/**
 * W2067 — the `responses` decoder, run against RECORDED frames.
 *
 * The assertions are statements about bytes a real provider sent
 * (`fixtures/responses/recorded-*.sse` — redacted recordings of a live
 * endpoint), not about a hand-written expectation. Production runs the same
 * decoder, so an upstream protocol change turns into a red test here instead
 * of a silent behaviour drift.
 *
 * The recordings pin, in order of how badly a decoder gets each one wrong:
 *
 *   1. No `[DONE]`. The stream ends on `response.completed`. A decoder that
 *      waits for the sentinel reports every turn as `interrupted` — a fake
 *      failure on a successful call.
 *   2. Usage appears ONLY on the terminal frame.
 *   3. The first `function_call_arguments.delta` of a call is the empty string,
 *      and a call is identified by `output_index` + `call_id`.
 *   4. Reasoning and text are different events and must not be merged.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import type http from "node:http";
import { describe, expect, it } from "vitest";

import { parseCallArguments, parseFrame, responsesEvents } from "./decode.js";
import type { StreamEvent } from "../seam.js";

// `src/responses/` -> `src` -> `packages/llm` -> `packages` -> repo root.
const FIXTURES = join(__dirname, "..", "..", "..", "..", "fixtures", "responses");

function* chunked(bytes: Buffer, size: number): Generator<Buffer> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

/**
 * A recorded body as a response. CHUNKED on purpose: a decoder that only
 * works when the whole body arrives in one TCP read is not a decoder.
 */
function recorded(name: string): http.IncomingMessage {
  const bytes = readFileSync(join(FIXTURES, name));
  const stream = Readable.from(chunked(bytes, 97));
  return Object.assign(stream, { statusCode: 200, headers: {} }) as unknown as http.IncomingMessage;
}

async function eventsOf(name: string): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of responsesEvents(recorded(name), null)) out.push(event);
  return out;
}

const joined = (events: StreamEvent[], kind: string): string =>
  events.filter((e) => e.kind === kind).map((e) => (e as { text: string }).text).join("");
const textOf = (events: StreamEvent[]): string => joined(events, "text");
const thinkingOf = (events: StreamEvent[]): string => joined(events, "thinking");
const terminal = (events: StreamEvent[]): Extract<StreamEvent, { kind: "done" }> => {
  const last = events.at(-1);
  if (last === undefined || last.kind !== "done") {
    throw new Error("expected a terminal done, got " + String(last?.kind));
  }
  return last;
};
describe("W2067  —  responses decoding over recorded frames", () => {
  it("1: a text turn ends on response.completed, NOT interrupted, and the recording has no [DONE]", async () => {
    const raw = readFileSync(join(FIXTURES, "recorded-text.sse"), "utf8");
    // The premise, asserted first: if the recording ever grows a [DONE], this
    // file is describing a protocol that no longer matches the endpoint.
    expect(raw).not.toContain("data: [DONE]");
    expect(raw).toContain("event: response.completed");

    const events = await eventsOf("recorded-text.sse");
    // A decoder waiting for [DONE] lands on `interrupted` here.
    expect(events.some((e) => e.kind === "interrupted")).toBe(false);
    expect(terminal(events).kind).toBe("done");
  });

  it("2: the turn emits its usage BEFORE the terminal event", async () => {
    // W2067 follow-up (found while adding the third adapter): the decoder folded
    // the terminal frame's usage into the accumulator and emitted NOTHING, so the
    // ledger and the statusline saw a completed turn with no counters. Usage
    // rides just before `done`, which is the contract `stream.ts` follows.
    const events = await eventsOf("recorded-text.sse");
    const usage = events.find((e) => e.kind === "usage");
    expect(usage).toBeDefined();
    if (usage !== undefined && usage.kind === "usage") {
      expect(usage.usage.prompt_tokens).toBeGreaterThan(0);
      expect(usage.usage.completion_tokens).toBeGreaterThan(0);
    }
    const usageAt = events.findIndex((e) => e.kind === "usage");
    const doneAt = events.findIndex((e) => e.kind === "done");
    expect(usageAt).toBeGreaterThanOrEqual(0);
    expect(usageAt).toBeLessThan(doneAt);
  });

  it("4: reasoning and text stay separate events (merging leaks deliberation into the answer)", async () => {
    const events = await eventsOf("recorded-text.sse");
    expect(thinkingOf(events).length).toBeGreaterThan(0);
    expect(textOf(events).length).toBeGreaterThan(0);
    expect(textOf(events)).not.toContain(thinkingOf(events).slice(0, 40));
  });

  it("3: a tool call assembles from output_index + call_id, and the empty leading delta is tolerated", async () => {
    const events = await eventsOf("recorded-tools.sse");
    const done = terminal(events);
    const calls = done.message.content.filter((c) => c.type === "tool_call");
    expect(calls).toHaveLength(1);
    const call = calls[0] as { content: { id: string; name: string; args: unknown } };
    expect(call.content.name).toBe("get_weather");
    expect(call.content.id).toMatch(/^call_/);
    // The empty first delta must not leave a "" or a half-written argument.
    expect(call.content.args).toEqual({ city: "Beijing" });
  });

  it("1: a body cut before response.completed is interrupted, never a fake done", async () => {
    const raw = readFileSync(join(FIXTURES, "recorded-text.sse"), "utf8");
    const cut = raw.slice(0, raw.indexOf("event: response.completed"));
    const stream = Readable.from(chunked(Buffer.from(cut, "utf8"), 97));
    const out: StreamEvent[] = [];
    for await (const e of responsesEvents(Object.assign(stream, { statusCode: 200 }) as unknown as http.IncomingMessage, null)) out.push(e);
    expect(out.at(-1)?.kind).toBe("interrupted");
  });

  it("2+5: a capped turn ends on response.incomplete, carries usage, and reports truncated", async () => {
    const raw = readFileSync(join(FIXTURES, "recorded-capped.sse"), "utf8");
    // MEASURED, and only visible in a real recording: a turn that hits the
    // output cap does NOT end on response.completed. The terminal frame is
    // `response.incomplete` with `incomplete_details.reason: "length"`.
    // A decoder that only knows the `completed` name reads this turn as
    // `interrupted` — a fake failure for a turn that merely ran out of budget.
    expect(raw).toContain("event: response.incomplete");
    expect(raw).not.toContain("event: response.completed");

    const events = await eventsOf("recorded-capped.sse");
    expect(events.some((e) => e.kind === "interrupted")).toBe(false);
    // W2017 parity: still `done`, but flagged — a truncated answer IS an answer.
    const done = terminal(events);
    expect(done.truncated).toBe(true);

    // And the usage really is on that frame: the recording was made with
    // max_output_tokens: 5 and the endpoint answered with exactly 5.
    const lastData = raw.slice(raw.lastIndexOf("event: response.incomplete"));
    const frame = parseFrame(lastData.slice(lastData.indexOf("data: ") + 6).split("\n")[0] ?? "");
    expect(frame?.type).toBe("usage");
    if (frame?.type === "usage") {
      expect(frame.usage.completion_tokens).toBe(5);
      expect(frame.usage.prompt_tokens).toBeGreaterThan(0);
    }
  });
});

describe("W2067  —  parseFrame", () => {
  it("maps the recorded event types; unknown ones are skipped, not failed", () => {
    expect(parseFrame("not json")).toBeUndefined();
    expect(parseFrame("{}")?.type).toBe("unknown");
    expect(parseFrame(JSON.stringify({ type: "response.output_text.delta", delta: "hi" }))?.type).toBe("text");
    expect(parseFrame(JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "hmm" }))?.type).toBe("thinking");
    expect(parseFrame(JSON.stringify({ type: "response.brand_new_event" }))?.type).toBe("unknown");
  });

  it("carries the empty leading argument delta instead of treating it as a call", () => {
    const frame = parseFrame(JSON.stringify({ type: "response.function_call_arguments.delta", delta: "", output_index: 1, sequence_number: 47 }));
    expect(frame).toEqual({ type: "call-delta", index: 1, delta: "", sequenceNumber: 47 });
  });

  it("a non-function_call output item is lifecycle, never a tool call", () => {
    const frame = parseFrame(JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "item_x" } }));
    expect(frame?.type).toBe("lifecycle");
  });
});

describe("W2067  —  parseCallArguments", () => {
  it("empty is an empty object; malformed is reported, not thrown", () => {
    expect(parseCallArguments("")).toEqual({});
    expect(parseCallArguments("   ")).toEqual({});
    expect(parseCallArguments(JSON.stringify({ city: "X" }))).toEqual({ city: "X" });
    expect(parseCallArguments("{\"city\":")).toEqual({ __malformed: "{\"city\":" });
  });
});