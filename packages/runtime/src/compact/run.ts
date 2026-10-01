/**
 * Compaction orchestration (port of `celestea_studio/src/compact.rs:410-500`,
 * extended by W2011/B2 with a head budget).
 *
 * One call is: read -> parse -> threshold -> summarize -> plan -> atomic rewrite
 * (W2018/B1: the rewrite installs a leading `compaction_start` marker inside the
 * same atomic rename; W2020 moved the trailing `compaction_end` OUT of this
 * function — the caller closes the pair with [installCompactionEnd] only after
 * its own post-rewrite work succeeded. See ./markers.ts for why that placement
 * is the only one that can make a REBIND failure detectable).
 * Every branch is explicit and observable, because the HTTP layer has to answer
 * three different ways:
 *   - `compacted:false` (at/below [COMPACT_THRESHOLD] complete turns) is a
 *     NORMAL 200 with the frozen "历史不足，无需压缩" note;
 *   - `compacted:true` carries `kept_turns` and the "已压缩…" note;
 *   - a read/summary/write failure throws — the caller turns it into a 500 with
 *     the message (never a silent no-op that left the log untouched).
 *
 * W1900: the rewrite also INVALIDATES the session's compression sidecar, since
 * that sidecar is a list of turn intervals over the numbering the rewrite has
 * just replaced (see [clearCompressionSidecar]).
 *
 * Parsing mirrors the host's `parse_session_jsonl`: blank lines are padding and
 * parsing STOPS at the first unparsable record (a torn tail is not content).
 */

import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { parseSessionEvent, type SessionEvent } from "@celestea/core";
import { compressionPathFor } from "@celestea/session";
import {
  COMPACT_HEAD_TURNS,
  COMPACT_KEEP_TURNS,
  COMPACT_NOTE_SKIPPED,
  compactNote,
  countCompleteTurns,
  planCompaction,
  selectTurns,
} from "./plan.js";
import { appendCompactionEnd, compactionStartEvent } from "./markers.js";
import { rewriteAtomic } from "./rewrite.js";
import type { Summarizer } from "./summarize.js";
import { renderTranscript } from "./transcript.js";

export interface CompactionInput {
  /** Absolute path of the session log (`<session dir>/cli-main.jsonl`). */
  logPath: string;
  summarize: Summarizer;
  /** Surviving most-recent complete turns (default [COMPACT_KEEP_TURNS]). */
  keep?: number;
  /** Surviving oldest complete turns (default [COMPACT_HEAD_TURNS]; 0 = pure tail). */
  head?: number;
  /** Injection seams for tests (defaults: real fs). */
  readText?: (path: string) => string;
  write?: (path: string, events: readonly SessionEvent[]) => void;
  /**
   * W2020: how the pair-closing end marker lands. The CALLER owns the timing
   * (see [installCompactionEnd]); this only decides the bytes.
   */
  writeEndMarker?: (path: string) => void;
  /**
   * W1900: how the stale compression sidecar is removed (default: real fs).
   * Injected so a test can assert the invalidation happened without a disk.
   */
  removeSidecar?: (path: string) => void;
}

export interface CompactionResult {
  compacted: boolean;
  /**
   * Complete ORIGINAL turns the new log still carries, head + tail (present as a
   * number only when `compacted === true`). The elision row is not a turn of its
   * own, so it is not counted here — the count answers "how much history
   * survived", not "how many turn_start rows are in the file".
   */
  kept_turns: number | null;
  note: string;
  /** Complete turns found in the log BEFORE the decision. */
  turns_before: number;
  /**
   * The log THIS CALL REWROTE (W2018/B1: the leading `compaction_start`
   * included), or null when nothing was compacted.
   *
   * W2020: this is NOT "the log as it now is on disk". The trailing
   * `compaction_end` is written by the caller, after its own work succeeded, so
   * it is deliberately ABSENT here rather than being a row this call never
   * wrote. See [installCompactionEnd].
   */
  events: SessionEvent[] | null;
  /**
   * The append seam that CLOSES this compaction's pair, carried out of the call
   * so the caller can hand the very same seam to [installCompactionEnd]. It is
   * present only when `compacted === true` (the skip branch opens no pair), and
   * it carries the test seam rather than the real fs so a caller never has to
   * re-decide which writer to use.
   */
  writeEndMarker?: (path: string) => void;
}

/** JSONL text -> events; blank lines are padding, a torn tail stops parsing. */
export function parseEventLog(text: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const parsed = parseSessionEvent(line.trim());
    if (!parsed.ok) break;
    events.push(parsed.event);
  }
  return events;
}

function readLog(input: CompactionInput): string {
  try {
    return (input.readText ?? ((p: string): string => readFileSync(p, "utf8")))(input.logPath);
  } catch (e) {
    throw new Error(`读取会话日志失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * W2020: close the pair that [runCompaction]'s rewrite opened.
 *
 * Call this with the result of the rewrite, AFTER every step the compaction
 * still owed (in production: the engine rebind in `session-lifecycle.ts`) has
 * succeeded. If that step fails, the end marker is never written and the log
 * keeps an UNPAIRED `compaction_start` — the durable signature
 * [hasUnpairedCompactionStart] reads, which is exactly the P12 failure that was
 * invisible while this append lived inside [runCompaction].
 *
 * The skip branch (`compacted: false`) writes NOTHING: a short history opens no
 * pair, so an end there would be an ORPHAN end, not a completion. That is why
 * this takes the RESULT and not just a path — a caller cannot turn it into an
 * orphan end by forgetting a branch.
 */
export function installCompactionEnd(
  result: Pick<CompactionResult, "compacted">,
  logPath: string,
  writeEndMarker: (path: string) => void = appendCompactionEnd,
): void {
  if (!result.compacted) return;
  writeEndMarker(logPath);
}

/**
 * W1900: drop the session's compression sidecar, because the log it described
 * has just been renumbered.
 *
 * The sidecar is DERIVED state (a list of turn intervals plus summaries), and
 * a compaction replaces the turn numbering wholesale. Rebound over the new log
 * it would either cover the wrong turns or — via the overlay's missing-turn
 * arm — reach past what it ever claimed. Nothing is lost by dropping it: the
 * new log carries the summary row, and `decompress` was only ever about the
 * pre-compaction numbering.
 *
 * Best-effort on a MISSING file (the ordinary case: most sessions never
 * compress), loud on a real failure — see the call site for why that has to
 * fail the whole compaction rather than be swallowed.
 */
function clearCompressionSidecar(path: string, remove?: (p: string) => void): void {
  try {
    (remove ?? ((p: string): void => rmSync(p, { force: true })))(path);
  } catch (e) {
    throw new Error(`压缩已重写日志，但清理压缩侧车失败（${path}）：${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Run one compaction. Throws on read/summarize/write failure; returns the
 * skipped branch when the history is too short to be worth a summary request.
 *
 * W2020: a successful return means "the log has been REWRITTEN", not "the
 * compaction is complete" — the caller still owes [installCompactionEnd].
 */
export async function runCompaction(input: CompactionInput): Promise<CompactionResult> {
  const keep = input.keep ?? COMPACT_KEEP_TURNS;
  const head = input.head ?? COMPACT_HEAD_TURNS;
  const events = parseEventLog(readLog(input));
  const turns = countCompleteTurns(events);
  if (turns <= 0 || planCompaction(events, "", keep, head) === null) {
    return { compacted: false, kept_turns: null, note: COMPACT_NOTE_SKIPPED, turns_before: turns, events: null };
  }
  const summary = await input.summarize(renderTranscript(events));
  const planned = planCompaction(events, summary, keep, head);
  if (planned === null) throw new Error("内部错误：压缩计划为空");
  // W2018 (B1): the start marker rides INSIDE the atomic rewrite, as the first
  // row of the NEW log — so it is installed all-or-nothing together with the
  // compacted history. Appending it to the OLD log instead would be
  // self-defeating: the rename replaces that file, destroying the marker.
  const rewritten: SessionEvent[] = [compactionStartEvent(), ...planned];
  (input.write ?? rewriteAtomic)(input.logPath, rewritten);
  // W1900 x W2011: the rewrite RENUMBERS the turns (the old log's turns are
  // replaced by a synthetic head + the kept tail, all counted from turn-0
  // again). Every block in the compression sidecar is a CLOSED INTERVAL OVER
  // THE OLD NUMBERS, so keeping the file means the next rebind applies
  // intervals that now point at different turns — or, when a `to_turn` no
  // longer exists, at whatever the overlay can reach from there. The history
  // itself is not lost (the new log carries the summary row), so the honest
  // move is to drop the derived state with the numbering it was derived from.
  //
  // It rides WITH the rewrite, before the caller rebinds: a rebind over a
  // stale sidecar is precisely the window this closes. A failure here throws,
  // which leaves the compaction's `compaction_start` pair unpaired — the same
  // "half-finished state is detectable" rule the end-marker placement follows
  // (docs/pitfalls.md P12), rather than a silent return over a stale view.
  clearCompressionSidecar(compressionPathFor(dirname(input.logPath)), input.removeSidecar);
  // W2020: the end marker is NOT appended here. This function is only the
  // REWRITE half of the operation; the caller still has to rebind the engine,
  // and a pair closed before that step cannot describe that step's failure. The
  // caller closes it through [installCompactionEnd] once the rebind succeeded,
  // so an unpaired start now covers the WHOLE window (docs/pitfalls.md P12)
  // instead of only the rename.
  const kept = selectTurns(events, keep, head);
  return {
    compacted: true,
    kept_turns: Math.min(kept.head.length + kept.tail.length, turns),
    note: compactNote(keep, head),
    turns_before: turns,
    // What THIS CALL wrote: the start marker and the compacted history, exactly
    // the byte string the atomic rewrite installed. The end row reaches the FILE
    // later, written by the caller, so it is not claimed here.
    events: rewritten,
    // Hand the caller the seam that closes the pair, so it neither re-decides
    // the writer nor has to import the fs default itself.
    writeEndMarker: input.writeEndMarker ?? appendCompactionEnd,
  };
}
