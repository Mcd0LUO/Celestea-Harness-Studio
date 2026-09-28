// @vitest-environment node
// ============================================================================
// W2040 验收（样式面）：工作台文件行的**焦点环**必须可见，且与既有 token 一致。
//
// 为什么单独一个文件：行为面在 files-keys.test.ts（jsdom），这里只做**CSS 解析 + 闭式
// 对比度计算**（纯 node，不需要浏览器）。与 W9226 的 F7 分区同一条纪律：取值一律从
// apps/web/src/styles/*.css **解析**出来算，不把期望值抄一遍（抄一遍就变成自证）。
//
// 四条不变量，每条对应一条变异负控制（见报告 §5）：
//   ① `.wb-row` 有真实的焦点指示器（去掉它 ⇒ 键盘聚焦零可见变化，WCAG 2.4.7 失败）；
//   ② 指示器指向 **--c-focus-ring**（W2006 的专用 token），**不得**引用装饰 token
//      （--c-accent-ring / --interactive-accent-ring）；
//   ③ 该 token 在**四套配色**下对本行的两种真实底色（--c-surface-raised 常态 /
//      --c-accent-soft 选中态）按 alpha 合成后都 >= 3:1（WCAG 1.4.11 / 2.4.11）；
//   ④ 没有同/更高特异性的规则把焦点环重置掉（outline:none 一类的回退）。
// ============================================================================
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 本文件就住在 styles/ 里 ⇒ 目录就是 HERE（不是相对层级推导，免得挪文件时静默指错）。 */
const STYLES = HERE;
const cssText = (f: string): string => readFileSync(join(STYLES, f), 'utf8');
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');

/* ---------------- CSS 解析（与 W9226 同一套口径） ---------------- */
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

const WORKBENCH = stripComments(cssText('workbench.css'));
/** 行的两种真实底色：常态（.wb-panel 的 --c-surface-raised）与选中态（--c-accent-soft 叠在它上面）。 */
const ROW_BASES = ['--c-surface-raised'] as const;
const FOCUS_TOKEN = '--c-focus-ring';
const DECOR_TOKENS = ['--c-accent-ring', '--interactive-accent-ring'] as const;

/** `.wb-row` 的焦点指示器声明（本仓口径：只认 :focus-visible 的 outline / box-shadow）。 */
function rowFocusRules(): { selector: string; prop: string; value: string; tokens: string[] }[] {
  const out: { selector: string; prop: string; value: string; tokens: string[] }[] = [];
  for (const m of WORKBENCH.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (m[1] ?? '').trim().replace(/\s+/g, ' ');
    if (!/\.wb-row/.test(selector) || !/:focus/.test(selector)) continue;
    for (const d of (m[2] ?? '').split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      const prop = d.slice(0, i).trim();
      const value = d.slice(i + 1).trim();
      if (prop !== 'outline' && prop !== 'box-shadow') continue;
      if (value === 'none' || value === '') continue;
      out.push({ selector, prop, value, tokens: [...value.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g)].map((x) => x[1] as string) });
    }
  }
  return out;
}

describe('W2040 · .wb-row 焦点环可见性（WCAG 2.4.7 / 1.4.11）', () => {
  it('① .wb-row 有真实的焦点指示器（去掉 ⇒ 键盘聚焦零可见变化）', () => {
    const rules = rowFocusRules();
    expect(rules.length, '.wb-row 必须声明至少一条 :focus* 的 outline / box-shadow').toBeGreaterThanOrEqual(1);
    // 键盘焦点必须走 :focus-visible（鼠标点击不画环 —— 与既有 .btn:focus-visible 同口径）
    expect(rules.some((r) => r.selector.includes(':focus-visible'))).toBe(true);
  });

  it('② 指示器指向焦点环专用 token，不得引用装饰 token', () => {
    for (const r of rowFocusRules()) {
      expect(r.tokens, r.selector + ' 的焦点环必须引用 token（不是写死颜色）').toContain(FOCUS_TOKEN);
      for (const t of r.tokens) {
        expect(DECOR_TOKENS as readonly string[], r.selector + ' 不得引用装饰 token ' + t).not.toContain(t);
      }
    }
  });

  it('②b 对比度算法自检（防公式被改坏）：黑白 21:1、同色 1:1、alpha 合成是恒等', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#123456', '#123456')).toBeCloseTo(1, 10);
    expect(composite('rgba(0,0,0,0.5)', '#ffffff')).toBe('#808080');
    expect(composite('#123456', '#ffffff')).toBe('#123456');
  });

  it('③ 四套配色下，焦点环对行的两种真实底色都 >= 3:1', () => {
    for (const [name, table] of THEMES) {
      const ring = resolve(table, FOCUS_TOKEN);
      for (const base of ROW_BASES) {
        const bgv = resolve(table, base);
        const shown = composite(ring, bgv);
        const ratio = contrast(shown, bgv);
        expect(ratio, name + '：' + ring + ' 在 ' + base + ' ' + bgv + ' 上合成 ' + shown + ' = ' + ratio.toFixed(3) + ':1')
          .toBeGreaterThanOrEqual(3);
      }
      // 选中态：--c-accent-soft 叠在常态底色上（.wb-row.sel 的 background）
      const soft = resolve(table, '--c-accent-soft');
      const raised = resolve(table, ROW_BASES[0]);
      const selBg = composite(soft, raised);
      const ringOnSel = composite(resolve(table, FOCUS_TOKEN), selBg);
      const ratioSel = contrast(ringOnSel, selBg);
      expect(ratioSel, name + '：选中行上的焦点环 ' + ringOnSel + ' vs ' + selBg + ' = ' + ratioSel.toFixed(3) + ':1')
        .toBeGreaterThanOrEqual(3);
    }
  });

  it('④ 没有规则把 .wb-row 的焦点环重置掉（outline:none 一类的回退）', () => {
    const offenders: string[] = [];
    for (const f of readdirSync(STYLES).filter((n) => n.endsWith('.css')).sort()) {
      const text = stripComments(cssText(f));
      for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = (m[1] ?? '').trim().replace(/\s+/g, ' ');
        if (!/\.wb-row/.test(selector) || !/:focus/.test(selector)) continue;
        for (const d of (m[2] ?? '').split(';')) {
          const i = d.indexOf(':');
          if (i < 0) continue;
          const prop = d.slice(0, i).trim();
          const value = d.slice(i + 1).trim();
          if ((prop === 'outline' || prop === 'box-shadow') && value === 'none') offenders.push(f + ' :: ' + selector);
        }
      }
    }
    expect(offenders, '不得有规则把 .wb-row 的焦点指示器重置为 none').toEqual([]);
  });

  it('④b 指示器是 outline（不参与布局 ⇒ 焦点不会推挤列表），且没有第二条 outline 覆盖它', () => {
    const rules = rowFocusRules();
    for (const r of rules) expect(r.prop, '焦点指示器用 outline：它不参与布局，行高与行位置在聚焦前后逐像素不变').toBe('outline');
    // 只允许**一条** `.wb-row:focus-visible` 的 outline 规则：多一条就是「后来人加回来」的入口。
    const outs = rules.filter((r) => r.prop === 'outline');
    expect(outs.length, '.wb-row 的 outline 焦点指示器应当只有一条').toBe(1);
    expect(outs[0]?.selector).toContain(':focus-visible');
  });
});
