import { readFileSync } from "node:fs";
import { firstJsonDiff } from "@celestea/core";

import type { CompareCtx, Finding } from "./types.js";

/** 读并解析一个 JSON 文件（原先的 readJson<T>()，逐字未改）。 */
export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * 逐项对拍两个数组，把差异写进 ctx.findings，返回差异数。
 *
 * 逻辑逐字搬自 compare-replay.ts 的 compareLists()，唯一变化是 findings 与
 * maxShown 由 ctx 传入（原为模块级 const）：两处行为（长度差异先报、最多
 * 展示 maxShown 条、余下的合并成一条 "and N more"）完全不变。
 */
export function compareLists(
  ctx: CompareCtx,
  scope: string,
  expected: readonly unknown[],
  actual: readonly unknown[],
  kind: Finding["kind"],
): number {
  let divergences = 0;
  if (expected.length !== actual.length) {
    ctx.findings.push({ scope, kind, detail: `length ${expected.length} != ${actual.length}` });
    divergences += 1;
  }
  const n = Math.min(expected.length, actual.length);
  let shown = 0;
  for (let i = 0; i < n; i++) {
    const d = firstJsonDiff(expected[i], actual[i], `$[${i}]`);
    if (d === null) continue;
    divergences += 1;
    if (shown < ctx.maxShown) {
      ctx.findings.push({ scope, kind, detail: d });
      shown += 1;
    }
  }
  if (divergences > shown) ctx.findings.push({ scope, kind, detail: `... and ${divergences - shown} more divergence(s) suppressed` });
  return divergences;
}
