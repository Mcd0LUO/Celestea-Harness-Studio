/**
 * Compaction planning — port of `celestea_studio/src/compact.rs:60-190`,
 * extended by W2011 (B2) to a HEAD + TAIL budget.
 *
 * The plan is a pure function of (events, summary, keep, head):
 *   1. split the log into COMPLETE turns (`turn_start ..= turn_end`); an
 *      unterminated tail and everything before the first `turn_start` are
 *      dropped — only a closed turn may enter the new log;
 *   2. refuse to compact at or below [COMPACT_THRESHOLD] complete turns;
 *   3. new log = one synthetic head turn (turn-1: the summary) + the FIRST
 *      `head` complete turns + (only when turns were dropped) one elision row +
 *      the LAST `keep` complete turns, renumbered turn-2.. but otherwise
 *      byte-identical (tool / thinking rows stay inside their turn, the outcome
 *      is preserved).
 *
 * Why a head budget (W2011 / B2): a pure tail keep of K=4 drops the session's
 * OPENING requirement — the anchor of the whole task — and leaves recent turns
 * plus a summary OF a summary. Kimi Code's compaction shape keeps both ends and
 * marks the hole in the middle (head+tail budget + an elision note saying how
 * much was dropped and that the trailing summary covers it). [COMPACT_HEAD_TURNS]
 * and [elisionEvent] port exactly that; `head = 0` reproduces the pre-W2011
 * pure-tail turn SELECTION (the elision row is still emitted — it describes what
 * was dropped, which is independent of which end was kept).
 *
 * The `turn-<n>` prefix is the engine-native turn id: `PersistentSessionLog`
 * only recognises that prefix when it restores its counter, so renumbering is
 * what keeps the next live turn id from colliding with what is on disk.
 */

import { estimateTokens } from "@celestea/agent-loop";
import type { SessionEvent } from "@celestea/core";
import { clip, SUMMARY_KEEP_MAX_CHARS } from "./transcript.js";

/** Complete turns at or below this count are "not enough history" to compact. */
export const COMPACT_THRESHOLD = 8;
/** How many most-recent complete turns survive a compaction. */
export const COMPACT_KEEP_TURNS = 4;
/**
 * How many OLDEST complete turns survive a compaction (W2011 / B2).
 *
 * 2 is deliberately small: the opening requirement is usually stated in the
 * first turn or two, while a larger head budget would eat the tail budget
 * (threshold 8 ⇒ head 2 + tail 4 = 6, so a just-compactable 9-turn log still
 * drops something). Raise it only together with [COMPACT_THRESHOLD].
 */
export const COMPACT_HEAD_TURNS = 2;
/** Head turn user message prefix (the summary is appended verbatim). */
export const COMPACT_HEAD_PREFIX = "【上下文压缩】";
/** Head turn assistant message (fixed text, not model-generated). */
export const COMPACT_HEAD_ASSISTANT = "上下文已压缩，以上为历史摘要。";
/** Elision row prefix: the turns a compaction dropped between head and tail. */
export const COMPACT_ELISION_PREFIX = "【上下文压缩·省略】";
/** Note of the "nothing to do" branch. */
export const COMPACT_NOTE_SKIPPED = "历史不足，无需压缩";

/**
 * Note of the compacted branch.
 *
 * `head` defaults to 0 so a pure-tail caller keeps the frozen pre-W2011 string
 * ("已压缩：摘要轮 + 最近4轮"); the runtime passes its real head budget so the note
 * never claims a tail-only keep while the log also carries the opening turns.
 */
export function compactNote(keep: number, head = 0): string {
  return head > 0 ? `已压缩：摘要轮 + 最早${head}轮 + 最近${keep}轮` : `已压缩：摘要轮 + 最近${keep}轮`;
}

/** Engine-native turn id (`turn-<n>`). */
export function compactTurnId(n: number): string {
  return `turn-${n}`;
}

/**
 * Cut the event stream into complete turns. A repeated/nested `turn_start`
 * discards the previous unterminated fragment; rows before the first
 * `turn_start` are dropped.
 */
export function splitCompleteTurns(events: readonly SessionEvent[]): SessionEvent[][] {
  const turns: SessionEvent[][] = [];
  let current: SessionEvent[] | null = null;
  for (const ev of events) {
    if (ev.type === "turn_start") {
      current = [ev];
      continue;
    }
    if (current === null) continue; // orphan before the first turn_start
    current.push(ev);
    if (ev.type === "turn_end") {
      turns.push(current);
      current = null;
    }
  }
  return turns;
}

/** Number of complete turns (the threshold predicate). */
export function countCompleteTurns(events: readonly SessionEvent[]): number {
  return splitCompleteTurns(events).length;
}

/**
 * Replace a turn's boundary ids with `id`; every other row is copied verbatim,
 * including the terminal outcome (renumbering is not a semantic rewrite).
 */
export function renumberTurn(turn: readonly SessionEvent[], id: string): SessionEvent[] {
  return turn.map((ev) => {
    if (ev.type === "turn_start") return { type: "turn_start", id };
    if (ev.type === "turn_end") return { type: "turn_end", id, ...(ev.outcome === undefined ? {} : { outcome: ev.outcome }) };
    return ev;
  });
}

/** The complete turns a compaction with `keep` preserves (never empty). */
export function keptTurns(events: readonly SessionEvent[], keep: number): SessionEvent[][] {
  const turns = splitCompleteTurns(events);
  const k = Math.max(1, Math.min(keep, turns.length));
  return turns.slice(turns.length - k);
}

/** One compaction's turn selection: both ends kept, the hole between them counted. */
export interface TurnSelection {
  /** The oldest `head` complete turns (empty when head+tail already covers everything). */
  head: SessionEvent[][];
  /** The newest `keep` complete turns; never empty. */
  tail: SessionEvent[][];
  /** Complete turns kept by neither budget (0 = nothing was dropped). */
  dropped: number;
  /** Token estimate of those dropped turns ([estimateTokens] over their rows). */
  droppedTokens: number;
}

/**
 * Select the surviving turns for a head+tail budget (W2011 / B2).
 *
 * The two budgets NEVER overlap — `head` is clamped to what the tail leaves
 * over — so the same turn can never be emitted twice, and the head can never
 * push the plan past the source log's turn count. The dropped slice is measured
 * with the SAME estimator the agent loop's context trim uses, so the elision
 * number is comparable to a context budget rather than an invented unit.
 */
export function selectTurns(events: readonly SessionEvent[], keep: number, head: number): TurnSelection {
  const turns = splitCompleteTurns(events);
  const tailCount = Math.max(1, Math.min(keep, turns.length));
  const tailFrom = turns.length - tailCount;
  const headCount = Math.max(0, Math.min(head, tailFrom));
  const dropped = turns.slice(headCount, tailFrom);
  return { head: turns.slice(0, headCount), tail: turns.slice(tailFrom), dropped: dropped.length, droppedTokens: estimateTokens(serializeRows(dropped)) };
}

/** The exact bytes those rows occupy in the log (the estimator's input). */
function serializeRows(turns: readonly SessionEvent[][]): string {
  let text = "";
  for (const turn of turns) for (const ev of turn) text += JSON.stringify(ev);
  return text;
}

/**
 * The row that stands in for everything a compaction dropped (W2011 / B2).
 *
 * It is an ordinary `user_message` with `origin: "compact"` — the same shape the
 * summary head row already uses, so every existing consumer (log codec, model
 * projection, inbox renderer, web client) handles it without a contract change.
 * The text states the two facts a reader needs: HOW MUCH is missing and WHERE
 * its content now lives (the summary in the first turn).
 */
export function elisionEvent(turns: number, tokens: number): Extract<SessionEvent, { type: "user_message" }> {
  return {
    type: "user_message",
    text: `${COMPACT_ELISION_PREFIX}此处省略了 ${turns} 个完整轮（约 ${tokens} tokens）—— 这些轮的内容由本日志第 1 轮的摘要覆盖。`,
    origin: "compact",
  };
}

/** The synthetic turn-1: summary row + fixed assistant row, closed as completed. */
function summaryTurn(summary: string): SessionEvent[] {
  const head = compactTurnId(1);
  return [
    { type: "turn_start", id: head },
    { type: "user_message", text: `${COMPACT_HEAD_PREFIX}${clip(summary.trim(), SUMMARY_KEEP_MAX_CHARS)}`, origin: "compact" },
    { type: "assistant_message", text: COMPACT_HEAD_ASSISTANT },
    { type: "turn_end", id: head, outcome: "completed" },
  ];
}

/**
 * The post-compaction event list, or null when the log is at/below the
 * threshold (nothing to compact). `keep` is clamped to `[1, turn count]`,
 * `head` to `[0, turn count - keep]`; `head = 0` is the pure-tail selection.
 */
export function planCompaction(
  events: readonly SessionEvent[],
  summary: string,
  keep: number,
  head: number = COMPACT_HEAD_TURNS,
): SessionEvent[] | null {
  if (countCompleteTurns(events) <= COMPACT_THRESHOLD) return null;
  const kept = selectTurns(events, keep, head);
  const out: SessionEvent[] = summaryTurn(summary);
  kept.head.forEach((turn, i) => out.push(...renumberTurn(turn, compactTurnId(i + 2))));
  if (kept.dropped > 0) out.push(elisionEvent(kept.dropped, kept.droppedTokens));
  kept.tail.forEach((turn, i) => out.push(...renumberTurn(turn, compactTurnId(i + 2 + kept.head.length))));
  return out;
}
