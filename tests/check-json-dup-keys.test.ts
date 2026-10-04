// @vitest-environment node
/**
 * check:json-dup-keys —— 重复键是**静默**的（JSON.parse 取最后一条），所以要有门禁。
 *
 * 测的是**门禁真正跑的那条命令**（spawn 真 CLI），不是 import 一个内部函数 ——
 * 后者需要给 .mjs 补 .d.mts，而且会绕过「枚举 + 解析 + 报告 + 退出码」这一整条路径。
 *
 * 那个撞键真实发生过：apps/web/tools/bundle-size-baseline.json 里曾同时有两条 note36
 * 与两条 note35（各自一条说明被静默吞掉）。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("真仓库现在干净：不传参数枚举全仓 ⇒ exit 0", () => {
    const out = execFileSync("node", [CLI], { cwd: REPO, encoding: "utf8" });
    expect(out).toContain("0 处重复键");
  });
});
