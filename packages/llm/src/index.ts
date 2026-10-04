/**
 * @celestea/llm — OpenAI-compatible LLM provider (P2a public API).
 *
 * Parity target: `retired-engine/crates/llm` — raw SSE transport, usage /
 * cache-hit parsing, three timeout tiers, free-form reasoning_effort.
 *
 * Only this barrel is the package's public surface: provider internals
 * (SSE framing, wire mapping, HTTP transport) stay private so callers depend on
 * the `Llm` seam, not on the provider.
 *
 * Above that one seam is the wire-protocol one: `RouteAdapter` owns ONE
 * protocol and the routes that speak it, `AdapterRegistry` resolves one per call
 * and REFUSES by name (`NO_ADAPTER`) when the requested protocol has no adapter.
 * A caller still only depends on the `Llm` seam — which is what lets the retry,
 * fallback and image-downgrade decorators keep working unchanged across formats.
 */

// The seam this package implements. A1 (W746): every symbol below is CORE's
// own (re-exported through seam.ts) except the one documented widening of
// `StreamEvent.failed.kindOf` — see seam.ts §StreamEvent.
export type {
  Content,
  ImageContent,
  ImageRef,
  Llm,
  LlmStream,
  Message,
  ModelRequest,
  ModelRequestDraft,
  ResolvedImages,
  Role,
  StreamEvent,
  TextContent,
  ToolCall,
  ToolCallContent,
  ToolSpec,
} from "./seam.js";
export {
  assistantText,
  assistantToolCall,
  collectMessageText,
  collectStream,
  messageToolCalls,
  ROLES,
  systemMessage,
  toolResultMessage,
  userMessage,
} from "./seam.js";

// Usage contract (the statusline reads exactly these flat counters). The
// `Usage` shape + `zeroUsage`/`usageIsEmpty` are core's; the parser is ours.
export type { LlmUsageFrame, Usage } from "./usage.js";
export {
  cacheHitRatio,
  CACHE_READ_FLAT_KEYS,
  CACHE_READ_NESTED,
  parseUsage,
  REASONING_TOKENS_NESTED,
  USAGE_REQUIRED_KEYS,
  usageFromObject,
  usageIsEmpty,
  ZERO_USAGE,
  zeroUsage,
} from "./usage.js";

// Errors: the machine-readable timeout/timeout-stage + status/retryability
// contract (iteration E §4 P0 adds httpStatus/retryable; nothing is renamed).
export type { LlmErrorKind, LlmErrorOptions, TimeoutStage } from "./errors.js";
export {
  cancelledError,
  parseRetryAfterHeader,
  retryAfterMsOf,
  setRetryAfterMs,
  connectTimeoutError,
  errorKind,
  ImageUnsupportedError,
  IMAGE_UNSUPPORTED_MARKERS,
  isImageUnsupportedBody,
  isImageUnsupportedError,
  isRetryableStatus,
  isTimeoutError,
  LlmError,
  networkError,
  responseHeaderTimeoutError,
  RETRYABLE_HTTP_STATUSES,
  statusError,
  streamIdleTimeoutMessage,
  TIMEOUT_ERROR_PREFIX,
  timeoutError,
} from "./errors.js";

// The three timeout tiers + profile/env resolution.
export type { EnvLike, TimeoutProfile, TimeoutTiers } from "./timeouts.js";
export {
  CONNECT_TIMEOUT_ENV,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_RESPONSE_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_TIMEOUTS,
  isTimeoutMs,
  PROFILE_TIMEOUT_KEYS,
  readTimeoutProfile,
  RESPONSE_TIMEOUT_ENV,
  resolveTimeoutMs,
  resolveTimeoutTiers,
  STREAM_IDLE_TIMEOUT_ENV,
} from "./timeouts.js";

// Provider profile -> client configuration (api key from env only).
export type { LlmProfile, ResolvedClientConfig } from "./profile.js";
export {
  API_KEY_ENV,
  BASE_URL_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  normalizeReasoningEffort,
  resolveApiKey,
  resolveClientConfig,
  tiersFromConfig,
  validateModel,
} from "./profile.js";

// W2066: the wire-protocol seam. An adapter owns one protocol AND the routes
// that speak it; an unregistered protocol is refused by name (NO_ADAPTER)
// instead of being silently spoken as OpenAI's dialect.
export type { RouteAdapter, RouteDescription } from "./adapter.js";
export {
  AdapterRegistry,
  chatCompletionsAdapter,
  CHAT_COMPLETIONS_FORMAT,
  noAdapterAdvice,
  NO_ADAPTER,
  unknownRouteDescription,
} from "./adapter.js";

// Production factory: mode switch + live profile -> client assembly (W511).
export type { LiveLlmProfile, LiveLlmView, LlmMode } from "./factory.js";
export {
  createLiveLlm,
  defaultAdapterRegistry,
  liveLlmView,
  LLM_BASE_URL_ENV,
  LLM_MODE_ENV,
  requestFormatOf,
  resolveLlmMode,
  withBaseUrlFallback,
} from "./factory.js";

// W2067: the `responses` protocol — the second adapter, and the evidence that the
// seam is one. `ResponsesClient` is the same `Llm` seam behind a different wire;
// the pure frame decoder and the request encoder are exported so the golden
// recordings replay through the SAME code the live path runs.
export type { SendRequestOptions } from "./responses/decode.js";
export {
  parseCallArguments,
  parseFrame,
  responsesEvents,
  ResponsesClient,
  type ParsedFrame,
} from "./responses/decode.js";
export { RESPONSES_FORMAT, responsesAdapter } from "./responses/adapter.js";

// W2068: the `anthropic_messages` protocol — the third adapter.
export type { SendRequestOptions as AnthropicSendOptions } from "./anthropic/decode.js";
export {
  anthropicEvents,
  AnthropicClient,
  parseAnthropicArguments,
  parseAnthropicFrame,
  parseAnthropicUsage,
  type AnthropicFrame,
} from "./anthropic/decode.js";
export { ANTHROPIC_MESSAGES_FORMAT, anthropicMessagesAdapter } from "./anthropic/adapter.js";
export {
  anthropicUrl,
  buildAnthropicBody,
  DEFAULT_MAX_TOKENS,
  mapAnthropicTool,
  type AnthropicBlock,
  type AnthropicBody,
  type AnthropicMessage,
  type AnthropicTool,
} from "./anthropic/wire.js";
export {
  buildResponsesBody,
  mapResponsesTool,
  responsesUrl,
  type ResponsesBody,
  type ResponsesInput,
  type ResponsesTool,
} from "./responses/wire.js";

// Fallback chain (iteration E §4 P1): the decorator, its trigger-table defaults
// and the sidecar config loader (`fallbacks.json` / `CELESTEA_LLM_FALLBACKS`).
export type {
  FallbackAttemptInfo,
  FallbackLlm,
  FallbackLlmOptions,
  FallbackPolicy,
  FallbackStepHandle,
  FallbackStepSink,
  FailureInfo,
  LlmTarget,
  StatusTable,
} from "./fallback.js";
export {
  createFallbackLlm,
  DEFAULT_FALLBACK_POLICY,
  describeEvent,
  describeFailure,
  FallbackState,
  isProducedEvent,
  orderTargets,
} from "./fallback.js";

// Same-target retry (W9104): the decorator that re-issues ONE target's request,
// its default policy and the two pure helpers the host/tests assert on. It
// consumes the trigger table above instead of owning a second one.
export type { RetryAttemptInfo, RetryLlm, RetryLlmOptions, RetryPolicy } from "./retry.js";
export { clampRetries, createRetryLlm, DEFAULT_RETRY_POLICY, MAX_RETRIES, retryDelayMs } from "./retry.js";
export type { FallbackConfig } from "./fallback-config.js";
export {
  configProblems,
  ENV_FALLBACK_SWITCH,
  ENV_FALLBACKS,
  FALLBACKS_FILE,
  fallbackEnabled,
  loadFallbackConfig,
  parseConfig,
  targetAvailability,
} from "./fallback-config.js";

// The adapter + provider registration.
export type { OpenAiCompatOptions } from "./client.js";
export { OpenAiCompatClient } from "./client.js";
export {
  createDeepSeekLlm,
  createDeepSeekRegistry,
  DEEPSEEK_PROVIDER_NAME,
  LlmRegistry,
} from "./provider.js";


// W804 (multimodal P0): the image-aware wire helpers + the one-shot downgrade.
export type { WireContentPart, WireImagePart, WireTextPart } from "./wire.js";
export {
  collectMessageParts,
  dataUrlFor,
  messageImageRefs,
  messagesHaveImages,
  resolvedImagesOf,
  wireMessagesFor,
} from "./wire.js";
export type { ImageDowngradeCause, ImageDowngradeInfo, ImageDowngradeLlmOptions } from "./image-fallback.js";
export { createImageDowngradeLlm, imagePlaceholderText, withImagePlaceholders } from "./image-fallback.js";
