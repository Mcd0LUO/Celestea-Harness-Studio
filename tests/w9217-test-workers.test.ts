// @vitest-environment node
/**
 * W9217 —— 测试 worker 上限必须存在且可调。
 *
 * 为什么需要门禁：vitest 5 的 `maxWorkers` **默认等于 CPU 核数**。本仓有 399 个测试文件、
 * 且 `isolate` 默认 true（一个文件一个进程）。在 32 核开发机上，`pnpm test` 会同时起
 * 32 个 node 进程，整机在跑测试期间不可用。这类「默认值」很容易在后续重构里被悄悄删掉
 * （删掉后**一切照常绿**，只是机器又被打满），所以必须钉住。
 *
 * 判据（三条，缺一不可）：
 *   ① vitest.config.ts 里必须有 maxWorkers，且取自可覆盖的常量；
 *   ② 默认值必须是一个**有界的小数**，不是 CPU 核数；
 *   ③ 必须能用环境变量覆盖（本地要能调回去，CI 也可能需要调）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CONFIG = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");

describe("W9217 · 测试并发上限", () => {
  it("① 配置里设置了 maxWorkers（否则默认吃满所有核）", () => {
    expect(CONFIG, "vitest.config.ts 必须设置 maxWorkers").toMatch(/\bmaxWorkers\s*:/);
  });

  it("② 默认上限是一个有界的小数，而不是 CPU 核数", () => {
    // 取出 TEST_WORKERS 的默认分支（形如 `return 8;`）。
    const m = /const TEST_WORKERS[\s\S]*?return (\d+);/.exec(CONFIG);
    expect(m, "TEST_WORKERS 必须有数字默认值").not.toBeNull();
    const def = Number(m?.[1]);
    expect(Number.isFinite(def) && def > 0, "默认上限必须是正整数").toBe(true);
    // 32 核的机器上默认吃满就是这里要防的；给一个明确的上界。
    expect(def, "默认上限不应超过 16（否则在 32 核机器上仍会吃满）").toBeLessThanOrEqual(16);
  });

  it("③ 可用环境变量覆盖（本地/CI 都要能调）", () => {
    expect(CONFIG, "必须支持 CELESTEA_TEST_WORKERS 覆盖").toContain("CELESTEA_TEST_WORKERS");
    expect(CONFIG, "覆盖值必须做有限性/正数校验，避免 NaN 传给 vitest").toMatch(
      /Number\.isFinite\(n\)[\s\S]{0,60}n > 0/,
    );
  });
});
