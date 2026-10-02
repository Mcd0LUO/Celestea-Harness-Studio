/**
 * 成员七态状态机 + 订阅 + 合帧原语（纯内存、零依赖）。
 *
 * 搬运来源：dsh-agent-swarm 的 `swarm-registry.ts`（618 行），**裁剪**而来。
 *
 * **裁掉了什么、为什么**（Q3 裁定）：删掉 DSH remote 协议那部分——
 * SwarmOpenedFrame / SwarmRosterFrame / SwarmClosedFrame 三帧协议、`framesFor` 推流生成器、
 * `diffFrames`、`StreamCursor`、`visibleBatches` 的**帧投影**部分。
 * 判据：帧推流是 DSH SSE 的载体，而本仓 §7.1 明确**不加 SSE 事件名**，走
 * `Statusline.swarm?` 可选字段（apps/studio 组装 statusline 时从本注册表读）。
 * 那套帧投影在本仓没有载体，留着就是死代码 + 一份没人读的协议。
 * `visibleBatches` 本身**保留**（它读的是本文件自己维护的 beginSeq/endSeq，与帧无关），
 * 因为 `getLatestBatch` 与面板的"多批次"呈现都要用它。
 *
 * **留了什么**：beginBatch / markStarting / setAgentId / markReady / markSuspended /
 * markSettled / endBatch 的状态推进、终态粘性、`deriveBatchStatus` 推导、
 * 订阅的会话过滤与异常隔离、`OutputWaiter`、`sleepWithSignal`。
 *
 * **成员状态机（面板的数据源）**：pending → starting → running ⇄ retrying →
 * completed | failed | aborted。终态粘性：落定之后不再改变。
 * XML 才是成员状态的**唯一权威口径**，本注册表只是过程可见性（feature §6）。
 */

import { clipText } from "./text-clip.js";

/**
 * Well-known token for the swarm roster service in a Context.
 *
 * Lives HERE rather than in core because the registry is an implementation-level
 * service, not a seam: core holds only the seam tokens (LLM_SERVICE,
 * TOOL_REGISTRY_SERVICE, and friends). The same rule puts
 * PROCESS_REGISTRY_SERVICE in packages/tools/src/process/registry.ts, beside the
 * class it names.
 *
 * The host does NOT read this token directly: it peeks the registry off the runtime
 * instance (the same shape as RuntimeAdapter.workersOf), because the roster is
 * session-scoped and a global token would hand one session another session batch.
 * This token exists so the wiring layer can carry the instance into the Context.
 */
export const SWARM_REGISTRY_SERVICE = "celestea.swarm.SwarmRegistry";

/** 成员七态。前四态是"进行中"，后三态是终态。 */
export type SwarmPhase =
  | "pending"
  | "starting"
  | "running"
  | "retrying"
  | "completed"
  | "failed"
  | "aborted";

export interface SwarmMemberView {
  index: number;
  /** item 的显示摘要（超过 MEMBER_VIEW_ITEM_MAX_CHARS 时截断并补省略号）。 */
  item: string;
  /** item 原文长度；仅在 item 被截断时出现。 */
  itemChars?: number;
  agentId?: string;
  phase: SwarmPhase;
  retryCount: number;
  retryReadyAt?: number;
  startedAt?: number;
  settledAt?: number;
  /** 状态说明的显示摘要（超过 MEMBER_VIEW_DETAIL_MAX_CHARS 时截断）。 */
  detail?: string;
}

export interface SwarmBatch {
  swarmId: string;
  sessionId: string;
  description: string;
  /** 批次生效路由的展示标签（如 "deepseek/deepseek-chat"）；读不到时缺省，UI 留空不猜。 */
  routeLabel?: string;
  total: number;
  status: "running" | "completed" | "failed" | "aborted";
  startedAt: number;
  endedAt?: number;
  members: Map<number, SwarmMemberView>;
  /** 每次可观测变化 +1；订阅方可据此只重读变化了的批次。 */
  version: number;
  /** 开批次时的全局序号（单调递增，与墙钟无关，判定先后不受同毫秒影响）。 */
  beginSeq: number;
  /** 收批次时的全局序号；未结束为 undefined。 */
  endSeq?: number;
}

/** 成员视图里 item 摘要的最大码元数。 */
export const MEMBER_VIEW_ITEM_MAX_CHARS = 200;
/** 成员视图里 detail 摘要的最大码元数。 */
export const MEMBER_VIEW_DETAIL_MAX_CHARS = 500;
/** 单个会话同时可见的批次数上限（只保留最新的这么多个）。 */
export const MAX_VISIBLE_BATCHES = 8;

// ───────────────────────── 唤醒与合帧原语 ─────────────────────────

/** 唤醒标志等待器：两次 wait 之间的 wake 绝不丢失。 */
export class OutputWaiter {
  #dirty = false;
  #resolver?: () => void;

  wake(): void {
    this.#dirty = true;
    this.#resolver?.();
  }

  wait(signal: AbortSignal): Promise<void> {
    if (this.#dirty || signal.aborted) {
      this.#dirty = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const finish = () => {
        signal.removeEventListener("abort", finish);
        if (this.#resolver === finish) this.#resolver = undefined;
        this.#dirty = false;
        resolve();
      };
      this.#resolver = finish;
      signal.addEventListener("abort", finish, { once: true });
    });
  }
}

/** 合帧窗口：睡 ms 毫秒，或在 signal abort 时立即返回。 */
export function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", finish);
      resolve();
    }, ms);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
  });
}

// ───────────────────────── 注册表 ─────────────────────────

export interface SwarmRegistryOptions {
  /** 合帧窗口，默认 100ms。 */
  flushMs?: number;
  /** 每会话保留的最大批次数，默认 10（软上限：只淘汰已结束的批次）。 */
  maxRetainedBatches?: number;
  /** 保留的最大会话数，默认 64（按最近活跃淘汰；有运行中批次的会话不淘汰）。 */
  maxRetainedSessions?: number;
}

/** 变化监听器：参数是发生变化的会话。 */
export type SwarmRegistryListener = (sessionId: string) => void;

const TERMINAL_PHASES: ReadonlySet<SwarmPhase> = new Set(["completed", "failed", "aborted"]);

function isTerminal(phase: SwarmPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

/** 由成员相位推导批次终态：全 completed → completed；有 aborted 且无 failed → aborted；其余 → failed。 */
export function deriveBatchStatus(batch: SwarmBatch): SwarmBatch["status"] {
  let hasFailed = false;
  let hasAborted = false;
  let allCompleted = true;
  for (const m of batch.members.values()) {
    if (m.phase === "failed") hasFailed = true;
    if (m.phase === "aborted") hasAborted = true;
    if (m.phase !== "completed") allCompleted = false;
  }
  if (allCompleted) return "completed";
  if (hasAborted && !hasFailed) return "aborted";
  return "failed";
}

/**
 * 面板用的只读投影（Statusline.swarm? 的数据源）。
 *
 * 形状是 Lane D 面板的输入契约：批次描述 / 模型标签 / 成员相位数组 / done-total 计数。
 * 四个分组计数是面板"四组折叠"（进行中/失败/已完成/已取消）的直接依据，所以在这里一次算齐，
 * 让前端不必自己遍历成员数组数相位——那会让同一份口径在两个地方各写一遍。
 */
export interface SwarmRosterSnapshot {
  description: string;
  routeLabel?: string;
  total: number;
  /** 已落定的成员数（completed + failed + aborted）。 */
  done: number;
  status: SwarmBatch["status"];
  activeCount: number;
  completedCount: number;
  failedCount: number;
  abortedCount: number;
  /** 成员按 index 升序（1-based，与 XML 的编号同源）。 */
  members: SwarmMemberView[];
}
/**
 * 成员七态状态机 + 会话级订阅。
 *
 * 资源边界（照搬源仓）：会话数与每会话批次数都有上限；淘汰**只淘汰已结束的批次**，
 * 运行中的批次永不淘汰——它一旦被淘汰，之后的每次相位更新都会静默落空，面板会永远停在中途。
 */
export class SwarmRegistry {
  readonly #batches = new Map<string, SwarmBatch>();
  /** 会话 → 批次 id（开批次先后）。Map 的迭代顺序即会话最近活跃先后（开批次时移到末尾）。 */
  readonly #sessionBatches = new Map<string, string[]>();
  /** 全部批次 id（开批次先后），供不指定会话的读取使用。 */
  readonly #allBatchIds: string[] = [];
  readonly #listeners = new Set<SwarmRegistryListener>();
  readonly #flushMs: number;
  readonly #maxRetainedBatches: number;
  readonly #maxRetainedSessions: number;
  /** 全局单调序号：开批次与收批次各取一次，用于判定先后而不依赖墙钟。 */
  #seq = 0;

  constructor(options: SwarmRegistryOptions = {}) {
    this.#flushMs = options.flushMs ?? 100;
    this.#maxRetainedBatches = options.maxRetainedBatches ?? 10;
    this.#maxRetainedSessions = options.maxRetainedSessions ?? 64;
  }

  /** 合帧窗口（供组装 statusline 的合帧读取使用）。 */
  get flushMs(): number {
    return this.#flushMs;
  }

  #notify(sessionId: string): void {
    for (const listener of this.#listeners) {
      try {
        listener(sessionId);
      } catch {
        // 监听者自身的异常不得影响状态推进与其它监听者。
      }
    }
  }

  /** 订阅变化；监听器收到发生变化的会话 id。返回退订函数。 */
  subscribe(listener: SwarmRegistryListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** 一次可观测变化：批次版本 +1 并通知该会话。 */
  #touch(batch: SwarmBatch): void {
    batch.version += 1;
    this.#notify(batch.sessionId);
  }

  /** 取成员；批次或成员不存在时返回 undefined（迟到的回调对已淘汰批次一律静默）。 */
  #memberOf(swarmId: string, index: number): { batch: SwarmBatch; member: SwarmMemberView } | undefined {
    const batch = this.#batches.get(swarmId);
    const member = batch?.members.get(index);
    return batch !== undefined && member !== undefined ? { batch, member } : undefined;
  }
  beginBatch(
    sessionId: string,
    description: string,
    specs: readonly { index: number; item: string }[],
    now = Date.now(),
    routeLabel?: string,
  ): string {
    const swarmId = `swarm-${String(now)}-${Math.random().toString(36).slice(2, 8)}`;
    const members = new Map<number, SwarmMemberView>();
    for (const spec of specs) {
      const item = clipText(spec.item, MEMBER_VIEW_ITEM_MAX_CHARS);
      members.set(spec.index, {
        index: spec.index,
        item,
        ...(item === spec.item ? {} : { itemChars: spec.item.length }),
        phase: "pending",
        retryCount: 0,
      });
    }

    this.#seq += 1;
    const batch: SwarmBatch = {
      swarmId,
      sessionId,
      // description 同样来自模型、长度不可信，且随每个 opened / roster 帧下发：与 item 同样截成显示摘要。
      description: clipText(description, MEMBER_VIEW_ITEM_MAX_CHARS),
      ...(routeLabel === undefined ? {} : { routeLabel }),
      total: specs.length,
      status: "running",
      startedAt: now,
      members,
      version: 0,
      beginSeq: this.#seq,
    };

    this.#batches.set(swarmId, batch);
    this.#allBatchIds.push(swarmId);

    // 会话移到最近活跃的末尾（Map 迭代顺序即 LRU 顺序）。
    const ids = this.#sessionBatches.get(sessionId) ?? [];
    this.#sessionBatches.delete(sessionId);
    ids.push(swarmId);
    this.#sessionBatches.set(sessionId, ids);
    this.#enforceSessionBatchCap(ids, swarmId);
    this.#enforceSessionCap(sessionId);

    this.#touch(batch);
    return swarmId;
  }

  /**
   * 每会话批次数上限（软上限）：从最旧的**已结束**批次开始淘汰；全是运行中的批次时不淘汰。
   * 运行中的批次一旦被淘汰，它之后的每次相位更新都会静默落空，面板会把它永远停在中途。
   */
  #enforceSessionBatchCap(ids: string[], keep: string): void {
    while (ids.length > this.#maxRetainedBatches) {
      const victim = ids.findIndex((id) => id !== keep && this.#batches.get(id)?.endedAt !== undefined);
      if (victim < 0) return;
      const [removed] = ids.splice(victim, 1);
      if (removed !== undefined) this.#forget(removed);
    }
  }

  /** 会话数上限：从最久未活跃的会话开始整会话淘汰；有运行中批次的会话与当前会话跳过。 */
  #enforceSessionCap(current: string): void {
    if (this.#sessionBatches.size <= this.#maxRetainedSessions) return;
    for (const [sessionId, ids] of this.#sessionBatches) {
      if (this.#sessionBatches.size <= this.#maxRetainedSessions) return;
      if (sessionId === current) continue;
      if (ids.some((id) => this.#batches.get(id)?.endedAt === undefined)) continue;
      for (const id of ids) this.#forget(id);
      this.#sessionBatches.delete(sessionId);
    }
  }

  #forget(swarmId: string): void {
    this.#batches.delete(swarmId);
    const index = this.#allBatchIds.indexOf(swarmId);
    if (index >= 0) this.#allBatchIds.splice(index, 1);
  }

  markStarting(swarmId: string, index: number): void {
    const found = this.#memberOf(swarmId, index);
    if (!found || isTerminal(found.member.phase)) return;
    found.member.phase = "starting";
    this.#touch(found.batch);
  }

  setAgentId(swarmId: string, index: number, agentId: string): void {
    const found = this.#memberOf(swarmId, index);
    if (!found) return;
    found.member.agentId = agentId;
    this.#touch(found.batch);
  }

  markReady(swarmId: string, index: number, now = Date.now()): void {
    const found = this.#memberOf(swarmId, index);
    if (!found || isTerminal(found.member.phase)) return;
    found.member.phase = "running";
    if (found.member.startedAt === undefined) {
      found.member.startedAt = now;
    }
    this.#touch(found.batch);
  }

  markSuspended(
    swarmId: string,
    index: number,
    retryCount: number,
    retryReadyAt: number,
    detail?: string,
  ): void {
    const found = this.#memberOf(swarmId, index);
    if (!found || isTerminal(found.member.phase)) return;
    found.member.phase = "retrying";
    found.member.retryCount = retryCount;
    found.member.retryReadyAt = retryReadyAt;
    if (detail !== undefined) {
      found.member.detail = clipText(detail, MEMBER_VIEW_DETAIL_MAX_CHARS);
    }
    this.#touch(found.batch);
  }

  markSettled(
    swarmId: string,
    index: number,
    outcome: "completed" | "failed" | "aborted",
    detail?: string,
    now = Date.now(),
  ): void {
    const found = this.#memberOf(swarmId, index);
    if (!found) return;
    // 终态**粘性**：落定之后不再改变（与 markSuspended 的终态守卫对称）。
    //
    // 为什么必须如此：批次中断时调度器的 #abandonSuspended 会先把"尚未 ready"的成员
    // 通知成 aborted；而此刻可能仍有在飞的 ctx.subagents.start，它之后才 reject，
    // 宿主 catch 里会再调一次 markSettled("failed")。若允许覆写，这次"后到者"会把
    // 已落定的 aborted 改成 failed，批次又被 endBatch 推导成 failed，与 XML 侧
    // "全员 aborted"的结论重新矛盾——即 2026-10-01 审查 P1-2 的残余时序。
    // 反序同理：先到的终态才是真实发生过的那个结局。
    if (isTerminal(found.member.phase)) return;
    found.member.phase = outcome;
    found.member.settledAt = now;
    if (detail !== undefined) {
      found.member.detail = clipText(detail, MEMBER_VIEW_DETAIL_MAX_CHARS);
    }
    // 批次已收尾后才落定的成员（中断时成员的 run.result 异步收场，晚于宿主 finally 里的 endBatch）：
    // 重算批次状态，否则 status 会停在 endBatch 那一刻按残留相位推导出的 failed，与成员和 XML 不符。
    if (found.batch.endedAt !== undefined) found.batch.status = deriveBatchStatus(found.batch);
    this.#touch(found.batch);
  }

  endBatch(swarmId: string, now = Date.now()): void {
    const batch = this.#batches.get(swarmId);
    if (!batch) return;
    batch.endedAt = now;
    this.#seq += 1;
    batch.endSeq = this.#seq;

    // 根据成员状态推导批次最终状态
    //
    // 前提（中断收敛，WP-B 修复后）：调度器会把批次中断通知给**每一个**还没走到终态的
    // 成员——包括从未启动的排队成员（SwarmAbandonedEvent 的 agentId 可选，缺省即未启动）。
    // 因此正常结束时此处不应再看到 pending/starting/running/retrying：被中断的成员在
    // onAbandoned 里落 aborted，在跑的成员由宿主侧 run.result 回执落终态。
    //
    // 但仍保留 "非全 completed 且无 aborted → failed" 这条兜底，且**不**把残留相位强行
    // 归位成 aborted。为什么：残留相位在两种真实情况下仍可能出现——
    //   ① 批次根本没进调度器（调度器构造期因 config 非法直接抛出，宿主 finally 仍会
    //      调 endBatch），此时全员仍是 pending；
    //   ② 宿主接线漏挂了 onAbandoned 回调（或被中断时进程刚好结束），终态通知从未送达。
    // 这两种都是"批次没跑成"，推导成 failed 才如实；把它们改写成 aborted 等于把
    // "宿主没收到通知"伪装成"用户主动取消"，正是本次修复要消灭的那类静默失真。
    batch.status = deriveBatchStatus(batch);
    this.#touch(batch);
  }

  getBatch(swarmId: string): SwarmBatch | undefined {
    return this.#batches.get(swarmId);
  }

  /** 最新批次（指定会话内，或不指定会话时全局）。 */
  getLatestBatch(sessionId?: string): SwarmBatch | undefined {
    const ids = this.#batchIdsOf(sessionId);
    const lastId = ids[ids.length - 1];
    return lastId === undefined ? undefined : this.#batches.get(lastId);
  }

  /**
   * 当前可见批次（开批次先后，最后一个最新），最多 {@link MAX_VISIBLE_BATCHES} 个。
   *
   * 可见 = 未结束，或结束于最新批次开始**之后**（即与最新批次有时间重叠）。
   * 结束之后才有新批次开始的旧批次视为"被取代"，不再可见。
   */
  visibleBatches(sessionId?: string): SwarmBatch[] {
    const batches: SwarmBatch[] = [];
    for (const id of this.#batchIdsOf(sessionId)) {
      const batch = this.#batches.get(id);
      if (batch) batches.push(batch);
    }
    const latest = batches[batches.length - 1];
    if (latest === undefined) return [];
    const visible = batches.filter((batch) => batch.endSeq === undefined || batch.endSeq > latest.beginSeq);
    return visible.slice(-MAX_VISIBLE_BATCHES);
  }

  /** 空串与 undefined 同义：不限会话。 */
  #batchIdsOf(sessionId: string | undefined): readonly string[] {
    if (!sessionId) return this.#allBatchIds;
    return this.#sessionBatches.get(sessionId) ?? [];
  }


  /**
   * 面板用的只读投影（Statusline.swarm? 的数据源）：成员按 index 升序的**拷贝** + 四个计数。
   *
   * 为什么返回拷贝而不是活的 Map：调用方（statusline 组装）会把它挂到会话上供后续读取，
   * 返回内部 Map 就等于把可变状态泄漏出去——面板会看到「上一次读」与「这一次读」之间
   * 被别的代码改掉的成员。
   */
  snapshot(sessionId?: string): SwarmRosterSnapshot | undefined {
    const batch = this.getLatestBatch(sessionId);
    return batch === undefined ? undefined : this.#project(batch);
  }

  /** 对**指定批次**取同一份投影（搬运测试按批次断言，不按会话取最新）。 */
  snapshotOf(batch: SwarmBatch): SwarmRosterSnapshot {
    return this.#project(batch);
  }

  #project(batch: SwarmBatch): SwarmRosterSnapshot {
    const members = Array.from(batch.members.values(), (member) => ({ ...member })).sort(
      (a, b) => a.index - b.index,
    );
    let activeCount = 0;
    let completedCount = 0;
    let failedCount = 0;
    let abortedCount = 0;
    for (const m of members) {
      if (m.phase === "starting" || m.phase === "running" || m.phase === "retrying") activeCount += 1;
      else if (m.phase === "completed") completedCount += 1;
      else if (m.phase === "failed") failedCount += 1;
      else if (m.phase === "aborted") abortedCount += 1;
    }
    return {
      description: batch.description,
      ...(batch.routeLabel === undefined ? {} : { routeLabel: batch.routeLabel }),
      total: batch.total,
      done: completedCount + failedCount + abortedCount,
      status: batch.status,
      activeCount,
      completedCount,
      failedCount,
      abortedCount,
      members,
    };
  }
}
