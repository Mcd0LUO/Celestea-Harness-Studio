/**
 * 调度器主状态机：正常模式放量 + attempt 生命周期 + 结果落位 + 中断/超时。
 *
 * 限流相关的全部判据在 {@link ../rate-limit.js}（容量收缩/退避/恢复/唤醒时刻）；
 * 本文件只负责"放不放"与"跑完算什么"两件事。
 *
 * 节奏契约：
 *   正常模式  首波无间隔连发 initialLaunchLimit 个，之后每 initialLaunchIntervalMs 放 1 个
 *   退避      第 n 次限流重排队 → retryBaseMs * retryFactor^(n-1) * 抖动（本仓新增，见 rate-limit.ts）
 *   中断      AbortSignal → 在跑标 aborted、清空队列
 *
 * 相对上游行为描述的**有意偏离**（均为可测的收紧，不是功能变更）：
 *   1. 退避重排队事件（onSuspended）额外携带 retryCount / retryDelayMs / retryReadyAt。
 *   2. 结果同时给出 `state` 与 `outcome` 两个正交维度，`state` 由"是否真的启动过"决定。
 *   3. 时间语义修正：退避延迟、容量防抖、恢复**一律走注入的 now()**，绝不读 Date.now()。
 *   4. 宿主注入的函数（onSuspended / onAbandoned）抛错不再逃逸：就地收下并**并进该成员
 *      的结果文案**，调度继续跑完整批。
 *   5. 超时 0 = 禁用（显式定义，消解上游 D8 歧义）。
 */

import {
  DEFAULT_SWARM_SCHEDULER_CONFIG,


  type SwarmSchedulerConfig,
  type SwarmSchedulerDeps,
  type SwarmSchedulerSnapshot,
  type SwarmState,
  type SwarmTaskResult,
  type SwarmTaskSpec,
  type SwarmTimerHandle,
} from "../types.js";
import { RateLimitGate, retryDelayMs } from "./rate-limit.js";
import {
  ABORTED_BEFORE_START,
  abortedResult,
  failedResult,
  runAttemptOnce,
  startedOf,
  withHostFailures,
} from "./results.js";

/**
 * 限流挂起原因文案（写进 onSuspended 事件，供 UI/日志使用）。
 *
 * 面向**模型与日志**，不进 i18n 字典（面向人的同类信息走 Statusline 的 swarm? 字段）。
 */
export const RATE_LIMIT_SUSPENDED_REASON =
  "The provider applied a rate limit to this member; it is back in the queue and will be retried.";

const TIMED_OUT = "Subagent timed out.";
const ABANDONED_BY_RATE_LIMIT =
  "Subagent was still rate limited while it was the only unfinished member; the swarm gave up on it.";

/**
 * 判死条件的第二条（per-task 重试上限）专用文案。
 *
 * 为什么与 ABANDONED_BY_RATE_LIMIT 分开：两条判死路径的原因不同——前者是"批次尾部只剩
 * 它，腾不出别人来"；后者是"它自己重试次数到顶了"（哪怕旁边还有别的成员在跑）。
 * 共用一句会让"为什么被放弃"在成员多于一个时彻底说不清。
 */
const ABANDONED_BY_RETRY_LIMIT = (limit: number): string =>
  `Subagent stayed rate limited after ${String(limit)} retries; the swarm gave up on it.`;


function resolveConfig(config?: Partial<SwarmSchedulerConfig>): SwarmSchedulerConfig {
  return { ...DEFAULT_SWARM_SCHEDULER_CONFIG, ...config };
}

/**
 * 调度器配置的**唯一**合法性判定（构造期调用；宿主也可在加载期提前调用以 fail-fast）。
 *
 * 本仓与源仓的差别（有意）：源仓的 maxConcurrency / maxRateLimitRetries 是可选参数
 * （undefined = 无上限），但**本仓没有宿主派发池兜底**，并发闸门是唯一防线，
 * 因此这两个字段改为**必填且带默认值**（16 / 3），给定值仍必须是 >= 1 的整数：
 *   0  → `active.size >= 0` 恒真（maxConcurrency：静默不放量）/ 第一次限流就判死；
 *   NaN → 与任何数比较都 false → 闸门形同虚设；
 *   负数/小数 → 同上或语义不明。
 * 它们都会把"非法 config 必然抛错"的契约变成静默失效，所以一并挡掉。
 */
export function validateSchedulerConfig(config?: Partial<SwarmSchedulerConfig>): void {
  const resolved = resolveConfig(config);
  if (!(resolved.initialLaunchLimit >= 1)) {
    throw new Error(`initialLaunchLimit must be >= 1, got ${String(resolved.initialLaunchLimit)}.`);
  }
  if (!(resolved.retryBaseMs >= 0)) {
    throw new Error(`retryBaseMs must be >= 0, got ${String(resolved.retryBaseMs)}.`);
  }
  if (!(resolved.retryFactor >= 1)) {
    throw new Error(`retryFactor must be >= 1, got ${String(resolved.retryFactor)}.`);
  }
  for (const field of ["maxConcurrency", "maxRateLimitRetries"] as const) {
    const value = resolved[field];
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${field} must be an integer >= 1, got ${String(value)}.`);
    }
  }
}

/** 每个任务的持久状态，跨重试保留。 */
interface TaskState {
  index: number;
  spec: SwarmTaskSpec;
  retryCount: number;
  retryReadyAt: number;
  agentId?: string;
  /** 是否真的跑起来过（曾 markReady 或曾拿到 agentId）。跨重试保留。 */
  started: boolean;
  /**
   * 宿主回调在本成员身上抛出的错误（`<message> (from <source>)`）。跨重试保留：
   * 抛错发生在调用回调的那一刻，而该成员的结果要到之后才成形——记在任务状态上，
   * 才能保证最终结果一定带着它。
   */
  hostFailures: string[];
}

/** 单次尝试，跑完即弃。 */
interface Attempt {
  state: TaskState;
  controller: AbortController;
  ready: boolean;
  timedOut: boolean;
  cleanup(): void;
}

type AttemptOutcome =
  | { type: "settled"; result: SwarmTaskResult }
  | { type: "rate_limited"; agentId?: string; error: unknown };

/**
 * 按 spec 顺序把任务跑完，返回**与输入等长、按 index 落位**的结果数组。
 * run() 的 Promise 只会 resolve（批次级失败以 failed 结果的形式落位）；
 * 非法 config 在**构造期同步抛错**，根本走不到 run()。
 */
export class SwarmScheduler {
  readonly #deps: SwarmSchedulerDeps;
  readonly #config: SwarmSchedulerConfig;
  readonly #gate: RateLimitGate;
  readonly #states: TaskState[];
  readonly #results: (SwarmTaskResult | undefined)[];

  #resolve: ((results: SwarmTaskResult[]) => void) | undefined;
  /** 首次 run() 返回的批次 Promise；重复调用原样返回它。 */
  #runPromise: Promise<SwarmTaskResult[]> | undefined;
  #pending: TaskState[] = [];
  #active = new Set<Attempt>();
  #finished = false;

  #normalLaunchCount = 0;
  #normalLaunchTimer: SwarmTimerHandle | undefined;
  #random: () => number;

  #onBatchAbort = (): void => {
    if (this.#finished) return;
    this.#abandonSuspended();
    this.#finishWithAbort();
  };

  constructor(
    specs: readonly SwarmTaskSpec[],
    deps: SwarmSchedulerDeps,
    config?: Partial<SwarmSchedulerConfig>,
  ) {
    validateSchedulerConfig(config);
    this.#config = resolveConfig(config);
    this.#deps = deps;
    this.#random = deps.randomFn ?? Math.random;
    this.#gate = new RateLimitGate(this.#config, deps);
    this.#states = specs.map((spec, i) => ({
      index: i,
      spec,
      retryCount: 0,
      retryReadyAt: 0,
      started: false,
      hostFailures: [],
    }));
    this.#results = new Array<SwarmTaskResult | undefined>(specs.length);
    this.#pending = [...this.#states];
  }

  /**
   * 启动批次；**幂等**——重复调用返回首次启动的那个 Promise。
   *
   * 为什么选"返回同一个 Promise"而不是"第二次抛错"：
   *   ① 类契约是"该 Promise 只会 resolve，唯一会 reject 的情况是非法 config"；
   *   ② 旧实现每次调用都新建 Promise 并覆盖 #resolve，首个 Promise 会永远挂着、且
   *      **没有任何可观测信号**——幂等正是消除该形态的最小手段；
   *   ③ 宿主侧更安全：重入拿到的是同一批结果，而不是第二次调度。
   */
  run(): Promise<SwarmTaskResult[]> {
    if (this.#runPromise !== undefined) return this.#runPromise;
    const promise = new Promise<SwarmTaskResult[]>((resolve) => {
      this.#resolve = resolve;
      if (this.#states.length === 0) {
        this.#finish([]);
        return;
      }
      const signal = this.#deps.signal;
      if (signal?.aborted === true) {
        this.#onBatchAbort();
        return;
      }
      signal?.addEventListener("abort", this.#onBatchAbort, { once: true });
      this.#schedule();
    });
    this.#runPromise = promise;
    return promise;
  }

  /**
   * 只读状态快照：调度态与限流态**合并成一次读数**。用于测试断言与宿主日志；不改变任何调度状态。
   *
   * 为什么合并而不分成 snapshot() + rateLimitSnapshot()：容量收缩/恢复/唤醒保活这几类行为
   * 只能通过「下一次何时放量」观察，断言需要 pendingCount、activeCount 与 rateLimitCapacity
   * 来自**同一个瞬间**。分两次读就会出现「读了容量、期间批次变了」的撕裂读数，断言必然 flaky。
   */
  snapshot(): SwarmSchedulerSnapshot {
    const gate = this.#gate;
    const settledResults = this.#results.filter((r): r is SwarmTaskResult => r !== undefined);
    return {
      config: this.#config,
      results: settledResults,
      done: settledResults.length,
      total: this.#states.length,
      settled: this.#finished,
      finished: this.#finished,
      failed: settledResults.some((r) => r.outcome === "failed"),
      started: this.#states.some((s) => s.started),
      rateLimitMode: gate.mode,
      rateLimitCapacity: gate.capacity,
      globalRetryIntervalMs: gate.globalRetryIntervalMs,
      nextRateLimitLaunchAt: gate.nextLaunchAt,
      startedSuccessCount: gate.startedSuccessCount,
      activeCount: this.#active.size,
      pendingCount: this.#pending.length,
    };
  }
  // ───────────────────────── 调度主循环 ─────────────────────────

  #schedule(): void {
    if (this.#finished) return;
    if (this.#finishIfComplete()) return;
    if (this.#deps.signal?.aborted === true) return;
    if (this.#gate.mode) this.#scheduleRateLimitLaunch();
    else this.#scheduleNormalLaunch();
  }

  #finishIfComplete(): boolean {
    for (const result of this.#results) if (result === undefined) return false;
    this.#finish(this.#results as SwarmTaskResult[]);
    return true;
  }

  #scheduleNormalLaunch(): void {
    // 首波：最多 initialLaunchLimit 个，无间隔连发
    while (
      this.#normalLaunchCount < this.#config.initialLaunchLimit &&
      this.#pending.length > 0 &&
      !this.#gate.mode &&
      !this.#isAtConcurrencyLimit()
    ) {
      const state = this.#pending.shift() as TaskState;
      this.#startAttempt(state);
      this.#normalLaunchCount += 1;
    }
    // 首波之后：每 initialLaunchIntervalMs 放一个
    if (
      this.#pending.length === 0 ||
      this.#gate.mode ||
      this.#normalLaunchTimer !== undefined ||
      this.#isAtConcurrencyLimit()
    ) {
      return;
    }
    this.#normalLaunchTimer = this.#deps.setTimeout(() => {
      this.#normalLaunchTimer = undefined;
      if (this.#finished || this.#gate.mode || this.#pending.length === 0) return;
      if (this.#isAtConcurrencyLimit()) return;
      const state = this.#pending.shift() as TaskState;
      this.#startAttempt(state);
      this.#normalLaunchCount += 1;
      this.#schedule();
    }, this.#config.initialLaunchIntervalMs);
  }

  /**
   * 硬并发闸门。**本仓与源仓的差别**：源仓是 `maxConcurrency !== undefined && ...`
   * （undefined = 无上限），本仓是必填字段，直接比较即可。
   */
  #isAtConcurrencyLimit(): boolean {
    return this.#active.size >= this.#config.maxConcurrency;
  }

  #scheduleRateLimitLaunch(): void {
    this.#gate.clearWakeup();
    if (this.#pending.length === 0) return;
    const now = this.#deps.now();
    this.#gate.recover(now, this.#pending);

    // ① 在跑数已达容量 → 等到容量恢复时刻再唤醒
    //（统一走 funnel，让"有 pending 就有未来唤醒"这一不变量只有一个武装点）
    if (this.#active.size >= this.#gate.capacity) {
      this.#scheduleNextRateLimitWakeup(now);
      return;
    }

    // ② 下一个可放量时刻 = max(全局节流, 最早就绪任务)
    const nextAllowedAt = Math.max(this.#gate.nextLaunchAt, this.#nextPendingReadyAt());
    const nextWakeupAt = Math.min(nextAllowedAt, this.#nextCapacityRecoveryAt());
    if (nextWakeupAt > now) {
      // funnel 会用同样的输入算出同一个时刻（此刻 active < 容量，故取 min(...) 分支）。
      this.#scheduleNextRateLimitWakeup(now);
      return;
    }

    // ③ 找一个就绪任务启动
    //
    // 硬并发闸门：maxConcurrency 与 rateLimitCapacity 是**两个独立**的闸门，缺一不可。
    // rateLimitCapacity 只在限流时收紧（可能远大于 maxConcurrency），因此它变小不构成
    // "一定没到并发上限"的保证；此处一旦漏检，就会在 maxConcurrency 已满时继续补位，
    // 直接违反 SwarmSchedulerConfig.maxConcurrency 的契约。
    if (this.#isAtConcurrencyLimit()) {
      // 满并发时不启动新任务，但仍**必须**装下一次唤醒定时器。
      // 两种醒来理由都要覆盖：① 在跑任务腾位子；② 容量恢复时刻到（否则 180s 恢复被饿死）。
      this.#scheduleNextRateLimitWakeup(now);
      return;
    }
    const pendingIndex = this.#pending.findIndex((state) => state.retryReadyAt <= now);
    if (pendingIndex === -1) {
      // 理论上不可达，但同样不允许裸 return：只要 pending 非空，就必须留下唤醒。
      this.#scheduleNextRateLimitWakeup(now);
      return;
    }
    const [state] = this.#pending.splice(pendingIndex, 1) as [TaskState];
    this.#startAttempt(state);
    this.#gate.noteLaunch(now);
    this.#scheduleNextRateLimitWakeup(now);
  }

  /**
   * 限流模式下**唯一**的唤醒武装点：只要 pending 非空，就必然留下未来的定时器。
   * 覆盖 #scheduleRateLimitLaunch 的每一个出口（①容量满 ②时刻未到 ③并发满 ④找不到就绪
   * ⑤刚放一个），合起来即"有 pending 且未结束 ⇒ 有未来唤醒"。
   */
  #scheduleNextRateLimitWakeup(now: number): void {
    if (this.#pending.length === 0) return;
    this.#gate.armWakeup(this.#gate.nextWakeupAt(now, this.#pending, this.#active.size), now, () => {
      this.#schedule();
    });
  }

  #nextPendingReadyAt(): number {
    let min = Number.POSITIVE_INFINITY;
    for (const state of this.#pending) min = Math.min(min, state.retryReadyAt);
    return min;
  }

  #nextCapacityRecoveryAt(): number {
    return this.#gate.nextCapacityRecoveryAt(this.#pending);
  }

  // ───────────────────────── 尝试生命周期 ─────────────────────────

  #startAttempt(state: TaskState): void {
    if (this.#finished || this.#deps.signal?.aborted === true) return;
    const controller = new AbortController();
    const attempt: Attempt = {
      state,
      controller,
      ready: false,
      timedOut: false,
      cleanup: () => undefined,
    };
    attempt.cleanup = this.#linkAttemptSignals(attempt);
    this.#active.add(attempt);
    void runAttemptOnce({
      state,
      signal: attempt.controller.signal,
      attempt: state.retryCount + 1,
      timedOut: attempt.timedOut,
      isRateLimitError: this.#deps.isRateLimitError,
      executor: this.#deps.executor,
      markReady: () => {
        this.#markAttemptReady(attempt);
      },
    }).then(
      (outcome) => {
        this.#handleAttemptOutcome(attempt, outcome);
      },
      (error: unknown) => {
        this.#handleAttemptError(attempt, error);
      },
    );
  }


  #linkAttemptSignals(attempt: Attempt): () => void {
    const batchSignal = this.#deps.signal;
    const abortFromBatch = (): void => {
      attempt.controller.abort(batchSignal?.reason);
    };
    // **0 = 禁用**（本仓显式定义，消解上游 D8 的 undefined/0 语义分叉）。
    const timeoutMs = this.#config.timeoutMs;
    const timeout =
      timeoutMs <= 0
        ? undefined
        : this.#deps.setTimeout(() => {
            attempt.timedOut = true;
            attempt.controller.abort(new Error(TIMED_OUT));
          }, timeoutMs);

    if (batchSignal?.aborted === true) abortFromBatch();
    else batchSignal?.addEventListener("abort", abortFromBatch, { once: true });

    return () => {
      if (timeout !== undefined) this.#deps.clearTimeout(timeout);
      batchSignal?.removeEventListener("abort", abortFromBatch);
    };
  }

  #markAttemptReady(attempt: Attempt): void {
    if (this.#finished || attempt.ready || !this.#active.has(attempt)) return;
    attempt.ready = true;
    attempt.state.started = true;
    this.#gate.noteStarted();
    if (this.#gate.mode) {
      this.#gate.noteReadyInRateLimit(this.#deps.now());
      this.#schedule();
    }
  }

  #handleAttemptOutcome(attempt: Attempt, outcome: AttemptOutcome): void {
    if (!this.#releaseAttempt(attempt)) return;
    if (this.#finished) return;

    const deathError = outcome.type === "settled" ? undefined : this.#rateLimitDeathCause(attempt.state);
    if (outcome.type === "settled") {
      this.#results[attempt.state.index] = outcome.result;
    } else if (deathError !== undefined) {
      // 死锁防护：两条判死条件任一成立即判 failed（详见 #rateLimitDeathCause）。
      const error = deathError;
      const result: SwarmTaskResult = {
        spec: attempt.state.spec,
        outcome: "failed",
        state: startedOf(attempt.state),
        ...(outcome.agentId === undefined ? {} : { agentId: outcome.agentId }),
        error,
      };
      this.#results[attempt.state.index] = result;
      this.#callHostCallback(attempt.state, "onAbandoned", () => {
        this.#deps.onAbandoned?.({
          spec: attempt.state.spec,
          ...(outcome.agentId === undefined ? {} : { agentId: outcome.agentId }),
          outcome: "failed",
          error,
        });
      });
      // 该分支的结果在调用回调**之前**就落了位，回调抛错同样不得静默：把告警补进文案。
      this.#results[attempt.state.index] = withHostFailures(attempt.state, result);
    } else {
      this.#requeueRateLimited(attempt, outcome);
    }
    this.#schedule();
  }

  #handleAttemptError(attempt: Attempt, error: unknown): void {
    if (!this.#releaseAttempt(attempt)) return;
    if (this.#finished) return;
    this.#results[attempt.state.index] = failedResult(attempt.state, this.#errorMessage(attempt, error));
    this.#schedule();
  }

  #releaseAttempt(attempt: Attempt): boolean {
    if (!this.#active.delete(attempt)) return false;
    attempt.cleanup();
    return true;
  }

  #isOnlyUnfinishedTask(state: TaskState): boolean {
    for (let i = 0; i < this.#results.length; i += 1) {
      if (i !== state.index && this.#results[i] === undefined) return false;
    }
    return true;
  }

  /**
   * 限流判死判定：**双重（or）**，任一条件成立就返回该成员的失败文案，否则返回 undefined。
   *
   * ① 单成员尾部：只剩它一个未完成 且 已退避重试过（retryCount>=1）仍限流。
   *   相对上游机制文档的**有意放宽**（上游首次限流即判死）：限流高度瞬时，
   *   首次即弃会把可恢复的抖动变成终态失败，故先给 retryBaseMs 退避一次。
   *
   * ② per-task 重试上限：retryCount >= maxRateLimitRetries。**为什么必须有它**：
   *   ① 在 >=2 个成员同时持续限流时恒为 false（每个成员都还"有别人没完成"），
   *   而重排队分支没有次数上限 → 无限重排队，批次 Promise 永不 resolve。
   *   它按成员各自计数——一个成员限流到顶，不会连坐拖死同批仍在健康跑完的其它成员。
   *
   * 校准：每次 requeue 递增 1，故"已重排队 N 次后仍在第 N+1 次尝试里限流"时 retryCount === N。
   */
  #rateLimitDeathCause(state: TaskState): string | undefined {
    if (this.#isOnlyUnfinishedTask(state) && state.retryCount >= 1) {
      return ABANDONED_BY_RATE_LIMIT;
    }
    const limit = this.#config.maxRateLimitRetries;
    if (state.retryCount >= limit) {
      return ABANDONED_BY_RETRY_LIMIT(limit);
    }
    return undefined;
  }

  // ───────────────────────── 限流重排队 ─────────────────────────

  #requeueRateLimited(attempt: Attempt, outcome: { agentId?: string; error: unknown }): void {
    const state = attempt.state;
    if (outcome.agentId !== undefined) state.agentId = outcome.agentId;

    const now = this.#deps.now();
    this.#gate.noteRateLimit(now);
    state.retryCount += 1;

    // 带抖动（本仓新增，上游无）：base * factor^(n-1) * (0.5 + random * 0.5)
    const retryDelay = retryDelayMs(this.#config, state.retryCount, this.#random());
    state.retryReadyAt = now + retryDelay;
    this.#pending.unshift(state);

    this.#callHostCallback(state, "onSuspended", () => {
      this.#deps.onSuspended?.({
        spec: state.spec,
        ...(state.agentId === undefined ? {} : { agentId: state.agentId }),
        reason: RATE_LIMIT_SUSPENDED_REASON,
        retryCount: state.retryCount,
        retryDelayMs: retryDelay,
        retryReadyAt: state.retryReadyAt,
      });
    });

    this.#gate.enter(now);
    // 一律轻罚：只推 retryBaseMs。曾在源仓存在"首个请求未发出 → 全局间隔翻倍"的重罚档，
    // 但那是 DSH 宿主无法观测的状态（该分支的测试在生产接线下永不可达 = 僵尸代码），已删除。
    this.#gate.pushGlobalInterval(now);
  }

  // ───────────────────────── 结果构造 ─────────────────────────

  /** `state` 属性：子代理是否真的启动过（与 outcome 正交）。 */
  #startedOf(state: TaskState): SwarmState {
    return state.started || state.agentId !== undefined ? "started" : "not_started";
  }

  /** 超时文案优先于原始错误。 */
  #errorMessage(attempt: Attempt, error: unknown): string {
    if (attempt.timedOut) return TIMED_OUT;
    return this.#describeThrown(error);
  }

  #describeThrown(value: unknown): string {
    return value instanceof Error ? value.message : String(value);
  }

  // ───────────────────────── 宿主回调容纳 ─────────────────────────

  /**
   * 调用宿主注入的回调；抛错一律就地收下并记到该成员身上。
   *
   * 为什么必须收：这些回调是在 `#runAttempt(...).then(onOk, onErr)` 的 continuation 里被
   * **同步**调用的。抛错会同时造成两件事——
   *   (a) 该 continuation 变成一个**未处理 rejection**：宿主只看到"调度器炸了"，
   *       而没有任何成员的结果能反映它（错误从可观测面上消失）；
   *   (b) 紧随其后的 `#schedule()` 被跳过 → 不再武装任何定时器 → 批次永不收尾。
   */
  #callHostCallback(state: TaskState, source: string, call: () => void): void {
    try {
      call();
    } catch (thrown) {
      state.hostFailures.push(`${this.#describeThrown(thrown)} (from ${source})`);
    }
  }
  /**
   * 批次中断时，把所有"还没走到终态"的成员统一通知宿主：它们已被放弃。
   *
   * 必须覆盖两类，缺一类宿主就收不到终态：
   *   ① 仍在队列里的成员——既可能是**从未启动**的排队成员（没有 agentId），
   *      也可能是限流重排队后带着上一次尝试 agentId 的成员；
   *   ② 已建好但还没 markReady 的尝试——首个请求尚未真正生效。
   *
   * 为什么不能按 "agentId 是否存在" 过滤：SwarmAbandonedEvent.agentId 在契约里是
   * **可选**的（agentId?: string），所以未启动成员照样要发这条事件；按 agentId 过滤会让
   * 它们在宿主的 registry 里永久停在 pending，批次被推导成 failed，与 XML 侧"全员 aborted"
   * 的结论互相矛盾。缺省语义 = 不带该字段，而不是补一个假 id
   * （agentId 是宿主跳转/resume 的凭据，伪造比缺失更危险）。
   */
  #abandonSuspended(): void {
    for (const state of this.#pending) {
      this.#callHostCallback(state, "onAbandoned", () => {
        this.#deps.onAbandoned?.({
          spec: state.spec,
          ...(state.agentId === undefined ? {} : { agentId: state.agentId }),
          outcome: "cancelled",
          error: ABORTED_BEFORE_START,
        });
      });
    }
    for (const attempt of this.#active) {
      if (attempt.ready) continue;
      const agentId = attempt.state.agentId;
      this.#callHostCallback(attempt.state, "onAbandoned", () => {
        this.#deps.onAbandoned?.({
          spec: attempt.state.spec,
          ...(agentId === undefined ? {} : { agentId }),
          outcome: "cancelled",
          error: ABORTED_BEFORE_START,
        });
      });
    }
  }

  #finishWithAbort(): void {
    if (this.#finished) return;
    this.#clearNormalTimer();
    this.#gate.clearWakeup();
    for (const attempt of this.#active) {
      attempt.controller.abort(this.#deps.signal?.reason);
    }
    const results = this.#states.map((state) => {
      const existing = this.#results[state.index];
      if (existing !== undefined) return existing;
      return abortedResult(state, state.agentId);
    });
    this.#finish(results);
  }

  #finish(results: SwarmTaskResult[]): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#cleanup();
    this.#resolve?.(results);
  }

  #cleanup(): void {
    this.#deps.signal?.removeEventListener("abort", this.#onBatchAbort);
    this.#clearNormalTimer();
    this.#gate.clearWakeup();
    for (const attempt of this.#active) attempt.cleanup();
    this.#active.clear();
  }

  #clearNormalTimer(): void {
    if (this.#normalLaunchTimer === undefined) return;
    this.#deps.clearTimeout(this.#normalLaunchTimer);
    this.#normalLaunchTimer = undefined;
  }
}
