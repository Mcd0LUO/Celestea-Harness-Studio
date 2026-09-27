// @vitest-environment node
/**
 * W9220 · 执行架构棘轮：**vmThreads 主池 + forks 兜底**。
 *
 * 历史（为什么会有这个文件）：
 *   · W9219 先用「两池」——isolated（forks/isolate:true）+ shared（isolate:false，
 *     283 个实测 6/6 通过的白名单文件）。它在默认并发下墙钟与改动前**相同（都是 34 s）**，
 *     只把 worker 启动从 401 降到 121，却引入了一整套白名单机器
 *     （证据 JSON + 平台 fail-closed + 棘轮）。
 *   · W9219 **否决了 vmThreads**，依据是 `ERR_WORKER_INVALID_EXEC_ARGV`：
 *     「worker_threads 不接受本仓必需的 --expose-gc，池起不来」。
 *   · W9220 查明那**不是池的问题**：是那条 `execArgv` 被放在**顶层**（全局继承）。
 *     把它从顶层移走、只给真正需要 gc 的那一个文件单独开 forks project 后，
 *     vmThreads 完全可用：墙钟 **34 s → 20 s（−41%）**、CPU 264 → 230 CPU·s（−13%）、
 *     进程 133 → **6（−95%）**，且 3/3 全绿。
 *
 * 为什么 vmThreads 能免掉整套白名单：它给**每个测试文件一个独立 VM 上下文**，
 * 全局（globalThis.Node / navigator / 模块注册表）不跨文件泄漏 ——
 * 6 次 isolate:false 全量实测里那 21 个不稳定文件正是被这类泄漏害的，
 * 而它们在 vmThreads 下 3/3 全过。
 *
 * 本文件钉住 6 条（见 tests/lib/test-arch-rules.ts 的 POOL_RULES），并含 **★ 调包用例**：
 * 把 `pool: "vmThreads"` 换成等价形态、或把 execArgv 放回顶层，都必须变红。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { POOL_RULES, describeMissing, missingRules } from "./lib/test-arch-rules.js";

const ROOT = process.cwd();
const CONFIG = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");

describe("W9220 · vmThreads 执行架构", () => {
  it("① 配置按名满足全部执行架构契约（失败信息给出每条规则守的事实）", () => {
    expect(missingRules(POOL_RULES, CONFIG), describeMissing(POOL_RULES, CONFIG)).toEqual([]);
  });

  it("② 每条规则都有唯一名字（防止两条规则同名互相顶替）", () => {
    const names = POOL_RULES.map((r) => r.name);
    expect(new Set(names).size, "规则名必须唯一").toBe(names.length);
    for (const rule of POOL_RULES) {
      expect(rule.why.length, `规则 ${rule.name} 必须写明它守的事实`).toBeGreaterThan(8);
    }
  });

  it("③ ★ 调包用例：删掉「顶层不得有 execArgv」再加一条等价规则、条数不变 ⇒ 必须变红", () => {
    // 真实调包：把 execArgv 放回顶层（这正是 W9219 误判 vmThreads 的形态）。
    const swapped = CONFIG.replace(
      "    ...(TEST_WORKERS === undefined ? {} : { maxWorkers: TEST_WORKERS }),",
      "    ...(TEST_WORKERS === undefined ? {} : { maxWorkers: TEST_WORKERS }),\n    execArgv: [\"--expose-gc\"], // SWAPPED: 放回顶层 ⇒ vmThreads 池起不来",
    );
    expect(swapped, "前置：调包确实改了配置").not.toBe(CONFIG);
    // 条数不变 —— 「数条数」的门禁在这里会假绿。
    // 用**字面量**钉住条数（不能写 `expect(X.length).toBe(X.length)`，那是恒真的假断言）。
    expect(POOL_RULES.length, "规则条数必须被字面量钉住（删规则即红）").toBe(6);
    const missing = missingRules(POOL_RULES, swapped);
    expect(missing, "★ 顶层 execArgv 必须被抓到").toContain("no-top-level-execargv");
    expect(describeMissing(POOL_RULES, swapped)).toContain("no-top-level-execargv");
  });

  it("④ ★ 调包用例：主池换回 forks、条数不变 ⇒ 必须变红", () => {
    const swapped = CONFIG.replace('pool: "vmThreads",', 'pool: "forks", // SWAPPED: 退回一文件一进程');
    expect(swapped, "前置：调包确实改了配置").not.toBe(CONFIG);
    const missing = missingRules(POOL_RULES, swapped);
    expect(missing, "★ 主池退回 forks 必须被抓到").toContain("vm-pool");
  });

  it("⑤ forks 兜底集合必须非空，且三类文件都被真的兜住", () => {
    expect(CONFIG, "必须声明 CHDIR_FILES").toMatch(/const CHDIR_FILES = \["packages\/tools\/src\/guard\/w824-guard\.test\.ts"\]/);
    expect(CONFIG, "必须声明 GC_FILES").toMatch(/const GC_FILES = \["packages\/workers\/src\/tools\.test\.ts"\]/);
    expect(CONFIG, "必须声明 URL_SHIM_FILES").toMatch(/const URL_SHIM_FILES = \["tests\/frontend-r3-b5-attachments-dom\.test\.ts"\]/);
  });

  it("⑥ 顶层不得有 execArgv（worker 线程拒绝 --expose-gc 的直接护栏）", () => {
    // 独立再钉一次：这是 W9219 误判的根因，值得一条自己的用例（失败信息更直白）。
    // 顶层 = 4 空格缩进；project 级（10 空格）是 gc 兜底所必需的，不算违规。
    expect(CONFIG, "顶层 execArgv 会让整个 vmThreads 池起不来").not.toMatch(/^ {4}execArgv\s*:/m);
    expect(CONFIG, "gc 兜底 project 必须保留自己的 execArgv").toMatch(/^ {10}execArgv: \["--expose-gc"\],/m);
  });
});