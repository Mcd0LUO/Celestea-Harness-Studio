/**
 * Provider model probe — `/api/providers/test` and
 * `/api/providers/{id}/models/fetch` (`src/providers.rs:523-553,725-776`).
 *
 * Two rules carry the security weight:
 *   1. **keyless same-origin borrow** — a provider with NO key whose
 *      normalized `base_url` equals the CURRENT generation's `base_url` may
 *      borrow the engine's own key for that one request. The borrowed key is
 *      never persisted, never echoed and never logged;
 *   2. a keyless NON-same-origin provider reports `该提供商未配置 api_key`
 *      WITHOUT issuing a request at all (no key ever leaves the process for a
 *      provider that never had one).
 *
 * The HTTP client is injected so the contract is testable without network.
 *
 * W9271: the probe now asks the host BY request_format, the same way the ENGINE
 * does (packages/llm factory.ts defaultAdapterRegistry speaks all three). The old
 * gate was a single `request_format !== "chat_completions"` refusal, so a row
 * declaring `responses` or `anthropic_messages` could be stored and displayed yet
 * never probed - a claim the engine's own capability contradicted. A format with no
 * probe implementation is still refused BY NAME before a socket is opened.
 *
 * The probe MIRRORS the engine's wire (see `probeAuth`) rather than speaking each
 * protocol "correctly" - a probe that guessed differently from the engine would lie
 * about the row in both directions.
 */

import { createRedactor } from "@celestea/core";
import { HttpTargetPolicy, requestOnce } from "@celestea/tools";

import { normalizeBaseUrl } from "./providers.js";
import { errText } from "./result.js";
import type { RequestFormat } from "./providers.js";

/**
 * W9271: the refusal now NAMES the format. The bare constant is the prefix and is
 * kept exported (providers.test.ts imports it), so an unknown protocol is still a
 * structured refusal - never a guessed dialect sent on the wire.
 */
export const UNSUPPORTED_FORMAT = "该请求格式暂不支持自动测试";
export const NO_API_KEY = "该提供商未配置 api_key";

/** The protocols this build has an engine adapter for - and therefore can probe. */
export const PROBE_PROTOCOLS = ["chat_completions", "responses", "anthropic_messages"] as const;
export type ProbeProtocol = (typeof PROBE_PROTOCOLS)[number];

/**
 * W9271: the auth headers the ENGINE would send for this format; `null` for a format
 * this build has no adapter for.
 *
 * Why MIRROR instead of "speaking the protocol correctly": this probe backs the
 * 获取模型 / 测试 button, whose promise is 「this row will work」. A probe that guessed a
 * different auth shape than the engine would lie in BOTH directions - it would bless a
 * row the engine then 401s, or reject a row the engine serves fine. So the source of
 * truth is the engine's own transport, not the protocol's spec.
 *
 * Measured fact (2026-10-02): the engine's transport
 * (`requestHeaders` in `packages/llm/src/transport.ts`) sends `authorization: Bearer`
 * for EVERY protocol, `anthropic_messages` included; the anthropic adapter adds only
 * the request BODY (`packages/llm/src/anthropic/wire.ts`). That is a real gap in the
 * adapter - it
 * claims a protocol whose native auth is `x-api-key` + `anthropic-version` - and it is
 * registered as P19 in `docs/pitfalls.md`. **When that adapter grows protocol-native
 * headers, this function must move with it**; writing the coupling down here is the
 * point, because the alternative is a probe that silently disagrees with the engine.
 *
 * Returning `null` for an unknown format is the fail-closed path: the caller refuses
 * BEFORE the SSRF check and before any byte leaves the process.
 */
export function probeAuth(format: string, key: string): Record<string, string> | null {
  if (!(PROBE_PROTOCOLS as readonly string[]).includes(format)) return null;
  return { accept: "application/json", authorization: `Bearer ${key}` };
}
/**
 * W815-13 (= W819-6): the target was refused by the deployment SSRF policy.
 * Deliberately generic - the resolver reason names the resolved IP, and that
 * internal address must not travel back to the caller.
 */
export const TARGET_FORBIDDEN = "该提供商地址被站点的 SSRF 策略拒绝（CELESTEA_HTTP_ALLOW / CELESTEA_HTTP_DENY）";

export interface ProbeResponse {
  status: number;
  text(): Promise<string>;
}

export interface ProbeInit {
  method: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}

export type ProbeFetch = (url: string, init: ProbeInit) => Promise<ProbeResponse>;

export interface ProbeCandidate {
  id: string;
  base_url: string;
  request_format: RequestFormat;
  api_key: string | null;
}

export interface ProbeOptions {
  /** Defaults to the global fetch; tests inject a recorder. */
  fetch?: ProbeFetch;
  /** The CURRENT generation's base_url + key (borrow source). */
  engineBaseUrl: string;
  engineKey: string | null;
  timeoutMs?: number;
  /**
   * W815-13: the deployment SSRF target policy. Default:
   * HttpTargetPolicy.fromEnv(env ?? process.env) - exactly the policy
   * http_request mounts, so a denied target is never dialed.
   */
  policy?: HttpTargetPolicy;
  /** Env for the default policy (tests / injected deployments). */
  env?: NodeJS.ProcessEnv;
}

export interface ProbeOutcome {
  ok: boolean;
  models?: Array<{ id: string }>;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** Probe bodies are model lists; 1 MiB is far beyond any real answer. */
export const PROBE_MAX_BODY_BYTES = 1024 * 1024;

/**
 * The production transport of a probe: one policy-approved, PINNED hop over
 * the same requestOnce http_request uses. pinnedIps makes the socket connect
 * to the exact address resolveChecked authorized, so a DNS rebind between
 * check and connect cannot carry the borrowed key to an internal address
 * (W738 check-then-use).
 */
function pinnedProbeFetch(pinnedIps: readonly string[], timeoutMs: number): ProbeFetch {
  return async (url, init) => {
    const result = await requestOnce({
      url: new URL(url),
      method: init.method,
      headers: Object.entries(init.headers),
      body: null,
      timeoutMs,
      maxBodyBytes: PROBE_MAX_BODY_BYTES,
      pinnedIps,
    });
    return { status: result.status, text: () => Promise.resolve(result.body) };
  };
}

/**
 * A bounded, REDACTED excerpt of an upstream body — the ONLY way this file may
 * quote bytes an upstream sent us.
 *
 * B2-01 (P0): both failure strings used to be `head(text, …)`, so an upstream
 * that echoes the `Authorization` header it received (many gateways quote the
 * bad key back in a 401/500) put the row's stored `api_key` straight into the
 * `{ok:false,error}` body that `/api/providers/test` and `/models/fetch` return.
 * That broke the frozen `endpoints.json` convention
 * `"no response ever contains api_key"`.
 *
 * Why the probe's OWN key is passed as a registered secret: a provider key is an
 * arbitrary vendor string (`9f8e7d6c…`), so no token-shape rule can be relied on.
 * `createRedactor`'s registered-secret pass replaces the literal value wherever it
 * appears, and its DEFAULT_RULES additionally cover the common `sk-…` /
 * `Bearer …` shapes for a key this process never held. The engine path
 * (`packages/llm/src/transport.ts:redact`) does the same for the same reason —
 * this is the probe half of that guard, not a second vocabulary.
 *
 * Order matters and is deliberate: REDACT FIRST, then truncate. Truncating first
 * could slice a secret in half and leave an unmatchable fragment behind.
 */
function safeHead(text: string, n: number, secrets: readonly (string | null)[] = []): string {
  const known = secrets.filter((s): s is string => typeof s === "string" && s !== "");
  const redacted = createRedactor(known).redact(text);
  return redacted.length <= n ? redacted : redacted.slice(0, n);
}

/** Which key a probe would use, and whether it was borrowed. NEVER logged. */
export function resolveProbeKey(candidate: ProbeCandidate, opts: ProbeOptions): { key: string | null; borrowed: boolean } {
  const own = candidate.api_key;
  if (typeof own === "string" && own !== "") return { key: own, borrowed: false };
  const sameOrigin = normalizeBaseUrl(candidate.base_url) === normalizeBaseUrl(opts.engineBaseUrl);
  if (sameOrigin && opts.engineKey !== null && opts.engineKey !== "") return { key: opts.engineKey, borrowed: true };
  return { key: null, borrowed: false };
}

function parseModels(text: string): Array<{ id: string }> | null {
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const rows = Array.isArray(body) ? body : (body as { data?: unknown }).data;
  if (!Array.isArray(rows)) return null;
  const out: Array<{ id: string }> = [];
  for (const row of rows) {
    const id = typeof row === "object" && row !== null ? (row as Record<string, unknown>)["id"] : undefined;
    if (typeof id === "string" && id !== "") out.push({ id });
  }
  return out;
}

/** GET `<base_url>/models`; every failure is a 200 body with `ok:false`. */
export async function probeModels(candidate: ProbeCandidate, opts: ProbeOptions): Promise<ProbeOutcome> {
  // W9271: a format with no probe implementation is refused BY NAME, before the
  // SSRF resolution and before any byte leaves the process - the same fail-closed
  // shape packages/llm's AdapterRegistry uses for an unregistered protocol.
  if (!(PROBE_PROTOCOLS as readonly string[]).includes(candidate.request_format)) {
    return { ok: false, error: `${UNSUPPORTED_FORMAT}：${candidate.request_format}` };
  }
  if ((candidate.base_url ?? "").trim() === "") return { ok: false, error: "base_url is required" };
  const { key } = resolveProbeKey(candidate, opts);
  if (key === null) return { ok: false, error: NO_API_KEY };
  // Read-only: every protocol probes the SAME model-list endpoint. The protocols
  // differ in how a REQUEST BODY is shaped, not in where the catalog lives.
  const headers = probeAuth(candidate.request_format, key);
  if (headers === null) return { ok: false, error: `${UNSUPPORTED_FORMAT}：${candidate.request_format}` };
  const url = `${candidate.base_url.replace(/\/+$/, "")}/models`;
  // W815-13: authorize the target with the SAME policy http_request uses
  // before a single byte leaves the process. An inactive policy (both env vars
  // unset) allows everything, so it neither resolves nor pins and the historical
  // host-fetch path is unchanged.
  const policy = opts.policy ?? HttpTargetPolicy.fromEnv(opts.env ?? process.env);
  let pinned: readonly string[] | null = null;
  try {
    if (policy.active) {
      const checked = await policy.resolveChecked(url);
      if (checked.reason !== null) return { ok: false, error: TARGET_FORBIDDEN };
      pinned = checked.ips;
    }
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
  const doFetch =
    opts.fetch ??
    (pinned === null
      ? (globalThis.fetch as unknown as ProbeFetch)
      : pinnedProbeFetch(pinned, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  // The pinned transport owns its own deadline; only the injected / host-fetch
  // paths keep the AbortSignal timeout (no dangling timer on the pinned path).
  const signal =
    opts.fetch === undefined && pinned !== null
      ? undefined
      : AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: ProbeResponse;
  try {
    res = await doFetch(url, {
      method: "GET",
      headers,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    return { ok: false, error: `summary response read failed: ${errText(e)}` };
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, error: `HTTP ${res.status}: ${safeHead(text, 300, [key])}` };
  }
  const models = parseModels(text);
  if (models === null) {
    return { ok: false, error: `response is not JSON (invalid body); body head: ${safeHead(text, 200, [key])}` };
  }
  return { ok: true, models };
}

export interface TestOutcome {
  ok: boolean;
  latency_ms?: number;
  model_count?: number;
  error?: string;
}

/** POST /api/providers/test — same probe, plus latency and model count. */
export async function testProvider(candidate: ProbeCandidate, opts: ProbeOptions, now: () => number = Date.now): Promise<TestOutcome> {
  const start = now();
  const outcome = await probeModels(candidate, opts);
  if (!outcome.ok) return { ok: false, error: outcome.error };
  const latency_ms = Math.max(0, Math.round(now() - start));
  return { ok: true, latency_ms, model_count: outcome.models?.length ?? 0 };
}
