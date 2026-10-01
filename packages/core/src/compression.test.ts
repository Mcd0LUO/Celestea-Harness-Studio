/**
 * W1900 (Phase 2) — the compression core: the overlay, the range rules and the
 * two thresholds the prompt quotes.
 *
 * These tests pin the properties the design's two invariants depend on, and
 * nothing about storage or tools (those live next door and are tested there):
 *
 *   1. **The log is the truth** — a block changes only what `deriveMessages`
 *      returns; `events()` comes back byte-for-byte, so extraction, replay and
 *      the audit still see every original row.
 *   2. **A turn is the atom** — a range is a turn-number interval, the engine
 *      refuses any range reaching the turn in flight, and re-compressing a range
 *      that covers a block merges into a single summary of summaries.
 */

import { describe, expect, it } from "vitest";

import {
  blockText,
  COMPRESSION_NUDGE_RATIO,
  COMPRESSION_PREFLIGHT_RATIO,
  COMPRESSION_PHILOSOPHY,
  contextRatioFacts,
  isValidRange,
  mergedBlockCount,
  normalizeBlocks,
  overlayCompressions,
  turnNumbersOf,
  validateRange,
  withCompressionPhilosophy,
  type CompressionBlock,
} from "./index.js";
import type { Message, SessionEvent } from "./index.js";

/** One turn: a start, a question, an answer, an end. */
function turn(n: number, text: string): SessionEvent[] {
  return [
    { type: "turn_start", id: `turn-${n}` },
    { type: "user_message", text: `q${n} ${text}` },
    { type: "assistant_message", text: `a${n} ${text}` },
    { type: "turn_end", id: `turn-${n}`, outcome: "completed" },
  ];
}

/** A log of `count` turns, each saying `body`. */
function turns(count: number, body = "hello"): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (let n = 1; n <= count; n += 1) events.push(...turn(n, body));
  return events;
}

function block(from: number, to: number, summary = "S"): CompressionBlock {
  return { from_turn: from, to_turn: to, summary, created_turn: to + 1, context_ratio: 0.5 };
}

/** The turn numbers an interval covers, ascending. */
function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function texts(messages: readonly Message[]): string[] {
  const out: string[] = [];
  for (const message of messages) {
    let text = "";
    for (const part of message.content) if (part.type === "text") text += part.content;
    out.push(text);
  }
  return out;
}

describe("W1900 · overlayCompressions (the view changes, the log does not)", () => {
  it("replaces a covered turn range with ONE summary block message", () => {
    const events = turns(5, "cold");
    const view = overlayCompressions(events, [block(2, 4, "everything about turns 2-4")]);

    expect(texts(view)).toEqual([
      "q1 cold",
      "a1 cold",
      blockText(block(2, 4, "everything about turns 2-4")),
      "q5 cold",
      "a5 cold",
    ]);
    // The block is the model's own user-role row: a summary, not a fake turn.
    const middle = view[2];
    expect(middle?.role).toBe("user");
    expect(middle?.tool_call_id).toBeNull();
  });

  it("leaves events() untouched — hide-consumed, not delete", () => {
    const events = turns(4, "hidden");
    const before = JSON.stringify(events);

    const view = overlayCompressions(events, [block(1, 3, "one summary")]);

    expect(JSON.stringify(events)).toBe(before);
    expect(events).toHaveLength(16);
    // ...and the covered text really is gone from the VIEW only.
    expect(texts(view).some((t) => t.startsWith("q1 hidden") || t.startsWith("a3 hidden"))).toBe(false);
    // The turns OUTSIDE the range still read normally, which is what proves the
    // block hid a RANGE rather than truncating the log.
    expect(texts(view)).toContain("q4 hidden");
  });

  it("is a pure function of (events, blocks): no mutation, same answer twice", () => {
    const events = turns(4);
    const blocks = [block(1, 2)];
    const snapshot = JSON.stringify(events);

    const first = overlayCompressions(events, blocks);
    const second = overlayCompressions(events, blocks);

    expect(texts(first)).toEqual(texts(second));
    expect(JSON.stringify(events)).toBe(snapshot);
    expect(blocks[0]?.to_turn).toBe(2);
  });

  it("is the identity projection when nothing is compressed", () => {
    const events = turns(3);
    const plain = texts(overlayCompressions(events, []));
    expect(plain).toEqual(["q1 hello", "a1 hello", "q2 hello", "a2 hello", "q3 hello", "a3 hello"]);
    expect(texts(overlayCompressions(events, []))).toEqual(plain);
  });

  it("projects a block whose turns the log never had as a NO-OP, not a wipe", () => {
    // A sidecar replayed into a shorter session, or hand-edited. The view must
    // not lose the conversation it is currently in the middle of.
    const events = turns(3);
    expect(texts(overlayCompressions(events, [block(7, 9, "stale")]))).toEqual(
      texts(overlayCompressions(events, [])),
    );
    // ...while a block over-claiming past the END of the log covers up to it —
    // there is no later turn it could be stealing.
    expect(texts(overlayCompressions(events, [block(2, 99, "tail to the end")]))).toEqual([
      "q1 hello",
      "a1 hello",
      blockText(block(2, 99, "tail to the end")),
    ]);
  });

  it("stops a block at the next REAL turn boundary when its to_turn is missing", () => {
    // The log has a gap (turns 1,2,4,5 — 3 never happened) and a stale sidecar
    // claims 1..3. W1900 read the missing end as "cover to the end of the log",
    // which hid turns 4 AND 5 — the most recent history, and the turn in
    // flight — behind a summary that was never about them. A block may only
    // cover what it can have meant, so it stops at turn 4.
    const events = [...turn(1, "one"), ...turn(2, "two"), ...turn(4, "four"), ...turn(5, "five")];
    expect(texts(overlayCompressions(events, [block(1, 3, "stale")]))).toEqual([
      blockText(block(1, 3, "stale")),
      "q4 four",
      "a4 four",
      "q5 five",
      "a5 five",
    ]);
  });

  it("keeps the turns AFTER the block verbatim, in log order", () => {
    const view = overlayCompressions(turns(6, "tail"), [block(1, 2, "S")]);
    expect(texts(view)).toEqual([
      blockText(block(1, 2, "S")),
      "q3 tail", "a3 tail", "q4 tail", "a4 tail", "q5 tail", "a5 tail", "q6 tail", "a6 tail",
    ]);
  });

  it("balances a tool call the cut would otherwise strand (protocol validity)", () => {
    // The call is in turn 1, its result in turn 2. Compressing turn 1 alone is
    // impossible (a range is turn-aligned), so compress BOTH: the pair goes
    // into the summary together and never straddles the cut.
    const events: SessionEvent[] = [
      { type: "turn_start", id: "turn-1" },
      { type: "user_message", text: "q1 hello" },
      { type: "assistant_message", text: "a1 hello" },
      { type: "tool_call", id: "c1", name: "read_file", args: { path: "a" } },
      { type: "turn_end", id: "turn-1", outcome: "completed" },
      { type: "turn_start", id: "turn-2" },
      { type: "tool_result", id: "c1", value: "body", error: null },
      { type: "turn_end", id: "turn-2", outcome: "completed" },
    ];
    const view = overlayCompressions(events, [block(1, 2, "read a.ts")]);
    expect(texts(view)).toEqual([blockText(block(1, 2, "read a.ts"))]);
    // Nothing dangling survives: every tool message has a call before it.
    const calls = view.filter((m) => m.role === "assistant").length;
    const tools = view.filter((m) => m.role === "tool").length;
    expect(tools).toBeLessThanOrEqual(calls);
  });
});

describe("W1900 · range rules (a turn is the atom)", () => {
  it("accepts a whole past turn range", () => {
    expect(validateRange(turns(5), { from: 1, to: 3 }, 6)).toBeNull();
  });

  it("refuses any range that reaches the turn in flight", () => {
    const events = turns(5);
    expect(validateRange(events, { from: 1, to: 4 }, 5)).toBeNull();
    // The current turn itself: to_turn === current is already too far.
    expect(validateRange(events, { from: 1, to: 5 }, 5)).toBe("current_turn");
    expect(validateRange(events, { from: 5, to: 5 }, 5)).toBe("current_turn");
    expect(validateRange(events, { from: 3, to: 9 }, 5)).toBe("current_turn");
  });

  it("refuses a turn the log never had", () => {
    const events = turns(3);
    expect(validateRange(events, { from: 1, to: 3 }, 3)).toBe("current_turn");
    expect(validateRange(events, { from: 1, to: 3 }, 9)).toBeNull();
    // Turn 7 does not exist even though the current turn counter says 9.
    expect(validateRange(events, { from: 4, to: 7 }, 9)).toBe("unknown_turn");
  });

  it("refuses an inverted or non-integer range", () => {
    expect(isValidRange({ from: 3, to: 2 })).toBe(false);
    // NEGATIVE is what a missing/blank argument degrades to: still refused.
    expect(isValidRange({ from: -1, to: 1 })).toBe(false);
    // ...but 0 is not an error: it is the session's FIRST turn (see the
    // turn-numbering test below). W1900 refused it, which put turn-0 out of
    // reach for the whole life of every session.
    expect(isValidRange({ from: 0, to: 1 })).toBe(true);
    expect(isValidRange({ from: 1.5, to: 2 })).toBe(false);
    expect(isValidRange({ from: 2, to: 2 })).toBe(true);
    expect(validateRange(turns(3), { from: 3, to: 1 }, 4)).toBe("inverted");
    expect(validateRange([...turn(0, "zero"), ...turn(1, "one")], { from: 0, to: 0 }, 2)).toBeNull();
  });

  it("refuses a turn number that sits in a GAP, instead of covering past it", () => {
    // A log of turns 0 and 2 (turn 1 never happened: a crash, a partial
    // replay). W1900 only asked `maxTurnNumber(events) < to_turn`, so 0..1
    // passed and the overlay then covered up to the end of the log — hiding
    // turn 2, the newest thing the model had. A gap is a legal log shape, so
    // the refusal has to happen HERE, where the model is told the reason.
    const events = [...turn(0, "zero"), ...turn(2, "two")];
    expect(validateRange(events, { from: 0, to: 1 }, 3)).toBe("unknown_turn");
    expect(validateRange(events, { from: 0, to: 2 }, 3)).toBeNull();
  });

  it("reads turn 0 as the FIRST turn of the session, with no offset anywhere", () => {
    // The numbering the tools, the sidecar and context_status all share: the
    // log's own id. `nextTurnNumber([]) === 0`, so turn-0 is the first turn.
    expect(turnNumbersOf(turns(3))).toEqual([1, 2, 3]);
    const fromZero = [...turn(0, "zero"), ...turn(1, "one"), ...turn(2, "two")];
    expect(turnNumbersOf(fromZero)).toEqual([0, 1, 2]);
    // The first turn is a legal TARGET, not just a legal number.
    expect(validateRange(fromZero, { from: 0, to: 1 }, 3)).toBeNull();
  });

  it("reads turn numbers off the log, ignoring ids it does not own", () => {
    const events: SessionEvent[] = [
      { type: "turn_start", id: "turn-2" },
      { type: "user_message", text: "x" },
      { type: "turn_start", id: "legacy-t1" },
      { type: "turn_start", id: "turn-1" },
    ];
    expect(turnNumbersOf(events)).toEqual([1, 2]);
    expect(turnNumbersOf([])).toEqual([]);
  });
});

describe("W1900 · nested ranges merge (a summary of summaries)", () => {
  it("folds a covering block into the newer one, keeping the newest text", () => {
    const blocks = [block(2, 4, "old summary"), block(1, 6, "summary of summaries")];
    const normalized = normalizeBlocks(blocks);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.summary).toBe("summary of summaries");
    expect(mergedBlockCount(blocks)).toBe(1);
  });

  it("never mutates the caller's blocks", () => {
    const blocks = [block(2, 4, "old")];
    normalizeBlocks([...blocks, block(1, 6, "new")]);
    expect(blocks[0]?.to_turn).toBe(4);
  });

  it("keeps disjoint ranges side by side, sorted", () => {
    const normalized = normalizeBlocks([block(7, 9, "late"), block(1, 2, "early")]);
    expect(normalized.map((b) => [b.from_turn, b.to_turn])).toEqual([[1, 2], [7, 9]]);
  });

  it("splits the older block when a later range merely OVERLAPS it", () => {
    // Turn 4 is claimed by the newer block, so the older one keeps 1-3 and
    // 7-9 — dropping either tail would leave those turns invisible FOREVER,
    // because the overlay is the only thing that renders them.
    const normalized = normalizeBlocks([block(1, 6, "older"), block(4, 9, "newer")]);
    expect(normalized.map((b) => [b.from_turn, b.to_turn])).toEqual([[1, 3], [4, 9]]);
    // Every block is still a real interval, and together they cover 1..9 exactly.
    const covered = normalized.map((b) => [b.from_turn, b.to_turn]);
    expect(covered.every(([from, to]) => (to as number) >= (from as number))).toBe(true);
    expect(covered.flatMap(([from, to]) => range(from as number, to as number))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("keeps the older block's text on BOTH sides of a partial overlap", () => {
    const normalized = normalizeBlocks([block(1, 6, "older"), block(4, 9, "newer")]);
    expect(normalized.filter((b) => b.summary === "older").map((b) => [b.from_turn, b.to_turn])).toEqual([[1, 3]]);
    expect(normalized.filter((b) => b.summary === "newer").map((b) => [b.from_turn, b.to_turn])).toEqual([[4, 9]]);
  });

  it("drops the zero-length sliver an edge-to-edge overlap would leave", () => {
    const normalized = normalizeBlocks([block(1, 3, "a"), block(1, 4, "b")]);
    expect(normalized.map((b) => [b.from_turn, b.to_turn])).toEqual([[1, 4]]);
  });

  it("renders the merged view as ONE block, not two stacked ones", () => {
    const view = overlayCompressions(turns(8), [block(2, 4, "inner"), block(1, 6, "outer")]);
    const summaries = texts(view).filter((t) => t.includes("[compressed turns"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain("outer");
  });

  it("counts a re-compression as merging the blocks it absorbed", () => {
    // mergedBlockCount is what the tool reports back to the model, so the
    // number must be the drop in block count, not the number of covered turns.
    expect(mergedBlockCount([block(1, 3), block(1, 3)])).toBe(1);
    expect(mergedBlockCount([block(1, 3), block(5, 7)])).toBe(0);
  });
});

describe("W1900 · the block header is a stable citation handle", () => {
  it("names the range, the turn count and the creating turn", () => {
    const text = blockText(block(3, 9, "what happened"));
    expect(text.startsWith("[compressed turns 3-9]")).toBe(true);
    expect(text).toContain("7 earlier turn(s)");
    expect(text).toContain("written at turn 10");
    expect(text.endsWith("what happened")).toBe(true);
  });
});

describe("W1900 · thresholds and the water-level arithmetic", () => {
  it("keeps the two thresholds distinct and inside the window", () => {
    expect(COMPRESSION_NUDGE_RATIO).toBe(0.5);
    expect(COMPRESSION_PREFLIGHT_RATIO).toBe(0.8);
    expect(COMPRESSION_PREFLIGHT_RATIO).toBeGreaterThan(COMPRESSION_NUDGE_RATIO);
  });

  it("prefers the provider's real prompt size, then the assembly estimate", () => {
    expect(contextRatioFacts({ promptTokens: 90, assembledTokens: 10, window: 100 })).toEqual({
      used: 90,
      window: 100,
      ratio: 0.9,
      estimated: false,
      method: "usage_prompt_tokens",
      projected: false,
    });
    expect(contextRatioFacts({ promptTokens: 0, assembledTokens: 40, window: 100 })).toEqual({
      used: 40,
      window: 100,
      ratio: 0.4,
      estimated: true,
      method: "assembled_estimate",
      projected: false,
    });
    expect(contextRatioFacts({ promptTokens: 0, assembledTokens: null, window: 100 }).method).toBe("none");
  });

  it("clamps the ratio into 0..1 and reports 0 without a window", () => {
    expect(contextRatioFacts({ promptTokens: 500, assembledTokens: null, window: 100 }).ratio).toBe(1);
    expect(contextRatioFacts({ promptTokens: 50, assembledTokens: null, window: 0 }).ratio).toBe(0);
  });
});

describe("W1900 · the philosophy merge is idempotent and append-only", () => {
  it("keeps the profile prompt first and adds the philosophy after it", () => {
    const merged = withCompressionPhilosophy("You are celestea.");
    expect(merged.startsWith("You are celestea.")).toBe(true);
    expect(merged).toContain(COMPRESSION_PHILOSOPHY);
  });

  it("never double-appends (a second call is a no-op, so the cache key holds)", () => {
    const once = withCompressionPhilosophy("You are celestea.");
    expect(withCompressionPhilosophy(once)).toBe(once);
  });

  it("still rides along with a user-supplied prompt instead of replacing it", () => {
    const merged = withCompressionPhilosophy("USER OVERRIDE");
    expect(merged.startsWith("USER OVERRIDE")).toBe(true);
    expect(merged).toContain("Compression is a TOOL, not an obligation.");
  });
});
