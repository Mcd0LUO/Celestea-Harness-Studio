/**
 * Raw chat-completions chunk parsing (P2a).
 *
 * Mirrors `crates/llm/src/client.rs`:
 *   parse_raw_chunk   — delta view of one SSE data payload;
 *   extract_reasoning — choices[].delta.reasoning_content, joined in wire order;
 *   thinking_event    — blank-gated thinking event for a reasoning delta;
 *   parse_arguments   — tool-call arguments (malformed JSON kept raw).
 *
 * Non-JSON payloads (heartbeats, noise) and payloads carrying neither a delta
 * nor usage (e.g. `{"choices":[]}`) return undefined, so the caller skips them.
 */

import { parseUsage, type Usage } from "../usage.js";
import type { StreamEvent } from "../seam.js";

/** One streamed tool-call fragment (id/name/arguments arrive piecemeal). */
export interface RawToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

/** The content + tool_calls part of a single choice's delta. */
export interface RawChoiceDelta {
  text?: string;
  toolCalls: RawToolCallDelta[];
}

/** One decoded chat-completions stream chunk (raw wire shape). */
export interface RawChunk {
  /** Joined reasoning_content across choices (absent when none). */
  reasoning?: string;
  /** Per-choice content / tool-call deltas, in wire order. */
  choices: RawChoiceDelta[];
  /** Provider-reported usage, when the chunk carries some. */
  usage?: Usage;
  /**
   * W2017: the provider's own `choices[].finish_reason`, verbatim, when the
   * chunk carries one. Absent for every chunk that does not — which is most of
   * them, and every chunk of a provider that never sends the field.
   *
   * The value is deliberately NOT normalized here (the raw wire vocabulary is
   * kept: "stop" | "length" | "tool_calls" | "content_filter" | ...), so a
   * consumer needing a wider classification than [isTruncationFinishReason]
   * still has the fact.
   */
  finishReason?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function choiceIndex(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
}

/**
 * Extract chain-of-thought text: DeepSeek streams the CoT in
 * choices[].delta.reasoning_content (absent for non-reasoning models);
 * multi-choice deltas join in wire order.
 */
export function extractReasoning(chunk: unknown): string | undefined {
  if (!isRecord(chunk)) return undefined;
  const choices = chunk["choices"];
  if (!Array.isArray(choices)) return undefined;
  const parts: string[] = [];
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const delta = choice["delta"];
    if (!isRecord(delta)) continue;
    const reasoning = str(delta["reasoning_content"]);
    if (reasoning !== undefined && reasoning !== "") parts.push(reasoning);
  }
  return parts.length === 0 ? undefined : parts.join("");
}

/**
 * W2017: the FIRST non-empty `choices[].finish_reason` of one payload, or
 * undefined when the payload carries none.
 *
 * "First" is a deliberate choice, not an accident: `n > 1` is the only way a
 * payload has two reasons at once, and the harness always sends `n = 1`. The
 * value is returned verbatim (no normalization) so the caller can tell "length"
 * from "stop"; blank strings and non-string values are "absent", never "".
 */
export function finishReasonOf(chunk: unknown): string | undefined {
  if (!isRecord(chunk)) return undefined;
  const choices = chunk["choices"];
  if (!Array.isArray(choices)) return undefined;
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const reason = str(choice["finish_reason"]);
    if (reason !== undefined && reason !== "") return reason;
  }
  return undefined;
}

/**
 * W2017: true for the ONE finish_reason the harness must not ignore — the
 * provider stopped because the output hit the request's token cap, so whatever
 * arrived is a PREFIX (a half sentence, a half JSON tool-call argument).
 *
 * "length" is OpenAI's documented value and the one the repo has observed live
 * (the multimodal evidence log, §2.2). The comparison is
 * case-insensitive and trimmed because gateways do not all forward the string
 * byte-identically; every other value ("stop", "tool_calls", "content_filter",
 * a value from a future provider, ...) and an ABSENT reason are false.
 */
export function isTruncationFinishReason(reason: string | undefined): boolean {
  return reason !== undefined && reason.trim().toLowerCase() === "length";
}

/** Parse one tool_calls array entry into a fragment. */
function parseToolCallDelta(call: unknown): RawToolCallDelta | undefined {
  if (!isRecord(call)) return undefined;
  const fn = isRecord(call["function"]) ? call["function"] : {};
  const fragment: RawToolCallDelta = { index: choiceIndex(call["index"]) };
  const id = str(call["id"]);
  const name = str(fn["name"]);
  const args = str(fn["arguments"]);
  if (id !== undefined) fragment.id = id;
  if (name !== undefined) fragment.name = name;
  if (args !== undefined) fragment.arguments = args;
  return fragment;
}

/** Parse one choices[] entry into its delta view, or undefined when empty. */
function parseChoiceDelta(choice: unknown): RawChoiceDelta | undefined {
  if (!isRecord(choice)) return undefined;
  const delta = choice["delta"];
  if (!isRecord(delta)) return undefined;
  const rawText = str(delta["content"]);
  const toolCalls: RawToolCallDelta[] = [];
  const rawCalls = delta["tool_calls"];
  if (Array.isArray(rawCalls)) {
    for (const call of rawCalls) {
      const fragment = parseToolCallDelta(call);
      if (fragment !== undefined) toolCalls.push(fragment);
    }
  }
  const out: RawChoiceDelta = { toolCalls };
  if (rawText !== undefined && rawText !== "") out.text = rawText;
  if (out.text === undefined && toolCalls.length === 0) return undefined;
  return out;
}

/**
 * Parse one SSE data payload into the delta view. Returns undefined for
 * non-JSON payloads, `[DONE]`, and JSON payloads without deltas or usage.
 */
export function parseRawChunk(data: string): RawChunk | undefined {
  let value: unknown;
  try {
    value = JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;

  const reasoning = extractReasoning(value);
  const finishReason = finishReasonOf(value);
  const usage = parseUsage(value);
  const choices: RawChoiceDelta[] = [];
  const rawChoices = value["choices"];
  if (Array.isArray(rawChoices)) {
    for (const choice of rawChoices) {
      const delta = parseChoiceDelta(choice);
      if (delta !== undefined) choices.push(delta);
    }
  }

  // W2017: a finish_reason-only frame (the provider's LAST frame often carries
  // the reason with an empty delta) is a fact, not noise — dropping it here is
  // exactly how a truncated turn used to become invisible.
  if (
    reasoning === undefined &&
    choices.length === 0 &&
    usage === undefined &&
    finishReason === undefined
  ) {
    return undefined;
  }
  const chunk: RawChunk = { choices };
  if (reasoning !== undefined) chunk.reasoning = reasoning;
  if (usage !== undefined) chunk.usage = usage;
  // Only ever set when the wire carried it: an absent finish_reason must leave
  // the key OFF the object (no `finishReason: undefined`), so a consumer that
  // enumerates keys sees exactly what the provider sent.
  if (finishReason !== undefined) chunk.finishReason = finishReason;
  return chunk;
}

/**
 * The upstream-reported error message of one SSE payload, or undefined when the
 * payload carries none (W835 R3 batch C / P1-1).
 *
 * OpenAI-compatible gateways report a failed generation as a 200 SSE frame
 * whose body is `{"error":{...}}` (some send `{"message":"..."}`). Such a frame
 * carries no choices/usage, so [parseRawChunk] returns undefined; without this
 * check it was silently dropped and a following `[DONE]` could even turn it
 * into a "successful" empty reply. Recognising it lets the stream terminate as
 * `failed{kindOf:"stream"}` instead.
 */
export function parseStreamError(data: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const error = value["error"];
  if (error !== undefined && error !== null) {
    const text = errorText(error);
    if (text !== undefined) return text;
  }
  const message = str(value["message"]);
  return message !== undefined && message.trim() !== "" ? message : undefined;
}

/** Best-effort text of an `error` payload (string, or a nested message/detail). */
function errorText(error: unknown): string | undefined {
  if (typeof error === "string") return error.trim() === "" ? undefined : error;
  if (!isRecord(error)) return undefined;
  for (const key of ["message", "detail"]) {
    const text = str(error[key]);
    if (text !== undefined && text.trim() !== "") return text;
  }
  const json = JSON.stringify(error);
  return json === undefined || json === "{}" ? undefined : json;
}

/** Build a thinking event for a non-blank reasoning delta (blank-gated). */
export function thinkingEvent(reasoning: string): StreamEvent | null {
  return reasoning.trim() === "" ? null : { kind: "thinking", text: reasoning };
}

/** Parse accumulated tool-call arguments; malformed JSON is preserved raw. */
export function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
