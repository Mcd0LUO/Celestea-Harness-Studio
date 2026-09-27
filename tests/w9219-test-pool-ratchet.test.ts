// @vitest-environment node
/**
 * W9219 · 两池测试架构的**白名单 + 平台**棘轮（fail-closed）。
 *
 * 架构：`vitest.config.ts` 把测试文件分成三个 project ——
 *   · `isolated`（isolate 默认 true，一文件一进程）—— **默认归宿**；
 *   · `shared`  （isolate:false，共享进程）—— 只装 `shared-pool-allowlist.json`，且**只在 win32 启用**；
 *   · `real-backend`（默认零文件，CELESTEA_E2E=1 才装载）。
 *
 * 为什么只能白名单、不能全局共享：6 次全量 isolate:false 实测的不稳定并集有 21 个文件，
 * 且**没有一个是 6/6 失败**（见 `shared-pool-evidence.json` 的 passCount）。这是跨文件
 * 不确定性，不是某个文件的固有缺陷 —— 全局共享会让这些文件随机变红。
 * 根因已钉死：共享进程下 DOM 垫片 `tests/lib/w1467-dom.ts` 的 `globalThis.Node` 等
 * 全局会泄漏给后续文件，使 chai 的 `actual instanceof Node` 抛
 * `TypeError: Right-hand side of 'instanceof' is not callable`（实测 288 个白名单文件里
 * 98 个因此变红，isolated 池 0 个）。
 *
 * ★ 平台 fail-closed（W9219 Phase 2，发起者必修项 2.1）：白名单证据**只在 Windows 采集**，
 *   而白名单里有 20 个带**条件跳过（平台或能力探测）**的文件（`skipIf(!posixShell)` / `skipIf(!POSIX_PROCESS_GROUPS)`…）。
 *   它们在 Windows 上的「6/6」是**空洞的**（被跳过的用例没验证），到 Linux 却会**真跑**；
 *   最危险的是 `apps/studio/src/main.test.ts` 的 SIGTERM 用例 —— 正是本仓历史 CI 事故那条。
 *   所以 shared 池**只在 win32 启用**，其它平台全走 isolated（= 改动前行为）⇒ ubuntu CI 零变化。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWLIST_PLATFORM,
  SHARED_POOL_PLATFORM,
  sharedPoolEnabled,
  sharedPoolFiles,
} from "./lib/shared-pool-policy.js";
import { POOL_RULES, describeMissing, missingRules } from "./lib/test-arch-rules.js";

const ROOT = process.cwd();
const readJson = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

const ALLOW = readJson("tests/lib/shared-pool-allowlist.json") as {
  platform: string;
  shared: string[];
  reviewedDemotions?: Array<{ file: string; reason: string }>;
};
const EVIDENCE = readJson("tests/lib/shared-pool-evidence.json") as {
  platform: string;
  totalRuns: number;
  stable: string[];
  passCount: Record<string, number>;
};
const CONFIG = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");

/** 证据里「每次全量都没出现失败用例」的文件集合（阈值 = 全部运行次数）。 */
const FULLY_STABLE = new Set(EVIDENCE.stable.filter((f) => EVIDENCE.passCount[f] === EVIDENCE.totalRuns));
/** 复核降级：实测「单独跑过、共享跑红」或「已知 flaky」的文件。 */
const DEMOTED = new Set((ALLOW.reviewedDemotions ?? []).map((d) => d.file));

describe("W9219 · shared 池白名单 fail-closed", () => {
  it("① 不在白名单里的文件默认进 isolated 池（fail-closed 的核心）", () => {
    const allow = new Set(sharedPoolFiles("win32"));
    const me = "tests/w9219-test-pool-ratchet.test.ts";
    expect(allow.has(me), "棘轮文件自身不得进 shared 池").toBe(false);
    const poolOf = (f: string): "shared" | "isolated" => (allow.has(f) ? "shared" : "isolated");
    expect(poolOf(me)).toBe("isolated");
    expect(poolOf("tests/definitely-not-in-allowlist.test.ts")).toBe("isolated");
    expect(poolOf([...allow][0]!)).toBe("shared");
  });

  it("② 白名单每一项都有原始数据支撑：6/6 通过，或已登记复核降级", () => {
    const unsupported = ALLOW.shared.filter((f) => !FULLY_STABLE.has(f) && !DEMOTED.has(f));
    expect(unsupported, "白名单不得收「没有 6/6 实测支撑」的文件（fail-closed）").toEqual([]);
    const stillListed = [...DEMOTED].filter((f) => ALLOW.shared.includes(f));
    expect(stillListed, "已复核降级的文件必须从白名单移除").toEqual([]);
    expect(EVIDENCE.totalRuns).toBeGreaterThanOrEqual(2);
    expect(EVIDENCE.stable.length).toBeGreaterThan(0);
  });

  it("③ 白名单无重复项、无已不存在的文件（陈旧项）", () => {
    const dupes = ALLOW.shared.filter((f, i) => ALLOW.shared.indexOf(f) !== i);
    expect(dupes, "白名单不得有重复项").toEqual([]);
    const missing = ALLOW.shared.filter((f) => !existsSync(join(ROOT, f)));
    expect(missing, "白名单里的文件必须存在（删了测试就要同步删表）").toEqual([]);
    const notTests = ALLOW.shared.filter((f) => !f.endsWith(".test.ts"));
    expect(notTests, "白名单只收 *.test.ts").toEqual([]);
  });

  it("④ 配置按名满足全部两池契约（★ 调包用例防「删一条+加一条等价」）", () => {
    expect(missingRules(POOL_RULES, CONFIG), describeMissing(POOL_RULES, CONFIG)).toEqual([]);
  });

  it("⑤ ★ 调包用例：删掉「平台判定」再加一条等价规则、条数不变 ⇒ 必须变红", () => {
    // 调包手法：把 platform-gated 改成一条**看起来等价**的规则（恒真），规则总数不变。
    const swapped = CONFIG.replace(
      "sharedPoolEnabled(process.platform)",
      "true /* SWAPPED: 平台判定恒真 */",
    );
    expect(swapped, "前置：调包确实改了配置").not.toBe(CONFIG);
    // 条数不变（规则表长度没变）—— 证明「数条数」的门禁抓不到它。
    // 用**字面量**钉住条数（`expect(X.length).toBe(X.length)` 是恒真的假断言）。
    expect(POOL_RULES.length, "规则条数必须被字面量钉住（删规则即红）").toBe(7);
    // 但**按名判定**必须抓到：platform-gated 缺失。
    const missing = missingRules(POOL_RULES, swapped);
    expect(missing, "★ 调包用例必须变红（按名判定抓到 platform-gated 缺失）").toContain("platform-gated");
    expect(describeMissing(POOL_RULES, swapped)).toContain("platform-gated");
  });

  it("⑥ ★ 平台 fail-closed：非 win32 必须全部走 isolated（用策略函数证明有牙）", () => {
    // 真实行为：非 win32 ⇒ 空列表 ⇒ 全部文件进 isolated。
    expect(sharedPoolEnabled("linux"), "linux 不得启用 shared 池").toBe(false);
    expect(sharedPoolEnabled("darwin"), "darwin 不得启用 shared 池").toBe(false);
    expect(sharedPoolFiles("linux"), "linux 下 shared 池必须为空").toEqual([]);
    expect(sharedPoolFiles("darwin")).toEqual([]);
    // win32 才启用（本机即 win32）。
    expect(sharedPoolEnabled("win32")).toBe(true);
    expect(sharedPoolFiles("win32").length).toBe(ALLOW.shared.length);
    // ★ 调包：把平台常量改成 linux ⇒ 本机（win32）也必须整体关停，证明判定真的在读常量。
    expect(SHARED_POOL_PLATFORM, "白名单证据的采集平台必须是 win32").toBe("win32");
    expect(ALLOWLIST_PLATFORM, "JSON 里的平台字段必须与策略常量一致").toBe(SHARED_POOL_PLATFORM);
    expect(EVIDENCE.platform, "证据 JSON 也必须声明平台").toBe(SHARED_POOL_PLATFORM);
  });

  it("⑦b 平台/能力条件跳过的文件数必须被重算钉住（注释里的 20 不得漂移）", () => {
    // 白名单里带**条件跳过**的文件：其 Windows「6/6」是空洞证据（被跳过的用例没验证），
    // 这正是「shared 池只在 win32 启用」的理由。注释里写的是 20 —— 这里按定义**重算**，
    // 数字漂移即红（否则注释会慢慢变成谎言，而门禁看不出来）。
    const CONDITIONAL_SKIP = /(it|describe|test)\.skipIf\s*\(/;
    const PLATFORM_OR_CAPABILITY = /canPty|pty|PTY|process\.platform|POSIX|posix|win32/i;
    const gated = ALLOW.shared.filter((rel) => {
      const src = readFileSync(join(ROOT, rel), "utf8");
      return CONDITIONAL_SKIP.test(src) && PLATFORM_OR_CAPABILITY.test(src);
    });
    expect(gated.length, "白名单里条件跳过的文件数（注释写 20）").toBe(20);
    // 最危险的那个必须在列：Windows 跳过、Linux 真跑，正是历史 CI 事故那条。
    expect(gated, "main.test.ts 的 SIGTERM 用例必须被算作条件跳过").toContain("apps/studio/src/main.test.ts");
  });

  it("⑦ 白名单规模必须显著小于全量（否则说明退化成全局共享）", () => {
    expect(ALLOW.shared.length, "shared 池不得覆盖全部测试文件").toBeLessThan(400);
    expect(ALLOW.shared.length, "shared 池应是小部分").toBeLessThanOrEqual(350);
    expect(ALLOW.shared.length).toBeGreaterThan(0);
  });
});
