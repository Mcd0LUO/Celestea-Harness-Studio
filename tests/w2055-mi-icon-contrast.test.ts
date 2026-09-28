// @vitest-environment jsdom
/**
 * W2055 · `--mi-*` 模型图标色的**数值门禁**（WCAG 1.4.11 非文本对比度 >= 3:1）。
 *
 * ── 为什么需要这个文件（缺口核实）────────────────────────────────────────────
 * 4b0aa06（2026-09-26）修过一个真实缺陷：`--mi-*` 用 `prefers-color-scheme` 而不是
 * `data-theme` 选色，于是「系统深色 + mono 主题」（底仍是 #ffffff）拿到**亮色图标**，
 * 真机实测 12/12 家族低于 3:1，最差 cohere 1.71:1。该提交把 `--mi-*` 拆成三套
 * （亮 / `[data-theme="dark"]` / claude 暗）。
 *
 * ★ 但它的门禁（tests/w9203-style-i18n-fixes.test.ts 的 describe ④）只钉**结构**：
 *     ① 每个 `--mi-<k>` 出现 3 次；② 暗色表挂在 `[data-theme="dark"]` 块里；
 *     ③ claude 暗色表在 `@media (prefers-color-scheme: dark)` 内。
 *   三条全是「有没有声明」「挂在哪」—— **没有一处计算对比度**。
 *   ⇒ 有人把某个 `--mi-*` 值「顺手调浅」，这三条**一条都不会红**。
 *   本文件补的正是这个数值面：把「值」本身钉在 >= 3:1 上。
 *
 * ── 判据来源（真机实测，不是 token 推导）────────────────────────────────────
 * 用 scripts/perf/lib 的 CDP harness 起 headless Chrome，走**真实交互路径**点开
 * `#slModel` 弹层，读 `getComputedStyle` 的**实际背景色**（四套配色各一遍），
 * 并用截图像素读回校验 hover 态的 rgba 合成。实测（2026-09-27，W2055）：
 *
 *   | 配色        | data-theme | 系统偏好 | 图标所在底色（弹层 / 状态栏） |
 *   |-------------|-----------|---------|------------------------------|
 *   | mono 浅     | mono      | light   | #ffffff                      |
 *   | mono 深     | dark      | light   | #1c1c1c                      |
 *   | claude 浅   | claude    | light   | #ffffff                      |
 *   | claude 深   | claude    | dark    | #262521                      |
 *
 *   · 状态栏本体（`#statusline`，`--composer-bg`）与弹层（`.sl-popup`，
 *     `--c-surface-raised`）在四套配色下**实测同值**（`getComputedStyle` 逐套相同），
 *     且 `.sl-micon` 在**两处都出现**（ring.ts 的 renderModelCell / picker-list.ts 的
 *     optButton），故两处共用同一组数值断言，不需要分叉。
 *   · ★ 但「同值」是**当前事实**、不是不变量：claude 深是 #262521 而 mono 深是
 *     #1c1c1c，说明两者由不同 token 链决定。因此本门禁**分别解析**两条链
 *     （`--composer-bg` 与 `--c-surface-raised`）并各自断言 —— 哪天有人只改一条，
 *     数值门禁仍守得住；把它们合并成一个写死的 #ffffff 就会漏掉那一半。
 *
 * ── 三条判据（全部**从 CSS 解析**、不抄期望值）───────────────────────────────
 *   ① 12 个家族 × 四套配色 × 两个真实底色，**每一个都 >= 3:1**；
 *   ② 失败信息**自报「哪个 token、哪个配色、实测多少」**（门禁要说出自己是谁）；
 *   ③ hover 态也要达标 —— 行的 hover 底是 `--c-accent-soft` 的 rgba 叠在弹层底上，
 *      实测合成后 mono 浅 gemini 从 3.453 掉到 **3.057**（仍过，但余量只剩 2%），
 *      故 hover 必须进判据，否则「常态过、悬停不过」这条缝无人守。
 *
 * ── 与 W2006 同一标准 ───────────────────────────────────────────────────────
 * WCAG 1.4.11 非文本对比度 >= 3:1，与焦点环（tests/w9226 的 W2006 分区）同一口径、
 * 同一算法（WCAG 2.1 相对亮度）。本文件自带一份纯函数实现（与 w9226 逐字同源），
 * 因为 w9226 的那两个函数没有 export，跨文件 import 需要动它的文件头 ——
 * 铁律：不许删改既有断言，也不为复用去改别人的门禁文件。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = join(HERE, '..', 'apps', 'web', 'src', 'styles');

/* ------------- CSS 解析（与 w9226 同一口径：剥注释 / 取块 / 解析声明 / 跟随 var() 链） ------------- */
const cssText = (f: string): string => readFileSync(join(STYLES, f), 'utf8');
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');

/** 取某选择器块的正文（大括号配对；':root,' 会命中 ':root, [data-theme="mono"]'）。 */
function block(css: string, selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) throw new Error('selector not found: ' + selector);
  const start = css.indexOf('{', i);
  let depth = 0;
  for (let j = start; j < css.length; j++) {
    if (css[j] === '{') depth++;
    else if (css[j] === '}') {
      depth--;
      if (depth === 0) return css.slice(start + 1, j);
    }
  }
  throw new Error('unbalanced braces for ' + selector);
}
/** 块里的 --x: value; 声明表（后写的覆盖先写的，与块内级联同序）。 */
function vars(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1] as string] = (m[2] as string).trim();
  return out;
}
/** token -> 最终值：跟随 var() 别名链（--c-surface-raised -> --bg-surface-raised -> --s-white）。 */
function resolve(table: Record<string, string>, name: string, depth = 0): string {
  if (depth > 10) throw new Error('var() chain too deep at ' + name);
  const raw = table[name];
  if (raw === undefined) throw new Error('token not defined: ' + name);
  const m = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(raw.trim());
  return m === null ? raw.trim() : resolve(table, m[1] as string, depth + 1);
}

/* ------------- WCAG 2.1 相对亮度 / 对比度（与 w9226 的 F6 分区逐字同源） ------------- */
function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error('not a 6-digit hex: ' + hex);
  const n = parseInt(m[1] as string, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
/** 解析颜色 -> [r,g,b,a]；支持 #rgb / #rrggbb / #rrggbbaa / rgb() / rgba()。 */
function parseColor(v: string): [number, number, number, number] {
  const s = v.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (hex) {
    let h = hex[1] as string;
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) throw new Error('bad hex: ' + v);
    const n = parseInt(h.slice(0, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (fn) {
    const p = (fn[1] as string).split(/[,\/]/).map((x) => x.trim()).filter((x) => x !== '');
    if (p.length < 3) throw new Error('bad rgb(): ' + v);
    return [Number(p[0]), Number(p[1]), Number(p[2]), p.length > 3 ? Number(p[3]) : 1];
  }
  throw new Error('unsupported color syntax: ' + v);
}
/** 半透明前景按 alpha 合成到不透明背景上（1.4.11 判的是屏幕上的真实像素）。 */
function composite(fg: string, bg: string): string {
  const [r, g, b, a] = parseColor(fg);
  const [br, bgc, bb] = parseColor(bg);
  const mix = (c: number, d: number): number => Math.round(c * a + d * (1 - a));
  return '#' + [mix(r, br), mix(g, bgc), mix(b, bb)].map((c) => c.toString(16).padStart(2, '0')).join('');
}

/* ------------- 四套配色的 token 表（与 w9226 / w2040 / theme-claude.test.ts 同一口径） ------------- */
const TOKENS = stripComments(cssText('tokens.css'));
const CLAUDE = stripComments(cssText('theme-claude.css'));
const MONO = { ...vars(block(TOKENS, ':root {')), ...vars(block(TOKENS, ':root,')) };
const MONO_DARK = { ...MONO, ...vars(block(TOKENS, '[data-theme="dark"]')) };
const CLAUDE_MEDIA = CLAUDE.indexOf('@media (prefers-color-scheme: dark)');
const CLAUDE_LIGHT = { ...MONO, ...vars(block(CLAUDE.slice(0, CLAUDE_MEDIA), '[data-theme="claude"]')) };
const CLAUDE_DARK = { ...MONO, ...vars(block(CLAUDE.slice(CLAUDE_MEDIA), '[data-theme="claude"]')) };

/** 图标上色的 CSS 表（statusline.css）：亮色 / dark / claude 暗三块。 */
const SL = stripComments(cssText('statusline.css'));
/** 取块；不存在返回 null（**不抛错** —— 见下面 OLD_DEFECT 的说明）。 */
function blockOrNull(css: string, selector: string): string | null {
  try {
    return block(css, selector);
  } catch {
    return null;
  }
}
const SL_ROOT_BODY = blockOrNull(SL, ':root {');
const SL_DARK_BODY = blockOrNull(SL, '[data-theme="dark"] {');
const SL_CLAUDE_MEDIA = SL.indexOf('@media (prefers-color-scheme: dark)');
const SL_CLAUDE_BODY = SL_CLAUDE_MEDIA < 0 ? null : blockOrNull(SL.slice(SL_CLAUDE_MEDIA), '[data-theme="claude"] {');

/** 媒体查询块**本体**（大括号配对；不存在返回 null）。 */
function mediaBody(css: string): string | null {
  const i = css.indexOf('@media (prefers-color-scheme: dark)');
  if (i < 0) return null;
  const open = css.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < css.length; j++) {
    if (css[j] === '{') depth++;
    else if (css[j] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, j);
    }
  }
  return null;
}
const SL_MEDIA_BODY = mediaBody(SL);

const SL_ROOT = vars(SL_ROOT_BODY ?? '');
const SL_DARK = vars(SL_DARK_BODY ?? '');
const SL_CLAUDE_DARK = vars(SL_CLAUDE_BODY ?? '');

/**
 * ★ 旧缺陷面（4b0aa06 修的那个）：`--mi-*` 曾整表挂在
 * `@media (prefers-color-scheme: dark) { :root { … } }` 上。
 * 于是「**mono 主题** + 系统深色」——底仍是 #ffffff（mono 的 color-scheme 钉 light）
 * ——拿到**暗色图标**，12/12 家族低于 3:1（实测最差 grok #3f3f46 → 1.63 反向错配）。
 *
 * 这里把这一面**显式建模**成一个配色来算，而不是只留一条结构断言：
 * 媒体查询块里若出现 `:root` 的 `--mi-*`，它们就会在系统深色下生效。
 * 修复后该表为空 ⇒ 本行等于亮色表 ⇒ 天然达标；一旦有人把暗色表搬回媒体查询的
 * `:root`，这一行立刻算出暗色图标画在白底上的真实比值（**自报 token + 配色 + 数值**），
 * 而不是让解析器抛一个「selector not found」把整个文件打挂（实测踩到过：
 * 那种失败形态说不出是哪个 token 出了问题，等于门禁失效）。
 */
const SL_MEDIA_ROOT = SL_MEDIA_BODY === null ? {} : vars(blockOrNull(SL_MEDIA_BODY, ':root') ?? '');

/**
 * 五套「配色 × 图标表」= 基础 token 表 + 该套应生效的 `--mi-*` 覆盖。
 * ★ 取值口径与 w9203 的结构门禁**一致**（那是本修复的原门禁，不另立一套）：
 *   mono 浅 = :root；mono 深 = :root + [data-theme="dark"]；
 *   claude 浅 = :root；claude 深 = :root + 媒体查询内的 [data-theme="claude"]；
 *   mono + 系统深色 = :root + 媒体查询里 :root 的覆盖（旧缺陷面，见上）。
 */
const THEMES: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ['mono 浅', { ...MONO, ...SL_ROOT }],
  ['mono 深', { ...MONO_DARK, ...SL_ROOT, ...SL_DARK }],
  ['claude 浅', { ...CLAUDE_LIGHT, ...SL_ROOT }],
  ['claude 深', { ...CLAUDE_DARK, ...SL_ROOT, ...SL_CLAUDE_DARK }],
  ['mono + 系统深色（旧缺陷面）', { ...MONO, ...SL_ROOT, ...SL_MEDIA_ROOT }],
];

/**
 * 家族清单**从 CSS 解析**出来，不在测试里抄一遍。
 * 为什么：抄一份 12 项的清单，等于「新增第 13 个家族时门禁不知道」——
 * 那正是这类门禁最常见的失效形态（清单过期 ⇒ 覆盖悄悄变小）。
 */
function families(): string[] {
  const out: string[] = [];
  for (const k of Object.keys(SL_ROOT)) {
    const m = /^--mi-([a-z0-9-]+)$/.exec(k);
    if (m !== null) out.push(m[1] as string);
  }
  return out.sort();
}
const FAMILIES = families();

/** 两个真实底色（★ 分别解析，见文件头：状态栏与弹层当前同值但不是同一条链）。 */
const SURFACES = ['--composer-bg', '--c-surface-raised'] as const;
/** hover 态：行底 = --c-accent-soft 叠在弹层底上（statusline.css 的 .sl-opt:hover）。 */
const HOVER_SOFT = '--c-accent-soft';

/** 判据下限：WCAG 1.4.11 非文本对比度（与 W2006 焦点环同一标准）。 */
const MIN = 3;

/** 失败信息格式：**哪个 token、哪个配色、哪个底色、实测多少**。 */
const why = (family: string, theme: string, surface: string, bg: string, r: number): string =>
  '--mi-' + family + ' 在「' + theme + '」的 ' + surface + ' ' + bg + ' 上只有 ' + r.toFixed(3) +
  ':1（判据 >= ' + MIN + ':1，WCAG 1.4.11 非文本对比度）';

describe('W2055 · --mi-* 模型图标色非文本对比度（四套配色 >= 3:1）', () => {
  it('对比度算法自检：黑白 21:1、同色 1:1、合成按 alpha 算（防公式被改坏）', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#123456', '#123456')).toBeCloseTo(1, 10);
    expect(composite('rgba(0, 0, 0, 0.055)', '#ffffff'), 'mono 浅的 hover 合成底').toBe('#f1f1f1');
    expect(composite('rgba(255, 255, 255, 0.08)', '#1c1c1c'), 'mono 深的 hover 合成底').toBe('#2e2e2e');
    expect(composite('rgba(168, 80, 42, 0.09)', '#ffffff'), 'claude 浅的 hover 合成底').toBe('#f7efec');
    expect(composite('#000000', '#ffffff'), '不透明色合成是恒等（不得被改动）').toBe('#000000');
  });

  it('解析器自检：12 个家族、四套配色、两个底色都解析得出来（防空集假绿）', () => {
    // 没有这条，任何解析失败都会让下面的循环「零次迭代 ⇒ 全绿」。
    expect(FAMILIES, '家族清单必须从 CSS 解析出来').toHaveLength(12);
    expect(FAMILIES).toContain('gemini');
    expect(FAMILIES).toContain('glm');
    for (const [name, table] of THEMES) {
      for (const f of FAMILIES) {
        expect(() => resolve(table, '--mi-' + f), name + ' --mi-' + f + ' 解析不出值').not.toThrow();
      }
      for (const s of SURFACES) {
        expect(() => resolve(table, s), name + ' ' + s + ' 解析不出值').not.toThrow();
      }
      expect(() => resolve(table, HOVER_SOFT), name + ' ' + HOVER_SOFT).not.toThrow();
    }
  });

  it('每一套配色都必须**自己**给出一套图标色（不得靠继承别套的暗色表）', () => {
    // 为什么单列这条：mono 深若删掉 [data-theme="dark"] 块里的 --mi-*，
    // 会经 :root 继承到**亮色**值 —— 在 #1c1c1c 上多数亮色家族仍 >= 3:1
    // （实测最低 gemini 3.45），只有 grok（近黑 #3f3f46）会掉到 1.68。
    // 「必须自己定义」这条能在**任何**家族被删时立刻红，不必等某个具体家族踩线。
    for (const [name, table] of THEMES) {
      for (const f of FAMILIES) {
        expect(table['--mi-' + f], name + ' 没有自己定义 --mi-' + f).toBeDefined();
      }
    }
    // 反向：亮色表与两套暗色表的值必须**不同**（否则「拆三套」名存实亡）。
    for (const f of FAMILIES) {
      expect(SL_DARK['--mi-' + f], '--mi-' + f + ' 的暗色值与亮色值不得相同').not.toBe(SL_ROOT['--mi-' + f]);
    }
  });

  it('四套配色 × 12 家族 × 两个真实底色（状态栏 / 弹层）都 >= 3:1', () => {
    const bad: string[] = [];
    for (const [name, table] of THEMES) {
      for (const surface of SURFACES) {
        const bg = resolve(table, surface);
        for (const f of FAMILIES) {
          const fg = resolve(table, '--mi-' + f);
          const r = contrast(fg, bg);
          if (r < MIN) bad.push(why(f, name, surface, bg, r));
        }
      }
    }
    // ★ 失败信息自报身份：每条都带 token / 配色 / 底色 / 实测值。
    expect(bad, '图标对真实底色的对比度不足（每条自带 token + 配色 + 实测值）').toEqual([]);
  });

  it('hover 态（--c-accent-soft 叠在弹层底上）也 >= 3:1', () => {
    // 真机实测：mono 浅的 hover 底是 #f1f1f1，gemini 从 3.453 掉到 **3.057**
    // —— 余量只剩 2%，再浅一点点就会「常态过、悬停不过」。
    const bad: string[] = [];
    for (const [name, table] of THEMES) {
      const base = resolve(table, '--c-surface-raised');
      const hoverBg = composite(resolve(table, HOVER_SOFT), base);
      for (const f of FAMILIES) {
        const fg = resolve(table, '--mi-' + f);
        const r = contrast(fg, hoverBg);
        if (r < MIN) bad.push(why(f, name, HOVER_SOFT + ' 叠 --c-surface-raised', hoverBg, r));
      }
    }
    expect(bad, '悬停态图标对合成底色的对比度不足').toEqual([]);
  });

  it('每个 --mi-* 都真的被某个 .sl-micon-<家族> 规则引用（不得有死 token）', () => {
    // 门禁的另一半：token 达标但没人用 = 覆盖是假的。反向也钉住「新增家族忘了加规则」。
    const used = new Set<string>();
    for (const m of SL.matchAll(/\.sl-micon-([a-z0-9-]+)\s*\{[^}]*var\(\s*(--mi-[a-z0-9-]+)\s*\)/g)) {
      used.add(m[2] as string);
      expect(m[2], '类名 .sl-micon-' + m[1] + ' 应引用 --mi-' + m[1]).toBe('--mi-' + m[1]);
    }
    for (const f of FAMILIES) expect(used.has('--mi-' + f), '--mi-' + f + ' 没有被任何 .sl-micon-* 规则引用').toBe(true);
  });

  it('★ 旧缺陷面（mono 主题 + 系统深色）必须拿亮色表：底仍是 #ffffff', () => {
    // 4b0aa06 修的那个缺陷：--mi-* 曾整表挂在媒体查询的 :root 上，于是
    // 「mono 主题 + 系统深色」（底仍是 #ffffff）拿到**暗色图标**。
    // 数值面由上面 THEMES 里的「mono + 系统深色（旧缺陷面）」一行覆盖：
    // 修复后该行 = 亮色表 ⇒ 天然达标；一旦有人把暗色表搬回去，那一行立刻
    // 算出暗色图标画在白底上的真实比值并**自报 token**。
    // 这里再钉住**结构**前提（两者互补：结构说「挂在哪」，数值说「够不够」）。
    expect(SL_MEDIA_BODY, '媒体查询块必须存在（claude 深色靠它）').not.toBeNull();
    const innerSelectors = [...(SL_MEDIA_BODY as string).matchAll(/([^{}]+)\{/g)].map((m) => (m[1] as string).trim());
    expect(innerSelectors, '媒体查询块里只能挂 [data-theme="claude"]').toEqual(['[data-theme="claude"]']);
    expect(SL_MEDIA_BODY as string, '媒体查询块内不得出现 :root 选择器').not.toMatch(/^\s*:root\s*\{/m);
    // 反向：mono 主题的亮色表必须仍挂在裸 :root（不是被挪进了媒体查询）。
    expect(SL_ROOT_BODY, '亮色 --mi-* 表必须挂在裸 :root').not.toBeNull();
    for (const f of FAMILIES) {
      expect(SL_ROOT['--mi-' + f], '裸 :root 应含 --mi-' + f).toBeDefined();
      expect(SL_MEDIA_ROOT['--mi-' + f], '媒体查询的 :root 不得含 --mi-' + f).toBeUndefined();
    }
  });
});
