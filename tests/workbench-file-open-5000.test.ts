// @vitest-environment jsdom
/**
 * 文件管理器 · 点文件 ⇒ **右侧预览面板**流式打开**完整文件**（W1545）。
 *
 * ★ W9220（测试提速）：本文件是原 ~tests/workbench-file-open.test.ts~ 里那条
 *   「完整文件：5000 行（> 256 KiB）必须全文渲染」用例的**独立文件**。
 *   用例正文与断言**逐字未动**，共享夹具（~pagedServer~/~setup~/~clickFile~/~makeLines~）
 *   也逐字复制自原文件 —— 只改了文件归属。
 *   为什么单开：那条用例本机实测单条 **11.3s**（5000 行 × ≈150 字符 = 750 KB 走
 *   分段流式 + hljs 分块高亮），而 vitest 以**文件**为调度单位 —— 它原本会把
 *   同文件其余 8 条（合计约 2s）拖在同一 worker 里串行等待。拆开后两条并行。
 *
 * ★ W1545（用户原话：「文件管理器打开文件应该直接渲染完整的文件（流式打开巨文件）
 *   而不是直接原地展开，且原地展开的文件还没有高亮」+「右侧的预览是应该几乎瞬时
 *   出现的」）：本文件的断言是**有意更新**的（架构师批准）。旧断言钉的是 W1532 的
 *   「内容在文件行下方的 .wb-inline 里」—— 那个交互被用户点名删掉了。新断言是同
 *   一条不变量换一个落点：
 *     · 内容仍由 GET /api/fs/read 装载、仍非空、仍可见、降级仍可读；
 *     · 但它现在长在**右侧预览面板**的 .preview-body 里（.wb-inline 必须不存在）；
 *     · 并且是**完整**文件（分段取到 truncated=false，不是 256 KiB 截断/降级）；
 *     · 面板壳**当帧**出现（不等第一次读盘返回）。
 *   判别力由变异负控制证明（见 results/W1545-preview-stream.md「变异负控制」一节）：
 *   把 cap 改回 256 KiB ⇒ 「完整文件」红；把点击改回不打开面板 ⇒ 「面板打开」红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flush, reply, resetHarness, type ElLike } from './lib/w795-dom.js';

interface ViewCtxMod { initViewCtx(): unknown; ensurePane(id: string, kind?: string, title?: string): { el: ElLike }; activatePane(id: string, kind?: string, title?: string): unknown; setPaneMeta(id: string, meta: { workspace?: string }): void }
interface WbMod { initWorkbench(): void; openPanel(kind: string, dock?: string): { id: string }; resetPanels(): void }
interface WorkspaceStoreMod { setWsList(v: unknown[]): void }

const rows = (): ElLike[] => Array.from(doc.querySelectorAll('.wb-row')) as ElLike[];
/** 预览面板的正文（W1545：内容长在这里，不再在文件行下方的 .wb-inline 里）。 */
const q = (s: string): ElLike | null => doc.querySelector(s) as ElLike | null;
/** 分段块的全文（按 DOM 序拼接 = 面板里真正显示的文件内容）。 */
const shownText = (): string =>
  Array.from(doc.querySelectorAll('.preview-code code')).map((c) => c.textContent ?? '').join('');
const shownLines = (): number => {
  const s = shownText();
  if (s === '') return 0;
  const n = s.split('\n').length;
  return s.endsWith('\n') ? n - 1 : n;
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
  store.setWsList([{ name: 'celestea_studio-ts', path: '/src/celestea_studio-ts' }]);
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
describe('文件管理器 · 点文件在右侧预览里流式打开（W1545）', () => {
  beforeEach(() => {
    resetHarness();
    const btn = doc.createElement('button') as unknown as ElLike;
    btn.id = 'btnWorkbench';
    doc.body.appendChild(btn);
  });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });
  it('★ 完整文件：5000 行（> 256 KiB）必须**全文**渲染，且不是降级文案', async () => {
    const lines = makeLines(5000);
    const expected = lines.join('\n') + '\n';
    expect(expected.length, '★ 样本必须**远**超过旧的 256 KiB 上限（否则变异抓不住，见 makeLines 注释）').toBeGreaterThan(600 * 1024);
    const srv = pagedServer(lines);
    const { wb } = await setup(srv.fetch);
    await clickFile(wb, 'big.ts');
    await waitFor(() => shownLines() === 5000, 'the stream to finish (5000 lines)');
    expect(q('.preview-degrade'), '★ 不许降级成「文件过大」').toBeNull();
    expect(shownLines(), '★ DOM 行数必须等于服务端 totalLines').toBe(5000);
    expect(shownText(), '★ 逐字节等于完整文件').toBe(expected);
    expect(srv.calls.length, '分段取（不止一次往返）').toBeGreaterThan(1);
    expect(srv.calls[0], '首段用**小** limit（首屏快）').toContain('limit=400');
    expect(srv.calls[1], '后续段用大 limit（往返少）').toContain('limit=1200');
  });
});
