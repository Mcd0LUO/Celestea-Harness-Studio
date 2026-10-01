/**
 * Anthropic **Messages** request encoding (W2068).
 *
 * Measured against a live endpoint; recordings in
 * `fixtures/anthropic/recorded-*.sse`. Four differences from the two protocols
 * already in this package, each one a place where copying the previous adapter
 * would have been wrong:
 *
 *   1. The system prompt is a **top-level field**, not a message. Anthropic takes
 *      `system` beside `messages`; a `system`-role entry inside `messages` is a
 *      different (and wrong) request.
 *   2. Tools are **flat** with an `input_schema` (not `parameters` under a
 *      `function` wrapper).
 *   3. `max_tokens` is **REQUIRED** - the endpoint answers 400 without it. It is
 *      the output cap, spelled like the chat-completions name and meaning the same
 *      thing, so a configured cap maps straight across. When nothing is
 *      configured this module uses a documented default rather than omitting the
 *      field and taking a 400 on every turn.
 *   4. The endpoint is `{base_url}/messages` (same no-double-`/v1` rule as responses).
 *
 * Tool results go back as a `tool_result` CONTENT BLOCK inside a user message,
 * not as a role of its own - another place where the chat-completions shape is
 * simply not this protocol's shape.
 *
 * @module @celestea/llm/anthropic/wire
 */

import { LlmError } from "../errors.js";
// `messageImageRefs` lives in wire.ts: the image rules are section 3.3's, and
// this module reuses them rather than re-deriving them.
import { messageImageRefs } from "../wire.js";
import {
  collectMessageText,
  type Message,
  type ModelRequestDraft,
  type ToolSpec,
} from "../seam.js";

/** The cap used when neither the request nor the profile declares one (required field). */
export const DEFAULT_MAX_TOKENS = 4096;

/** One `messages[]` content block. */
export interface AnthropicBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicBody {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  stream: true;
  /** Top-level, NOT a message (1). */
  system?: string;
  tools?: AnthropicTool[];
}

export interface AnthropicBodyOptions {
  model: string;
  /** Ignored ON PURPOSE: this endpoint has no reasoning-effort field (see the adapter). */
  reasoningEffort?: string | null;
  maxOutputTokens?: number | null;
}

/** `{base_url}/messages` - `base_url` already carries the `/v1` prefix (4). */
export function anthropicUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  const slash = trimmed === "" || trimmed.endsWith("/") ? "" : "/";
  return trimmed + slash + "messages";
}

/** One tool spec -> a flat Anthropic tool (2). */
export function mapAnthropicTool(spec: ToolSpec): AnthropicTool {
  return {
    name: spec.name,
    description: spec.description,
    input_schema: spec.parameters,
  };
}

/** An assistant turn -> text blocks + tool_use blocks. */
function assistantBlocks(msg: Message): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = [];
  for (const part of msg.content) {
    if (part.type === "text") {
      if (part.content !== "") blocks.push({ type: "text", text: part.content });
    } else if (part.type === "tool_call") {
      blocks.push({ type: "tool_use", id: part.content.id, name: part.content.name, input: part.content.args });
    }
  }
  return blocks;
}

/** A tool RESULT becomes a `tool_result` block on the user side (not a role). */
function toolResultBlocks(msg: Message): AnthropicBlock[] {
  return [{ type: "tool_result", tool_use_id: msg.tool_call_id ?? "", content: collectMessageText(msg.content) }];
}

/** One seam message -> Anthropic message(s). */
function messageFor(msg: Message): AnthropicMessage[] {
  if (messageImageRefs(msg).length > 0) {
    throw new LlmError(
      "anthropic_messages endpoint: image content blocks are not supported by this adapter",
      "generate",
      { retryable: false },
    );
  }
  // Unreachable from buildAnthropicBody, which HOISTS system messages into the
  // top-level field before reaching here (see its comment). Kept as a guard so a
  // future caller cannot reintroduce a system-role entry on this protocol.
  if (msg.role === "system") return [];
  if (msg.role === "tool") return [{ role: "user", content: toolResultBlocks(msg) }];
  if (msg.role === "assistant") return [{ role: "assistant", content: assistantBlocks(msg) }];
  const text = collectMessageText(msg.content);
  return text === "" ? [] : [{ role: "user", content: [{ type: "text", text }] }];
}

/** Build the serialized Messages body for one request draft. */
export function buildAnthropicBody(req: ModelRequestDraft, opts: AnthropicBodyOptions): AnthropicBody {
  const messages: AnthropicMessage[] = [];
  // W1900: the loop appends an EPHEMERAL system-role message to the request (the
  // context-compression water-level nudge). Point 1 above means this protocol has
  // no such role INSIDE the conversation — but "no such role" is not "no such
  // text": dropping it (this file's pre-W1900 reading) silently deleted the water
  // level from EVERY anthropic_messages route, and that is the route a
  // MiniMax-style third-party row uses. Hoisting the text into the top-level
  // `system` is the only lossless option this protocol offers; the cost is its
  // POSITION (it is read with the prompt rather than last), which is a far
  // smaller loss than the text itself.
  const hoisted: string[] = [];
  for (const message of req.messages ?? []) {
    if (message.role === "system") {
      const text = collectMessageText(message.content);
      if (text !== "") hoisted.push(text);
      continue;
    }
    messages.push(...messageFor(message));
  }

  const tools = (req.tools ?? []).map(mapAnthropicTool);
  const requested = req.max_tokens ?? opts.maxOutputTokens ?? null;
  // (3): required, so a configured-or-default value rather than an omission.
  const cap =
    typeof requested === "number" && Number.isInteger(requested) && requested > 0
      ? requested
      : DEFAULT_MAX_TOKENS;

  const body: AnthropicBody = { model: opts.model, max_tokens: cap, messages, stream: true };
  // (1): the system prompt is a top-level field, not a message. The prompt leads
  // and any hoisted message is APPENDED after it, so nothing that was already in
  // this field moves; an empty result leaves the field off entirely rather than
  // sending `""`.
  const system = [...(req.system === null || req.system === undefined || req.system === "" ? [] : [req.system]), ...hoisted].join("\n\n");
  if (system !== "") body.system = system;
  if (tools.length > 0) body.tools = tools;
  // `reasoningEffort` is accepted and ignored: no such field on this endpoint,
  // and forwarding one would make the engine's effort knob a lie.
  return body;
}
