/**
 * W2018 (B1): the two field-free compaction markers and their pairing detector.
 *
 * WHY THEY EXIST (docs/pitfalls.md P12): `POST /api/sessions/{id}/compact`
 * rewrites the log atomically and THEN rebinds the engine. Before this change
 * the log carried no trace that a compaction had ever run, so a log left in a
 * half-finished state was indistinguishable from an ordinary short session.
 *
 * WHERE THE MARKERS LIVE, AND WHAT THAT BUYS (the whole design):
 *
 *   - `compaction_start` is the FIRST ROW OF THE **NEW** LOG, i.e. it is part of
 *     the very byte string `rewriteAtomic` writes to its temp file and then
 *     `rename`s into place. It is therefore installed ATOMICALLY with the
 *     compacted history: a reader can never observe the start marker without the
 *     compacted log, nor the compacted log without the start marker.
 *
 *     Writing the start into the OLD log instead (append-then-rewrite) would be
 *     self-defeating: `rename` REPLACES the old file, so the marker would be
 *     destroyed by the very rewrite it is supposed to outlive. It would also
 *     mutate the log on a compaction that later fails (e.g. the summarizer
 *     throws), which is a behaviour change for a diagnostic.
 *
 *   - `compaction_end` is APPENDED, and the append is fsynced. Only when it has
 *     landed is the pair complete. W2020: the append is performed by the CALLER
 *     (via [installCompactionEnd]) once every step the compaction still owed has
 *     succeeded — in production, after the engine has been rebound onto the new
 *     log. It used to run inside [runCompaction] right after the rename.
 *
 * The detectable state is therefore exactly: **a log whose last
 * `compaction_start` has no `compaction_end` after it** — the rewrite landed
 * but the compaction never reached completion (the process died in that window,
 * the end append itself failed, or — W2020 — the caller's rebind failed). In
 * that state the caller never received a success answer, yet the pre-compaction
 * history is already gone from the log and survives only in
 * `cli-main.jsonl.precompact`.
 *
 * WHAT THE MOVED APPEND BUYS (W2020): the window the unpaired start describes is
 * now the WHOLE post-rewrite operation rather than just the rename. The failure
 * docs/pitfalls.md P12 names — `registry.ensure` refusing to recompose the
 * engine after the log was replaced — is inside it, so that half-finished state
 * is finally distinguishable from an ordinary session. Before the move the pair
 * was already closed when the rebind ran, so the rebind's failure left a log
 * that looked COMPLETE.
 *
 * HONEST SCOPE — what this still CANNOT see: a failure AFTER the rebind returned
 * (i.e. after [installCompactionEnd] ran) is outside the window by construction;
 * the compaction genuinely completed at that point, so there is nothing to
 * report. And the detector is a pure log reader: it says "an unpaired start
 * exists", never which of the window's steps failed.
 *
 * The markers carry no fields (the tag is the payload), are never emitted by the
 * engine, and project to nothing in every consumer, so an existing log replays
 * byte for byte.
 */

import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { serializeSessionEvent, type SessionEvent } from "@celestea/core";

/** The field-free "a compaction began" row (first row of the new log). */
export type CompactionStartEvent = Extract<SessionEvent, { type: "compaction_start" }>;
/** The field-free "the compaction finished" row (appended last). */
export type CompactionEndEvent = Extract<SessionEvent, { type: "compaction_end" }>;

/** The canonical start row. Frozen: it is a constant, not a per-call payload. */
export function compactionStartEvent(): CompactionStartEvent {
  return { type: "compaction_start" };
}

/** The canonical end row. */
export function compactionEndEvent(): CompactionEndEvent {
  return { type: "compaction_end" };
}

/**
 * Append the end marker to `logPath` and fsync it.
 *
 * Durability matters here: an end marker lost to a power cut would turn a
 * COMPLETED compaction into a false "interrupted" report, so the append is
 * ordered with the same fsync discipline `rewriteAtomic` uses for content.
 *
 * A failure PROPAGATES. Swallowing it would let the log show an unpaired start
 * for a compaction the caller was told had succeeded, which would destroy the
 * only meaning the marker has; the caller instead gets the error, and the
 * unpaired start it leaves behind is a truthful description of what happened.
 *
 * W2020: this is the DEFAULT writer for [installCompactionEnd] and is no longer
 * called by [runCompaction] itself — the timing moved to the caller, the bytes
 * did not.
 */
export function appendCompactionEnd(logPath: string): void {
  const fd = openSync(logPath, "a");
  try {
    writeSync(fd, `${serializeSessionEvent(compactionEndEvent())}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * True when the log's LAST `compaction_start` was never closed by a
 * `compaction_end` — the durable signature of an interrupted compaction.
 *
 * A scan (rather than a count) so that a log carrying several completed
 * compactions is judged on its TRAILING marker only: each rewrite installs
 * exactly one fresh start (older markers are orphan rows the planner drops), so
 * the last one is the one that describes the current state.
 */
export function hasUnpairedCompactionStart(events: readonly SessionEvent[]): boolean {
  let pending = false;
  for (const ev of events) {
    if (ev.type === "compaction_start") pending = true;
    else if (ev.type === "compaction_end") pending = false;
  }
  return pending;
}

/** Marker census of a log (gate/debug aid; `unpaired` is the P12 signal). */
export function compactionMarkers(events: readonly SessionEvent[]): { starts: number; ends: number; unpaired: boolean } {
  let starts = 0;
  let ends = 0;
  for (const ev of events) {
    if (ev.type === "compaction_start") starts += 1;
    else if (ev.type === "compaction_end") ends += 1;
  }
  return { starts, ends, unpaired: hasUnpairedCompactionStart(events) };
}
