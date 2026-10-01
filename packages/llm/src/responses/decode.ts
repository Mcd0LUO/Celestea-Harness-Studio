/**
 * OpenAI **Responses** SSE decoding (W2067).
 *
 * Frame inventory, as MEASURED against a live endpoint
 * (`fixtures/responses/recorded-text.sse` / `recorded-tools.sse` — redacted
 * recordings, not hand-written samples):
 *
 *   response.created                      | lifecycle, ignored
 *   response.in_progress                  | lifecycle, ignored
 *   response.output_item.added            | opens a reasoning OR a function_call item
 *   response.content_part.added           | opens a text part
 *   response.reasoning_summary_part.*     | opens/closes a reasoning summary part
 *   response.reasoning_summary_text.delta | -> thinking
 *   response.output_text.delta            | -> text
 *   response.function_call_arguments.delta| -> tool-call argument fragment
 *   response.*.done / content_part.done   | closes an item
 *   response.completed                    | TERMINAL, and the ONLY frame with usage
 *
 * Four measured facts this decoder is built around:
 *
 *   1. There is **no `[DONE]` sentinel** — the stream ends on
 *      `response.completed`. A decoder waiting for `[DONE]` reports every
 *      responses turn as `interrupted`: a fake failure for a successful call.
 *   2. **Usage exists only on the terminal frame.** chat-completions has
 *      `stream_options:{include_usage}` for the mid-stream gap; this endpoint
 *      has no equivalent, so the running token count is legitimately 0 until
 *      the turn ends. Reported as measured, never faked (pitfalls P16).
 *   3. The first `function_call_arguments.delta` of a call carries an **empty
 *      string**. An accumulator emitting on first sight yields a tool call with
 *      `arguments:""`; id and name come from `output_item.added`.
 *   4. `sequence_number` increases monotonically across interleaved reasoning and
 *      tool items. Used as a duplicate/gap DETECTOR — reordering is not this
 *      layer's job, and a gap is reported rather than silently absorbed.
 *
 * @module @celestea/llm/responses/decode
 */

import type http from "node:http";

import { SseDecoder, type SseFrame } from "../sse/frames.js";
import { TurnAccumulator, readBodyChunks, StreamIdleAbort } from "../stream.js";
import type { Content, Message, ModelRequestDraft, StreamEvent } from "../seam.js";
import { usageFromObject, type Usage } from "../usage.js";
import { buildResponsesBody, responsesUrl } from "./wire.js";

/** The transport slice, injected so a decoder test never needs a socket. */
export interface SendRequestOptions {
  url: string;
  apiKey: string;
  body: string;
}

/** One in-flight tool call, keyed by the responses `output_index`. */
interface CallAcc {
  id: string;
  name: string;
  args: string;
}

/**
 * The Responses-endpoint `Llm`: the same seam as chat-completions, a different
 * wire. The timeout tiers and the HTTP transport belong to the transport layer
 * (injected), so this class only owns encoding and decoding.
 */
export class ResponsesClient {
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
    return responsesUrl(this.#baseUrl);
  }

  /** Secret-free view of the configuration (safe to log/serialize). */
  describe(): { baseUrl: string; model: string; maxOutputTokens: number | null } {
    return { baseUrl: this.#baseUrl, model: this.#model, maxOutputTokens: this.#maxOutputTokens };
  }

  /** Start a streaming turn. */
  async generate(req: ModelRequestDraft): Promise<AsyncIterable<StreamEvent>> {
    const model = req.model === undefined || req.model === "" ? this.#model : req.model;
    const body = buildResponsesBody(req, { model, maxOutputTokens: this.#maxOutputTokens });
    const response = await this.#send({
      url: this.endpoint(),
      apiKey: this.#apiKey,
      body: JSON.stringify(body),
    });
    return responsesEvents(response, this.#idleMs);
  }
}

/** The decoded shape of one Responses frame — the union the loop folds. */
export type ParsedFrame =
  | { type: "lifecycle"; sequenceNumber?: number }
  | { type: "thinking"; delta: string; sequenceNumber?: number }
  | { type: "text"; delta: string; sequenceNumber?: number }
  | { type: "call-open"; index: number; id: string; name: string; sequenceNumber?: number }
  | { type: "call-delta"; index: number; delta: string; sequenceNumber?: number }
  | { type: "usage"; usage: Usage; sequenceNumber?: number; terminal: true; truncated?: boolean }
  | { type: "completed"; sequenceNumber?: number; truncated?: true }
  | { type: "error"; message: string; sequenceNumber?: number }
  | { type: "unknown"; sequenceNumber?: number };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

/**
 * Map one `response.*` frame onto the fold union.
 *
 * Unknown event types map to `unknown` and are SKIPPED, not failed on: the
 * endpoint emits 12 types today and may add more, and a new event must not
 * break an in-flight turn (the same rule `stream.ts` applies to non-JSON
 * frames). A frame whose data is not JSON is skipped for the same reason.
 */
export function parseFrame(data: string): ParsedFrame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const type = str(parsed["type"]);
  const sequenceNumber = num(parsed["sequence_number"]);
  switch (type) {
    case "response.reasoning_summary_text.delta":
      return { type: "thinking", delta: str(parsed["delta"]), sequenceNumber };
    case "response.output_text.delta":
      return { type: "text", delta: str(parsed["delta"]), sequenceNumber };
    case "response.output_item.added": {
      const item = parsed["item"];
      if (!isRecord(item) || item["type"] !== "function_call") {
        return { type: "lifecycle", sequenceNumber };
      }
      return {
        type: "call-open",
        index: num(parsed["output_index"]) ?? 0,
        id: str(item["call_id"]),
        name: str(item["name"]),
        sequenceNumber,
      };
    }
    case "response.function_call_arguments.delta":
      return {
        type: "call-delta",
        index: num(parsed["output_index"]) ?? 0,
        // Measured: the FIRST delta of every call is the empty string.
        delta: str(parsed["delta"]),
        sequenceNumber,
      };
    case "response.completed":
    case "response.incomplete": {
      const response = isRecord(parsed["response"]) ? parsed["response"] : {};
      const usage = response["usage"];
      if (isRecord(usage)) {
        // `2: usage lives ONLY here. The nested `*_tokens_details` shapes are
        // mapped by the shared parser, so the flat statusline counters agree
        // across both protocols.
        const parsedUsage = usageFromObject({
          prompt_tokens: usage["input_tokens"],
          completion_tokens: usage["output_tokens"],
          total_tokens: usage["total_tokens"],
          prompt_tokens_details: usage["input_tokens_details"],
          completion_tokens_details: usage["output_tokens_details"],
        });
        // MEASURED, and only visible in a real recording: the terminal frame
        // carries BOTH the end marker AND the usage block, and its NAME depends
        // on whether the turn finished — `response.completed` normally,
        // `response.incomplete` when the output cap bit (measured:
        // `max_output_tokens: 5` -> `incomplete_details.reason: "length"`, and
        // the frame really is named `response.incomplete`).
        //
        // The earlier draft returned from the usage branch, so `terminal` was
        // never set and every real turn decoded as `interrupted`. One frame,
        // one place: `terminal` says the stream ends here, and `truncated` carries
        // W2017's "the provider stopped on the cap" fact — a truncated answer IS
        // an answer, so the turn still ends as `done`.
        const truncated = type === "response.incomplete" || str(response["status"]) === "incomplete";
        if (parsedUsage !== undefined) {
          return { type: "usage", usage: parsedUsage, sequenceNumber, terminal: true, truncated };
        }
        if (truncated) return { type: "completed", sequenceNumber, truncated: true };
      }
      return { type: "completed", sequenceNumber };
    }
    case "response.failed":
    case "error": {
      const err = isRecord(parsed["response"]) ? parsed["response"]["error"] : parsed["error"];
      const message = isRecord(err) ? str(err["message"]) : str(err);
      return { type: "error", message: message === "" ? type : message, sequenceNumber };
    }
    default:
      return { type: "unknown", sequenceNumber };
  }
}

/** Parse accumulated tool-call arguments; malformed JSON is reported, not thrown. */
export function parseCallArguments(raw: string): unknown {
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { __malformed: raw };
  }
}


/** The mutable fold state, shared by the generator and [foldFrames]. */
interface FoldState {
  turn: TurnAccumulator;
  calls: Map<number, CallAcc>;
  terminal: boolean;
  truncated: boolean;
  lastSequence: number;
  gap: string | null;
}

/**
 * Record the sequence cursor and report a gap. Returns the gap message so the
 * caller cannot forget to latch it.
 *
 * The cursor advances for EVERY frame that carries a sequence number, including
 * the ones this decoder ignores (lifecycle events) — otherwise a run of
 * `response.created` / `in_progress` would read as a gap.
 */
function trackSequence(state: FoldState, sequenceNumber: number | undefined): void {
  if (sequenceNumber === undefined) return;
  if (state.lastSequence >= 0 && sequenceNumber !== state.lastSequence + 1) {
    state.gap = `responses stream sequence ${state.lastSequence} -> ${sequenceNumber}`;
  }
  state.lastSequence = sequenceNumber;
}

/**
 * Fold one batch of SSE frames into seam events (ARCHITECTURE.md §4.2, split by
 * stage — this is the `project` half, kept out of the generator so neither one
 * grows past the depth budget).
 *
 * Returns the events to yield plus whether the caller must STOP: an upstream
 * error frame is terminal and must not be followed by a synthetic `done`.
 */
function* foldFrames(
  frames: readonly SseFrame[],
  state: FoldState,
): Generator<StreamEvent, "stop" | "continue", void> {
  for (const frame of frames) {
    if (frame.event === "keepalive") continue;
    const parsed = parseFrame(frame.data);
    if (parsed === undefined) continue;
    trackSequence(state, parsed.sequenceNumber);
    if (parsed.type === "unknown" || parsed.type === "lifecycle") continue;
    switch (parsed.type) {
      case "text":
        // The empty delta is the measured normal case on this protocol.
        if (parsed.delta !== "") yield { kind: "text", text: parsed.delta };
        break;
      case "thinking":
        if (parsed.delta !== "") yield { kind: "thinking", text: parsed.delta };
        break;
      case "call-open":
        state.calls.set(parsed.index, { id: parsed.id, name: parsed.name, args: "" });
        break;
      case "call-delta": {
        // The EMPTY leading delta is the measured normal case. Skipping it keeps
        // the accumulator free of a "" that would otherwise surface as a
        // half-written argument.
        const call = state.calls.get(parsed.index);
        if (call !== undefined && parsed.delta !== "") call.args += parsed.delta;
        break;
      }
      case "usage":
        // Folded into the shared accumulator so the terminal message and the
        // usage the caller sees come from ONE place.
        state.turn.push({ choices: [], usage: parsed.usage } as never);
        state.terminal = true;
        if (parsed.truncated === true) state.truncated = true;
        break;
      case "completed":
        state.terminal = true;
        if (parsed.truncated === true) state.truncated = true;
        break;
      case "error":
        yield { kind: "failed", kindOf: "stream", message: "responses stream error: " + parsed.message };
        return "stop";
    }
  }
  return "continue";
}
/**
 * Decode a recorded or live Responses SSE body into seam events.
 *
 * Pure over the byte stream, so the golden recordings and the live path run
 * the SAME code — the fixture is evidence about the decoder, not about a
 * hand-written expectation.
 */
export async function* responsesEvents(
  response: http.IncomingMessage,
  idleMs: number | null,
): AsyncGenerator<StreamEvent> {
  const state: FoldState = {
    turn: new TurnAccumulator(),
    calls: new Map<number, CallAcc>(),
    terminal: false,
    // W2017 parity: the provider stopped on the output cap. Measured terminal
    // frame for a capped turn is `response.incomplete`, NOT `response.completed`
    // (see parseFrame). Latched, never cleared: a truncated answer IS an answer,
    // so the turn still ends `done` — the fact is simply no longer invisible,
    // exactly as `finish_reason:"length"` is on the chat-completions side.
    truncated: false,
    lastSequence: -1,
    gap: null,
  };
  const decoder = new SseDecoder();
  // §4.2 of ARCHITECTURE.md (split by stage): the frame fold is its own function
  // so the generator stays at depth 1. `foldFrames` owns the sequence check and
  // the switch; this loop only does I/O and the idle guard.
  try {
    for await (const chunk of readBodyChunks(response, idleMs)) {
      const verdict = yield* foldFrames(decoder.push(chunk.toString("utf8")), state);
      // An upstream error frame is terminal: a later frame must not turn it into
      // a synthetic `done`.
      if (verdict === "stop") return;
    }
  } catch (e) {
    if (e instanceof StreamIdleAbort) {
      yield { kind: "failed", kindOf: "timeout", message: e.message };
      return;
    }
    throw e;
  }
  if (state.gap !== null) {
    yield { kind: "failed", kindOf: "stream", message: state.gap };
    return;
  }
  if (!state.terminal) {
    // No [DONE] on this protocol; absence of either terminal frame means the
    // stream really did stop early.
    yield { kind: "interrupted" };
    return;
  }
  const message: Message = {
    role: "assistant",
    content: assembledContent(state.turn, state.calls),
    tool_call_id: null,
  };
  // W2017: the cap is reported as a property of the done event, never as an error —
  // a half-written answer is what the caller must expect, not a failed turn.
  // W2067 follow-up: usage rides just before the terminal event, the same contract
  // `stream.ts` follows. An earlier draft folded it into the accumulator and
  // emitted nothing, so a responses turn completed with no observable usage at
  // all — found while adding the third adapter (W2068) and its test.
  const usage = state.turn.usage;
  if (usage !== null) yield { kind: "usage", usage };
  yield state.truncated ? { kind: "done", message, truncated: true } : { kind: "done", message };
}

/**
 * The assembled assistant message.
 *
 * Text comes from the shared accumulator (it owns the text/thinking split and
 * the empty-delta rule); tool calls from this decoder's per-index map, because
 * the responses protocol identifies a call by `output_index` rather than an
 * OpenAI `index` — the ids are deliberately not shared.
 */
function assembledContent(turn: TurnAccumulator, calls: Map<number, CallAcc>): Content[] {
  const content: Content[] = turn.doneMessage().content.filter((c) => c.type !== "tool_call");
  for (const index of [...calls.keys()].sort((a, b) => a - b)) {
    const call = calls.get(index);
    if (call === undefined || call.name === "") continue;
    content.push({
      type: "tool_call",
      content: { id: call.id, name: call.name, args: parseCallArguments(call.args) },
    });
  }
  return content;
}