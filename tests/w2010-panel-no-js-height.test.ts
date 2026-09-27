// @vitest-environment jsdom
/**
 * W2010 · 行内面板「高度全部交给 CSS」守护。
 *
 * 背景：providers 与 plugins 两个行内面板原先靠 JS 量高 ——
 * 展开时把 `scrollHeight + 'px'` 写进 inner.style.maxHeight、过渡结束后再写 'none'、
 * 收起时为了拿到动画还要「先固定当前高度 + void offsetHeight 强制回流」。
 * W2008 实测确认：`interpolate-size: allow-keywords`（可继承）+
 * `max-height: max-content` 能让过渡自己补间，这些 JS 写点可以整体删除。
 *
 * 本文件钉住四条**机械**不变量（真机几何由 results/w2010/verify.mjs 三引擎实测）：
 *   ① 两个面板文件里**一个高度写点都没有**（style.maxHeight / scrollHeight /
 *      offsetHeight / 强制回流 hack）；
 *   ② 展开终值是 `max-height: max-content` 且**不带 @supports 守卫** ——
 *      FF 155 / WebKit 26.6 的 CSS.supports('interpolate-size','allow-keywords')
 *      为 false，加守卫会让 max-height 停在 0px、内容**永久不可见**（W2008 实测
 *      clientHeight = 0）；
 *   ③ 绝不用 `calc-size()`（同实测：FF/WebKit 下内容永久不可见）；
 *   ④ interpolate-size 必须真的落在两个面板的**祖先**上（它是可继承属性，
 *      写在边界内的文件即可，不必动架构师独占的 tokens.css）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web');
const read = (rel: string): string => readFileSync(join(WEB, rel), 'utf8');

/** 两个面板的生产文件（只许切 class，不许量高）。 */
const PANEL_SRC = [
  'src/ui/providers/panel.ts',
  'src/ui/plugins/config-panel.ts',
] as const;

/** 剥掉注释后剩下的才是真代码（本仓注释里会**引用**被禁的写法做说明）。 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('W2010 ① 面板不再用 JS 量高', () => {
  it('两个面板文件里没有任何高度写点 / 强制回流', () => {
    for (const rel of PANEL_SRC) {
      const src = code(read(rel));
      for (const bad of ['style.maxHeight', 'scrollHeight', 'offsetHeight']) {
        expect(src.includes(bad), rel + ' 不得再出现 ' + bad).toBe(false);
      }
      // 强制回流 hack 的专有形状（`void` 本身合法：面板里还有 fire-and-forget 的 promise）
      expect(/void\s+[\w.$]*offsetHeight/.test(src), rel + ' 不得再有强制回流 hack').toBe(false);
    }
  });

  it('syncPanelHeight 与 onLayout 量高回调已整体删除', () => {
    const all = PANEL_SRC.map((r) => code(read(r))).join('\n');
    expect(all.includes('syncPanelHeight')).toBe(false);
    // providers 的表单钩子 onLayout 只为量高而生：面板侧不再接它
    expect(code(read('src/ui/providers/panel.ts')).includes('onLayout')).toBe(false);
    expect(code(read('src/ui/plugins/index.ts')).includes('syncPanelHeight')).toBe(false);
  });

  it('展开/收起只切 class（.open 与 aria-expanded）', () => {
    const panel = code(read('src/ui/providers/panel.ts'));
    expect(panel).toMatch(/panelTr\.classList\.add\('open'\)/);
    expect(panel).toMatch(/panelTr\.classList\.remove\('open'\)/);
    expect(panel).toMatch(/setAttribute\('aria-expanded', 'true'\)/);
    expect(panel).toMatch(/setAttribute\('aria-expanded', 'false'\)/);
    const cfg = code(read('src/ui/plugins/config-panel.ts'));
    expect(cfg).toMatch(/panel\.classList\.add\('open'\)/);
    expect(cfg).toMatch(/panel\.classList\.remove\('open'\)/);
  });
});

describe('W2010 ② 展开终值是 max-content，且没有 @supports 守卫', () => {
  const RULES = [
    { css: 'src/styles/settings.css', sel: '.prov-panel-row.open .prov-inline' },
    { css: 'src/styles/plugins.css', sel: '.plug-panel.open .plug-panel-inner' },
  ] as const;

  it('展开规则无条件写 max-height: max-content', () => {
    for (const r of RULES) {
      const text = read(r.css);
      const i = text.indexOf(r.sel + ' {');
      expect(i, r.css + ' 必须有 ' + r.sel + ' 规则').toBeGreaterThan(-1);
      const block = text.slice(i, text.indexOf('}', i));
      expect(block).toMatch(/max-height:\s*max-content;/);
    }
  });

  it('★ 绝不把 max-content 包进 @supports 守卫（FF/WebKit 会永久不可见）', () => {
    for (const r of RULES) {
      const text = read(r.css);
      // 逐条 @supports 块检查：块内出现 max-height: max-content 即失败
      for (const m of text.matchAll(/@supports[^{]*\{([\s\S]*?)\n\}/g)) {
        expect(
          /max-height:\s*max-content/.test(m[1] ?? ''),
          r.css + ' 的 @supports 块里不得出现 max-height: max-content',
        ).toBe(false);
      }
      // 该选择器的 max-height 声明必须**不在**任何 @supports 内 —— 用「块内注释标记」的
      // 反向证据钉死：声明必须出现在 .open 规则体内（上一条已断言），且全文件里
      // max-content 只出现一次（若被挪进守卫，规则体里就没有了）。
      const hits = text.split('max-height: max-content').length - 1;
      expect(hits, r.css + ' 里 max-height: max-content 只应出现 1 次（无条件那一次）').toBe(1);
    }
  });

  it('★ 绝不使用 calc-size()（同实测：FF/WebKit 内容永久不可见）', () => {
    for (const f of ['src/styles/settings.css', 'src/styles/plugins.css', 'src/styles/provider-edit.css']) {
      expect(read(f).includes('calc-size('), f + ' 不得使用 calc-size()').toBe(false);
    }
  });
});

describe('W2010 ③ interpolate-size 落在面板祖先上（不碰 tokens.css）', () => {
  it('两个面板各有可继承的 interpolate-size: allow-keywords 落点', () => {
    const prov = read('src/styles/settings.css');
    expect(prov).toMatch(/\.prov-table\s*\{[^}]*interpolate-size:\s*allow-keywords;/);
    const plug = read('src/styles/plugins.css');
    expect(plug).toMatch(/\.plug-entry\s*\{[^}]*interpolate-size:\s*allow-keywords;/);
  });

  it('落点是**祖先**而非承载元素本身（.prov-inline / .plug-panel-inner 只拿继承值）', () => {
    const prov = read('src/styles/settings.css');
    const i = prov.indexOf('.prov-inline {');
    expect(prov.slice(i, prov.indexOf('}', i))).not.toContain('interpolate-size');
    const plug = read('src/styles/plugins.css');
    const j = plug.indexOf('.plug-panel-inner {');
    expect(plug.slice(j, plug.indexOf('}', j))).not.toContain('interpolate-size');
  });

  it('架构师独占的 tokens.css 未被本改动波及（不含 interpolate-size）', () => {
    expect(read('src/styles/tokens.css').includes('interpolate-size')).toBe(false);
  });
});
