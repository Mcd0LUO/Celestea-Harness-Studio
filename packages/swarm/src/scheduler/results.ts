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
  | { type: "rate_limited"; agentId?: string; error: unknown };

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
      return { type: "rate_limited", ...(agentId === undefined ? {} : { agentId }), error };
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
