/**
 * W2017: the harness must be able to SEE a token-cap truncation.
 *
 * The provider says why it stopped in `choices[].finish_reason`; `"length"` means
 * the output hit the request's `max_tokens` and everything received is a PREFIX
 * (a half sentence, a half JSON tool-call argument). Before this cut the repo
 * parsed the field nowhere, so an HTTP 200 turn that ran out of budget was
 * indistinguishable from a finished one.
 *
 * Three gates, in the order the data flows:
 *   parse  — [parseRawChunk] keeps the reason, verbatim, and only when present;
 *   stream — the terminal `done` carries `truncated: true` for "length" ONLY;
 *   default— a stream that never sends the field yields the byte-identical
 *            event sequence it yielded before (`toStrictEqual`, so an extra
 *            `truncated: undefined` key would fail these too).
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  collectStream,
  createFallbackLlm,
  createRetryLlm,
  OpenAiCompatClient,
  userMessage,
  type Llm,
  type LlmStream,
  type ModelRequestDraft,
  type StreamEvent,
} from "@celestea/llm";
import { finishReasonOf, isTruncationFinishReason, parseArguments, parseRawChunk } from "./sse/chunks.js";
import { sseFrame, startMockUpstream, type MockUpstream } from "./mock-upstream.test-util.js";

const DUMMY_KEY = "sk-dummy-test-key-never-real";

let upstream: MockUpstream | null = null;

afterEach(async () => {
  if (upstream !== null) await upstream.close();
  upstream = null;
});

/** The event list of one scripted SSE response. */
async function runFrames(frames: Array<string | Buffer>): Promise<Awaited<ReturnType<typeof collectStream>>> {
  upstream = await startMockUpstream("frames", { frames, end: true });
  const llm = new OpenAiCompatClient({
    baseUrl: upstream.baseUrl,
    apiKey: DUMMY_KEY,
    model: "deepseek-v4-pro",
    connectTimeoutMs: 5_000,
    responseTimeoutMs: 5_000,
    streamIdleTimeoutMs: 5_000,
  });
  const req: ModelRequestDraft = { model: "deepseek-v4-pro", messages: [userMessage("ping")], max_tokens: 200 };
  return await collectStream(await llm.generate(req));
}

/** The terminal `done` of one scripted response (fails loudly when absent). */
async function doneOf(frames: Array<string | Buffer>): Promise<unknown> {
  const events = await runFrames(frames);
  const terminal = events.at(-1);
  expect(terminal?.kind).toBe("done");
  return terminal;
}

describe("parseRawChunk: finish_reason", () => {
  it('keeps "length" verbatim and classifies it as a truncation', () => {
    const chunk = parseRawChunk(
      '{"choices":[{"index":0,"delta":{"content":"half a sen"},"finish_reason":"length"}]}',
    );
    expect(chunk?.finishReason).toBe("length");
    expect(isTruncationFinishReason(chunk?.finishReason)).toBe(true);
  });

  it('keeps "stop" and does NOT classify it as a truncation', () => {
    const chunk = parseRawChunk(
      '{"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}',
    );
    expect(chunk?.finishReason).toBe("stop");
    expect(isTruncationFinishReason(chunk?.finishReason)).toBe(false);
  });

  it("leaves the key OFF when the provider sends no finish_reason", () => {
    const chunk = parseRawChunk('{"choices":[{"index":0,"delta":{"content":"hi"}}]}');
    // `in`, not `=== undefined`: an absent field must not become a present key
    // holding undefined, or every consumer that enumerates keys changes.
    expect(chunk !== undefined && "finishReason" in chunk).toBe(false);
    expect(Object.keys(chunk ?? {}).sort()).toEqual(["choices"]);
    expect(isTruncationFinishReason(chunk?.finishReason)).toBe(false);
    expect(finishReasonOf({ choices: [{ delta: { content: "hi" } }] })).toBeUndefined();
  });

  it("does not turn a blank or non-string reason into an empty string", () => {
    expect(parseRawChunk('{"choices":[{"finish_reason":"","delta":{"content":"x"}}]}')).not.toHaveProperty(
      "finishReason",
    );
    expect(parseRawChunk('{"choices":[{"finish_reason":7,"delta":{"content":"x"}}]}')).not.toHaveProperty(
      "finishReason",
    );
  });

  it("keeps a finish_reason-only frame (empty delta) instead of dropping it", () => {
    // The provider's LAST frame often carries the reason with no delta at all;
    // returning undefined there is exactly how a truncation became invisible.
    const chunk = parseRawChunk('{"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}');
    expect(chunk?.finishReason).toBe("length");
    expect(chunk?.choices).toEqual([]);
  });
});

describe("streamEvents: the terminal done carries the truncation", () => {
  it("marks a max_tokens truncation as truncated", async () => {
    const terminal = await doneOf([
      sseFrame({ choices: [{ index: 0, delta: { content: "The answer is " } }] }),
      sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }),
      sseFrame("[DONE]"),
    ]);
    expect(terminal).toStrictEqual({
      kind: "done",
      message: { role: "assistant", content: [{ type: "text", content: "The answer is " }], tool_call_id: null },
      truncated: true,
    });
  });

  it("exposes the half-written tool call a truncation leaves behind", async () => {
    // The damage the flag makes visible: `parseArguments` keeps malformed JSON
    // as a raw string, so the truncation used to reach the loop as a plausible
    // tool call with a string argument.
    const events = await runFrames([
      sseFrame({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"path":"/tm' } }] },
          },
        ],
      }),
      sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }),
      sseFrame("[DONE]"),
    ]);
    const terminal = events.at(-1);
    expect(terminal).toMatchObject({ kind: "done", truncated: true });
    if (terminal?.kind === "done") {
      const call = terminal.message.content[0];
      expect(call).toMatchObject({ type: "tool_call" });
      if (call?.type === "tool_call") expect(call.content.args).toBe('{"path":"/tm');
    }
    expect(parseArguments('{"path":"/tm')).toBe('{"path":"/tm');
  });

  it("yields the byte-identical done for stop and for an absent reason", async () => {
    const stopped = await doneOf([
      sseFrame({ choices: [{ index: 0, delta: { content: "ok" } }] }),
      sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      sseFrame("[DONE]"),
    ]);
    const silent = await doneOf([
      sseFrame({ choices: [{ index: 0, delta: { content: "ok" } }] }),
      sseFrame("[DONE]"),
    ]);
    // toStrictEqual: a `truncated: undefined` key on either side fails here.
    expect(stopped).toStrictEqual({
      kind: "done",
      message: { role: "assistant", content: [{ type: "text", content: "ok" }], tool_call_id: null },
    });
    expect(silent).toStrictEqual({
      kind: "done",
      message: { role: "assistant", content: [{ type: "text", content: "ok" }], tool_call_id: null },
    });
  });

  it("leaves the whole no-reason event sequence unchanged", async () => {
    const events = await runFrames([
      sseFrame({ choices: [{ index: 0, delta: { reasoning_content: "r" } }] }),
      sseFrame({ choices: [{ index: 0, delta: { content: "ok" } }] }),
      sseFrame({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      sseFrame("[DONE]"),
    ]);
    expect(events).toStrictEqual([
      { kind: "thinking", text: "r" },
      { kind: "text", text: "ok" },
      {
        kind: "usage",
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cache_read: 0, reasoning_tokens: 0 },
      },
      { kind: "done", message: { role: "assistant", content: [{ type: "text", content: "ok" }], tool_call_id: null } },
    ]);
  });
});
/**
 * The fact has to SURVIVE the production chain, or it is only visible in a unit
 * test. Both decorators forward the terminal event verbatim — these two cases
 * pin that, so a future rewrite of either one that rebuilds `done` (dropping
 * the optional key) fails here instead of silently re-blinding the harness.
 */
function truncatingSeam(): Llm {
  const stream: LlmStream = {
    async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
      yield { kind: "text", text: "half a sen" };
      yield {
        kind: "done",
        message: { role: "assistant", content: [{ type: "text", content: "half a sen" }], tool_call_id: null },
        truncated: true,
      };
    },
  };
  return { generate: async (): Promise<LlmStream> => stream };
}

describe("the truncation fact survives the decorators that wrap every live turn", () => {
  it("passes through the same-target retry decorator", async () => {
    const llm = createRetryLlm({ inner: truncatingSeam(), policy: { maxRetries: 1 }, sleep: async () => {} });
    const events = await collectStream(await llm.generate({ messages: [userMessage("hi")] }));
    expect(events.at(-1)).toMatchObject({ kind: "done", truncated: true });
    expect(llm.retries()).toBe(0);
  });

  it("passes through the fallback chain decorator", async () => {
    const llm = createFallbackLlm({
      targets: [{ name: "only", provider: "p", model: "m" }],
      clientFor: () => truncatingSeam(),
    });
    const events = await collectStream(await llm.generate({ messages: [userMessage("hi")] }));
    expect(events.at(-1)).toMatchObject({ kind: "done", truncated: true });
    expect(llm.failedAttempts()).toBe(0);
  });
});
