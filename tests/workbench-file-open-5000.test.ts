// @vitest-environment jsdom
/**
 * 文件管理器 · 点文件 ⇒ **面板内单页**流式打开**完整文件**（W1545 → W9329 重做落点）。
 *
 * ★ W9220（测试提速）：本文件是原 ~tests/workbench-file-open.test.ts~ 里那条
 *   「完整文件：5000 行（> 256 KiB）必须全文渲染」用例的**独立文件**。
 *   为什么单开：那条用例本机实测单条 **11.3s**（5000 行 × ≈150 字符 = 750 KB 走
 *   分段流式 + hljs 分块高亮），而 vitest 以**文件**为调度单位 —— 它原本会把
 *   同文件其余 8 条（合计约 2s）拖在同一 worker 里串行等待。拆开后两条并行。
 *
 * ★ W9329 重做（用户原话：「打开文件，内容**原地**全量呈现」；原型已拍板「打开文件 =
 *   面板内单页：内容原地呈现，「← 树」返回。**不做左右分栏**」）：**落点**从右侧预览
 *   侧栏的 .preview-body 换成了文件管理器面板自己的 .wb-file。
 *
 *   ★ 不变量一条没丢，只是换了承载面（这是本文件改写的全部理由）：
 *     · 内容仍由 GET /api/fs/read 装载、**逐字节等于完整文件**（最强的那条）；
 *     · 仍是**完整**文件（分段取到 truncated=false，绝不降级成「文件过大」）；
 *     · 仍然**分段取**（不止一次往返），首段 limit=400（首屏快）、后续 1200（往返少）；
 *     · DOM 行数 == 服务端 totalLines。
 *   判别力仍在：把 cap 改回 256 KiB ⇒ 「完整文件」红；把点击改成不打开 ⇒ 行数 0 红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flush, reply, resetHarness, type ElLike } from './lib/w795-dom.js';

interface ViewCtxMod { initViewCtx(): unknown; ensurePane(id: string, kind?: string, title?: string): { el: ElLike }; activatePane(id: string, kind?: string, title?: string): unknown; setPaneMeta(id: string, meta: { workspace?: string }): void }
interface WbMod { initWorkbench(): void; openPanel(kind: string, dock?: string): { id: string }; resetPanels(): void }
interface WorkspaceStoreMod { setWsList(v: unknown[]): void }

const rows = (): ElLike[] => Array.from(doc.querySelectorAll('.wb-row')) as ElLike[];
const q = (s: string): ElLike | null => doc.querySelector(s) as ElLike | null;
/**
 * 面板内正文的**全文**（按 DOM 序把每行的文本列拼回来 = 面板里真正显示的文件内容）。
 * ★ 每个 .wb-line 自带行号列与文本列，所以「全文」= 文本列按 \n 连接 + 末尾 \n。
 *   （旧口径是拼 .preview-code code 的段块；段块天然带 \n，本形态每行一个节点。）
 */
const shownText = (): string => {
  const txs = Array.from(doc.querySelectorAll('.wb-file-code .wb-line-tx')).map((c) => c.textContent ?? '');
  return txs.length === 0 ? '' : txs.join('\n') + '\n';
};
const shownLines = (): number => doc.querySelectorAll('.wb-file-code .wb-line').length;
const footText = (): string => q('.wb-file-foot')?.textContent ?? '';

/**
 * 流式装载的**停滞预算**（不是总预算）。
 *
 * 判据是「有没有进展」，不是「总共花了多久」—— 这是本文件与墙钟预算的分水岭：
 *   · 慢但一直在长（机器被别的 worker 挤住）⇒ **不算失败**，继续等；
 *   · 卡住不动（真的坏了，例如上限被改回 256 KiB ⇒ 流在 ~1600 行处停死）⇒ 到点即红。
 * 30s 与改动前的总预算**同值**，所以「真的坏了多久才红」这条性质一字未变；
 * 变的只是它现在**只对停滞计时**，不再对正常耗时计时。
 */
const STREAM_STALL_MS = 30_000;
/**
 * 兜底上限：防「永远在长、永远长不到头」这种病态（每 29s 长一行）。
 * 取实测最坏合法总耗时的 ~4 倍（W2035 实测：空闲 9.5s；12 路争用下 20.5–29.0s）。
 */
const STREAM_CEILING_MS = 120_000;

/** 等「分段流式装载真的读完」：判据是**进展**，不是墙钟（理由同上）。 */
async function waitForFullStream(
  progress: () => number,
  target: number,
  stallMs = STREAM_STALL_MS,
  ceilingMs = STREAM_CEILING_MS,
): Promise<void> {
  const started = Date.now();
  let best = progress();
  let bestAt = Date.now();
  for (;;) {
    const seen = progress();
    if (seen >= target) return;
    if (seen > best) {
      best = seen;
      bestAt = Date.now();
    }
    const stalled = Date.now() - bestAt;
    if (stalled > stallMs) {
      // 报出**卡在第几行**：比「超时」有用得多（直接分辨「没开始」与「读一半停住」）。
      throw new Error('stream stalled at ' + best + '/' + target + ' lines (no progress for ' + stalled + 'ms, ' + (Date.now() - started) + 'ms total)');
    }
    if (Date.now() - started > ceilingMs) {
      throw new Error('stream never finished: ' + best + '/' + target + ' lines after ' + (Date.now() - started) + 'ms');
    }
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
function makeLines(n: number, pad = 0): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push('export function fn' + i + '(a: number, b: string, c: boolean): number { const s = "str-' + i + '"; const t = "tail-' + i + '"; return a + s.length + t.length + (c ? 1 : 0); }' + (pad > 0 ? ' // ' + 'x'.repeat(pad) : ''));
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
  // ★ W2035：文件级预算 150s（**只给这一条**，不动全局 testTimeout）。
  //   它是兜底，不是判据 —— 先触发的一定是 waitForFullStream 的停滞判据（30s 无进展）。
  it('★ 完整文件：2100 行 × ≈320 字符（≈672 KB，> 256 KiB）必须**全文**渲染，且不是降级文案', { timeout: 150_000 }, async () => {
    const lines = makeLines(2100, 170); // ★ 2100 行 × ≈320 字符 ≈ 672 KB：**行数必须 > 2000**（否则 `files-view` 的「整篇/流式」判据会把它当整篇打开，就不是这条用例要守的流式了），字节仍 > 600 KiB（变异判别力）。比原先的 5000 行少 58% 的 DOM 行。
    const expected = lines.join('\n') + '\n';
    expect(expected.length, '★ 样本必须**远**超过旧的 256 KiB 上限（否则变异抓不住，见 makeLines 注释）').toBeGreaterThan(600 * 1024);
    const srv = pagedServer(lines);
    const { wb } = await setup(srv.fetch);
    await clickFile(wb, 'big.ts');
    // ★ W2035：等「全文渲染完成」，判据是**进展**不是墙钟（见 waitForFullStream 的长注释）。
    await waitForFullStream(() => shownLines(), 2100);
    // ★ 不降级：页脚不许出现「上限」那句（chat.preview.streamLimit 的文案）。
    expect(footText(), '★ 不许降级成「文件超过预览上限」').not.toContain('上限');
    expect(shownLines(), '★ DOM 行数必须等于服务端 totalLines').toBe(2100);
    expect(shownText(), '★ 逐字节等于完整文件').toBe(expected);
    // ★ 页脚**如实**：流式进度必须报「全部到手」，而不是停在中途。
    expect(footText(), '★ 页脚如实报告读满').toContain('已加载 2100 / 共 2100');
    expect(srv.calls.length, '分段取（不止一次往返）').toBeGreaterThan(1);
    expect(srv.calls[0], '首段用**小** limit（首屏快）').toContain('limit=400');
    expect(srv.calls[1], '后续段用大 limit（往返少）').toContain('limit=1200');
  });
});
