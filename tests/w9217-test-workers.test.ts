// @vitest-environment node
/**
 * W9217 —— 测试并发上限：**只在真的降低时才设**（W9219 Phase 2 改写）。
 *
 * 背景：本仓测试文件多、`isolate` 默认 true（一个文件一个进程，每个约 600ms 启动），
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
 *   32 核开发机 ⇒ 默认 31 > 16 ⇒ 设 16；
 *    4 核 CI     ⇒ 默认  3 >  2 ⇒ 设  2（更低的、更安全的值）。
 *
 * ★ W9219 改写说明（为什么不再逐条 match 配置字符串）：
 *   原版把契约写成 4 条 `expect(CONFIG).toMatch(/字面正则/)`。Phase 2 重构 `vitest.config.ts`
 *   后这些字面量会漂移，门禁变成「守注释拼写」而不是「守契约」。现在改为
 *   **按名判定**（`tests/lib/test-arch-rules.ts` 的 `WORKER_RULES`）：
 *   每条规则有唯一名字与它守的事实，失败信息直接给出原因。
 *   并补上**★ 调包用例**：删掉一条旧规则、再加一条**等价**的新规则、**条数不变**时，
 *   必须变红 —— 按条数记账的门禁抓不到这种调包（本仓 W9214 实测复现过该洞）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKER_RULES, describeMissing, missingRules } from "./lib/test-arch-rules.js";

const ROOT = process.cwd();
const CONFIG = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");

describe("W9217 · 测试并发上限只在真的降低时才设", () => {
  it("① 配置按名满足全部并发契约（失败信息给出每条规则守的事实）", () => {
    expect(missingRules(WORKER_RULES, CONFIG), describeMissing(WORKER_RULES, CONFIG)).toEqual([]);
  });

  it("② 每条规则都有唯一名字（防止两条规则同名互相顶替）", () => {
    const names = WORKER_RULES.map((r) => r.name);
    expect(new Set(names).size, "规则名必须唯一").toBe(names.length);
    for (const rule of WORKER_RULES) {
      expect(rule.why.length, `规则 ${rule.name} 必须写明它守的事实`).toBeGreaterThan(8);
    }
  });

  it("③ ★ 调包用例：删一条旧规则 + 加一条等价新规则、条数不变 ⇒ 必须变红", () => {
    // 真实调包：把「只降不升」判定换成一条**看起来等价**的规则（恒真），规则条数不变。
    const swapped = CONFIG.replace(
      "return half < vitestDefault ? half : undefined;",
      "return half; // SWAPPED: 去掉「只降不升」的闸门",
    );
    expect(swapped, "前置：调包确实改了配置").not.toBe(CONFIG);
    // 条数不变 —— 「数条数」的门禁在这里会假绿。
    // 用**字面量**钉住条数（不能写 `expect(X.length).toBe(X.length)`，那是恒真的假断言）。
    expect(WORKER_RULES.length, "规则条数必须被字面量钉住（删规则即红）").toBe(8);
    // 按名判定必须抓到 only-lower 缺失。
    const missing = missingRules(WORKER_RULES, swapped);
    expect(missing, "★ 调包必须变红（按名抓到 only-lower 缺失）").toContain("only-lower");
    expect(describeMissing(WORKER_RULES, swapped)).toContain("only-lower");
  });

  it("④ ★ 调包用例：删掉「禁止无条件 maxWorkers」也必须有牙", () => {
    // 反向调包：把条件展开换成无条件赋值（这正是 v1 事故的形态）。
    const swapped = CONFIG.replace(
      "...(TEST_WORKERS === undefined ? {} : { maxWorkers: TEST_WORKERS }),",
      "maxWorkers: 8, // SWAPPED: v1 事故形态（无条件提高并发）",
    );
    expect(swapped, "前置：调包确实改了配置").not.toBe(CONFIG);
    const missing = missingRules(WORKER_RULES, swapped);
    expect(missing, "★ 无条件 maxWorkers 必须被两条规则同时抓到").toContain("conditional-injection");
    expect(missing).toContain("no-unconditional-maxworkers");
  });

  it("⑤ 注释必须保留 v1/v2 两次事故与「无法本地复现」的取舍", () => {
    expect(CONFIG, "必须点明真实默认的形状").toMatch(/cores - 1|numCpus - 1|availableParallelism\(\) - 1/);
    expect(CONFIG, "必须说明为何不能随便改默认").toMatch(/SKIPS|跳过|无法本地复现/);
    expect(CONFIG, "必须保留实测代价曲线（Phase 2 必修项 2.3）").toMatch(/149 s/);
  });
});
