// @vitest-environment node
// ============================================================================
// tests/w9346-trend-color.test.ts — W9346：趋势图序列色**走 token**、多主题可读。
//
// 用户报障（真机截图）：深色主题下「每日 Token 趋势」的**趋势线太浅**看不出来；
// 图例里第一条序列（MiniMax-M3.1-Flash-Preview）的**色块几乎看不见**。
// 根因：trend.ts 写死 `SERIES_COLORS = ['#1a1a1a', …]`（注释「黑白主题下用不同灰阶」）
// ⇒ 深色主题上第一条 ≈ 背景色。
//
// 本门禁守**三条契约**（都是「这三条破了就一定会回到那个 bug」的因，不是排版细节）：
//   ① **JS 里不再有色值字面量** —— 颜色只活在 CSS 的 `--usage-series-N`；
//   ② **每个主题各自定义整套 6 条** —— 漏一个主题 ⇒ 那个主题上又变回「看不见」；
//   ③ **图例色块与折线读同一个 var** —— 不同源就等于「一处改了另一处没改」。
//
// ★ 对比度/色差**不在这里判**（那是像素事实）：见 scripts/a11y/w9346-trend-color-probe.mjs，
//   它在真机上量「线对底的对比度」「两条序列的 ΔE」「色块非背景色」。
//   按铁律 11，这里不钉任何具体色值 —— 换色卡不该让本门禁红。
// ============================================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(process.cwd(), "apps", "web", "src", "styles", "usage.css"), "utf8");
const TREND = readFileSync(join(process.cwd(), "apps", "web", "src", "ui", "usage", "trend.ts"), "utf8");

/** 去注释（注释里也会出现选择器与色值样例，会把「存在性」类断言带偏）。 */
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, "");

/** 某选择器下定义的 --usage-series-* → 色值。 */
function seriesVars(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  const css = strip(CSS);
  // 只取该选择器**自己**的块（含分组里属于它的）。
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const list = (m[1] ?? "").split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (!list.includes(selector)) continue;
    for (const v of (m[2] ?? "").matchAll(/(--usage-series-(\d))\s*:\s*([^;]+);/g)) {
      out[v[1] ?? ""] = (v[3] ?? "").trim();
    }
  }
  return out;
}

const NAMES = [1, 2, 3, 4, 5, 6].map((i) => `--usage-series-${i}`);

describe("W9346 ① 颜色只在 CSS 里（JS 不带色值）", () => {
  it("trend.ts 的**代码**里没有任何十六进制色值字面量", () => {
    // ★ 必须先去注释：注释里引用旧值（`'#1a1a1a'`）是**解释成因**，
    //   留着才能让后来人看懂「为什么不能写死」；那不是「JS 里带了色值」。
    const code = strip(TREND);
    const hexes = code.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hexes, "trend.ts 的代码不许写死色值（颜色唯一真源是 usage.css 的 token）").toEqual([]);
  });

  it("trend.ts 不再有 SERIES_COLORS 之类的写死色数组", () => {
    expect(strip(TREND), "写死色数组已删除").not.toMatch(/SERIES_COLORS/);
  });

  it("折线与端点都写 var(--usage-series-N)（颜色来自 CSS，不是属性里的色值）", () => {
    expect(strip(TREND), "折线 stroke 走 token").toContain("var(--usage-series-");
    // 图例**不**再 inline 写 background（inline 会盖过主题变量，切主题不改色）。
    expect(strip(TREND), "图例色块不许 inline background").not.toMatch(/\.style\.background/);
  });
});

describe("W9346 ② 每个主题各自定义整套 6 条（漏一个 = 那个主题上又看不见）", () => {
  for (const [theme, selector] of [
    ["浅色基准（:root）", ":root"],
    ["深色", '[data-theme="dark"]'],
    ["claude 浅色", '[data-theme="claude"]'],
  ] as const) {
    it(`${theme} 定义了全部 6 条序列色`, () => {
      const vars = seriesVars(selector);
      const missing = NAMES.filter((n) => !(n in vars) || vars[n] === "");
      expect(missing, `${selector} 缺少：${missing.join(", ")}`).toEqual([]);
    });
  }

  it("claude 深色（@media prefers-color-scheme: dark）也定义了全部 6 条", () => {
    // 主题机制：<html data-theme> 单属性；claude 的深色是「同一 id + 系统偏好」（见 theme-claude.css 头注）。
    const m = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*\[data-theme="claude"\]\s*\{([^}]*)\}/.exec(strip(CSS));
    expect(m, "claude 深色覆盖块必须存在（否则系统深色偏好下回落到浅色值）").not.toBeNull();
    const defined = new Set(Array.from((m![1] ?? "").matchAll(/(--usage-series-\d)\s*:/g)).map((x) => x[1]));
    const missing = NAMES.filter((n) => !defined.has(n));
    expect(missing, `claude 深色缺少：${missing.join(", ")}`).toEqual([]);
  });

  it("深色与浅色是两套**不同的**取值（同一组灰阶在深底上就是背景色）", () => {
    const light = seriesVars(":root");
    const dark = seriesVars('[data-theme="dark"]');
    const same = Object.keys(light).filter((k) => light[k] === dark[k]);
    expect(same, "深色不能照抄浅色值 —— 那正是「深底上等于背景」的成因").toEqual([]);
  });
});

describe("W9346 ③ 图例色块与折线同源", () => {
  it("图例色块的 background 走 var(--usage-series-N)，不是写死色", () => {
    const css = strip(CSS);
    const base = /\.usage-legend-swatch\s*\{([^}]*)\}/.exec(css);
    expect(base, "色块基础规则必须存在").not.toBeNull();
    const body = base?.[1] ?? "";
    expect(body, "色块走 token").toMatch(/background:\s*var\(--usage-series-1\)/);
    // 基础规则里不许出现任何硬编码 hex / rgb。
    expect(body.match(/#[0-9a-fA-F]{3,8}|rgba?\(/g) ?? []).toEqual([]);
  });

  it("第 2..6 条序列各有对应的 data-series 规则（少一条 = 那条序列的色块看不见）", () => {
    const css = strip(CSS);
    for (let i = 2; i <= 6; i += 1) {
      const re = new RegExp(`\\.usage-legend-swatch\\[data-series="${i}"\\]\\s*\\{[^}]*var\\(--usage-series-${i}\\)`);
      expect(re.test(css), `data-series="${i}" → --usage-series-${i} 的规则缺失`).toBe(true);
    }
  });

  it("trend.ts 给色块挂的是 1..6 的下标（与 CSS 的选择器对得上）", () => {
    // 断言的是**契约**（下标从 1 起、范围 1..6），不是某个具体色。
    const code = strip(TREND);
    expect(code).toMatch(/data-series/);
    const n = code.match(/\(i\s*%\s*(\d+)\)\s*\+\s*1/);
    expect(n, "下标换算应是 (i % N) + 1（1-based）").not.toBeNull();
    expect(Number(n![1]), "序列数应与 CSS 的 6 条一致").toBe(6);
  });

  it("折线有 .usage-trend-line 类（几何/线宽搬进 CSS，颜色交给 token）", () => {
    expect(strip(TREND)).toContain("usage-trend-line");
    const css = strip(CSS);
    expect(/\.usage-trend-line\s*\{[^}]*stroke-width/.test(css), "线宽在 CSS 里").toBe(true);
  });
});
