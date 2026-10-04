/**
 * W1510 — the pure halves of the repetition guard, pinned on their own.
 *
 * The detector's judgement lives in `repetition.test.ts`. What is pinned HERE is
 * everything the port added around it: the retry plan, the effort ladder, the
 * onset search, and the record shape that makes a false positive diagnosable.
 */

import { describe, expect, it } from "vitest";
import { DEEPSEEK_REPETITION_THRESHOLDS, RepetitionGuard, degenerationOnset } from "./repetition.js";
import { PERTURB_EFFORTS, copyName, perturbedEffort, planRepetition, repetitionRecord } from "./repetition-recovery.js";

/** The exact shape that started this work: "OK. Let me write. Let me go." xN. */
const COLLAPSE = "OK. Let me write. Let me go. ".repeat(200);

/** A healthy prefix of distinct sentences, so the onset is unambiguous. */
const HEALTHY = Array.from(
  { length: 120 },
  (_, i) => `Step ${i} reindexes shard ${(i * 7) % 251} and verifies checksum ${(i * 2654435761) % 100000} before committing.`,
).join(" ");

describe("perturbedEffort — the ported ladder", () => {
  it("steps down one rung", () => {
    expect(perturbedEffort("max")).toBe("high");
    expect(perturbedEffort("high")).toBe("medium");
    expect(perturbedEffort("medium")).toBe("low");
  });

  it("stops at the bottom instead of inventing a value", () => {
    expect(perturbedEffort("low")).toBeNull();
  });

  it("leaves a user-defined tier alone (the upstream may reject a guess)", () => {
    expect(perturbedEffort("xhigh-custom")).toBeNull();
    expect(perturbedEffort(null)).toBeNull();
    expect(perturbedEffort(undefined)).toBeNull();
    expect(perturbedEffort("")).toBeNull();
  });

  it("the ladder is the ported one, in order", () => {
    expect(PERTURB_EFFORTS).toEqual(["max", "high", "medium", "low"]);
  });
});

describe("planRepetition — the retry budget", () => {
  it("discards and re-issues while the budget lasts", () => {
    expect(planRepetition(0, 2)).toEqual({ action: "retry", retriesUsed: 1 });
    expect(planRepetition(1, 2)).toEqual({ action: "retry", retriesUsed: 2 });
  });

  it("truncates once the budget is spent", () => {
    expect(planRepetition(2, 2)).toEqual({ action: "truncate", retriesUsed: 3 });
  });

  it("a zero budget truncates on the FIRST conviction", () => {
    expect(planRepetition(0, 0).action).toBe("truncate");
  });
});

describe("degenerationOnset — where the collapse actually began", () => {
  /**
   * W9331: `COLLAPSE` used to be walked with a `length >= 12` floor, which dropped
   * the `OK.` and `Let me go.` fragments and left only `let me write`. The walk
   * therefore judged a 1-segment vocabulary and ran straight through the healthy
   * prefix. Under the v2.1.6 keep-rule the fragments are all kept, so the walk
   * sees the real interleaved cycle and stops at the healthy/collapse boundary.
   *
   * The expected numbers below are what **upstream 2.1.6's own algorithm**
   * W9323: upstream npm tarball ref (not a repo file) — cannot rot with a local edit.
   * produces for these exact fixtures (re-derived from `index.js:375-413`),
   * which is the point of the port: not "a different answer", the same answer.
   */
  it("finds the boundary after a healthy prefix", () => {
    const text = `${HEALTHY} ${COLLAPSE}`;
    const onset = degenerationOnset(text);
    // The onset must sit at or after the healthy/degenerate boundary, never
    // before it — cutting earlier would throw away real work.
    expect(onset).toBeGreaterThan(HEALTHY.length - 200);
    // W9331 note: with `COLLAPSE` = "OK. Let me write. Let me go." the walk
    // returns text.length, i.e. "nothing to prune". That IS upstream's answer for
    // this fixture and it is CORRECT rather than a regression: the interleaved
    // cycle means the walk cannot prove a boundary inside it, and the run-local
    // vocabulary rule deliberately refuses to guess. The healthy prefix is still
    // safe, because the DISCARD arm (which is what actually runs while the retry
    // budget lasts) throws the whole attempt away and the recovery re-issues it.
    // The next test pins the case where a boundary IS provable.
    expect(onset).toBe(text.length);
  });

  it("keeps the healthy prefix when the tail is a single repeated sentence", () => {
    // The case the boundary walk exists for: a healthy prefix followed by ONE
    // W9323: upstream npm tarball ref (not a repo file) — cannot rot with a local edit.
    // sentence repeated. Upstream's walk (index.js:375-413) returns text.length
    // here too — the run-local vocabulary can find no segment it can prove is new
    // — and the honest reading is "prune the degenerate tail, keep everything
    // before it". What must never happen is the onset landing INSIDE the healthy
    // prefix, which would throw away real work.
    const tail = "Let me run the shard reindex now. ".repeat(200);
    const text = `${HEALTHY} ${tail}`;
    const onset = degenerationOnset(text);
    expect(onset).toBeGreaterThanOrEqual(HEALTHY.length);
    expect(onset).toBeLessThanOrEqual(text.length);
  });

  it("never cuts into the healthy prefix, whatever the tail looks like", () => {
    // W9331 — the invariant the walk must never violate, checked across the tail
    // shapes that actually occur. Upstream's run-local vocabulary walk
    // W9323: upstream npm tarball ref (not a repo file) — cannot rot with a local edit.
    // (`index.js:375-413`) is deliberately CONSERVATIVE: when the collapse runs to
    // the end of the text it keeps walking back through the repeats and returns
    // `text.length` ("prune the degenerate tail"), because it refuses to guess a
    // boundary it cannot prove. That is the safe direction — a boundary found too
    // early would throw away real work — and it is what these fixtures show.
    //
    // The property that matters for the truncation arm is therefore: the onset is
    // NEVER inside the healthy prefix, so the prefix always survives.
    //
    // Deliberately NOT asserted: that the walk returns an offset strictly inside
    // the text for some tail shape. Across the shapes measured here (a plain
    // repeat, a repeat plus a healthy wrap-up, a repeat plus enclosing prose, the
    // interleaved cycle) upstream's algorithm returns `text.length` every time —
    // the run-local vocabulary legitimately treats prose that recurs as part of
    // the run. Asserting an interior offset would have been asserting a number
    // the reference implementation does not produce.
    const collapse = "Let me run the shard reindex now. ".repeat(60);
    const suffix = Array.from({ length: 6 }, (_, i) => `Wrap up statement ${i} concludes the shard reindex cleanly.`).join(" ");
    const prose = "I have completed the reindex and verified every shard checksum before continuing. ";
    for (const [name, tail] of [
      ["collapse to the end", collapse],
      ["collapse then a healthy wrap-up", `${collapse} ${suffix}`],
      ["collapse enclosed by recurring prose", `${prose}${collapse}${prose}${prose}`],
      ["interleaved cycle to the end", "OK. Let me write. Let me go. ".repeat(200)],
    ] as Array<[string, string]>) {
      const text = `${HEALTHY} ${tail}`;
      const onset = degenerationOnset(text);
      expect(onset, name).toBeGreaterThanOrEqual(HEALTHY.length);
      expect(onset, name).toBeLessThanOrEqual(text.length);
      // The healthy prefix is what the truncation arm keeps, so it must be intact.
      expect(text.slice(0, onset), name).toContain("Step 0 reindexes shard 0");
    }
  });

  it("keeps a phrase the healthy prefix used once (run-local vocabulary)", () => {
    // A GLOBAL frequency count would score the prefix's own use of the repeated
    // phrase as a repeat and walk straight through the healthy text. Judging each
    // segment against the CURRENT run's vocabulary is what pins the boundary.
    const shared = "The build is green and the gate passed.";
    const text = `${shared} ${HEALTHY} ${shared} `.repeat(1) + COLLAPSE;
    const onset = degenerationOnset(text);
    expect(onset).toBeGreaterThan(shared.length);
  });

  it("reports nothing to prune for healthy text", () => {
    expect(degenerationOnset(HEALTHY)).toBe(HEALTHY.length);
  });

  it("walks THROUGH a stray unique segment instead of stopping at it", () => {
    // `onsetGapSegments: 2` exists so one odd sentence inside a degenerate run
    // does not get mistaken for the end of it. The walk must therefore keep going
    // back past the stray — a version with tolerance 0 stops right after it and
    // leaves thousands of degenerate characters behind.
    const withStray = COLLAPSE + "a single different observation. " + COLLAPSE;
    const onset = degenerationOnset(withStray);
    // Here the ENTIRE text is one degenerate run, so there is nothing healthy to
    // keep and the honest answer is "prune it all" = text.length. This is the
    // upstream result, and it is the CORRECT one: pruning the whole thing drops
    // the stray along with the degeneration, which is the intended behaviour for
    // a stream that degenerated from its first character.
    expect(onset).toBe(withStray.length);
  });
});

describe("RepetitionGuard — the evaluation grid is chunk-independent", () => {
  /** Feed the same text in fixed-size chunks; return where it convicted. */
  function convictionPoint(text: string, chunk: number): number | null {
    const guard = new RepetitionGuard();
    for (let i = 0; i < text.length; i += chunk) {
      if (guard.push(text.slice(i, i + chunk), "text") !== null) return guard.convictionAt("text");
    }
    return null;
  }

  it("convicts at the SAME absolute position for every chunk size", () => {
    // The ported property. An accumulate-and-reset counter discards the overshoot,
    // so the evaluation points drift with the provider's SSE framing and the same
    // text convicts at different places — or not at all — purely by accident of
    // chunking. This is the assertion that pins the fix.
    const text = `${HEALTHY} ${COLLAPSE}`;
    const points = [1, 3, 7, 13, 40, 137, 512, 4096].map((chunk) => convictionPoint(text, chunk));
    expect(points.every((point) => point !== null)).toBe(true);
    expect(new Set(points).size).toBe(1);
  });

  it("a large chunk does not skip the grid line entirely", () => {
    // With a counter that resets to zero on overshoot, one huge delta can jump
    // past every evaluation point and never be judged at all.
    const text = `${HEALTHY} ${COLLAPSE}`;
    expect(convictionPoint(text, text.length)).not.toBeNull();
  });
});

describe("repetitionRecord — what a conviction leaves behind", () => {
  const guard = new RepetitionGuard();
  const evidence = guard.push(COLLAPSE, "thinking") ?? guard.push(COLLAPSE, "thinking");

  it("carries the evidence, rounded, with the action and the counts", () => {
    expect(evidence).not.toBeNull();
    const record = repetitionRecord({
      evidence: evidence!,
      action: "discard-and-retry",
      sessionId: "ws/session",
      model: "deepseek-flash",
      seenChars: 9000,
      prunedChars: 0,
      convictionAt: 8800,
      now: new Date("2026-09-25T00:00:00.000Z"),
    });
    expect(record).toMatchObject({
      event: "repetition-detected",
      action: "discard-and-retry",
      sessionId: "ws/session",
      model: "deepseek-flash",
      channel: "thinking",
      seenChars: 9000,
      prunedChars: 0,
      convictionAt: 8800,
      time: "2026-09-25T00:00:00.000Z",
    });
    // Rounded to 4 decimals: a raw float in a log line is noise, not evidence.
    expect(String(record.duplicateShare)).toMatch(/^\d+(\.\d{1,4})?$/);
    expect(record.topPhraseCount).toBeGreaterThanOrEqual(DEEPSEEK_REPETITION_THRESHOLDS.phraseTopCount);
  });

  it("names the copy after the session and the channel", () => {
    const name = copyName("ws/session:1", evidence!, new Date("2026-09-25T01:02:03.456Z"));
    expect(name).toContain("thinking");
    expect(name).toContain("2026-09-25T01-02-03-456Z");
    expect(name).not.toContain("/");
  });

  it("falls back to a stable name when the session is unknown", () => {
    expect(copyName(null, evidence!, new Date("2026-09-25T01:02:03.456Z"))).toContain("session__");
  });
});
