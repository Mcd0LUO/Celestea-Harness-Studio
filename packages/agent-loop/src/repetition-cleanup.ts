/**
 * W9331 — RETROACTIVE decontamination, ported from upstream
 * `dsh-guard-repeat-output` **2.1.6** (MIT, zero dependencies) `lib/cleanup.js`.
 *
 * ## Why this exists
 *
 * The live guard prevents NEW pollution, but it cannot help a session that was
 * already poisoned before it was installed. Upstream measured this on a real
 * incident AFTER the guard went live: the active context still carried 205,942
 * characters of degenerate reasoning that every subsequent request replayed. Those
 * blocks are exactly the priming that makes a collapse recur.
 *
 * ## ⚠️ ONE DELIBERATE DIVERGENCE FROM UPSTREAM, MEASURED IN THIS REPO
 *
 * Upstream judges the **reasoning** of an `assistant/message`, because in its host
 * the reasoning IS part of the model-visible surface: it comes back as `reasoning`
 * content blocks on the next request.
 *
 * **In this repo it does not.** `packages/core/src/projection.ts` projects
 * `thinking_delta` to `null` — reasoning is a LOG-ONLY row, kept for the
 * transcript and the audit but never replayed to the provider. Measured directly:
 * a log whose `thinking_delta` says `SECRET_REASONING…` and whose
 * `assistant_message` says `the answer` derives a surface containing only
 * `[{"role":"assistant","content":[{"type":"text","content":"the answer"}]}]`.
 *
 * So judging reasoning here would be wrong in BOTH directions:
 *
 *   - it cannot be the pollution it is upstream (a hidden row is not replayed, so
 *     it cannot prime the next request), and
 *   - shadowing a turn on that basis would delete a **healthy, model-visible
 *     answer** to hide text the model never saw — strictly harmful.
 *
 * Therefore the scan judges the text this repo actually REPLAYS: the concatenated
 * `assistant_message` rows of a turn. The degenerate-reasoning size is still
 * REPORTED (it is the shape the live guard fights, and it is what a human auditing
 * the log wants), but it is a diagnostic, not a shadow trigger. Same mechanism,
 * same goal — remove replayed degeneration — adapted to what is actually replayed.
 *
 * ## THE SAFETY RULE THAT MATTERS
 *
 * A turn that contains a tool call must NOT be shadowed on its own: its
 * `tool_result` rows would survive as orphans, and providers reject a tool result
 * with no matching call. Upstream verified that the real surface fold accepts the
 * orphan SILENTLY, so the danger is real and not caught downstream. This module
 * therefore REPORTS `hasToolCall` rather than deciding, and the caller must skip
 * those turns.
 *
 * ## Why the verdict reuses the LIVE detector
 *
 * [degenerateVerdict] calls [evaluateRepetitionWindow] — the same function the
 * online guard uses — rather than a second implementation, so the offline scan and
 * the live guard can never disagree about what "degenerate" means. A cleanup using
 * LOOSER thresholds than the guard would shadow text the guard considered healthy,
 * which is the one outcome that makes this feature dangerous.
 */

import type { SessionEvent } from "@celestea/core";
import {
  DEEPSEEK_REPETITION_THRESHOLDS,
  evaluateRepetitionWindow,
  type RepetitionEvidence,
  type RepetitionThresholds,
} from "./repetition.js";

/**
 * Whether one block of model-visible text looks degenerate.
 *
 * The text is fed forward in check-sized slices and the accumulating tail window is
 * evaluated at each step, exactly as the live stream does as it grows. The first
 * slices are below `minWindowChars` and return `null`, which is the same "not
 * enough evidence yet" the live guard gives.
 *
 * @param text - concatenated model-visible text of one turn.
 * @param thresholds - resolved guard thresholds (the same shape the live guard uses).
 * @returns the detector's evidence, or null when healthy.
 */
export function degenerateVerdict(
  text: string,
  thresholds: RepetitionThresholds = DEEPSEEK_REPETITION_THRESHOLDS,
): RepetitionEvidence | null {
  if (typeof text !== "string" || text.length < thresholds.minWindowChars) return null;
  const step = Math.max(1, thresholds.evalEveryChars);
  for (let end = step; end < text.length + step; end += step) {
    const evidence = evaluateRepetitionWindow(text.slice(0, end), thresholds, "text");
    if (evidence !== null) return evidence;
  }
  return null;
}

/** One degenerate turn, as the scan reports it. */
export interface DegenerateTurn {
  /** The turn NUMBER the degenerate text belongs to (`turn-<n>` -> `n`). */
  turn: number;
  /** Index into the events array of the `turn_start` that opened it. */
  startIndex: number;
  /** MODEL-VISIBLE characters judged (the concatenated `assistant_message` text). */
  chars: number;
  /**
   * Reasoning characters seen in the turn. Reported for diagnosis only — in this
   * repo reasoning is a LOG-ONLY row (`projection.ts` projects `thinking_delta` to
   * `null`), so it is neither the pollution nor a reason to shadow. See the header.
   */
  reasoningChars: number;
  /**
   * True when the turn also emitted a tool call. **The caller MUST skip these**:
   * shadowing the turn would orphan its `tool_result` rows, and the surface fold
   * accepts the orphan silently (see the module header).
   */
  hasToolCall: boolean;
  /** The detector's evidence for the model-visible text. */
  evidence: RepetitionEvidence;
}

/** `turn-<n>` -> `n`, or null when the id is not that shape. */
function parseTurnNumber(id: string): number | null {
  const match = /^turn-(\d+)$/.exec(id);
  return match === null ? null : Number(match[1]);
}

/**
 * Find degenerate turns in one session's events.
 *
 * Text and reasoning are accumulated PER TURN (between `turn_start` and
 * `turn_end`), because a window shared across turns would let one healthy turn
 * dilute another turn's collapse — and the reverse. A turn with no model-visible
 * text, and a row outside any turn markers, are both skipped rather than guessed at.
 *
 * @param events - contiguous session events.
 * @param thresholds - resolved guard thresholds.
 * @returns one entry per degenerate turn, oldest first.
 */
export function findDegenerateTurns(
  events: readonly SessionEvent[],
  thresholds: RepetitionThresholds = DEEPSEEK_REPETITION_THRESHOLDS,
): DegenerateTurn[] {
  const found: DegenerateTurn[] = [];
  let turn: number | null = null;
  let startIndex = 0;
  let text = "";
  let reasoningChars = 0;
  let hasToolCall = false;

  const settle = (): void => {
    if (turn === null || text === "") return;
    const evidence = degenerateVerdict(text, thresholds);
    if (evidence === null) return;
    found.push({ turn, startIndex, chars: text.length, reasoningChars, hasToolCall, evidence });
  };

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event === undefined) continue;
    if (event.type === "turn_start") {
      // A new turn opens: settle the previous one first (a torn log may lack its
      // `turn_end`, and dropping it would silently skip a degenerate turn).
      settle();
      turn = parseTurnNumber(event.id);
      startIndex = i;
      text = "";
      reasoningChars = 0;
      hasToolCall = false;
      continue;
    }
    if (event.type === "turn_end") {
      settle();
      turn = null;
      text = "";
      reasoningChars = 0;
      hasToolCall = false;
      continue;
    }
    if (turn === null) continue;
    if (event.type === "assistant_message") text += event.text;
    else if (event.type === "thinking_delta") reasoningChars += event.text.length;
    else if (event.type === "tool_call") hasToolCall = true;
  }
  settle();
  return found;
}

/**
 * Build the replacement note that shadows one degenerate turn.
 *
 * Model-facing, like the guard's wrap-up instruction: it tells the model what was
 * removed and why, and tells it to continue from the surrounding conversation —
 * because a shadow with no explanation reads as a hole in the history.
 *
 * @param entry - one entry from [findDegenerateTurns].
 * @returns the model-facing replacement text.
 */
export function cleanupNote(entry: DegenerateTurn): string {
  return [
    "[guard-repeat-output] Removed a degenerate block from this conversation:",
    `- ${entry.chars} characters of repeating text at turn ${entry.turn}`,
    `- measured repetition ${(entry.evidence.duplicateShare * 100).toFixed(1)}%, new-material ratio ${(entry.evidence.uniqueGramRatio * 100).toFixed(1)}%`,
    "The block produced no work and is not shown again. Continue from the surrounding conversation.",
  ].join("\n");
}
