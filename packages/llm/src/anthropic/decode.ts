/**
 * Anthropic **Messages** SSE decoding (W2068).
 *
 * Frame inventory, MEASURED against a live endpoint
 * ("fixtures/anthropic/recorded-text.sse" / "recorded-tools.sse" — redacted
 * recordings, not hand-written samples). This protocol is the most regular of
 * the three: a block is opened, streamed, closed.
 *
 *   message_start        | carries input_tokens (output_tokens is 0 here)
 *   content_block_start  | opens a block: thinking | text | tool_use
 *   content_block_delta  | thinking_delta | text_delta | input_json_delta
 *   content_block_stop   | closes a block by index
 *   message_delta        | carries the FINAL output_tokens
 *   message_stop         | TERMINAL
 *   ping / error         | keepalive and failure
 *
 * Four measured facts, each a place a decoder can silently go wrong:
 *
 *   1. **Usage arrives in TWO frames and must be merged.** "message_start" carries
 *      "input_tokens" with "output_tokens: 0"; "message_delta" carries the real
 *      "output_tokens" and restates input. Taking either one alone reports a turn that
 *      spent 39 prompt tokens and 0 completion — or the reverse.
 *   2. **There is no per-delta tool id.** A "tool_use" block is opened by
 *      "content_block_start" with "index" + "id" + "name", and its arguments arrive
 *      afterwards as "input_json_delta" carrying only an "index". The per-index map is
 *      mandatory, not an optimisation.
 *   3. **The first argument fragment is "{", not empty** — the opposite of the
 *      responses endpoint, whose leading delta is "". A decoder carrying that
 *      habit over produces "arguments: """ here.
 *   4. **"stop_reason" does NOT appear in the stream.** It is only on the non-streaming
 *      body. So the "max_tokens" truncation fact is NOT observable mid-stream here: a capped
 *      turn ends as a plain "done". Reported as measured rather than guessed
 *      (docs/pitfalls.md P17) — this protocol is the one place where the engine
 *      cannot set "done.truncated", and it says so rather than faking it.
 *
 * @module @celestea/llm/anthropic/decode
 */

import type http from "node:http";

import { SseDecoder, type SseFrame } from "../sse/frames.js";
import { TurnAccumulator, readBodyChunks, StreamIdleAbort } from "../stream.js";
import type { Content, Message, ModelRequestDraft, StreamEvent } from "../seam.js";
import { usageFromObject, type Usage } from "../usage.js";
import { anthropicUrl, buildAnthropicBody } from "./wire.js";

/** Wire keys, named once: this protocol nests deeper than the other two. */
const KEY_TYPE = "type";
const KEY_INDEX = "index";
const KEY_BLOCK = "content_block";
const KEY_DELTA = "delta";
const KEY_ID = "id";
const KEY_NAME = "name";
const KEY_MESSAGE = "message";
const KEY_THINKING = "thinking";
const KEY_TEXT = "text";
const KEY_PARTIAL = "partial_json";
const KEY_USAGE = "usage";
const KEY_INPUT = "input_tokens";
const KEY_OUTPUT = "output_tokens";
const KEY_CACHE_READ = "cache_read_input_tokens";
const KEY_ERROR = "error";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

/** The transport slice, injected so a decoder test never needs a socket. */
export interface SendRequestOptions {
  url: string;
  apiKey: string;
  body: string;
}

/** One in-flight tool call, keyed by the protocol's content-block index (2). */
interface CallAcc {
  id: string;
  name: string;
  args: string;
}

/** The decoded shape of one Anthropic frame — the union the loop folds. */
export type AnthropicFrame =
  | { type: "lifecycle" }
  | { type: "thinking"; delta: string }
  | { type: "text"; delta: string }
  | { type: "call-open"; index: number; id: string; name: string }
  | { type: "call-delta"; index: number; delta: string }
  | { type: "usage"; usage: Usage; final: boolean }
  | { type: "stop" }
  | { type: "error"; message: string }
  | { type: "unknown" };

/**
 * The Messages usage shape -> the flat counters the statusline reads.
 *
 * Measured keys: "input_tokens", "output_tokens", "cache_read_input_tokens" (flat),
 * "cache_creation_input_tokens". The shared parser is reused by renaming into its
 * expected shape, so the cache-hit ratio means the same thing on every protocol
 * — and "total_tokens" is DERIVED, because this protocol sends none.
 */
export function parseAnthropicUsage(raw: unknown): Usage {
  const usage = isRecord(raw) ? raw : {};
  const input = num(usage[KEY_INPUT]) ?? 0;
  const output = num(usage[KEY_OUTPUT]) ?? 0;
  return (
    usageFromObject({
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: input + output,
      cache_read_input_tokens: usage[KEY_CACHE_READ],
    }) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_read: 0, reasoning_tokens: 0 }
  );
}

/**
 * Map one Anthropic frame onto the fold union.
 *
 * Unknown event types map to "unknown" and are SKIPPED, not failed on: the endpoint
 * emits 7 types today (plus "ping"), and a new one must not break an in-flight turn.
 */
export function parseAnthropicFrame(data: string): AnthropicFrame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const type = str(parsed[KEY_TYPE]);
  const index = num(parsed[KEY_INDEX]) ?? 0;
  switch (type) {
    case "content_block_start": {
      const block = parsed[KEY_BLOCK];
      if (isRecord(block) && block[KEY_TYPE] === "tool_use") {
        return { type: "call-open", index, id: str(block[KEY_ID]), name: str(block[KEY_NAME]) };
      }
      return { type: "lifecycle" };
    }
    case "content_block_delta": {
      const delta = parsed[KEY_DELTA];
      if (!isRecord(delta)) return { type: "lifecycle" };
      const kind = str(delta[KEY_TYPE]);
      if (kind === "thinking_delta") return { type: "thinking", delta: str(delta[KEY_THINKING]) };
      if (kind === "text_delta") return { type: "text", delta: str(delta[KEY_TEXT]) };
      if (kind === "input_json_delta") {
        // Measured: the FIRST fragment here is a brace, not the empty string the
        // responses endpoint sends. Carried verbatim either way.
        return { type: "call-delta", index, delta: str(delta[KEY_PARTIAL]) };
      }
      return { type: "lifecycle" };
    }
    case "message_start": {
      const message = parsed[KEY_MESSAGE];
      return { type: "usage", final: false, usage: parseAnthropicUsage(isRecord(message) ? message[KEY_USAGE] : undefined) };
    }
    case "message_delta":
      // (1) the SECOND half of usage; final tells the loop which frame wins.
      return { type: "usage", final: true, usage: parseAnthropicUsage(parsed[KEY_USAGE]) };
    case "message_stop":
      return { type: "stop" };
    case "ping":
      return { type: "lifecycle" };
    case "error": {
      const error = parsed[KEY_ERROR];
      const message = isRecord(error) ? str(error[KEY_MESSAGE]) : str(error);
      return { type: "error", message: message === "" ? "error" : message };
    }
    default:
      return { type: "unknown" };
  }
}

/**
 * The two usage frames, folded into the flat counters (fact 1).
 *
 * Exported as a PURE function because the merge is the one piece of this
 * decoder that the per-frame assertions cannot see: both source frames parse
 * correctly whether or not anything combines them, and a decoder that forgets
 * to combine them reports a turn that spent real prompt tokens and zero
 * completion. A mutation (drop the merge) has to be able to turn this red.
 */
export function mergedUsage(inputTokens: number, outputTokens: number, cacheRead: number): Usage {
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    cache_read: cacheRead,
    reasoning_tokens: 0,
  };
}

/** Parse accumulated tool arguments; malformed JSON is reported, not thrown. */
export function parseAnthropicArguments(raw: string): unknown {
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { __malformed: raw };
  }
}

/** The mutable fold state, shared by the generator and [foldAnthropicFrames]. */
interface AnthropicState {
  turn: TurnAccumulator;
  calls: Map<number, CallAcc>;
  terminal: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
}

/**
 * Fold one batch of SSE frames (ARCHITECTURE.md 4.2, split by stage — the
 * generator stays shallow and each half has one job).
 *
 * Returns whether the caller must STOP: an error frame is terminal and a later
 * message_stop must not be allowed to synthesize a done.
 */
function* foldAnthropicFrames(
  frames: readonly SseFrame[],
  state: AnthropicState,
): Generator<StreamEvent, "stop" | "continue", void> {
  for (const frame of frames) {
    if (frame.event === "keepalive") continue;
    const parsed = parseAnthropicFrame(frame.data);
    if (parsed === undefined) continue;
    if (parsed.type === "lifecycle" || parsed.type === "unknown") continue;
    switch (parsed.type) {
      case "text":
        if (parsed.delta !== "") yield { kind: "text", text: parsed.delta };
        break;
      case "thinking":
        if (parsed.delta !== "") yield { kind: "thinking", text: parsed.delta };
        break;
      case "call-open":
        state.calls.set(parsed.index, { id: parsed.id, name: parsed.name, args: "" });
        break;
      case "call-delta": {
        // (2) no id on the delta, so the per-index map is how it is found;
        // (3) the leading fragment here is a real brace, so it is appended.
        const call = state.calls.get(parsed.index);
        if (call !== undefined && parsed.delta !== "") call.args += parsed.delta;
        break;
      }
      case "usage":
        // (1) two frames, one truth: message_start has input only, message_delta
        // has the real output. The final one REPLACES the counters.
        if (parsed.final) {
          state.inputTokens = parsed.usage.prompt_tokens;
          state.outputTokens = parsed.usage.completion_tokens;
          state.cacheRead = parsed.usage.cache_read;
        } else {
          state.inputTokens = Math.max(state.inputTokens, parsed.usage.prompt_tokens);
        }
        break;
      case "error":
        yield { kind: "failed", kindOf: "stream", message: "anthropic stream error: " + parsed.message };
        return "stop";
      case "stop":
        state.terminal = true;
        break;
    }
  }
  return "continue";
}

/** The assembled assistant message: text from the accumulator, calls from the map. */
function assembledContent(state: AnthropicState): Content[] {
  const content: Content[] = state.turn.doneMessage().content.filter((c) => c.type !== "tool_call");
  for (const index of [...state.calls.keys()].sort((a, b) => a - b)) {
    const call = state.calls.get(index);
    if (call === undefined || call.name === "") continue;
    content.push({ type: "tool_call", content: { id: call.id, name: call.name, args: parseAnthropicArguments(call.args) } });
  }
  return content;
}

/**
 * Decode a recorded or live Messages SSE body into seam events.
 *
 * Pure over the byte stream, so the golden recordings and the live path run the
 * SAME code — the fixture is evidence about the decoder, not about a
 * hand-written expectation.
 */
export async function* anthropicEvents(
  response: http.IncomingMessage,
  idleMs: number | null,
): AsyncGenerator<StreamEvent> {
  const state: AnthropicState = {
    turn: new TurnAccumulator(),
    calls: new Map(),
    terminal: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
  };
  const decoder = new SseDecoder();
  try {
    for await (const chunk of readBodyChunks(response, idleMs)) {
      const verdict = yield* foldAnthropicFrames(decoder.push(chunk.toString("utf8")), state);
      if (verdict === "stop") return;
    }
  } catch (e) {
    if (e instanceof StreamIdleAbort) {
      yield { kind: "failed", kindOf: "timeout", message: e.message };
      return;
    }
    throw e;
  }
  if (!state.terminal) {
    yield { kind: "interrupted" };
    return;
  }
  // Usage rides just before the terminal event, the same contract `stream.ts`
  // follows (the ledger and the statusline observe it there). An earlier draft
  // folded the merged counters into the accumulator and emitted nothing — the
  // turn then completed with no observable usage at all.
  yield { kind: "usage", usage: mergedUsage(state.inputTokens, state.outputTokens, state.cacheRead) };
  const message: Message = { role: "assistant", content: assembledContent(state), tool_call_id: null };
  yield { kind: "done", message };
}

/** The Anthropic-endpoint "Llm": the same seam, a different wire. */
export class AnthropicClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #maxOutputTokens: number | null;
  readonly #idleMs: number | null;
  readonly #send: (options: SendRequestOptions) => Promise<http.IncomingMessage>;

  constructor(options: {
    baseUrl: string;
    apiKey: string;
    model: string;
    maxOutputTokens?: number | null;
    streamIdleTimeoutMs?: number | null;
    send: (options: SendRequestOptions) => Promise<http.IncomingMessage>;
  }) {
    this.#baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    const max = options.maxOutputTokens;
    this.#maxOutputTokens =
      typeof max === "number" && Number.isFinite(max) && max > 0 ? Math.floor(max) : null;
    this.#idleMs = options.streamIdleTimeoutMs ?? null;
    this.#send = options.send;
  }

  /** The endpoint this client posts to. */
  endpoint(): string {
    return anthropicUrl(this.#baseUrl);
  }

  /** Secret-free view of the configuration (safe to log/serialize). */
  describe(): { baseUrl: string; model: string; maxOutputTokens: number | null } {
    return { baseUrl: this.#baseUrl, model: this.#model, maxOutputTokens: this.#maxOutputTokens };
  }

  /** Start a streaming turn. */
  async generate(req: ModelRequestDraft): Promise<AsyncIterable<StreamEvent>> {
    const model = req.model === undefined || req.model === "" ? this.#model : req.model;
    const body = buildAnthropicBody(req, { model, maxOutputTokens: this.#maxOutputTokens });
    const response = await this.#send({
      url: this.endpoint(),
      apiKey: this.#apiKey,
      body: JSON.stringify(body),
    });
    return anthropicEvents(response, this.#idleMs);
  }
}
