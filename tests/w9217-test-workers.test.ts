// @vitest-environment node
/**
 * W9217 —— 测试并发上限：**只在真的降低时才设**。
 *
 * 背景：本仓有 399 个测试文件、`isolate` 默认 true（一个文件一个进程，每个约 600ms 启动），
 * 所以核多的开发机上 `pnpm test` 会同时起几十个 node 进程，整机不可用。
 *
 * 但「加一个上限」我连错两次，两次都在 **4 核 CI** 上把并发**提了上去**：
 *   v1  `return 8`                   ⇒ vitest 默认 3 被提到 8；
 *   v2  `min(8, max(cores-1, 1))`    ⇒ 理论等于默认，但 CI 恰在该提交开始红
 *                                       `main.test.ts` 的 SIGTERM 用例。
 * 而该套件是 `describe.skipIf(!POSIX_PROCESS_GROUPS)` —— 本机（Windows）**跳过**，
 * 所以我**无法本地复现**，也就无法证明 v2 无害。
 *
 * 现在的契约（本文件钉住）：**上限只在严格低于 vitest 默认时才发出**。
 * 不满足时**什么都不发** ⇒ 配置与「没有这个上限」逐字相同 ⇒ CI 不可能因此改变。
 *   32 核开发机 ⇒ 默认 31 > 8 ⇒ 设 8（机器仍可用）；
 *    4 核 CI     ⇒ 默认  3 < 8 ⇒ 不发（与改动前一致）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CONFIG = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");

describe("W9217 · 测试并发上限只在真的降低时才设", () => {
  it("① maxWorkers 必须由条件展开注入，不能无条件赋值", () => {
    expect(CONFIG, "默认不得无条件设置 maxWorkers").not.toMatch(/^\s*maxWorkers\s*:/m);
    expect(CONFIG, "maxWorkers 必须由条件展开注入").toMatch(
      /TEST_WORKERS === undefined \? \{\} : \{ maxWorkers: TEST_WORKERS \}/,
    );
  });

  it("② 必须复刻 vitest 的默认（cores-1），且只在严格更低时才返回数字", () => {
    expect(CONFIG, "必须算出 vitest 的默认 max(cores-1, 1)").toMatch(
      /Math\.max\(cores - 1, 1\)/,
    );
    expect(CONFIG, "必须「只在严格更低时才设」，否则 undefined").toMatch(
      /vitestDefault > DEFAULT_TEST_WORKERS \? DEFAULT_TEST_WORKERS : undefined/,
    );
  });

  it("③ 可用 CELESTEA_TEST_WORKERS 显式覆盖，且做有限性/正数校验", () => {
    expect(CONFIG, "必须支持 CELESTEA_TEST_WORKERS").toContain("CELESTEA_TEST_WORKERS");
    expect(CONFIG, "覆盖值必须校验，避免 NaN 传给 vitest").toMatch(
      /Number\.isFinite\(n\)[\s\S]{0,60}n > 0/,
    );
  });

  it("④ 注释必须点明真实默认与「无法本地复现」的取舍", () => {
    expect(CONFIG, "注释必须点明真实默认的形状").toMatch(/cores - 1|numCpus - 1|availableParallelism\(\) - 1/);
    expect(CONFIG, "注释必须说明为何不能随便改默认").toMatch(/SKIPS|跳过|无法本地复现/);
  });
});
