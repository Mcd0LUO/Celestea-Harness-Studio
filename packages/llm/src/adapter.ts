/**
 * RouteAdapter — the wire-protocol seam (W2066).
 *
 * WHY this exists. The runtime conflated two different questions in one object:
 *
 *   WHERE does this call go   — base_url, which credential, which route
 *   HOW is it spoken there    — the wire protocol (auth headers, request body,
 *                               SSE framing, usage accounting)
 *
 * `Profile` is the second question plus call controls (effort, token caps, the
 * system prompt); the provider row is the first. Before W2065 the first leaked
 * into the Profile (`base_url`) and the second was `request_format` — a field
 * every layer stored, every surface displayed, and **no code ever read** (the
 * engine composed `chat_completions` unconditionally).
 *
 * This module fixes the second question, and it is deliberately NOT a dialect
 * switch: an adapter owns a wire protocol AND the routes that speak it, and it
 * is asked what a route supports instead of having that declared in a config
 * row. The shape follows the DSH reference (`dsh-llm`'s `LlmAdapter` +
 * `ctx.llm.registerAdapter`): register adapters, resolve one per call, and
 * **refuse by name** when none is registered.
 *
 * Three properties this seam buys, each a real defect it removes:
 *
 *   1. A format nobody implements is a NAMED, fail-closed failure
 *      (`NO_ADAPTER`), not a silent downgrade onto OpenAI's dialect. The
 *      pre-W2066 failure mode was the worst kind: the model id changed, the
 *      wire did not, and the error surfaced as a provider 400 with no cause.
 *   2. The decorators are untouched. `retry.ts` / `fallback.ts` /
 *      `image-fallback.ts` already wrap the `Llm` seam, so a new adapter
 *      inherits retry, fallback, and the image downgrade for free. That is why
 *      the seam — not a `switch (format)` inside one client — is the right unit.
 *   3. Adding a protocol is a NEW FILE plus one `register()` line. No existing
 *      module grows a branch, so `ARCHITECTURE.md` `3.3's if-provider-equals-x
 *      anti-pattern has nowhere to appear.
 *
 * What this seam does NOT do (deliberate, and the reason it stays small): it
 * does not model per-route capabilities beyond `describe()`, and it carries no
 * adapter-private replay state. Both are real (DSH has them) and both are
 * separate changes: the first needs a core contract decision, the second needs
 * real recorded frames this build does not have yet.
 *
 * @module @celestea/llm/adapter
 */

import { OpenAiCompatClient } from "./client.js";
import { LlmError } from "./errors.js";
import type { ResolvedClientConfig } from "./profile.js";
import type { Llm } from "./seam.js";

/**
 * The machine-readable code for 「no adapter serves this wire protocol」.
 *
 * Stable and provider-neutral (it is the adapter layer's own taxonomy, not an
 * upstream's). Callers branch on this; nothing parses the message.
 */
export const NO_ADAPTER = "NO_ADAPTER";

/** The wire protocol this build speaks, named as providers.json names it. */
export const CHAT_COMPLETIONS_FORMAT = "chat_completions";

/** What one route supports — answered by the adapter, never declared in config. */
export interface RouteDescription {
  /** The protocol actually in force for this route. */
  requestFormat: string;
  /**
   * The route's free-form reasoning-effort labels. EMPTY means 「the endpoint
   * decides」 — deliberately not a default: DSH's rule is that an unsupported
   * explicit effort is REJECTED before provider I/O, never clamped or aliased,
   * and a hard-coded default would be exactly that aliasing.
   */
  reasoningEfforts: readonly string[];
  /** Declared context capacity, or null when neither the route nor config knows. */
  contextWindow: number | null;
  /** Whether this route accepts image content blocks. */
  acceptsImages: boolean;
}

/**
 * One wire protocol, plus the routes that speak it.
 *
 * `createClient` is the only required member: everything about encoding the
 * request, framing the response stream, and accounting usage for THIS protocol
 * is behind it, and nothing above this line knows which protocol it got.
 */
export interface RouteAdapter {
  /** Diagnostic name (surfaces in the refusal text and the startup log). */
  readonly name: string;
  /** The protocol this adapter serves; equals a provider row's `request_format`. */
  readonly requestFormat: string;
  /** Build the network-backed `Llm` for one fully resolved route. */
  createClient(config: ResolvedClientConfig): Llm;
  /** What this route supports. Optional: the default claims nothing. */
  describe?(config: ResolvedClientConfig): RouteDescription;
}

/**
 * The built-in OpenAI-compatible adapter — the protocol this repository has
 * always spoken, now behind the seam rather than beside it. Its client is the
 * pre-W2066 `OpenAiCompatClient` unchanged: registering an adapter must not be
 * a refactor of the code it wraps.
 *
 * It lives HERE, not in `factory.ts`, for one structural reason: the responses
 * adapter registers alongside it, and having IT import `factory.ts` back made
 * the pair circular (dep-cruiser `no-circular`). The registry is the neutral
 * ground both sides stand on — which is also why `factory.ts` may assemble
 * both without either knowing about the other.
 */
export const chatCompletionsAdapter: RouteAdapter = {
  name: "chat-completions",
  requestFormat: CHAT_COMPLETIONS_FORMAT,
  createClient: (config: ResolvedClientConfig) => OpenAiCompatClient.fromConfig(config),
  // W2066: deliberately empty. The chat-completions dialect declares no effort
  // vocabulary of its own — the endpoint decides, and inventing one here is
  // exactly the clamping/aliasing the seam exists to avoid.
  describe: (): RouteDescription => ({
    requestFormat: CHAT_COMPLETIONS_FORMAT,
    reasoningEfforts: [],
    contextWindow: null,
    acceptsImages: true,
  }),
};

/** The description used when an adapter declares none. */
export function unknownRouteDescription(requestFormat: string): RouteDescription {
  return { requestFormat, reasoningEfforts: [], contextWindow: null, acceptsImages: false };
}

/**
 * The adapter registry: request_format -> adapter.
 *
 * Fail-closed by construction. There is no default adapter and no fallback
 * chain here — resolving an unregistered protocol throws `NO_ADAPTER` naming
 * the format AND the setting that declared it, because that is the one fact an
 * operator can act on (docs/pitfalls.md P14's honest-refusal rule, the same
 * shape `provider-probe.ts` already uses for `UNSUPPORTED_FORMAT`).
 */
export class AdapterRegistry {
  readonly #byFormat = new Map<string, RouteAdapter>();

  /**
   * Register one adapter and return its disposer. Last-wins matches every other
   * registry in this codebase (`LlmRegistry`, `NamedRegistry`); a disposer is
   * required so a plugin can withdraw its adapter without a restart.
   */
  register(adapter: RouteAdapter): () => void {
    this.#byFormat.set(adapter.requestFormat, adapter);
    return () => {
      if (this.#byFormat.get(adapter.requestFormat) === adapter) this.#byFormat.delete(adapter.requestFormat);
    };
  }

  /** Resolve the adapter for one protocol, or refuse with `NO_ADAPTER`. */
  resolve(requestFormat: string, declaredBy: string): RouteAdapter {
    const adapter = this.#byFormat.get(requestFormat);
    if (adapter !== undefined) return adapter;
    const implemented = this.formats().join(", ");
    throw new LlmError(
      `no adapter serves request_format '${requestFormat}' (declared by ${declaredBy}); this build implements: ${implemented}`,
      "generate",
      { retryable: false },
    );
  }

  /** Every protocol this build can actually speak, in registration order. */
  formats(): readonly string[] {
    return [...this.#byFormat.keys()];
  }

  /** Describe one route through its adapter, or the empty description. */
  describe(requestFormat: string, config: ResolvedClientConfig, declaredBy: string): RouteDescription {
    const adapter = this.resolve(requestFormat, declaredBy);
    return adapter.describe === undefined
      ? unknownRouteDescription(requestFormat)
      : adapter.describe(config);
  }
}

/**
 * The refusal a host surfaces to a person: the same failure `resolve` throws,
 * phrased as the repair rather than the mechanism. Kept beside it so the
 * machine code and the human sentence cannot drift apart.
 */
export function noAdapterAdvice(requestFormat: string, providerId: string, implemented: readonly string[]): string {
  const have = implemented.length === 0 ? "(none)" : implemented.join(", ");
  return [
    `provider '${providerId}' declares request_format '${requestFormat}', which this build does not implement.`,
    `Implemented: ${have}.`,
    `If that endpoint actually speaks an OpenAI-compatible API, set this provider's request_format to '${CHAT_COMPLETIONS_FORMAT}' in settings -> providers.`,
    "Nothing is sent while the format is unsupported.",
  ].join(" ");
}
