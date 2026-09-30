/**
 * Production provider factory (W511).
 *
 * The one place a resolved runtime profile becomes a NETWORK-backed `Llm`:
 *
 *   base_url          profile.base_url > CELESTEA_BASE_URL > DEEPSEEK_BASE_URL
 *                     > https://api.deepseek.com
 *   api key           env[profile.api_key_env] ONLY (default DEEPSEEK_API_KEY):
 *                     never a file, never written back, never echoed
 *   reasoning_effort  profile value, verbatim (free string, never folded)
 *   max_output_tokens profile value
 *   timeouts          CELESTEA_LLM_{CONNECT,RESPONSE,STREAM_IDLE}_TIMEOUT_MS
 *                     > profile key > built-in default (0 disables a stage)
 *
 * `context_window_tokens` is not a request field (the engine trims with it); it
 * is surfaced in `liveLlmView()` so a startup log can report the live window
 * next to the model.
 *
 * `CELESTEA_LLM_MODE` picks live vs offline. This package is network-only, so it
 * only REPORTS the mode (the deterministic offline seam is host-side, an
 * injected test seam in apps/studio).
 */

import {
  AdapterRegistry,
  CHAT_COMPLETIONS_FORMAT,
  type RouteAdapter,
  type RouteDescription,
} from "./adapter.js";
import { OpenAiCompatClient } from "./client.js";
import { LlmError } from "./errors.js";
import { resolveClientConfig, tiersFromConfig, type LlmProfile, type ResolvedClientConfig } from "./profile.js";
import type { EnvLike, TimeoutTiers } from "./timeouts.js";

/** `live` = the real provider; `offline` = the host's deterministic seam. */
export const LLM_MODE_ENV = "CELESTEA_LLM_MODE";
/** Base-URL fallback used by the host (wins over DEEPSEEK_BASE_URL). */
export const LLM_BASE_URL_ENV = "CELESTEA_BASE_URL";

export type LlmMode = "live" | "offline";

/** The profile subset the live factory consumes. */
export interface LiveLlmProfile extends LlmProfile {
  context_window_tokens?: number | null;
}

/** Secret-free view of a live adapter (safe to log / serialize). */
export interface LiveLlmView {
  mode: LlmMode;
  model: string;
  baseUrl: string;
  reasoningEffort: string | null;
  maxOutputTokens: number | null;
  contextWindow: number | null;
  timeouts: TimeoutTiers;
  hasApiKey: boolean;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Read the mode. Absent/blank or "live" = live (the deployment default); only
 * an explicit "offline" turns the network off. Anything else is a config typo
 * and fails fast instead of silently reaching (or not reaching) a provider.
 */
export function resolveLlmMode(env: EnvLike = process.env): LlmMode {
  const raw = (env[LLM_MODE_ENV] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "live") return "live";
  if (raw === "offline") return "offline";
  throw new LlmError(`${LLM_MODE_ENV} must be 'live' or 'offline', got '${raw}'`, "generate");
}

/** Fill `base_url` from CELESTEA_BASE_URL when the profile leaves it empty. */
export function withBaseUrlFallback(profile?: LiveLlmProfile | null, env: EnvLike = process.env): LiveLlmProfile {
  const base = profile ?? {};
  if (nonEmpty(base.base_url) !== undefined) return base;
  const fromEnv = nonEmpty(env[LLM_BASE_URL_ENV]);
  return fromEnv === undefined ? base : { ...base, base_url: fromEnv };
}

/**
 * W2066: the protocol a profile asks for, defaulting to the one every
 * pre-W2066 deployment spoke. Blank/absent is the DEFAULT, not a guess: the
 * absence means 「nobody declared anything」, and the only honest answer to
 * that is the protocol this build has always used.
 */
export function requestFormatOf(profile?: LiveLlmProfile | null): string {
  const asked = (profile?.request_format ?? "").trim();
  return asked === "" ? CHAT_COMPLETIONS_FORMAT : asked;
}

/**
 * The built-in OpenAI-compatible adapter — the protocol this repository has
 * always spoken, behind the W2066 seam rather than beside it. Its client is
 * the pre-W2066 `OpenAiCompatClient` unchanged: registering an adapter must
 * not be a refactor of the code it wraps.
 */
export const chatCompletionsAdapter: RouteAdapter = {
  name: "chat-completions",
  requestFormat: CHAT_COMPLETIONS_FORMAT,
  createClient: (config: ResolvedClientConfig) => OpenAiCompatClient.fromConfig(config),
  // W2066: deliberately empty. The chat-completions dialect declares no
  // effort vocabulary of its own — the endpoint decides, and inventing one
  // here is exactly the clamping/aliasing the seam exists to avoid.
  describe: (): RouteDescription => ({
    requestFormat: CHAT_COMPLETIONS_FORMAT,
    reasoningEfforts: [],
    contextWindow: null,
    acceptsImages: true,
  }),
};

/** A registry holding only the built-in adapter (one per call, not shared). */
export function defaultAdapterRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(chatCompletionsAdapter);
  return registry;
}

/**
 * Build the live client behind the `Llm` seam, through the adapter registry.
 *
 * W2066: the format decides WHICH adapter builds the client. A format with
 * no registered adapter is refused by name (NO_ADAPTER) before any socket
 * is opened — the honest-refusal rule (docs/pitfalls.md P14), the same shape
 * `provider-probe.ts` uses for UNSUPPORTED_FORMAT.
 */
export function createLiveLlm(
  profile?: LiveLlmProfile | null,
  env: EnvLike = process.env,
  registry: AdapterRegistry = defaultAdapterRegistry(),
): OpenAiCompatClient {
  const effective = withBaseUrlFallback(profile, env);
  const config = resolveClientConfig(effective, env);
  const format = requestFormatOf(effective);
  const adapter = registry.resolve(format, `profile.request_format='${format}'`);
  const client = adapter.createClient(config);
  // The registry is a general seam; the host still wants the concrete client
  // (endpoint(), describe()). A future adapter may return a different
  // implementation, so the cast is checked here rather than assumed.
  if (!(client instanceof OpenAiCompatClient)) {
    throw new LlmError(
      `adapter '${adapter.name}' produced ${client.constructor.name}, which the host cannot describe`,
      "generate",
      { retryable: false },
    );
  }
  return client;
}

/** Secret-free view of the live configuration (never carries the key). */
export function liveLlmView(
  profile?: LiveLlmProfile | null,
  env: EnvLike = process.env,
  mode: LlmMode = resolveLlmMode(env),
): LiveLlmView {
  const effective = withBaseUrlFallback(profile, env);
  const config = resolveClientConfig(effective, env);
  const window = effective.context_window_tokens;
  return {
    mode,
    model: config.model,
    baseUrl: config.baseUrl,
    reasoningEffort: config.reasoningEffort,
    maxOutputTokens: config.maxOutputTokens,
    contextWindow: typeof window === "number" && window > 0 ? window : null,
    // W835 (R3 batch D / P2-1): the view must use the same null-when-disabled
    // mapping as client.timeouts(), else a disabled stage is printed as "0ms".
    timeouts: tiersFromConfig(config),
    hasApiKey: config.apiKey !== "",
  };
}
