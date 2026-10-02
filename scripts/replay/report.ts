/**
 * 报告的两半：JSON 对象组装 + Markdown 渲染。
 *
 * 两段都逐字搬自 compare-replay.ts（buildReport / renderMarkdown），
 * 字段顺序、表格文案、finding 转义规则一字未改 —— 报告文本必须逐字不变。
 */

import type { Finding, ReplayConfig, ReportShape, SessionReport } from "./types.js";

/** 退出码判定与 buildReport 共用的三个计数（口径必须一致，故抽出来）。 */
export interface Tally {
  goldenDivergences: number;
  selfDivergences: number;
  errors: number;
}

export function tally(sessions: SessionReport[], findings: Finding[]): Tally {
  return {
    goldenDivergences: sessions.reduce((n, s) => n + s.messages.divergences, 0),
    selfDivergences: sessions.reduce((n, s) => n + s.derived.divergences + s.sse.divergences, 0),
    errors: findings.filter((f) => f.kind === "error").length,
  };
}

/**
 * 组装 report 对象。
 *
 * 字段顺序与原 main() 里的对象字面量逐字一致（JSON 产物靠它做 diff）。
 * verdict 的判定次序（errors 优先于 goldenDivergences）保持不变。
 */
export function buildReport(
  cfg: ReplayConfig,
  manifestGeneratedAt: string,
  sessions: SessionReport[],
  findings: Finding[],
): ReportShape & { fixtures: string } {
  const t = tally(sessions, findings);
  return {
    generatedAt: new Date().toISOString(),
    fixtures: cfg.fixtures,
    fixturesGeneratedAt: manifestGeneratedAt,
    strict: cfg.strict,
    summary: {
      sessions: sessions.length,
      goldenComparisons: sessions.length,
      goldenDivergences: t.goldenDivergences,
      selfCheckDivergences: t.selfDivergences,
      errors: t.errors,
      verdict: t.errors > 0 ? "error" : t.goldenDivergences > 0 ? "divergence" : "match",
    },
    sessions,
    findings,
  };
}

export function renderMarkdown(r: ReportShape): string {
  const lines: string[] = [];
  lines.push("# Replay diff report (P0 toolchain)");
  lines.push("");
  lines.push(`- generated: ${r.generatedAt}`);
  lines.push(`- fixtures generated: ${r.fixturesGeneratedAt}`);
  lines.push(`- strict: ${r.strict}`);
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push(`| metric | value |`);
  lines.push("|---|---|");
  lines.push(`| sessions replayed | ${r.summary.sessions} |`);
  lines.push(`| golden comparisons (Studio messages projection) | ${r.summary.goldenComparisons} |`);
  lines.push(`| **golden divergences** | **${r.summary.goldenDivergences}** |`);
  lines.push(`| self-check divergences | ${r.summary.selfCheckDivergences} |`);
  lines.push(`| structural errors | ${r.summary.errors} |`);
  lines.push(`| verdict | ${r.summary.verdict} |`);
  lines.push("");
  lines.push("## Sessions");
  lines.push("");
  lines.push("| session | roles | events | turns | dangling tool_call | sub-calls (parent_id) | torn tail | turn ids monotonic | outcomes | messages (ts/golden) | golden |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of r.sessions) {
    lines.push(
      `| ${s.id} | ${s.roles.join(", ")} | ${s.events} | ${s.turns} | ${s.danglingToolCalls} | ${s.subCalls} | ${s.tornTail ? "yes" : "no"} | ${s.turnIdMonotonic ? "yes" : "NO"} | ${JSON.stringify(s.outcomes)} | ${s.messages.actual}/${s.messages.golden} | ${s.goldenVerdict} |`,
    );
  }
  lines.push("");
  lines.push("## Findings");
  lines.push("");
  if (r.findings.length === 0) lines.push("_none_");
  else {
    lines.push("| scope | kind | detail |");
    lines.push("|---|---|---|");
    for (const f of r.findings) lines.push(`| ${f.scope} | ${f.kind} | ${f.detail.replace(/\|/g, "\\|")} |`);
  }
  lines.push("");
  lines.push("## What is (and is not) golden at P0");
  lines.push("");
  lines.push("- **Golden (from the frozen legacy capture)**: the Studio `messages` projection via `GET /api/sessions/{id}/messages`.");
  lines.push("- **Self-check only**: engine `derive_messages` and the SSE transcript — the engine exposes no HTTP surface for them, so the TS reference implementation is compared against its own stored derivation. P1 turns both into golden comparisons.");
  lines.push("- A non-empty diff at this stage is expected to be reported, not hidden: `pnpm replay:compare --strict` fails the run when the golden comparison diverges.");
  lines.push("");
  return lines.join("\n");
}
