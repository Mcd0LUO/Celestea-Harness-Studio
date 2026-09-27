/**
 * Compaction orchestration (port of `celestea_studio/src/compact.rs:410-500`,
 * extended by W2011/B2 with a head budget).
 *
 * One call is: read -> parse -> threshold -> summarize -> plan -> atomic rewrite
 * (W2018/B1: the rewrite installs a leading `compaction_start` marker inside the
 * same atomic rename, and a trailing `compaction_end` is appended once it
 * returned — see ./markers.ts for why that placement is the only one that can
 * make an interrupted compaction detectable).
 * Every branch is explicit and observable, because the HTTP layer has to answer
 * three different ways:
 *   - `compacted:false` (at/below [COMPACT_THRESHOLD] complete turns) is a
 *     NORMAL 200 with the frozen "历史不足，无需压缩" note;
 *   - `compacted:true` carries `kept_turns` and the "已压缩…" note;
 *   - a read/summary/write failure throws — the caller turns it into a 500 with
 *     the message (never a silent no-op that left the log untouched).
 *
 * Parsing mirrors the host's `parse_session_jsonl`: blank lines are padding and
 * parsing STOPS at the first unparsable record (a torn tail is not content).
 */

import { readFileSync } from "node:fs";
import { parseSessionEvent, type SessionEvent } from "@celestea/core";
import {
  COMPACT_HEAD_TURNS,
  COMPACT_KEEP_TURNS,
  COMPACT_NOTE_SKIPPED,
  compactNote,
  countCompleteTurns,
  planCompaction,
  selectTurns,
} from "./plan.js";
import { appendCompactionEnd, compactionEndEvent, compactionStartEvent } from "./markers.js";
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
  /** W2018/B1: the post-rewrite end-marker append (default: real fs + fsync). */
  append?: (path: string) => void;
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
   * The NEW LOG exactly as it was written (W2018/B1: the leading
   * `compaction_start` and the trailing `compaction_end` included), or null
   * when nothing was compacted.
   */
  events: SessionEvent[] | null;
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
 * Run one compaction. Throws on read/summarize/write failure; returns the
 * skipped branch when the history is too short to be worth a summary request.
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
  // The end marker lands only AFTER the rename returned, so a log whose last
  // start has no end is the durable signature of a compaction that died in
  // between (docs/pitfalls.md P12). A failure here propagates: the caller must
  // not be told "compacted" while the log says otherwise.
  (input.append ?? appendCompactionEnd)(input.logPath);
  const kept = selectTurns(events, keep, head);
  return {
    compacted: true,
    kept_turns: Math.min(kept.head.length + kept.tail.length, turns),
    note: compactNote(keep, head),
    turns_before: turns,
    // The log AS IT NOW IS on disk, both markers included — so the existing
    // "parsed file equals result.events" invariant keeps holding
    // (w2011-headtail.test.ts pins it).
    events: [...rewritten, compactionEndEvent()],
  };
}
