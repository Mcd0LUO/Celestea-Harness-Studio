// @vitest-environment jsdom
// ============================================================================
// W2052 — 正文里的可点路径**必须看得出可点**（可用性缺陷的样式门禁）。
// ----------------------------------------------------------------------------
// 用户原话：「链接点击和文件路径点击怎么还没做」。
//
// 复核结论：**功能是做了的**（W2013 点击委托 + W2025 键盘通道，见
// ui/enhance/file-link-mark.ts），缺的是**视觉提示** —— 该模块给命中节点写了
// data-fl-hit / data-fl-path / role=button / title / tabindex，但**样式侧一个
// 字节都没有**。真机实测（1440x900，CDP getComputedStyle）改动前与周围正文
// **逐条相同**：color rgb(17,17,17) / text-decoration none / cursor auto。
// 于是用户判定「没做」——这不是误解，是产品确实没告诉他。
//
// 本文件守四件事，每件都配变异负控制（见报告）：
//   ① 静态就与正文**可分辨**（不是「hover 才有」——那样静止时仍看不出可点）；
//   ② cursor 是 pointer（桌面端主要的可点性提示之一）；
//   ③ :focus-visible 有焦点环（WCAG 2.4.7 / 2.4.11），且用的是既有 token；
//   ④ 浅/深两套配色下线与焦点环都**达标**（WCAG 1.4.11 非文本 >= 3:1）。
//
// ★ 为什么断言「computed 值与正文不同」而不是断言某条具体声明：
//   本仓真实踩过的坑 —— mono 主题下 --c-accent === --c-text-1（都是 #111），
//   所以「照 <a> 那样加个 color」在本主题里 computed 值**一字不变**。
//   若门禁只查「CSS 里有 color: var(--c-accent)」，那条规则会绿着通过、
//   而用户看到的仍然是「和正文一模一样」。断言必须落在**用户能看到的东西**上。
//
// ★ 为什么用 getComputedStyle 而不是读 CSS 文本：
//   jsdom 30 走真实级联（选择器匹配 + 特异性 + 简写展开都真算），实测
//   [data-fl-hit] 的 cursor / text-decoration-line / text-decoration-color
//   都能取到正确值。唯一的限制是 **var() 不解析**（原样返回 "var(--x)"），
//   所以「颜色 token 的对比度」那部分改从 tokens.css 直接解析（见下 §④），
//   两条路径各取所长，不互相假装。
// ============================================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

/** 与 file-link-mark.ts 的 HIT_ATTR 同一字面量（那边是 TS 常量，跨环境取值不便）。 */
const HIT = "data-fl-hit";
/**
 * CSS 侧选择器：样式规则写的是**属性存在** `[data-fl-hit]`，不是 `[data-fl-hit="1"]`。
 * 这个区别本轮真踩到过：一开始拿 `[data-fl-hit="1"]` 去 CSS 里找规则，一条都匹配
 * 不到（hitRules() 返回空串、9 条断言全红），而产品 CSS 其实是对的 —— 假红。
 * DOM 侧仍按 "1" 精确匹配（markHit 写的就是 "1"）。
 */
const HIT_CSS = "[" + HIT;

const STYLES = join(process.cwd(), "apps/web", "src", "styles");
const COMPONENTS = readFileSync(join(STYLES, "components.css"), "utf8");
const TOKENS = readFileSync(join(STYLES, "tokens.css"), "utf8");
const CLAUDE = readFileSync(join(STYLES, "theme-claude.css"), "utf8");

/** 去注释：注释里也写了选择器与示例值，会把「规则存在」这类断言带偏。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 取某选择器块（大括号配对）的正文；取不到返回 ""。 */
function block(css: string, selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) return "";
  const start = css.indexOf("{", i);
  let depth = 0;
  for (let j = start; j < css.length; j++) {
    if (css[j] === "{") depth++;
    else if (css[j] === "}") {
      depth--;
      if (depth === 0) return css.slice(start + 1, j);
    }
  }
  throw new Error("unbalanced braces for " + selector);
}

/** 解析块里的 --x: value; 声明。 */
function vars(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1] as string] = (m[2] as string).trim();
  return out;
}

// ---------------------------------------------------------------------------
// ① 静态可分辨：把产品 CSS 真装进文档，读 computed 值与正文对照
// ---------------------------------------------------------------------------

/**
 * 只装 **components.css 里 [data-fl-hit] 那几条规则**，不是整份文件。
 * 理由：整份 components.css 会牵动大量与本题无关的规则（布局/浮层），
 * 在 jsdom 里既慢又可能因缺少祖先节点而误判；而本门禁要守的正是
 * 「file-link 那几条规则是否真的让命中节点与正文可分辨」。
 */
function hitRules(): string {
  const clean = stripComments(COMPONENTS);
  const out: string[] = [];
  for (const m of clean.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sels = (m[1] ?? "").split(",").map((s) => s.trim());
    if (sels.some((s) => s.includes(HIT_CSS))) out.push(m[0]);
  }
  return out.join("\n");
}

/** 正文容器：一个 <p> 里既有普通文字，也有一个命中节点（与真实 DOM 同构）。 */
function mount(): { prose: HTMLElement; hit: HTMLElement } {
  const box = document.createElement("div");
  box.className = "content rendered";
  const p = document.createElement("p");
  p.textContent = "先看 ";
  const hit = document.createElement("code");
  hit.setAttribute(HIT, "1"); // 与 file-link-mark.ts 的 markHit 同一取值
  hit.setAttribute("data-fl-path", "apps/web/src/styles/components.css");
  hit.textContent = "apps/web/src/styles/components.css";
  p.appendChild(hit);
  p.appendChild(document.createTextNode(" 这一段是普通正文。"));
  box.appendChild(p);
  document.body.appendChild(box);
  return { prose: p, hit };
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  const s = document.createElement("style");
  s.textContent = hitRules();
  document.head.appendChild(s);
});

describe("W2052 ① 可点路径与正文必须可分辨", () => {
  it("规则存在（命中选择器至少有一条声明块）", () => {
    expect(hitRules()).not.toBe("");
  });

  it("★ 静止态就有可分辨的视觉（下划线 / 颜色 / cursor 三者至少一项不同）", () => {
    const { prose, hit } = mount();
    const a = getComputedStyle(prose);
    const b = getComputedStyle(hit);
    const differs =
      a.color !== b.color ||
      a.textDecorationLine !== b.textDecorationLine ||
      a.textDecorationColor !== b.textDecorationColor ||
      a.cursor !== b.cursor;
    expect(
      differs,
      "命中路径与正文的 computed 样式完全相同 ⇒ 用户看不出可点（这正是用户报障的形态）",
    ).toBe(true);
  });

  it("★ 下划线是**静态**的（不是 :hover 才有 —— 那样静止时仍看不出可点）", () => {
    const { hit } = mount();
    expect(getComputedStyle(hit).textDecorationLine).toBe("underline");
  });

  it("下划线的线色与正文文字色**不同**（否则线淹没在字里，等于没画）", () => {
    const { hit } = mount();
    const s = getComputedStyle(hit);
    expect(s.textDecorationColor).not.toBe(s.color);
  });

  it("下划线离开字形（text-underline-offset 非 0/auto）", () => {
    const { hit } = mount();
    const off = getComputedStyle(hit).textUnderlineOffset;
    expect(off).not.toBe("auto");
    expect(parseFloat(off)).toBeGreaterThan(0);
  });
});

describe("W2052 ② cursor 必须表达可点", () => {
  it("★ 命中节点是 pointer（桌面端主要的可点性提示）", () => {
    const { hit } = mount();
    expect(getComputedStyle(hit).cursor).toBe("pointer");
  });

  it("正文仍是默认 cursor（不得把整段正文变成手型）", () => {
    const { prose } = mount();
    expect(getComputedStyle(prose).cursor).not.toBe("pointer");
  });
});

/**
 * 取 `[data-fl-hit]…:focus-visible` 规则的声明体（去注释后按选择器过滤）。
 * 供 §③ 用：jsdom 不解析 var()，所以「环声明了什么」只能从文本读；
 * 而「聚焦本身是否成立」由下面的 computed 断言守。
 */
function focusVisibleDecls(): string {
  return [...stripComments(COMPONENTS).matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => (m[1] ?? "").includes(HIT_CSS) && (m[1] ?? "").includes("focus-visible"))
    .map((m) => m[2] ?? "")
    .join(";");
}

describe("W2052 ③ 键盘聚焦必须有可见焦点环（WCAG 2.4.7 / 2.4.11）", () => {
  it("★ 键盘聚焦时元素真的匹配 :focus-visible（前置：聚焦本身生效）", () => {
    const { hit } = mount();
    hit.tabIndex = 0;
    hit.focus();
    expect(document.activeElement).toBe(hit);
    expect(hit.matches(":focus-visible")).toBe(true);
  });

  it("★ :focus-visible 声明了 >= 2px 的 outline，且颜色走既有 token", () => {
    // ★ 为什么这里读 CSS 文本而不是 getComputedStyle：
    //   jsdom 30 的 CSS 解析器**会整条丢掉含 var() 的 outline 简写** ——
    //   实测：产品 CSS 明明写着 `outline: 2px solid var(--c-focus-ring)`，
    //   jsdom 里 outlineStyle 仍是 none / width 仍是 medium；而同一份规则在
    //   真实 Chrome 里算出 2px solid rgba(0, 0, 0, 0.45)（见报告真机数据）。
    //   这是 jsdom 的能力边界，不是产品缺陷。若在这里断言 computed，门禁会
    //   **红在一个假象上**，而唯一的「修法」是别用 token —— 那更糟。
    //   所以分工：文本侧守「声明存在且用了 token」，真机侧守「真的画出来了」。
    const decls = focusVisibleDecls();
    expect(decls).toContain("--c-focus-ring");
    const m = /outline\s*:\s*(\d+(?:\.\d+)?)px\s+solid/.exec(decls);
    expect(m, "focus-visible 规则里必须有一条 outline: <n>px solid …：" + decls).not.toBeNull();
    expect(parseFloat(m?.[1] as string)).toBeGreaterThanOrEqual(2);
  });

  it(":focus-visible 的环与文字之间留了偏移（不贴着字形）", () => {
    const m = /outline-offset\s*:\s*(-?\d+(?:\.\d+)?)px/.exec(focusVisibleDecls());
    expect(m, "focus-visible 规则里必须有 outline-offset").not.toBeNull();
    expect(parseFloat(m?.[1] as string)).toBeGreaterThan(0);
  });

  it("--c-focus-ring 在四套配色下都有定义（不是只在 mono 里成立）", () => {
    const t = vars(block(stripComments(TOKENS), ":root,"));
    expect(t["--c-focus-ring"]).toBeDefined();
    const claudeAll = stripComments(CLAUDE);
    const mediaStart = claudeAll.indexOf("@media (prefers-color-scheme: dark)");
    expect(vars(block(claudeAll.slice(0, mediaStart), '[data-theme="claude"]'))["--interactive-focus-ring"]).toBeDefined();
    expect(vars(block(claudeAll.slice(mediaStart), '[data-theme="claude"]'))["--interactive-focus-ring"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ④ 四套配色下的对比度（WCAG 2.1 相对亮度）
//
// 为什么从 CSS 文本解析而不是 getComputedStyle：jsdom **不解析 var()**
// （实测返回字面量 "var(--c-text-3)"），所以带 token 的颜色只能自己跟别名链。
// 这与 theme-claude.test.ts 的既有做法一致（那里也是文本解析 + resolve）。
// ---------------------------------------------------------------------------

/** token -> 最终值：跟随 var() 别名链。 */
function resolve(table: Record<string, string>, name: string, depth = 0): string {
  if (depth > 10) throw new Error("var() chain too deep at " + name);
  const raw = table[name];
  if (raw === undefined) throw new Error("token not defined: " + name);
  const m = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(raw.trim());
  if (!m) return raw.trim();
  return resolve(table, m[1] as string, depth + 1);
}

/** 颜色：实色 #rrggbb 或 rgba()。 */
interface Rgba { r: number; g: number; b: number; a: number }

/**
 * 解析 token 的最终值。
 *
 * 必须支持 rgba：本仓的焦点环就是半透明墨（mono/dark 的
 * --interactive-focus-ring = rgba(0,0,0,0.45) / rgba(255,255,255,0.45)），
 * 而**半透明色的对比度不能拿它自己的 RGB 去算** —— 必须先按 alpha 合成到
 * 它实际所在的底色上，否则算出来的是「黑对白」这种不存在的画面
 * （W2006 的实算注释里写的正是合成后的值）。
 */
function rgbaOf(c: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(c.trim());
  if (hex !== null) {
    const n = parseInt(hex[1] as string, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(c.trim());
  if (m === null) throw new Error("unsupported color syntax: " + c);
  const p = (m[1] as string).split(",").map((x) => parseFloat(x.trim()));
  return { r: p[0] as number, g: p[1] as number, b: p[2] as number, a: p.length > 3 ? (p[3] as number) : 1 };
}

/** 半透明前景合成到实底上（底色本身必须是实色）。 */
function over(fg: Rgba, bg: Rgba): Rgba {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

function luminance(c: Rgba): number {
  const f = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

/** 两个颜色 token 的对比度：各自解析 -> 半透明者合成到底色 -> WCAG 2.1 相对亮度。 */
function contrastOf(fg: string, bg: string): number {
  const b = rgbaOf(bg);
  if (b.a < 1) throw new Error("背景必须是实色: " + bg);
  const f = over(rgbaOf(fg), b);
  const la = luminance(f);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const TOKENS_CLEAN = stripComments(TOKENS);
const CLAUDE_CLEAN = stripComments(CLAUDE);
const CLAUDE_MEDIA = CLAUDE_CLEAN.indexOf("@media (prefers-color-scheme: dark)");
/**
 * 三层叠加，与浏览器的真实级联同序（tokens.css 的分层见其文件头）：
 *   static  : `:root { --s-* }`                                 —— 原始色板（唯一写死颜色处）
 *   alias   : `:root, [data-theme="mono"] { --c-* -> --s-* }`    —— 别名层
 *   主题覆盖: `[data-theme="dark"|"claude"] { --s-* / --interactive-* }`
 * 关键：别名层挂在 `:root,` 上 ⇒ 它在任何 data-theme 下都生效（html 就是 :root），
 * 只有 --s-* 与 --interactive-* 被各主题覆盖。所以四套配色都必须是
 * static + alias + 该主题覆盖，而不是「只解析该主题块」—— 那样 --c-text-1
 * 这类纯别名 token 根本不存在（实测报 token not defined）。
 */
const STATIC = vars(block(TOKENS_CLEAN, ":root {"));
const ALIAS = vars(block(TOKENS_CLEAN, ":root,"));
const DARK = vars(block(TOKENS_CLEAN, '[data-theme="dark"]'));
const CLAUDE_LIGHT = vars(block(CLAUDE_CLEAN.slice(0, CLAUDE_MEDIA), '[data-theme="claude"]'));
const CLAUDE_DARK = vars(block(CLAUDE_CLEAN.slice(CLAUDE_MEDIA), '[data-theme="claude"]'));
/** mono（默认主题）：static + alias 两层即是全部。 */
const MONO = { ...STATIC, ...ALIAS };

/** 四套配色：名称 + 叠加后的 token 表。 */
const THEMES: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ["mono", MONO],
  ["dark", { ...MONO, ...DARK }],
  ["claude-light", { ...MONO, ...CLAUDE_LIGHT }],
  ["claude-dark", { ...MONO, ...CLAUDE_DARK }],
];

/** 下划线颜色 token（components.css 里声明的那一个）。 */
const DECO_TOKEN = "--c-text-3";

describe("W2052 ④ 四套配色下都正确（WCAG 1.4.11 非文本 >= 3:1）", () => {
  it("命中规则的下划线颜色确实引用 token（不是写死颜色）", () => {
    const clean = stripComments(COMPONENTS);
    const decl = [...clean.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter((m) => (m[1] ?? "").includes(HIT_CSS))
      .map((m) => m[2] ?? "")
      .join(";");
    expect(decl).toContain("text-decoration-color: var(" + DECO_TOKEN + ")");
  });

  for (const [name, t] of THEMES) {
    it(name + "：下划线 / 卡片底 >= 3:1", () => {
      const r = contrastOf(resolve(t, DECO_TOKEN), resolve(t, "--bg-layer-1"));
      expect(r, name + " 下划线对比度 " + r.toFixed(2)).toBeGreaterThanOrEqual(3);
    });

    it(name + "：下划线 / 页面底 >= 3:1", () => {
      const r = contrastOf(resolve(t, DECO_TOKEN), resolve(t, "--bg-base"));
      expect(r, name + " 下划线对比度 " + r.toFixed(2)).toBeGreaterThanOrEqual(3);
    });

    it(name + "：下划线 / 代码底 >= 3:1（行内 code 形态就画在这个底上）", () => {
      const r = contrastOf(resolve(t, DECO_TOKEN), resolve(t, "--bg-code"));
      expect(r, name + " 下划线对比度 " + r.toFixed(2)).toBeGreaterThanOrEqual(3);
    });

    it(name + "：焦点环 / 卡片底 >= 3:1", () => {
      const r = contrastOf(resolve(t, "--c-focus-ring"), resolve(t, "--bg-layer-1"));
      expect(r, name + " 焦点环对比度 " + r.toFixed(2)).toBeGreaterThanOrEqual(3);
    });

    it(name + "：下划线必须**淡于**正文（否则密集路径会把正文切碎）", () => {
      const deco = contrastOf(resolve(t, DECO_TOKEN), resolve(t, "--bg-layer-1"));
      const text = contrastOf(resolve(t, "--c-text-1"), resolve(t, "--bg-layer-1"));
      expect(deco, name).toBeLessThan(text);
    });
  }

  it("四套配色的下划线颜色**各不相同**（说明 token 链真的跟着主题走）", () => {
    const seen = THEMES.map(([, t]) => resolve(t, DECO_TOKEN));
    expect(new Set(seen).size).toBe(THEMES.length);
  });
});
