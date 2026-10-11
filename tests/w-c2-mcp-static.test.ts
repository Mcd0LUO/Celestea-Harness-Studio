// @vitest-environment jsdom
/**
 * W-C2 · MCP 设置页的**静态**不变量（不碰网络、不碰真实装配）：
 *   ① ui/config.ts 的 PANES 与 apps/web/index.html **逐名双向一致** ——
 *      这是 W-C2 把 paneEl/navEl 从 `need()` 改成可空之后，那条不变量改由这里守；
 *   ② MCP 那一格的静态文案**只**走 data-i18n（护栏 D 在此的局部版本）；
 *   ③ i18n 双语键齐，且这一格的文案两语都不是「回落成 key 本身」。
 *
 * ★ 为什么不把 ① 放回运行时的 `need()`：11 个共用 jsdom 夹具各自写死了九格骨架，
 *   让 initSettingsPage() 为它们根本没建的 pane 抛错 —— 那是用夹具的过时换实现的
 *   正确。读 index.html 真源逐名比对，比运行时抛错更早暴露，也不会波及无关用例。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { at } from './lib/w795-dom.js';

const ROOT = process.cwd();
const html = readFileSync(join(ROOT, 'apps', 'web', 'index.html'), 'utf8');
const configSrc = readFileSync(join(ROOT, 'apps', 'web', 'src', 'ui', 'config.ts'), 'utf8');

/** PANES 的真源是 ui/config.ts 的字面量（它不导出，故从源码读）。 */
function paneNames(): string[] {
  const literal = /const PANES = \[([^\]]*)\]/.exec(configSrc)?.[1] ?? '';
  return [...literal.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '').filter((n) => n !== '');
}

/** 去掉 HTML 注释（中文注释不是文案，护栏 D 也是先剥注释再扫）。 */
function withoutComments(src: string): string {
  return src.replace(/<!--[\s\S]*?-->/g, '');
}

describe('W-C2 · 设置页「MCP」格的静态不变量', () => {
  it('index.html 为 PANES 的每一项都注册了 nav 项与 pane（缺一个即红）', () => {
    const names = paneNames();
    expect(names.length, 'PANES 不能是空的').toBeGreaterThan(0);
    expect(names, '第十格必须是 mcp').toContain('mcp');
    for (const n of names) {
      expect(html.includes('data-page="' + n + '"'), '缺 nav 项：' + n).toBe(true);
      expect(html.includes('data-pane="' + n + '"'), '缺 pane：' + n).toBe(true);
    }
  });

  it('index.html 里没有 PANES 之外的 nav / pane（防止加了格忘了接线）', () => {
    const names = new Set(paneNames());
    const navs = [...html.matchAll(/class="settings-nav-item[^"]*"[^>]*data-page="([^"]+)"/g)].map((m) => m[1] ?? '');
    const panes = [...html.matchAll(/class="settings-pane[^"]*"[^>]*data-pane="([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(navs.length, 'nav 项数').toBe(panes.length);
    expect([...navs].filter((n) => !names.has(n)), '多出来的 nav 项').toEqual([]);
    expect([...panes].filter((n) => !names.has(n)), '多出来的 pane').toEqual([]);
  });

  it('MCP 那一格的静态文案只走 data-i18n（剥注释后不得有中文）', () => {
    const bare = withoutComments(html);
    const start = bare.indexOf('data-pane="mcp"');
    expect(start, '找不到 MCP 的 pane').toBeGreaterThan(-1);
    const section = bare.slice(start, bare.indexOf('</section>', start));
    expect(section).toContain('id="settingsMcp"');
    expect(section, '标题与说明必须挂 data-i18n').toContain('data-i18n="settings.mcp.paneTitle"');
    expect(section).toContain('data-i18n="settings.mcp.paneNote"');
    expect(section, '静态骨架里不得有中文字面量').not.toMatch(/[\u3400-\u9fff]/);
    const nav = /<button class="settings-nav-item"[^>]*data-page="mcp"[^>]*>/.exec(bare)?.[0] ?? '';
    expect(nav).toContain('data-i18n="settings.mcp.tab"');
  });

  it('i18n：zh/en 双语都有这一格的键，且都不是回落成 key 本身', async () => {
    const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as {
      t(k: string, p?: Record<string, string | number>): string;
      setLocale(l: string): void;
      localeDict(l: string): Record<string, string>;
    };
    const keys = [
      'settings.mcp.tab',
      'settings.mcp.empty',
      'settings.mcp.emptyHint',
      'settings.mcp.unavailable',
      'settings.mcp.summary',
      'settings.mcp.state.ready',
      'settings.mcp.state.failed',
      'settings.mcp.state.disabled',
      'settings.mcp.state.unknown',
      'settings.mcp.failure.connect_failed',
    ];
    const zh = i18n.localeDict('zh');
    const en = i18n.localeDict('en');
    for (const k of keys) {
      expect(zh[k], 'zh 缺 ' + k).toBeTruthy();
      expect(en[k], 'en 缺 ' + k).toBeTruthy();
      expect(en[k], 'en 混进了中文：' + k).not.toMatch(/[\u3400-\u9fff]/);
    }
    i18n.setLocale('zh');
    expect(i18n.t('settings.mcp.tab')).toBe(zh['settings.mcp.tab']);
    i18n.setLocale('en');
    expect(i18n.t('settings.mcp.state.failed')).toBe(en['settings.mcp.state.failed']);
    // 空态必须**指向数据文件**（不给编辑 UI），两语都要指。
    expect(zh['settings.mcp.emptyHint']).toContain('mcp.json');
    expect(en['settings.mcp.emptyHint']).toContain('mcp.json');
    i18n.setLocale('zh');
  });
});
