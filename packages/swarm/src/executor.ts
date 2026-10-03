/**
 * Swarm member executor — one lightweight turn per spec (feature-agent-swarm §5.2).
 *
 * A member is a FRESH Context + a fresh in-memory session log + a one-shot
 * AgentLoop running the expanded prompt. It is deliberately NOT a worker: no
 * registry row, no receipt file, no mailbox, nothing on disk. An interrupted
 * batch is cancelled, never resumed (§12).
 *
 * The seam combination is the one `packages/workers/src/driver.ts` already uses
 * for a driven worker (a fresh Context receiving the shared Llm / ToolRegistry /
 * AgentLoop plus its own SessionLog), so there is no second wiring shape in the
 * repo to learn.
 *
 * ── 三条铁律（本文件逐条落地，测试见 executor.test.ts）────────────────────────
 *
 * 1. **resolve = 成功，throw = 失败。**
 *    An attempt that returns normally is reported to the scheduler as
 *    `SwarmAttemptResult`, and a result renders as `outcome="completed"`.
 *    So returning a failure-shaped object would let the XML report a failed
 *    member as completed — the result IS the success signal, and there is no
 *    second channel that could disagree. Every non-success below therefore
 *    throws, including a member that produced no text.
 *
 * 2. **成员终态只认批次信号。**
 *    The batch signal is the only authority on whether a member may be reported
 *    as finished. The scheduler's timeout gate aborts the SAME member signal a
 *    user interrupt uses (types.ts SwarmSchedulerConfig.timeoutMs), so timeout
 *    and interrupt are indistinguishable BY CONSTRUCTION — a member that
 *    self-reports "I was cancelled" is guessing, and believing it would
 *    misreport a timeout as a clean finish. Two consequences here: an attempt
 *    that settles after its signal fired throws even if `runTurn` resolved
 *    normally (the loop answers a cancelled turn with outcome "cancelled" and
 *    does NOT throw), and a member entered with an already-aborted signal never
 *    starts at all (it must not be reported as started).
 *
 * 3. **取消必须清扫队列。**
 *    The queue sweep belongs to the scheduler and ONLY to the scheduler: it
 *    owns the pending view and is the only place that can settle a queued
 *    member (types.ts SwarmAbandonedEvent.outcome carries the "cancelled"
 *    word; SwarmOutcome has no such state, so the XML vocabulary is
 *    completed/failed/aborted). A second sweep here would be a second source of
 *    truth for member state. What this file owes that rule is the member half:
 *    an aborted attempt ALWAYS rejects (§2 above), so a cancelled member leaves
 *    the in-flight set instead of hanging, and a cancellation can never be
 *    re-queued as work.
 *
 * 成员工具集 = 宿主会话工具集剔除编排类工具（防嵌套，§5.2）：**不在本文件剔除**。
 * The ToolRegistry seam (packages/core/src/tool.ts) has no unregister and no
 * clone, so filtering here would mean inventing a second filter; instead the
 * wiring layer hands in the member-visible face. §5.2 names exactly
 * `agent_swarm` and `spawn_worker` as the orchestration tools to drop.
 *
 * 模型路由（feature §5.2）：`model` 按 `LlmRegistry` 的注册名解析（last-wins）。
 * 解析不到就抛结构化错误，**不静默回退**（不换默认模型），报错里**不带候选清单**
 * —— 本仓的 `model` 参数是注册名而不是模糊匹配，一个枚举所有注册名的报错只会
 * 把注册表泄进对话上下文，而调用方要改的是"名字写错了"这一件事。缺省 model =
 * 继承当前会话模型（deps.llm + deps.config.model）。
 */

import {
  AGENT_LOOP_SERVICE,
  LLM_SERVICE,
  SESSION_LOG_SERVICE,
  TOOL_REGISTRY_SERVICE,
  memoryEventStore,
  projectingSessionLog,
  usageAdd,
  zeroUsage,
  Context,
  type AgentConfig,
  type AgentLoop,
  type Llm,
  type LlmRegistry,
  type LoopEvent,
  type SessionLog,
  type ToolRegistry,
  type Usage,
} from "@celestea/core";
import type { SwarmAttemptResult, SwarmExecutor, SwarmTaskSpec } from "./types.js";

/** One member turn's loop bindings — the structural mirror of runtime's `LoopBindings`. */
export interface SwarmLoopBindings {
  config: AgentConfig;
  signal: AbortSignal;
  sink: (event: LoopEvent) => void;
  usage: { record(usage: Usage): void };
}

/** Builds one one-shot AgentLoop; supplied by the wiring layer (runtime's loopFactory). */
export type SwarmLoopFactory = (bindings: SwarmLoopBindings) => AgentLoop;

/** Error code carried by [SwarmModelError]; the tool renders it as a structured envelope. */
export const SWARM_MODEL_UNRESOLVED = "MODEL_UNRESOLVED";

/**
 * A `model` that the LlmRegistry does not know. Its own class (rather than a
 * bare Error) is what lets tool.ts answer with a structured, correctable
 * validation-shaped error instead of a generic "member failed" — while rule 1
 * still holds, because an unresolved model is thrown, never returned.
 *
 * The message deliberately names only the requested name: no candidate list.
 */
export class SwarmModelError extends Error {
  readonly code = SWARM_MODEL_UNRESOLVED;
  readonly model: string;

  constructor(model: string) {
    super(`Unknown swarm model '${model}': it is not a registered LlmRegistry name.`);
    this.name = "SwarmModelError";
    this.model = model;
  }
}

/**
 * 一个成员 attempt 已经**执行过工具调用**的事实（W9290 B1-04）。
 *
 * 为什么调度器要问这件事：限流（429/408/425）发生在 provider 响应阶段，此时成员的
 * **本地工具副作用通常已经发生**。整轮重放 = 副作用再跑一次（写文件两次、跑命令两次）。
 * 而调度器**看不到**成员的 log——所以由 executor 在它唯一有 log 的地方把答案带出来。
 *
 * 判据取 `tool_call` 而不是「成员有没有产出文本」：只有工具调用会动外部世界。
 */
function usedTool(log: SessionLog): boolean {
  for (const event of log.events()) {
    if (event.type === "tool_call") return true;
  }
  return false;
}

/** A member abandoned because the batch signal fired (rule 2 / rule 3). */

/**
 * A member whose turn reached a FAILED terminal state (the loop resolved, it did
 * not throw). Carries the turn's own kind + message so the reason survives the hop.
 *
 * `retryable` is the flag the scheduler's rate-limit classifier reads. It is set from
 * the turn's message because the turn contract keeps only the text — see
 * {@link RATE_LIMIT_LABEL} for why the label is a reliable read of the status.
 */
export class SwarmMemberFailedError extends Error {
  readonly code = "MEMBER_FAILED";
  readonly index: number;
  readonly kind: "generate" | "stream";
  /** True when the failure is a provider rate limit (HTTP 429). */
  readonly retryable: boolean;
  /**
   * True when this attempt already issued at least one tool call (W9290 B1-04).
   *
   * **调度器据此拒绝重放**：工具调用意味着外部世界的副作用已经发生，整轮重放会让它
   * 再发生一次。缺省 false = 「没有可重放的副作用」，于是**不碰工具的老成员**仍然能
   * 享受限流退避——把退避整个取消掉会损失真正的瞬时限流恢复能力，那不是本条要修的东西。
   */
  readonly usedTool: boolean;

  constructor(
    spec: SwarmTaskSpec,
    kind: "generate" | "stream",
    message: string,
    retryable: boolean,
    usedTool = false,
  ) {
    super(`Swarm member ${String(spec.index)} failed: ${message}`);
    this.name = "SwarmMemberFailedError";
    this.index = spec.index;
    this.kind = kind;
    this.retryable = retryable;
    this.usedTool = usedTool;
  }
}

/**
 * The repo's non-2xx message format starts with the numeric status
 * (`stream request failed: <label>: <body>`, and httpStatusLabel renders the label as
 * `"<status> <statusText>"` or just `"<status>"`). So a 429 in the turn's terminal
 * message is readable WITHOUT string-matching provider prose — and this is the only
 * place that turns a turn-terminal message into a rate-limit verdict.
 *
 * 408/425 count too: they are the repo's own RETRYABLE_HTTP_STATUSES alongside 429,
 * and the scheduler treats any rate limit the same way (back off, then re-queue).
 */
const RATE_LIMIT_LABEL = /\b(429|408|425)\b/;
export class SwarmMemberAbortedError extends Error {
  readonly code = "MEMBER_ABORTED";
  readonly index: number;

  constructor(spec: SwarmTaskSpec) {
    super(`Swarm member ${String(spec.index)} was aborted before it finished.`);
    this.name = "SwarmMemberAbortedError";
    this.index = spec.index;
  }
}

export interface SwarmExecutorDeps {
  /** The host session's Llm; used when the batch names no model. */
  llm: Llm;
  /** The member-visible tool face (orchestration tools already removed by the wiring). */
  tools: ToolRegistry;
  /** Builds the one-shot loop per attempt; the host's loopFactory. */
  loopFactory: SwarmLoopFactory;
  /** The host session's base config (system prompt, step budget, model default). */
  config: AgentConfig;
  /**
   * The batch's `model` parameter: an `LlmRegistry` registered name, or
   * undefined to inherit the host session's model.
   *
   * It is a SEPARATE field from `config.model` on purpose. `config.model` is
   * the host's already-resolved model id (what the loop sends to the provider),
   * while this parameter is a NAME to be looked up in the registry — routing
   * it through `config` would make every batch silently re-resolve the host's
   * model id as a registry name, and fail whenever that id is not also a
   * registered name.
   */
  model?: string;
  /** Needed only to resolve a `model` name; absent + a model name = unresolvable. */
  llmRegistry?: LlmRegistry;
  /** Member log factory (default: core's in-memory projecting log — nothing touches disk). */
  logFactory?: () => SessionLog;
  /**
   * Optional stable id for a member (rendered as `agent_id`). Absent = the
   * attribute is omitted: a lightweight turn has no session of its own, so
   * minting an id here would invent an address the runtime cannot resolve.
   */
  agentIdFor?: (spec: SwarmTaskSpec) => string;
}

/**
 * The member executor: one fresh Context + one one-shot loop per attempt.
 *
 * Per-member isolation that the wiring layer CANNOT provide: each attempt gets
 * its own session log, its own event sink and its own usage recorder. Sharing
 * the host's sink would let 20 concurrent members interleave their frames into
 * the host statusline, and sharing the host's usage accumulator would bill the
 * members to the host turn. Both are per-attempt objects that are dropped when
 * the attempt settles.
 */
export class SwarmMemberExecutor implements SwarmExecutor {
  private readonly deps: SwarmExecutorDeps;
  private readonly logFactory: () => SessionLog;
  /** Resolved once per batch, then reused: a 128-member batch would otherwise resolve 128 times. */
  private resolved: { llm: Llm; config: AgentConfig } | null = null;
  private resolutionError: unknown = null;

  constructor(deps: SwarmExecutorDeps) {
    this.deps = deps;
    this.logFactory = deps.logFactory ?? ((): SessionLog => projectingSessionLog(memoryEventStore()));
  }

  async run(spec: SwarmTaskSpec, context: SwarmAttemptContextLike): Promise<SwarmAttemptResult> {
    // Rule 2: a member entered with a fired signal never starts, so it must not
    // be reported as started. Checked BEFORE markReady for that reason alone.
    if (context.signal.aborted) throw new SwarmMemberAbortedError(spec);
    const { llm, config } = this.resolveModel();
    context.markReady();
    const log = this.logFactory();
    const attempt = this.attemptUsage();
    const agentId = this.deps.agentIdFor?.(spec);
    if (agentId !== undefined && agentId !== "") context.setAgentId(agentId);
    const loop = this.deps.loopFactory({
      config,
      signal: context.signal,
      // Member-local sink: the host's sink belongs to the host turn. Forwarding
      // member events there would interleave N members into one frame stream.
      sink: () => undefined,
      usage: attempt,
    });
    const ctx = memberContext(llm, this.deps.tools, log, loop);
    try {
      await loop.runTurn(ctx, spec.prompt);
    } catch (error) {
      // Rule 2 again: once the signal has fired, the member's own error is not
      // evidence about WHY it ended. Re-throwing it verbatim would hand the
      // scheduler a rate-limit-shaped error for a cancelled member, and the
      // retry branch would re-queue work that was already cancelled.
      if (context.signal.aborted) throw new SwarmMemberAbortedError(spec);
      throw error;
    }
    // The loop answers a cancelled turn with outcome "cancelled" and does NOT
    // throw, so reaching here proves nothing on its own — the signal decides.
    if (context.signal.aborted) throw new SwarmMemberAbortedError(spec);
    const result = lastAssistantText(log);
    if (result !== null) return { result };
    // No assistant text. Before this, the member reported one generic message and the
    // scheduler saw a plain Error — so a 429 became indistinguishable from a bug and
    // the rate-limit branch never ran. The turn's TERMINAL state is the only thing that
    // says what actually happened, so rethrow THAT (kind + message preserved).
    //
    // `retryable` is derived from the message because the turn contract only keeps the
    // text: a `stream request failed: 429 …` is a provider rate limit by the repo's own
    // label format (httpStatusLabel starts with the numeric status). Marking it retryable
    // is what routes the member into the scheduler's backoff instead of straight to failed.
    const terminal = terminalErrorOf(log);
    if (terminal === null) {
      throw new Error(`Swarm member ${String(spec.index)} produced no assistant message.`);
    }
    throw new SwarmMemberFailedError(
      spec,
      terminal.kind,
      terminal.message,
      RATE_LIMIT_LABEL.test(terminal.message),
      usedTool(log),
    );
  }

  /**
   * Resolve the batch's model WITHOUT running a member.
   *
   * tool.ts calls this before the scheduler starts, so an unresolvable model name is a
   * structured error on the FIRST member instead of 128 identical failures after 128
   * model calls. Throws [SwarmModelError]; the resolution is memoized either way, so
   * it costs nothing when the batch is fine.
   */
  resolveBatchModel(): void {
    this.resolveModel();
  }

  /** Resolve the batch's model once. Throws [SwarmModelError] — never falls back silently. */
  private resolveModel(): { llm: Llm; config: AgentConfig } {
    if (this.resolved !== null) return this.resolved;
    if (this.resolutionError !== null) throw this.resolutionError;
    const requested = requestedModel(this.deps);
    try {
      if (requested === null) {
        this.resolved = { llm: this.deps.llm, config: this.deps.config };
        return this.resolved;
      }
      const llm = this.deps.llmRegistry?.resolve(requested);
      if (llm === undefined) throw new SwarmModelError(requested);
      this.resolved = { llm, config: { ...this.deps.config, model: requested } };
      return this.resolved;
    } catch (error) {
      // Memoized so a 128-member batch reports the same cause once per member
      // instead of re-resolving; the scheduler settles on the first one anyway.
      this.resolutionError = error;
      throw error;
    }
  }

  private attemptUsage(): { record(usage: Usage): void } {
    let total = zeroUsage();
    return { record: (usage) => { total = usageAdd(total, usage); } };
  }
}

/** The attempt half of the scheduler's context (see types.ts SwarmAttemptContext). */
interface SwarmAttemptContextLike {
  readonly signal: AbortSignal;
  markReady(): void;
  setAgentId(agentId: string): void;
}

/**
 * A member Context: the shared seams (Llm / ToolRegistry / AgentLoop) plus THIS
 * attempt's own log. Mirrors `workerContext()` in packages/workers/src/driver.ts.
 */
function memberContext(llm: Llm, tools: ToolRegistry, log: SessionLog, loop: AgentLoop): Context {
  const ctx = Context.root();
  ctx.provide(LLM_SERVICE, llm);
  ctx.provide(TOOL_REGISTRY_SERVICE, tools);
  ctx.provide(SESSION_LOG_SERVICE, log);
  ctx.provide(AGENT_LOOP_SERVICE, loop);
  return ctx;
}

/**
 * The member's final answer, read from its OWN log rather than from the event
 * stream: the log is the repo's single source of truth for a conversation, and
 * a `done` event fires per model step (a tool-using step's "answer" is empty).
 */
function terminalErrorOf(log: SessionLog): { kind: "generate" | "stream"; message: string } | null {
  for (const event of log.events()) {
    if (event.type !== "turn_end") continue;
    const outcome = event.outcome;
    if (typeof outcome !== "object" || outcome === null) continue;
    return outcome.error;
  }
  return null;
}

function lastAssistantText(log: SessionLog): string | null {
  let text: string | null = null;
  for (const event of log.events()) {
    if (event.type === "assistant_message") text = event.text;
  }
  return text;
}

/**
 * The model NAME this batch asked for.
 *
 * Read from the deps rather than carried on the attempt: the batch routes as a
 * whole (feature §3.1), so one resolution per batch is the honest reading, and
 * putting it on SwarmExecutor.run would make it per-member state that a retry
 * could disagree with.
 */
function requestedModel(deps: SwarmExecutorDeps): string | null {
  const model = deps.model?.trim();
  return model === undefined || model === "" ? null : model;
}
