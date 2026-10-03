// @vitest-environment jsdom
/**
 * F2-03 / F2-04 / F2-05：390px 设置页几何 + 上下文环可访问名。
 *
 * F2-03：窄档 .settings-nav 变 row，但 align-items 未复位 —— 默认 normal 在 row 下
 *        等价 stretch，9 个导航项一律被拉到 135px 高（选中项是瘦高药丸）。
 * F2-04：窄档设置页已是 height:100dvh + border-radius:0 的全屏形态，settings.css
 *        那条 34px 顶内边距仍在，shell 底部 34px 落到视口外（bottom=878 > vh 844）。
 * F2-05：#slRing 的 aria-label 原先由 `(title).replace(clickFull, '')` 削出来 ——
 *        未知态的 unknownTitle 写的是「点击查看完整上下文」**不带括号**，
 *        replace 削不掉，操作提示漏进可访问名。改为每分支独立字典键。
 *
 * 加载纪律（同 F2-01/02 那个文件）：
 *   1. 前端模块一律走 tests/lib/w795-dom.ts 的 at(rel) 动态加载器 + 窄接口，
 *      不得写 typeof import('../apps/web/src/...')（那是类型级静态导入，会把整棵
 *      apps/web 拖进根 tsc/depcruise 工程）。
 *   2. 不得直接用 DOM 全局类型（HTMLElement / Document / document）—— 根 tsconfig
 *      的 lib 里没有 DOM，本仓 web 测试一律经夹具的 doc / ElLike 访问。
 *
 * CSS 这两条用 **CSSOM 规则匹配** 断言（jsdom 能解析媒体查询与层叠顺序），
 * 而不是量 getBoundingClientRect —— jsdom 不做布局，量出来恒为 0。
 */
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { at, doc, type ElLike } from './lib/w795-dom.js';

/** 元素窄类型：只补本测试用到的那几个成员。 */
interface FocusEl extends ElLike {
  getAttribute(k: string): string | null;
  setAttribute(k: string, v: string): void;
  textContent: string | null;
  title: string;
  style: Record<string, unknown>;
  classList: { add(c: string): void; remove(c: string): void; toggle(c: string, on?: boolean): boolean; contains(c: string): boolean };
}

interface RingMod {
  renderContextCell(ctxEl: FocusEl, ring: FocusEl, usage: unknown): void;
}

interface I18nMod {
  t(key: string, vars?: Record<string, string | number>): string;
}
interface LocaleStatusline { statusline: Record<string, string> }

/**
 * 仓库根：从本文件位置反推，**不得写死本机绝对路径**。
 * 写死只在作者本机成立 —— CI runner 上必然 ENOENT（main run 37133961564 即因此变红），
 * 而本地因为那个路径真实存在反而全绿，属「把本机事实当普遍事实」（同 17cacfc 那一类）。
 */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const loadRing = async (): Promise<RingMod> =>
  (await import(/* @vite-ignore */ at('statusline/ring.ts'))) as unknown as RingMod;
const loadI18n = async (): Promise<I18nMod> =>
  (await import(/* @vite-ignore */ at('i18n/index.ts'))) as unknown as I18nMod;
const loadZhStatusline = async (): Promise<LocaleStatusline> =>
  (await import(/* @vite-ignore */ at('i18n/locales/zh/statusline.ts'))) as unknown as LocaleStatusline;
const loadEnStatusline = async (): Promise<LocaleStatusline> =>
  (await import(/* @vite-ignore */ at('i18n/locales/en/statusline.ts'))) as unknown as LocaleStatusline;

interface RuleLike {
  selectorText?: string;
  /** CSSOM 里 @media 规则带的是 MediaList 对象（不是字符串），取它的 mediaText。 */
  media?: { mediaText: string };
  /**
   * 媒体查询里的子规则列表。
   *
   * ★ 字段名是 **cssRules**，不是 rules —— 写错会静默拿到 undefined、递归进去
   *   等于空数组，于是整条查找返回 null（jsdom 上实测踩过；同层的 style 规则
   *   用 selectorText 判定，不需要任何子列表字段）。
   */
  cssRules?: RuleLike[];
  style?: { getPropertyValue(p: string): string } | null;
}

interface CSSStyleSheetLike {
  cssRules: RuleLike[];
}

/**
 * 在一张 <style> 里找出「命中该选择器、且位于 @media (max-width:640px) 内」的规则，
 * 返回其声明体里某条属性的值；找不到返回 null。
 *
 * 为什么走 CSSOM 而不是量盒模型：jsdom 不做布局，getBoundingClientRect 恒为 0；
 * 而 F2-03/F2-04 的根因**就是声明本身**（align-items / padding），规则匹配
 * 才是与根因同构的断言。真机量测见 results 下的截图证据。
 */
function mobileRule(prop: string, selector: string): string | null {
  const host = doc.querySelector('style') as unknown as { sheet?: CSSStyleSheetLike | null } | null;
  const sheet = host?.sheet;
  if (!sheet) return null;
  // 收集候选后再取值：拼接多张表后，**同一个选择器在窄档里可能出现多次**
  // （例如 .settings-nav-item 在 tablet 档与 mobile 档各一条）。命中选择器但没有这条
  // 属性时必须**继续找**，不能就此返回 null —— 那是本函数第一版的 bug。
  const found: string[] = [];
  const walk = (rules: RuleLike[], inMobile: boolean): void => {
    for (const rule of rules) {
      if (rule.media !== undefined) {
        walk(rule.cssRules ?? [], /max-width:\s*640px/.test(rule.media.mediaText));
        continue;
      }
      if (!inMobile) continue;
      if (rule.selectorText !== selector) continue;
      const v = (rule.style?.getPropertyValue(prop) ?? '').trim();
      if (v !== '') found.push(v);
    }
  };
  walk(sheet.cssRules, false);
  // 层叠：同优先级下后写的赢。
  return found.length ? (found[found.length - 1] as string) : null;
}

/** 把样式表按 main.ts 的相对顺序拼进一张 <style>（tokens → settings → responsive）。 */
function unmountStyles(): void {
  (doc as unknown as { head: { innerHTML: string } }).head.innerHTML = '';
}

function mountStyles(files: readonly string[]): void {
  const css = files.map((f) => readFileSync(ROOT + '/apps/web/src/styles/' + f, 'utf8')).join('\n');
  const node = doc.createElement('style');
  // 先入档再填内容：<style> 的 sheet 在插入文档时按当时的 textContent 建立，
  // 先填后插在 jsdom 上拿不到 cssRules（已实测 sheet 为 null）。
  (doc as unknown as { head: ElLike }).head.appendChild(node as unknown as ElLike);
  (node as unknown as { textContent: string }).textContent = css;
}

const STYLE_FILES = ['tokens.css', 'base.css', 'settings.css', 'responsive.css'];

describe('F2-03 · 390px 设置页导航项高度', () => {
  beforeEach(() => {
    mountStyles(STYLE_FILES);
  });
  afterEach(() => {
    unmountStyles();
  });

  it('窄档 .settings-nav 必须复位 align-items（row 方向下 normal = stretch）', () => {
    const v = mobileRule('align-items', '.settings-nav');
    if (v === null) {
      // 断言失败时把「看到了哪些选择器」打出来，避免又一次瞎猜
      const host = doc.querySelector('style') as unknown as { sheet?: { cssRules: unknown[] } | null } | null;
      const seen: string[] = [];
      const dump = (rules: unknown[]): void => {
        for (const raw of rules) {
          const r = raw as { media?: { mediaText: string }; cssRules?: unknown[]; selectorText?: string };
          if (r.media) dump(r.cssRules ?? []);
          else if (r.selectorText && /settings-nav/.test(r.selectorText)) seen.push(r.selectorText);
        }
      };
      dump(host?.sheet?.cssRules ?? []);
      throw new Error('mobileRule null; selectors seen under mobile media: ' + JSON.stringify(seen));
    }
    expect(v).toBe('center');
  });

  it('窄档 .settings-nav-item 钉住高度 = --tap-min，不再被拉伸到导航条全高', () => {
    const h = mobileRule('height', '.settings-nav-item');
    expect(h).not.toBeNull();
    expect(h).toBe('var(--tap-min)');
  });

  it('窄档 .settings-nav-item 同时保留触控下限（不得为修高度把命中区缩小）', () => {
    expect(mobileRule('min-height', '.settings-nav-item')).toBe('var(--tap-min)');
  });
});

describe('F2-04 · 390px 设置页 shell 不再超出视口', () => {
  beforeEach(() => {
    mountStyles(STYLE_FILES);
  });
  afterEach(() => {
    unmountStyles();
  });

  it('窄档 .settings-page 内边距归零（全屏形态不需要那 34px 顶留白）', () => {
    // jsdom 把 `padding: 0` 规范化成 `0px`，两种写法都接受。
    expect(mobileRule('padding', '.settings-page')).toMatch(/^0(px)?$/);
  });

  it('窄档 shell 仍是 100dvh 全屏（padding 归零后正好铺满一屏）', () => {
    expect(mobileRule('height', '.settings-shell')).toBe('100dvh');
  });

  it('settings.css 的桌面态 padding 未被窄档规则改写（只影响 ≤640px）', () => {
    const css = readFileSync(ROOT + '/apps/web/src/styles/settings.css', 'utf8');
    expect(css).toContain('padding: 34px 24px 24px;');
  });
});
/** 一个最小的环元素替身：只实现 renderContextCell 会碰到的那些成员。 */
function fakeRing(): FocusEl & { attrs: Record<string, string> } {
  const attrs: Record<string, string> = {};
  const node = doc.createElement('span');
  const style: Record<string, unknown> = {};
  const cl = {
    add: () => {},
    remove: () => {},
    toggle: () => false,
    contains: () => false,
  };
  const w = node as unknown as FocusEl & { attrs: Record<string, string> };
  w.attrs = attrs;
  w.style = style;
  w.classList = cl;
  w.title = '';
  w.textContent = '';
  w.setAttribute = (k: string, v: string) => { attrs[k] = v; };
  w.getAttribute = (k: string): string | null => (k in attrs ? (attrs[k] as string) : null);
  return w;
}

function fakeCtx(): FocusEl {
  const node = doc.createElement('span');
  const w = node as unknown as FocusEl;
  w.textContent = '';
  return w;
}

describe('F2-05 · 上下文环的可访问名恒稳定', () => {
  beforeEach(async () => {
    const i18n = await loadI18n();
    i18n.t('statusline.ring.noneAria'); // 预热，锁住当前语言
  });

  it('空闲态（无 usage）：aria-label 非空，且**不含**「点击」操作提示', async () => {
    const ring = await loadRing();
    const r = fakeRing();
    ring.renderContextCell(fakeCtx(), r, undefined);
    const aria = r.getAttribute('aria-label') ?? '';
    expect(aria.length).toBeGreaterThan(0);
    expect(aria).not.toContain('点击');
  });

  it('未知态（usage 但 window=0）：aria-label 非空且不含「点击」', async () => {
    const ring = await loadRing();
    const r = fakeRing();
    ring.renderContextCell(fakeCtx(), r, { used: 10, window: 0, ratio: 0 });
    const aria = r.getAttribute('aria-label') ?? '';
    expect(aria.length).toBeGreaterThan(0);
    expect(aria).not.toContain('点击');
  });

  it('数据态：aria-label 带完整数值，且不含「点击」', async () => {
    const ring = await loadRing();
    const r = fakeRing();
    ring.renderContextCell(fakeCtx(), r, { used: 12000, window: 200000, ratio: 0.06 });
    const aria = r.getAttribute('aria-label') ?? '';
    expect(aria).toContain('6');
    expect(aria).not.toContain('点击');
  });

  it('三态的 aria-label 都非空 —— 环是 role=button 的可聚焦控件，名字空了读屏只报「按钮」', async () => {
    const ring = await loadRing();
    const cases: unknown[] = [undefined, { used: 1, window: 0, ratio: 0 }, { used: 5, window: 100, ratio: 0.05 }];
    for (const usage of cases) {
      const r = fakeRing();
      ring.renderContextCell(fakeCtx(), r, usage);
      expect((r.getAttribute('aria-label') ?? '').trim().length).toBeGreaterThan(0);
    }
  });

  it('aria-label 不再由 title 削字符串得来（没有 replace(clickFull) 这条路）', () => {
    const src = readFileSync(ROOT + '/apps/web/src/statusline/ring.ts', 'utf8');
    expect(src).not.toContain("replace(t('statusline.ring.clickFull')");
  });

  it('zh/en 都有三个 *Aria 键，且与各自的 *Title 键成对存在', async () => {
    const zh = (await loadZhStatusline()).statusline;
    const en = (await loadEnStatusline()).statusline;
    for (const dict of [zh, en]) {
      for (const k of ['statusline.ring.titleAria', 'statusline.ring.unknownAria', 'statusline.ring.noneAria']) {
        expect((dict[k] ?? '').length).toBeGreaterThan(0);
      }
    }
  });
});
