/**
 * Engine LLM assembly (W511): profile -> `Llm`, live by default.
 *
 * Two seams, one switch:
 *   - LIVE     `@celestea/llm`'s OpenAI-compatible client, assembled from the
 *              engine profile (model / base_url / reasoning_effort /
 *              max_output_tokens) + the environment (api key, the three
 *              CELESTEA_LLM_* timeouts);
 *   - OFFLINE  the deterministic in-process seam (`createOfflineLlm`), still
 *              available for tests and replay via `CELESTEA_LLM_MODE=offline`
 *              or an injected `llm` factory on the adapter.
 *
 * `@celestea/llm` speaks its own (parity) seam types; core owns the seam the
 * engine consumes. `liveEngineLlm` is the ONE adapter between them: requests
 * pass through unchanged (identical shapes), stream events are copied field by
 * field, and a provider stream-idle failure (`kindOf: "timeout"`) is reported
 * as core's `"stream"` terminal — the message keeps the `llm timeout:` prefix,
 * so the distinction survives in the transcript.
 *
 * W2017: the bridge is also where a token-cap truncation becomes OBSERVABLE
 * (`reportTruncation`, an audit line). See the doc on [bridgeProviderLlm] for
 * why the notice is an audit line and not an SSE frame.
 */

import {
  createLiveLlm,
  liveLlmView,
  resolveLlmMode,
  type LiveLlmView,
  type LlmMode,
  type LlmTarget,
} from "@celestea/llm";
import type {
  Llm,
  LlmStream,
  ModelRequest,
  StreamEvent,
} from "@celestea/core";
import type { Profile } from "@celestea/runtime";
import type { EngineProfile } from "../runtime-adapter.js";
import { defaultEngineProfile } from "./engine-profile.js";
import { createOfflineLlm } from "./offline-llm.js";
import {
  applyProviderTarget,
  resolveProviderTarget,
  type ProviderLookup,
  type ProviderTarget,
} from "./provider-target.js";
import type { Llm as ProviderLlm, LlmStream as ProviderStream, StreamEvent as ProviderEvent } from "@celestea/llm";

/**
 * The profile fields a live client needs, from either profile shape (`Profile`
 * carries `context_window_tokens`, the host view `context_window`).
 */
export function llmProfileOf(profile: Profile | EngineProfile): {
  model: string;
  base_url: string;
  api_key_env: string;
  request_format: string;
  reasoning_effort: string | null;
  max_output_tokens: number | null;
  context_window_tokens: number;
} {
  return {
    model: profile.model,
    base_url: profile.base_url,
    api_key_env: profile.api_key_env,
    // W2066: THIS is the line where the format used to die — the host view had
    // no such field, so the wire protocol was decided inside the transport and
    // the row's declaration never arrived. It is route state and crosses the
    // boundary with the rest of the route (model + base_url + key env).
    request_format: profile.request_format,
    reasoning_effort: profile.reasoning_effort,
    max_output_tokens: profile.max_output_tokens,
    context_window_tokens:
      "context_window_tokens" in profile ? profile.context_window_tokens : profile.context_window,
  };
}

/** One provider stream event -> the core event the engine consumes. */
function coreEvent(event: ProviderEvent): StreamEvent {
  switch (event.kind) {
    case "text":
      return { kind: "text", text: event.text };
    case "thinking":
      return { kind: "thinking", text: event.text };
    case "usage":
      return { kind: "usage", usage: event.usage };
    case "done":
      return { kind: "done", message: event.message };
    case "interrupted":
      return { kind: "interrupted" };
    case "failed":
      return {
        kind: "failed",
        // core's union has no "timeout" member: an SSE idle guard is a broken
        // stream there, and the "llm timeout:" prefix keeps the detail.
        kindOf: event.kindOf === "generate" ? "generate" : "stream",
        message: event.message,
      };
  }
}

/** Re-yield a provider stream as a core stream. */
async function* coreStream(stream: ProviderStream, onTruncated: (() => void) | null): LlmStream {
  for await (const event of stream) {
    if (event.kind === "done" && event.truncated === true) onTruncated?.();
    yield coreEvent(event);
  }
}

/**
 * W2017: the audit line for a turn the provider cut off on the token cap.
 *
 * WHY HERE, and not on the SSE bus: `contracts/sse-events.json` is FROZEN and
 * every key of every frame is validated against it (`tests/contract-parity.test.ts`
 * -> `checkPayload`); a new key on an existing event is a hard violation, so a
 * user-visible notice would need a contract change plus a decision record —
 * neither of which is a worker's bounded cut. The audit channel is the one that
 * IS open (the exact precedent is W804/W855's image downgrade, which reports
 * through `console.warn` for the same reason: "the session log keeps its frozen
 * event vocabulary").
 *
 * `finish_reason` is the provider's own statement, never a guess: the line says
 * the OUTPUT WAS CUT, so a half sentence or a half JSON tool-call argument is
 * expected rather than a finished answer. It carries no prompt, no body and no
 * credential — the model id and the reason only (§4.4 discipline).
 */
export function reportTruncation(model: string, warn: (line: string) => void = (l) => console.warn(l)): void {
  warn(
    "[W2017] llm output truncated by max_tokens model=" +
      (model === "" ? "-" : model) +
      ' finish_reason="length" (the answer is a PREFIX; a half-written tool-call argument is expected)',
  );
}

/**
 * The ONE provider-seam -> core-seam bridge: requests pass through unchanged and
 * every event is copied field by field. Shared by [liveEngineLlm] and by the
 * fallback decorator (E §4 P1), so a fallback turn is bridged exactly once and
 * the two paths cannot drift.
 *
 * W2017: `model` and `onTruncated` are OPTIONAL — the bridge's default
 * behaviour is byte-for-byte the pre-W2017 one (a plain field-by-field copy).
 * The truncation report fires at most once per turn and only when the provider
 * actually said `finish_reason:"length"`; a provider that never sends the field
 * cannot reach it.
 */
export function bridgeProviderLlm(
  inner: ProviderLlm,
  opts: { model?: string; onTruncated?: (model: string) => void } = {},
): Llm {
  const onTruncated =
    opts.onTruncated === undefined ? null : (): void => opts.onTruncated?.(opts.model ?? "");
  return {
    async generate(req: ModelRequest): Promise<LlmStream> {
      return coreStream(await inner.generate(req), onTruncated);
    },
  };
}

/** The live provider behind the core `Llm` seam. */
export function liveEngineLlm(
  profile: Profile,
  env: NodeJS.ProcessEnv,
  onTruncated?: (model: string) => void,
): Llm {
  return bridgeProviderLlm(createLiveLlm(llmProfileOf(profile), env), {
    model: profile.model,
    ...(onTruncated === undefined ? {} : { onTruncated }),
  });
}

/**
 * ONE fallback target's client (E §4.2.1 P1): the composed profile with that
 * target's own `model` / `base_url` / key env applied, so each target keeps its
 * own credential and its own three timeout tiers (§4.2.1 "三档超时语义逐字不变").
 * Only env var NAMES travel here; the value is resolved inside `createLiveLlm`.
 */
export function liveEngineLlmFor(
  base: Profile,
  target: LlmTarget,
  env: NodeJS.ProcessEnv,
  onTruncated?: (model: string) => void,
): Llm {
  return liveEngineLlm(
    {
      ...base,
      model: target.model,
      base_url: target.baseUrl ?? base.base_url,
      api_key_env: target.apiKeyEnv ?? base.api_key_env,
      // W2066: a fallback target carries its OWN protocol; inheriting the
      // primary's is only right when the sidecar did not name one.
      ...(target.requestFormat === undefined || target.requestFormat === null
        ? {}
        : { request_format: target.requestFormat as Profile["request_format"] }),
    },
    env,
    onTruncated,
  );
}

/**
 * The engine's `Llm` for this generation: live, or the offline test seam.
 *
 * W2017: the LIVE path reports a token-cap truncation through `onTruncated`
 * (default: the audit line of [reportTruncation]). The OFFLINE seam is
 * deterministic and never truncates, so it has nothing to report.
 */
export function createEngineLlm(
  profile: Profile,
  env: NodeJS.ProcessEnv,
  mode: LlmMode = resolveLlmMode(env),
  onTruncated: (model: string) => void = (model) => reportTruncation(model),
): Llm {
  return mode === "offline" ? createOfflineLlm() : liveEngineLlm(profile, env, onTruncated);
}

/** Secret-free description of the live adapter (startup logging / diagnostics). */
export function engineLlmView(
  profile: Profile | EngineProfile,
  env: NodeJS.ProcessEnv,
  mode?: LlmMode,
): LiveLlmView {
  return liveLlmView(llmProfileOf(profile), env, mode);
}

/**
 * The startup profile: the host constants + env overrides ([defaultEngineProfile])
 * with providers.json applied on top (model, base_url, and the api key into the
 * process env — in memory only).
 */
export function startupEngineProfile(
  lookup: ProviderLookup,
  env: NodeJS.ProcessEnv,
  apiKeyEnv: string,
): { profile: EngineProfile; target: ProviderTarget } {
  const base = defaultEngineProfile(env, apiKeyEnv);
  const target = resolveProviderTarget(lookup, env, base);
  return applyProviderTarget(base, target, lookup, env);
}
