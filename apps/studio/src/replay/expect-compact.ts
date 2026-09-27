/**
 * INDEPENDENT re-derivation of the frozen compaction plan (W259 / W2011).
 *
 * This is deliberately a SECOND implementation: the runtime's planner lives in
 * `packages/runtime/src/compact/plan.ts` (written as a straight port of
 * `celestea_studio/src/compact.rs`), while this one is written from the spec text
 * with a different shape (index scan + slice, no helper reuse). A P5 comparison
 * between the two is therefore a cross-implementation check of the STRUCTURE
 * (summary turn, head selection, elision row, kept-tail selection, renumbering,
 * dropping an unterminated tail), not a tautology.
 *
 * The summary string is passed in (the replay reads it back out of the compacted
 * log), so the summary itself is out of scope for this comparison.
 *
 * W2011: the plan is no longer pure-tail. It keeps the OLDEST `head` turns as
 * well as the newest `keep`, and stands in for everything between them with an
 * elision row. This oracle tracks that spec independently -- including the token
 * estimate, whose input is the exact JSON serialization of the dropped rows.
 */

import type { SessionEvent } from "@celestea/core";

export const SPEC_THRESHOLD = 8;
export const SPEC_KEEP = 4;
/** W2011: surviving OLDEST complete turns (the pre-W2011 planner had no head). */
export const SPEC_HEAD = 2;
export const SPEC_HEAD_PREFIX = "【上下文压缩】";
export const SPEC_HEAD_ASSISTANT = "上下文已压缩，以上为历史摘要。";
export const SPEC_ELISION_PREFIX = "【上下文压缩·省略】";

/** Index ranges [start, end) of every complete turn (`turn_start` .. `turn_end`). */
export function completeTurnRanges(events: readonly SessionEvent[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev === undefined) continue;
    if (ev.type === "turn_start") {
      start = i;
      continue;
    }
    if (ev.type === "turn_end" && start >= 0) {
      ranges.push([start, i + 1]);
      start = -1;
    }
  }
  return ranges;
}

/**
 * The token estimate the elision row quotes: `ceil(utf8 bytes / 4)`, the SAME
 * ruler the agent loop's context trim uses. Re-derived here (not imported) so a
 * change on either side shows up as a diff.
 */
function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

/** The exact bytes the dropped rows occupy: their JSON, concatenated. */
function droppedBytes(events: readonly SessionEvent[], ranges: ReadonlyArray<[number, number]>): string {
  let text = "";
  for (const [from, to] of ranges) for (let i = from; i < to; i++) text += JSON.stringify(events[i]);
  return text;
}

/** The synthetic turn-1: summary row + fixed assistant row, closed as completed. */
function summaryTurn(summary: string): SessionEvent[] {
  return [
    { type: "turn_start", id: "turn-1" },
    // W888: the head summary row carries origin: "compact" (the runtime planner
    // does too; this second implementation must track the plan shape).
    { type: "user_message", text: `${SPEC_HEAD_PREFIX}${summary}`, origin: "compact" },
    { type: "assistant_message", text: SPEC_HEAD_ASSISTANT },
    { type: "turn_end", id: "turn-1", outcome: "completed" },
  ];
}

/** The expected post-compaction log, or null when the history is too short. */
export function expectedCompactLog(
  events: readonly SessionEvent[],
  summary: string,
  keep = SPEC_KEEP,
  head = SPEC_HEAD,
): SessionEvent[] | null {
  const ranges = completeTurnRanges(events);
  if (ranges.length <= SPEC_THRESHOLD) return null;
  const tailCount = Math.max(1, Math.min(keep, ranges.length));
  const tailFrom = ranges.length - tailCount;
  // The head can never eat into the tail, and never overshoots the log.
  const headCount = Math.max(0, Math.min(head, tailFrom));
  const headRanges = ranges.slice(0, headCount);
  const dropped = ranges.slice(headCount, tailFrom);
  const tailRanges = ranges.slice(tailFrom);

  // W2018 (B1): the markers are part of the frozen plan shape now — the start
  // row is written INSIDE the atomic rewrite (so it is the FIRST row of the new
  // log) and the end row is appended after it. Written LITERALLY here, not via
  // the runtime's constructors, so this stays an independent re-derivation: a
  // change to either marker's shape or position must show up as a diff.
  const out: SessionEvent[] = [{ type: "compaction_start" }, ...summaryTurn(summary)];
  const append = (part: ReadonlyArray<[number, number]>, firstTurn: number): void => {
    part.forEach(([from, to], i) => {
      const id = `turn-${firstTurn + i}`;
      for (const ev of events.slice(from, to)) {
        if (ev.type === "turn_start") out.push({ type: "turn_start", id });
        else if (ev.type === "turn_end") out.push({ type: "turn_end", id, ...(ev.outcome === undefined ? {} : { outcome: ev.outcome }) });
        else out.push(ev);
      }
    });
  };
  append(headRanges, 2);
  if (dropped.length > 0) {
    const tokens = estimateTokens(droppedBytes(events, dropped));
    out.push({
      type: "user_message",
      text: `${SPEC_ELISION_PREFIX}此处省略了 ${dropped.length} 个完整轮（约 ${tokens} tokens）—— 这些轮的内容由本日志第 1 轮的摘要覆盖。`,
      origin: "compact",
    });
  }
  append(tailRanges, 2 + headCount);
  out.push({ type: "compaction_end" });
  return out;
}

/** The inner (non-boundary) rows of a turn: what renumbering must NOT touch. */
export function turnBody(events: readonly SessionEvent[]): SessionEvent[] {
  return events.filter((ev) => ev.type !== "turn_start" && ev.type !== "turn_end");
}

/** Split a serialized log into one entry per complete turn (raw text lines). */
export function rawTurnBodies(text: string, parse: (t: string) => { events: SessionEvent[] }): string[][] {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const events = parse(text).events;
  const bodies: string[][] = [];
  let current: string[] | null = null;
  events.forEach((ev, i) => {
    if (ev.type === "turn_start") current = [];
    else if (ev.type === "turn_end") {
      if (current !== null) bodies.push(current);
      current = null;
    } else if (current !== null) current.push(lines[i] ?? "");
  });
  return bodies;
}

/** The summary text embedded in a compacted log's head turn (null when absent). */
export function headSummary(events: readonly SessionEvent[]): string | null {
  const head = events.find((ev) => ev.type === "user_message" && ev.text.startsWith(SPEC_HEAD_PREFIX));
  return head === undefined || head.type !== "user_message" ? null : head.text.slice(SPEC_HEAD_PREFIX.length);
}
