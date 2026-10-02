/**
 * A/B/C 三组「逐会话」对拍 + 会话表组装。
 *
 * 逐字搬自 compare-replay.ts 的 main() 循环体；行为、finding 顺序、
 * 报告字段全部不变，唯一的结构变化是每个阶段有自己的函数。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeReplay, deriveMessages, deriveSseTranscript, parseSessionJsonl, projectMessages } from "@celestea/session";
import type { SessionEvent } from "@celestea/core";

import { compareLists, readJson } from "./shared.js";
import type { CompareCtx, ManifestEntry, SessionReport } from "./types.js";

/**
 * B / C 两组的计数三元组。
 *
 * A 组（messages 投影）在 SessionReport 里用的是 `golden` 而不是 `expected`
 * （SessionReport.messages 的历史字段名），故 A 不复用本类型，直接给字面量。
 */
export interface Triple {
  expected: number;
  actual: number;
  divergences: number;
}

/** A 组的计数：字段名是 golden（不是 expected），与 SessionReport.messages 同形。 */
export interface MessagesCount {
  golden: number;
  actual: number;
  divergences: number;
}

/**
 * A. Studio messages projection vs GET /api/sessions/{id}/messages
 *    （GOLDEN，来自冻结的 legacy capture）。
 *
 * 读 cli-main.jsonl → 解析 → 投影 → 与 messages-expected.json 逐项对拍。
 * 顺带返回 analyzeReplay() 的统计（会话表要用），使 jsonl 只被解析一次。
 */
export function compareMessagesProjection(
  ctx: CompareCtx,
  entry: ManifestEntry,
): { events: SessionEvent[]; stats: ReturnType<typeof analyzeReplay>; count: MessagesCount } {
  const dir = join(ctx.fixtures, "sessions", entry.slug);
  const parsed = parseSessionJsonl(readFileSync(join(dir, "cli-main.jsonl"), "utf8"));
  const stats = analyzeReplay(parsed);
  const actualMessages = projectMessages(parsed.events);
  const golden = readJson<{ messages: unknown[] }>(join(dir, "messages-expected.json")).messages;
  const msgDiv = compareLists(ctx, `${entry.id} :: messages-projection`, golden, actualMessages, "golden-divergence");
  return {
    events: parsed.events,
    stats,
    count: { golden: golden.length, actual: actualMessages.length, divergences: msgDiv },
  };
}

/** B. engine derive_messages vs 存储的推导结果（自洽检查；P1 转正为 golden）。 */
export function compareDerivedMessages(
  ctx: CompareCtx,
  id: string,
  slug: string,
  events: readonly SessionEvent[],
): Triple {
  const dir = join(ctx.fixtures, "sessions", slug);
  const derivedExpected = readJson<{ messages: unknown[] }>(join(dir, "derive-messages-expected.json")).messages;
  const actualDerived = deriveMessages(events);
  const derivedDiv = compareLists(ctx, `${id} :: derive-messages`, derivedExpected, actualDerived, "self-check-divergence");
  return { expected: derivedExpected.length, actual: actualDerived.length, divergences: derivedDiv };
}

/**
 * C. SSE transcript vs 存储的推导结果（确定性检查）。
 *
 * 存了 sse-transcript-derived.jsonl 就对拍；没存（大会话不落盘）就记一条
 * info finding 并在内存里重算一遍 —— 两种分支的计数口径与原 main() 相同。
 */
export function compareSseTranscript(
  ctx: CompareCtx,
  id: string,
  slug: string,
  events: readonly SessionEvent[],
): Triple {
  const ssePath = join(ctx.fixtures, "sessions", slug, "sse-transcript-derived.jsonl");
  let sseDiv = 0;
  let sseCount = 0;
  if (existsSync(ssePath)) {
    const sseExpected = readFileSync(ssePath, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as unknown);
    const actualSse = deriveSseTranscript(events) as unknown[];
    sseCount = actualSse.length;
    sseDiv = compareLists(ctx, `${id} :: sse-transcript`, sseExpected, actualSse, "self-check-divergence");
  } else {
    ctx.findings.push({
      scope: `${id} :: sse-transcript`,
      kind: "info",
      detail: "derived transcript not stored (large session); regenerated in-memory for this run",
    });
    sseCount = deriveSseTranscript(events).length;
  }
  return { expected: sseCount, actual: sseCount, divergences: sseDiv };
}

/** 跑完一个会话的 A/B/C 三组对比，组装它在报告里的那一行。 */
export function compareSession(ctx: CompareCtx, entry: ManifestEntry): SessionReport {
  const a = compareMessagesProjection(ctx, entry);
  const derived = compareDerivedMessages(ctx, entry.id, entry.slug, a.events);
  const sse = compareSseTranscript(ctx, entry.id, entry.slug, a.events);
  return {
    id: entry.id,
    slug: entry.slug,
    roles: entry.roles,
    events: a.events.length,
    turns: a.stats.turnStarts,
    danglingToolCalls: a.stats.danglingToolCalls.length,
    orphanToolResults: a.stats.orphanToolResults.length,
    subCalls: a.stats.subCalls,
    tornTail: a.stats.tornTail !== null,
    turnIdMonotonic: a.stats.turnIds.nonMonotonic.length === 0 && a.stats.turnIds.duplicates.length === 0,
    outcomes: a.stats.outcomes,
    messages: a.count,
    derived,
    sse,
    goldenVerdict: a.count.divergences === 0 ? "match" : "divergence",
  };
}
