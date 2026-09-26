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

  it("② 上限常量本身是一个有界的小数（不是核数）", () => {
    // 默认值由 DEFAULT_TEST_WORKERS 承载，再对核数取 min（见 ④）。
    const m = /const DEFAULT_TEST_WORKERS = (\d+);/.exec(CONFIG);
    expect(m, "必须有 DEFAULT_TEST_WORKERS 数字常量").not.toBeNull();
    const def = Number(m?.[1]);
    expect(Number.isFinite(def) && def > 0, "上限必须是正整数").toBe(true);
    // 32 核的机器上默认吃满就是这里要防的；给一个明确的上界。
    expect(def, "上限不应超过 16（否则在 32 核机器上仍会吃满）").toBeLessThanOrEqual(16);
  });

  it("③ 可用环境变量覆盖（本地/CI 都要能调）", () => {
    expect(CONFIG, "必须支持 CELESTEA_TEST_WORKERS 覆盖").toContain("CELESTEA_TEST_WORKERS");
    expect(CONFIG, "覆盖值必须做有限性/正数校验，避免 NaN 传给 vitest").toMatch(
      /Number\.isFinite\(n\)[\s\S]{0,60}n > 0/,
    );
  });

  /**
   * ★ 上限**只降不升** —— 这条是本文件存在的核心理由。
   *
   * 第一版无条件 return 8。在 32 核开发机上那是「限制」，但在 **4 核的 GitHub runner**
   * 上，vitest 的默认本来就是 4，而 8 把并发**提高了一倍** —— 时序敏感套件随即开始
   * 间歇性失败（win24 绿 / win26 红，ubuntu24 红 / ubuntu26 绿，典型 flaky）。
   * **上限若会提高负载，它就不是上限。**
   *
   * 判据：默认分支必须对核数取 min，不能是裸字面量。
   */
  it("★ ④ 默认上限对核数取 min —— 上限不许提高并发", () => {
    expect(
      CONFIG,
      "默认上限必须 min(上限, 核数)：裸字面量会在小核 CI 上把并发提上去",
    ).toMatch(/Math\.min\(\s*DEFAULT_TEST_WORKERS\s*,\s*availableParallelism\(\)\s*\)/);
    // 并且必须真的 import 了 availableParallelism（否则上面那行是假的）。
    expect(CONFIG, "必须从 node:os 引入 availableParallelism").toMatch(
      /import\s*\{[^}]*availableParallelism[^}]*\}\s*from\s*"node:os"/,
    );
  });
});
