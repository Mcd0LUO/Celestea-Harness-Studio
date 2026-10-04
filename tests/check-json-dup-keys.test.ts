// @vitest-environment node
/**
 * check:json-dup-keys —— 重复键是**静默**的（JSON.parse 取最后一条），所以要有门禁。
 *
 * 测的是**门禁真正跑的那条命令**（spawn 真 CLI），不是 import 一个内部函数 ——
 * 后者需要给 .mjs 补 .d.mts，而且会绕过「枚举 + 解析 + 报告 + 退出码」这一整条路径。
 *
 * 那个撞键真实发生过：一份前端基线 JSON 里曾同时有两条 note36 与两条 note35
 * （各自一条说明被静默吞掉）。那份基线已随**产物体积棘轮**一并移除（2026-10-04 W9339），
 * 所以回归锚点改指 `contracts/endpoints.json` —— 一份**仍然存在**的真实契约 JSON，
 * 由下面的用例端到端断言它现在是干净的（既守住真文件，也让这条引用不会再悬空）。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "scripts", "check-json-dup-keys.mjs");
const DIR = mkdtempSync(join(tmpdir(), "json-dup-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

let n = 0;
/** 写一个 fixture 并跑真 CLI；返回 exit code 与合并输出。 */
function runOn(text: string): { code: number; out: string } {
  n += 1;
  const p = join(DIR, "f" + n + ".json");
  writeFileSync(p, text, "utf8");
  try {
    const out = execFileSync("node", [CLI, p], { cwd: REPO, encoding: "utf8" });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

describe("JSON 重复键门禁（端到端跑真 CLI）", () => {
  it("干净的 JSON：exit 0", () => {
    expect(runOn('{"a":1,"b":{"c":2,"d":[{"e":3}]}}').code).toBe(0);
  });

  it("顶层重复键：exit 1，并报出键名与路径", () => {
    const r = runOn('{"note35":"jia","other":1,"note35":"yi"}');
    expect(r.code).toBe(1);
    expect(r.out).toContain("note35");
  });

  it("嵌套与数组下标都进路径", () => {
    const r = runOn('{"rows":[{"k":1},{"k":2,"k":3}]}');
    expect(r.code).toBe(1);
    expect(r.out).toContain("rows.[1].k");
  });

  it("字符串里的花括号与转义引号不会把它带偏", () => {
    expect(runOn('{"a":"}{ \\" b","c":1}').code).toBe(0);
  });

  // 变异负控制（铁律 2）：把重复键改名 ⇒ 同一条断言必须不再成立。
  it("变异负控制：把重复键改名后 exit 0（证明它真的在比键名）", () => {
    expect(runOn('{"note35":"jia","note35":"yi"}').code).toBe(1);
    expect(runOn('{"note35":"jia","note63":"yi"}').code).toBe(0);
  });

  it("非法 JSON 不由本门禁负责（交给别的门禁），不误报 exit 1", () => {
    expect(runOn("{ not json").code).toBe(0);
  });

  it("真仓库的真实契约 JSON（contracts/endpoints.json）现在是干净的：exit 0", () => {
    const p = join(REPO, "contracts", "endpoints.json");
    // ★ 这两条断言**必须成对**，缺一条就退化成空话：
    //   `check-json-dup-keys.mjs` 对**解析不过**的文件是**静默跳过**的（它只查合法 JSON，
    //   非法 JSON 按设计交给别的门禁 —— 见上面那条用例），而它打印的「扫 1 个 JSON」只证明
    //   **读到了**、不证明**解析过**（scanned 在 JSON.parse 之前就 +1）。所以「这份文件是
    //   合法 JSON」必须由本用例自己钉住，否则文件一旦写坏（哪怕只是多个 BOM），
    //   「0 处重复键」就变成一句什么也没查的话。
    expect(() => JSON.parse(readFileSync(p, "utf8")), "文件必须是合法 JSON，否则门禁会静默跳过它").not.toThrow();
    const out = execFileSync("node", [CLI, p], { cwd: REPO, encoding: "utf8" });
    // 守**后果**（这份契约是干净的、退出码 0），不守**我的措辞** —— 措辞会改，
    // 而「读过几个 / 几个合法解析」的分母写法就不该被钉住（铁律 11）。
    expect(out).toContain("0 处重复键");
  });

  it("真仓库现在干净：不传参数枚举全仓 ⇒ exit 0", () => {
    const out = execFileSync("node", [CLI], { cwd: REPO, encoding: "utf8" });
    expect(out).toContain("0 处重复键");
  });
});
