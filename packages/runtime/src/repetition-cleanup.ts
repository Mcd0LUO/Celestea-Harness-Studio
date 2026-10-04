/**
 * W9331 — apply the RETROACTIVE decontamination to a session's surface.
 *
 * The pure half lives in `@celestea/agent-loop` (`repetition-cleanup.ts`): it
 * reports which turns carry degenerate reasoning and whether they also emitted a
 * tool call. THIS file owns the other half — shadowing those turns — and it lives
 * in `runtime` because it needs the compression store.
 *
 * ## The mechanism is the repo's EXISTING one, not a new one
 *
 * Upstream's `lib/cleanup.js` shadows a degenerate assistant message "using the
 * same surface-replacement mechanism compaction uses". This repo HAS that
 * mechanism, and it is the compression OVERLAY (`@celestea/core`
 * `overlayCompressions`, mounted as a log decorator by
 * `packages/session/src/compression-log.ts`):
 *
 *   - the log stays **append-only** and keeps every original byte;
 *   - `events()` is untouched, so extraction, replay and audit still read it all;
 *   - only `deriveMessages()` — the model-visible surface — is overlaid, replacing
 *     a covered turn range with ONE replacement message.
 *
 * So a block whose `summary` is the cleanup note is exactly "shadow this turn with
 * a short note, keep the bytes". Nothing is deleted, and a decompress of the same
 * range brings the original turns back — which is what makes a false positive
 * cheap rather than a loss.
 *
 * ⚠️ Do NOT reach for `POST /api/sessions/{id}/compact` here: that path REWRITES
 * the log, renumbers turns and destroys the overlay (`packages/runtime/src/compact/`).
 * It is a different feature that happens to share the word "compaction".
 *
 * ## The two rules that make this safe
 *
 *   1. **A turn with a tool call is never shadowed.** Its `tool_result` rows would
 *      survive as orphans, and the surface fold accepts that silently (verified
 *      upstream), so the caller is TOLD about it and it is left alone.
 *   2. **The turn in flight is never shadowed.** `validateRange` refuses
 *      `to_turn >= currentTurn`; that refusal is reused rather than re-implemented,
 *      so there is one truth for "may this range be covered?".
 */

import {
  maxTurnNumber,
  normalizeBlocks,
  validateRange,
  type CompressionBlock,
  type SessionEvent,
  type SessionLog,
} from "@celestea/core";
import {
  DEEPSEEK_REPETITION_THRESHOLDS,
  cleanupNote,
  findDegenerateTurns,
  type RepetitionThresholds,
} from "@celestea/agent-loop";
import { compressionStoreOf, type CompressionStore } from "@celestea/session";

/** One turn the scan found but deliberately did NOT shadow, and why. */
export interface SkippedTurn {
  turn: number;
  reason: "tool-call" | "not-in-range";
}

/** The outcome of one cleanup pass. */
export interface CleanupResult {
  /** Turns actually shadowed (a block was written for each). */
  shadowed: number[];
  /** Turns left alone, with the reason — never silent. */
  skipped: SkippedTurn[];
  /** The block list after the pass (also what was persisted). */
  blocks: CompressionBlock[];
}

/** The three things a cleanup pass needs from a session. */
export interface CleanupTarget {
  /** The RAW events (never the compressed view). */
  events(): readonly SessionEvent[];
  /** The current block list. */
  blocks(): readonly CompressionBlock[];
  /** Persist the new block list (the store owns atomicity). */
  save(blocks: readonly CompressionBlock[]): void;
}

/**
 * Build a [CleanupTarget] from a decorated log.
 *
 * `null` when the log carries no overlay (a detached in-memory session, or the
 * compression kill-switch): with nowhere to persist a block, a port that silently
 * dropped writes would report success for a cleanup that did not happen.
 */
export function cleanupTargetOf(log: SessionLog | null | undefined): CleanupTarget | null {
  if (log === undefined || log === null) return null;
  const store: CompressionStore | null = compressionStoreOf(log);
  if (store === null) return null;
  return { events: () => log.events(), blocks: () => store.blocks(), save: (next) => store.save(next) };
}

/**
 * Scan for degenerate turns and shadow the ones that are safe to shadow.
 *
 * Deterministic and side-effect-free except for ONE `target.save` at the end, so a
 * pass that changes nothing writes nothing (no spurious sidecar churn, and no
 * compression epoch bump for a no-op).
 *
 * @param target - the session's raw events + block list.
 * @param thresholds - resolved guard thresholds; pass the LIVE ones so the offline
 *   scan and the online guard cannot disagree (see the pure half's header).
 * @returns which turns were shadowed, which were skipped and why.
 */
export function shadowDegenerateTurns(
  target: CleanupTarget,
  thresholds: RepetitionThresholds = DEEPSEEK_REPETITION_THRESHOLDS,
): CleanupResult {
  const events = target.events();
  const found = findDegenerateTurns(events, thresholds);
  const current = maxTurnNumber(events);
  let blocks: CompressionBlock[] = [...target.blocks()];
  const shadowed: number[] = [];
  const skipped: SkippedTurn[] = [];

  for (const entry of found) {
    // Rule 1: a turn with a tool call is reported, never shadowed (orphan results).
    if (entry.hasToolCall) {
      skipped.push({ turn: entry.turn, reason: "tool-call" });
      continue;
    }
    const block: CompressionBlock = {
      from_turn: entry.turn,
      to_turn: entry.turn,
      summary: cleanupNote(entry),
      // `created_turn` must sit outside the covered range; the newest turn is the
      // only honest answer, and it is never inside a range we are allowed to write.
      created_turn: current,
      context_ratio: 0,
    };
    // Rule 2: the range validator owns "may this be covered?" — the turn in flight
    // is protected there, so this does not re-implement that judgement.
    if (validateRange(events, { from: block.from_turn, to: block.to_turn }, current) !== null) {
      skipped.push({ turn: entry.turn, reason: "not-in-range" });
      continue;
    }
    const merged = normalizeBlocks([...blocks, block]);
    // Did adding this block actually CHANGE the list? Comparing the block's own
    // range is NOT enough: `normalizeBlocks` merges adjacent and overlapping ranges,
    // so re-adding a block for an already-covered turn produces a list that is
    // identical (or merely wider) and a range check would report a second shadowing
    // that did not happen. The list is the truth, so it is compared as one.
    if (sameBlocks(merged, blocks)) {
      skipped.push({ turn: entry.turn, reason: "not-in-range" });
      continue;
    }
    blocks = merged;
    shadowed.push(entry.turn);
  }

  if (shadowed.length > 0) target.save(blocks);
  return { shadowed, skipped, blocks };
}

/** Structural equality of two block lists (they are small, flat and JSON-safe). */
function sameBlocks(a: readonly CompressionBlock[], b: readonly CompressionBlock[]): boolean {
  return a.length === b.length && a.every((block, i) => JSON.stringify(block) === JSON.stringify(b[i]));
}
