/**
 * EX-03 —— §5 证据落盘 + Markdown 报告渲染。
 *
 * 纯搬家：evidence 的字段顺序、counts 的算法、render() 的每一条行文本，
 * 以及「写文件 → mkdir reports → 写 markdown → 打印 → 按 failed/degraded 定退出码」
 * 的先后次序，都与拆分前一致（退出码同样是 1 > 2 的判定顺序）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checks, type Check } from "./checks.js";
import { STUDIO } from "./runtime.js";

export interface Evidence {
  generatedAt: string;
  studio: string;
  policy: string;
  counts: { checks: number; passed: number; failed: number; degraded: number; endpointsSampled: number; sseEvents: number; tools: number };
  verdict: string;
  checks: Check[];
}

export function render(e: Evidence): string {
  const lines: string[] = [];
  lines.push("# Contract probe evidence (live :3777, read-only)");
  lines.push("");
  lines.push("- generated: " + e.generatedAt);
  lines.push("- target: " + e.studio);
  lines.push("- policy: " + e.policy);
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push("| metric | value |");
  lines.push("|---|---|");
  lines.push("| checks | " + e.counts.checks + " |");
  lines.push("| passed | " + e.counts.passed + " |");
  lines.push("| failed | " + e.counts.failed + " |");
  lines.push("| degraded | " + e.counts.degraded + " |");
  lines.push("| **endpoints sampled** | **" + e.counts.endpointsSampled + "** |");
  lines.push("| SSE event names frozen | " + e.counts.sseEvents + " |");
  lines.push("| tool specs | " + e.counts.tools + " |");
  lines.push("| verdict | " + e.verdict + " |");
  lines.push("");
  lines.push("## Checks");
  lines.push("");
  lines.push("| endpoint | kind | status | observed | detail |");
  lines.push("|---|---|---|---|---|");
  for (const c of e.checks) {
    lines.push("| " + c.endpoint + " | " + c.kind + " | " + c.status + " | " + (c.observedStatus ?? "-") + " | " + c.detail.replace(/\|/g, "\\|") + " |");
  }
  lines.push("");
  lines.push("## Mutation safety of the error-branch probes");
  lines.push("");
  lines.push("| endpoint | why it cannot mutate |");
  lines.push("|---|---|");
  for (const c of e.checks.filter((x) => x.safeBecause !== undefined)) lines.push("| " + c.endpoint + " | " + c.safeBecause + " |");
  lines.push("");
  return lines.join("\n");
}

export function buildEvidence(sseEventCount: number, toolCount: number): Evidence {
  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  const degradedCount = checks.filter((c) => c.status === "degraded").length;
  const endpointsSampled = new Set(checks.filter((c) => c.kind === "response-shape" || c.kind === "error-branch").map((c) => c.endpoint)).size;

  return {
    generatedAt: new Date().toISOString(),
    studio: STUDIO,
    policy: "read-only: GET probes + error branches proven mutation-free in the retired backend source",
    counts: { checks: checks.length, passed, failed, degraded: degradedCount, endpointsSampled, sseEvents: sseEventCount, tools: toolCount },
    verdict: failed > 0 ? "INCONSISTENT" : degradedCount > 0 ? "DEGRADED" : "consistent",
    checks,
  };
}

export function writeEvidence(evidence: Evidence): void {
  const root = resolve(join(import.meta.dirname ?? ".", "..", ".."));
  writeFileSync(join(root, "contracts", "probe-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(join(root, "reports", "contract-probe.md"), render(evidence));
}

/** §5 的控制台摘要 + 退出码：文案与优先级（failed 先于 degraded）逐字保留。 */
export function reportAndExit(evidence: Evidence): void {
  console.log("[verify-contracts] checks=" + evidence.counts.checks + " pass=" + evidence.counts.passed + " fail=" + evidence.counts.failed + " degraded=" + evidence.counts.degraded + " endpointsSampled=" + evidence.counts.endpointsSampled);
  for (const c of checks.filter((x) => x.status === "fail")) console.log("  FAIL " + c.endpoint + ": " + c.detail);
  for (const c of checks.filter((x) => x.status === "degraded")) console.log("  DEGRADED " + c.endpoint + ": " + c.detail);
  console.log("[verify-contracts] wrote contracts/probe-evidence.json + reports/contract-probe.md");
  if (evidence.counts.failed > 0) process.exit(1);
  if (evidence.counts.degraded > 0) process.exit(2);
}
