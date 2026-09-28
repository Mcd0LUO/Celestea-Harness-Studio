// @vitest-environment jsdom
/**
 * W2058 · 文件预览（用户原话：「还有，取消这个展开，改为借鉴 dsh 的同款侧边栏。」）
 *
 * 两件事各守一组不变量，都用**真实模块 + 真实 CSS 真源**（不复刻逻辑）：
 *
 *   ① **取消「展开」** —— 预览里的代码块不再有折叠按钮，**聊天里的照旧有**。
 *      范围判断为 (a) 只取消预览侧（依据见报告「任务 A 的范围判断」：截图是文件
 *      预览，且「预览」的语义就是看完整内容）。判别力靠**同一条增强遍**在两个
 *      作用域下的产出对比 —— 不是「预览里没有 .code-fold」这种单侧断言，那在
 *      「code-extras 整个坏掉」时也会绿。
 *
 *   ② **停靠而非覆盖** —— 预览不再压在正文上。
 *      ★ jsdom 没有排版（getBoundingClientRect 恒为 0），所以这里**不假装**量像素，
 *      而是断言那组让「几何上不可能相交」**必然成立**的结构与声明事实
 *      （本仓 modes.ts 的既有判定法：两个上下/左右相邻的块 ⇒ 轴对齐矩形不相交）。
 *      真机像素几何由 scripts/a11y/w2058-preview-probe.mjs 实测（报告附截图与数字）。
 *
 * 变异负控制见文件末尾 §3：每条断言都配一个「把实现改坏 ⇒ 该断言必红」的用例。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at, doc, flush, HTML, resetHarness, type ElLike } from "./lib/w795-dom.js";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web");
/** 去注释：注释里也写着选择器与取值，会把「声明存在」这类断言带偏。 */
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "");
const css = (rel: string): string => strip(readFileSync(join(WEB, "src", "styles", rel), "utf8"));

/** 取某选择器**最后一条**规则体（后写的才生效；与 w1462 同口径）。 */
function rule(text: string, selector: string): string {
  const want = selector.trim().replace(/\s+/g, " ");
  let found = "";
  for (const m of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if ((m[1] ?? "").trim().replace(/\s+/g, " ") === want) found = m[2] ?? "";
  }
  expect(found, "找不到规则：" + selector).not.toBe("");
  return found;
}

const q = (s: string): ElLike | null => doc.querySelector(s) as ElLike | null;
const n = (s: string): number => doc.querySelectorAll(s).length;

/** 40 行（> CODE_FOLD_LINES=30）⇒ 在**聊天**作用域下必然触发折叠。 */
const LONG_SRC = Array.from({ length: 40 }, (_, i) => "const line" + i + " = " + i + ";").join("\n");

interface PanelMod { openPreview(r: unknown): void; closePreview(): void; previewIsOpen(): boolean }

/** 走真装配（hint ⇒ 客户端插件 ⇒ code-extras 真挂上），漏了这步用例会假绿。 */
async function boot(): Promise<PanelMod> {
  const V = (await import(/* @vite-ignore */ at("ui/viewctx.ts"))) as { initViewCtx(): void };
  V.initViewCtx();
  const hints = (await import(/* @vite-ignore */ at("ui/hint/index.ts"))) as { initHints(): void };
  hints.initHints();
  return (await import(/* @vite-ignore */ at("ui/preview/panel.ts"))) as unknown as PanelMod;
}

/** 打开一个代码文件预览（一次性读全，走 paint 路径）。 */
async function openCode(panel: PanelMod, text: string): Promise<void> {
  panel.openPreview({ candidate: { path: "/tmp/w2058/demo.ts", kind: "code", source: "label" }, loadFull: async () => ({ text }) });
  await flush(30);
}

beforeEach(() => {
  resetHarness();
  doc.body.innerHTML = HTML;
  vi.resetModules();
  vi.stubGlobal("EventSource", class { addEventListener(): void {} close(): void {} });
  vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => ({ ok: true, disabled: [], questions: [], messages: [] }) }));
});
afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

// ============================================================================
// ① 任务 A：预览取消折叠，聊天保留
// ============================================================================
describe("W2058 ① 预览退出代码块折叠（聊天不动）", () => {
  it("预览：40 行代码块**没有**折叠按钮，也没有 code-folded 折叠态", async () => {
    const panel = await boot();
    await openCode(panel, LONG_SRC);
    expect(q(".preview-body"), "预览面板必须出现").not.toBeNull();
    expect(n(".preview-body .cl"), "行号切分照常（164 行那个文件也是这么切的）").toBeGreaterThan(30);
    expect(n(".preview-body .code-fold"), "★ 预览里不得有折叠按钮").toBe(0);
    expect(n(".preview-body .code-folded"), "★ 预览里不得有折叠态").toBe(0);
  });

  it("★ 同一遍增强、同一段文本：聊天作用域下**仍然**折叠（证明取消是作用域级的，不是把功能删了）", async () => {
    await boot(); // ★ 必须真装配：code-extras 是**客户端插件**，不装配就根本没挂上
    const enhance = (await import(/* @vite-ignore */ at("ui/enhance/index.ts"))) as { runEnhancers(c: unknown): void };
    const box = doc.createElement("div") as unknown as ElLike;
    box.className = "content rendered";
    box.innerHTML = "<pre><code class='language-ts'>" + LONG_SRC + "</code></pre>";
    doc.body.appendChild(box);
    enhance.runEnhancers(box);
    expect(n(".content .code-fold"), "★ 聊天里 40 行块必须仍有折叠按钮").toBe(1);
    expect(n(".content .code-folded"), "★ 聊天里必须仍处于默认折叠态").toBe(1);
  });

  it("预览里徽标与行号**保留**（用户只反对折叠，没要求把 code-extras 整遍关掉）", async () => {
    const panel = await boot();
    await openCode(panel, LONG_SRC);
    expect(n(".preview-body .code-badge"), "语言徽标仍在").toBe(1);
    // 语言名来自 renderers 的 language-<hljs 名>（.ts ⇒ typescript，见 ui/preview/lang.ts）
    expect(q(".preview-body .code-badge")?.textContent, "徽标文本 = 语言名").toBe("typescript");
    expect(n(".preview-body .cl-nl"), "行号载体仍在").toBeGreaterThan(0);
    expect(n(".preview-body .code-copy"), "复制按钮仍在").toBe(1);
  });

  it("退出折叠的标记挂在 .preview-body 上（单一真源，见 code-extras 的 NO_FOLD_ATTR）", async () => {
    const panel = await boot();
    await openCode(panel, LONG_SRC);
    const body = q(".preview-body");
    expect(body?.getAttribute("data-code-fold"), "预览正文带折叠退出标记").toBe("off");
  });

  it("流式分段路径同样不折叠（.preview-seg 是 body 的后代，closest 一样命中）", async () => {
    const panel = await boot();
    let seg = 0;
    panel.openPreview({
      candidate: { path: "/tmp/w2058/big.ts", kind: "code", source: "label" },
      stream: async () => {
        seg += 1;
        if (seg > 1) return { text: "", totalLines: 40, more: false };
        return { text: LONG_SRC + "\n", totalLines: 40, more: false };
      },
    });
    await flush(30);
    expect(n(".preview-body .preview-seg"), "分段容器在位").toBeGreaterThan(0);
    expect(n(".preview-body .cl"), "分段内容已切行").toBeGreaterThan(30);
    expect(n(".preview-body .code-fold"), "★ 流式分段同样不得有折叠按钮").toBe(0);
  });
});

// ============================================================================
// ② 任务 B：停靠而非覆盖
// ============================================================================
describe("W2058 ② 预览 = 停靠侧栏（不再覆盖正文）", () => {
  it("宿主挂进 #main（停靠的定位包含块），不是 document.body", async () => {
    const panel = await boot();
    await openCode(panel, LONG_SRC);
    const host = q(".preview-host");
    expect(host, "宿主必须在").not.toBeNull();
    expect(host?.parentElement?.id, "★ 宿主必须是 #main 的直接子项").toBe("main");
    expect(host?.closest(".chat-shell"), "宿主不得落在 .chat-shell 里").toBeNull();
  });

  it("★ 几何上不可能相交：宿主 right:0 + width:var(--preview-w)，#main 让位同样宽度", () => {
    const preview = css("preview.css");
    const host = rule(preview, ".preview-host");
    const dock = rule(preview, "body.preview-open #main");
    // 面板 = [边框盒右缘 − W, 边框盒右缘]；内容 = [内容盒左缘, 边框盒右缘 − W]
    // ⇒ 两者边界重合、零重叠，与内容长度/滚动位置无关（modes.ts 的判定法）。
    expect(host, "宿主贴右缘（绝对定位包含块 = #main 的 padding box）").toMatch(/right:\s*0/);
    expect(host, "宿主宽度读单一真源 --preview-w").toMatch(/width:\s*var\(--preview-w\)/);
    expect(dock, "★ #main 必须让出**同一个**宽度（两处各写一份就会立刻错位成覆盖）")
      .toMatch(/padding-right:\s*var\(--preview-w\)/);
    expect(host, "★ 宿主不得再用 fixed 铺在正文上").not.toMatch(/position:\s*fixed/);
    expect(preview, "--preview-w 必须有定义（唯一真源）").toMatch(/--preview-w:\s*min\(560px,\s*46vw\)/);
  });

  it("打开加 body.preview-open（让位生效）、关闭摘掉（正文恢复整宽）", async () => {
    const panel = await boot();
    await openCode(panel, LONG_SRC);
    expect(doc.body.classList.contains("preview-open"), "打开 ⇒ 让位").toBe(true);
    panel.closePreview();
    expect(doc.body.classList.contains("preview-open"), "关闭 ⇒ 撤销让位").toBe(false);
  });

  it("与**工作台右栏**共存：预览打开时 .wb-host 让开同一条带（两者都贴 #main 右缘）", () => {
    const preview = css("preview.css");
    expect(rule(preview, "body.preview-open .wb-host"), "★ 工作台必须退到预览左侧，否则被盖住")
      .toMatch(/right:\s*var\(--preview-w\)/);
  });

  it("面板不再有浮层阴影（分界改由 border-left 发丝线承担）", () => {
    expect(rule(css("preview.css"), ".preview-panel"), "停靠栏不投影到左侧正文上").not.toMatch(/box-shadow/);
  });

  it("窄屏（≤640px）刻意退回覆盖式：让位归零 + 宿主改回 fixed", () => {
    const resp = css("responsive.css");
    // ★ 不能取**第一个** 640px 块：responsive.css 里有多个 640px 档（顶栏/抽屉/…）。
    //   按「块内含 preview-open」定位，才是本轮那一档（取第一个会读到顶栏块而假红）。
    const blocks = Array.from(resp.matchAll(/@media \(max-width: 640px\) \{([\s\S]*?)\n\}/g)).map((m) => m[1] ?? "");
    const block = blocks.find((b) => b.includes("body.preview-open #main")) ?? "";
    expect(block, "必须存在 ≤640px 的预览档（含 body.preview-open #main）").not.toBe("");
    expect(block, "窄屏不让位（390px 里让不出 560px）").toMatch(/body\.preview-open #main \{[^}]*padding-right:\s*0/);
    expect(block, "窄屏宿主回到 fixed 全高").toMatch(/position:\s*fixed/);
    expect(block, "窄屏工作台也不再退让").toMatch(/body\.preview-open \.wb-host \{[^}]*right:\s*0/);
  });

  it("★ z-index 层级门禁未被本轮改动带偏（.preview-host 仍是 35，登记项仍在）", () => {
    expect(rule(css("preview.css"), ".preview-host"), "值不变 ⇒ W2007 的 LEGACY_MAGIC 条目不会变陈旧")
      .toMatch(/z-index:\s*35/);
  });
});

// ============================================================================
// ③ 变异负控制：把实现改坏 ⇒ 对应断言必红（证明上面每组断言真的有牙）
// ============================================================================
describe("W2058 ③ 变异负控制（调包必红）", () => {
  it("调包 A：把 NO_FOLD 标记从 .preview-body 上摘掉 ⇒ 预览里折叠按钮**必然**回来", async () => {
    const panel = await boot();
    await openCode(panel, LONG_SRC);
    const body = q(".preview-body") as unknown as { removeAttribute(k: string): void };
    body.removeAttribute("data-code-fold");
    const enhance = (await import(/* @vite-ignore */ at("ui/enhance/index.ts"))) as { runEnhancers(c: unknown): void };
    enhance.runEnhancers(body); // 重跑增强（幂等：折叠那一步此前被跳过，故这次会补上）
    expect(n(".preview-body .code-fold"), "★ 摘掉标记后折叠按钮必须出现 ⇒ 标记确实是判据").toBe(1);
    expect(n(".preview-body .code-folded"), "★ 且确实进入折叠态").toBe(1);
  });

  it("调包 B：把让位宽度改成 0 ⇒ 「两处同宽」这条断言必红", () => {
    const real = css("preview.css");
    const broken = real.replace("padding-right: var(--preview-w)", "padding-right: 0px");
    expect(broken, "前置：调包确实改了 CSS").not.toBe(real);
    // 判据在调包后必须失败（= 真实 CSS 上通过的那条）
    expect(rule(real, "body.preview-open #main")).toMatch(/padding-right:\s*var\(--preview-w\)/);
    expect(rule(broken, "body.preview-open #main")).not.toMatch(/padding-right:\s*var\(--preview-w\)/);
  });

  it("调包 C：把宿主改回 position:fixed ⇒ 「不再覆盖」这条断言必红", () => {
    const real = css("preview.css");
    const broken = real.replace("position: absolute;", "position: fixed;");
    expect(broken, "前置：调包确实改了 CSS").not.toBe(real);
    expect(rule(real, ".preview-host")).not.toMatch(/position:\s*fixed/);
    expect(rule(broken, ".preview-host"), "★ fixed 是改动前的覆盖式形态").toMatch(/position:\s*fixed/);
  });

  it("调包 D：把 .wb-host 的退让删掉 ⇒ 「与工作台共存」这条断言必红", () => {
    const real = css("preview.css");
    const broken = real.replace("body.preview-open .wb-host { right: var(--preview-w); }", "");
    expect(broken, "前置：调包确实删了规则").not.toBe(real);
    let threw = false;
    try { rule(broken, "body.preview-open .wb-host"); } catch { threw = true; }
    expect(threw, "★ 删掉退让后 rule() 必须找不到规则（= 断言会红）").toBe(true);
  });

  it("调包 E：折叠阈值调到极大 ⇒ 聊天的「仍然折叠」断言必红（证明那条断言测的是折叠本身）", async () => {
    await boot(); // 同上：不装配则 code-extras 未挂，这条会**假绿**（本轮实测踩到过）
    const enhance = (await import(/* @vite-ignore */ at("ui/enhance/index.ts"))) as { runEnhancers(c: unknown): void };
    const extras = (await import(/* @vite-ignore */ at("ui/enhance/code-extras.ts"))) as { setCodeFoldLines(n: number): void };
    const box = doc.createElement("div") as unknown as ElLike;
    box.className = "content rendered";
    box.innerHTML = "<pre><code class='language-ts'>" + LONG_SRC + "</code></pre>";
    doc.body.appendChild(box);
    extras.setCodeFoldLines(9999); // 调包：阈值高到永不折叠
    enhance.runEnhancers(box);
    expect(n(".content .code-fold"), "★ 阈值调高后聊天里也不折叠 ⇒ 上面那条断言确实在测阈值判据").toBe(0);
    extras.setCodeFoldLines(30); // 还原（模块级镜像，避免污染同文件后续用例）
  });
});
