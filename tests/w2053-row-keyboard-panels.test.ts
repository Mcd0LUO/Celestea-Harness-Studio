// @vitest-environment jsdom
// ============================================================================
// W2053 验收（接线面 · 弹层与设置页）：目录浏览弹层的目录行 / 提供商表行
// **真的**接上了键盘通道（跑真实生产模块，不复刻逻辑）。
//
// 与 tests/w2053-row-keyboard-sites.test.ts 的分工：那个文件守会话树（位点 1/2/3）；
//   本文件守位点 4/5。拆两个文件是因为本仓 eslint 对 tests/** 有单文件 400 行上限。
//
// 位点：
//   4. ui/fsbrowser.ts        .ws-fs-dir   —— 目录浏览弹层的目录行（roving）
//   5. ui/providers/panel.ts  tr.prov-row  —— 提供商表行（★ 唯一**不走 roving** 的一处）
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, doc, flush, reply, resetHarness } from './lib/w795-dom.js';
import { activeEl, installFetch, keyOn, loadProviders, openBrowser, q, qa, settle, stopsIn, type El } from './lib/w2053-rows.js';

beforeEach(() => { resetHarness(); });
afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

describe('W2053 位点 4 · 目录浏览弹层 .ws-fs-dir（fsbrowser.ts）', () => {
  /** 开一个弹层并返回「服务端收到的 path 序列」（假后端归一成绝对路径，与真后端一致）。 */
  async function bootAndCollect(): Promise<string[]> {
    const calls: string[] = [];
    installFetch((u) => {
      if (u.includes('/api/fs/browse')) {
        const asked = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
        const abs = asked === '' ? '/src' : asked;
        calls.push(abs);
        return reply(200, { path: abs, dirs: abs === '/src' ? ['alpha', 'beta'] : [] });
      }
      return undefined;
    });
    await openBrowser();
    return calls;
  }

  it('① 每一行目录都被标成可聚焦按钮，名字 = 可见目录名', async () => {
    installFetch((u) => (u.includes('/api/fs/browse') ? reply(200, { path: '/src', dirs: ['alpha', 'beta', 'gamma'] }) : undefined));
    await openBrowser();
    const rows = qa('.ws-fs-dir');
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.hasAttribute('data-roving')).toBe(true);
      expect(row.getAttribute('role')).toBe('button');
      expect(row.getAttribute('aria-label')).toBe(row.querySelector('.ws-fs-dir-name')?.textContent ?? '@@');
    }
  });

  it('③ 目录清单整体只占 1 个停靠点（3 行）', async () => {
    installFetch((u) => (u.includes('/api/fs/browse') ? reply(200, { path: '/src', dirs: ['alpha', 'beta', 'gamma'] }) : undefined));
    await openBrowser();
    expect(stopsIn('.ws-fs-tree').length).toBe(1);
    expect(qa('.ws-fs-dir[tabindex="0"]').length).toBe(1);
  });

  it('② Enter 与 click 等效：进的是同一个子目录（请求序列逐项相同）', async () => {
    // 鼠标：点第二行（beta）
    const callsByClick = await bootAndCollect();
    expect(qa('.ws-fs-dir').length, '第一层两个子目录').toBe(2);
    click(qa('.ws-fs-dir')[1] as El, true);
    await settle();
    expect(callsByClick, '鼠标路径').toEqual(['/src', '/src/beta']);
    const namesByClick = qa('.ws-fs-dir-name').map((n) => n.textContent);
    expect(namesByClick, '鼠标真的进了空目录').toEqual([]);
    // 键盘：全新弹层 → Enter 第二行
    const callsByKey = await bootAndCollect();
    keyOn(qa('.ws-fs-dir')[1] as El, 'Enter');
    await settle();
    expect(callsByKey, '键盘路径必须产生**同一个**请求序列').toEqual(callsByClick);
    expect(qa('.ws-fs-dir-name').map((n) => n.textContent), '两边都真的进了新目录').toEqual(namesByClick);
  });

  it('②b 键盘进子目录后焦点接回新清单的第一行（不掉回 body）', async () => {
    installFetch((u) => {
      if (u.includes('/api/fs/browse')) {
        const asked = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
        const abs = asked === '' ? '/src' : asked;
        return reply(200, { path: abs, dirs: abs === '/src' ? ['alpha'] : ['inner'] });
      }
      return undefined;
    });
    await openBrowser();
    keyOn(qa('.ws-fs-dir')[0] as El, 'Enter');
    await settle();
    const rows = qa('.ws-fs-dir');
    expect(rows.map((n) => n.querySelector('.ws-fs-dir-name')?.textContent)).toEqual(['inner']);
    expect(activeEl(), '焦点必须落在新清单的第一行（不是掉回 body）').toBe(rows[0]);
  });

  it('④ 鼠标点目录：**不**夺焦（焦点不被本模块改动）', async () => {
    installFetch((u) => (u.includes('/api/fs/browse') ? reply(200, { path: '/src', dirs: ['alpha', 'beta', 'gamma'] }) : undefined));
    await openBrowser();
    click(qa('.ws-fs-dir')[0] as El, true);
    await settle();
    expect(activeEl(), '鼠标导航不得被本模块夺焦').toBe(doc.body);
  });
});

describe('W2053 位点 5 · 提供商表行 tr.prov-row（providers/panel.ts）', () => {
  const PROVIDERS = [
    { id: 'p1', name: '网关甲', note: 'n1', request_format: 'chat_completions', models: [{ id: 'm1' }], is_default: true, has_key: true },
    { id: 'p2', name: '网关乙', note: 'n2', request_format: 'chat_completions', models: [], is_default: false, has_key: false },
  ];
  const bootProviders = (): Promise<void> => loadProviders(PROVIDERS);

  it('① 行**自己**进 Tab 序列（tabindex=0），role=row 与 aria-expanded 保住', async () => {
    await bootProviders();
    const rows = qa('.prov-table tbody tr.prov-row');
    expect(rows.length).toBe(2);
    for (const tr of rows) {
      expect(tr.getAttribute('tabindex'), '表格行走「自己占一个停靠点」模型').toBe('0');
      expect(tr.getAttribute('role'), '★ 不得改成 button：那会把 role=cell 全部降级成 generic（真机 AX 实测）').not.toBe('button');
      expect(tr.getAttribute('aria-expanded'), '既有 aria 一字不改').toBe('false');
      expect(tr.hasAttribute('data-roving'), '表格行**不**参与 roving（它不是 roving 行）').toBe(false);
    }
  });

  it('③ 行数有界 ⇒ 停靠点数 = 行数（2 行 2 个；这是刻意的，不是 Tab 污染）', async () => {
    await bootProviders();
    expect(qa('.prov-table tbody tr.prov-row[tabindex="0"]').length).toBe(2);
  });

  it('② Enter 与 click 等效：同一个展开态迁移（false → true → false）', async () => {
    await bootProviders();
    const rows = qa('.prov-table tbody tr.prov-row');
    const panelTr = q('.prov-panel-row') as El;
    keyOn(rows[0] as El, 'Enter');
    await flush();
    expect(rows[0]?.getAttribute('aria-expanded'), '键盘真的展开了').toBe('true');
    expect(panelTr.classList.contains('open')).toBe(true);
    keyOn(rows[0] as El, 'Enter');
    expect(rows[0]?.getAttribute('aria-expanded'), '再按一次收起（同一个 toggle 处理器）').toBe('false');
    expect(panelTr.classList.contains('open')).toBe(false);
  });

  it('②b Space 同样切换展开态', async () => {
    await bootProviders();
    const rows = qa('.prov-table tbody tr.prov-row');
    keyOn(rows[1] as El, ' ');
    await flush();
    expect(rows[1]?.getAttribute('aria-expanded')).toBe('true');
  });

  it('②c 行内「删除」按钮上的 Enter 只归它自己（不展开整行）', async () => {
    await bootProviders();
    const rows = qa('.prov-table tbody tr.prov-row');
    keyOn(rows[0]?.querySelector('.btn-mini.danger') as El, 'Enter');
    await flush();
    expect(rows[0]?.getAttribute('aria-expanded'), '删除按钮上的 Enter 不得展开内联面板').toBe('false');
  });

  it('④ 鼠标点击行仍然展开（既有 click 处理器一字未改）', async () => {
    await bootProviders();
    const rows = qa('.prov-table tbody tr.prov-row');
    click(rows[1] as El, true);
    await flush();
    expect(rows[1]?.getAttribute('aria-expanded')).toBe('true');
  });
});
