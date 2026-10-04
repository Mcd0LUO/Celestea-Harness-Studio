// @vitest-environment node
/**
 * 铁律 6 的机械兜底：**不许提交派生产物**。
 *
 * 为什么需要这个文件（2026-09-28 的真实事故）：
 *   `.gitignore` 当时只写了 `reports/replay-diff-*.json`（**带时间戳**的那一种命名），
 *   于是同一个脚本写的同一份内容，两种命名命运不同：
 *     reports/replay-diff-<stamp>.json   被忽略 ✓
 *     reports/replay-diff.json           ★入库 ✗
 *   而 reports/replay-e2e.{json,md}、reports/contract-probe.md、
 *   contracts/probe-evidence.json 更是**不匹配任何规则** ⇒ 被提交进公开仓。
 *
 *   它们全部【只被 writeFileSync 写、全仓无一处读】（核实见报告）：
 *     scripts/compare-replay.ts 的 main 收尾三连写  → reports/replay-diff.{json,md}
 *     scripts/replay-e2e.ts 的 [main] 两连写        → reports/replay-e2e.{json,md}
 *     scripts/contracts/report.ts 的 [writeEvidence] → contracts/probe-evidence.json
 *                                                 → reports/contract-probe.md
 *
 *   这些落点 2026-10-02 更新过一次：EX-02/03/04 三处重构把写盘点搬进了
 *   scripts/golden/* 与 scripts/contracts/*。这些注释**没有任何门禁盯着**（文档锚点有
 *   tests/doc-conventions.test.ts 的 ③b/③c，注释没有），所以它们是最容易悄悄烂掉的一类。
 *
 *   ★ 更糟的是 probe-evidence.json 已经【腐烂】：它记录 sseEvents=9 / tools=12，
 *     而契约真值是 10 / 22（tools 从 19 又涨到 22）—— 没有任何门禁保证它与契约同步，
 *     它只会越来越错。
 *
 * 本文件把「靠 .gitignore 的措辞正确」换成「靠索引事实」：
 *   只要 `git ls-files` 里出现这些产物，无论 .gitignore 写成什么，都红。
 *
 * ★ 判据来源是【索引】，不是工作区文件是否存在 ——
 *   脚本照常可以在本地写这些文件（那是它的功能），只是不许被跟踪。
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `git ls-files` 的完整输出（索引里的每个路径）。 */
function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\0").filter((s) => s !== "");
}

/**
 * 派生产物的**路径判据**（与「哪些文件」分开，这样新增脚本的输出只要落在这里就被覆盖）。
 *
 * 为什么按目录/文件而不是按「内容看起来像产物」：判据要能被机械复核，
 * 而「reports/ 整目录」与「这一个 contracts/ 下的快照」是**可枚举**的。
 */
const DERIVED_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["reports/ 是脚本输出目录，整目录不入库", /^reports\//],
  ["verify-contracts.ts 的每次运行快照，不是契约真源", /^contracts\/probe-evidence\.json$/],
];

describe("铁律 6 · 不许提交派生产物（索引事实，不看 .gitignore 的措辞）", () => {
  const tracked = trackedFiles();

  it("★ 索引里不得有 reports/ 下的任何文件", () => {
    const hits = tracked.filter((f) => /^reports\//.test(f));
    expect(
      hits,
      "这些是脚本输出（只被写、从不被读），不该入库。若确有 golden 要入库，请改名到 fixtures/ 并在此登记例外：\n" +
        hits.join("\n"),
    ).toEqual([]);
  });

  it("★ 索引里不得有 contracts/probe-evidence.json（它是运行快照且会腐烂）", () => {
    expect(tracked.filter((f) => f === "contracts/probe-evidence.json")).toEqual([]);
  });

  it("★ 判据自检：两个模式都真的能命中（防空集假绿）", () => {
    // 若正则写错（例如转义过头），下面的断言会全绿但什么都没检查。
    expect(DERIVED_PATTERNS.length).toBe(2);
    expect(DERIVED_PATTERNS[0]![1].test("reports/contract-probe.md")).toBe(true);
    expect(DERIVED_PATTERNS[1]![1].test("contracts/probe-evidence.json")).toBe(true);
    // 反例：真源不许被误伤。
    expect(DERIVED_PATTERNS[0]![1].test("contracts/endpoints.json")).toBe(false);
    expect(DERIVED_PATTERNS[1]![1].test("contracts/endpoints.json")).toBe(false);
    expect(DERIVED_PATTERNS[1]![1].test("contracts/probe-evidence.json.bak")).toBe(false);
  });

  it("★ 判据自检：reports/ 与 contracts/ 之外的路径不受影响", () => {
    // 防「模式过宽把正常文件也拦了」——那会让门禁变成噪音并被绕过。
    for (const f of ["src/index.ts", "tests/contracts.test.ts", "fixtures/reports.md"]) {
      expect(DERIVED_PATTERNS.some(([, re]) => re.test(f)), f + " 不该被判为产物").toBe(false);
    }
  });
});
