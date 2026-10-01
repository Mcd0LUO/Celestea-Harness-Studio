/**
 * W1900 (Phase 2) — the model-facing compression tools.
 *
 * What these tests hold down is the SPLIT of responsibility: the engine
 * validates, persists and projects; the model decides. So the tools must
 * (a) never silently "succeed" at a range the rules forbid, (b) never touch
 * the log, (c) report a refusal as a readable structured answer rather than a
 * stack trace, because a model that guessed a bad range should learn why and
 * retry once, and (d) be unmountable — an embedding with no live session must
 * not offer tools that could only fail.
 */

import type { CompressionBlock, CompressionHost, CompressionPort, ContextUsageFacts, SessionEvent, Tool } from "@celestea/core";
import { normalizeBlocks, overlayCompressions } from "@celestea/core";
import { describe, expect, it } from "vitest";

import { compressTool, compressionTools, contextStatusTool, decompressTool } from "./compression.js";

/** The store contract the tools use: read the blocks, write them back normalized. */
class MemoryStore {
  private current: CompressionBlock[];

  constructor(blocks: CompressionBlock[] = []) {
    this.current = blocks;
  }

  blocks(): CompressionBlock[] {
    return [...this.current];
  }

  save(next: readonly CompressionBlock[]): void {
    this.current = normalizeBlocks(next);
  }
}

function block(from: number, to: number, summary = "S"): CompressionBlock {
  return { from_turn: from, to_turn: to, summary, created_turn: to + 1, context_ratio: 0.61 };
}

/** A log with `count` finished turns, plus the store the tools write into. */
function stage(count: number, body = "work"): { events: SessionEvent[]; store: MemoryStore; currentTurn: number } {
  const events: SessionEvent[] = [];
  for (let n = 1; n <= count; n += 1) {
    events.push({ type: "turn_start", id: `turn-${n}` });
    events.push({ type: "user_message", text: `q${n} ${body}` });
    events.push({ type: "assistant_message", text: `a${n} ${body}` });
    events.push({ type: "turn_end", id: `turn-${n}`, outcome: "completed" });
  }
  return { events, store: new MemoryStore(), currentTurn: count + 1 };
}

/** A log staged turn by turn, for the tests that need GAPS in the turn numbers. */
function stagedTurns(turns: readonly number[], currentTurn: number): ReturnType<typeof stage> {
  const events: SessionEvent[] = [];
  for (const n of turns) {
    events.push({ type: "turn_start", id: `turn-${n}` });
    events.push({ type: "assistant_message", text: `a${n}` });
    events.push({ type: "turn_end", id: `turn-${n}`, outcome: "completed" });
  }
  return { events, store: new MemoryStore(), currentTurn };
}

const USAGE: ContextUsageFacts = { used: 61_000, window: 100_000, ratio: 0.61, estimated: false, method: "usage_prompt_tokens", projected: false };

/** A host over a staged log; the port re-reads the store on every call. */
function hostOf(
  staged: ReturnType<typeof stage>,
  usage: ContextUsageFacts | null = USAGE,
  blocks: CompressionBlock[] = [],
): CompressionHost & { store: MemoryStore } {
  staged.store.save(blocks);
  const port = (): CompressionPort => ({
    events: () => staged.events,
    currentTurn: () => staged.currentTurn,
    blocks: () => staged.store.blocks(),
    save: (next) => staged.store.save(next),
    usage: () => usage,
  });
  return { port, usage: () => usage, store: staged.store };
}

function call(tool: Tool, args: unknown): Promise<unknown> {
  return tool.execute(args);
}

async function out(tool: ReturnType<typeof compressTool>, args: unknown): Promise<Record<string, unknown>> {
  return (await call(tool, args)) as unknown as Record<string, unknown>;
}

/** Run and expect a structured tool failure, returning its error text. */
async function fails(tool: ReturnType<typeof compressTool>, args: unknown): Promise<string> {
  try {
    await call(tool, args);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected the tool to refuse");
}

describe("W1900 · compress writes a block and never touches the log", () => {
  it("stores the range, the summary and the water level at compression time", async () => {
    const staged = stage(5);
    const host = hostOf(staged);
    const result = await out(compressTool(host), { from_turn: 1, to_turn: 3, summary: "  the early decisions  " });

    expect(result["ok"]).toBe(true);
    expect(result["merged"]).toBe(0);
    expect(host.store.blocks()).toEqual([
      { from_turn: 1, to_turn: 3, summary: "the early decisions", created_turn: 6, context_ratio: 0.61 },
    ]);
    // The log is the truth: 20 rows before, 20 rows after.
    expect(staged.events).toHaveLength(20);
  });

  it("records ratio 0 when nothing is known yet, rather than inventing a water level", async () => {
    const staged = stage(3);
    const host = hostOf(staged, null);
    const result = await out(compressTool(host), { from_turn: 1, to_turn: 1, summary: "s" });
    expect((result["block"] as Record<string, unknown>)["context_ratio"]).toBe(0);
  });

  it("folds a range that COVERS an existing block into one summary of summaries", async () => {
    const staged = stage(6);
    const host = hostOf(staged, USAGE, [block(1, 2, "old one"), block(4, 5, "old two")]);

    const result = await out(compressTool(host), { from_turn: 1, to_turn: 5, summary: "everything early" });

    expect(result["merged"]).toBe(2);
    expect(host.store.blocks()).toHaveLength(1);
    expect(host.store.blocks()[0]?.summary).toBe("everything early");
  });

  it("keeps a block that merely OVERLAPS without being covered, and the store normalizes the rest", async () => {
    const staged = stage(6);
    const host = hostOf(staged, USAGE, [block(1, 4, "a")]);
    await out(compressTool(host), { from_turn: 3, to_turn: 6 - 1, summary: "b" });
    const ranges = host.store.blocks().map((b) => [b.from_turn, b.to_turn]);
    expect(ranges).toEqual([[1, 2], [3, 5]]);
  });
});

describe("W1900 · a refused range changes nothing and says why", () => {
  it("refuses the turn in flight, and accepts the last CLOSED turn", async () => {
    // Four finished turns, so turn 5 is the one in flight: 4 is the last
    // compressible turn and 5 is the first the engine owns.
    const staged = stage(4);
    const host = hostOf(staged);
    expect(await out(compressTool(host), { from_turn: 1, to_turn: 4, summary: "s" })).toMatchObject({ ok: true });
    expect(await out(compressTool(host), { from_turn: 1, to_turn: 5, summary: "s" })).toMatchObject({ ok: false, code: "current_turn" });
  });

  it("refuses a range reaching past the turn in flight, and past the log entirely", async () => {
    const staged = stage(4);
    const host = hostOf(staged);
    expect(await out(compressTool(host), { from_turn: 1, to_turn: 5, summary: "s" })).toMatchObject({ ok: false, code: "current_turn" });
    expect(await out(compressTool(host), { from_turn: 1, to_turn: 9, summary: "s" })).toMatchObject({ ok: false, code: "current_turn" });
    expect(host.store.blocks()).toEqual([]);
  });

  it("refuses a range reaching a turn this log has no record of", async () => {
    // The log stops at turn 3 while the host says turn 5 is in flight, so turn 4
    // is in the past AND unrecorded: a truncation, or a sidecar written beside a
    // different log. The range must not be accepted, because the overlay would
    // have to guess what turn 4 was.
    const host = hostOf(stagedTurns([1, 2, 3], 5));
    const result = await out(compressTool(host), { from_turn: 1, to_turn: 4, summary: "s" });
    expect(result).toMatchObject({ ok: false, code: "unknown_turn" });
    expect(host.store.blocks()).toEqual([]);
  });

  it("accepts a range whose END is recorded, whatever happened inside it", async () => {
    // A turn number that never happened INSIDE the range is not a problem: the
    // overlay projects the interval and there is simply nothing to show for the
    // missing turn. Only the far end is a promise about a turn's content.
    const host = hostOf(stagedTurns([1, 3], 4));
    expect(await out(compressTool(host), { from_turn: 1, to_turn: 3, summary: "s" })).toMatchObject({ ok: true });
  });

  it("refuses an inverted or non-positive range as a STRUCTURED refusal, not a throw", async () => {
    // The model gets `{ok:false, code}` for a range it got wrong, whatever the
    // mistake was, so it can read the reason and try again.
    const staged = stage(4);
    const host = hostOf(staged);
    expect(await out(compressTool(host), { from_turn: 3, to_turn: 1, summary: "s" })).toMatchObject({ ok: false, code: "inverted" });
    expect(await out(compressTool(host), { from_turn: 0, to_turn: 1, summary: "s" })).toMatchObject({ ok: false, code: "inverted" });
    expect(host.store.blocks()).toEqual([]);
  });

  it("refuses a missing or blank summary, because an empty one would lose the turns", async () => {
    const staged = stage(4);
    const host = hostOf(staged);
    expect(await fails(compressTool(host), { from_turn: 1, to_turn: 2 })).toContain("empty_summary");
    expect(await fails(compressTool(host), { from_turn: 1, to_turn: 2, summary: "   " })).toContain("empty_summary");
    expect(host.store.blocks()).toEqual([]);
  });

  it("refuses a fractional turn number", async () => {
    const staged = stage(4);
    const host = hostOf(staged);
    expect(await fails(compressTool(host), { from_turn: 1.5, to_turn: 2, summary: "s" })).toContain("must be an integer");
  });
});

describe("W1900 · decompress is the exact undo, and nothing more", () => {
  it("brings the block's turns back and reports how many", async () => {
    const staged = stage(5);
    const host = hostOf(staged, USAGE, [block(2, 4)]);
    const result = await out(decompressTool(host), { from_turn: 2, to_turn: 4 });
    expect(result).toMatchObject({ ok: true, from_turn: 2, to_turn: 4, restored_turns: 3 });
    expect(host.store.blocks()).toEqual([]);
  });

  it("requires an EXACT range: a superset or a subset matches nothing", async () => {
    const staged = stage(5);
    const host = hostOf(staged, USAGE, [block(2, 4)]);
    expect(await out(decompressTool(host), { from_turn: 1, to_turn: 4 })).toMatchObject({ ok: false, code: "no_such_block" });
    expect(await out(decompressTool(host), { from_turn: 2, to_turn: 5 })).toMatchObject({ ok: false, code: "no_such_block" });
    expect(host.store.blocks()).toHaveLength(1);
  });

  it("actually restores the view (the round trip is the promise)", async () => {
    const staged = stage(5);
    const host = hostOf(staged, USAGE, [block(2, 4)]);
    const before = overlayCompressions(staged.events, host.store.blocks()).length;
    expect(before).toBeLessThan(10);

    await call(decompressTool(host), { from_turn: 2, to_turn: 4 });
    expect(overlayCompressions(staged.events, host.store.blocks())).toHaveLength(10);
  });
});

describe("W1900 · context_status is read-only and quotes the same number as the statusline", () => {
  it("reports the water level, the turns and the blocks", async () => {
    const staged = stage(4);
    const summary = "a longer summary than the other one";
    const host = hostOf(staged, USAGE, [block(1, 2, summary)]);
    const result = await out(contextStatusTool(host), {});

    expect(result["context"]).toEqual(USAGE);
    expect(result["turn"]).toEqual({ current: 5, turns: [1, 2, 3, 4] });
    expect(result["current_turn"]).toBe(5);
    expect(result["blocks"]).toEqual([
      { from_turn: 1, to_turn: 2, created_turn: 3, context_ratio: 0.61, summary_chars: summary.length },
    ]);
    // Read-only.
    expect(host.store.blocks()).toHaveLength(1);
  });

  it("says 'none' instead of pretending the context is empty before anything ran", async () => {
    const staged = stage(2);
    const host = hostOf(staged, null);
    const result = await out(contextStatusTool(host), {});
    expect(result["context"]).toEqual({
      used: 0, window: 0, ratio: 0, estimated: true, method: "none", projected: false,
    });
  });
});

describe("W1900 · the trio is unmountable when no session is bound", () => {
  it("refuses every call with no_session instead of pretending to compress", async () => {
    const host: CompressionHost = { port: () => null, usage: () => null };
    expect(await fails(compressTool(host), { from_turn: 1, to_turn: 1, summary: "s" })).toContain("no_session");
    expect(await fails(decompressTool(host), { from_turn: 1, to_turn: 1 })).toContain("no_session");
    expect(await fails(contextStatusTool(host), {})).toContain("no_session");
  });

  it("mounts the three, in contract order", () => {
    const host = hostOf(stage(2));
    expect(compressionTools(host).map((t) => t.spec().name)).toEqual(["compress", "decompress", "context_status"]);
  });
});

describe("W1900 · the specs are what the contract promises", () => {
  it("requires exactly the turn range and the summary", () => {
    const params = compressTool(hostOf(stage(2))).spec().parameters as {
      required: string[];
      properties: Record<string, { type: string }>;
    };
    expect(params.required).toEqual(["from_turn", "to_turn", "summary"]);
    expect(params.properties["from_turn"]?.type).toBe("integer");
    expect(params.properties["to_turn"]?.type).toBe("integer");
  });

  it("takes no arguments at all for context_status", () => {
    const params = contextStatusTool(hostOf(stage(2))).spec().parameters as { required?: string[]; properties: Record<string, unknown> };
    expect(params.required).toBeUndefined();
    expect(Object.keys(params.properties)).toEqual(["desc"]);
  });
});

