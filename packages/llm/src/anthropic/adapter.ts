/**
 * The `anthropic_messages` wire-protocol adapter (W2068) — the THIRD entry in
 * the `AdapterRegistry`.
 *
 * Two adapters is a coincidence; three is a pattern. Nothing here is a branch, a
 * second timeout implementation, or a second retry layer: the tiers come from the
 * shared transport and the decorators sit above the `Llm` seam, which is why a
 * protocol nobody had written yet still got retry, fallback and the image
 * downgrade for free.
 *
 * The capability report states the measured gaps rather than papering over them:
 *
 *   reasoningEfforts: []  — this endpoint takes no reasoning-effort field. The engine
 *                         knob has nowhere to go, and declaring an empty list is
 *                         what stops the UI from offering a no-op.
 *   acceptsImages: false  — the input projection here is text/tool blocks only;
 *                         a vision model reached through it is told so up front.
 *
 * @module @celestea/llm/anthropic/adapter
 */

import { sendChatRequest } from "../transport.js";
import { DEFAULT_TIMEOUTS, timeoutMsOf } from "../timeouts.js";
import type { RouteAdapter, RouteDescription } from "../adapter.js";
import type { ResolvedClientConfig } from "../profile.js";
import { AnthropicClient } from "./decode.js";

/** The protocol name, exactly as providers.json spells it. */
export const ANTHROPIC_MESSAGES_FORMAT = "anthropic_messages";

/** The adapter. */
export const anthropicMessagesAdapter: RouteAdapter = {
  name: "anthropic-messages",
  requestFormat: ANTHROPIC_MESSAGES_FORMAT,
  createClient: (config: ResolvedClientConfig) =>
    new AnthropicClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      maxOutputTokens: config.maxOutputTokens,
      streamIdleTimeoutMs: timeoutMsOf(config.streamIdleTimeoutMs, DEFAULT_TIMEOUTS.idleMs),
      send: (options) =>
        sendChatRequest({
          url: options.url,
          apiKey: options.apiKey,
          body: options.body,
          connectMs: timeoutMsOf(config.connectTimeoutMs, DEFAULT_TIMEOUTS.connectMs),
          responseMs: timeoutMsOf(config.responseTimeoutMs, DEFAULT_TIMEOUTS.responseMs),
        }),
    }),
  describe: (): RouteDescription => ({
    requestFormat: ANTHROPIC_MESSAGES_FORMAT,
    // No such field on this endpoint; an empty list stops the effort picker.
    reasoningEfforts: [],
    contextWindow: null,
    acceptsImages: false,
  }),
};