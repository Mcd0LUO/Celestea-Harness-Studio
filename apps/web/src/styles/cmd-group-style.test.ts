// @vitest-environment node
// ============================================================================
// composer-surface §1.4 · 补全框**分组头**的样式真源：分组不靠颜色，靠小号文字 + 间距 + 上边框。
//
// 为什么单独一个文件：行为面在 tests/composer-surface-popup-groups.test.ts（jsdom），
// 这里只做 **CSS 解析 + 对比度实算**（纯 node，不需要浏览器）。与 w2040 同一口径：
// 取值一律从 apps/web/src/styles/*.css **解析**出来算，不把期望值抄一遍（抄一遍就自证）。
//
// 三条不变量，各配一次变异负控制（见交付报告 §变异）：
//   ① 非颜色维度齐全：上边框（非 none）+ 比正文更小的字号 + 非零间距 + 非 pointer 光标；
//   ② 颜色只作**加强**：必须是正文层级 token（--c-text-2/--c-text-3），不得是 --c-accent*，
//      且与正文色 --c-text-1 的对比度 ≥ 3:1 —— §1.4 点名的事故形态正是「差 3%、肉眼不可辨」
//      （--c-accent #1a1a1a vs --c-text-1 #111 = 1.03:1；tokens.css 的 --hl-title 同款）；
//   ③ 组头文字对**弹层自己的底色**（.cmd-popup 的 --c-surface-raised）在 mono 浅/深两套下
//      都 ≥ 4.5:1（WCAG 2.2 SC 1.4.3 小字门槛：组头 10.5px 属小字）。
//      覆盖口径：mono 两套在 tokens.css 里；claude 主题的同一组 --label-* token 由既有
//      W9226 实测（四套配色三级文字全部 ≥4.5:1），本文件不重复算。
// ============================================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const cssText = (f: string): string => readFileSync(join(HERE, f), 'utf8');
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');

const COMMANDS = stripComments(cssText('commands.css'));
const TOKENS = stripComments(cssText('tokens.css'));

interface Rule {
  sel: string;
  decls: Record<string, string>;
}

function parseRules(css: string): Rule[] {
  const out: Rule[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls: Record<string, string> = {};
    for (const d of (m[2] ?? '').split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      decls[(d.slice(0, i) ?? '').trim()] = (d.slice(i + 1) ?? '').trim();
    }
    out.push({ sel: (m[1] ?? '').trim().replace(/\s+/g, ' '), decls });
  }
  return out;
}

/** 选择器**逐字**匹配的那一条规则（不含 `.cmd-popup > .cmd-group:first-child`）。 */
function rule(sel: string): Record<string, string> {
  const hits = parseRules(COMMANDS).filter((r) => r.sel === sel);
  if (hits.length !== 1) throw new Error(sel + ' 应当恰好一条规则，实得 ' + hits.length);
  return hits[0]?.decls ?? {};
}

function block(css: string, selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) throw new Error('selector not found: ' + selector);
  const start = css.indexOf('{', i);
  let depth = 0;
  for (let j = start; j < css.length; j++) {
    const c = css[j];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start + 1, j);
    }
  }
  throw new Error('unbalanced braces for ' + selector);
}

function vars(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1] ?? ''] = (m[2] ?? '').trim();
  return out;
}

/** 沿 var() 链解析到字面值（只认整条就是一个 var() 的写法，与 w2040 同口径）。 */
function resolve(table: Record<string, string>, name: string, depth = 0): string {
  if (depth > 10) throw new Error('var() chain too deep at ' + name);
  const raw = table[name];
  if (raw === undefined) throw new Error('token not defined: ' + name);
  const m = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(raw);
  return m === null ? raw : resolve(table, m[1] ?? '', depth + 1);
}

const MONO: Record<string, string> = { ...vars(block(TOKENS, ':root {')), ...vars(block(TOKENS, ':root,')) };
const DARK: Record<string, string> = { ...MONO, ...vars(block(TOKENS, '[data-theme="dark"]')) };

/** 只接受六位 hex：token 链一旦换成 rgba() 就**响亮地**失败，而不是悄悄跳过对比度计算。 */
function hex(v: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(v.trim());
  if (!m) throw new Error('not a 6-digit hex: ' + v);
  return parseInt(m[1] ?? '', 16);
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function contrast(a: string, b: string): number {
  const lum = (h: string): number => {
    const n = hex(h);
    return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
  };
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}


/** padding 简写的上下两个值（1/2/3/4 值写法都取首尾；顺序与 CSS 一致：上 … 下）。 */
function verticals(v: string): number[] {
  const parts = v.trim().split(/\s+/).map((p) => px(p));
  return [parts[0] ?? 0, parts[parts.length - 1] ?? 0];
}

function px(v: string): number {
  const m = /^([\d.]+)px$/.exec(v.trim());
  if (!m) throw new Error('not a px value: ' + v);
  return Number(m[1]);
}

/** 组头文字色在给定主题下解析出的字面值（必须整条走一个 token）。 */
function groupColor(table: Record<string, string>): string {
  const decl = rule('.cmd-group')['color'] ?? '';
  const m = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(decl);
  if (!m) throw new Error('组头颜色必须整条走一个 token（实际是：' + decl + '）');
  return resolve(table, m[1] ?? '');
}

/** 正文级 token：§1.4 允许颜色作加强，但加强色必须仍在正文层级里。 */
const TEXT_TOKENS = ['--c-text-1', '--c-text-2', '--c-text-3'];

describe('composer-surface §1.4 · 分组头样式（不靠颜色区分种类）', () => {
  it('① 非颜色维度齐全：上边框 + 更小的字号 + 间距 + 非 pointer 光标', () => {
    const g = rule('.cmd-group');
    expect(g['border-top'], '上边框是分组的主要非颜色维度').toMatch(/^1px solid var\(--c-border-/);
    for (const v of verticals(g['padding'] ?? '')) {
      expect(v, '组头上下都要留出间距（' + (g['padding'] ?? '') + '）').toBeGreaterThan(0);
    }
    expect(px(g['font-size'] ?? ''), '组头文字必须小于正文字号')
      .toBeLessThan(px(rule('.cmd-name')['font-size'] ?? ''));
    expect(g['cursor'], '组头不是可点控件').not.toBe('pointer');
    expect(rule('.cmd-row')['cursor'], '对照：行才是可点的').toBe('pointer');
  });

  it('② 颜色只作加强：正文层级 token，且与正文的差别肉眼可辨（≥3:1）', () => {
    const token = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(rule('.cmd-group')['color'] ?? '')?.[1] ?? '';
    // --c-accent 是 §1.4 点名的事故 token（mono 下与正文只差 3%）
    expect(TEXT_TOKENS as string[], '组头色必须是正文层级 token（实际 ' + token + '）').toContain(token);
    const fg = resolve(MONO, token);
    const ratio = contrast(fg, resolve(MONO, '--c-text-1'));
    expect(ratio, fg + ' vs 正文 ' + resolve(MONO, '--c-text-1') + ' = ' + ratio.toFixed(2)
      + ':1（§1.4 的事故形态是 1.03:1）').toBeGreaterThanOrEqual(3);
  });

  it('③ 组头文字对弹层底色在 mono 浅/深两套下都 ≥ 4.5:1（SC 1.4.3 小字）', () => {
    for (const [name, table] of [['mono 浅', MONO], ['mono 深', DARK]] as const) {
      const fg = groupColor(table);
      const bg = resolve(table, '--c-surface-raised');
      const ratio = contrast(fg, bg);
      expect(ratio, name + '：' + fg + ' 在 ' + bg + ' 上 = ' + ratio.toFixed(2) + ':1')
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  it('③b 对比度算法自检（防公式被改坏）：黑白 21:1、同色 1:1', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#123456', '#123456')).toBeCloseTo(1, 10);
  });
});
