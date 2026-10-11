// @vitest-environment jsdom
/**
 * W9226 · 样式可访问性 P1 修复回归（F5 未知 key 的 undefined 字面量 / F6 三级文字对比度 /
 * F7 #input 键盘聚焦零指示 / F8 .sl-grant-badge 深色主题白字）。
 *
 * 为什么每条都要机械断言：
 *   · F5 —— 旧断言只判「非空」，而 setAttribute(name, undefined) 走 WebIDL 的
 *     ToString 写出的**字面量 'undefined' 是非空的** ⇒ 全套门禁全绿，用户悬停看到
 *     undefined。判据必须显式点名那个字面量，否则同类漏网会复发。
 *   · F6 / F8 —— 对比度是可闭式计算的量（WCAG 2.1 相对亮度）。值一旦被顺手调浅就
 *     立刻红，而不是等用户抱怨「字看不清」。
 *   · F7 —— 级联结果「聚焦时零可见变化」在 jsdom 里**不能**用 getComputedStyle 证明
 *     （实测 jsdom 30 的 getComputedStyle 不应用任何带伪类的规则，见下方 F7 分区说明），
 *     故这里用「真 DOM 状态下 :focus-within 确实匹配」+「声明真的存在且没有被同/更高
 *     特异性规则覆盖」两条机械链；真机 Blink 的计算值证据在报告里（headless Chrome）。
 *
 * 取值一律从 CSS **解析**出来算，不把期望值抄一遍（抄一遍就变成自证）——
 * 与 apps/web/src/theme-claude.test.ts 同一口径。
 *
 * W2006 增补：焦点环的非文本对比度（WCAG 2.4.11 / 1.4.11，>= 3:1）。同一纪律：
 *   ① 焦点环的**取值与「谁指向它」都从 styles/*.css 解析出来**，不写死期望值；
 *   ② rgba() 必须按 alpha **合成**到底色上再算 —— 1.4.11 判的是屏幕上的真实像素；
 *   ③ 断言必须覆盖**全部四套配色**（mono 浅/深、claude 浅/深），且每套都必须
 *      **自己**定义焦点环 —— claude 浅色若漏定义会继承到 mono 的黑环，
 *      在那个米白底上恰好也能过 3:1，只有「每套都得自己定义」这条能抓到。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { at, doc, resetHarness, type ElLike } from './lib/w795-dom.js';

interface I18nMod { setLocale(l: string): void; t(k: string): string }
interface DomMod { applyI18n(root: unknown): void }

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = join(HERE, '..', 'apps', 'web', 'src', 'styles');
const loadI18n = async (): Promise<I18nMod> => (await import(/* @vite-ignore */ at('i18n/index.ts'))) as I18nMod;
const loadDom = async (): Promise<DomMod> => (await import(/* @vite-ignore */ at('i18n/dom.ts'))) as DomMod;

/* ---------------- CSS 解析（剥注释 / 取块 / 解析声明 / 跟随 var() 链） ---------------- */
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
/** 取某选择器的声明表（后写的覆盖先写的）；无规则 ⇒ 空表。 */
function decls(text: string, selector: string): Map<string, string> {
  const want = selector.trim().replace(/\s+/g, ' ');
  const out = new Map<string, string>();
  for (const m of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if ((m[1] ?? '').trim().replace(/\s+/g, ' ') !== want) continue;
    for (const d of (m[2] ?? '').split(';')) {
      const i = d.indexOf(':');
      if (i > 0) out.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
  }
  return out;
}
/** token -> 最终值：跟随 var() 别名链（--c-text-3 -> --label-tertiary -> --s-gray-500）。 */
function resolve(table: Record<string, string>, name: string, depth = 0): string {
  if (depth > 10) throw new Error('var() chain too deep at ' + name);
  const raw = table[name];
  if (raw === undefined) throw new Error('token not defined: ' + name);
  const m = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(raw.trim());
  return m === null ? raw.trim() : resolve(table, m[1] as string, depth + 1);
}

/* ---------------- WCAG 2.1 相对亮度 / 对比度 ---------------- */
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

/* ---------------- 四套配色的 token 表（mono 浅/深 × claude 浅/深） ---------------- */
const TOKENS = stripComments(cssText('tokens.css'));
const CLAUDE = stripComments(cssText('theme-claude.css'));
/** mono 的浅色表：static 调色板 + ':root, [data-theme="mono"]' 的 alias。 */
const MONO = { ...vars(block(TOKENS, ':root {')), ...vars(block(TOKENS, ':root,')) };
const MONO_DARK = { ...MONO, ...vars(block(TOKENS, '[data-theme="dark"]')) };
const CLAUDE_MEDIA = CLAUDE.indexOf('@media (prefers-color-scheme: dark)');
const CLAUDE_LIGHT = { ...MONO, ...vars(block(CLAUDE.slice(0, CLAUDE_MEDIA), '[data-theme="claude"]')) };
const CLAUDE_DARK = { ...MONO, ...vars(block(CLAUDE.slice(CLAUDE_MEDIA), '[data-theme="claude"]')) };

const THEMES: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ['mono 浅', MONO],
  ['mono 深', MONO_DARK],
  ['claude 浅', CLAUDE_LIGHT],
  ['claude 深', CLAUDE_DARK],
];

/** 三级文字要读的那几个面：页面底 / 卡片 / 次级面 / 代码底（与审计 F6 同一组）。 */
const TERTIARY_SURFACES = ['--bg-base', '--bg-layer-1', '--bg-layer-3', '--bg-code'] as const;

describe('W9226 · F6 三级文字在四套配色下都 >= 4.5:1', () => {
  it('每一套配色的 --label-tertiary 对自己的四个面都达标', () => {
    for (const [name, table] of THEMES) {
      const fg = resolve(table, '--label-tertiary');
      for (const bg of TERTIARY_SURFACES) {
        const r = contrast(fg, resolve(table, bg));
        expect(r, name + ' ' + fg + ' on ' + bg + ' = ' + r.toFixed(2) + ':1').toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('mono 浅的 --s-gray-500 与 --c-text-3 同值（token 链不得分叉）', () => {
    // 旧缺陷正是这两个值都是 #999。它们必须一起改，否则「只改 alias 不改 static」
    // 会留下一个仍然不达标的入口。
    // --s-gray-500 在第一个 `:root {`（static 色板）。--c-text-3 在本块里出现两次：
    // 先是字面量 #6a6a6a，后段又被 alias 段重指为 var(--label-tertiary)（同文件后写者胜）。
    // 两个入口都必须指向达标值 —— 用 vars() 会只看到后一条，故字面量用原文匹配，
    // 别名链用 resolve() 走完整条（--c-text-3 -> --label-tertiary -> --s-gray-500）。
    expect(vars(block(TOKENS, ':root {'))['--s-gray-500']).toBe('#6a6a6a');
    expect(block(TOKENS, ':root,')).toContain('--c-text-3: #6a6a6a');
    expect(resolve(MONO, '--c-text-3'), '别名链的终点也必须是达标值').toBe('#6a6a6a');
    expect(MONO['--s-gray-500']).not.toBe('#999999');
  });

  it('三级仍严格淡于二级、二级淡于一级（层级没被对比度修复压平）', () => {
    // 判据必须是「对底色的对比度」，不能是亮度：深色主题里最亮的才是主文字，
    // 按亮度比方向会判反（实测踩到）。对比度是层级语义的正确度量。
    for (const [name, table] of THEMES) {
      const bg = resolve(table, '--bg-base');
      const t1 = contrast(resolve(table, '--label-primary'), bg);
      const t2 = contrast(resolve(table, '--label-secondary'), bg);
      const t3 = contrast(resolve(table, '--label-tertiary'), bg);
      expect(t1, name + ' 主文字应强于二级').toBeGreaterThan(t2);
      expect(t2, name + ' 二级应强于三级').toBeGreaterThan(t3);
    }
  });

  it('对比度算法自检：黑白 21:1、同色 1:1（防公式被改坏）', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#123456', '#123456')).toBeCloseTo(1, 10);
  });
});

describe('W9226 · F8 盾牌计数徽标：字色跟主题、字号可读', () => {
  const badge = (): Map<string, string> => decls(stripComments(cssText('grants.css')), '.sl-grant-badge');

  it('字色是 var(--c-accent-fg)，不是写死的 #fff（本文件头注释明令禁止写死颜色）', () => {
    const color = badge().get('color');
    expect(color, '.sl-grant-badge 不得再写死颜色').toBe('var(--c-accent-fg)');
    expect(color).not.toMatch(/#fff/i);
  });

  it('四套配色下 徽标字 / 授予底 都 >= 4.5:1', () => {
    for (const [name, table] of THEMES) {
      const fg = resolve(table, '--c-accent-fg');
      const bg = resolve(table, '--c-grant');
      const r = contrast(fg, bg);
      expect(r, name + ' ' + fg + ' on ' + bg + ' = ' + r.toFixed(2) + ':1').toBeGreaterThanOrEqual(4.5);
    }
  });

  it('字号提到可读下限（>= 10px），几何同步（height 与 line-height 相等）', () => {
    const d = badge();
    const size = Number((/([0-9.]+)px/.exec(d.get('font-size') ?? '') ?? [])[1]);
    expect(size, 'font-size 不得低于 10px（审计 F8 同条点名 8.5px 不可读）').toBeGreaterThanOrEqual(10);
    expect(d.get('height'), 'height 与 line-height 必须相等（单行垂直居中）').toBe(d.get('line-height'));
  });
});

describe('W9226 · F7 composer 聚焦可见指示', () => {
  const layout = (): string => stripComments(cssText('layout.css'));
  const baseCss = (): string => stripComments(cssText('base.css'));

  it('layout.css 声明了 #inputbar:focus-within 的 box-shadow 环', () => {
    const d = decls(layout(), '#inputbar:focus-within');
    // W2006：token 由 --c-accent-ring（一个 token 三用：9 处焦点环 + 32 处 border +
    // 15 处 box-shadow + 1 处 ::selection）换成**焦点环专用**的 --c-focus-ring。
    // 环本身（inset 0 0 0 1px）一字未动，换的只是它引用的 token。
    expect(d.get('box-shadow'), '聚焦环是这条修复的全部内容').toMatch(/inset\s+0\s+0\s+0\s+1px\s+var\(--c-focus-ring\)/);
  });

  it('没有别的规则声明 #inputbar 本体的 box-shadow（同/更高特异性不得重置聚焦环）', () => {
    // W1297 的既有断言要求 '#inputbar' 本体的 box-shadow 必须是 undefined，
    // 故本修复必须只写在 :focus-within 上；这里再跨文件兜一道，防后来人加回来。
    expect(decls(layout(), '#inputbar').get('box-shadow')).toBeUndefined();
    const offenders: string[] = [];
    for (const f of ['layout.css', 'base.css', 'views.css', 'caret.css', 'responsive.css', 'attachments.css']) {
      const text = stripComments(cssText(f));
      for (const m of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const sel = (m[1] ?? '').trim().replace(/\s+/g, ' ');
        if (sel !== '#inputbar') continue;
        if (/box-shadow\s*:/.test(m[2] ?? '')) offenders.push(f + ' :: ' + sel);
      }
    }
    expect(offenders, '#inputbar 本体的 box-shadow 必须无人声明（聚焦环才不会被重置）').toEqual([]);
  });

  it('扁平化不变量仍在：#input 恒无描边、恒无底色（F7 不得靠给输入框加框来修）', () => {
    const d = decls(layout(), '#input');
    expect(d.get('border'), 'W1297/W1466：输入框恒无描边').toBe('none');
    expect(d.get('background'), 'W1297/W1466：输入框恒无底色').toBe('transparent');
    // base.css 的全局 outline:none 仍然在 —— 修复是「补一个替代指示」，不是把它删掉
    // （删掉会让所有表单控件在 Chrome/Safari 拿到 UA 默认 outline，与本仓扁平口径冲突）。
    expect(decls(baseCss(), 'input, textarea, select').get('outline')).toBe('none');
  });

  it('真 DOM 状态下 :focus-within 确实匹配（jsdom 的 getComputedStyle 不应用伪类规则，故用 matches）', () => {
    resetHarness();
    const host = doc.createElement('div') as unknown as ElLike;
    host.innerHTML = '<div id="inputbar"><textarea id="input"></textarea></div>';
    doc.body.appendChild(host);
    const bar = host.querySelector('#inputbar') as unknown as { matches(s: string): boolean };
    const input = host.querySelector('#input') as unknown as { focus(): void; matches(s: string): boolean };
    expect(input.matches(':focus')).toBe(false);
    input.focus();
    expect(input.matches(':focus')).toBe(true);
    expect(bar.matches('#inputbar:focus-within'), '聚焦输入框时输入条必须匹配 :focus-within').toBe(true);
    // 这条把 base.css 的全局 `outline: none` 钉进**本**用例的判别力：修复的语义是
    // 「补一个替代指示」，不是「删掉那条声明」。删掉它会让 Chrome/Safari 给所有表单
    // 控件加回 UA 默认 outline，与本仓扁平口径冲突 —— 而上面那条独立断言若不单独跑，
    // 变异可能从这条缝里漏过去（W9226 变异 M9 实测：只改这一条时上面的用例抓不到）。
    expect(decls(baseCss(), 'input, textarea, select').get('outline'), 'F7 是补指示，不是删 outline:none').toBe('none');
    host.remove();
  });
});

describe('W9226 · F5 未知 i18n key 不得写出 undefined 字面量', () => {
  it('t() 在两语字典都没有该 key 时返回 key 本身（不是 undefined）', async () => {
    resetHarness();
    const i18n = await loadI18n();
    for (const locale of ['zh', 'en']) {
      i18n.setLocale(locale);
      const v = i18n.t('shell.topbar.versionTitle.TYPO');
      expect(typeof v, locale + '：t() 的返回类型必须是 string').toBe('string');
      expect(v, locale + '：必须回落 key 本身（让拼错在界面上自曝）').toBe('shell.topbar.versionTitle.TYPO');
    }
  });

  it('applyI18n 遇到不存在的 key 时不写属性（更不写字面量 undefined）', async () => {
    resetHarness();
    const dom = await loadDom();
    const host = doc.createElement('div') as unknown as ElLike;
    host.innerHTML =
      '<span id="a" data-i18n-title="nope.title.TYPO">x</span>' +
      '<span id="b" data-i18n-aria-label="nope.aria.TYPO"></span>' +
      '<input id="c" data-i18n-placeholder="nope.ph.TYPO">';
    doc.body.appendChild(host);
    // 注意：这里的 console.warn **抓不到** —— 生产模块经 pathToFileURL 由 Node 的 ESM
    // 加载器加载，跑在另一个 realm，用的是 Node 的真实 console，不是本测试上下文的那个
    // （实测：vi.spyOn(console,'warn') 计数为 0，而同文件里直接 console.warn 计数为 1）。
    // 因此这里只断言**可观测行为**（属性有没有被写坏），告警本身不进断言。
    dom.applyI18n(host);
    // 这条断言就是审计里缺的那一条：判「不等于字面量 undefined」，而不只是判非空。
    expect(host.querySelector('#a')?.getAttribute('title'), 'title 不得是字面量 undefined').not.toBe('undefined');
    expect(host.querySelector('#a')?.getAttribute('title')).toBeNull();
    expect(host.querySelector('#b')?.getAttribute('aria-label')).not.toBe('undefined');
    expect(host.querySelector('#b')?.getAttribute('aria-label')).toBeNull();
    expect(host.querySelector('#c')?.getAttribute('placeholder')).not.toBe('undefined');
    expect(host.querySelector('#c')?.getAttribute('placeholder')).toBeNull();
    host.remove();
  });

  it('正例：真实 key 照常写入（守卫不得把好文案一起拦掉）', async () => {
    resetHarness();
    const i18n = await loadI18n();
    const dom = await loadDom();
    i18n.setLocale('en');
    const host = doc.createElement('div') as unknown as ElLike;
    host.innerHTML = '<span id="ok" data-i18n-title="shell.topbar.versionTitle">x</span>';
    doc.body.appendChild(host);
    dom.applyI18n(host);
    const got = host.querySelector('#ok')?.getAttribute('title') ?? '';
    expect(got).toBe(i18n.t('shell.topbar.versionTitle'));
    expect(got).not.toBe('');
    expect(got).not.toBe('undefined');
    host.remove();
  });
});


/* ==========================================================================
 * W2006 · 焦点环的非文本对比度（WCAG 2.4.11 / 1.4.11：>= 3:1）
 * --------------------------------------------------------------------------
 * 缺陷：mono 的焦点环是 rgba(0,0,0,0.28) / rgba(255,255,255,0.32)，
 *   合成到 --c-bg 上分别只有 1.986:1 / 2.910:1（架构师实测，本文件复算一致）。
 * 修法（取舍见 results/W2006-focus-ring-a11y.md）：焦点环从
 *   --c-accent-ring（一个 token 三用：9 处焦点环 + 32 处 border + 15 处
 *   box-shadow + 1 处 ::selection）里**分家**出来，改用专用 token；
 *   47 处装饰用法一字不动 —— 把装饰描边一起加深是设计变更，不是修 bug。
 *
 * 本分区守四条不变量，全部**从 CSS 解析**、不抄期望值：
 *   ① 每一套配色都必须**自己**定义焦点环色（漏一套 ⇒ 继承别套的值）；
 *   ② 焦点环对四种真实底色合成后 >= 3:1（rgba 必须按 alpha 合成再算）；
 *   ③ 焦点环声明**不得**再引用装饰 token（否则「分家」名存实亡）；
 *   ④ 装饰外观与 ::selection 一字未动（改它们才是设计变更）。
 * ======================================================================== */
const FOCUS_TOKEN = '--c-focus-ring';
/** 装饰 token：焦点环不得再引用（③）。 */
const DECOR_TOKENS = ['--c-accent-ring', '--interactive-accent-ring'] as const;
/** 焦点环可能落在的四种真实底色（页面底 / 卡片 / 次级面 / 代码底）。 */
const RING_SURFACES = ['--bg-base', '--bg-layer-1', '--bg-layer-3', '--bg-code'] as const;

/**
 * 解析颜色 -> [r,g,b,a]。支持 #rgb / #rrggbb / #rrggbbaa / rgb() / rgba()。
 * 为什么必须解析 alpha：1.4.11 判的是**屏幕上的真实像素**，
 * rgba(0,0,0,0.45) 画在 #fafafa 上是 rgb(143,143,143)，不是黑色。
 */
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

/** 半透明前景按 alpha 合成到不透明背景上（WCAG 1.4.11 的实际呈现色）。 */
function composite(fg: string, bg: string): string {
  const [r, g, b, a] = parseColor(fg);
  const [br, bgc, bb] = parseColor(bg);
  const mix = (c: number, d: number): number => Math.round(c * a + d * (1 - a));
  return '#' + [mix(r, br), mix(g, bgc), mix(b, bb)].map((c) => c.toString(16).padStart(2, '0')).join('');
}

/**
 * 扫 styles/ 下全部 CSS，取出**真实的焦点指示器声明**：
 * 选择器含 :focus，属性是 outline / box-shadow，且值不是 none。
 * 为什么扫全部文件而不是列一张表：列一张表就是抄一遍期望值 —— 表会漏掉
 * 「后来人新加的焦点环」（这正是 .chatcol-resizer:focus-visible::after 的处境：
 * 它是 tabIndex=0 的真实 tab 停靠点，此前的审计清单里就没有它）。
 */
interface FocusRule { file: string; selector: string; value: string; tokens: string[] }
function focusIndicators(): FocusRule[] {
  const out: FocusRule[] = [];
  for (const f of readdirSync(STYLES).filter((n) => n.endsWith('.css')).sort()) {
    const text = stripComments(cssText(f));
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = (m[1] ?? '').trim().replace(/\s+/g, ' ');
      if (!/:focus/.test(selector)) continue;
      for (const d of (m[2] ?? '').split(';')) {
        const i = d.indexOf(':');
        if (i < 0) continue;
        const prop = d.slice(0, i).trim();
        const value = d.slice(i + 1).trim();
        if (prop !== 'outline' && prop !== 'box-shadow') continue;
        if (value === 'none' || value === '') continue;
        const tokens = [...value.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g)].map((x) => x[1] as string);
        out.push({ file: f, selector, value, tokens });
      }
    }
  }
  return out;
}
const FOCUS_RULES = focusIndicators();

/** 每套配色「自己」的那几个块 —— 用来判「本套是否自己定义了焦点环色」。 */
const OWN_BLOCKS: ReadonlyArray<readonly [string, Record<string, string>[], readonly string[]]> = [
  ['mono 浅', [vars(block(TOKENS, ':root {')), vars(block(TOKENS, ':root,'))], [':root {', ':root,']],
  ['mono 深', [vars(block(TOKENS, '[data-theme="dark"]'))], ['[data-theme="dark"]']],
  ['claude 浅', [vars(block(CLAUDE.slice(0, CLAUDE_MEDIA), '[data-theme="claude"]'))], ['claude 浅色块']],
  ['claude 深', [vars(block(CLAUDE.slice(CLAUDE_MEDIA), '[data-theme="claude"]'))], ['claude 深色块']],
];

describe('W2006 · 焦点环非文本对比度（四套配色 × 四种底色 >= 3:1）', () => {
  it('对比度算法自检：合成是真的按 alpha 算（半透明叠底 = 屏幕上的真实像素）', () => {
    expect(composite('rgba(0,0,0,0.5)', '#ffffff'), '黑 50% 叠白 = 中灰').toBe('#808080');
    expect(composite('rgba(0,0,0,0.5)', '#fafafa'), '黑 50% 叠页面底').toBe('#7d7d7d');
    // 本次修复的两个实际取值（报告里的 3.307:1 / 4.514:1 就是这两个合成色算出来的）
    expect(composite('rgba(0,0,0,0.45)', '#fafafa'), '本次修复的 mono 浅焦点环').toBe('#8a8a8a');
    expect(composite('rgba(255,255,255,0.45)', '#131313'), '本次修复的 mono 深焦点环').toBe('#7d7d7d');
    expect(composite('#000000', '#ffffff'), '不透明色叠底不得被改动（alpha=1 时合成是恒等）').toBe('#000000');
    expect(composite('#123456', '#ffffff'), '不透明色叠底不得被改动').toBe('#123456');
    // 已知锚点：架构师实测的旧值 1.986:1 / 2.910:1，本文件必须复算得出同一个数
    expect(contrast(composite('rgba(0, 0, 0, 0.28)', '#fafafa'), '#fafafa')).toBeCloseTo(1.986, 3);
    expect(contrast(composite('rgba(255, 255, 255, 0.32)', '#131313'), '#131313')).toBeCloseTo(2.91, 2);
  });

  it('每一套配色都**自己**定义了焦点环色（漏一套 ⇒ 继承别套的值）', () => {
    // 为什么单列这条：claude 浅色若删掉自己的定义，会经 alias 继承到 mono 的
    // rgba(0,0,0,0.45)，在那个米白底上恰好也能过 3:1 —— 只有「必须自己定义」
    // 这条能抓到「删掉一套配色定义」这个变异。
    for (const [name, blocks, where] of OWN_BLOCKS) {
      const own = blocks.some((b) => b[FOCUS_TOKEN] !== undefined || b['--interactive-focus-ring'] !== undefined);
      expect(own, name + ' 没有在 ' + where.join(' / ') + ' 里定义焦点环色').toBe(true);
    }
  });

  it('焦点环取值与装饰 token 分家（不是把装饰 token 加深了事）', () => {
    expect(resolve(MONO, FOCUS_TOKEN), 'mono 浅的焦点环不得等于装饰环').not.toBe(resolve(MONO, '--c-accent-ring'));
    expect(resolve(MONO_DARK, FOCUS_TOKEN)).not.toBe(resolve(MONO_DARK, '--c-accent-ring'));
    // 装饰环的四个历史取值必须一字未动（动了才是设计变更）
    expect(vars(block(TOKENS, ':root,'))['--interactive-accent-ring']).toBe('rgba(0, 0, 0, 0.28)');
    expect(vars(block(TOKENS, '[data-theme="dark"]'))['--interactive-accent-ring']).toBe('rgba(255, 255, 255, 0.32)');
    expect(vars(block(CLAUDE.slice(0, CLAUDE_MEDIA), '[data-theme="claude"]'))['--interactive-accent-ring']).toBe('#d5734f');
  });

  it('每一套配色下，焦点环对四种底色合成后都 >= 3:1', () => {
    for (const [name, table] of THEMES) {
      const raw = resolve(table, FOCUS_TOKEN);
      for (const bg of RING_SURFACES) {
        const bgv = resolve(table, bg);
        const shown = composite(raw, bgv);
        const r = contrast(shown, bgv);
        expect(r, name + '：焦点环 ' + raw + ' 在 ' + bg + ' ' + bgv + ' 上合成 ' + shown + ' = ' + r.toFixed(3) + ':1')
          .toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('四套配色都必须有焦点环 token（解析得到，不是 undefined 兜底）', () => {
    for (const [name, table] of THEMES) {
      expect(() => resolve(table, FOCUS_TOKEN), name).not.toThrow();
    }
  });

  it('每个真实的焦点指示器都指向焦点环 token（不是 --c-accent-ring）', () => {
    expect(FOCUS_RULES.length, '扫描必须真的扫到焦点指示器（防解析器被改坏后空集假绿）').toBeGreaterThanOrEqual(15);
    const bad: string[] = [];
    for (const rule of FOCUS_RULES) {
      for (const t of rule.tokens) {
        if ((DECOR_TOKENS as readonly string[]).includes(t)) bad.push(rule.file + ' | ' + rule.selector + ' | ' + rule.value);
      }
    }
    expect(bad, '焦点指示器不得再引用装饰 token').toEqual([]);
  });

  it('焦点指示器引用的 token 在四套配色下都定义得出来（没有悬空引用）', () => {
    const bad: string[] = [];
    for (const rule of FOCUS_RULES) {
      for (const t of rule.tokens) {
        for (const [name, table] of THEMES) {
          try { resolve(table, t); } catch { bad.push(name + ' :: ' + t + ' (' + rule.file + ' | ' + rule.selector + ')'); }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('装饰外观一字未动：::selection 仍用 --c-accent-ring（改它才是设计变更）', () => {
    expect(decls(stripComments(cssText('base.css')), '::selection').get('background')).toBe('var(--c-accent-ring)');
    // 装饰引用总数不得因为本次修复而减少（分家不是删除）
    let deco = 0;
    for (const f of readdirSync(STYLES).filter((n) => n.endsWith('.css'))) {
      for (const m of stripComments(cssText(f)).matchAll(/var\(\s*--(?:c-|interactive-)accent-ring\s*\)/g)) { void m; deco++; }
    }
    expect(deco, '装饰用法（border / box-shadow / ::selection）数量不得下降').toBeGreaterThanOrEqual(45);
  });
});
