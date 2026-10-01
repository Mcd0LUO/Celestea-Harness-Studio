/**
 * Phase 2 · model-driven context compression — the RANGE half.
 *
 * This module owns the arithmetic a compressed range is made of, and nothing
 * else: what a well-formed interval is, which intervals the engine accepts
 * against a real log and a real current turn, how a set of blocks flattens
 * into a non-overlapping cover (the nested-merge rule), and where a turn sits
 * in the raw event stream. It never builds a [Message] and never produces a
 * view — ./compression.ts holds the schema and the overlay projection that
 * consumes these numbers.
 *
 * The two invariants it exists to protect are the ones the overlay relies on:
 *
 *   1. **The log is the truth.** Validation reads the RAW event stream, so a
 *      range can only ever cover turns that actually happened; a corrupt or
 *      missing sidecar degrades to "no blocks", never to a rewritten history.
 *   2. **A turn is the atom.** A range is a turn-number interval, so it never
 *      splits a turn, and a turn boundary always carries a complete
 *      tool_call/tool_result group.
 *
 * Turn ids are the ONLY stable anchor a caller can hold: a [Message] has no
 * id, and a [SessionEvent] has no ordinal id either (see projection.ts — the
 * tool_call accumulator makes message<->event non-1:1). `turn-<n>` is
 * therefore both the reference scheme and the boundary rule.
 *
 * Everything here is generic over [RangedBlock] rather than over the concrete
 * block type, so the range math has no opinion about summaries, storage or
 * rendering: the schema that adds those lives next door.
 */

import { maxTurnNumber, parseTurnNumber } from "./turn-id.js";
import type { SessionEvent } from "./types.js";

/**
 * The coordinates of a compressed range, and nothing else.
 *
 * The two fields every piece of range math needs. A concrete block extends
 * this with the summary text and the bookkeeping the sidecar records.
 */
export interface RangedBlock {
  /** Closed turn interval this block replaces. */
  from_turn: number;
  /** Closed turn interval's last turn, inclusive. */
  to_turn: number;
}

/** A closed interval of turn numbers (`turn-${from}` .. `turn-${to}`). */
export interface TurnRange {
  /** First turn of the range, inclusive. */
  from: number;
  /** Last turn of the range, inclusive. */
  to: number;
}

/** A compression range that was refused, with the reason the model is told. */
export type CompressionRejection =
  | "not_aligned"
  | "unknown_turn"
  | "current_turn"
  | "inverted"
  | "empty";

/** True when [range] is a well-formed, non-inverted interval. */
export function isValidRange(range: TurnRange): boolean {
  return (
    Number.isSafeInteger(range.from) &&
    Number.isSafeInteger(range.to) &&
    range.from >= 1 &&
    range.to >= range.from
  );
}

/**
 * Validate a requested range against the log and the current turn.
 *
 * The CURRENT turn is refused by the ENGINE, not by the prompt: a summary of
 * the turn being generated cannot exist yet, and a block covering it would
 * hide the very turn the model is answering in. `current_turn` therefore
 * means `to_turn >= the turn in flight`.
 *
 * Turn numbers the log never had are refused as `unknown_turn` — a caller
 * may only compress turns that actually happened. Reading the raw stream is
 * what makes that checkable at all: the view may already be overlaid, but
 * the log is the truth.
 */
export function validateRange(
  events: readonly SessionEvent[],
  range: TurnRange,
  currentTurn: number,
): CompressionRejection | null {
  if (!isValidRange(range)) return "inverted";
  // Order matters, and it is not cosmetic. `current_turn` is the stronger
  // invariant and the one the philosophy paragraph names, so it is asked FIRST:
  // a range that overshoots into the turn in flight gets that diagnosis even
  // when the turn after it does not exist yet, because "never compress the
  // turn you are answering in" is the rule the model must actually learn.
  // `unknown_turn` then only fires for a range that stays in the past but names
  // a turn the log has no record of (a gap, or a sidecar written elsewhere).
  if (range.to >= currentTurn) return "current_turn";
  if (maxTurnNumber(events) < range.to) return "unknown_turn";
  return null;
}

/**
 * Flatten blocks into a non-overlapping, sorted cover of the event stream.
 *
 * A block that COVERS an earlier one (the nested re-compression case) replaces
 * it entirely: the old summary is consumed by the new one, which is the
 * "summary of summaries" the spec calls for. Where blocks merely OVERLAP, the
 * older one is SPLIT so it keeps exactly the turns the newer one does not
 * claim — an overlap must never leave a turn uncovered, because a turn that is
 * in no block and projects no events is a turn the model can never see again.
 *
 * Newest wins because the list is walked in INSERTION order, which is also
 * recency order: a block written later is a block written with more context.
 *
 * Copies, never mutates the caller's blocks — the store hands out the live
 * list and the view may be rebuilt at any time.
 */
export function normalizeBlocks<T extends RangedBlock>(blocks: readonly T[]): T[] {
  let out: T[] = [];
  for (const block of blocks) {
    const next: T[] = [];
    for (const kept of out) {
      // Full cover: the newer block supersedes the older one entirely. This is
      // the nested re-compression rule — the old summary is CONSUMED by the new
      // one, which is a summary of summaries.
      if (block.from_turn <= kept.from_turn && block.to_turn >= kept.to_turn) continue;
      // Disjoint (or entirely before/after): untouched.
      if (block.to_turn < kept.from_turn || block.from_turn > kept.to_turn) {
        next.push(kept);
        continue;
      }
      // Partial overlap: the older block keeps the part of its range the newer
      // one does not claim, split either side. Dropping a whole side instead
      // would leave those turns with NO block at all, and a turn with no block
      // and no projected events is a turn the model can never see again.
      const head: T = { ...kept, to_turn: block.from_turn - 1 };
      const tail: T = { ...kept, from_turn: block.to_turn + 1 };
      if (head.to_turn >= head.from_turn) next.push(head);
      if (tail.to_turn >= tail.from_turn) next.push(tail);
    }
    next.push({ ...block });
    out = next;
  }
  return out.sort((a, b) => a.from_turn - b.from_turn || a.to_turn - b.to_turn);
}

/** How many blocks [normalizeBlocks] folded into the result (nested merge count). */
export function mergedBlockCount(blocks: readonly RangedBlock[]): number {
  return blocks.length - normalizeBlocks(blocks).length;
}

/**
 * The index the given turn STARTS at, or **-1 when the log has no such turn**.
 *
 * The -1 is load-bearing and is why this is not written as "return `from`
 * when missing": a caller that cannot tell "turn 2 starts at index 4" from
 * "turn 9 was not found" will happily splice the whole rest of the log out of
 * the view, which is how a stale sidecar left over from a different session
 * would erase the conversation a model is currently having.
 */
export function turnStartIndex(events: readonly SessionEvent[], turn: number, from: number): number {
  for (let i = from; i < events.length; i += 1) {
    const ev = events[i];
    if (ev === undefined) break;
    if (ev.type === "turn_start" && parseTurnNumber(ev.id) === turn) return i;
  }
  return -1;
}

/**
 * The index just PAST the given turn's last event, or **-1 when the log has no
 * such turn** — the same not-found signal as `turnStartIndex`.
 *
 * A turn's span is `turn_start` .. the next `turn_start` (or the end of the
 * log), not `turn_start` .. `turn_end`: the rows between a turn's end and
 * the next turn's start (a receipt, a steering row) belong to neither turn,
 * and a range must not swallow them.
 */
export function turnEndIndex(events: readonly SessionEvent[], turn: number, from: number): number {
  // The turn must be PRESENT before its end means anything: walking forward
  // looking only for a later turn_start would happily return that later turn's
  // index for a turn the log never had, and the caller would treat the gap
  // between as the turn's own span.
  if (turnStartIndex(events, turn, from) < 0) return -1;
  for (let i = from; i < events.length; i += 1) {
    const ev = events[i];
    if (ev === undefined) break;
    if (ev.type === "turn_start") {
      const n = parseTurnNumber(ev.id);
      if (n !== null && n > turn) return i;
    }
  }
  return events.length;
}


/** Every turn number the log actually has, ascending (empty when none). */
export function turnNumbersOf(events: readonly SessionEvent[]): number[] {
  const seen = new Set<number>();
  for (const ev of events) {
    if (ev.type !== "turn_start") continue;
    const n = parseTurnNumber(ev.id);
    if (n !== null) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}
