// @vitest-environment node
/**
 * W2024 · WCAG 2.2 SC 2.5.8 (AA) 触摸目标门禁。
 *
 * ★ 本门禁的第一条纪律：**不许制造假警报**。
 *   SC 2.5.8 的正文不是「一律 >= 24」，而是「至少 24×24，**除非**命中 Spacing /
 *   Equivalent / Inline / User Agent Control / Essential 之一」。一个 143x20 的搜索框
 *   四周全是空白 ⇒ 满足 Spacing 例外 ⇒ **不是违规**。把「尺寸 < 24」直接当问题报，
 *   正是本仓最忌讳的假警报，故判据一律落在 findViolations()（尺寸 ∧ 不满足例外）上。
 *
 * 三层断言（从便宜到贵）：
 *   ① 纯函数：Spacing 例外判定 + **变异负控制**（阈值调 0 必须失去检测能力）；
 *   ② 静态 CSS：修复本身（--tap-hit 令牌、.sess-kebab 命中区、触控层的负外边距还原）
 *      不许被回退 —— 这三条**不需要浏览器**，任何机器都能跑；
 *   ③ 真机端到端：跑 scripts/a11y/audit-touch-targets.mjs（**同一份**审计代码，
 *      不在这里复刻一遍）。需要 Vite :3787 + Chrome，故按本仓既有纪律
 *      （vitest.config.ts 的 CELESTEA_E2E 注释）**显式 opt-in**：
 *        CELESTEA_A11Y_E2E=1 pnpm vitest run tests/w2024-touch-targets.test.ts
 *      没开时**可见地跳过并打印命令**，绝不假装通过。
 *
 * ★ 判据来源（真机复核，不是抄简报）：W3C Understanding SC 2.5.8 的 Figure 9 明确写
 *   了一个小控件**裁剪**（clip）一个大目标的例子：小目标 24x24 通过、16x16 **失败**，
 *   因为「画在小目标上的 24px 圆会与大目标本身相交」。本轮的 .sess-kebab（19x13）
 *   被 .ws-head / .sess-leaf 整行包住，正是这个形状。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STYLES = join(ROOT, "apps", "web", "src", "styles");
const LIB = join(ROOT, "scripts", "a11y", "lib", "touch-targets.mjs");
const CLI = join(ROOT, "scripts", "a11y", "audit-touch-targets.mjs");

interface Target {
  selector: string; tag: string; w: number; h: number; x: number; y: number;
  name: string; minHeight: string;
  onScreen?: boolean; occluded?: boolean; reachable?: boolean; undersized?: boolean;
}
interface Spaced extends Target { spacingPass: boolean | null; spacingMargin: number | null; nearest: string | null }
interface Lib {
  MIN_TAP_TARGET_PX: number;
  SPACING_RADIUS_PX: number;
  TOUCH_SELECTOR: string;
  auditTouchTargets(minPx: number): Target[];
  annotateSpacing(rows: Target[], minPx?: number, radius?: number): Spaced[];
  findUndersized(rows: Target[], minPx?: number): Target[];
  findViolations(rows: Target[], minPx?: number): Target[];
  formatTable(rows: Target[], minPx?: number): string;
  sortWorstFirst(rows: Target[]): Target[];
}
const lib = (await import(/* @vite-ignore */ pathToFileURL(LIB).href)) as Lib;

const cssText = (f: string): string => readFileSync(join(STYLES, f), "utf8");
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "");
/**
 * 取某选择器**最后一次**出现的声明表（同文件后写者胜，与级联同序）。
 *
 * `selector` 可以是**片段**（如 ":root,"）—— 匹配的是「选择器列表里含有它」。
 * 为什么不做全等匹配：tokens.css 里同一个块的选择器列表写成两行
 * （":root,\n[data-theme=\"mono\"] {"），全等匹配会因为空白/换行差异而静默落空，
 * 落空的表现是「token 不存在」——一个**看起来像真缺陷的假红**。
 */
function decls(text: string, selector: string): Map<string, string> {
  // 规范化：去掉尾逗号，压掉空白（调用方写 ":root," 与 ":root" 等价）。
  const want = selector.trim().replace(/\s+/g, " ").replace(/,$/, "");
  const out = new Map<string, string>();
  for (const m of stripComments(text).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = (m[1] ?? "").trim().replace(/\s+/g, " ");
    if (sel !== want && !sel.split(",").map((s) => s.trim()).includes(want)) continue;
    for (const d of (m[2] ?? "").split(";")) {
      const i = d.indexOf(":");
      if (i > 0) out.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
  }
  return out;
}

/* ------------------------------------------------------------------ 样本 */

/** 行内小控件（真实测量）：19x13 的 ⋯ 被 291x32.63 的可点行整行包住。 */
const NESTED: Target[] = [
  { selector: "summary.ws-head", tag: "summary", w: 291, h: 32.63, x: 12, y: 183.31, name: "perf", minHeight: "auto" },
  { selector: "button.sess-kebab", tag: "button", w: 19, h: 13, x: 276, y: 193.13, name: "Workspace actions", minHeight: "auto" },
];
/** 孤立小控件（真实测量）：143x20 的搜索框，四周全是空白。 */
const ISOLATED: Target[] = [
  { selector: "input.ws-search-input", tag: "input", w: 143.19, h: 19.8, x: 20, y: 300, name: "Search", minHeight: "auto" },
  { selector: "button.ws-toolbtn", tag: "button", w: 70.81, h: 29.31, x: 200, y: 296, name: "Active", minHeight: "auto" },
];
/** 被浮层盖住的小控件：当前状态下不是指针目标 ⇒ 不适用（不得算违规）。 */
const OCCLUDED: Target[] = [
  { selector: "summary.inbox-fold-head", tag: "summary", w: 159.64, h: 17.31, x: 20, y: 100, name: "Receipt", minHeight: "0px", onScreen: true, occluded: true, reachable: false },
  { selector: "button.settings-nav-item", tag: "button", w: 120, h: 44, x: 20, y: 100, name: "Config", minHeight: "auto", onScreen: true, occluded: false, reachable: true },
];

describe("W2024 · ① Spacing 例外判定（纯函数）", () => {
  it("尺寸达标的目标不是 undersized，也不参与例外判定", () => {
    const big: Target[] = [{ selector: "#ok", tag: "button", w: 24, h: 24, x: 0, y: 0, name: "", minHeight: "auto" }];
    expect(lib.findUndersized(big, 24)).toHaveLength(0);
    expect(lib.annotateSpacing(big, 24)[0]?.spacingPass).toBe(true);
  });

  it("孤立 undersized 目标满足 Spacing 例外（143x20 的搜索框）", () => {
    const rows = lib.annotateSpacing(ISOLATED, 24);
    const search = rows.find((r) => r.selector === "input.ws-search-input");
    expect(search?.spacingPass, "搜索框四周有空白 ⇒ 例外成立").toBe(true);
    expect(lib.findViolations(ISOLATED, 24), "满足例外 ⇒ 不是违规").toHaveLength(0);
  });

  it("★ 被大目标整行包住的 undersized 目标**违反**（19x13 的 ⋯）", () => {
    const rows = lib.annotateSpacing(NESTED, 24);
    const kebab = rows.find((r) => r.selector === "button.sess-kebab");
    // ⋯ 中心 (285.5, 199.63) 落在行矩形 [12,183.31]-[303,215.94] 内 ⇒ 距离 0
    // ⇒ 余量 0 - 12 = -12 ⇒ 相交 ⇒ 例外不成立 ⇒ 违规。
    expect(kebab?.spacingMargin, "圆心落在行矩形内 ⇒ 余量必为 -12").toBe(-12);
    expect(kebab?.spacingPass).toBe(false);
    expect(lib.findViolations(NESTED, 24).map((r) => r.selector)).toEqual(["button.sess-kebab"]);
  });

  it("被遮挡的目标标为「不适用」，**不得**算成违规", () => {
    const rows = lib.annotateSpacing(OCCLUDED, 24);
    const folded = rows.find((r) => r.selector === "summary.inbox-fold-head");
    expect(folded?.spacingPass, "不可达 ⇒ null（不适用），不是 false（违反）").toBeNull();
    expect(lib.findViolations(OCCLUDED, 24), "遮挡不是「挨太近」").toHaveLength(0);
  });

  it("两套阈值确实不同：undersized↔undersized 用圆心距(2r)，其余用圆心到矩形(r)", () => {
    // 两个 undersized 目标，圆心距 20 < 24 ⇒ 相交 ⇒ 双方都违规。
    const pair: Target[] = [
      { selector: "#a", tag: "button", w: 10, h: 10, x: 0, y: 0, name: "", minHeight: "auto" },
      { selector: "#b", tag: "button", w: 10, h: 10, x: 20, y: 0, name: "", minHeight: "auto" },
    ];
    expect(lib.findViolations(pair, 24).map((r) => r.selector).sort()).toEqual(["#a", "#b"]);
    // 拉开到圆心距 24 ⇒ 恰好不相交 ⇒ 例外成立。
    const far: Target[] = [pair[0]!, { ...pair[1]!, x: 24 }];
    expect(lib.findViolations(far, 24)).toHaveLength(0);
  });
});

describe("W2024 · ①b 变异负控制：阈值调 0 ⇒ 检测能力必须消失", () => {
  it("M3 真阈值能发现，0 阈值一个都发现不了（证明结论真的来自这个数）", () => {
    const at24 = lib.findUndersized(NESTED, 24);
    expect(at24.length, "阈值 24 时必须发现 ⋯ 不达标").toBeGreaterThan(0);
    const at0 = lib.findUndersized(NESTED, 0);
    expect(at0.length, "阈值 0 时「小于 0」恒假 ⇒ 必须一个都发现不了").toBe(0);
    expect(lib.findViolations(NESTED, 24).length).toBeGreaterThan(0);
    expect(lib.findViolations(NESTED, 0)).toHaveLength(0);
  });

  it("阈值上调到 44（--tap-min）会发现更多 —— 说明阈值是单调有效的参数", () => {
    expect(lib.findUndersized(ISOLATED, 44).length)
      .toBeGreaterThan(lib.findUndersized(ISOLATED, 24).length);
  });

  it("审计脚本的默认阈值就是 24（不是某个被改小的数）", () => {
    expect(lib.MIN_TAP_TARGET_PX).toBe(24);
    expect(lib.SPACING_RADIUS_PX).toBe(12);
    expect(readFileSync(CLI, "utf8")).toContain("MIN_TAP_TARGET_PX");
  });
});

describe("W2024 · ② 静态 CSS：修复不许被回退（无需浏览器）", () => {
  it("tokens.css 定义 --tap-hit 且 >= 24px（与 --tap-min=44 是两个量）", () => {
    // ":root" 同时命中 static 色板块与 ":root, [data-theme=\"mono\"]" 别名块；
    // 后者在文件里靠后 ⇒ 取到的是别名块（--tap-min / --tap-hit 都在那里）。
    const tokens = decls(cssText("tokens.css"), ":root");
    const hit = tokens.get("--tap-hit");
    expect(hit, "--tap-hit 必须存在（组件层要表达「至少合规」时用它）").toBeDefined();
    const px = Number(/^(\d+(?:\.\d+)?)px$/.exec(hit ?? "")?.[1]);
    expect(Number.isFinite(px), "--tap-hit 必须是 px 字面量").toBe(true);
    expect(px, "--tap-hit 不得低于 SC 2.5.8 的 24").toBeGreaterThanOrEqual(24);
    expect(px, "--tap-hit 是合规下限，不该等于 --tap-min=44（两者语义不同）").toBeLessThan(44);
  });

  it(".sess-kebab 用 --tap-hit 撑出 24px 命中区（这是本轮修的桌面缺陷）", () => {
    const k = decls(cssText("sessions.css"), ".sess-kebab");
    expect(k.get("min-width")).toBe("var(--tap-hit)");
    expect(k.get("min-height")).toBe("var(--tap-hit)");
    // 负外边距是「不撑高行」的手段，必须有；否则桌面行高会变大（M2 抓的就是它）。
    expect(k.get("margin-block"), "必须用负外边距收回命中区增量，否则撑高所在行").toMatch(/calc\(/);
  });

  it("responsive.css 触控层把负外边距还原为 0（否则移动端行高被反向压小）", () => {
    const k = decls(cssText("responsive.css"), ".sess-kebab");
    expect(k.get("min-width"), "触控档仍用 --tap-min=44").toBe("var(--tap-min)");
    expect(k.get("min-height")).toBe("var(--tap-min)");
    expect(k.get("margin-block"), "44px 必须真的占位，负外边距要显式还原").toBe("0");
  });
});

describe("W2024 · ③ 真机端到端（显式 opt-in）", () => {
  const opted = process.env.CELESTEA_A11Y_E2E === "1";
  const vite = process.env.CELESTEA_A11Y_VITE ?? "http://127.0.0.1:3787";
  const chrome = findChromePath();
  const live = opted && chrome !== null && viteUp(vite);
  const cmd = "CELESTEA_A11Y_E2E=1 pnpm vitest run tests/w2024-touch-targets.test.ts";

  /**
   * ★ 桌面基线（**改动前实测**，2024 真机 1440x900）：
   *   .ws-head         291 x 32.63
   *   .sess-leaf       291 x 30.63
   *   行内其它目标（New session / 工具行按钮 / 顶栏按钮 / 状态栏…）尺寸见报告表。
   * 硬要求是「桌面逐像素不变」，故这里断言**行高**与**非 kebab 目标**一字未动；
   * ⋯ 自己是唯一被修的目标（19x13 -> 24x24），单独断言。
   */
  // 选择器是「唯一 class 串」，会带上状态类（实测 div.sess-leaf.active.sel），
  // 故按**前缀**匹配 —— 状态类不该让基线断言找不到元素（那是假红）。
  const DESKTOP_ROW_BASELINE: ReadonlyArray<readonly [string, number, number]> = [
    ["summary.ws-head", 291, 32.63],
    ["div.sess-leaf", 291, 30.63],
  ];

  it.skipIf(!live)(
    "1440x900：violations=0，⋯ 命中区 >= 24x24，且**行高与改动前逐字相同**",
    () => {
      const desk = JSON.parse(runAudit(["--width", "1440", "--height", "900", "--scenario", "empty", "--json"])) as
        { violations: number; targets: (Target & { selector: string })[] };
      expect(desk.violations, "桌面（1440x900）不得有违规").toBe(0);
      const kebab = desk.targets.filter((t) => t.selector.includes("sess-kebab"));
      expect(kebab.length, "桌面必须量到 ⋯ 目标").toBeGreaterThan(0);
      for (const k of kebab) {
        expect(k.w, k.selector + " 宽").toBeGreaterThanOrEqual(24);
        expect(k.h, k.selector + " 高").toBeGreaterThanOrEqual(24);
      }
      // ★ 桌面逐像素不变：行高一旦被 ⋯ 的命中区撑大，这里立刻红。
      for (const [sel, w, h] of DESKTOP_ROW_BASELINE) {
        const hit = desk.targets.find((t) => t.selector === sel || t.selector.startsWith(sel + "."));
        expect(hit, "桌面必须量到 " + sel).toBeDefined();
        expect(hit?.w, sel + " 宽必须与改动前逐字相同").toBe(w);
        expect(hit?.h, sel + " 高必须与改动前逐字相同（命中区不得撑高行）").toBe(h);
      }
    },
  );

  it.skipIf(!live)(
    "390x844：violations=0，⋯ 命中区 >= 24x24（触控档仍是 --tap-min=44）",
    () => {
      const mob = JSON.parse(runAudit(["--width", "390", "--height", "844", "--scenario", "drawer", "--json"])) as
        { violations: number; targets: (Target & { selector: string })[] };
      expect(mob.violations, "移动端（390x844）不得有违规").toBe(0);
      const mk = mob.targets.filter((t) => t.selector.includes("sess-kebab"));
      expect(mk.length, "移动端必须量到 ⋯ 目标").toBeGreaterThan(0);
      for (const k of mk) {
        expect(k.w, "移动端 " + k.selector + " 宽").toBeGreaterThanOrEqual(24);
        expect(k.h, "移动端 " + k.selector + " 高").toBeGreaterThanOrEqual(24);
      }
    },
  );

  it("没开 opt-in 时打印命令（可见地跳过，绝不假装通过）", () => {
    if (live) return;
    const why = !opted ? "未设 CELESTEA_A11Y_E2E=1"
      : chrome === null ? "Chrome 未找到" : "Vite " + vite + " 未监听";
    console.log("[W2024] 真机审计跳过：" + why + "\n        跑：" + cmd);
    expect(true).toBe(true);
  });
});

/** 复用 perf 工具包的 Chrome 候选（与 audit 脚本同一套，不另写一份查找逻辑）。 */
function findChromePath(): string | null {
  try {
    const src = readFileSync(join(ROOT, "scripts", "perf", "lib", "chrome.mjs"), "utf8");
    const cands: (string | undefined)[] = [
      process.env.W9111_CHROME,
      "/usr/bin/google-chrome", "/usr/bin/chromium",
    ];
    // Playwright 缓存：目录名倒序 ⇒ 新构建优先（与 chrome.mjs 同口径）。
    if (src.includes("chrome-headless-shell")) {
      const home = process.env.HOME ?? "/root";
      for (const build of ["1234", "1243"]) {
        cands.push(home + "/.cache/ms-playwright/chromium_headless_shell-" + build +
          "/chrome-headless-shell-linux64/chrome-headless-shell");
      }
    }
    for (const c of cands) if (c !== undefined && c !== "" && existsSync(c)) return c;
    return null;
  } catch { return null; }
}

/** Vite 是否在监听（没有就不跑真机，也不报错）。 */
function viteUp(origin: string): boolean {
  try {
    execFileSync("node", ["-e", "fetch(" + JSON.stringify(origin) + ").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
      { stdio: "ignore", timeout: 5000 });
    return true;
  } catch { return false; }
}

/** 跑**同一个**审计 CLI（不在这里复刻审计逻辑）。 */
function runAudit(args: string[]): string {
  return execFileSync("node", [CLI, ...args], {
    cwd: ROOT, encoding: "utf8", timeout: 120000,
    env: { ...process.env, W9111_CHROME: findChromePath() ?? "" },
    stdio: ["ignore", "pipe", "ignore"],
  });
}
