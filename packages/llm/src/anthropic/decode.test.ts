/**
 * W2068 — the anthropic decoder, run against RECORDED frames.
 *
 * Same discipline as the responses tests: the assertions are statements about
 * bytes a live provider sent ("fixtures/anthropic/recorded-*.sse", redacted
 * recordings), so an upstream protocol change turns into a red test here.
 *
 * What the recordings pin, in order of how badly a decoder gets it wrong:
 *
 *   1. Usage arrives in TWO frames and must be merged. Taking one alone reports
 *      a turn that spent real prompt tokens and zero completion.
 *   2. A tool call is keyed by content-block INDEX; its argument deltas carry
 *      no id at all.
 *   3. The first argument fragment is a brace, not an empty string (the
 *      opposite of the responses endpoint).
 *   4. Reasoning and text are distinct delta types and must not be merged.
 *
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import type http from "node:http";
import { describe, expect, it } from "vitest";

import { anthropicEvents, mergedUsage, parseAnthropicArguments, parseAnthropicFrame, parseAnthropicUsage } from "./decode.js";
import type { StreamEvent } from "../seam.js";

const FIXTURES = join(__dirname, "..", "..", "..", "..", "fixtures", "anthropic");

function* chunked(bytes: Buffer, size: number): Generator<Buffer> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

/** A recorded body as a response. CHUNKED on purpose. */
function recorded(name: string): http.IncomingMessage {
  const bytes = readFileSync(join(FIXTURES, name));
  const stream = Readable.from(chunked(bytes, 89));
  return Object.assign(stream, { statusCode: 200, headers: {} }) as unknown as http.IncomingMessage;
}

async function eventsOf(name: string): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of anthropicEvents(recorded(name), null)) out.push(event);
  return out;
}

const joined = (events: StreamEvent[], kind: string): string =>
  events.filter((e) => e.kind === kind).map((e) => (e as { text: string }).text).join("");
const textOf = (events: StreamEvent[]): string => joined(events, "text");
const thinkingOf = (events: StreamEvent[]): string => joined(events, "thinking");
/**
 * The usage frame a decode emitted — it rides just before the terminal event,
 * the same contract `stream.ts` follows, which is how the ledger and the
 * statusline observe it.
 */
function usageOf(events: StreamEvent[]): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  const usage = events.find((e) => e.kind === "usage");
  if (usage === undefined || usage.kind !== "usage") throw new Error("the stream carried no usage frame");
  return usage.usage;
}

/** The first `data:` payload of the named SSE event in a recording. */
function firstData(raw: string, event: string): string {
  const at = raw.indexOf("event: " + event);
  const seg = raw.slice(at);
  const line = seg.slice(seg.indexOf("data: ") + 6);
  const end = line.indexOf(String.fromCharCode(10));
  return end < 0 ? line : line.slice(0, end);
}

describe("W2068 — anthropic decoding over recorded frames", () => {
  it("1: a text turn ends on message_stop, and the two usage frames are MERGED", async () => {
    const events = await eventsOf("recorded-text.sse");
    expect(events.some((e) => e.kind === "interrupted")).toBe(false);
    expect(events.at(-1)?.kind).toBe("done");

    const raw = readFileSync(join(FIXTURES, "recorded-text.sse"), "utf8");
    const start = parseAnthropicFrame(firstData(raw, "message_start"));
    const delta = parseAnthropicFrame(firstData(raw, "message_delta"));
    expect(start?.type).toBe("usage");
    expect(delta?.type).toBe("usage");
    if (start?.type === "usage" && delta?.type === "usage") {
      expect(start.final).toBe(false);
      expect(delta.final).toBe(true);
      // The premise: start has input and NO output; delta carries the output.
      expect(start.usage.prompt_tokens).toBeGreaterThan(0);
      expect(start.usage.completion_tokens).toBe(0);
      expect(delta.usage.completion_tokens).toBeGreaterThan(0);
    }
  });

  it("1: the turn's usage is BOTH halves — this is the assertion a dropped merge kills", async () => {
    // `mergedUsage` is unit-tested above, but a decoder can still call it with
    // only ONE of the two halves populated and every other test stays green —
    // which is exactly the mutation that was tried here. So the merged result has
    // to be read back off a REAL decode.
    const usage = usageOf(await eventsOf("recorded-text.sse"));
    // The recording: input came in message_start (output_tokens: 0), output in
    // message_delta. A decoder that keeps one half reports the other as 0.
    expect(usage.prompt_tokens).toBeGreaterThan(0);
    expect(usage.completion_tokens).toBeGreaterThan(0);
    expect(usage.total_tokens).toBe(usage.prompt_tokens + usage.completion_tokens);
  });

  it("4: reasoning and text stay separate events", async () => {
    const events = await eventsOf("recorded-text.sse");
    expect(thinkingOf(events).length).toBeGreaterThan(0);
    expect(textOf(events).length).toBeGreaterThan(0);
    expect(textOf(events)).not.toContain(thinkingOf(events).slice(0, 40));
  });

  it("2+3: a tool call keys by block index; the first argument fragment is a brace", async () => {
    const events = await eventsOf("recorded-tools.sse");
    const last = events.at(-1);
    if (last === undefined || last.kind !== "done") {
      throw new Error("expected done, got " + String(last?.kind));
    }
    const calls = last.message.content.filter((c) => c.type === "tool_call");
    expect(calls).toHaveLength(1);
    const call = calls[0] as { content: { id: string; name: string; args: unknown } };
    expect(call.content.name).toBe("get_weather");
    expect(call.content.id).toMatch(/^call_/);
    // (3) the first fragment here is '{', so the arguments must be REAL JSON.
    expect(call.content.args).toEqual({ city: "Beijing" });
  });

  it("a body cut before message_stop is interrupted, never a fake done", async () => {
    const raw = readFileSync(join(FIXTURES, "recorded-text.sse"), "utf8");
    const cut = raw.slice(0, raw.indexOf("event: message_stop"));
    const stream = Readable.from(chunked(Buffer.from(cut, "utf8"), 89));
    const out: StreamEvent[] = [];
    for await (const e of anthropicEvents(Object.assign(stream, { statusCode: 200 }) as unknown as http.IncomingMessage, null)) out.push(e);
    expect(out.at(-1)?.kind).toBe("interrupted");
  });
});
describe("W2068 — parseAnthropicFrame", () => {
  it("maps the recorded types; unknown ones are skipped, not failed", () => {
    expect(parseAnthropicFrame("not json")).toBeUndefined();
    expect(parseAnthropicFrame("{}")?.type).toBe("unknown");
    expect(parseAnthropicFrame(JSON.stringify({ type: "brand_new" }))?.type).toBe("unknown");
    expect(parseAnthropicFrame(JSON.stringify({ type: "ping" }))?.type).toBe("lifecycle");
  });

  it("a non-tool_use block start is lifecycle, never a call", () => {
    const frame = parseAnthropicFrame(JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }));
    expect(frame?.type).toBe("lifecycle");
  });

  it("an input_json_delta carries the index and the RAW fragment", () => {
    // The fragment is a single brace — the measured first piece on this protocol.
    const frame = parseAnthropicFrame(
      JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{" } }),
    );
    expect(frame).toEqual({ type: "call-delta", index: 1, delta: "{" });
  });
});

describe("W2068 — mergedUsage (the two-frame merge, on its own)", () => {
  it("combines input-only + output-only into counters no single frame carries", () => {
    // This is the assertion a dropped merge turns red. The per-frame tests pass
    // either way, because both frames parse correctly on their own — a decoder
    // that never combines them reports a turn that spent real prompt tokens and
    // zero completion (or the reverse), and nothing else notices.
    expect(mergedUsage(39, 181, 7)).toEqual({
      prompt_tokens: 39,
      completion_tokens: 181,
      total_tokens: 220,
      cache_read: 7,
      reasoning_tokens: 0,
    });
  });

  it("an unmerged decode (input only) reports a visibly wrong total", () => {
    // The failure shape a mutation produces, asserted so the intent is on record:
    // completion 0 against real input is not a number any real turn produces.
    expect(mergedUsage(39, 0, 0).completion_tokens).toBe(0);
    expect(mergedUsage(39, 0, 0).total_tokens).toBe(39);
  });
});

describe("W2068 — parseAnthropicUsage", () => {
  it("renames the flat keys and DERIVES total_tokens (this protocol sends none)", () => {
    const usage = parseAnthropicUsage({ input_tokens: 39, output_tokens: 181, cache_read_input_tokens: 7 });
    expect(usage.prompt_tokens).toBe(39);
    expect(usage.completion_tokens).toBe(181);
    expect(usage.total_tokens).toBe(220);
    expect(usage.cache_read).toBe(7);
  });

  it("a missing usage block is zeros, never a throw", () => {
    expect(parseAnthropicUsage(undefined)).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_read: 0, reasoning_tokens: 0 });
  });
});

describe("W2068 — parseAnthropicArguments", () => {
  it("empty is an empty object; malformed is reported, not thrown", () => {
    expect(parseAnthropicArguments("")).toEqual({});
    expect(parseAnthropicArguments("  ")).toEqual({});
    expect(parseAnthropicArguments(JSON.stringify({ city: "X" }))).toEqual({ city: "X" });
    const half = JSON.stringify({ city: "X" }).slice(0, 8);
    expect(parseAnthropicArguments(half)).toEqual({ __malformed: half });
  });
});
