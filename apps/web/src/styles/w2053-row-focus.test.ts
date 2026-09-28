// @vitest-environment node
// ============================================================================
// W2053 验收（样式面）：5 处行/表行的**焦点环**必须可见，且与既有 token 一致。
//
// 为什么单独一个文件：行为面在 ui/roving.test.ts（jsdom）与 tests/w2053-row-*.test.ts，
// 这里只做 **CSS 解析 + 闭式对比度计算**（纯 node，不需要浏览器）。与 W2040 的
// w2040-wbrow-focus.test.ts 同一条纪律：取值一律从 apps/web/src/styles/*.css
// **解析**出来算，不把期望值抄一遍（抄一遍就变成自证）。
//
// 五条不变量，每条对应一条变异负控制（见报告 §5）：
//   ① 五处都有真实的焦点指示器（去掉 ⇒ 键盘聚焦零可见变化，WCAG 2.4.7 失败）；
//   ② 指示器指向 **--c-focus-ring**（W2006 的专用 token），**不得**引用装饰 token
//      （--c-accent-ring / --interactive-accent-ring）；
//   ③ 该 token 在**四套配色**下对每处的真实底色按 alpha 合成后都 >= 3:1
//      （WCAG 1.4.11 / 2.4.11）；
//   ④ 没有同/更高特异性的规则把焦点环重置掉（outline:none 一类的回退）；
//   ⑤ 指示器是 **outline**（不参与布局 ⇒ 行高在聚焦前后逐像素不变）。
// ============================================================================
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 本文件住在 apps/web/src/styles/ ⇒ 目录就是 HERE（不靠相对层级推导）。 */
const STYLES = HERE;
const cssText = (f: string): string => readFileSync(join(STYLES, f), 'utf8');
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');

/* ---------------- CSS 解析（与 W9226 / W2040 同一套口径） ---------------- */
function block(css: string, selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) throw new Error('selector not found: ' + selector);
  const start = css.indexOf('{', i);
  let depth = 0;
  for (let j = start; j < css.length; j++) {
    if (css[j] === '{') depth += 1;
    else if (css[j] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start + 1, j);
    }
  }
  throw new Error('unbalanced braces for ' + selector);
}
function vars(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1] as string] = (m[2] as string).trim();
  return out;
}
function resolve(table: Record<string, string>, name: string, depth = 0): string {
  if (depth > 10) throw new Error('var() chain too deep at ' + name);
  const raw = table[name];
  if (raw === undefined) throw new Error('token not defined: ' + name);
  const m = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(raw.trim());
  return m === null ? raw.trim() : resolve(table, m[1] as string, depth + 1);
}

/* ---------------- WCAG 2.1 对比度（含 alpha 合成） ---------------- */
function parseColor(v: string): [number, number, number, number] {
  const s = v.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (hex) {
    let h = hex[1] as string;
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (fn) {
    const p = (fn[1] as string).split(/[,\/]/).map((x) => x.trim()).filter((x) => x !== '');
    return [Number(p[0]), Number(p[1]), Number(p[2]), p.length > 3 ? Number(p[3]) : 1];
  }
  throw new Error('unsupported color syntax: ' + v);
}
function composite(fg: string, bg: string): string {
  const [r, g, b, a] = parseColor(fg);
  const [br, bgc, bb] = parseColor(bg);
  const mix = (c: number, d: number): number => Math.round(c * a + d * (1 - a));
  return '#' + [mix(r, br), mix(g, bgc), mix(b, bb)].map((c) => c.toString(16).padStart(2, '0')).join('');
}
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

/* ---------------- 四套配色的 token 表 ---------------- */
const TOKENS = stripComments(cssText('tokens.css'));
const CLAUDE = stripComments(cssText('theme-claude.css'));
const MONO = { ...vars(block(TOKENS, ':root {')), ...vars(block(TOKENS, ':root,')) };
const MONO_DARK = { ...MONO, ...vars(block(TOKENS, '[data-theme="dark"]')) };
const CLAUDE_MEDIA = CLAUDE.indexOf('@media (prefers-color-scheme: dark)');
const CLAUDE_LIGHT = { ...MONO, ...vars(block(CLAUDE.slice(0, CLAUDE_MEDIA), '[data-theme="claude"]')) };
const CLAUDE_DARK = { ...MONO, ...vars(block(CLAUDE.slice(CLAUDE_MEDIA), '[data-theme="claude"]')) };
const THEMES: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ['mono 浅', MONO], ['mono 深', MONO_DARK], ['claude 浅', CLAUDE_LIGHT], ['claude 深', CLAUDE_DARK],
];

const FOCUS_TOKEN = '--c-focus-ring';
const DECOR_TOKENS = ['--c-accent-ring', '--interactive-accent-ring'] as const;

/**
 * 5 处位点：每处的**行选择器**与它所在的样式文件。
 *
 * ★ 底色（--c-surface-raised 等）是这 5 处共同的实际背景：会话树/worker 组/目录弹层
 *   都画在侧栏与弹层的 --c-surface 上，提供商表画在 --c-surface-raised 上。
 *   逐处把真实底色列出来，比「统一拿一个底色算」更严 —— 底色一旦被改浅，环的对比度
 *   会**逐处**重算，而不是靠一个代表值蒙过去。
 */
const SITES: ReadonlyArray<{ name: string; file: string; sel: string; base: string }> = [
  { name: '.sess-leaf（会话树叶子）', file: 'sessions.css', sel: '.sess-leaf', base: '--c-surface' },
  { name: '.ws-worker-row（worker 行）', file: 'sessions.css', sel: '.ws-worker-row', base: '--c-surface' },
  { name: '.ws-worker-parent（分组头）', file: 'views.css', sel: '.ws-worker-parent', base: '--c-surface' },
  { name: '.ws-fs-dir（目录弹层行）', file: 'sessions.css', sel: '.ws-fs-dir', base: '--c-surface' },
  { name: 'tr.prov-row（提供商表行）', file: 'settings.css', sel: '.prov-table tbody tr.prov-row', base: '--c-surface-raised' },
];

interface FocusRule { selector: string; prop: string; value: string; tokens: string[]; offset: string | null }

/**
 * 某文件里「选择器含 sel 且含 :focus」的 outline / box-shadow 声明。
 *
 * ★ offset 单独取：outline-offset 是**独立声明**（与 outline 简写同级），
 *   不并进 value 里 —— 早先把两者拼在一起断言，量到的是「没有 offset」的假红。
 *   行高不变这条不变量正是靠它，所以它必须被单独量到。
 */
function focusRules(file: string, sel: string): FocusRule[] {
  const text = stripComments(cssText(file));
  const out: FocusRule[] = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (m[1] ?? '').trim().replace(/\s+/g, ' ');
    if (!selector.includes(sel) || !/:focus/.test(selector)) continue;
    const decls = new Map<string, string>();
    for (const d of (m[2] ?? '').split(';')) {
      const i = d.indexOf(':');
      if (i > 0) decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
    for (const [prop, value] of decls) {
      if (prop !== 'outline' && prop !== 'box-shadow') continue;
      if (value === 'none' || value === '') continue;
      out.push({
        selector,
        prop,
        value,
        tokens: [...value.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g)].map((x) => x[1] as string),
        offset: decls.get('outline-offset') ?? null,
      });
    }
  }
  return out;
}

describe('W2053 · 5 处行/表行的焦点环可见性（WCAG 2.4.7 / 1.4.11）', () => {
  it('① 每一处都有真实的焦点指示器（去掉 ⇒ 键盘聚焦零可见变化）', () => {
    for (const s of SITES) {
      const rules = focusRules(s.file, s.sel);
      expect(rules.length, s.name + ' 必须声明至少一条 :focus* 的 outline / box-shadow').toBeGreaterThanOrEqual(1);
      expect(rules.some((r) => r.selector.includes(':focus-visible')), s.name + ' 必须走 :focus-visible').toBe(true);
    }
  });

  it('② 指示器指向焦点环专用 token，不得引用装饰 token', () => {
    for (const s of SITES) {
      for (const r of focusRules(s.file, s.sel)) {
        expect(r.tokens, s.name + ' :: ' + r.selector + ' 的焦点环必须引用 token（不是写死颜色）').toContain(FOCUS_TOKEN);
        for (const t of r.tokens) {
          expect(DECOR_TOKENS as readonly string[], s.name + ' 不得引用装饰 token ' + t).not.toContain(t);
        }
      }
    }
  });

  it('②b 对比度算法自检（防公式被改坏）：黑白 21:1、同色 1:1、alpha 合成是恒等', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#123456', '#123456')).toBeCloseTo(1, 10);
    expect(composite('rgba(0,0,0,0.5)', '#ffffff')).toBe('#808080');
    expect(composite('#123456', '#ffffff')).toBe('#123456');
  });

  it('③ 四套配色下，每一处的焦点环对它自己的真实底色都 >= 3:1', () => {
    for (const [name, table] of THEMES) {
      const ring = resolve(table, FOCUS_TOKEN);
      for (const s of SITES) {
        const bg = resolve(table, s.base);
        const shown = composite(ring, bg);
        const ratio = contrast(shown, bg);
        expect(ratio, name + ' · ' + s.name + '：' + ring + ' 在 ' + s.base + ' ' + bg + ' 上合成 ' + shown + ' = ' + ratio.toFixed(3) + ':1')
          .toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('④ 没有规则把任何一处的焦点环重置掉（outline:none 一类的回退）', () => {
    const offenders: string[] = [];
    for (const f of readdirSync(STYLES).filter((n) => n.endsWith('.css')).sort()) {
      const text = stripComments(cssText(f));
      for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = (m[1] ?? '').trim().replace(/\s+/g, ' ');
        if (!/:focus/.test(selector)) continue;
        const hit = SITES.find((s) => selector.includes(s.sel));
        if (hit === undefined) continue;
        for (const d of (m[2] ?? '').split(';')) {
          const i = d.indexOf(':');
          if (i < 0) continue;
          const prop = d.slice(0, i).trim();
          const value = d.slice(i + 1).trim();
          if ((prop === 'outline' || prop === 'box-shadow') && value === 'none') offenders.push(f + ' :: ' + selector);
        }
      }
    }
    expect(offenders, '不得有规则把焦点指示器重置为 none').toEqual([]);
  });

  it('④b 指示器是 outline（不参与布局 ⇒ 行高在聚焦前后逐像素不变），且每处只有一条', () => {
    for (const s of SITES) {
      const outs = focusRules(s.file, s.sel).filter((r) => r.prop === 'outline');
      expect(outs.length, s.name + ' 的 outline 焦点指示器应当只有一条（多一条就是「后来人加回来」的入口）').toBe(1);
      expect(outs[0]?.selector, s.name + ' 必须走 :focus-visible').toContain(':focus-visible');
      expect(outs[0]?.offset, s.name + ' 用负 outline-offset 把环画进行内（行高不变）').toBe('-2px');
    }
  });

  it('④c 五处的焦点环声明**逐字同一份**（同一 token 与同一 offset，无特例）', () => {
    const decls = SITES.map((s) => {
      const r = focusRules(s.file, s.sel).find((x) => x.prop === 'outline');
      return (r?.value ?? '') + ' | outline-offset: ' + String(r?.offset);
    });
    expect(new Set(decls).size, '五处必须是同一份声明：' + JSON.stringify(decls)).toBe(1);
    expect(decls[0]).toBe('2px solid var(--c-focus-ring) | outline-offset: -2px');
  });
});
