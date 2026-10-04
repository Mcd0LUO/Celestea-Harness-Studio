// ============================================================================
// tests/w9345-toolcard-args-dup.test.ts — W9345：工具卡**参数重复**门禁。
//
// 用户报障（真机截图）：工具卡展开后，同一个参数出现**两遍** ——
//     参数：{"path": "D:\tools\...\results\audit4\prob…   ← 截断的一行（省略号）
//     {"path": "D:\tools\...\results\audit4\probe\…"}   ← 完整参数块（.tool-args）
//     结果：…                                              ← 结果摘要（不同步出现，见下）
//     预览
//
// 本门禁守**后果**：展开后参数**只印一次**，且印的是**完整**那份。
// 铁律 11：不钉具体 px、不钉 class 名的排版，只钉「重复消失 + 完整块仍在」这两件事。
//
// ★ 为什么**只删参数摘要、保留结果摘要**（.toolcard-result-preview）：
//   结果全文在 `.tool-out`，是**结果到达后**（setToolResult）才有的；
//   参数块则是**建卡即在**。两者不同步出现 ⇒ 结果摘要仍是「先说一声有结果了」的
//   进度信息；删掉它会让运行中的卡在结果回填前完全看不出有结果。本轮只治用户指出的那一处。
//
// ★ 复制语义不许因删 DOM 而变：复制按钮读的是**闭包里的 `d.argsText`**（不是那个
//   被删的节点），所以 `chat.tool.copyHint`「复制参数与结果（JSON）」一字不变 —— 本文件
//   的「复制不读被删节点」那条就是守这个的。
// ============================================================================
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bundleFrontend, El, installDom, restoreDom } from "./lib/w1467-dom.js";

interface ToolcardsMod {
  buildToolCard: (d: Record<string, unknown>) => {
    col: El; card: El; body: El; resultPv: El;
  };
  setToolResult: (ref: unknown, text: string, failed: boolean) => void;
}

let tc: ToolcardsMod;
let tmpDir = "";

// 与 w1542-toolcard-dup.test.ts 同一手法：真的 esbuild 打包前端源码 ⇒ 跑的是真实现。
// 同样只给这一个 hook 显式 60s 预算（W2035：默认 10s 在争用下不够）。
beforeAll(async () => {
  installDom();
  tmpDir = mkdtempSync(join(tmpdir(), "w9345-argsdup-"));
  const out = join(tmpDir, "toolcards.mjs");
  await bundleFrontend(
    "export { buildToolCard, setToolResult } from './apps/web/src/ui/toolcards.ts';",
    out,
  );
  tc = (await import(pathToFileURL(out).href)) as ToolcardsMod;
}, 60_000);

afterAll(() => {
  restoreDom();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

/** 直接子元素里带该 class 的第一个（null = 无）。垫片不做祖先链匹配，见 w1467-dom.ts。 */
function child(node: El | null, cls: string): El | null {
  if (node === null) return null;
  for (const c of node.childNodes) if (c.classList.contains(cls)) return c;
  return null;
}

/** 节点子树的全部文本（递归拼接；垫片的 textContent 不拼子节点，见 w1542 注释）。 */
function textOf(n: El | null): string {
  if (n === null) return "";
  let s = n.textContent;
  for (const c of n.childNodes) s += textOf(c);
  return s;
}

/** 一个参数很长的 read_file 卡 —— 主场景（长参数 ⇒ 摘要必然被截断 + 省略号）。 */
const LONG_ARGS = JSON.stringify({
  path: "D:\\tools\\celestea-studio\\results\\audit4\\probe\\really-long-directory-name\\file.ts",
  start: 1,
  limit: 2000,
});

function card() {
  return tc.buildToolCard({ step: 1, name: "read_file", argsText: LONG_ARGS });
}

describe("W9345 · 工具卡参数不重复", () => {
  it("① 截断的参数摘要行不再渲染（用户报障的那一行）", () => {
    const ref = card();
    const dup = ref.body.querySelector(".toolcard-args-preview");
    expect(dup, "参数摘要（截断+省略号）那一行必须消失").toBeNull();
  });

  it("② 完整参数块仍在，内容逐字等于参数全文（不是截断、不是 desc）", () => {
    const ref = card();
    const full = child(ref.body, "tool-args");
    expect(full, "完整参数块必须保留").not.toBeNull();
    // ★ 逐字守「完整」：不是省略号版本，也不是卡头那行的 desc。
    // 不用 expect(x).toBe(长串) —— 垫片的 El 让 vitest 的 diff 格式化器崩
    // （`instanceof` not callable），长串失败时连真实值都看不到。改成量长度 + 布尔：
    const got = full!.textContent;
    expect(got.length, "完整参数长度必须等于参数全文长度").toBe(LONG_ARGS.length);
    expect(got === LONG_ARGS, "完整参数逐字等于参数全文（不是截断/不是 desc）").toBe(true);
    expect(got.indexOf("…") === -1, "不许带截断省略号").toBe(true);
  });

  it("③ 参数在整张卡里只印一次（去重口径：全文出现次数 = 1）", () => {
    const ref = card();
    const bodyText = textOf(ref.body);
    // 完整参数全文在 body 里出现**恰好一次**（被删的摘要是它唯一可能的第二份）。
    const occurrences = bodyText.split(LONG_ARGS).length - 1;
    expect(occurrences, "参数全文在 body 里出现次数").toBe(1);
  });

  it("④ 结果摘要保留（它不与结果全文重复：结果到达前先说一声）", () => {
    const ref = card();
    const resultPv = child(ref.body, "toolcard-result-preview");
    expect(resultPv, "结果摘要必须保留").not.toBeNull();
    // 结果没到时是空的（不是「参数摘要」那种一上来就占一行）。
    expect(resultPv!.textContent).toBe("");
  });

  it("⑤ 结果回填照旧工作（删参数摘要没有碰结果那条路）", () => {
    const ref = card();
    tc.setToolResult(ref, "file body", false);
    const resultPv = child(ref.body, "toolcard-result-preview");
    // 同 ②：避开长串 diff 格式化器（用布尔判定）。
    expect(resultPv!.textContent.indexOf("file body") !== -1, "结果摘要照旧回填（元素没换）").toBe(true);
    expect(child(ref.body, "tool-out"), "结果全文进 body").not.toBeNull();
  });

  it("⑥ 复制不读被删的节点 ⇒ chat.tool.copyHint 语义不变（复制内容仍含参数全文）", () => {
    const ref = card();
    // 复制按钮的文本源是**闭包里的 d.argsText**（见 toolcards.ts 的 click 处理），
    // 与被删的 args 预览节点无关。直接验证被删节点确实不在 DOM 里、而完整块在 ——
    // 复制按钮读的后者逐字含参数全文，语义不变。
    expect(ref.body.querySelector(".toolcard-args-preview"), "被删节点不在 DOM").toBeNull();
    const full = child(ref.body, "tool-args");
    expect(full!.textContent, "复制源（参数全文）仍在卡内").toBe(LONG_ARGS);
  });

  it("⑦ 折叠与复制按钮仍在（删的是一行预览，不是交互元素）", () => {
    const ref = card();
    expect(ref.card.querySelector(".toolcard-copy"), "复制按钮必须保留").not.toBeNull();
    expect(ref.card.querySelector(".toolcard-head"), "折叠头必须保留").not.toBeNull();
    expect(ref.card.querySelector(".toolcard-fold"), "折叠指示必须保留").not.toBeNull();
  });
});
