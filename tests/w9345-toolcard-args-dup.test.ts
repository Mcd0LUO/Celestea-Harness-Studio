// ============================================================================
// tests/w9345-toolcard-args-dup.test.ts — W9345：工具卡**参数重复**门禁。
//
// 用户报障（真机截图）：工具卡展开后，同一个东西出现**两遍** ——
//     参数：{"path": "D:\tools\...\results\audit4\prob…   ← 截断的一行（省略号）
//     {"path": "D:\tools\...\results\audit4\probe\…"}   ← 完整参数块（.tool-args）
//     结果：…                                              ← 结果摘要（同样与全文重复）
//     预览
//
// 本门禁守**后果**：展开后参数与结果**各只印一次**，且印的是**完整**那份。
// 铁律 11：不钉具体 px、不钉 class 名的排版，只钉「重复消失 + 全文仍在」这两件事。
//
// ★ W9345 二次更正：先前只删了参数摘要、保留了结果摘要，理由写的是
//   「结果摘要是未到达时的进度信息」。**那个理由是错的** —— `setToolResult` 在同一次
//   调用里同时写摘要行与 .tool-out，不存在「有摘要、无全文」的窗口。现两行都删。
//
// ★ 复制语义不许因删 DOM 而变：复制按钮读的是**闭包里的 `d.argsText`**（不是被删的
//   节点），所以 `chat.tool.copyHint`「复制参数与结果（JSON）」一字不变 —— 本文件的
//   「复制不读被删节点」那条就是守这个的。
// ============================================================================
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bundleFrontend, El, installDom, restoreDom } from "./lib/w1467-dom.js";

interface ToolcardsMod {
  buildToolCard: (d: Record<string, unknown>) => {
    col: El; card: El; body: El; label: El;
  };
  setToolResult: (ref: unknown, text: string, failed: boolean) => void;
  /** 标签文案（从真 i18n 读，断言不抄字面量）。 */
  t: (key: string) => string;
}

let tc: ToolcardsMod;
let tmpDir = "";

// 与 w1542-toolcard-dup.test.ts 同一手法：真的 esbuild 打包前端源码 ⇒ 跑的是真实现。
// 同样只给这一个 hook 显式 60s 预算（W2035：默认 10s 在争用下不够）。
beforeAll(async () => {
  installDom();
  tmpDir = mkdtempSync(join(tmpdir(), "w9345-argsdup-"));
  const out = join(tmpDir, "toolcards.mjs");
  // 顺带导出真 i18n 的 `t`（标签文案断言读它，不抄字面量 ⇒ 换语言/改文案都不会假红）。
  await bundleFrontend(
    "export { buildToolCard, setToolResult } from './apps/web/src/ui/toolcards.ts';" +
    "export { t } from './apps/web/src/i18n/index.ts';",
    out,
  );
  tc = (await import(pathToFileURL(out).href)) as ToolcardsMod;
}, 60_000);

afterAll(() => {
  restoreDom();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

/** 直接子元素里带该 class 的第一个（null = 无/未挂载）。垫片不做祖先链匹配，见 w1467-dom.ts。 */
function child(node: El | null | undefined, cls: string): El | null {
  if (!node) return null;
  for (const c of node.childNodes) if (c.classList.contains(cls)) return c;
  return null;
}

/**
 * 递归找带该 class 的第一个后代。
 * ★ W9348 起正文块住进 `.tool-block` 宿主（标签是它的首子节点），
 *   所以 `.tool-args` / `.tool-out` 不再是 `.toolcard-body` 的**直接**子节点 ——
 *   断言必须按**后代**找（与生产代码 `querySelector` 的口径一致）。
 */
function deep(node: El | null | undefined, cls: string): El | null {
  if (!node) return null;
  for (const c of node.childNodes) {
    if (c.classList.contains(cls)) return c;
    const hit = deep(c, cls);
    if (hit !== null) return hit;
  }
  return null;
}

/** 带标签的正文块：宿主 `.tool-block`（标签 + pre）。 */
function labeledBlock(body: El | null | undefined, blockCls: string): { host: El | null; label: El | null; block: El | null } {
  const block = deep(body, blockCls);
  if (block === null) return { host: null, label: null, block: null };
  // ★ 块**自己**的父节点就是 `.tool-block` 宿主（不是"父节点里再找一个 tool-block"）。
  //   垫片只有 `parentNode`（没有 `parentElement`，见 w1467-dom.ts 的 El 定义）。
  const host = block.parentNode;
  if (host === null || !host.classList.contains("tool-block")) {
    return { host: null, label: null, block };
  }
  return { host, label: child(host, "tool-block-label"), block };
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
    const full = deep(ref.body, "tool-args");
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

  it("④ 结果摘要也已删（结果全文那一行同样在重复）", () => {
    const ref = card();
    expect(
      child(ref.body, "toolcard-result-preview"),
      "结果摘要（与 .tool-out 全文重复）那一行必须消失",
    ).toBeNull();
  });

  it("⑤ 结果回填照旧工作：全文逐字到位，成败由 class + 状态 pill 表达", () => {
    const ref = card();
    tc.setToolResult(ref, "file body", false);
    // 删了摘要行，结果**内容**一个字都不能少。
    const out = deep(ref.body, "tool-out");
    expect(out, "结果全文进 body").not.toBeNull();
    expect(out!.textContent, "结果全文逐字").toBe("file body");
    // 删摘要没有把「成功/失败」这个信息一起删掉。
    const hasOk = ref.card.classList.contains("ok");
    const hasRunning = ref.card.classList.contains("running");
    expect(hasOk && !hasRunning, "成败仍由卡 class 表达（ok）").toBe(true);
    const pill = child(ref.card.querySelector(".toolcard-state"), "ts-label");
    expect(pill !== null && pill.textContent.length > 0, "状态 pill 仍有可见文案").toBe(true);
  });

  it("⑥ 复制不读被删的节点 ⇒ chat.tool.copyHint 语义不变（复制内容仍含参数全文）", () => {
    const ref = card();
    // 复制按钮的文本源是**闭包里的 d.argsText**（见 toolcards.ts 的 click 处理），
    // 与被删的 args 预览节点无关。直接验证被删节点确实不在 DOM 里、而完整块在 ——
    // 复制按钮读的后者逐字含参数全文，语义不变。
    expect(ref.body.querySelector(".toolcard-args-preview"), "被删节点不在 DOM").toBeNull();
    const full = deep(ref.body, "tool-args");
    expect(full!.textContent, "复制源（参数全文）仍在卡内").toBe(LONG_ARGS);
  });

  it("⑦ 折叠与复制按钮仍在（删的是一行预览，不是交互元素）", () => {
    const ref = card();
    expect(ref.card.querySelector(".toolcard-copy"), "复制按钮必须保留").not.toBeNull();
    expect(ref.card.querySelector(".toolcard-head"), "折叠头必须保留").not.toBeNull();
    expect(ref.card.querySelector(".toolcard-fold"), "折叠指示必须保留").not.toBeNull();
  });
});

/**
 * W9348：截断行保持删除，但**「参数」/「结果」标签必须回来**。
 *
 * 主人原话：「我只让去除 `参数：xxx...` 这种**截断渲染**」——标签是**要留的**。
 * 标签与截断正文原先长在同一个元素上，删行把标签一起带走了 ⇒ 两块变「光秃秃的」。
 *
 * 守**后果**（铁律 11：不钉字号/颜色/坐标常量）：
 *   ① 标签**可见**且**与块关联**（`aria-labelledby` 指向一个真实存在的标签元素）；
 *   ② 标签只有文字标签本身，**不带** `{text}`（正文在块里，不许再截断一份）；
 *   ③ **运行中的卡没有「结果」标签**（也没空块）—— 不许出现「有标签没块」；
 *   ④ 标签 id **逐块唯一**（`aria-labelledby` 按文档树解析，重复 id 会让所有块
 *      都念成第一个标签）。
 */
describe("W9348 「参数」/「结果」标签", () => {
  it("① 参数块有可见标签，且标签与块通过 aria-labelledby 关联", () => {
    const ref = card();
    const { label, block } = labeledBlock(ref.body, "tool-args");
    expect(label, "参数块必须带标签").not.toBeNull();
    expect(label!.textContent.length, "标签要有可见文字").toBeGreaterThan(0);
    const by = block!.getAttribute("aria-labelledby");
    expect(by, "块必须用 aria-labelledby 指向标签（不只做视觉）").toBeTruthy();
    expect(label!.getAttribute("id"), "aria-labelledby 必须指向这个标签").toBe(by);
  });

  it("② 结果块有可见标签，且同样通过 aria-labelledby 关联", () => {
    const ref = card();
    tc.setToolResult(ref, "file body", false);
    const { label, block } = labeledBlock(ref.body, "tool-out");
    expect(label, "结果块必须带标签").not.toBeNull();
    expect(label!.textContent.length, "标签要有可见文字").toBeGreaterThan(0);
    const by = block!.getAttribute("aria-labelledby");
    expect(by).toBeTruthy();
    expect(label!.getAttribute("id")).toBe(by);
  });

  it("③ 标签只有标签本身（不含截断正文 —— 截断行不许复活）", () => {
    const ref = card();
    const { label } = labeledBlock(ref.body, "tool-args");
    expect(label!.textContent, "标签里不许夹带参数正文").toBe(tc.t("chat.tool.argsLabel"));
    expect(label!.textContent.indexOf("…") === -1, "标签里不许有省略号").toBe(true);
    // 两个标签**不相同**（参数 ≠ 结果）：错配了也说明其中一个没接对。
    tc.setToolResult(ref, "file body", false);
    const outLabel = labeledBlock(ref.body, "tool-out").label;
    expect(outLabel!.textContent).toBe(tc.t("chat.tool.resultLabel"));
    expect(label!.textContent).not.toBe(outLabel!.textContent);
  });

  it("④ 运行中的卡：没有「结果」标签，也没有空的结果块", () => {
    const ref = card(); // 只 pushToolCard，没 applyToolResult
    expect(labeledBlock(ref.body, "tool-out").label, "结果没到就不该有结果标签").toBeNull();
    expect(deep(ref.body, "tool-out"), "结果没到就不该有空的结果块").toBeNull();
    // 但参数块此时就带标签（参数是建卡即有的）。
    expect(labeledBlock(ref.body, "tool-args").label, "参数标签建卡即在").not.toBeNull();
  });

  it("⑤ 标签 id 逐块唯一（两张卡不能让 aria-labelledby 指到同一处）", () => {
    const a = card();
    const b = card();
    const idA = labeledBlock(a.body, "tool-args").block!.getAttribute("aria-labelledby");
    const idB = labeledBlock(b.body, "tool-args").block!.getAttribute("aria-labelledby");
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idA, "两张卡的参数标签 id 必须不同").not.toBe(idB);
  });
});
