/**
 * W9331 — the garbage-code-point layer, ported from upstream
 * `dsh-guard-repeat-output` 2.1.6 (MIT) `lib/sanitize.js`.
 *
 * The layer has exactly two actions and the distinction between them is the whole
 * point, so both are pinned here:
 *
 *   · `strip`  — a blacklisted code point is removed. ALWAYS safe, because these
 *     code points carry no meaning in model output; one stray U+FFFD in a long
 *     answer is a decoding hiccup, not a collapse.
 *   · `severe` — DENSITY is what means collapse (a long unbroken run, or a large
 *     share of one delta). 200 NUL bytes in a row means the model is gone.
 *
 * The boundary between "cleaned silently" and "treated as collapse" is the thing a
 * future edit is most likely to get wrong, so it is asserted from both sides.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_GARBAGE_THRESHOLDS,
  classifyCodeUnit,
  garbageEvidence,
  isSevereGarbage,
  sanitizeText,
} from "./repetition-sanitize.js";

describe("W9331 sanitizeText · what is garbage and what is not", () => {
  it("removes NUL, C0/C1 controls, DEL, U+FFFD, lone surrogates and zero-width filler", () => {
    const dirty = "\u0000A\u0001B\u0007C\u007fD\u0085E\uFFFD F\u200bG\u2060H\ud800I";
    const cleaned = sanitizeText(dirty);
    // The ordinary space between `E` and `F` is NOT garbage and stays.
    expect(cleaned.text).toBe("ABCDE FGHI");
    expect(cleaned.removed).toBe(9);
    expect(cleaned.ratio).toBeGreaterThan(0);
  });

  it("KEEPS tab, newline and carriage return (legitimate in model output)", () => {
    const result = sanitizeText("a\tb\nc\r\nd");
    expect(result.text).toBe("a\tb\nc\r\nd");
    expect(result.removed).toBe(0);
  });

  it("KEEPS a well-formed surrogate pair (an emoji is ordinary text)", () => {
    const emoji = "\u{1F600}";
    const result = sanitizeText(`ok ${emoji} done`);
    expect(result.text).toBe(`ok ${emoji} done`);
    expect(result.removed).toBe(0);
  });

  it("removes an unpaired surrogate but keeps its paired neighbours intact", () => {
    const result = sanitizeText(`a\ud83d\ude00b\ud800c`);
    // The valid pair survives, the lone high surrogate does not.
    expect(result.text).toBe(`a\ud83d\ude00bc`);
    expect(result.removed).toBe(1);
  });

  it("returns the all-zero result for a non-string or an empty input (never throws)", () => {
    for (const input of ["", null, undefined, 42, {}] as unknown[]) {
      expect(sanitizeText(input as string)).toEqual({ text: "", removed: 0, maxRun: 0, ratio: 0 });
    }
  });

  it("leaves clean text byte-identical", () => {
    const clean = "The detector keeps a bounded rolling window over the stream.";
    const result = sanitizeText(clean);
    expect(result.text).toBe(clean);
    expect(result.removed).toBe(0);
    expect(result.maxRun).toBe(0);
    expect(result.ratio).toBe(0);
  });

  it("measures the LONGEST unbroken garbage run, not the total", () => {
    // Two short runs separated by clean text: the total is 4 but the longest run is 2.
    const result = sanitizeText("a\u0000\u0000b\u0000\u0000c");
    expect(result.removed).toBe(4);
    expect(result.maxRun).toBe(2);
  });
});

describe("classifyCodeUnit · the blacklist is an EXACT predicate", () => {
  it("classifies each family by its own name", () => {
    expect(classifyCodeUnit(0x41)).toBe("ok"); // 'A'
    expect(classifyCodeUnit(0x09)).toBe("ok"); // tab
    expect(classifyCodeUnit(0x0a)).toBe("ok"); // newline
    expect(classifyCodeUnit(0x0d)).toBe("ok"); // CR
    expect(classifyCodeUnit(0x00)).toBe("control"); // NUL
    expect(classifyCodeUnit(0x1f)).toBe("control"); // C0
    expect(classifyCodeUnit(0x7f)).toBe("control"); // DEL
    expect(classifyCodeUnit(0x85)).toBe("control"); // C1
    expect(classifyCodeUnit(0xfffd)).toBe("replacement");
    expect(classifyCodeUnit(0x200b)).toBe("zero-width");
    expect(classifyCodeUnit(0xfeff)).toBe("zero-width");
    expect(classifyCodeUnit(0xd800)).toBe("lone-surrogate");
    expect(classifyCodeUnit(0xdfff)).toBe("lone-surrogate");
  });
});

describe("isSevereGarbage · density is what means collapse", () => {
  it("is false for a single stray code point (a decoding hiccup is cleaned silently)", () => {
    const one = sanitizeText("a long healthy answer with one \uFFFD in it");
    expect(one.removed).toBe(1);
    expect(isSevereGarbage(one)).toBe(false);
  });

  it("is false when nothing was removed at all", () => {
    const clean = sanitizeText("perfectly healthy text");
    expect(isSevereGarbage(clean)).toBe(false);
  });

  it("is TRUE for an unbroken run of garbage (the run arm)", () => {
    const nul = sanitizeText("start\u0000".repeat(0) + "x".repeat(10) + "\u0000".repeat(DEFAULT_GARBAGE_THRESHOLDS.maxRun));
    expect(nul.maxRun).toBeGreaterThanOrEqual(DEFAULT_GARBAGE_THRESHOLDS.maxRun);
    expect(isSevereGarbage(nul)).toBe(true);
  });

  it("is TRUE for a garbage-dense delta even without a long run (the ratio arm)", () => {
    // Alternating garbage/high-share noise: no run reaches 32, but half the delta
    // is garbage. This is the arm that catches a model emitting garbage in bursts.
    const text = "\u0000a".repeat(40);
    const result = sanitizeText(text);
    expect(result.ratio).toBeGreaterThanOrEqual(DEFAULT_GARBAGE_THRESHOLDS.maxRatio);
    expect(result.maxRun).toBeLessThan(DEFAULT_GARBAGE_THRESHOLDS.maxRun);
    expect(isSevereGarbage(result)).toBe(true);
  });

  it("honours explicit limits, and 32/0.5 are the upstream 2.1.6 defaults", () => {
    expect(DEFAULT_GARBAGE_THRESHOLDS).toEqual({ maxRun: 32, maxRatio: 0.5 });
    const result = sanitizeText("ab\u0000cd");
    expect(isSevereGarbage(result, { maxRun: 1, maxRatio: 1 })).toBe(true);
    expect(isSevereGarbage(result, { maxRun: 99, maxRatio: 0.99 })).toBe(false);
  });
});

describe("garbageEvidence · a garbage collapse in the SHARED evidence shape", () => {
  it("says it is low-information and does NOT invent segment statistics", () => {
    const result = sanitizeText("\u0000".repeat(64));
    const evidence = garbageEvidence(result, "thinking");
    // The recovery path is shared with a phrase collapse, so the shape must match —
    // but the fields that describe segments never ran, so they are zero rather than
    // guessed. A reader of the log can tell the two arms apart.
    expect(evidence.kind).toBe("low-information");
    expect(evidence.channel).toBe("thinking");
    expect(evidence.longestRun).toBe(64);
    expect(evidence.segments).toBe(0);
    expect(evidence.topPhrase).toBe("");
    expect(evidence.topPhraseCount).toBe(0);
    expect(evidence.duplicateShare).toBe(0);
    expect(evidence.uniqueGramRatio).toBe(0);
  });
});
