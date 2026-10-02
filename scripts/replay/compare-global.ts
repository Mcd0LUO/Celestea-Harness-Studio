/**
 * D / E 两组「全局」对拍（不挂在任何单个会话上）。
 *
 * 逐字搬自 compare-replay.ts 的 main()；finding 顺序与文本一字未改。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRegistryTsv, serializeRegistryTsv, summarize } from "@celestea/workers";

import { compareLists, readJson } from "./shared.js";
import type { CompareCtx } from "./types.js";

/**
 * D. providers public_view vs 不含 api_key 的契约。
 *
 * 返回 provider 数量（原 main() 里的 providerCount，仅供调试，不进报告）。
 */
export function compareProvidersPublicView(ctx: CompareCtx): number {
  const providersPath = join(ctx.fixtures, "providers", "public-view.json");
  let providerCount = 0;
  if (existsSync(providersPath)) {
    const text = readFileSync(providersPath, "utf8");
    if (text.includes('"api_key"')) ctx.findings.push({ scope: "providers public_view", kind: "error", detail: 'contains the string "api_key"' });
    const body = readJson<{ body: { providers: Array<Record<string, unknown>> } }>(providersPath).body;
    providerCount = body.providers.length;
    const allowed = new Set(["id", "name", "note", "base_url", "request_format", "models", "is_default", "has_key"]);
    for (const p of body.providers) {
      for (const k of Object.keys(p)) if (!allowed.has(k)) ctx.findings.push({ scope: `providers public_view ${String(p["id"])}`, kind: "error", detail: `unexpected key '${k}'` });
    }
    ctx.findings.push({ scope: "providers public_view", kind: "info", detail: `${providerCount} provider(s), 0 api_key keys` });
  }
  return providerCount;
}

/**
 * E. registry.tsv 的 parse 对拍 + serialize(parse(x)) == x 往返。
 *
 * 返回行数（原 main() 里的 registryRows，仅供调试，不进报告）。
 */
export function compareRegistryRoundTrip(ctx: CompareCtx): number {
  const registryTsv = join(ctx.fixtures, "workers", "registry.tsv");
  let registryRows = 0;
  if (existsSync(registryTsv)) {
    const raw = readFileSync(registryTsv, "utf8");
    const reparsed = parseRegistryTsv(raw);
    registryRows = reparsed.entries.length;
    const stored = readJson<{ entries: unknown[]; summary: unknown }>(join(ctx.fixtures, "workers", "registry-parsed.json"));
    compareLists(ctx, "registry.tsv :: parse", stored.entries, reparsed.entries, "self-check-divergence");
    const roundTrip = serializeRegistryTsv(reparsed.entries);
    if (roundTrip !== raw) ctx.findings.push({ scope: "registry.tsv :: round-trip", kind: "self-check-divergence", detail: "serialize(parse(x)) != x" });
    const sum = summarize(reparsed.entries);
    ctx.findings.push({ scope: "registry.tsv", kind: "info", detail: `${registryRows} row(s) by_status=${JSON.stringify(sum.by_status)}` });
  }
  return registryRows;
}
