import { describe, expect, it } from "vitest";

import { LlmError } from "./errors.js";
import { createFallbackLlm, describeFailure } from "./fallback.js";
import { collectStream, userMessage, type LlmStream, type StreamEvent } from "./seam.js";

const REQ = { messages: [userMessage("hi")] };

/** A close as the step sink records it. */
type StepClose = { kind: string; error_kind?: string | null };

/**
 * B2-06 (P3, audited and deliberately KEPT) — the message-prefix arm of
 * `describeFailure` is not a defect; this pins why, so the judgment cannot be
 * quietly undone by a later reader who "cleans it up".
 *
 * `describeFailure` classifies a timeout three ways:
 * `rec.isTimeout === true || rec.kind === "timeout" || message.startsWith(prefix)`.
 * The third arm looks like the same prose-sniffing that was B2-04, but it is
 * the ONLY arm that can classify an error whose structured fields did not
 * survive a boundary:
 *
 *   - it can never CONTRADICT a structured field, because both structured arms
 *     are checked first and both mean the same thing. When they are present the
 *     prefix is redundant, not competing;
 *   - every real producer (`errors.ts:timeoutError`) sets `isTimeout: true` AND
 *     the prefix together, so the prose arm agrees with them by construction;
 *   - remove it and a `structuredClone`d / re-boxed / IPC-carried error would
 *     fall through to `reason: "generate", retryable: false` — i.e. a timeout
 *     would become a hard, non-retryable, mislabelled failure.
 *
 * Unlike B2-04's ledger rule (where the text DISAGREED with the adjacent
 * structured field), this prefix is a FALLBACK that only decides when nothing
 * structured exists. That is the difference, and it is the whole reason one was
 * fixed and the other is kept.
 */
describe("B2-06 — the prose arm is a last-resort fallback, not a competing classification", () => {
  it("classifies a field-stripped timeout that no structured arm can see", () => {
    // No `isTimeout`, no `kind`, and no `timeoutStage` either — so the stage falls
    // back to the "idle" default, which is the only honest thing to report about
    // a value that carries no stage. The point of the case is the CLASS, not the
    // stage: without the prose arm this is `reason: "generate"`, retryable false.
    const info = describeFailure(new Error("llm timeout: response headers not received within 60000ms"), 0);
    expect(info.kind).toBe("timeout");
    expect(info.retryable).toBe(true);
    expect(info.reason).toBe("timeout_idle");
    // The evidence it fell back to is the text — so this is exactly the case the
    // arm exists for, and exactly the one a structural-only rule would misfile.
    const withoutPrefix = describeFailure(new Error("connection reset by peer"), 0);
    expect(withoutPrefix.kind).toBe("generate");
    expect(withoutPrefix.retryable).toBe(false);
  });

  it("agrees with the structured arms when they are present (never competes)", () => {
    // The real producer: structured fields AND the prefix. `isTimeout` alone
    // already decides the class, so adding the prose arm changes nothing — that
    // is what "never competes" means here, demonstrated rather than asserted.
    const structured = new LlmError("llm timeout: response headers not received within 300ms", "generate", {
      isTimeout: true,
      timeoutStage: "response",
      retryable: true,
    });
    const bare = new Error(structured.message);
    // Same class, same retryability, same reason modulo the stage the bare value
    // cannot carry — and the structured one reports the stage it actually knows.
    expect(describeFailure(structured, 0)).toMatchObject({ kind: "timeout", retryable: true, reason: "timeout_response" });
    expect(describeFailure(bare, 0)).toMatchObject({ kind: "timeout", retryable: true });
  });

  it("takes the prefix arm only when no structured field is available", () => {
    // `isTimeout` alone is enough — the text is not consulted as the source of
    // truth, and a timeout whose message does NOT carry the prefix still works.
    const noPrefix = new LlmError("stream idle timeout: no data chunk for 90000ms", "timeout", {
      isTimeout: true,
      timeoutStage: "idle",
      retryable: true,
    });
    expect(describeFailure(noPrefix, 0).reason).toBe("timeout_idle");
  });

  it("a non-timeout error is unaffected by the arm (no false positives)", () => {
    expect(describeFailure(new LlmError("stream request failed: 500 oops", "generate", { httpStatus: 500 }), 0).reason).toBe("http_500");
    expect(describeFailure(new Error("connection reset by peer"), 0).reason).toBe("generate");
  });
});

/**
 * B2-07 (P3, audited and deliberately KEPT) — `closeStep` is correct as written.
 *
 * The concern was that the `finally` arm's unconditional `closeStep({kind:"ok"})`
 * could book a FAILURE as an ok row, or close the step twice. It cannot:
 *
 *   - `closed` is a one-way latch, so the step is closed EXACTLY once;
 *   - the `finally` arm runs LAST, so on every failure path `closed` is already
 *     true and its call is a no-op — it only reaches `step.close` on the one path
 *     no other arm owns: the consumer abandoned the attempt (break / cancel).
 *
 * These cases pin that invariant so a future edit that reorders or removes the
 * latch fails here rather than in the ledger.
 */
describe("B2-07 — one step close, and never an ok row over a failure", () => {
  function rigFor(body: () => AsyncGenerator<StreamEvent>, closes: StepClose[]) {
    return createFallbackLlm({
      targets: [{ name: "t", provider: "p", model: "m" }],
      clientFor: () => ({ generate: async () => ({ async *[Symbol.asyncIterator]() { yield* body(); } }) }),
      steps: { beginStep: () => ({ record: () => {}, close: (o: { kind: "ok" | "error" }) => closes.push(o) }) },
      sleep: async () => {},
    });
  }

  it("books the failure, not ok, when the stream reports failed", async () => {
    const closes: StepClose[] = [];
    const llm = rigFor(
      async function* () {
        yield { kind: "text", text: "hi" };
        yield { kind: "failed", kindOf: "stream", message: "upstream died" };
      },
      closes,
    );
    await collectStream(await llm.generate(REQ));
    expect(closes).toEqual([{ kind: "error", error_kind: "stream", http_status: null, retryable: false }]);
  });

  it("books the failure, not ok, when the stream throws", async () => {
    const closes: StepClose[] = [];
    const llm = rigFor(
      async function* () {
        yield { kind: "text", text: "hi" };
        throw new LlmError("socket hang up", "stream");
      },
      closes,
    );
    await collectStream(await llm.generate(REQ));
    expect(closes).toHaveLength(1);
    expect(closes[0]?.kind).toBe("error");
  });

  it("closes EXACTLY once on the abandon path, where the finally arm is the only closer", async () => {
    const closes: StepClose[] = [];
    const llm = rigFor(
      async function* () {
        yield { kind: "usage", usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, cache_read: 0, reasoning_tokens: 0 } };
        yield { kind: "text", text: "partial" };
      },
      closes,
    );
    const stream = await llm.generate(REQ);
    for await (const _event of stream) break; // consumer abandons
    expect(closes).toEqual([{ kind: "ok" }]);
  });

  it("never mixes an error and an ok row for one attempt, across every terminal shape", async () => {
    const bodies: Record<string, () => AsyncGenerator<StreamEvent>> = {
      failed: async function* () { yield { kind: "failed", kindOf: "stream", message: "d" }; },
      interrupted: async function* () { yield { kind: "interrupted" }; },
      thrown: async function* () { throw new LlmError("boom", "generate"); },
      done: async function* () { yield { kind: "done", message: { role: "assistant", content: [], tool_call_id: null } }; },
      empty: async function* () {},
    };
    const cases = Object.entries(bodies).flatMap(([name, body]) =>
      [0, 1, 2, 3].map((stopAfter) => ({ name, body, stopAfter })),
    );
    for (const { name, body, stopAfter } of cases) await assertOneClosePerAttempt(name, body, stopAfter);
  });
});

/**
 * Drain `body`'s stream, abandoning it after `stopAfter` events, then assert the
 * step-sink contract: AT MOST one close, and never one error row beside one ok
 * row for the same attempt. Extracted so the matrix case stays flat — the nested
 * loops put it over the repo's 4-level `max-depth`.
 */
async function assertOneClosePerAttempt(
  name: string,
  body: () => AsyncGenerator<StreamEvent>,
  stopAfter: number,
): Promise<void> {
  const closes: StepClose[] = [];
  const llm = createFallbackLlm({
    targets: [{ name: "t", provider: "p", model: "m" }],
    clientFor: () => ({ generate: async () => ({ async *[Symbol.asyncIterator]() { yield* body(); } }) }),
    steps: { beginStep: () => ({ record: () => {}, close: (o: { kind: "ok" | "error" }) => closes.push(o) }) },
    sleep: async () => {},
  });
  const label = `${name}/stopAfter=${stopAfter}`;
  await consumeUpTo(await llm.generate(REQ), stopAfter);
  expect(closes.length, label).toBeLessThanOrEqual(1);
  const kinds = new Set(closes.map((c) => c.kind));
  expect(kinds.has("error") && kinds.has("ok"), `${label} booked both`).toBe(false);
}

/** Drain `stream` until `stopAfter` events, then stop; a throw is a legitimate terminal. */
async function consumeUpTo(stream: LlmStream, stopAfter: number): Promise<void> {
  let seen = 0;
  try {
    for await (const _event of stream) {
      seen += 1;
      if (seen >= stopAfter) break;
    }
  } catch { /* the throw IS the terminal this case is about */ }
}
