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
 */
import { readFileSync } from 'node:fs';
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
    expect(d.get('box-shadow'), '聚焦环是这条修复的全部内容').toMatch(/inset\s+0\s+0\s+0\s+1px\s+var\(--c-accent-ring\)/);
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
