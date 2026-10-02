/**
 * EX-03 —— 响应形状比较用到的纯函数（顶层键 / 契约字段名 / 占位符展开）。
 *
 * 纯搬家：函数体逐字保留，连带 BESPOKE_GET 这张「TypeScript-only 端点不能用通用
 * 顶层键比较」的分派表一起搬过来，判定与 detail 文案一字未改。
 */
import type { EndpointContract } from "@celestea/core";
import type { ProbeResult } from "../lib/http.js";

/**
 * W767 added two TypeScript-only endpoints that are not plain JSON GETs, so a
 * generic top-level-key comparison misreports both. Each gets its own honest
 * assertion instead of a silent skip: /login is HTML, and /auth/check is
 * cookie-gated — with no cookie the documented 401 branch IS the answer.
 */
export const BESPOKE_GET: Record<string, (res: ProbeResult) => { ok: boolean; detail: string }> = {
  get_login: (res) => ({
    ok: res.status === 200 && (res.headers["content-type"] ?? "").includes("text/html"),
    detail: `HTTP ${res.status}; HTML login page (${(res.headers["content-type"] ?? "no content-type").split(";")[0]}) — no JSON keys to compare`,
  }),
  get_auth_check: (res) => ({
    ok: res.status === 401 && res.text.includes("unauthorized"),
    detail: `HTTP ${res.status}; cookie-gated, so the documented 401 "unauthorized" branch is the correct answer for an unauthenticated probe`,
  }),
};

/** Top-level keys of the live body, used for shape comparison. */
export function topKeys(body: unknown): string[] {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return [];
  return Object.keys(body as Record<string, unknown>).sort();
}

/** Contract field names, normalized ("(same shape as GET /api/config)" etc. ignored). */
export function contractFieldNames(e: EndpointContract, includeOptional = true): string[] {
  return e.response.fields
    .filter((f) => includeOptional || f.optional !== true)
    .map((f) => f.name)
    .filter((n) => /^[a-z_][a-z0-9_]*$/.test(n))
    .sort();
}

/** Fill {placeholders} with values that keep the probe read-only. */
export function concreteProbePath(path: string, sampleSessionId: string): string {
  return path
    .replace("{id}", encodeURIComponent(sampleSessionId))
    .replace("{name}", "sample-workspace")
    .replace("{*path}", "sample.js");
}
