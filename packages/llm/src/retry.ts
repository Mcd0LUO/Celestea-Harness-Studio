/**
 * Same-target retry decorator (W9104) — a `Llm`, not a new seam.
 *
 * The fallback decorator (`fallback.ts`) HANDS OVER to another target; this one
 * re-issues the SAME request against the SAME target. They are two different
 * questions, and when both are armed the ACTUAL nesting is retry-INNER,
 * fallback-OUTER — each target gets its own retry decorator, so "the current
 * endpoint is retried `maxRetries` times, and only then does the chain hand
 * over to the next target":
 *
 *     createFallbackLlm({ clientFor })        <- hands over to target B
 *       └─ createRetryLlm({ inner: client })  <- retries target A maxRetries times
 *
 * (F-05 correction: this header used to draw the opposite nesting, retry
 * OUTSIDE fallback. That would re-run the WHOLE chain — A then B — `maxRetries`
 * times, which is not what `apps/studio/src/runtime/fallback-host.ts` builds.
 * The wiring is the source of truth; the two compositions are not equivalent.)
 *
 * The decorator is ALSO usable standalone: with no fallback chain configured
 * (`CELESTEA_LLM_FALLBACK` off, the default) the host wraps the single composed
 * client in it directly, so same-target retry is not hostage to the fallback
 * switch.
 *
 * **Why retry-first** (the order is a product decision, not an accident): a
 * 503/timeout/idle-stall is usually a blip on an endpoint that is otherwise
 * serving this deployment well. Switching target costs a different MODEL
 * (quality changes under the user) plus a cold connection; retrying the same
 * target first keeps the user's configured model in force, and only an endpoint
 * that fails `maxRetries + 1` times in a row is treated as "this target is
 * down" and left behind. The fallback decorator's per-target failure counter
 * (`failureThreshold`) therefore keeps counting the retried attempt, which is
 * exactly what "consecutive failures on this target" should mean.
 *
 * What this decorator owns (each mechanically testable):
 *   1. the TRIGGER TABLE — reused verbatim from `fallback.ts`
 *      (`describeFailure` / `describeEvent` / `isProducedEvent`); no second
 *      classification vocabulary exists. A non-retryable status (400/401/403/
 *      404/422), a caller abort and a produced attempt are all terminal;
 *   2. the PRODUCED LOCK — once a text/thinking delta reached the consumer the
 *      attempt is NEVER re-issued (re-issuing would drop text the user already
 *      saw and double-bill the provider);
 *   3. BACKOFF — attempt k waits `backoffMs * 2^k`; a `Retry-After` the failure
 *      carried wins over the exponential, and either way the wait is CLAMPED
 *      into `[0, maxDelayMs]` (an over-cap header means "wait the cap", never
 *      "retry instantly"). The sleep is injectable, so tests never really wait;
 *   4. VISIBILITY — every retry is reported through `onRetry`, so "this was a
 *      retry" can never be silent;
 *   5. ONE USAGE FRAME PER `generate()` (W9225 / F-04) — the usage of every
 *      attempt is SUMMED and forwarded exactly once, just before the terminal
 *      event, instead of forwarding each attempt's frame. The ledger books one
 *      row per `generate()` with an OVERWRITE-style `record`, while the
 *      agent-loop's `UsageTracker` is ADDITIVE; forwarding N frames therefore
 *      made the statusline show N attempts' tokens and the ledger only the last
 *      one, so neither agreed with the other or with the real bill. One summed
 *      frame makes all three the same number.
 *
 * Honest boundary: the ledger still books ONE step per `generate()` call, so an
 * un-armed (no fallback) retry sequence is one ledger row while the audit/SSE
 * channel shows every retry. That row's usage is now the TRUE total (see #5).
 * Per-attempt ledger rows are the fallback decorator's job (it owns `beginStep`
 * per target attempt).
 *
 * W9225 (F-10): a `Retry-After` LARGER than `maxDelayMs` is not merely clamped
 * — it forbids the same-target re-issue outright. The retry decorator cannot
 * honour "come back in 120s" (it would wait 60s at most), and re-issuing anyway
 * is what multiplied one rate-limited turn into `targets x (maxRetries+1)`
 * upstream calls. Declining here hands the decision to the OUTER fallback
 * decorator, which switches target instead of hammering the same one.
 */

import {
  DEFAULT_FALLBACK_POLICY,
  describeEvent,
  describeFailure,
  isProducedEvent,
  type FailureInfo,
  type StatusTable,
} from "./fallback.js";
import { usageAdd, type Usage } from "@celestea/core";
import type { Llm, LlmStream, ModelRequestDraft, StreamEvent } from "./seam.js";

/**
 * Hard ceiling of EXTRA same-target attempts. The value is the extra retries,
 * never the total: `maxRetries: 3` = up to 4 attempts on one target.
 */
export const MAX_RETRIES = 3;

/** The retry policy: counts, backoff and the shared status trigger table. */
export interface RetryPolicy {
  /** EXTRA attempts on the same target (0 = never retry). Clamped to [0, MAX_RETRIES]. */
  maxRetries: number;
  /** Base backoff: attempt k waits `backoffMs * 2^k` ms. */
  backoffMs: number;
  /** Ceiling for ONE wait; `Retry-After` is clamped to it, never discarded. */
  maxDelayMs: number;
  /** Honour the failure's `Retry-After`; false = pure backoff. */
  respectRetryAfter: boolean;
  /** Reused from the fallback trigger table (one home, two decorators). */
  notRetryableStatuses: number[];
  retryableStatuses: number[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 1,
  backoffMs: 500,
  maxDelayMs: 60_000,
  respectRetryAfter: true,
  notRetryableStatuses: [...DEFAULT_FALLBACK_POLICY.notRetryableStatuses],
  retryableStatuses: [...DEFAULT_FALLBACK_POLICY.retryableStatuses],
};

/**
 * The one place "how many retries" is turned into a legal number. Non-numbers
 * (and NaN/Infinity) fall back to the default, everything else is truncated and
 * clamped into [0, MAX_RETRIES] — the ceiling is a product rule, so a caller
 * cannot raise it by passing a bigger number.
 */
export function clampRetries(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_RETRY_POLICY.maxRetries;
  return Math.min(MAX_RETRIES, Math.max(0, Math.trunc(value)));
}

/**
 * How long attempt `retryIndex` (0-based) waits before it is re-issued.
 *
 * `Retry-After` wins over the exponential when it is a usable number, and is
 * then CLAMPED into `[0, maxDelayMs]`. The clamp is the whole point: the
 * fallback decorator's "beyond the cap we move on" rule (`fallback.ts:honourRetryAfter`)
 * is sound there because it means "stop waiting and switch TARGET", but this
 * decorator keeps hammering the SAME endpoint. Returning 0 for an over-cap
 * header would turn a server's explicit `Retry-After: 120` ("come back in two
 * minutes") into the MOST aggressive possible retry — four immediate hits on an
 * endpoint that just asked to be left alone, i.e. strictly worse than not
 * reading the header at all. Clamping instead means "we do not wait longer than
 * the policy allows, but we do not retry instantly either".
 *
 * Every branch is bounded, so the returned value is always a finite number in
 * `[0, maxDelayMs]` (a negative `backoffMs`/non-finite policy is floored at 0).
 */
export function retryDelayMs(info: { retryAfterMs: number | null }, retryIndex: number, policy: RetryPolicy): number {
  const cap = Number.isFinite(policy.maxDelayMs) ? Math.max(0, policy.maxDelayMs) : 0;
  const retryAfter = policy.respectRetryAfter ? info.retryAfterMs : null;
  if (retryAfter !== null && Number.isFinite(retryAfter)) return Math.min(Math.max(0, retryAfter), cap);
  const backoff = policy.backoffMs * 2 ** Math.max(0, retryIndex);
  return Math.min(Number.isFinite(backoff) ? Math.max(0, backoff) : cap, cap);
}

/** One retry, as reported to the host (audit line + SSE `status` frame). */
export interface RetryAttemptInfo {
  /** Index of the attempt ABOUT to run: 1 = the first retry. */
  attempt: number;
  /** Chain target name when the caller knows one (fallback armed); null otherwise. */
  target: string | null;
  /** Model this retry was issued against. */
  model: string | null;
  /** `http_503` / `timeout_idle` / `stream` / `network` / `generate`. */
  reason: string;
  httpStatus: number | null;
  retryAfterMs: number | null;
  /** The wait actually applied before the retry (0 = immediate). */
  delayMs: number;
  /** text/thinking deltas already delivered (always 0 on a retry). */
  produced: number;
  maxRetries: number;
  message: string;
}

export interface RetryLlmOptions {
  inner: Llm;
  policy?: Partial<RetryPolicy>;
  /** Target name reported on every retry (null = the host has no chain). */
  target?: string | null;
  /** Model reported on every retry (null = the inner seam knows it). */
  model?: string | null;
  /** Called once per retry, BEFORE the backoff sleep. */
  onRetry?: (info: RetryAttemptInfo) => void;
  /** Injectable backoff (tests never really wait). */
  sleep?: (ms: number) => Promise<void>;
}

/** The decorator + the two diagnostics the host/tests read. */
export interface RetryLlm extends Llm {
  /** Retries actually performed by THIS decorator (diagnostics/tests). */
  retries(): number;
  /** The resolved policy (clamped). */
  policy(): RetryPolicy;
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The mutable state of ONE decorator instance (so the loop stays a function). */
interface RetryRuntime {
  opts: RetryLlmOptions;
  policy: RetryPolicy;
  sleep: (ms: number) => Promise<void>;
  retries: number;
}

/**
 * Resolve one policy: the defaults, the caller's overrides, then the clamps.
 *
 * The two STATUS ARRAYS are copied on purpose (F-11). A plain spread would leave
 * `policy.retryableStatuses` pointing at `DEFAULT_RETRY_POLICY`'s own array —
 * and at every other instance's — so one `llm.policy().retryableStatuses.push(...)`
 * (the getter returned a shallow copy too) would silently rewrite the trigger
 * table of the whole process, future instances included. A policy is per
 * decorator; it must not be shared mutable state.
 */
function resolvePolicy(overrides: Partial<RetryPolicy> | undefined): RetryPolicy {
  const merged: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...(overrides ?? {}) };
  return {
    ...merged,
    maxRetries: clampRetries(merged.maxRetries),
    notRetryableStatuses: [...merged.notRetryableStatuses],
    retryableStatuses: [...merged.retryableStatuses],
  };
}

export function createRetryLlm(opts: RetryLlmOptions): RetryLlm {
  const policy = resolvePolicy(opts.policy);
  const rt: RetryRuntime = { opts, policy, sleep: opts.sleep ?? sleepMs, retries: 0 };
  return {
    // EAGER on the pre-stream phase on purpose: a request that never opened a
    // response must REJECT out of `generate()`, exactly like the undecorated
    // seam. Returning a lazy generator would turn a 503 into a "torn stream" for
    // every caller that awaits `generate()` inside its own try/catch.
    generate: async (req: ModelRequestDraft): Promise<LlmStream> => attemptLoop(rt, req, await openAttempt(rt, req, 0)),
    retries: () => rt.retries,
    // A COPY, arrays included (F-11): a caller may inspect the resolved policy
    // but must not be able to mutate this decorator through it.
    policy: () => ({ ...rt.policy, notRetryableStatuses: [...rt.policy.notRetryableStatuses], retryableStatuses: [...rt.policy.retryableStatuses] }),
  };
}

/** The verdict of one consumed attempt (the fallback decorator's shape). */
type AttemptOutcome =
  | { kind: "done"; terminal: StreamEvent; usage: Usage | null }
  | { kind: "failed"; info: FailureInfo; terminal: StreamEvent | null; error: unknown; usage: Usage | null };

/** An OPENED attempt: the stream plus the retry index it was issued under. */
interface OpenAttempt {
  stream: LlmStream;
  retry: number;
}

/**
 * Open one attempt, retrying the PRE-STREAM phase until a response exists or the
 * failure is terminal. Split out so `generate()` can run it eagerly while the
 * mid-stream phase stays in the generator below — the two phases must not share
 * a `try` because only the first one may reject out of `generate()`.
 */
async function openAttempt(rt: RetryRuntime, req: ModelRequestDraft, startRetry: number): Promise<OpenAttempt> {
  for (let retry = startRetry; ; retry++) {
    try {
      return { stream: await rt.opts.inner.generate(req), retry };
    } catch (error) {
      const info = describeFailure(error, 0, rt.policy);
      if (!canRetry(rt, info, retry, error)) throw error;
      await backoff(rt, info, retry);
    }
  }
}

/**
 * Retry the SAME target while the failure is retryable and nothing was produced.
 * The pre-stream throw and the mid-stream terminal share one predicate
 * (`canRetry`), which is why the two branches below read the same.
 */
async function* attemptLoop(rt: RetryRuntime, req: ModelRequestDraft, first: OpenAttempt): LlmStream {
  let current = first;
  // W9225 (F-04): every attempt's usage, summed ACROSS attempts, so the single
  // frame below is the true total. Forwarding each attempt's frame made the
  // additive `UsageTracker` report N attempts while the overwrite-style ledger
  // reported only the last one.
  let usage: Usage | null = null;
  for (;;) {
    const outcome = yield* consume(current.stream, rt.policy);
    usage = addUsage(usage, outcome.usage);
    if (outcome.kind === "done") {
      yield* yieldUsage(usage);
      yield outcome.terminal;
      return;
    }
    if (!canRetry(rt, outcome.info, current.retry, outcome.error)) {
      // The failed attempt still cost money: its usage rides out ahead of the
      // terminal event (or the throw), exactly where a single attempt put it.
      yield* yieldUsage(usage);
      if (outcome.error !== null) throw outcome.error;
      if (outcome.terminal !== null) yield outcome.terminal;
      return;
    }
    await backoff(rt, outcome.info, current.retry);
    current = await openAttempt(rt, req, current.retry + 1);
  }
}

/** Sum two attempts' usage; `null` means "that attempt reported none". */
function addUsage(total: Usage | null, next: Usage | null): Usage | null {
  if (next === null) return total;
  return total === null ? { ...next } : usageAdd(total, next);
}

/** Forward the accumulated usage once, just before the terminal event. */
function* yieldUsage(usage: Usage | null): Generator<StreamEvent> {
  if (usage !== null) yield { kind: "usage", usage };
}

/**
 * A retry is legal only while the failure is retryable, nothing was produced,
 * the budget is left, and the caller did not ABORT.
 *
 * The abort guard is explicit even though `describeFailure` already answers
 * "not retryable" for an unstructured error: a cancellation that reaches this
 * seam shaped like a transient stream failure (a destroyed response read) must
 * still never be re-issued — the user asked for the turn to stop, and a retry
 * would keep a cancelled turn alive behind their back.
 */
function canRetry(rt: RetryRuntime, info: FailureInfo, retry: number, error: unknown): boolean {
  if (isAbort(error)) return false;
  if (retryAfterExceedsCap(rt.policy, info)) return false;
  return info.retryable && info.produced === 0 && retry < rt.policy.maxRetries;
}

/**
 * W9225 (F-10): true when the failure asked to be left alone for LONGER than
 * this policy may wait. Such a failure is not "retry the same target" material:
 * clamping the wait and re-issuing anyway is what turned one rate-limited turn
 * into `targets x (maxRetries+1)` upstream calls. Declining here lets the outer
 * fallback decorator switch target, which is the only honest response to
 * "come back in two minutes" when the budget for one wait is one minute.
 *
 * `respectRetryAfter:false` deliberately opts out: the caller has said it does
 * not want the header consulted at all, so it cannot also veto on it.
 */
export function retryAfterExceedsCap(policy: RetryPolicy, info: { retryAfterMs: number | null }): boolean {
  if (!policy.respectRetryAfter || info.retryAfterMs === null) return false;
  if (!Number.isFinite(info.retryAfterMs)) return false;
  const cap = Number.isFinite(policy.maxDelayMs) ? Math.max(0, policy.maxDelayMs) : 0;
  return info.retryAfterMs > cap;
}

/** A caller cancellation, recognised structurally (core's LlmError or a DOMError). */
export function isAbort(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const rec = error as Record<string, unknown>;
  if (rec["name"] === "AbortError") return true;
  const signal = rec["signal"];
  return typeof signal === "object" && signal !== null && (signal as { aborted?: unknown }).aborted === true;
}

/** Report the retry, then wait (the order is the visibility contract). */
async function backoff(rt: RetryRuntime, info: FailureInfo, retry: number): Promise<void> {
  const delayMs = retryDelayMs(info, retry, rt.policy);
  rt.retries += 1;
  rt.opts.onRetry?.({
    attempt: retry + 1,
    target: rt.opts.target ?? null,
    model: rt.opts.model ?? null,
    reason: info.reason,
    httpStatus: info.httpStatus,
    retryAfterMs: info.retryAfterMs,
    delayMs,
    produced: info.produced,
    maxRetries: rt.policy.maxRetries,
    message: info.message,
  });
  if (delayMs > 0) await rt.sleep(delayMs);
}

/**
 * Forward one attempt's events, counting what the consumer has already seen.
 *
 * W9225 (F-04): a `usage` frame is NOT forwarded here — it is captured and
 * returned with the verdict, and `attemptLoop` emits ONE summed frame for the
 * whole `generate()`. Forwarding each attempt's frame is what split the
 * statusline's additive total from the ledger's overwrite-style row.
 */
async function* consume(stream: LlmStream, policy: StatusTable): AsyncGenerator<StreamEvent, AttemptOutcome, undefined> {
  let produced = 0;
  let usage: Usage | null = null;
  try {
    for await (const event of stream) {
      if (isProducedEvent(event)) produced += 1;
      if (event.kind === "done") return { kind: "done", terminal: event, usage };
      if (event.kind === "usage") {
        usage = addUsage(usage, event.usage);
        continue;
      }
      if (event.kind === "failed" || event.kind === "interrupted") {
        return { kind: "failed", info: describeEvent(event, produced), terminal: event, error: null, usage };
      }
      yield event;
    }
  } catch (error) {
    return { kind: "failed", info: describeFailure(error, produced, policy), terminal: null, error, usage };
  }
  // A provider stream that ended without a terminal event: the same torn-stream
  // verdict the fallback decorator reaches, and retryable while nothing was seen.
  return { kind: "failed", info: describeEvent({ kind: "interrupted" }, produced), terminal: { kind: "interrupted" }, error: null, usage };
}
