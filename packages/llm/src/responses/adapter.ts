/**
 * The `responses` wire-protocol adapter (W2067) — the second entry in the
 * `AdapterRegistry`, and the proof that the W2066 seam is a seam and not a
 * one-adapter formality.
 *
 * What this file deliberately does NOT contain: no `if (format === ...)` branch
 * (ARCHITECTURE.md `3.3's anti-pattern), no second timeout implementation, no
 * second retry/fallback layer. The timeout tiers come from the shared transport,
 * and the decorators sit above the `Llm` seam exactly as they do for
 * chat-completions — which is why a protocol nobody has written yet can still
 * be retried and fallback-covered for free.
 *
 * The capability report is the other half of the contract, and it is where the
 * measured gaps are stated rather than papered over:
 *
 *   reasoningEfforts: []  — `reasoning:{effort}` is answered with HTTP 400 on
 *                         the measured endpoint, so the engine's effort knob
 *                         has nowhere to go. Declaring an empty list is what
 *                         makes the UI stop offering it, instead of a knob
 *                         that silently does nothing.
 *   acceptsImages: false  — this adapter's input projection is plain strings;
 *                         a vision model reached through it is told so up front
 *                         and the engine's existing downgrade handles it.
 *
 * @module @celestea/llm/responses/adapter
 */


import { DEFAULT_TIMEOUTS, timeoutMsOf } from "../timeouts.js";
import { sendChatRequest } from "../transport.js";
import type { RouteAdapter, RouteDescription } from "../adapter.js";
import type { ResolvedClientConfig } from "../profile.js";
import { ResponsesClient } from "./decode.js";

/** The protocol name, exactly as providers.json spells it. */
export const RESPONSES_FORMAT = "responses";

/**
 * The adapter.
 *
 * `createClient` builds the client with the SAME resolved configuration the
 * chat-completions adapter receives, so the credential, the endpoint and the
 * cap are resolved once, upstream of this layer.
 */
export const responsesAdapter: RouteAdapter = {
  name: "responses",
  requestFormat: RESPONSES_FORMAT,
  createClient: (config: ResolvedClientConfig) =>
    new ResponsesClient({
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
    requestFormat: RESPONSES_FORMAT,
    // Measured 400 — see the module header. Empty means 「the endpoint decides」,
    // which is what stops the effort picker from offering a no-op.
    reasoningEfforts: [],
    contextWindow: null,
    acceptsImages: false,
  }),
};

/**
 * The registry itself is assembled in `factory.ts` (`defaultAdapterRegistry`)
 * — ONE place, so the list of speakable protocols can be read off in one hop.
 * This module only owns the adapter.
 */
