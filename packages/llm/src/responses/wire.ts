/**
 * OpenAI **Responses** request encoding (W2067) — one direction only.
 *
 * Everything in this file was measured against a live endpoint, not read off a
 * spec: the recording is `fixtures/responses/recorded-*.sse` (see the header of
 * `decode.ts` for the frame inventory and `docs/pitfalls.md` P16 for the two
 * fields that fail SILENTLY). Three measurements shaped the code:
 *
 *   1. The endpoint is `{base_url}/responses`. `base_url` already ends in `/v1`
 *      for every provider row, so there is no `/v1` to prepend — copying
 *      chat-completions' `chatCompletionsUrl` would produce `/v1/v1/responses`.
 *   2. The output cap is `max_output_tokens`, NOT `max_tokens`. Measured:
 *      `max_output_tokens: 5` -> `output_tokens: 5`; the same request with
 *      `max_tokens: 5` -> `output_tokens: 34`, i.e. the field was accepted and
 *      **silently ignored**. A cap the caller believes in but the wire drops is
 *      worse than a 400, so this module sends exactly one name.
 *   3. There is NO reasoning-effort field on this endpoint: `reasoning:
 *      {effort}` is answered with HTTP 400, not ignored. The engine's effort
 *      knob therefore has nowhere to go, and the adapter says so in its
 *      `describe()` rather than inventing a mapping.
 *
 * The message projection reuses `wire.ts`'s helpers (tool messages, image
 * splitting) and reshapes their output into the Responses `input` array; it
 * does not re-derive any of the section 3.3 rules.
 *
 * @module @celestea/llm/responses/wire
 */

import { LlmError } from "../errors.js";
// `messageImageRefs` / `resolvedImagesOf` live in wire.ts: the image rules are
// section 3.3's, and this module reshapes their output rather than re-deriving it.
import { messageImageRefs, resolvedImagesOf } from "../wire.js";
import {
  collectMessageText,
  type Message,
  type ModelRequestDraft,
  type ResolvedImages,
  type ToolSpec,
} from "../seam.js";

/** One `input` entry: the Responses input array is a flat, role-tagged list. */
export type ResponsesInput = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Only on a tool-result entry; the call it answers. */
  call_id?: string;
};

export interface ResponsesTool {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface ResponsesBody {
  model: string;
  input: ResponsesInput[];
  stream: true;
  tools?: ResponsesTool[];
  /** The ONE name this protocol uses for the output cap (measured; see `2). */
  max_output_tokens?: number;
}

export interface ResponsesBodyOptions {
  model: string;
  /** Ignored ON PURPOSE — see `3. Kept so the call site stays symmetric. */
  reasoningEffort?: string | null;
  maxOutputTokens?: number | null;
}

/** `{base_url}/responses` — `base_url` already carries the `/v1` prefix. */
export function responsesUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  return trimmed === "" || trimmed.endsWith("/") ? `${trimmed}responses` : `${trimmed}/responses`;
}

/** One tool spec -> a flat Responses tool (the function wrapper is gone). */
export function mapResponsesTool(spec: ToolSpec): ResponsesTool {
  return {
    type: "function",
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
  };
}

/**
 * Flatten one seam message into Responses `input` entries.
 *
 * A tool message is the only one that carries an id. Images are deliberately
 * NOT projected: this endpoint's input entries are plain strings here, and
 * faking an image part that the endpoint may not accept would be worse than
 * saying so — the adapter's `describe()` declares `acceptsImages: false` and the
 * engine's existing image downgrade handles a vision model that says otherwise.
 */
function inputFor(msg: Message): ResponsesInput[] {
  if (messageImageRefs(msg).length > 0) {
    throw new LlmError(
      "responses endpoint: image content blocks are not supported by this adapter" +
        (msg.tool_call_id === undefined ? "" : ` (tool_call_id ${msg.tool_call_id})`),
      "generate",
      { retryable: false },
    );
  }
  if (msg.role === "tool") {
    return [{ role: "tool", content: collectMessageText(msg.content), call_id: msg.tool_call_id ?? "" }];
  }
  return [{ role: msg.role, content: collectMessageText(msg.content) }];
}

/**
 * Build the serialized Responses body for one request draft.
 *
 * `reasoningEffort` is accepted and ignored: the field does not exist on this
 * endpoint (measured 400), and silently forwarding it would make the engine's
 * effort knob a lie. `describe()` is where that fact is reported.
 */
export function buildResponsesBody(req: ModelRequestDraft, opts: ResponsesBodyOptions): ResponsesBody {
  const input: ResponsesInput[] = [];
  if (req.system !== null && req.system !== undefined && req.system !== "") {
    input.push({ role: "system", content: req.system });
  }
  for (const message of req.messages ?? []) input.push(...inputFor(message));

  const tools = (req.tools ?? []).map(mapResponsesTool);
  const cap = req.max_tokens ?? opts.maxOutputTokens ?? null;

  const body: ResponsesBody = { model: opts.model, input, stream: true };
  if (tools.length > 0) body.tools = tools;
  // 0/negative = no cap, and the field is omitted (the same rule as wire.ts).
  if (typeof cap === "number" && Number.isInteger(cap) && cap > 0) body.max_output_tokens = cap;
  return body;
}

/** Re-exported so the adapter shares ONE image-table rule with chat-completions. */
export { resolvedImagesOf };
export type { ResolvedImages };
