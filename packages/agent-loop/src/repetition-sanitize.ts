/**
 * W9331 — the GARBAGE-CODEPOINT layer, ported from upstream
 * `dsh-guard-repeat-output` **2.1.6** (MIT, zero dependencies) `lib/sanitize.js`.
 *
 * ## Why this is a SEPARATE file and not part of the detector
 *
 * A plugin cannot touch logits, but it can sit on the chunk boundary, which is
 * the same place in the pipeline one step later. A model that is half-collapsed
 * emits garbage before it emits loops: NUL bytes, C0/C1 control codes, U+FFFD
 * replacement characters (a decoding failure made visible), lone surrogates, and
 * zero-width filler.
 *
 * None of that is ever legitimate in a reply, and — unlike repetition — **it
 * needs no statistical judgement: a blacklist decides it exactly**. That is the
 * reason it lives here and not in `repetition.ts`: a statistical detector and an
 * exact predicate are correct for different reasons, and coupling them would
 * mean a change to one silently changed the other. Mixing "does this window look
 * degenerate" with "is this code point legal" in one function would also make
 * the detector's verdicts depend on how much garbage a stream carried, which is
 * exactly the kind of coupling upstream avoided.
 *
 * Two actions, and the distinction is the whole point:
 *
 *   - `strip`  — remove blacklisted characters from a delta **before it is
 *     forwarded**, so they never reach the session log. Always safe: these code
 *     points carry no meaning in model output.
 *   - `severe` — report a delta as evidence of collapse when the garbage is
 *     DENSE (a long unbroken run, or a high share of the delta). The stream
 *     guard then treats it like a detected loop: cut and stop.
 *
 * One stray U+FFFD in a long answer is a decoding hiccup and should be cleaned
 * silently; 200 NUL bytes in a row means the model is gone and the attempt
 * should end. The garbage detector is here; the collapse POLICY is
 * `repetition-recovery.ts` and the driver, exactly as for a phrase collapse.
 */

import type { RepetitionChannel, RepetitionEvidence } from "./repetition.js";

/** Control characters that are legitimate in model output. */
const ALLOWED_CONTROLS: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0d]); // tab, newline, carriage return

/** Zero-width and byte-order code points that are never meaningful in a reply. */
const ZERO_WIDTH: ReadonlySet<number> = new Set([0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0xfeff, 0x2060]);

/** U+FFFD REPLACEMENT CHARACTER: a decoder failure rendered as text. */
const REPLACEMENT = 0xfffd;

/** How a single UTF-16 code unit is classified. */
export type GarbageClass = "ok" | "control" | "replacement" | "zero-width" | "lone-surrogate";

/**
 * Classify one UTF-16 code unit.
 *
 * @param code - a UTF-16 code unit.
 * @returns the class (see [GarbageClass]).
 */
export function classifyCodeUnit(code: number): GarbageClass {
  if (code === REPLACEMENT) return "replacement";
  if (ZERO_WIDTH.has(code)) return "zero-width";
  // Lone surrogates: a well-formed pair is handled by the caller, so any
  // surrogate reaching here is unpaired and therefore malformed text.
  if (code >= 0xd800 && code <= 0xdfff) return "lone-surrogate";
  // C0 (except the allowed three), DEL, and C1.
  if (code < 0x20 && !ALLOWED_CONTROLS.has(code)) return "control";
  if (code === 0x7f) return "control";
  if (code >= 0x80 && code <= 0x9f) return "control";
  return "ok";
}

/** The outcome of sanitizing one delta. */
export interface SanitizeResult {
  /** The cleaned text (identical to the input when nothing was removed). */
  text: string;
  /** How many code units were removed. */
  removed: number;
  /** The longest unbroken run of removed code units. */
  maxRun: number;
  /** The removed fraction of the input (0 when nothing was removed). */
  ratio: number;
}

/**
 * Remove blacklisted characters and measure how much garbage the text carried.
 *
 * Pure, allocation-conscious, and never throws: a non-string or empty input
 * yields the all-zero result, so a caller can feed it whatever the provider
 * hands over without a guard.
 *
 * @param text - one delta or accumulated block of text.
 * @returns the cleaned text plus the garbage measurements.
 */
export function sanitizeText(text: string): SanitizeResult {
  if (typeof text !== "string" || text.length === 0) {
    return { text: "", removed: 0, maxRun: 0, ratio: 0 };
  }
  let out = "";
  let removed = 0;
  let run = 0;
  let maxRun = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // A valid surrogate pair is ordinary text; skip both units together.
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // `?? ""` matches the repo's indexed-access idiom (see `context-trim.ts`);
        // the index is provably in range, so this is belt-and-braces for
        // `noUncheckedIndexedAccess` rather than a real fallback.
        out += (text[i] ?? "") + (text[i + 1] ?? "");
        i++;
        run = 0;
        continue;
      }
    }
    if (classifyCodeUnit(code) === "ok") {
      out += text[i] ?? "";
      run = 0;
      continue;
    }
    removed++;
    run++;
    if (run > maxRun) maxRun = run;
  }
  return { text: out, removed, maxRun, ratio: removed / text.length };
}

/** The two density thresholds that turn "garbage" into "collapse". */
export interface GarbageThresholds {
  /** An unbroken garbage run of at least this many code units means collapse. */
  maxRun: number;
  /** A garbage share of at least this fraction within one delta means collapse. */
  maxRatio: number;
}

/**
 * W9323: upstream npm tarball ref (not a repo file) — cannot rot with a local edit.
 * Upstream 2.1.6's shipped values (`index.js:220-223`).
 *
 * `garbageRunChars: 32` — an unbroken garbage run this long marks the delta as
 * collapse evidence. `garbageRatio: 0.5` — a garbage share this high within one
 * delta marks it as collapse evidence.
 */
export const DEFAULT_GARBAGE_THRESHOLDS: GarbageThresholds = { maxRun: 32, maxRatio: 0.5 };

/**
 * Whether a sanitize result is dense enough to count as model collapse.
 *
 * Two independent triggers, both configurable:
 *   - an unbroken garbage run of `maxRun` or more code units, or
 *   - a garbage share of `maxRatio` or more within one delta.
 *
 * Both are far above anything legitimate output produces: a normal reply's
 * garbage count is zero, and a single decoding hiccup is one or two code units.
 *
 * @param result - from [sanitizeText].
 * @param limits - density thresholds; defaults to [DEFAULT_GARBAGE_THRESHOLDS].
 * @returns true when the delta shows collapse.
 */
export function isSevereGarbage(result: SanitizeResult, limits: GarbageThresholds = DEFAULT_GARBAGE_THRESHOLDS): boolean {
  if (result.removed === 0) return false;
  return result.maxRun >= limits.maxRun || result.ratio >= limits.maxRatio;
}

/**
 * W9331: a garbage collapse expressed in the SAME evidence shape as a phrase
 * collapse, so the recovery path (retry ladder, truncation, diagnostics) is
 * shared and neither arm needs its own driver.
 *
 * This is deliberately NOT a statistical verdict, and it does not pretend to be
 * one: the fields that describe segments are zero, and `kind` says why. A reader
 * of a conviction log line must be able to tell "the window looked degenerate"
 * from "the delta was mostly illegal code points" without guessing.
 *
 * Pure, so the shape is testable without a stream.
 */
export function garbageEvidence(result: SanitizeResult, channel: RepetitionChannel): RepetitionEvidence {
  return {
    // `low-information` is the closer of the two existing kinds: the model
    // produced volume without producing information. There is deliberately no
    // new enum member, because every consumer (recovery, truncation, the log
    // record) already handles both kinds identically.
    kind: "low-information",
    channel,
    windowChars: result.removed,
    // Zero by construction: segmentation never ran, so claiming a segment count
    // would be inventing evidence.
    segments: 0,
    topPhrase: "",
    topPhraseCount: 0,
    longestRun: result.maxRun,
    duplicateShare: 0,
    uniqueGramRatio: 0,
  };
}
