#!/usr/bin/env tsx
/**
 * Replay comparison harness (P0 skeleton) —— **入口/调度层**。
 *
 * Reads fixtures/ -> replays every session through the TS implementation ->
 * writes a structured diff report to reports/.
 *
 * Compared:
 *   A. Studio messages projection  vs GET /api/sessions/{id}/messages (GOLDEN, from the frozen legacy capture)
 *   B. engine derive_messages      vs the TS-derived expectation (self-consistency; P1 makes it golden)
 *   C. SSE transcript              vs the stored derivation (determinism)
 *   D. providers public_view       vs the api_key-free contract
 *   E. registry.tsv round-trip     vs the stored parse
 *
 * `--strict` exits non-zero when a GOLDEN comparison (A) diverges.
 *
 * W9266（EX-04）：A–E 五组对比原本全部内联在 main() 里，把它顶到 115 行
 * （ESLint max-lines-per-function 上限 100）。现在每组对比各归一
 * compareX()（见 scripts/replay/），main() 只做「调度 + 汇总 + 落盘 + 退出码」。
 * 这次是**纯搬家**：报告文本、JSON 字段顺序、退出码逐字不变。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { bool, num, parseArgs, str } from "./lib/args.js";
import { compareProvidersPublicView, compareRegistryRoundTrip } from "./replay/compare-global.js";
import { compareSession } from "./replay/compare-sessions.js";
import { buildReport, renderMarkdown, tally } from "./replay/report.js";
import { readJson } from "./replay/shared.js";
import type { CompareCtx, Finding, Manifest, ReplayConfig, SessionReport } from "./replay/types.js";

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const cfg: ReplayConfig = {
    fixtures: resolve(str(args, "fixtures", "fixtures")),
    reports: resolve(str(args, "reports", "reports")),
    strict: bool(args, "strict"),
    maxShown: num(args, "max-diffs", 5),
  };

  if (!existsSync(cfg.fixtures)) {
    throw new Error(`fixtures directory not found: ${cfg.fixtures} (run \`pnpm golden:export\` first)`);
  }
  mkdirSync(cfg.reports, { recursive: true });
  const manifest = readJson<Manifest>(join(cfg.fixtures, "index.json"));

  const findings: Finding[] = [];
  const sessions: SessionReport[] = [];
  const ctx: CompareCtx = { findings, maxShown: cfg.maxShown, fixtures: cfg.fixtures };

  // A / B / C —— 逐会话三组对拍（会话表在这里一行行长出来）。
  for (const entry of manifest.sessions) {
    sessions.push(compareSession(ctx, entry));
  }

  // D / E —— 全局两组对拍（不挂在任何单个会话上）。
  compareProvidersPublicView(ctx);
  compareRegistryRoundTrip(ctx);

  const counts = tally(sessions, findings);
  const report = buildReport(cfg, manifest.generatedAt, sessions, findings);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(cfg.reports, "replay-diff.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(cfg.reports, `replay-diff-${stamp}.json`), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(cfg.reports, "replay-diff.md"), renderMarkdown(report));

  console.log(`[compare-replay] sessions=${sessions.length} goldenDivergences=${counts.goldenDivergences} selfCheckDivergences=${counts.selfDivergences} errors=${counts.errors}`);
  for (const s of sessions) {
    console.log(
      `  ${s.goldenVerdict === "match" ? "OK  " : "DIFF"} ${s.id} events=${s.events} turns=${s.turns} messages=${s.messages.actual}/${s.messages.golden} dangling=${s.danglingToolCalls} subCalls=${s.subCalls}`,
    );
  }
  console.log(`[compare-replay] wrote ${join(cfg.reports, "replay-diff.md")}`);

  if (counts.errors > 0) process.exit(2);
  if (cfg.strict && counts.goldenDivergences > 0) process.exit(1);
}

main();
