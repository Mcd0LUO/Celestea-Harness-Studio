/**
 * One turn, driven through the `AgentLoop` seam (`runtime/src/run.rs`).
 *
 * Responsibilities, in order:
 *   1. **single concurrency slot** — a Runtime generation runs at most one turn;
 *      a second `runTurn` while busy is a [TurnBusyError] (409), never a queue;
 *   2. **receipt drain** — pending worker receipts are polled out of the host
 *      mailbox and appended to the session log BEFORE the input, so a receipt is
 *      real, model-visible history on the host's next turn (W232);
 *   3. **stream mapping** — every `LoopEvent` the loop emits is fed to the
 *      statusline tracker and mapped to one host frame, in log order;
 *   4. **cancel propagation** — the caller's `AbortSignal` is linked to the
 *      turn's own signal, which is (a) passed to the loop bindings and
 *      (b) provided on the turn scope under `TURN_ABORT_SERVICE`;
 *   5. **terminal state** — read back from the session log's own `turn_end`
 *      (the log is the single source of truth), never invented by the runtime.
 *   6. **usage ledger observation** (W728) — when a ledger is wired, the turn
 *      boundary is announced to it (pure observation; it can never throw).
 */

import {
  AGENT_LOOP_SERVICE,
  type AgentConfig,
  type AgentLoop,
  type Context,
  type ContextUsageFacts,
  type ImageRef,
  type InjectionSource,
  type PendingInjection,
  type LoopEvent,
  type SessionEvent,
  type SessionLog,
  type TurnOutcome,
} from "@celestea/core";
import type { AfterInputRow } from "@celestea/agent-loop";
import { selectTurnContextRows } from "./turn-context-dedup.js";
import { ComposeError, RuntimeReleasedError, TurnBusyError } from "./errors.js";
import type { FrameMapper, LoopEventSink, TurnFrame } from "./frames.js";
import type { TurnLedgerHooks } from "./ledger.js";
import type { MemoryExtractionScheduler } from "./memory-extraction.js";
import type { StatusTracker } from "./status.js";
import { TURN_ABORT_SERVICE, TURN_SINK_SERVICE, USAGE_TRACKER_SERVICE } from "./tokens.js";
import type { UsageAccounting } from "./usage.js";

/** Host-side frame consumer (SSE publisher, CLI renderer, test collector). */
export type FrameSink = (frame: TurnFrame) => void;

/**
 * W888: one engine-owned turn-context row. The origin is what the transcript
 * uses to label the injected block instead of showing it as a user bubble.
 *
 * W9346: `goal` joined the set. The persistent session goal is resident turn
 * context like the skill catalog and the memory block, and it passes the SAME
 * three-state dedup (turn-context-dedup.ts) so an unchanged goal is not appended
 * once per turn.
 */
export interface TurnContextRow {
  readonly text: string;
  readonly origin: "skill" | "memory" | "goal";
}

export interface TurnOptions {
  /** Caller cancellation (linked into the turn's own signal). */
  signal?: AbortSignal;
  /** Frame consumer for this turn; absent = frames are dropped. */
  sink?: FrameSink;
  /**
   * W804: content-addressed image references for THIS turn's user message. The
   * loop writes them onto the `user_message` row; bytes never enter the log.
   */
  attachments?: readonly ImageRef[];
}

/** Collaborators handed to a per-turn loop instance (`with_bindings`). */
export interface LoopBindings {
  config: AgentConfig;
  signal: AbortSignal;
  sink: LoopEventSink;
  usage: UsageAccounting;
  /** Mid-turn injection source (absent = nothing can be injected). */
  injections?: InjectionSource;
  /**
   * W1900: the water level the compression nudge reads at BUILD time. The
   * host injects the runtime's OWN `contextUsage` answer — the loop must not
   * compute a second one, or the nudge and the statusline would quote
   * different numbers to the same operator. Absent = no nudge, which is
   * byte-for-byte the pre-Phase-2 request.
   */
  contextUsage?: () => ContextUsageFacts | null;
  /**
   * W9346: the one-shot row the loop appends RIGHT AFTER the turn's user input
   * (the session goal's change notice). The loop owns the position because the
   * input row is written there and nowhere else; the runner only carries the
   * source down. Absent = a loop with no notice channel at all.
   */
  afterInput?: () => AfterInputRow | null | undefined;
}

/** Builds the per-turn `AgentLoop`; the host injects its concrete loop here. */
export type LoopFactory = (bindings: LoopBindings) => AgentLoop;

/** Anything waiting to be appended to the log (user text, receipt, relay). */
export type PendingReceipt = PendingInjection;

export interface TurnRunnerDeps {
  ctx: Context;
  /** Current session log (a rebind swaps the producer, so this is a getter). */
  session: () => SessionLog;
  status: StatusTracker;
  usage: UsageAccounting;
  agentConfig: AgentConfig;
  frameMapper: FrameMapper;
  /**
   * Usage ledger hooks (W728 §3 P0): the turn boundary is only known HERE, and
   * the ledger must not guess it from a counter. Observation only — the ledger
   * swallows its own IO failures, so a turn cannot fail because of bookkeeping.
   */
  ledger?: TurnLedgerHooks;
  /**
   * Background memory extraction (docs/feature-memory-extraction.md Phase 1):
   * scheduled fire-and-forget at every turn end; the scheduler coalesces and
   * the host drains it at session eviction/shutdown.
   */
  extraction?: MemoryExtractionScheduler;
  /** Absent = the loop is resolved from `AGENT_LOOP_SERVICE` in the Context. */
  loopFactory?: LoopFactory;
  /**
   * The TURN-START drain (`next-turn` lane + session mailbox): receipts precede
   * the input (W232) and a follow-up queued while the session was idle is
   * appended before it (W515 §1: `placement: "queued"`).
   */
  drainPending?: () => PendingReceipt[];
  /**
   * The STEP-BOUNDARY source handed to the loop (`next-step` lane + session
   * mailbox). It carries `pending()` so the loop can refuse to close a turn
   * while a steering message is still waiting (W515 §1 invariant).
   */
  injections?: InjectionSource;
  /**
   * W884: durable, ENGINE-OWNED turn context — the skill catalog (name +
   * description only) and the F3 workspace MEMORY.md. Evaluated at EVERY turn
   * start, before the receipts and the input, and appended as ordinary user-role
   * history so it stays resident and participates in trimming/compaction like any
   * other message. Returning `[]` costs nothing (a workspace with neither).
   *
   * W888: each row carries its own `origin` so the transcript can label an
   * injected block ('skill' catalog vs 'memory') instead of showing it as a
   * typed user bubble.
   */
  turnContext?: () => readonly TurnContextRow[];
  /**
   * W1900: the loop's compression-nudge water level, wired from `compose` to
   * the SAME `contextUsage` the statusline reads, so the nudge, the
   * `context_status` tool and `/api/status` can never disagree.
   */
  contextUsage?: () => ContextUsageFacts | null;
  /**
   * W9346: the after-input notice SOURCE (the session goal's pending change).
   *
   * It is a callback, not a value, for the same reason `turnContext` is: the
   * notice is produced by an HTTP POST that can land at any moment, and a value
   * captured at compose time would deliver it once and never again (or not at
   * all).
   *
   * The runner PEEKS it once per turn at the start of `drive`, because the
   * suppression rule needs to know whether a notice is coming BEFORE the resident
   * rows are selected — and the loop then reads it again to build the row (with
   * the real `delivered` acknowledgement). The peek is side-effect free by
   * contract: a source that mutated on a peek would deliver the notice twice.
   */
  afterInput?: () => AfterInputRow | null | undefined;
}

export class TurnRunner {
  private readonly deps: TurnRunnerDeps;
  private busy = false;
  private controller: AbortController | null = null;
  private turnNo = 0;
  private released = false;
  /** The in-flight turn promise, so shutdown can wait for it (P1-5, W836). */
  private inFlight: Promise<TurnOutcome> | null = null;

  constructor(deps: TurnRunnerDeps) {
    this.deps = deps;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /** The in-flight turn's signal, or null between turns. */
  get currentSignal(): AbortSignal | null {
    return this.controller?.signal ?? null;
  }

  /** Turns started by this runner (diagnostics / tests). */
  get turnCount(): number {
    return this.turnNo;
  }

  /** Cancel the in-flight turn; returns false when nothing was running. */
  cancel(): boolean {
    if (this.controller === null) return false;
    this.controller.abort();
    return true;
  }

  /** Shutdown hook: stop driving, but keep no other state. */
  stop(): void {
    this.released = true;
    this.cancel();
  }

  async runTurn(input: string | null, opts: TurnOptions = {}): Promise<TurnOutcome> {
    if (this.released) throw new RuntimeReleasedError("the turn runner was stopped");
    if (this.busy) throw new TurnBusyError();
    this.busy = true;
    const controller = new AbortController();
    const unlink = opts.signal === undefined ? null : linkAbort(opts.signal, controller);
    this.controller = controller;
    const run = this.drive(input, opts, controller.signal);
    this.inFlight = run;
    try {
      return await run;
    } finally {
      unlink?.();
      this.controller = null;
      this.busy = false;
      this.inFlight = null;
    }
  }

  /**
   * P1-5 (W836): wait for the in-flight turn to settle. `stop()` only ABORTS it;
   * a shutdown that claims a clean exit must first see the turn's own terminal
   * write, or a crash inside that window strands the turn forever.
   */
  async join(): Promise<void> {
    const run = this.inFlight;
    if (run === null) return;
    try {
      await run;
    } catch {
      // The starter observes the outcome; shutdown only needs the turn stopped.
    }
  }

  private async drive(input: string | null, opts: TurnOptions, signal: AbortSignal): Promise<TurnOutcome> {
    this.turnNo += 1;
    this.deps.status.beginTurn();
    const sink = this.makeSink(opts.sink);
    const scope = this.turnScope(signal, sink);
    const log = this.deps.session();
    // W9346: is a change notice waiting? The PEEK exists for one reason — the
    // suppression rule below: a turn that delivers `[目标] 已更新：…` must not
    // ALSO append the resident `[目标] …` line, because the same change would then
    // be said twice in one turn. The row itself is appended by the loop after the
    // input, and the host clears its slot only once that append happened, so a
    // turn that dies earlier leaves the notice for the next one.
    const noticeComing = this.peekAfterInput();
    // W884: the skill catalog is standing context, so it lands BEFORE the
    // receipts (which are addressed messages and belong nearest the input).
    this.injectTurnContext(log, noticeComing);
    this.injectReceipts(log);
    const start = log.events().length;
    const loop = this.resolveLoop(signal, sink);
    this.deps.ledger?.beginTurn(log);
    let failure: unknown = null;
    try {
      await loop.runTurn(scope, input, opts.attachments);
    } catch (error) {
      failure = error;
    }
    try {
      const outcome = resolveOutcome(log.events(), start, signal, failure);
      this.deps.ledger?.endTurn(outcome);
      // Phase 1: AFTER the turn closes (and its ledger rows), fire-and-forget.
      // The skip gates live in the scheduler; a turn without eligible prose
      // costs nothing but a cursor save.
      this.deps.extraction?.schedule(log);
      return outcome;
    } catch (error) {
      // A wiring failure still closes the ledger's turn before it propagates:
      // the usage already booked belongs to a turn that will have no total.
      this.deps.ledger?.endTurn("interrupted");
      throw error;
    }
  }

  /** Feed the tracker, then map the event onto one host frame. */
  private makeSink(userSink?: FrameSink): LoopEventSink {
    return (event: LoopEvent) => {
      this.observe(event);
      userSink?.(this.deps.frameMapper(event));
    };
  }

  /**
   * W263口径: a step per tool CALL; deltas feed the rate window.
   * W1467: the delta TEXT goes in (not its length) — the tracker measures it with
   * the shared token estimator, which is what makes `tokens_per_sec` a real
   * token rate for CJK output instead of a character count.
   */
  private observe(event: LoopEvent): void {
    if (event.kind === "text") this.deps.status.addDelta(event.delta);
    else if (event.kind === "thinking") this.deps.status.addDelta(event.delta);
    else if (event.kind === "tool_call") this.deps.status.addStep();
  }

  /**
   * The turn scope: the root context plus the per-turn services. A loop
   * constructed from the Context (no factory) can resolve the signal and sink
   * here without importing this package.
   */
  private turnScope(signal: AbortSignal, sink: LoopEventSink): Context {
    const scope = this.deps.ctx.scoped();
    scope.provide(TURN_ABORT_SERVICE, signal);
    scope.provide(TURN_SINK_SERVICE, sink);
    scope.provide(USAGE_TRACKER_SERVICE, this.deps.usage);
    return scope;
  }

  private resolveLoop(signal: AbortSignal, sink: LoopEventSink): AgentLoop {
    const factory = this.deps.loopFactory;
    if (factory !== undefined) {
      const injections = this.deps.injections;
      const afterInput = this.deps.afterInput;
      return factory({
        config: this.deps.agentConfig,
        signal,
        sink,
        usage: this.deps.usage,
        ...(injections === undefined ? {} : { injections }),
        ...(this.deps.contextUsage === undefined ? {} : { contextUsage: this.deps.contextUsage }),
        // W9346: the SAME source the suppression peek used, handed to the loop so
        // it can read it again at the input row — the peek returned a boolean and
        // consumed nothing, so the notice is still waiting when the loop asks.
        ...(afterInput === undefined ? {} : { afterInput }),
      });
    }
    const loop = this.deps.ctx.get<AgentLoop>(AGENT_LOOP_SERVICE);
    if (loop === undefined) {
      throw new ComposeError("no AgentLoop: pass a loopFactory or mount an agentLoopPlugin");
    }
    return loop;
  }

  /**
   * W884: append the engine-owned turn context (the skill catalog). Blank rows
   * are dropped, so a provider that has nothing to say is free to return [""].
   *
   * Phase 0b: rows pass the three-state dedup first — an unchanged row that is
   * still model-visible is NOT appended again (turn-context-dedup.ts).
   *
   * W9346: `suppressResident` is the notice rule. When this turn will deliver a
   * goal change notice, the GOAL row is dropped for this turn only: the notice
   * itself carries the new text ("[目标] 已更新：X"), so adding the resident line
   * too would say the same thing twice in one turn. The suppression is scoped to
   * the `goal` origin — a skill catalog is a different fact and stays.
   */
  private injectTurnContext(log: SessionLog, noticeComing: boolean): void {
    const offered = this.deps.turnContext?.() ?? [];
    const rows = noticeComing ? offered.filter((row) => row.origin !== "goal") : offered;
    const selected = selectTurnContextRows(log, rows, this.deps.agentConfig);
    for (const row of selected) {
      // W888: the origin travels with the row so the projection can label it.
      log.append({ type: "user_message", text: row.text, origin: row.origin });
    }
  }

  /**
   * W9346: is a change notice waiting for this turn? A throwing source answers
   * "no" (a broken notice channel must not stop the turn the human asked for);
   * it is the same containment the loop applies when it asks again.
   */
  private peekAfterInput(): boolean {
    const afterInput = this.deps.afterInput;
    if (afterInput === undefined) return false;
    try {
      const row = afterInput();
      return row !== null && row !== undefined && row.text !== "";
    } catch (e) {
      process.stderr.write(`[celestea-runtime] afterInput source failed: ${String(e)}\n`);
      return false;
    }
  }

  /** Turn-start drain: receipts and interjections land BEFORE the input. */
  private injectReceipts(log: SessionLog): void {
    for (const receipt of this.drainPending()) {
      // W888: a worker receipt is NOT the human's voice.
      log.append({ type: "user_message", text: formatReceipt(receipt), origin: "receipt" });
    }
  }

  /** The single drain function shared by turn start and the step boundary. */
  private drainPending(): readonly PendingReceipt[] {
    return this.deps.drainPending?.() ?? [];
  }


}

/** `[from W1] content` — the receipt attribution the host log shows verbatim. */
export function formatReceipt(receipt: PendingReceipt): string {
  return receipt.from === "" ? receipt.text : `[from ${receipt.from}] ${receipt.text}`;
}

/**
 * Link a caller signal into the turn's controller. Returns the cleanup that
 * removes the listener again (P1-7, W836): `once:true` only removes it when the
 * source DOES abort, so a host signal that outlives many turns would otherwise
 * accumulate one listener per turn.
 */
export function linkAbort(source: AbortSignal, target: AbortController): () => void {
  if (source.aborted) {
    target.abort();
    return () => undefined;
  }
  const onAbort = (): void => target.abort();
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

/**
 * The terminal state of the turn that started at `from`: the LAST `turn_end`
 * appended after that index, with legacy rows (missing outcome) defaulting to
 * `completed` exactly like the JSONL codec does.
 */
export function lastTurnEndOutcome(events: readonly SessionEvent[], from: number): TurnOutcome | null {
  for (let i = events.length - 1; i >= from; i--) {
    const ev = events[i];
    if (ev !== undefined && ev.type === "turn_end") return ev.outcome ?? "completed";
  }
  return null;
}

/**
 * Resolve the outcome of a finished turn:
 *   1. a `turn_end` written by the loop wins — the log is the source of truth;
 *   2. otherwise the turn never terminated: a thrown error propagates (a wiring
 *      failure is not a terminal state), an aborted turn is `cancelled`, and a
 *      silently-stopped turn is `interrupted` (a torn turn is never `completed`).
 */
export function resolveOutcome(
  events: readonly SessionEvent[],
  from: number,
  signal: AbortSignal,
  failure: unknown,
): TurnOutcome {
  const fromLog = lastTurnEndOutcome(events, from);
  if (fromLog !== null) return fromLog;
  if (failure !== null && failure !== undefined) throw failure;
  return signal.aborted ? "cancelled" : "interrupted";
}
