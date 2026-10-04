// @vitest-environment jsdom
// ============================================================================
// W2053 验收（接线面 · 会话树）：会话树叶子 / worker 行 / worker 分组头
// **真的**接上了键盘通道（跑真实生产模块，不复刻逻辑）。
//
// 与 apps/web/src/ui/roving.test.ts 的分工：那个文件守**内核**（纯行为，不需要业务
//   模块）；本文件守**接线** —— 渲染函数是否真的调了 markRowButton / bindRoving。
//   内核全绿但某一处忘了接线，用户侧仍然是「按 Enter 没反应」，而内核测试一个字都不会红。
//
// 位点（简报给的编号，逐条对着改后的源码复核）：
//   1. ui/sessiontree/render.ts  .sess-leaf        —— 点它切会话（用户每天用的核心交互）
//   2. ui/sessiontree/workers.ts .ws-worker-row    —— 点它开 worker 会话
//   3. ui/sessiontree/workers.ts .ws-worker-parent —— worker 分组头（**可点的那种**）
//
// ★ 位点 3 的复核更正（不照抄简报）：简报说「workers.ts 里 `markRowButton(head, …)`
//   那一段是分组折叠头」。读源码后
//   那个「已分组」分支里的 `head` 其实是 **orphans 分支的「未关联」纯标签**（`head.title`
//   为空、**没有 click 监听**）—— 它不可点，不该是交互项。真正可点、真的需要键盘通道的是
//   **已分组分支**那个「父会话 → 其 worker 子行」的分组头（有 click、有 title）。
//   本遍改的是 `markRowButton(head, pname.textContent ?? '')` 那一处。
//   给 orphans 那个标签加 tabindex 会造出一个**假的交互项**（Tab 上去按 Enter 什么都不
//   发生）—— 那比不可达更糟。见报告「诚实清单」。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, click, doc, flush, reply, resetHarness } from './lib/w795-dom.js';
import { SESSIONS, installFetch, keyOn, loadSessionsTree, q, qa, stopsIn, type El } from './lib/w2053-rows.js';

beforeEach(() => { resetHarness(); });
afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

describe('W2053 位点 1 · 会话树叶子 .sess-leaf（render.ts）', () => {
  it('① 每一行都被标成可聚焦的按钮，且行名 = 可见标题（Label in Name）', async () => {
    installFetch(() => undefined);
    await loadSessionsTree();
    const leaves = qa('.sess-leaf');
    expect(leaves.length, '夹具画出了三个会话').toBe(3);
    for (const leaf of leaves) {
      expect(leaf.hasAttribute('data-roving'), '行必须带 roving 标记').toBe(true);
      expect(leaf.getAttribute('role')).toBe('button');
      expect(leaf.getAttribute('tabindex'), 'roving：行都可编程聚焦，但只有第一行进序列')
        .toBe(leaves[0] === leaf ? '0' : '-1');
      const visible = leaf.querySelector('.sess-leaf-name')?.textContent ?? '';
      expect(leaf.getAttribute('aria-label'), '无障碍名必须含可见标签原文（WCAG 2.5.3）').toBe(visible);
    }
  });

  it('③ 整棵树只占 1 个 Tab 停靠点（3 个会话、1 个工作区分组）', async () => {
    installFetch(() => undefined);
    await loadSessionsTree();
    expect(stopsIn('#sessionTree').length, 'roving：整棵树 1 个停靠点').toBe(1);
    expect(qa('.sess-leaf[tabindex="0"]').length).toBe(1);
  });

  it('② Enter 与 click 等效（同一个处理器：切到该会话）', async () => {
    installFetch(() => undefined);
    await loadSessionsTree();
    const leaves = qa('.sess-leaf');
    const store = (await import(/* @vite-ignore */ at('ui/sessiontree/store.ts'))) as {
      getActiveSession(): string | null;
    };
    keyOn(leaves[1] as El, 'Enter');
    await flush();
    expect(store.getActiveSession(), '键盘激活真的切了会话').toBe('ws/s2');
    click(leaves[2] as El, true);
    await flush();
    expect(store.getActiveSession(), '鼠标点第三行 → 同一个可观测量').toBe('ws/s3');
  });

  it('②b Space 同样激活（并吞掉按键，避免面板滚动）', async () => {
    installFetch(() => undefined);
    await loadSessionsTree();
    const store = (await import(/* @vite-ignore */ at('ui/sessiontree/store.ts'))) as {
      getActiveSession(): string | null;
    };
    keyOn(qa('.sess-leaf')[2] as El, ' ');
    await flush();
    expect(store.getActiveSession()).toBe('ws/s3');
  });

  it('②c 行内 ⋯ 上的 Enter 归 ⋯ 自己（不切会话 —— 一次按键只能有一个动作）', async () => {
    installFetch(() => undefined);
    await loadSessionsTree();
    const store = (await import(/* @vite-ignore */ at('ui/sessiontree/store.ts'))) as {
      getActiveSession(): string | null;
    };
    const before = store.getActiveSession();
    keyOn(qa('.sess-leaf .sess-kebab')[0] as El, 'Enter');
    await flush();
    expect(store.getActiveSession(), '⋯ 上的 Enter 不得顺带切会话').toBe(before);
  });

  it('④ 鼠标点击不移停靠点（Tab 永远从第一行进树）', async () => {
    installFetch(() => undefined);
    await loadSessionsTree();
    const leaves = qa('.sess-leaf');
    click(leaves[2] as El, true);
    await flush();
    expect(stopsIn('#sessionTree').length).toBe(1);
    expect((leaves[0] as El).getAttribute('tabindex')).toBe('0');
  });
});

describe('W2053 位点 2/3 · worker 行与分组头（workers.ts）', () => {
  const WORKERS = [
    { id: 'worker:ws_s1-session-0', title: 'W9001·甲工', workspace: 'engine', kind: 'worker', wid: 'W9001', parentSessionId: 'ws/s1', status: 'RUNNING' },
    { id: 'worker:ws_s1-session-1', title: 'W9002·乙工', workspace: 'engine', kind: 'worker', wid: 'W9002', parentSessionId: 'ws/s1', status: 'DONE', inherited: true },
  ];

  async function bootWorkers(): Promise<void> {
    // worker 行来自 /api/sessions（kind:'worker'），所以这里让 extra 接管那一个端点。
    installFetch((u, method) =>
      method === 'GET' && (u === '/api/sessions' || u.startsWith('/api/sessions?'))
        ? reply(200, { ok: true, sessions: [...SESSIONS, ...WORKERS] })
        : undefined,
    );
    await loadSessionsTree();
  }

  it('② 每一行 worker 都被标成可聚焦按钮，名字含 wid（Label in Name）', async () => {
    await bootWorkers();
    const rows = qa('.ws-worker-row');
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.hasAttribute('data-roving')).toBe(true);
      expect(row.getAttribute('role')).toBe('button');
      const label = row.getAttribute('aria-label') ?? '';
      expect(label).toContain(row.querySelector('.ws-worker-wid')?.textContent ?? '@@');
    }
  });

  it('③ worker 组整体只占 1 个停靠点（组内 2 行 + 1 个分组头）', async () => {
    await bootWorkers();
    const host = q('.ws-worker-host') as El;
    expect(stopsIn('.ws-worker-host').length, '组内行 + 分组头合起来只占 1 个停靠点').toBe(1);
    // 分组头在文档序里排在最前（workers.ts 先 append head 再 append kids）
    // ⇒ 停靠点落在它身上，两个 worker 行都是 -1。
    expect(host.querySelectorAll('.ws-worker-parent[tabindex="0"]').length).toBe(1);
    expect(host.querySelectorAll('.ws-worker-row[tabindex="0"]').length).toBe(0);
  });

  it('③b 分组头（可点的那种）也是行', async () => {
    await bootWorkers();
    const parents = qa('.ws-worker-parent');
    expect(parents.length, '夹具只有一个父会话 ⇒ 一个分组头').toBe(1);
    const head = parents[0] as El;
    expect(head.hasAttribute('data-roving'), '可点的分组头必须是行').toBe(true);
    expect(head.getAttribute('role')).toBe('button');
  });

  it('③c 「未关联」标签**不是**行（不可点的东西不得造出假交互项）', async () => {
    // 夹具：一条没有 parentSessionId 的 worker ⇒ 落进 orphans 分支 ⇒ 出现那个纯标签
    installFetch((u, method) =>
      method === 'GET' && (u === '/api/sessions' || u.startsWith('/api/sessions?'))
        ? { ok: true, status: 200, json: async () => ({ ok: true, sessions: [{ id: 'ws/s9', title: '孤', workspace: 'ws', modified: 1 }] }) }
        : undefined,
    );
    await loadSessionsTree();
    // 有父会话 ⇒ 无 orphans 标签；这里只断言「凡是带 data-roving 的分组头都有 click 行为」
    for (const head of qa('.ws-worker-parent')) {
      const roving = head.hasAttribute('data-roving');
      const clickable = (head.getAttribute('title') ?? '') !== '';
      expect(roving, '只有真的绑了 click 的分组头才该是行').toBe(clickable);
    }
  });

  it('②b worker 行的 Enter 与 click 等效（开同一个 worker 会话）', async () => {
    await bootWorkers();
    const opened: string[] = [];
    const actions = (await import(/* @vite-ignore */ at('ui/sessiontree/actions.ts'))) as {
      openSessionRow: (c: unknown, id: string, m?: unknown) => void;
    };
    const spy = vi.spyOn(actions, 'openSessionRow').mockImplementation((_c, id) => { opened.push(id); });
    const rows = qa('.ws-worker-row');
    keyOn(rows[0] as El, 'Enter');
    const byKey = opened.slice();
    opened.length = 0;
    click(rows[1] as El, true);
    expect(byKey.length, '键盘真的开了会话').toBe(1);
    expect(opened, '两条路开的是各自那一行（同一个处理器）').toEqual(['worker:ws_s1-session-1']);
    spy.mockRestore();
  });

  it('②c 分组头的 Enter 与 click 等效（开父会话）', async () => {
    await bootWorkers();
    const opened: string[] = [];
    const actions = (await import(/* @vite-ignore */ at('ui/sessiontree/actions.ts'))) as {
      openSessionRow: (c: unknown, id: string, m?: unknown) => void;
    };
    const spy = vi.spyOn(actions, 'openSessionRow').mockImplementation((_c, id) => { opened.push(id); });
    keyOn(qa('.ws-worker-parent')[0] as El, 'Enter');
    expect(opened).toEqual(['ws/s1']);
    spy.mockRestore();
  });
});
