#!/usr/bin/env tsx
/**
 * Live contract verification against the running backend (:3777).
 *
 * READ-ONLY policy:
 *   - GET probes only for the 10 read endpoints
 *   - error-branch probes are restricted to paths that the retired backend source proves
 *     return BEFORE any mutation (validation guards) — see `safeBecause`
 *   - no POST /api/turn, no /api/clear, no provider/workspace/prompt writes
 *
 * Writes contracts/probe-evidence.json + reports/contract-probe.md.
 * Exits 1 when a probe disagrees with the frozen contract, 2 when a face could
 * not be probed at all (degraded; recorded, never a silent pass).
 *
 * W9265 / EX-03：main() 原本是 169 行的线性探针清单（docs/ARCHITECTURE.md §5 记为
 * EX-03）。按该处处方「探针清单抽成数据表（数组字面量）+ runProbe() 循环」拆到
 * scripts/contracts/ 下，本文件只剩编排：加载契约 → 跑 5 组探针 → 落盘 + 定退出码。
 * 各步骤的顺序、探针条数、断言与输出文案均逐字未变（见该目录各文件头注释）。
 */

import { loadEndpoints, loadSse, loadTools } from "@celestea/core";
import { probe } from "./lib/http.js";
import { pass } from "./contracts/checks.js";
import { runErrorProbes, runGetProbes } from "./contracts/probes.js";
import { runSseProbe } from "./contracts/sse-probe.js";
import { probeToolFaces } from "./contracts/tool-faces.js";
import { buildEvidence, reportAndExit, writeEvidence } from "./contracts/report.js";
import { STUDIO, TIMEOUT } from "./contracts/runtime.js";

async function main(): Promise<void> {
  const contract = loadEndpoints();
  const sse = loadSse();
  const tools = loadTools();

  // ---- 0. contract self-consistency ---------------------------------------
  // NOTE: loadEndpoints()/loadSse()/loadTools() already THROW on a count
  // mismatch, so these lines record the frozen count as evidence; the numbers
  // come from the contracts themselves (never a hard-coded literal that can
  // silently rot).
  pass("contracts/endpoints.json", "contract-count", `${contract.endpoints.length} endpoints (contract declares ${contract.count})`, undefined);
  pass("contracts/sse-events.json", "contract-count", `${sse.events.length} SSE events (contract declares ${sse.count})`, undefined);
  pass("contracts/tools.json", "contract-count", `${tools.tools.length} tool specs (contract declares ${tools.count})`, undefined);

  // ---- 1. GET endpoints: status + top-level response shape ----------------
  const sessionList = await probe(STUDIO, "/api/sessions", { timeoutMs: TIMEOUT });
  const sampleSessionId =
    ((sessionList.json as { sessions?: Array<{ id?: string }> }).sessions ?? []).find((x) => typeof x.id === "string")?.id ?? "sample-ws/sample-session";

  // W516: the four grant endpoints are TypeScript-only (probe.checked === false
  // points at the retired backend) — they are not probed here.
  const probeable = contract.endpoints.filter((x) => x.probe?.checked !== false);
  await runGetProbes(probeable, sampleSessionId);

  // ---- 2. read-only error branches (mutation-proof) ----------------------
  await runErrorProbes();

  // ---- 3. SSE transport --------------------------------------------------
  await runSseProbe(sse.events.length);

  // ---- 4. live tool set (session-explicit; W803 probe follow-up) ----------
  const sessions = (((sessionList.json as { sessions?: Array<{ id?: string; mode?: string }> }).sessions) ?? [])
    .filter((s): s is { id: string; mode?: string } => typeof s.id === "string");
  const contractNames = tools.tools.map((t) => t.name).sort();
  await probeToolFaces(sessions, contractNames);

  // ---- 5. report ---------------------------------------------------------
  const evidence = buildEvidence(sse.events.length, tools.tools.length);
  writeEvidence(evidence);
  reportAndExit(evidence);
}

main().catch((err: unknown) => {
  console.error(`[verify-contracts] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
