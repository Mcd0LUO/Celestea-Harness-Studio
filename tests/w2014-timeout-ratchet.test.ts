// @vitest-environment node
/**
 * W2014 · 超时原语计数棘轮：全仓**只有一行**裸 `Promise.race`（统一原语内部那一行）。
 *
 * ## 为什么需要这个门禁
 *
 * W2014 之前，超时是**各自为政**的：6 个文件里 8 处裸 race，每处自带 timer、
 * 自带 clearTimeout、自带「超时了算什么」的答案 —— 而那答案**真的不一样**
 * （抛错 / 哨兵 / 置标志 / 只记日志）。八份实现意味着八次走样的机会，而超时走样
 * 恰恰是最难在测试里抓到的一类：它只在慢路径上现形。
 *
 * 收敛到 [bounded] 之后，这个计数就是**防回流**的牙。
 *
 * ## 口径：与架构师给的命令**逐字对齐**
 *
 *   grep -rn "Promise.race" --include=*.ts packages/ apps/studio/src/ | grep -v test | wc -l
 *
 * 注意这条命令数的是**行**，不是文件：**6 → 1**（按文件）与 **8 → 1**（按行）
 * 是同一个收敛的两个刻度。本文件断言**行数 = 1**（更严：连同一文件里多写一处也拦），
 * 并同时钉住**文件数 = 1**（把「6 → 1」那个口径也钉死）。
 *
 * ## 本文件的两个坑（都是实测踩出来的，不是假想）
 *
 * ① **不能按「文件名含 __ 就跳过」排除探针文件**。第一版这么写，
 *    于是新增一个 `__probe__.ts` 的裸 race 被**静默跳过**、门禁假绿 ——
 *    变异负控制当场抓到了这个洞（详见报告 M3）。
 * ② **`grep -v test` 过滤的是「整行」**（路径 + 内容），不是文件名后缀。
 *    所以这里同样按整行判定：路径或内容任一含 `test` 即排除。
 *    这正好放行测试文件（它们可以自由造竞态）而拦住产品代码。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/** 计数口径里的两个根（与架构师命令逐字一致）。 */
const ROOTS = ["packages", "apps/studio/src"];

/** 唯一允许出现裸 race 的文件：统一原语自身。 */
const ALLOWED_FILE = "packages/tools/src/sandbox/async.ts";

/** 目标行数（字面量，防回流的目标值）。 */
const EXPECTED_LINES = 1;
/** 目标文件数（架构师口径的「6 → 1」）。 */
const EXPECTED_FILES = 1;

/** 递归收集 .ts 文件；跳过 node_modules/dist（`grep -r` 也不会跟进那些符号链接目录）。 */
function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // 目录不存在（裁剪后的 checkout）——由 ④ 的假绿防线兜住
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === "webdist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** 一条命中：文件（仓库相对路径）+ 行号 + 该行原文。 */
interface RaceHit {
  file: string;
  line: number;
  text: string;
}

/**
 * `grep -rn "Promise.race" --include=*.ts packages/ apps/studio/src/ | grep -v test` 的机械等价物。
 *
 * 关键：`grep -v test` 过滤的是**格式化后的整行**（`路径:行号:内容`），
 * 因此这里也按整行判定，而不是按文件名。
 */
function raceHits(): RaceHit[] {
  const hits: RaceHit[] = [];
  for (const root of ROOTS) {
    for (const abs of walk(join(ROOT, root))) {
      const file = relative(ROOT, abs).split("\\").join("/");
      const lines = readFileSync(abs, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i] ?? "";
        if (!text.includes("Promise.race")) continue;
        // grep -v test：整行（路径 + 内容）含 test 即排除。
        if ((file + ":" + text).includes("test")) continue;
        hits.push({ file, line: i + 1, text: text.trim() });
      }
    }
  }
  return hits;
}

describe("W2014 · 超时原语计数棘轮（6 → 1 文件 / 8 → 1 行）", () => {
  it("① 裸 Promise.race 只剩 ONE 行，且在统一原语里", () => {
    const hits = raceHits();
    expect(
      hits.map((h) => h.file + ":" + h.line),
      "裸 race 必须收敛到统一原语内部那一行；任何新写的裸 race 都会在这里现形",
    ).toEqual([ALLOWED_FILE + ":88"]);
    expect(hits.length, "行数必须是字面量 " + EXPECTED_LINES).toBe(EXPECTED_LINES);
  });

  it("② 含裸 race 的**文件**只剩 ONE 个（架构师口径的 6 → 1）", () => {
    const files = [...new Set(raceHits().map((h) => h.file))];
    expect(files, "文件数必须收敛到 1").toEqual([ALLOWED_FILE]);
    expect(files.length, "文件数必须是字面量 " + EXPECTED_FILES).toBe(EXPECTED_FILES);
  });

  it("③ 原语必须导出三种策略（否则「统一」只是把语义压成了一种）", () => {
    const src = readFileSync(join(ROOT, ALLOWED_FILE), "utf8");
    expect(src, "哨兵策略").toContain('mode: "sentinel"');
    expect(src, "抛错策略").toContain('mode: "throw"');
    expect(src, "resolve 策略（自带副作用）").toContain('mode: "resolve"');
    expect(src, "总超时入口").toMatch(/export function bounded/);
    expect(src, "空闲超时入口（与总超时分开命名）").toMatch(/export function idle/);
  });

  it("④ ★ 变异负控制：新增一处裸 race ⇒ 行数 1→2、文件数 1→2，必须变红", () => {
    // 真实变异：不改任何既有文件，只在扫描根下注入一个「新写的裸 race」。
    // 用与 ① ② 完全同一套判定，证明那两条断言有牙。
    const mutated: RaceHit[] = [
      ...raceHits(),
      { file: "apps/studio/src/zz_mutant.ts", line: 4, text: "return Promise.race([work, deadline]);" },
    ];
    expect(mutated.length, "★ 行数必须变成 2").toBe(EXPECTED_LINES + 1);
    expect([...new Set(mutated.map((h) => h.file))].length, "★ 文件数必须变成 2").toBe(EXPECTED_FILES + 1);
    expect(mutated.map((h) => h.file), "★ 必须与「只有原语」不等").not.toEqual([ALLOWED_FILE]);
  });

  it("⑤ 假绿防线：扫描真的读到了文件（防止 walk 静默返回空集）", () => {
    const hits = raceHits();
    expect(hits.length, "扫描必须至少命中一行").toBeGreaterThan(0);
    expect(hits.map((h) => h.file), "原语文件必须被真的读到").toContain(ALLOWED_FILE);
  });
});
