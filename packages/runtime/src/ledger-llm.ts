/**
 * The `Llm` step observer (iteration E §3.2.3, W728 P0) — one ledger step per
 * model call, including the calls that FAIL.
 *
 * A decorator, not a new seam: `generate` and every stream event pass through
 * byte-for-byte unchanged, and a rejection is re-thrown untouched. What it adds
 * is the two facts only this seam can see:
 *   - the step BOUNDARIES (a stream that tears after a usage frame is one error
 *     row, not an ok row plus an error row, §3.2.3);
 *   - the structured failure cause — W723's `LlmError.httpStatus/retryable`
 *     (`packages/llm/src/errors.ts`), read structurally so this package keeps
 *     importing nothing from `@celestea/llm` (runtime composes L1, it does not
 *     depend on it).
 *
 * This is observation only: failures and retries book a row, they never change
 * what the engine does with the response (§3.5, "纯新增观测").
 */

import type { Llm, LlmStream, ModelRequest, StreamEvent } from "@celestea/core";
import type { LedgerStepHandle, LedgerStepOutcome, LedgerStepSink } from "./ledger.js";

/** What the observer knows about the target it wraps (config, not per-call). */
export interface LedgerLlmOptions {
  inner: Llm;
  sink: LedgerStepSink;
  /** Provider row id (`providers.json`), when the host resolved one. */
  provider?: string | null;
  /** Model of the composed profile; the request's own model wins per call. */
  model?: string | null;
  base_url_host?: string | null;
  /** 0 = first attempt (§5.2); P1's fallback decorator passes the real value. */
  attempt?: number;
  /** Target name this attempt failed over from (P1); null in P0. */
  fallback_from?: string | null;
}

/** Wrap one `Llm` so every model step is booked (success, failure and abort). */
export function createLedgerLlm(opts: LedgerLlmOptions): Llm {
  return {
    async generate(req: ModelRequest): Promise<LlmStream> {
      const step = opts.sink.beginStep({
        provider: opts.provider ?? null,
        model: req.model === "" ? (opts.model ?? null) : req.model,
        base_url_host: opts.base_url_host ?? null,
        attempt: opts.attempt ?? 0,
        fallback_from: opts.fallback_from ?? null,
      });
      let stream: LlmStream;
      try {
        stream = await opts.inner.generate(req);
      } catch (error) {
        step.close(failureOf(error));
        throw error;
      }
      return observeStep(stream, step);
    },
  };
}

/** The stream of one step, forwarded unchanged and closed exactly once. */
function observeStep(stream: LlmStream, step: LedgerStepHandle): LlmStream {
  const inner = stream[Symbol.asyncIterator]();
  const iterator: AsyncIterator<StreamEvent> = {
    async next(): Promise<IteratorResult<StreamEvent>> {
      let result: IteratorResult<StreamEvent>;
      try {
        result = await inner.next();
      } catch (error) {
        step.close(failureOf(error));
        throw error;
      }
      if (result.done === true) {
        step.close({ kind: "ok" });
        return result;
      }
      const event = result.value;
      if (event.kind === "usage") step.record(event.usage);
      else if (event.kind === "failed") step.close(streamFailure(event));
      else if (event.kind === "interrupted") step.close({ kind: "error", error_kind: "stream" });
      return result;
    },
    async return(): Promise<IteratorResult<StreamEvent>> {
      // The consumer abandoned the step (cancel/close): whatever usage it
      // already produced is real money and keeps its row (§3.2.3 "取消").
      step.close({ kind: "ok" });
      await inner.return?.();
      return { done: true, value: undefined };
    },
  };
  return { [Symbol.asyncIterator]: (): AsyncIterator<StreamEvent> => iterator };
}

/**
 * The structured failure of a thrown value. W723's `LlmError` carries
 * `kind`/`httpStatus`/`retryable`; anything else is an unclassified local
 * failure, reported as the turn-outcome kind the loop will use ("generate").
 */
export function failureOf(error: unknown): LedgerStepOutcome {
  const rec = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const kind = rec["kind"];
  const status = rec["httpStatus"];
  const retryable = rec["retryable"];
  return {
    kind: "error",
    error_kind: typeof kind === "string" ? kind : "generate",
    http_status: typeof status === "number" ? status : null,
    retryable: typeof retryable === "boolean" ? retryable : null,
  };
}

/**
 * A mid-stream terminal failure: no HTTP status exists (the response was 2xx).
 *
 * B2-04: `retryable` used to be `event.message.startsWith("llm timeout")` — the
 * only prose-parsed classification left in the repo, and it disagreed with the
 * structured `kindOf` sitting right next to it in the same object: a body whose
 * text merely MENTIONED the prefix booked `retryable: true` while its own
 * `kindOf` said otherwise. The row now answers from the structured field alone,
 * which is the only thing that was ever authoritative.
 *
 * `retryable` is TRUE for `timeout` and FALSE for the rest, and the reason
 * `timeout` is a real member of this union — not a hypothetical — is that this
 * observer can sit on either side of the host adapter: the provider seam widens
 * `StreamEvent.failed.kindOf` with `"timeout"` (see the `TODO(core-timeout-kind)`
 * in `packages/llm/src/seam.ts`), and `apps/studio`'s `llm-assembly.ts:98` folds
 * it back to `"stream"` only for the CORE-typed engine. `stepObservedLlm` wraps
 * whichever Llm it is handed, so a deployment that observes the provider seam
 * directly really does deliver `kindOf: "timeout"` here. Both spellings are
 * honoured; neither depends on the message text.
 *
 * A `stream` tear books `false` rather than an uninformative `null`: the stream
 * broke, and a byte-identical attempt is not what fixes a broken stream. This
 * changes what a row RECORDS, never what the engine does (§3.5, observation
 * only).
 */
export function streamFailure(event: { kindOf: string; message: string }): LedgerStepOutcome {
  return {
    kind: "error",
    error_kind: event.kindOf,
    http_status: null,
    retryable: event.kindOf === "timeout",
  };
}

/** Host of a base_url (`api.deepseek.com`), or null when it is not a URL. */
export function hostOf(baseUrl: string | null): string | null {
  if (baseUrl === null || baseUrl === "") return null;
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}
