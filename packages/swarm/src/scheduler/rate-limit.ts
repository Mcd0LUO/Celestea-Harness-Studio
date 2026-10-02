/**
 * 限流模式：容量收缩 / 退避 / 恢复 / 唤醒时刻计算。
 *
 * 为什么单独成模块：它是调度器里**唯一**一块"状态与判据交织、且有独立演化理由"的逻辑。
 * 收缩与恢复的时序、退避的就绪时刻、唤醒时刻的兜底策略各自都有成套不变量，压在同一个
 * 类里会让主状态机（放量与 attempt 生命周期）无法单独阅读。
 *
 * 本模块**不持有**任务状态：它只回答三个问题——
 *   ①现在还能放几个？        → {@link RateLimitGate.capacity}
 *   ②下一次唤醒在什么时候？  → {@link RateLimitGate.nextWakeupAt}
 *   ③这次退避要等多久？      → {@link retryDelayMs}
 * 「还有哪些任务没跑」由调用方以参数传入，因为队列属于主状态机。
 */

import type { SwarmSchedulerConfig, SwarmTimerHandle } from "../types.js";

/**
 * 退避延迟，带抖动：base * factor^(n-1) * (0.5 + random * 0.5)，范围 [0.5x, 1.0x] 基准。
 *
 * **为什么必须抖动**（本仓相对上游的净收益，规避上游 D5）：无抖动时所有被限流的成员
 * 共享同一条"第 n 次退避 X 毫秒"的刻度，它们会在同一个时刻一起醒来、同时再撞一次限流，
 * 形成重试雷暴——限流信号被自己的重试放大。抖动把同一批成员的到期时刻打散到半个基准窗口内，
 * 代价只是"多等一点"，收益是重试压力被摊平。
 *
 * 抖动系数取 [0.5, 1.0) 而非 [0, 1)：**不缩短**退避，保证抖动不会削弱退避本身的保护作用
 * （取 [0,1) 时随机源偏小会让某成员被提前重试，反而可能更早再撞限流）。
 *
 * random 缺省 Math.random，由调用方注入（见 SwarmSchedulerDeps.randomFn 的理由：
 * 随机源是环境依赖，必须可注入才能写出确定性断言）。
 */
export function retryDelayMs(
  config: Pick<SwarmSchedulerConfig, "retryBaseMs" | "retryFactor">,
  retryCount: number,
  random: number,
): number {
  const base = config.retryBaseMs * config.retryFactor ** (retryCount - 1);
  return base * (0.5 + random * 0.5);
}

/** 队列视角的最小就绪时刻（限流时 pending 里的新任务 retryReadyAt=0，永远就绪）。 */
export type ReadyAtSource = { retryReadyAt: number };

/**
 * 限流闸门。持有**全部**限流态字段，正常模式进入限流时由它接管。
 *
 * 不变量（都有测试钉住）：
 *   ① 容量 >= 1（收缩地板）；
 *   ② 收缩有防抖，非强制收缩在 capacityShrinkDebounceMs 内不重复扣减；
 *   ③ 恢复**无上界**（见 recover 的注释）；
 *   ④ pending 非空且批次未结束 ⇒ 必然留下一个未来的唤醒时刻（见 {@link nextWakeupAt}）。
 */
export class RateLimitGate {
  #config: SwarmSchedulerConfig;
  #setTimeout: (handler: () => void, ms: number) => SwarmTimerHandle;
  #clearTimeout: (handle: SwarmTimerHandle) => void;
  #now: () => number;

  #mode = false;
  #capacity = 1;
  /** 已成功启动过的成员数：进入限流时的容量起点（"我们刚才能跑几个"）。 */
  #startedSuccessCount = 0;
  #lastRateLimitAt: number | undefined;
  #lastCapacityShrinkAt: number | undefined;
  #lastCapacityRecoveryAt: number | undefined;
  #globalRetryIntervalMs: number;
  /** 全局放量节流阀：一次放量后要等这么久才允许再放。 */
  #nextLaunchAt = 0;
  #wakeupTimer: SwarmTimerHandle | undefined;

  constructor(
    config: SwarmSchedulerConfig,
    clock: {
      now(): number;
      setTimeout: (handler: () => void, ms: number) => SwarmTimerHandle;
      clearTimeout(handle: SwarmTimerHandle): void;
    },
  ) {
    this.#config = config;
    this.#now = clock.now;
    this.#setTimeout = clock.setTimeout;
    this.#clearTimeout = clock.clearTimeout;
    this.#globalRetryIntervalMs = config.retryBaseMs;
  }

  get mode(): boolean {
    return this.#mode;
  }

  get capacity(): number {
    return this.#capacity;
  }

  get globalRetryIntervalMs(): number {
    return this.#globalRetryIntervalMs;
  }

  get nextLaunchAt(): number {
    return this.#nextLaunchAt;
  }

  get lastRateLimitAt(): number | undefined {
    return this.#lastRateLimitAt;
  }

  /** 成员首次 ready 时计数（进入限流时的容量起点）。只在正常模式累加。 */
  noteStarted(): void {
    if (!this.#mode) this.#startedSuccessCount += 1;
  }

  /**
   * 进入限流模式（首次）或在已处于限流模式时记一次限流（触发收缩）。
   *
   * 首次进入时容量起点取"已成功启动数"，下限 1：把并发直接压到 1 会让一次瞬时限流
   * 罚得比实际需要的更重，而已成功启动数正是"刚才确实跑得动几个"的实测值。
   */
  enter(now: number): void {
    if (!this.#mode) {
      this.#mode = true;
      this.#capacity = Math.max(1, this.#startedSuccessCount);
      this.#nextLaunchAt = Math.max(this.#nextLaunchAt, now + this.#config.retryBaseMs);
      this.#shrink(now, true);
      return;
    }
    this.#shrink(now, false);
  }

  /** 收缩容量。force = 首次进入限流（跳过防抖）；否则受 capacityShrinkDebounceMs 约束。 */
  #shrink(now: number, force: boolean): void {
    if (
      !force &&
      this.#lastCapacityShrinkAt !== undefined &&
      now - this.#lastCapacityShrinkAt < this.#config.capacityShrinkDebounceMs
    ) {
      return;
    }
    this.#capacity = Math.max(1, this.#capacity - 1);
    this.#lastCapacityShrinkAt = now;
  }

  /**
   * 容量恢复：每满 capacityRecoveryIntervalMs 就把容量 +1。
   *
   * **刻意无上界**（源仓决策笔记已论证，不得加 ceiling）：
   *   ① 唯一实际风险是"容量超过宿主并发上限"，而那道闸门由 maxConcurrency 独立把关，
   *      容量再大也放不出超过 maxConcurrency 的并发——上限的收益是零；
   *   ② 反过来，给容量设硬上限会把"可自愈"变成"可能永久锁死"：早期一次瞬时限流把容量
   *      压到 1 之后，若上界恰好等于当时的容量，恢复就再也推不动，批次只能靠成员陆续
   *      settle 慢慢磨；
   *   ③ 容量只影响"何时放量"的节奏，不影响正确性，收紧它带来的风险大于收益。
   */
  recover(now: number, pending: readonly ReadyAtSource[]): void {
    if (this.#nextCapacityRecoveryAt(pending) > now) return;
    this.#capacity += 1;
    this.#lastCapacityRecoveryAt = now;
    this.#nextLaunchAt = Math.min(this.#nextLaunchAt, now);
  }

  /** 成员在限流模式下 ready：重新锚定全局节流阀（轻罚，与 ready 与否无关）。 */
  noteReadyInRateLimit(now: number): void {
    this.#globalRetryIntervalMs = this.#config.retryBaseMs;
    this.#nextLaunchAt = now + this.#globalRetryIntervalMs;
  }

  /** 一次放量后推进全局节流阀。 */
  noteLaunch(now: number): void {
    this.#nextLaunchAt = now + this.#globalRetryIntervalMs;
  }

  /** 记一次限流发生（时间戳供恢复节奏使用）。 */
  noteRateLimit(now: number): void {
    this.#lastRateLimitAt = now;
  }

  /** 限流重排队后把全局节流阀至少推到 now + retryBaseMs（一律轻罚）。 */
  pushGlobalInterval(now: number): void {
    this.#nextLaunchAt = Math.max(this.#nextLaunchAt, now + this.#config.retryBaseMs);
  }

  #nextPendingReadyAt(pending: readonly ReadyAtSource[]): number {
    let min = Number.POSITIVE_INFINITY;
    for (const state of pending) min = Math.min(min, state.retryReadyAt);
    return min;
  }

  /** 正常模式累加的"已成功启动数"（进入限流时的容量起点）。 */
  get startedSuccessCount(): number {
    return this.#startedSuccessCount;
  }

  /** 供调用方计算"容量恢复时刻"的公开入口（与内部唤醒计算同一条公式）。 */
  nextCapacityRecoveryAt(pending: readonly ReadyAtSource[]): number {
    return this.#nextCapacityRecoveryAt(pending);
  }

  #nextCapacityRecoveryAt(pending: readonly ReadyAtSource[]): number {
    if (pending.length === 0 || this.#lastRateLimitAt === undefined) return Number.POSITIVE_INFINITY;
    return (
      Math.max(this.#lastRateLimitAt, this.#lastCapacityRecoveryAt ?? 0) + this.#config.capacityRecoveryIntervalMs
    );
  }

  /**
   * 计算下一次唤醒时刻，返回值**必然 > now**。
   *
   * 候选过期时退到容量恢复刻度，而不是随便退一个短间隔（例如 now + 1）：容量恢复是由时钟
   * 决定、**必然发生在未来**的下一个状态变化点，所以它既保证"定时器真的会触发一次状态
   * 变化"，又不会退化成忙等——恢复间隔是 180s 量级，每轮最多多一次 tick。
   *
   * 四个唤醒来源（全局节流 / 退避就绪 / 容量恢复 / 并发闸门）里，并发闸门的释放时刻
   * **不可预测**（只能等某个在跑成员 settle），于是"下一个可放量时刻"完全可能是过去时。
   * 旧实现在这种情形下直接把唤醒丢掉，批次只能靠"恰好有人 settle"续命；
   * 本函数的全函数性质（永远给出未来时刻）正是那条缺口的封堵。
   */
  nextWakeupAt(now: number, pending: readonly ReadyAtSource[], activeCount: number): number {
    const recoveryAt = this.#nextCapacityRecoveryAt(pending);
    const candidate =
      activeCount >= this.#capacity
        ? recoveryAt
        : Math.min(Math.max(this.#nextLaunchAt, this.#nextPendingReadyAt(pending)), recoveryAt);
    if (Number.isFinite(candidate) && candidate > now) return candidate;
    if (Number.isFinite(recoveryAt) && recoveryAt > now) return recoveryAt;
    // 兜底（限流模式下 lastRateLimitAt 必有值、且此处 pending 非空，故理论上不可达）：
    // 仍要给出一个有限且未来的复查刻度，绝不静默返回。
    const interval = this.#config.capacityRecoveryIntervalMs;
    return now + (Number.isFinite(interval) && interval > 0 ? interval : 1);
  }

  /** 武装唤醒定时器；wakeupAt 非有限或不在未来时**不装**（避免立即自旋）。 */
  armWakeup(wakeupAt: number, now: number, onWake: () => void): void {
    this.clearWakeup();
    if (!Number.isFinite(wakeupAt) || wakeupAt <= now) return;
    this.#wakeupTimer = this.#setTimeout(() => {
      this.#wakeupTimer = undefined;
      onWake();
    }, wakeupAt - now);
  }

  clearWakeup(): void {
    if (this.#wakeupTimer === undefined) return;
    this.#clearTimeout(this.#wakeupTimer);
    this.#wakeupTimer = undefined;
  }

  /** 只读快照（测试与日志用）。 */
  snapshot(): { capacity: number; mode: boolean; globalRetryIntervalMs: number; nextLaunchAt: number } {
    return {
      capacity: this.#capacity,
      mode: this.#mode,
      globalRetryIntervalMs: this.#globalRetryIntervalMs,
      nextLaunchAt: this.#nextLaunchAt,
    };
  }
}
