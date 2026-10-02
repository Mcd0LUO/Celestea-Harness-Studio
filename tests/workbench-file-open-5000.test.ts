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

/**
 * 等「分段流式装载真的读完」：判据是**进展**，不是墙钟。
 *
 * 为什么需要轮询：分段之间会**让出一帧**（requestAnimationFrame，见 preview/stream.ts），
 * 而 jsdom 的 rAF 是按 ~16ms 的宏任务跑的 —— 用固定 flush 猜段数会随机器负载 flake
 * （本仓 W896 的教训：把「猜宏任务数」换成「等事实成立」）。
 *
 * ★ 为什么不再用「总预算 30s」（W2035 修的就是它）：
 *   本用例的**语义**是「5000 行（>256 KiB）必须**全文**渲染」，与耗时无关；耗时却
 *   完全由宿主争用决定（W2035 实测：空闲 9.5s；12 路争用 20.5–29.0s；再挤 >30s）。
 *   拿总耗时当闸门 ⇒ 机器一忙就红，且报错与断言无关（负载下抓到的是
 *   `Test timed out in 30000ms`，不是任何一条断言失败）。
 *   ⇒ 让**阈值**让步、**语义**不让步：断言一字未改，只把「多久算坏」从墙钟换成停滞。
 */
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
  // ★ W2035：文件级预算 150s（**只给这一条**，不动全局 testTimeout）。
  //   它是兜底，不是判据 —— 先触发的一定是 waitForFullStream 的停滞判据（30s 无进展）；
  //   150s 只为「一直在长但长不到头」这种病态兜底，且远大于实测最坏合法耗时（29.0s）。
  it('★ 完整文件：5000 行（> 256 KiB）必须**全文**渲染，且不是降级文案', { timeout: 150_000 }, async () => {
    const lines = makeLines(5000);
    const expected = lines.join('\n') + '\n';
    expect(expected.length, '★ 样本必须**远**超过旧的 256 KiB 上限（否则变异抓不住，见 makeLines 注释）').toBeGreaterThan(600 * 1024);
    const srv = pagedServer(lines);
    const { wb } = await setup(srv.fetch);
    await clickFile(wb, 'big.ts');
    // ★ W2035：等「全文渲染完成」，判据是**进展**不是墙钟（见 waitForFullStream 的长注释）。
    //   负载下这条用例合法地要 20.5–29.0s（12 路争用实测），而 vitest 的 30s testTimeout
    //   是**文件级**的墙钟预算 —— 于是机器一忙就报 `Test timed out in 30000ms`。
    //   断言一字未改；改的只是「多久算坏」。文件级预算同步抬到 150s（下面 it 的第三参），
    //   让停滞判据（30s 无进展）成为**先**触发的那个，而不是被 vitest 抢答。
    await waitForFullStream(() => shownLines(), 5000);
    expect(q('.preview-degrade'), '★ 不许降级成「文件过大」').toBeNull();
    expect(shownLines(), '★ DOM 行数必须等于服务端 totalLines').toBe(5000);
    expect(shownText(), '★ 逐字节等于完整文件').toBe(expected);
    expect(srv.calls.length, '分段取（不止一次往返）').toBeGreaterThan(1);
    expect(srv.calls[0], '首段用**小** limit（首屏快）').toContain('limit=400');
    expect(srv.calls[1], '后续段用大 limit（往返少）').toContain('limit=1200');
  });
});
