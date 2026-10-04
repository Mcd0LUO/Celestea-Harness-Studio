import { describe, expect, it } from "vitest";

import { failureOf, streamFailure } from "./ledger-llm.js";

/**
 * B2-04 — `retryable` must be read from the STRUCTURED failure, never from the
 * message prose.
 *
 * The bug this pins: `streamFailure` decided retryability with
 * `event.message.startsWith("llm timeout")`, while the very same object carried
 * a structured `kindOf`. A body whose text merely MENTIONED the prefix booked
 * `retryable: true` regardless of what `kindOf` said; everything else booked
 * `null`, including a genuine idle stall (its text is "stream idle timeout: …",
 * which does NOT begin with the canonical prefix).
 *
 * On "timeout" being a real member here: the provider seam widens
 * `StreamEvent.failed.kindOf` with `"timeout"` (the `TODO(core-timeout-kind)` in
 * `packages/llm/src/seam.ts`), and only the core-typed host adapter
 * ([coreEvent] in `apps/studio/.../llm-assembly.ts`) folds it back to `"stream"`. This
 * observer wraps whichever `Llm` it is handed, so both spellings reach it in a
 * real deployment — which is exactly why a MESSAGE-SNIFFING rule was wrong:
 * the two spellings carry the same semantics but different text.
 *
 * Observation only (§3.5): this decides what a row RECORDS, never what the engine
 * does with the response.
 */describe("B2-04 — streamFailure answers from kindOf, not from the message", () => {
  it("calls a real idle stall retryable, although its text lacks the canonical prefix", () => {
    // Verbatim from packages/llm/src/errors.ts:streamIdleTimeoutMessage.
    const outcome = streamFailure({ kindOf: "timeout", message: "stream idle timeout: no data chunk for 90000ms" });
    expect(outcome).toEqual({ kind: "error", error_kind: "timeout", http_status: null, retryable: true });
  });

  it("does NOT call a plain stream tear retryable", () => {
    expect(streamFailure({ kindOf: "stream", message: "sse decode error: upstream hung up" }).retryable).toBe(false);
  });

  it("does not let the message text override the structured kind (the inversion)", () => {
    // A "stream" failure whose prose claims to be a timeout: the old rule made
    // this `true` on the strength of the text alone.
    const lying = streamFailure({ kindOf: "stream", message: "llm timeout: something that merely mentions the prefix" });
    expect(lying.retryable).toBe(false);
    expect(lying.error_kind).toBe("stream");
  });

  it("never parses the message at all — a hostile message cannot change the verdict", () => {
    for (const kindOf of ["timeout", "stream", "generate"]) {
      for (const message of ["", "llm timeout", "Bearer sk-live-LEAK", "x".repeat(5000)]) {
        const outcome = streamFailure({ kindOf, message });
        expect(outcome.retryable).toBe(kindOf === "timeout");
        expect(outcome.error_kind).toBe(kindOf);
      }
    }
  });
});

/**
 * `failureOf` is the sibling of `streamFailure` and was already structural; this
 * case exists so the two functions cannot drift apart in style again.
 */
describe("failureOf keeps reading the LlmError fields structurally", () => {
  it("reads httpStatus/retryable off the error object", () => {
    const shaped = Object.assign(new Error("stream request failed: 503"), {
      kind: "generate",
      httpStatus: 503,
      retryable: true,
    });
    expect(failureOf(shaped)).toEqual({ kind: "error", error_kind: "generate", http_status: 503, retryable: true });
  });

  it("reports an unclassified throw as an unknown-local failure", () => {
    expect(failureOf(new Error("socket hang up"))).toEqual({
      kind: "error",
      error_kind: "generate",
      http_status: null,
      retryable: null,
    });
  });
});
