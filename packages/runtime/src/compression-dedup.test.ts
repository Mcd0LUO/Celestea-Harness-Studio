/**
 * W1900 (Phase 2) — compression OVERLAPPING the 0b resident-row dedup.
 *
 * The two features meet in exactly one place, and it is the reason the overlay
 * was placed inside the `deriveMessages()` seam rather than beside it: the dedup
 * state machine decides "is this resident row still model-visible?" by running
 * the loop's OWN trim over `log.deriveMessages()`
 * (turn-context-dedup.ts:98 trimmedView). So a resident row that a compression
 * block swallowed stops being visible — not because it was trimmed, but because
 * the view no longer renders it — and state ③ has to notice and re-inject.
 *
 * The one-directional safety declared at turn-context-dedup.ts:28-30 is what
 * makes this safe: the simulation can only ever cut DEEPER than the real loop
 * (receipts and the user input land between the decision and the first step), so
 * a row the simulation still calls visible may in truth be gone, and it gets
 * re-injected next turn. Compression cannot break that, because it only ever
 * makes a row LESS visible — it never makes an invisible row visible. That is
 * the property these tests exist to hold down, together with the second half of
 * the promise: a re-injected row must land ONCE, not once per turn forever.
 *
 * Every fixture here turns trimming OFF (a window no request can exceed), so the
 * ONLY thing that can make a row invisible is the compression overlay. A test
 * that passed because trimContext happened to cut would prove nothing about
 * the interaction.
 */

import { defaultAgentConfig, type AgentConfig, type CompressionBlock, type SessionEvent, type SessionLog } from "@celestea/core";
import { InMemorySessionLog, MemoryCompressionStore, compressedLog } from "@celestea/session";
import { describe, expect, it } from "vitest";

import { selectTurnContextRows, type ResidentContextRow } from "./turn-context-dedup.js";

const SKILL: ResidentContextRow = { text: "SKILL-CATALOG-V1", origin: "skill" };

/** Trimming disabled: only the overlay can make a row invisible here. */
function config(): AgentConfig {
  return { ...defaultAgentConfig(), system_prompt: "", context_window_tokens: 0 };
}

function block(from: number, to: number, summary = "folded"): CompressionBlock {
  return { from_turn: from, to_turn: to, summary, created_turn: to + 1, context_ratio: 0.6 };
}

/** Append a row exactly the way TurnRunner.injectTurnContext does. */
function inject(log: SessionLog, row: ResidentContextRow): void {
  log.append({ type: "user_message", text: row.text, origin: row.origin });
}

function textsOf(log: SessionLog): string[] {
  return log.deriveMessages().map((message) => {
    let out = "";
    for (const part of message.content) if (part.type === "text") out += part.content;
    return out;
  });
}

function turnEvents(n: number): SessionEvent[] {
  return [
    { type: "turn_start", id: `turn-${n}` },
    { type: "user_message", text: `human turn ${n}` },
    { type: "assistant_message", text: `answer turn ${n}` },
    { type: "turn_end", id: `turn-${n}`, outcome: "completed" },
  ];
}

function fill(log: SessionLog, count: number): void {
  for (let n = 1; n <= count; n += 1) for (const event of turnEvents(n)) log.append(event);
}

/**
 * `count` clean turns, with the resident row injected INSIDE the first one, so
 * a block covering turns 1..n really does swallow it. (Injecting after the last
 * turn would put the row outside every block and the test would prove nothing.)
 */
function residentLog(count: number): InMemorySessionLog {
  const log = InMemorySessionLog.create();
  log.append({ type: "turn_start", id: "turn-1" });
  inject(log, SKILL);
  log.append({ type: "assistant_message", text: "answer turn 1" });
  log.append({ type: "turn_end", id: "turn-1", outcome: "completed" });
  for (let n = 2; n <= count; n += 1) for (const event of turnEvents(n)) log.append(event);
  return log;
}

describe("W1900 · a swallowed resident row is invisible, so ③ re-injects it", () => {
  it("state ② holds while the row is rendered, and ③ fires the moment a block covers it", () => {
    const log = InMemorySessionLog.create();
    // The resident row is injected at the head of turn 1, so the block below
    // really does swallow it.
    log.append({ type: "turn_start", id: "turn-1" });
    inject(log, SKILL);
    log.append({ type: "assistant_message", text: "answer turn 1" });
    log.append({ type: "turn_end", id: "turn-1", outcome: "completed" });
    fill(log, 3); // turns 2 and 3 (turn-1 is already half-written, so start at 2)
    const store = new MemoryCompressionStore();

    const open = compressedLog(log, store);
    expect(textsOf(open).some((t) => t.includes(SKILL.text))).toBe(true);
    expect(selectTurnContextRows(open, [SKILL], config())).toEqual([]);

    // The model compresses turns 1..3. The row is still IN THE LOG.
    store.save([block(1, 3, "early work")]);
    const folded = compressedLog(log, store);
    expect(textsOf(folded).some((t) => t.includes(SKILL.text))).toBe(false);
    expect(folded.events().some((ev) => ev.type === "user_message" && ev.origin === "skill")).toBe(true);

    // ③ — invisible in the view, still in the log: re-inject.
    expect(selectTurnContextRows(folded, [SKILL], config())).toEqual([SKILL]);
  });

  it("re-injects ONCE: the fresh copy is visible again, so the next turn skips", () => {
    const log = residentLog(3);
    const store = new MemoryCompressionStore([block(1, 3, "early work")]);
    const folded = compressedLog(log, store);

    // ③ — the row is inside the folded range, so it has to come back.
    expect(textsOf(folded).some((t) => t.includes(SKILL.text))).toBe(false);
    expect(selectTurnContextRows(folded, [SKILL], config())).toEqual([SKILL]);

    // The runner appends it during the NEXT turn, which is outside every block,
    // so the new copy is model-visible again.
    for (const event of turnEvents(4)) log.append(event);
    inject(log, SKILL);
    const after = compressedLog(log, store);
    expect(textsOf(after).some((t) => t.includes(SKILL.text))).toBe(true);

    // ② again — otherwise the row would grow once per turn forever, which is
    // exactly the pile-up Phase 0b was written to stop.
    expect(selectTurnContextRows(after, [SKILL], config())).toEqual([]);
    const copies = log.events().filter((ev) => ev.type === "user_message" && ev.origin === "skill");
    expect(copies).toHaveLength(2);
  });

  it("never hides a row appended after the last block (the turn in flight)", () => {
    // The engine refuses to compress the turn in flight, so the newest rows are
    // always outside every block: ③ fires only for rows an already-closed
    // range swallowed, never for a row this turn just injected.
    const log = InMemorySessionLog.create();
    fill(log, 4);
    const store = new MemoryCompressionStore([block(1, 3, "early")]);
    for (const event of turnEvents(5)) log.append(event);
    inject(log, SKILL);
    const after = compressedLog(log, store);

    expect(textsOf(after).some((t) => t.includes(SKILL.text))).toBe(true);
    expect(selectTurnContextRows(after, [SKILL], config())).toEqual([]);
  });

  it("compression makes a row invisible and never the reverse (one-directional safety)", () => {
    // The safety the dedup module declares (turn-context-dedup.ts:28-30) rests
    // on the overlay only ever REMOVING visibility. Folding a range can make a
    // resident row disappear from the view; decompressing the same range brings
    // the ORIGINAL row back, which is ② again (visible, unchanged, skip) — it
    // never produces a decision the pre-Phase-2 code could not have made.
    const log = residentLog(3);
    const store = new MemoryCompressionStore();
    const open = compressedLog(log, store);
    expect(selectTurnContextRows(open, [SKILL], config())).toEqual([]);

    store.save([block(1, 3, "early")]);
    expect(selectTurnContextRows(compressedLog(log, store), [SKILL], config())).toEqual([SKILL]);

    store.save([]);
    expect(selectTurnContextRows(compressedLog(log, store), [SKILL], config())).toEqual([]);
  });
});
