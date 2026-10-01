/**
 * Phase 0b — resident turn-context dedup (docs/feature-memory-extraction.md §4).
 *
 * Without this filter the runner appends the skill catalog and the memory
 * context to the log on EVERY turn (W888's origin rows), so an unchanged row
 * piles up once per turn and the resident share of the prompt grows without
 * bound (Phase 0a baseline: 3.0% → 9.9% over ten turns).
 *
 * The decision is a three-state machine, evaluated per row against the LOG:
 *
 *   1. row text differs from the last injected row of the same origin
 *      (or none exists — first turn, or compaction rewrote the log) → APPEND;
 *   2. text unchanged AND the last copy is still model-visible → SKIP;
 *   3. text unchanged but the last copy fell out of the model-visible view
 *      (trimmed, or the log no longer contains it) → RE-INJECT.
 *
 * Design decisions, and why:
 *
 *   - **State is a pure function of (log, config).** No in-memory bookkeeping:
 *     an idle-TTL eviction, a compaction rebind or a restart drops process
 *     state, but the next turn re-derives the same decision from the log.
 *   - **Visibility is SIMULATED, not reported by the loop.** The trim that
 *     removes a row runs inside the loop on the derived view (loop.ts
 *     buildRequest), invisible here. Instead of a new log event (codec +
 *     parity-fixture churn for zero decision gain) we run the SAME
 *     `trimContext` with the SAME `AgentConfig` the loop will use and ask
 *     whether the row survives the cut. The only divergence is what lands
 *     between this decision and the loop's first step (receipt drain + the
 *     user input): that can only DEEPEN the cut, so a skipped row that gets
 *     cut anyway is re-injected next turn — one-directional, self-healing.
 *   - **Duplicates resolve to the last copy.** Historical logs may hold many
 *     identical rows (that was the bug). The last derived match is the most
 *     recent surviving copy; identical copies are interchangeable, so if any
 *     copy is visible the row counts as resident.
 *
 * The filter only sees rows whose origin is "skill" | "memory" — the closed
 * `TurnContextRow` set. Receipts and human input never pass through here.
 */

import {
  isTextContent,
  type AgentConfig,
  type Message,
  type SessionEvent,
  type SessionLog,
} from "@celestea/core";
import { estimateTokens, trimContext } from "@celestea/agent-loop";

/** The row shape this filter needs (structural twin of turn-runner's TurnContextRow). */
export interface ResidentContextRow {
  readonly text: string;
  readonly origin: "skill" | "memory";
}

/**
 * Select which of the pending resident rows must be appended to the log this
 * turn. Blank rows are dropped (the old unconditional filter's contract).
 */
export function selectTurnContextRows(
  log: SessionLog,
  rows: readonly ResidentContextRow[],
  config: AgentConfig,
): ResidentContextRow[] {
  const events = log.events();
  let view: TrimmedView | null = null;
  const selected: ResidentContextRow[] = [];
  for (const row of rows) {
    if (row.text === "") continue;
    if (lastInjectedText(events, row.origin) !== row.text) {
      selected.push(row); // ① changed or never injected
      continue;
    }
    view ??= trimmedView(log, config);
    if (!isResident(view, row.text)) selected.push(row); // ③ trimmed/compacted away
    // else: ② unchanged and still model-visible — skip
  }
  return selected;
}

/** The last injected text of one origin, or undefined when never injected. */
function lastInjectedText(events: readonly SessionEvent[], origin: "skill" | "memory"): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev !== undefined && ev.type === "user_message" && ev.origin === origin) return ev.text;
  }
  return undefined;
}

/** The derived history plus how many leading non-system messages the next trim would cut. */
interface TrimmedView {
  readonly derived: readonly Message[];
  /** `trimContext`'s cut: count of leading non-system messages removed (0 = untrimmed). */
  readonly removedHead: number;
}

/** Reproduce the loop's buildRequest trim (same function, same config). */
function trimmedView(log: SessionLog, config: AgentConfig): TrimmedView {
  const derived = log.deriveMessages();
  const result = trimContext(
    derived,
    estimateTokens(config.system_prompt),
    config.context_window_tokens,
    config.context_trim_threshold,
    config.context_keep_recent,
  );
  return { derived, removedHead: result.outcome.trimmed ? result.outcome.removedMessages : 0 };
}

/**
 * Is the most recent copy of `text` still inside the post-trim history?
 * Rank is the message's index among NON-SYSTEM messages (the list the cut
 * counts); the row survives iff its rank is at or past the cut.
 */
function isResident(view: TrimmedView, text: string): boolean {
  let rank = -1;
  let position = 0;
  for (const msg of view.derived) {
    if (msg.role === "system") continue;
    if (msg.role === "user" && messageText(msg) === text) rank = position;
    position += 1;
  }
  return rank >= view.removedHead;
}

/** Concatenated text blocks of a message (injected rows never carry images). */
function messageText(msg: Message): string {
  let text = "";
  for (const block of msg.content) if (isTextContent(block)) text += block.content;
  return text;
}
