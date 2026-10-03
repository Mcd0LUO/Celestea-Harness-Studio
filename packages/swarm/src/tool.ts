/**
 * agent_swarm — the tool the model actually calls.
 *
 * Pipeline, in this order:
 *   1. spec from the frozen contract (contracts/tools.json, via core loadTools) —
 *      never a second hand-written copy, so GET /api/tools and the model prompt can
 *      never drift from the spec this file executes. A missing entry THROWS
 *      (fail-closed), exactly like workerToolSpec() in packages/workers/src/tools.ts.
 *   2. validate (Lane A) — the six hard checks, before any member starts.
 *   3. exclusivity self-check (this file) — see the block below.
 *   4. schedule (Lane A) — runSwarm with a per-batch executor.
 *   5. render (Lane A) — renderSwarmResultSafely into one XML block.
 *
 * 失败是结果不是异常 (ARCHITECTURE §6.2): every expected failure returns the
 * envelope {ok:false, step, error} so the model can correct itself. The only throws
 * are contract-level (a missing tools.json entry) and programming errors — a batch
 * that is merely bad input must never kill the turn.
 *
 * ── 排他性约束（feature §3.3，本仓拍板：工具内自检）─────────────────────────────
 * agent_swarm must be the ONLY tool call in one assistant reply: nothing in that
 * reply's context is relevant to any member.
 *
 * 判据与取舍（为什么精度天然差一档）: the check counts CONCURRENT calls inside one
 * dispatch batch — a process-wide window opened by the first call and closed when
 * the last one settles. Two calls in DIFFERENT steps of the same turn, or one
 * arriving after the previous has already settled, are NOT caught. A tool cannot
 * see the loop step boundaries, and the accurate detector (agent-loop's
 * dispatchToolCalls) was explicitly rejected in favour of not touching the loop's
 * dispatch path. A window outliving the batch would trade this miss for false
 * positives ACROSS turns. The tool-side window is the cheaper failure: a model that
 * disobeys is already off-contract, and the frozen tool description states the rule.
 */

import {
  isRecord,
  loadTools,
  type Tool,
  type ToolExecOutcome,
  type ToolInput,
  type ToolSpec,
} from "@celestea/core";
import { SwarmMemberExecutor, SwarmMemberFailedError, SwarmModelError, type SwarmExecutorDeps } from "./executor.js";
import type { SwarmRegistry } from "./roster.js";
import { renderSwarmResultSafely } from "./result-xml.js";
import { runSwarm } from "./scheduler/index.js";
import {
  DEFAULT_SWARM_SCHEDULER_CONFIG,
  type SwarmSchedulerConfig,
  type SwarmSchedulerDeps,
  type SwarmTaskResult,
} from "./types.js";
import { validateSwarmInput } from "./validate.js";

/** {ok:false, step, error} — the tool-facing failure envelope (same shape as workers). */
function contractError(step: string, error: string): Record<string, unknown> {
  return { ok: false, step, error };
}

/** The one tool name this package contributes (the frozen contract name). */
export const SWARM_TOOL_NAME = "agent_swarm";

/**
 * Orchestration tools a member may NOT call (§5.2 — exactly these two).
 *
 * send_message / stop_worker / worker_status are deliberately NOT here: they address
 * RESIDENT worker sessions, which a batch member has no concept of. Only the two
 * tools that would let a member spawn MORE work are folded (upstream maxDepth=1).
 */
export const SWARM_NESTED_TOOL_NAMES: readonly string[] = [SWARM_TOOL_NAME, "spawn_worker"];

/** Spec straight out of the frozen contract (throws when the contract lost it). */
export function swarmToolSpec(name: string = SWARM_TOOL_NAME): ToolSpec {
  const found = loadTools().tools.find((t) => t.name === name);
  if (found === undefined) throw new Error("contracts/tools.json has no tool: " + name);
  return { name: found.name, description: found.description, parameters: found.parameters };
}

export interface SwarmToolDeps extends SwarmExecutorDeps {
  /**
   * Scheduler tuning; omitted = the frozen defaults in types.ts.
   *
   * Named schedulerConfig, NOT config: `SwarmToolDeps` extends `SwarmExecutorDeps`,
   * whose `config` is the AgentConfig the member turn runs with. Two different
   * `config` meanings in one object is a silent-mispatch bug waiting to happen.
   */
  schedulerConfig?: Partial<SwarmSchedulerConfig>;
  /** Rate-limit classifier; omitted = the LlmError field test below. */
  isRateLimitError?: (error: unknown) => boolean;
  /**
   * Batch cancellation (the host turn's signal).
   *
   * **一个批次一个信号**：它在 `runBatch` 入口解析一次，整批（连同每个成员的中继信号）都用
   * 它，所以「终态只认批次信号」这条契约在语义上仍然是「同一批共用一个权威」。
   */
  signal?: AbortSignal;
  /**
   * 批次取消的**延迟求值来源**（W9290 B1-01）。
   *
   * 为什么与 `signal` 并存：取消信号是**每个 turn 各自新建**的（见 `TurnRunner.runTurn`），
   * 而工具是**整个 session 一份**。只挂一个具体 `AbortSignal` 的话，它会一直是第一批那个
   * turn 的信号——第一批结束���，之后每批的「用户按停止」都传不进来，成员只能各自烧到
   * `timeoutMs`（默认 2 小时）。`signalProvider` 让每批在**开跑那一刻**问一次「现在这一轮
   * 的信号是哪个」，`null`（轮次之间）按无取消通道处理。
   *
   * 优先级：`signalProvider` 解析出的值 > `signal`。两者都缺省 = 无取消通道（与修复前等价）。
   */
  signalProvider?: () => AbortSignal | null;
  /** Progress observer for the statusline panel (optional). */
  onProgress?: (results: readonly SwarmTaskResult[]) => void;
  /**
   * The member roster (the panel's data source, feature §7). Absent = no roster is
   * advanced and the tool behaves exactly as before; the batch still works, the
   * panel simply has nothing to show. That is the honest degradation: a missing
   * registry must never fail a batch.
   */
  registry?: SwarmRegistry;
  /**
   * The session this batch belongs to, recorded on the roster so a host reading
   * per-session snapshots gets this batch and no other. Defaults to a constant so
   * an un-wired host still produces a coherent single-session view.
   */
  sessionId?: string;
}

/**
 * The batch-in-flight window, process-wide.
 *
 * Module scope rather than per-tool state because EXCLUSIVITY is a property of one
 * assistant reply, not of one object: a host (or a test) may hold two tools built from
 * the same deps, and the rule must still hold across both.
 */
let inFlight = 0;

export function swarmTool(deps: SwarmToolDeps): Tool {
  return {
    spec: () => swarmToolSpec(),
    async execute(args: unknown): Promise<unknown> {
      return runBatch(deps, args);
    },
    // The loop assigns call_id; execute() alone cannot see sibling calls, so the
    // exclusivity check rides this seam (same reason run_code implements it).
    async executeWith(input: ToolInput): Promise<ToolExecOutcome> {
      return { value: await runBatch(deps, input.args), render: null };
    },
  };
}

/** The batch chain; every expected failure leaves through the envelope. */
async function runBatch(deps: SwarmToolDeps, args: unknown): Promise<unknown> {
  // Exclusivity FIRST: a batch refused for being non-exclusive must not then be
  // rejected for its arguments — the model fixes one thing per attempt.
  if (inFlight > 0) {
    return contractError(
      "exclusive",
      "agent_swarm must be the only tool call in one reply: a second concurrent agent_swarm was refused. Run the other tool in a separate turn.",
    );
  }
  inFlight += 1;
  try {
    return await dispatchBatch(deps, args);
  } finally {
    // The window closes even when the batch throws, or one bad batch would wedge
    // every later agent_swarm in the process for the rest of the session.
    inFlight -= 1;
  }
}
async function dispatchBatch(deps: SwarmToolDeps, args: unknown): Promise<unknown> {
  const validation = validateSwarmInput(readRequest(args));
  if (!validation.ok) {
    return contractError("validate", validation.error.message);
  }
  const executor = new SwarmMemberExecutor(deps);
  // The model name is resolved by the executor, which THROWS SwarmModelError rather
  // than falling back. Here it becomes a structured error so the model can correct it.
  try {
    executor.resolveBatchModel();
  } catch (error) {
    if (error instanceof SwarmModelError) return contractError("model", error.message);
    throw error;
  }
  const registry = deps.registry;
  // The label and route are the MODEL's own words (contract `description` / `model`),
  // so the panel shows what the model actually asked for rather than a re-derivation.
  // Lane C observed validate.ts never reads `description`; it is still carried here
  // because the panel's header needs it, and reading it here cannot fail a batch.
  const request = readRequest(args);
  const label = typeof request.description === 'string' ? request.description : DEFAULT_BATCH_LABEL;
  const modelName = typeof request.model === 'string' ? request.model : undefined;
  // No registry = no panel data, but the batch still runs (see the deps doc).
  if (registry === undefined) {
    const { xml } = await runBatchResults(deps, validation.specs, executor);
    return { xml };
  }
  return runWithRoster({ deps, registry, specs: validation.specs, executor, label, routeLabel: modelName });
}

async function runBatchResults(
  deps: SwarmToolDeps,
  specs: readonly { index: number; item: string; prompt: string; kind: "spawn" }[],
  executor: SwarmMemberExecutor,
): Promise<{ xml: string; batchResults: readonly SwarmTaskResult[] }> {
  const results = await runSwarm(specs, schedulerDeps(deps, executor), {
    ...DEFAULT_SWARM_SCHEDULER_CONFIG,
    ...(deps.schedulerConfig ?? {}),
  });
  deps.onProgress?.(results);
  // The results travel with the XML so the roster settles from the very array the
  // XML was rendered from (one truth for the panel and for the model).
  return { xml: renderSwarmResultSafely(results), batchResults: results };
}

/**
 * The batch with roster bookkeeping around it (feature §7 data source).
 *
 * **beginBatch / endBatch are paired by try-finally, without exception.** A batch that
 * throws, or a host that aborts mid-flight, would otherwise leave the batch stuck at
 * status `running` forever: the panel would show a spinner for a batch that ended
 * minutes ago, and `visibleBatches` would keep it (running batches are never evicted).
 *
 * **终态只认批次信号**（与 executor 铁律 2 同源）: a member settles as `aborted` iff the
 * BATCH signal fired, otherwise `failed`. The member's own account is not evidence —
 * the timeout gate aborts the same member signal an interrupt does, so the two are
 * indistinguishable by construction.
 *
 * Settling is done from the scheduler RESULTS (not from live callbacks) and it is
 * **unconditional**: `markSettled` is terminal-sticky, so a member already settled by
 * `onAbandoned` keeps its first, truthful outcome and a late `failed` cannot overwrite
 * an `aborted` (the 2026-10-01 P1-2 residue this registry already guards).
 */
/** The inputs of one roster-advancing batch (one object, per the repo's max-params rule). */
interface RosterBatch {
  deps: SwarmToolDeps;
  registry: SwarmRegistry;
  specs: readonly { index: number; item: string; prompt: string; kind: "spawn" }[];
  executor: SwarmMemberExecutor;
  label: string;
  routeLabel: string | undefined;
}

async function runWithRoster(batch: RosterBatch): Promise<unknown> {
  const { deps, registry, specs, executor, label, routeLabel } = batch;
  const sessionId = deps.sessionId ?? DEFAULT_ROSTER_SESSION;
  const swarmId = registry.beginBatch(sessionId, label, specs, Date.now(), routeLabel);
  // Members are marked STARTING here and become RUNNING when the scheduler reports
  // them ready; the terminal is settled from the scheduler's own result afterwards.
  // Nothing is inferred from the roster's current phase: a phase left at `starting`
  // is genuinely unknown, and reading it as `failed` would contradict a batch whose
  // members all completed (the 2026-10-01 P1-2 shape).
  for (const spec of specs) registry.markStarting(swarmId, spec.index);
  let results: readonly SwarmTaskResult[] | null = null;
  try {
    // runBatchResults returns the XML; the results behind it are captured here so the
    // finally can settle members from the SAME array the XML was rendered from. A
    // module-level variable would be wrong: two concurrent batches (different tools)
    // would overwrite each other's results.
    const { xml, batchResults } = await runBatchResults(deps, specs, executor);
    results = batchResults;
    return { xml };
  } finally {
    // Settle first, close second: endBatch derives the batch status from member phases,
    // so it must run after every member is terminal or it would read leftovers as
    // failed. The finally path guarantees this on throw/cancel too — a batch that
    // never yields results settles as aborted (batch signal) or failed (never ran).
    settleMembers(registry, swarmId, specs, results, deps.signal);
    registry.endBatch(swarmId);
  }
}

/**
 * Settle every member from the scheduler's own results.
 *
 * The results array IS the same source the XML renders, so the panel and the answer
 * the model reads are derived from one truth rather than two inferences. Members
 * missing from it (the scheduler could not produce a result at all) fall back to the
 * batch-signal rule: aborted when the signal fired, otherwise failed.
 */
function settleMembers(
  registry: SwarmRegistry,
  swarmId: string,
  specs: readonly { index: number }[],
  results: readonly SwarmTaskResult[] | null,
  signal: AbortSignal | undefined,
): void {
  const aborted = signal?.aborted === true;
  const byIndex = new Map((results ?? []).map((r) => [r.spec.index, r] as const));
  for (const spec of specs) {
    // markReady BEFORE the settle: a completed member should read as having run.
    if (byIndex.has(spec.index)) registry.markReady(swarmId, spec.index);
    const result = byIndex.get(spec.index);
    const outcome = result === undefined ? (aborted ? 'aborted' : 'failed') : result.outcome;
    // Unconditional: markSettled is terminal-sticky, so a member already settled by
    // onAbandoned keeps its first truthful outcome and cannot be flipped afterwards.
    registry.markSettled(swarmId, spec.index, outcome, result?.error);
  }
}


/** The session id recorded on a batch when the host wired none. */
const DEFAULT_ROSTER_SESSION = "cli-main";

/** The panel header when the model sent no `description` (schema normally requires it). */
const DEFAULT_BATCH_LABEL = "swarm batch";

/**
 * The wire shape is the CONTRACT's (snake_case: prompt_template, items, model);
 * validate.ts speaks this repo's camelCase (promptTemplate). This is the only place
 * that sees both, so the mapping is explicit and per-field.
 *
 * Why NOT a generic de-underscore-and-case: the contract sets additionalProperties:false,
 * so an unknown key is a contract violation. A generic converter would quietly turn
 * an arbitrary typo into a plausible field name and the batch would run with it.
 */
function readRequest(args: unknown): Record<string, unknown> {
  if (!isRecord(args)) return {};
  const request: Record<string, unknown> = {
    items: args["items"],
    promptTemplate: args["prompt_template"],
  };
  // `description` is NOT a validate.ts input (the six checks never read it), but the
  // roster needs it as the panel's header, so it is mapped here rather than being
  // re-read off the raw args at the call site.
  const description = args["description"];
  if (typeof description === "string") request["description"] = description;
  // Pass through only when present and a string: an absent field must stay ABSENT so
  // validate.ts's own "missing template" / "not a string" branches stay reachable.
  const model = args["model"];
  if (typeof model === "string") request["model"] = model;
  return request;
}

/**
 * 本批的取消信号：每批解析**一次**，整批共用。
 *
 * 为什么在 `schedulerDeps` 里解析而不是每次用到时现问：调度器在 `SwarmSchedulerDeps` 上
 * 读 `signal`（加监听、查 `aborted`），一个批次必须自始至终是**同一个** AbortSignal 实例——
 * 每问一次换一个实例，等于给同一批装了两条互不相识的取消链，成员会各听各的。
 *
 * 解析顺序：`signalProvider()`（每轮现问，优先）> `signal`（宿主给的固定信号）。
 */
function batchSignalOf(deps: SwarmToolDeps): AbortSignal | undefined {
  const live = deps.signalProvider?.() ?? null;
  if (live !== null) return live;
  return deps.signal;
}

/** Wire the scheduler to the batch's executor and the host's seams. */
function schedulerDeps(deps: SwarmToolDeps, executor: SwarmMemberExecutor): SwarmSchedulerDeps {
  const batchSignal = batchSignalOf(deps);
  return {
    now: () => Date.now(),
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    executor,
    isRateLimitError: deps.isRateLimitError ?? isRateLimitErrorFromLlmError,
    // randomFn is the scheduler's jitter source (types.ts); Math.random is the
    // documented default, so it is left unset rather than passed explicitly.
    ...(batchSignal === undefined ? {} : { signal: batchSignal }),
  };
}

/**
 * Rate-limit test: the provider's OWN classification.
 *
 * Why structural (feature §4 "限流信号"): a member's LlmError carries httpStatus and
 * a conservative retryable flag, so this repo can enable the rate-limit branch BY
 * DEFAULT — the upstream build could not, because its host did not pass the code up.
 * A status check alone would be wrong (429 is retryable but a 400 is not), and the
 * flag alone is the documented conservative default (false with no evidence).
 */
function isRateLimitErrorFromLlmError(error: unknown): boolean {
  // A member whose turn reached a failed TERMINAL state (the loop resolved rather
  // than threw) arrives as SwarmMemberFailedError, carrying the verdict already
  // derived from that turn's own message. Reading it here is what makes §4's backoff
  // reachable on the REAL path — before this, such a member was a plain Error and
  // every provider rate limit looked like a bug.
  if (error instanceof SwarmMemberFailedError) return error.retryable;
  if (typeof error !== "object" || error === null) return false;
  const status = (error as { httpStatus?: unknown }).httpStatus;
  return status === 429 || (error as { retryable?: unknown }).retryable === true;
}

