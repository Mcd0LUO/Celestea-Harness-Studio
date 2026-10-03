/**
 * 结果构造与宿主回调容纳（纯函数 + 一个小状态字段）。
 *
 * 为什么从 core.ts 拆出来：core.ts 拆完是 504 有效行，超过本仓 450 有效行红线（实测）。
 * 这一块是**没有状态机时序**的纯构造逻辑——把"某个成员的这一次尝试落定成什么结果"
 * 写成纯函数，主类只保留时序编排，于是两边各自都读得动。
 *
 * 纯函数化顺带带来一个好处：终态粘性（落定之后不改）从"类内的一个 if"变成
 * "调用方必须显式传对 phase"，不再依赖"上一个方法的副作用恰好把 phase 设成终态"这种隐式耦合。
 */

import type {
  SwarmAttemptContext,
  SwarmAttemptResult,
  SwarmExecutor,
  SwarmSchedulerConfig,
  SwarmState,
  SwarmTaskResult,
  SwarmTaskSpec,
} from "../types.js";

/** 中止文案：运行中被取消（started）与未启动即取消（not_started）固定区分。 */
export const ABORTED_WHILE_RUNNING = "The swarm was interrupted before this member finished.";
export const TIMED_OUT = "Subagent timed out.";
export const ABORTED_BEFORE_START = "The swarm was interrupted before this member was started.";

/** 宿主回调抛错告警前缀，并进受影响成员的结果文案，保证"没被吞掉"在任何 outcome 下可观测。 */
const HOST_CALLBACK_FAILED = "host callback failed";

/** 任务状态的最小形状：结果构造只需要这几项。 */
export interface ResultTaskState {
  spec: SwarmTaskSpec;
  started: boolean;
  agentId?: string;
  /** 宿主回调在本成员身上抛出的错误（跨重试保留）。 */
  hostFailures: string[];
}

/** 把该成员累计的宿主回调失败以分号追加到结果文案后（不覆盖原文案；空文案不带前导分隔符）。 */
export function appendHostCallbackFailures(text: string, failures: readonly string[]): string {
  if (failures.length === 0) return text;
  const notes = failures.map((failure) => `${HOST_CALLBACK_FAILED}: ${failure}`).join("; ");
  return text === "" ? notes : `${text}; ${notes}`;
}

/** state 属性：子代理是否真的启动过（与 outcome 正交）。 */
export function startedOf(state: ResultTaskState): SwarmState {
  return state.started || state.agentId !== undefined ? "started" : "not_started";
}

/**
 * 把该成员累计的宿主回调失败并进结果文案——不静默吞掉，也不改动"谁成功了"这一事实。
 *
 * 字段选择必须跟着渲染口径走（result-xml.ts 的 bodyOf）：completed 的正文取 result，
 * 其余取 error；若一律写 error，completed 成员的告警渲染后就不见了——那等于静默吞掉。
 */
export function withHostFailures(state: ResultTaskState, result: SwarmTaskResult): SwarmTaskResult {
  if (state.hostFailures.length === 0) return result;
  if (result.outcome === "completed") {
    return { ...result, result: appendHostCallbackFailures(result.result ?? "", state.hostFailures) };
  }
  return { ...result, error: appendHostCallbackFailures(result.error ?? "", state.hostFailures) };
}

/** 失败结果（非限流失败、超时、以及判死）。 */
export function failedResult(state: ResultTaskState, error: string): SwarmTaskResult {
  return withHostFailures(state, {
    spec: state.spec,
    outcome: "failed",
    state: startedOf(state),
    ...(state.agentId === undefined ? {} : { agentId: state.agentId }),
    error,
  });
}

/** 中止结果：运行中被取消与未启动即取消用不同文案。 */
export function abortedResult(state: ResultTaskState, agentId: string | undefined): SwarmTaskResult {
  const startedState = startedOf(state);
  const id = agentId ?? state.agentId;
  return withHostFailures(state, {
    spec: state.spec,
    outcome: "aborted",
    state: startedState,
    ...(id === undefined ? {} : { agentId: id }),
    error: startedState === "started" ? ABORTED_WHILE_RUNNING : ABORTED_BEFORE_START,
  });
}

/** 单次尝试的产出：要么落定成一个结果，要么是一次限流（交回调用方重排队）。 */
export type AttemptOutcome =
  | { type: "settled"; result: SwarmTaskResult }
  | { type: "rate_limited"; agentId?: string; error: unknown; usedTool: boolean };

/** 闸门与中继共同依赖的最小调度器视图（core.ts 的 #deps 满足它）。 */
export interface AttemptGateDeps {
  /** 批次级取消信号（宿主 turn 的信号；缺省 = 该批无取消通道）。 */
  signal?: AbortSignal;
  /** 调度器时钟/定时器（与执行函数无关，是「宿主等不下去」的唯一权威）。 */
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** 一次尝试的取消面：批次信号的中继 + 超时兜底闸门。 */
export interface AttemptGate {
  /** 撤掉中继监听（批次收尾时调用）。 */
  unlink(): void;
  /** 撤除超时闸门（幂等；释放与中止共用同一处，见下方说明）。 */
  disarm(): void;
  /**
   * 武装超时闸门；`onExpired` 是到期回调，**调用方**（core.ts）用它落定该成员。
   *
   * **为什么到期不是「reject 一个 Promise」而是一个回调**：本仓的 W2014 棘轮规定全仓
   * 只有一处裸 race（统一原语内部那一行），而统一原语住在 `packages/tools`，
   * `packages/swarm` 是**同一层（L1）**，`tier1-no-peer-deps-swarm` 禁止横向依赖它。
   * 与其为了拿一个 race 去放宽棘轮或破坏分层，不如走**本来就存在**的那条释放路径——
   * 取消（批次 signal）正是靠「不经过 executor 就把成员落定」救了整批；超时现在走同一条。
   *
   * 到期回调先跑「置 timedOut → abort 成员信号」，再调 `onExpired`，顺序由本函数固定。
   * `timeoutMs <= 0` = 不武装（与 SwarmSchedulerConfig.timeoutMs 同义）。
   */
  arm(onExpired: () => void): void;
}

/** runAttemptOnce 需要的最小上下文（不含 attempt 对象本身，避免本模块依赖调度器的私有状态）。 */
export interface AttemptRunContext {
  state: ResultTaskState;
  /** attempt 级取消信号：批次中断或超时都会 abort 它。 */
  signal: AbortSignal;
  /** 限流判定门：true 表示该错误应重排队而非判终态 failed。 */
  isRateLimitError(error: unknown): boolean;
  /** 执行函数。 */
  executor: SwarmExecutor;
  /** 本次尝试的序号（1-based；契约要求执行函数按它区分首次与重试）。 */
  attempt: number;
  /** 成员发出首个请求时通知调度器（推进容量计数、重新锚定放量时刻）。 */
  markReady(): void;
  /** 超时文案（超时优先于原始错误）。 */
  timedOut: boolean;

}

/**
 * 跑一次尝试并把它的产出翻译成 AttemptOutcome。
 *
 * 为什么从调度器里抽出来：这段逻辑没有状态机时序——它只读一个 context、跑一次 executor.run、
 * 然后按"限流 / 成功 / 失败"三条路把结果分类。放在调度器类里时，它与放量、容量、唤醒混在
 * 一起，读的时候要跳过 400 行才知道一次尝试是怎么落定的。
 *
 * **executor 契约：resolve=成功，throw=失败**。返回失败对象会让 XML 把失败谎报成 completed，
 * 所以失败一律以 throw 表达，由本函数转成 settled/failed 或 rate_limited。
 */
export async function runAttemptOnce(ctx: AttemptRunContext): Promise<AttemptOutcome> {
  const state = ctx.state;
  if (ctx.signal.aborted) {
    return { type: "settled", result: abortedResult(state, state.agentId) };
  }

  let agentId = state.agentId;
  const attemptContext: SwarmAttemptContext = {
    attempt: ctx.attempt,
    signal: ctx.signal,
    markReady: ctx.markReady,
    setAgentId: (id: string) => {
      agentId = id;
      state.agentId = id;
      state.started = true;
    },
    ...(state.agentId === undefined ? {} : { previousAgentId: state.agentId }),
  };

  let outcome: SwarmAttemptResult;
  try {
    outcome = await ctx.executor.run(state.spec, attemptContext);
  } catch (error) {
    if (ctx.isRateLimitError(error)) {
      // usedTool 让调度器能拒绝重放一个已经动过外部世界的 attempt（W9290 B1-04）：
      // 限流发生在 provider 响应阶段，而工具副作用通常在那之前就已经发生。
      return {
        type: "rate_limited",
        ...(agentId === undefined ? {} : { agentId }),
        error,
        usedTool: isUsedToolError(error),
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      type: "settled",
      result: failedResult(state, ctx.timedOut ? TIMED_OUT : message),
    };
  }

  const result: SwarmTaskResult = {
    spec: state.spec,
    outcome: "completed",
    state: "started",
    ...(agentId === undefined ? {} : { agentId }),
    ...(outcome.result === undefined ? {} : { result: outcome.result }),
    ...(outcome.stopReason === undefined ? {} : { stopReason: outcome.stopReason }),
  };
  return { type: "settled", result: withHostFailures(state, result) };
}

/**
 * 一次尝试的取消面：批次信号的中继 + 超时兜底闸门。
 *
 * **为什么超时与中继必须同源同刻（W9290 B1-02）**：它们回答的是同一个问题——「这个成员
 * 还要等多久」。分开武装两支定时器，即使 ms 相同也会先后触发，于是「abort 先到、对决后到」
 * 时会先按成员自己的错误落定——超时优先于原始错误这条契约又变回巧合。这里只装**一支**，
 * 它的回调按「置 `timedOut` → abort 成员信号 → 让对决落定」的固定次序跑完，顺序由结构保证。
 *
 * **为什么闸门是必需的（而不是只有中继）**：中继只是**通知**。一个无视 abort 的执行函数
 *（子进程 wedged、SDK 永不返回、await 死锁）会让 `executor.run` 的 Promise 永不 settle，
 * 调用方等不到 `.then`，整个批次的 `run()` 也就永远不 resolve。闸门是那条与 executor 无关的
 * 释放路径：它由调度器自己的时钟武装，正是取消（批次 signal）已经在用、而超时当时缺的那条。
 *
 * `disarm` 幂等且由**释放与中止共用**：闸门在 `runAttemptOnce` 内部武装（对决之前），而释放
 * 发生在 `#releaseAttempt`——两者不在同一个栈上。若只由对决的 finally 撤除，批次被取消、
 * 对决还没跑到 finally 时闸门就会留在事件循环上（既有回归用例 `vi.getTimerCount() === 0`
 * 正是这一条）。
 */
export function attemptGate(
  deps: AttemptGateDeps,
  timeoutMs: number,
  attempt: {
    controller: AbortController;
    /** 由本函数在到期时置位；调用方在落定文案里读它。 */
    timedOut: boolean;
  },
): AttemptGate {
  let armed: unknown;
  /** 已撤除（批次收尾）= 后续的 `arm` 必须直接返回，不再武装。 */
  let closed = false;
  const batchSignal = deps.signal;
  const abortFromBatch = (): void => {
    attempt.controller.abort(batchSignal?.reason);
  };
  if (batchSignal?.aborted === true) abortFromBatch();
  else batchSignal?.addEventListener("abort", abortFromBatch, { once: true });

  return {
    unlink: () => {
      batchSignal?.removeEventListener("abort", abortFromBatch);
    },
    disarm: () => {
      closed = true;
      if (armed === undefined) return;
      const handle = armed;
      armed = undefined;
      deps.clearTimeout(handle);
    },
    arm: (onExpired) => {
      // 批次已经收尾（`disarm` 先行一步）：再装一支定时器就没人会撤它，
      // 它会留在事件循环上直到自己触发——既有回归用例的 getTimerCount()===0 正是这一条。
      if (closed || !(timeoutMs > 0)) return;
      armed = deps.setTimeout(() => {
        armed = undefined;
        attempt.timedOut = true;
        attempt.controller.abort(new Error(TIMED_OUT));
        onExpired();
      }, timeoutMs);
    },
  };
}

/**
 * 一个被校验的数值字段：`>= min`（可选再要求整数），且**必须有限**。
 */
export interface NumericField {
  key: keyof SwarmSchedulerConfig & string;
  value: number;
  /** 下界（闭区间）。 */
  min: number;
  /** true = 还必须是整数。 */
  integer: boolean;
}

/**
 * **`SwarmSchedulerConfig` 的全部数值字段与其合法下界**（W9290 B1-05）。
 *
 * 为什么必须是**一张穷尽的表**而不是若干条 if：这个契约的失败模式是「静默失效」——
 * `NaN` 与任何数比较都 false，于是 `NaN <= 0` 为 false 会真的装一支定时器，而 Node 把它
 * 当 1ms；`initialLaunchIntervalMs: NaN` 则退化成 0ms 忙等；`Infinity` 让超时永不触发。
 * 每一个漏校验的字段都会**静默**变成一个「看起来生效、其实不是」的行为，而它只在慢路径上
 * 现形。列全这张表并让「新增字段忘记校验」成为一次编译期可见的遗漏（下面按字段逐个列出，
 * 不用 `Object.keys` 反射——反射会让漏加字段在类型上完全无声）。
 *
 * `min: 0` 表示「0 是有意义的值」；真正要区分「0 = 禁用」的字段在下表里显式标出。
 */
export const SWARM_NUMERIC_FIELDS: readonly NumericField[] = [
  // 首波放几个：至少 1，否则首波一个都放不出去。
  { key: "initialLaunchLimit", value: 0, min: 1, integer: false },
  // 放量间隔：0 = 不额外等待（忙跑，合法但昂贵）。
  { key: "initialLaunchIntervalMs", value: 0, min: 0, integer: false },
  // 退避基数：0 = 不退避（合法，测试用）。
  { key: "retryBaseMs", value: 0, min: 0, integer: false },
  // 退避因子：>= 1，否则第 n 次退避比第 1 次还短。
  { key: "retryFactor", value: 0, min: 1, integer: false },
  // 收缩防抖：0 = 每次限流都立刻收缩。
  { key: "capacityShrinkDebounceMs", value: 0, min: 0, integer: false },
  // 恢复间隔：**必须 >= 1**，否则 nextWakeupAt 的兜底分支会退化成自旋。
  { key: "capacityRecoveryIntervalMs", value: 0, min: 1, integer: false },
  { key: "maxConcurrency", value: 0, min: 1, integer: true },
  // 单成员超时：**0 = 禁用**（显式定义，消解上游 D8 的 undefined/0 歧义），故下界 0。
  { key: "timeoutMs", value: 0, min: 0, integer: false },
  { key: "maxRateLimitRetries", value: 0, min: 1, integer: true },
  // 整批墙钟预算：0 = 禁用（与 timeoutMs 同义），故下界 0。
  { key: "maxTotalMs", value: 0, min: 0, integer: false },
  // 整批退避上限：0 = 不允许任何重排队（合法：立刻判死，别把墙钟耗在退避上）。
  { key: "maxBatchRateLimitRetries", value: 0, min: 0, integer: true },
];

/** 按 resolved 配置把上面那张表填上真实值。 */
export function numericFieldsOf(config: SwarmSchedulerConfig): NumericField[] {
  return SWARM_NUMERIC_FIELDS.map((field) => ({ ...field, value: config[field.key] }));
}

/**
 * 单个数值字段的合法性判定。**有限性优先于一切**：
 * `NaN`/`Infinity` 不是「一个很大的数」，而是「这个数没有定义」，任何比较都不成立。
 */
export function assertSaneNumber(key: string, value: number, min: number, integer: boolean): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number, got ${String(value)}.`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer >= ${String(min)}, got ${String(value)}.`);
  }
  if (!(value >= min)) {
    throw new Error(`${key} must be >= ${String(min)}, got ${String(value)}.`);
  }
}

/**
 * 读出「这个 attempt 是否已经执行过工具调用」（W9290 B1-04）。
 *
 * 判据走结构而非 `instanceof`：`SwarmMemberFailedError` 是 executor 的类，而本模块刻意
 * 不 import 它（results.ts 不该知道执行器的实现）。字段 duck-typing 在这里是安全的：
 * 只有 executor 会写 `usedTool`，缺字段即 false（= 没有副作用），与构造器缺省一致。
 */
function isUsedToolError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { usedTool?: unknown }).usedTool === true;
}

/**
 * 整批墙钟预算的武装结果：只有 `disarm`，没有别的（W9290 B1-03）。
 *
 * 做成「返回一个撤除句柄」而不是「在调度器里存一个 timer 字段」，是为了让预算与
 * attempt 闸门共享同一种形状——两者都是「武装在别处、撤除在收尾处」，而收尾只有一处。
 */
export interface BatchBudget {
  /** 撤除预算定时器（幂等）。 */
  disarm(): void;
}

/** 什么也不撤除的预算：对应「未武装」。 */
export const NO_BUDGET: BatchBudget = { disarm: () => undefined };

/**
 * 武装**整批**墙钟预算（`maxTotalMs`，0 = 禁用）—— W9290 B1-03。
 *
 * **为什么它不能由 per-attempt 的 timeoutMs 拼出来**：一批的代价是「波数 × 每波上限」，
 * 而波数（成员数 ÷ maxConcurrency）在配置期根本不知道实际会跑几波；即使知道，
 * 128 成员 ÷ 16 并发 × 2h 也已经是 16 小时。宿主等的是**整批**的结果，所以必须有一条
 * 与 attempt 无关的整批闸门。
 *
 * 到点的动作 = **与用户中断完全同一条路径**（调用方传进来的 `onExpire`）：未落定的成员
 * 记 aborted、队列清空、在跑的成员收到 abort。这不是新语义——「批次被取消」这套形状早已
 * 存在，预算只是给它加了一个**宿主自己也能调的**触发源，并把「一定落定」变成可依赖的。
 */
export function armBatchBudget(
  deps: { setTimeout(handler: () => void, ms: number): unknown; clearTimeout(handle: unknown): void },
  maxTotalMs: number,
  onExpire: () => void,
): BatchBudget {
  if (!(maxTotalMs > 0)) return NO_BUDGET;
  let handle: unknown;
  let closed = false;
  handle = deps.setTimeout(() => {
    closed = true;
    handle = undefined;
    onExpire();
  }, maxTotalMs);
  return {
    disarm: () => {
      if (closed || handle === undefined) return;
      closed = true;
      const h = handle;
      handle = undefined;
      deps.clearTimeout(h);
    },
  };
}
