// @vitest-environment jsdom
/**
 * 文件管理器 · 点文件 ⇒ **面板内单页**流式打开**完整文件**（W1545 → W9329 重做）。
 *
 * ★ W9329 重做（用户原话：「打开文件，内容**原地**全量呈现」；原型已拍板「打开文件 =
 *   面板内单页：内容原地呈现，「← 树」返回。**不做左右分栏**」）：本文件的**落点**变了
 *   —— 内容不再长在**右侧预览侧栏**的 .preview-body 里，而是长在**文件管理器面板自己**
 *   的 .wb-file 里。
 *
 *   ★ 但**不变量一条没丢**，只是换了承载面（这是本文件改写的全部理由）：
 *     · 内容仍由 GET /api/fs/read 装载、仍非空、仍可见、降级仍可读；
 *     · 仍是**完整**文件（分段取到 truncated=false，不是软上限截断）；
 *     · 仍受**竞态守卫**（晚到的旧文件段落一个字都不许画进新文件）；
 *     · **外壳仍在** .wb-inline / .preview-host 之外的正确位置（就地呈现）。
 *   右侧预览侧栏**仍然存在、仍然可用** —— 它是**另一个入口**（正文里的文件链接、
 *   工具卡的「预览」、F2，见 ui/enhance/file-link.ts）；本文件只钉**文件管理器这一条路**。
 *   那条路另有 tests/w2058-preview-sidebar.test.ts 守着（它守的是侧栏自己的停靠/折叠
 *   行为，不受本轮影响）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flush, reply, resetHarness, type ElLike } from './lib/w795-dom.js';

interface ViewCtxMod { initViewCtx(): unknown; ensurePane(id: string, kind?: string, title?: string): { el: ElLike }; activatePane(id: string, kind?: string, title?: string): unknown; setPaneMeta(id: string, meta: { workspace?: string }): void }
interface WbMod { initWorkbench(): void; openPanel(kind: string, dock?: string): { id: string }; resetPanels(): void }
interface WorkspaceStoreMod { setWsList(v: unknown[]): void }

const rows = (): ElLike[] => Array.from(doc.querySelectorAll('.wb-row')) as ElLike[];
/** ★ W9329：文件正文长在**文件管理器面板自己**的 .wb-file 里（原地呈现）。 */
const bodyText = (): string => (doc.querySelector('.wb-file-code') as ElLike | null)?.textContent ?? '';
const q = (s: string): ElLike | null => doc.querySelector(s) as ElLike | null;
const rowOf = (name: string): ElLike | undefined => rows().find((r) => r.querySelector('.wb-name')?.textContent === name);
const visibleInDom = (node: ElLike | null): boolean => {
  if (!node) return false;
  let n: ElLike | null = node;
  while (n) {
    if (n.classList.contains('hidden')) return false;
    if ((n as unknown as { style?: { display?: string } }).style?.display === 'none') return false;
    n = n.parentElement as ElLike | null;
  }
  return node.isConnected === true;
};

/**
 * 轮询等一个事实成立（上限 5s）。
 *
 * 为什么需要：分段之间会**让出一帧**（requestAnimationFrame，见 preview/stream.ts），
 * 而 jsdom 的 rAF 是按 ~16ms 的宏任务跑的 —— 用固定 flush 猜段数会随机器负载 flake
 * （本仓 W896 的教训：把「猜宏任务数」换成「等事实成立」）。超时上限保证「真的坏了」
 * 依旧快速失败，而不是永远等下去。
 */
async function waitFor(probe: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 造一个「像真服务端」的分页桩：按 offset/limit 切行窗口，末页 truncated=false。 */
function pagedServer(lines: string[], kind: 'text' | 'binary' = 'text'): { fetch: (url: unknown) => Promise<unknown>; calls: string[] } {
  const calls: string[] = [];
  const fetch = async (url: unknown): Promise<unknown> => {
    const u = String(url);
    if (u.includes('/api/fs/list')) {
      const p = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
      return reply(200, { path: p, parent: null, entries: [{ name: 'big.ts', type: 'file', size: 999, mtime: null }, { name: 'src', type: 'dir', size: null, mtime: null }], roots: [], truncated: false });
    }
    if (!u.includes('/api/fs/read')) return reply(200, { ok: true });
    calls.push(u);
    const p = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
    if (kind === 'binary') return reply(200, { path: p, size: 10, kind: 'binary', text: '', offset: 1, limit: 400, totalLines: 0, truncated: false });
    const offset = Number(/[?&]offset=(\d+)/.exec(u)?.[1] ?? '1');
    const limit = Number(/[?&]limit=(\d+)/.exec(u)?.[1] ?? '400');
    const window = lines.slice(offset - 1, offset - 1 + limit);
    const text = window.length === 0 ? '' : window.join('\n') + '\n';
    const more = offset - 1 + window.length < lines.length;
    return reply(200, { path: p, size: 999, kind: 'text', text, offset, limit, totalLines: lines.length, truncated: more });
  };
  return { fetch, calls };
}

/** 装配：真实 viewctx + 真实工作台（面板走真实路径），fetch 打桩。 */
async function setup(fetchImpl: (url: unknown) => Promise<unknown>): Promise<{ wb: WbMod }> {
  const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
  ctxMod.initViewCtx();
  ctxMod.ensurePane('ws/s1', 'session', '甲会话');
  ctxMod.activatePane('ws/s1', 'session', '甲会话');
  ctxMod.setPaneMeta('ws/s1', { workspace: 'celestea_studio-ts' });
  const store = (await import(/* @vite-ignore */ at('ui/sessiontree/store.ts'))) as WorkspaceStoreMod;
  store.setWsList([{ name: 'celestea_studio-ts', path: '/srv/celestea/studio' }]);
  vi.stubGlobal('fetch', fetchImpl);
  const wb = (await import(/* @vite-ignore */ at('ui/workbench/index.ts'))) as WbMod;
  wb.resetPanels();
  wb.initWorkbench();
  return { wb };
}

/** 打开文件管理器并点一个文件（含等待 rAF：分段之间会**让出一帧**）。 */
async function clickFile(wb: WbMod, name: string): Promise<void> {
  wb.openPanel('files', 'right');
  await flush();
  const row = rows().find((r) => r.querySelector('.wb-name')?.textContent === name);
  expect(row, '目录列表里应有 ' + name).not.toBeUndefined();
  row!.dispatchEvent(new Ev('click', { bubbles: true }));
  await flush();
  await new Promise((r) => setTimeout(r, 40));
  await flush();
}

/**
 * 造 N 行「真代码」（有 hljs 认得出的关键字，供高亮断言）。
 *
 * ★ 行**故意写得长**（≈150 字符）：5000 行 ≈ 750 KB，远在 256 KiB 之上。
 *   为什么必须远：断言要能机械抓住「把上限改回 256 KiB」这个变异。若样本只有
 *   280 KB（刚好过线），截断只会发生在**最后一段**，而最后一段的 more=false
 *   本来就会正常收尾 ⇒ 变异跑绿、断言没有判别力（第一版就是这么假绿的，见报告）。
 */
function makeLines(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push('export function fn' + i + '(a: number, b: string, c: boolean): number { const s = "str-' + i + '"; const t = "tail-' + i + '"; return a + s.length + t.length + (c ? 1 : 0); }');
  }
  return out;
}

describe('文件管理器 · 点文件在面板内流式打开完整文件（W1545 → W9329 重做落点）', () => {
  beforeEach(() => {
    resetHarness();
    const btn = doc.createElement('button') as unknown as ElLike;
    btn.id = 'btnWorkbench';
    doc.body.appendChild(btn);
  });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('点文本文件 → 内容在**面板内**、非空、可见；行内展开块不存在', async () => {
    const srv = pagedServer(['# Hello', 'world']);
    const { wb } = await setup(srv.fetch);
    await clickFile(wb, 'big.ts');
    expect(srv.calls.length, '应打 GET /api/fs/read').toBe(1);
    expect(srv.calls[0]).toContain('path=%2Fsrv%2Fcelestea%2Fstudio%2Fbig.ts');
    // ★ W9329：外壳在**面板自己**里（原地呈现），不是右侧预览侧栏、也不是行内展开。
    expect(q('.wb-file'), '★ 文件在面板内呈现（不是跳到别的侧栏）').not.toBeNull();
    expect(visibleInDom(q('.wb-file')), '★ 面板内文件视图必须真的可见').toBe(true);
    expect(bodyText(), '正文非空').toContain('Hello');
    expect(q('.wb-inline'), '行内展开块必须不存在').toBeNull();
    // 「← 树」存在（原型已拍板：单页 + 返回，不做分栏）。
    const back = Array.from(doc.querySelectorAll('.wb-head-btn')).find((b) => (b.textContent ?? '').includes('树'));
    expect(back, '★ 表头有「← 树」').toBeTruthy();
    // ★ 选中态：文件视图态下**目录列表不在 DOM 里**（单页替换），所以选中态只能
    //   在「← 树」回到列表之后看 —— 那时的行带着刚才看过的那个文件（用户回到列表
    //   能一眼看到自己刚在看哪个）。这条不变量与 W1532 那条同源，只是可见时机变了。
    back!.dispatchEvent(new Ev('click', { bubbles: true }));
    await flush(3);
    expect(q('.wb-file'), '返回后离开文件视图').toBeNull();
    expect(rowOf('big.ts')?.classList.contains('sel'), '★ 回到列表时刚才那个文件仍是选中态').toBe(true);
  });

  it('★ 面板壳**当帧**出现：首段读盘还没回来，面板内文件视图已建好', async () => {
    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => { release = r; });
    const { wb } = await setup(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/fs/list')) {
        const p = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
        return reply(200, { path: p, parent: null, entries: [{ name: 'slow.ts', type: 'file', size: 10, mtime: null }], roots: [], truncated: false });
      }
      if (u.includes('/api/fs/read')) { await held; return reply(200, { path: '', size: 1, kind: 'text', text: 'x\n', offset: 1, limit: 400, totalLines: 1, truncated: false }); }
      return reply(200, { ok: true });
    });
    wb.openPanel('files', 'right');
    await flush();
    rowOf('slow.ts')!.dispatchEvent(new Ev('click', { bubbles: true }));
    // ★ 不 await：读盘仍被扣住。面板内的文件视图必须**已经**在 DOM 里。
    expect(q('.wb-file'), '★ 读盘未返回时面板内视图就必须建好（壳先出）').not.toBeNull();
    expect(q('.wb-subhead .wb-head-path')?.textContent, '路径当帧就位').toBe('/srv/celestea/studio/slow.ts');
    expect(bodyText(), '此刻还没有文件内容').not.toContain('x');
    release!();
    await flush();
    await new Promise((r) => setTimeout(r, 40));
    await flush();
    expect(bodyText(), '首段落地后正文出现').toContain('x');
  });

  /**
   * ★ 高亮生效的**结构**前提。
   *
   * 真 bug（用户原话「原地展开的文件还没有高亮」）：hljs 的颜色**全部**作用域限定在
   * `.rendered` 下（components.css 的 `.rendered .hljs-keyword { color: … }`）。
   * W1532 的内联块是 `el('div', 'wb-inline-content')` —— **没有** .rendered，
   * 于是 hljs 的 class 都加上了、颜色一条都不命中（类在、色不在）。
   * ★ W9329：面板内的正文容器是 .wb-file-code，它**也**必须落在高亮的作用域里，
   *   否则会把同一个 bug 原样带进新面板 —— 这条断言就是防它的。
   */
  it('★ 高亮：内容容器在 hljs 的作用域内，且 hljs 真的把 token 标出来了', async () => {
    // ★ 样本必须让**首段**就超过 hljs 的 32 KB 单块上限，否则「每段再切块」没被考到。
    const srv = pagedServer(makeLines(500));
    const { wb } = await setup(srv.fetch);
    await clickFile(wb, 'big.ts');
    await waitFor(() => doc.querySelectorAll('.wb-line').length > 0, 'the lines to land');
    // 面板内正文落在 .rendered 祖先内（hljs 的颜色规则只认这个作用域）。
    const code = q('.wb-file-code');
    expect(code, '面板内正文存在').not.toBeNull();
    expect(code!.closest('.rendered') ?? doc.querySelector('.rendered .wb-file-code'), '★ 正文必须落在 .rendered 作用域内').not.toBeNull();
    // ★ 真 hljs：必须真的产出 .hljs-keyword（否则就是 W1532 那个「类在、色不在」/
    //   「一个字都不高亮」的 bug 换了个面板重演）。type 文件里 export/function/const
    //   都是 keyword。
    const kw = q('.wb-file-code .hljs-keyword');
    expect(kw, '★ 面板内正文必须真的高亮出 .hljs-keyword').not.toBeNull();
    expect(kw!.closest('.rendered'), '★ token 在 .rendered 祖先之内（颜色才命中）').not.toBeNull();
  });

  it('binary → 可读降级原因（不白屏）', async () => {
    const srv = pagedServer([], 'binary');
    const { wb } = await setup(srv.fetch);
    await clickFile(wb, 'big.ts');
    await waitFor(() => (q('.wb-file-foot')?.textContent ?? '').length > 0, 'degrade reason');
    expect(bodyText().length + (q('.wb-file-foot')?.textContent ?? '').length, '降级原因不能为空').toBeGreaterThan(0);
  });

  it('读取失败（4xx）→ 可读降级原因', async () => {
    const { wb } = await setup(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/fs/list')) {
        const p = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
        return reply(200, { path: p, parent: null, entries: [{ name: 'big.ts', type: 'file', size: 10, mtime: null }], roots: [], truncated: false });
      }
      if (u.includes('/api/fs/read')) return reply(400, { error: 'not a regular file' });
      return reply(200, { ok: true });
    });
    await clickFile(wb, 'big.ts');
    await waitFor(() => (q('.wb-file-foot')?.textContent ?? '').length > 0, 'degrade reason');
    expect((q('.wb-file-foot')?.textContent ?? '').length, '降级原因不能为空').toBeGreaterThan(0);
  });

  /**
   * W1545 **竞态守卫**：先点那个文件的**首段**可能后到。它绝不能被画进后点那个
   * 文件的面板里 —— 那正是「内容串了」这个 bug 的形态。
   *
   * ★ W9329：走法变了（单页设计）。文件视图会**替换**目录列表，所以「连点两个文件」
   *   在 UI 上不再可能；真实路径是 A（首段被扣住）→ 点「← 树」→ 点 B。
   *   **不变量一字未改**：A 的晚到段落一个字都不许进 B 的面板。守卫仍是 panel 的
   *   seq（每次导航/打开取新 seq），所以这条路径照样把它考到。
   */
  it('竞态：先点文件的晚到段落不得覆盖后点文件的内容', async () => {
    const gate: Array<() => void> = [];
    const { wb } = await setup(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/fs/list')) {
        const p = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
        return reply(200, { path: p, parent: null, entries: [{ name: 'A.ts', type: 'file', size: 10, mtime: null }, { name: 'B.ts', type: 'file', size: 10, mtime: null }], roots: [], truncated: false });
      }
      if (u.includes('/api/fs/read')) {
        const p = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
        if (p.endsWith('A.ts')) {
          await new Promise<void>((res) => gate.push(res)); // 扣住 A
          return reply(200, { path: p, size: 10, kind: 'text', text: 'CONTENT-A\n', offset: 1, limit: 400, totalLines: 1, truncated: false });
        }
        return reply(200, { path: p, size: 10, kind: 'text', text: 'CONTENT-B\n', offset: 1, limit: 400, totalLines: 1, truncated: false });
      }
      return reply(200, { ok: true });
    });
    wb.openPanel('files', 'right');
    await flush();
    rowOf('A.ts')!.dispatchEvent(new Ev('click', { bubbles: true })); // 打开 A（首段被扣住）
    await flush();
    // 回到树（文件视图态下列表不在 DOM 里，这是单页设计的走法）。
    const back = Array.from(doc.querySelectorAll('.wb-head-btn')).find((b) => (b.textContent ?? '').includes('树')) as ElLike;
    back.dispatchEvent(new Ev('click', { bubbles: true }));
    await flush();
    expect(rowOf('B.ts'), '回到树后能看到 B').not.toBeUndefined();
    rowOf('B.ts')!.dispatchEvent(new Ev('click', { bubbles: true })); // 改点 B（立即返回）
    await flush();
    await new Promise((r) => setTimeout(r, 40));
    await flush();
    expect(bodyText(), 'B 的内容先落地').toContain('CONTENT-B');
    gate.forEach((res) => res()); // 放行 A 的晚到响应
    await flush();
    await new Promise((r) => setTimeout(r, 40));
    await flush();
    expect(bodyText(), '★ A 的晚到内容不得串进 B 的面板').toContain('CONTENT-B');
    expect(bodyText(), '★ A 的内容一个字都不许出现').not.toContain('CONTENT-A');
  });
});

/** 目录导航与「点文件」是两条路：进入目录**不得**读文件、不得开文件视图。 */
describe('文件管理器 · 点目录仍然进入目录（W1545）', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('进入目录（不打开文件视图、不读文件）', async () => {
    const srv = pagedServer(['x']);
    const { wb } = await setup(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/fs/list')) {
        const p = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
        if (p.endsWith('/src')) return reply(200, { path: p, parent: '/srv/celestea/studio', entries: [{ name: 'main.ts', type: 'file', size: 10, mtime: null }], roots: [], truncated: false });
        return reply(200, { path: p, parent: null, entries: [{ name: 'src', type: 'dir', size: null, mtime: null }], roots: [], truncated: false });
      }
      return srv.fetch(url);
    });
    wb.openPanel('files', 'right');
    await flush();
    const dirRow = rows().find((r) => r.querySelector('.wb-name')?.textContent === 'src')!;
    dirRow.dispatchEvent(new Ev('click', { bubbles: true }));
    await flush();
    await new Promise((r) => setTimeout(r, 20));
    await flush();
    expect(q('.wb-crumb-cur')?.textContent).toBe('/srv/celestea/studio/src');
    expect(rows().map((r) => r.querySelector('.wb-name')?.textContent)).toEqual(['main.ts']);
    expect(srv.calls.length, '进入目录不得读文件').toBe(0);
  });
});
