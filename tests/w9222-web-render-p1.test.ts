// @vitest-environment jsdom
// ============================================================================
// tests/w9222-web-render-p1.test.ts — W9222：W9201 审计的 5 条未修 P1 的机械门禁。
//
// 覆盖（每条都有「改回缺陷形态即变红」的变异负控制，逐条实测见报告）：
//   F-05 恢复窗口期到达的 live 思考帧被 replaceChildren 连同旧 DOM 一起丢弃；
//   F-06 restoreSessionHistory 在 guard/streaming 中止时不回滚已发生的副作用
//        （rail 被清、restoreOps 被清、histToolStep 归零）；
//   F-07 ctx.restored 在收尾步骤**之前**置位且无失败回退 ⇒ 失败会话永远不再恢复；
//   F-11 容器整体重建（renderEmptyHint / resetMessages）不清思考账本 ⇒ 新段被误回收；
//   F-12 pruneThinkBudget 只对 doomed 里的列减账，被摘列的**嵌套子树**漏减 ⇒ 账本偏高。
//
// 为什么断言这些**具体**形状：W9201 的审计结论是「既有三条 W9113 门禁全绿但结构上
// 抓不到这些缺陷」（其 F-23）—— 本文件补的正是那些夹具形态。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness } from './lib/w795-dom.js';

interface El {
  className: string;
  textContent: string | null;
  hidden: boolean;
  appendChild(n: unknown): unknown;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): ArrayLike<El>;
}
interface Pane {
  id: string;
  el: El;
  hint: El;
  streaming: boolean;
  restored: boolean;
  restoreOps: Map<string, unknown>;
  histToolStep: number;
}
interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, k?: string, t?: string): Pane;
  activatePane(id: string, k?: string, t?: string): unknown;
}
interface MsgMod {
  appendThinking(ctx: unknown, delta: string): void;
  thinkRetained(container: El): number;
  buildThinkSeg(o?: { text?: string; collapsed?: boolean }): { root: El; text: string; dropped: number };
  noteRestoredThinkingBatch(container: El, segs: unknown[]): void;
  renderEmptyHint(ctx: unknown): void;
  addUserMessage(ctx: unknown, text: string): unknown;
}
interface CapMod {
  MAX_DOM_COLS: number;
  prunePaneDom(ctx: unknown, force?: boolean): number;
  pruneThinkBudget(ctx: unknown, doomed: El[]): number;
}
interface RestoreMod {
  restoreSessionHistory(pane: unknown, guard?: () => boolean): Promise<void>;
  openSession(id: string): unknown;
}

/** 一条历史行（内容任意，这里只关心条数与 role 分布）。 */
const historyRow = (i: number): Record<string, unknown> =>
  i % 3 === 0
    ? { role: 'assistant', content: '回答 ' + i }
    : { role: 'user', content: '提问 ' + i };

/** 100 条历史 ⇒ 触发 3 片（RESTORE_CHUNK=40），保证片间至少让出一次事件循环。 */
const history = (n = 100): { messages: unknown[] } => ({
  messages: Array.from({ length: n }, (_, i) => historyRow(i)),
});

function stubHistory(n = 100): void {
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => history(n) }));
}

/**
 * 装配一个聚焦会话。`withRail` 时额外 initRail()（幂等）—— F-06 的长条断言需要它：
 * railAdd 在 mainEl 为 null 时**直接 return**（[railAdd] 的第一行守卫），不装配就永远没有长条。
 */
async function bootPane(id: string, withRail = false): Promise<{ pane: Pane; V: ViewCtxMod }> {
  const V = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
  V.initViewCtx();
  const pane = V.ensurePane(id, 'session', '甲会话');
  V.activatePane(id, 'session', '甲会话');
  if (withRail) {
    // initRail 用 ResizeObserver 观察容器；jsdom 不提供它（与 w9113-frame-budget 同款打桩）。
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
    const rail = (await import(/* @vite-ignore */ at('ui/rail.ts'))) as { initRail(): void };
    rail.initRail();
  }
  return { pane, V };
}

describe('W9222 · F-05 恢复窗口期到达的 live 思考帧必须保住', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('分片让出期间 appendThinking 的正文随历史一起进入最终 DOM', async () => {
    const { pane } = await bootPane('ws/f05');
    const restore = (await import(/* @vite-ignore */ at('ui/restore.ts'))) as RestoreMod;
    const M = (await import(/* @vite-ignore */ at('ui/messages.ts'))) as MsgMod;
    stubHistory(100);

    const running = restore.restoreSessionHistory(pane);
    // 让出一次：恢复已进入第二片的 await，第一片已渲染进**离屏**容器。
    await new Promise((r) => setTimeout(r, 0));
    // 模拟 SSE thinking 帧在恢复窗口期到达（live 不因恢复而暂停）。
    M.appendThinking(pane, 'LIVE-DELTA');
    await running;

    // ★ 主断言：改动前这里是 false —— live 段随旧 DOM 被 replaceChildren 丢弃。
    expect(pane.el.textContent, '恢复窗口期到达的 live 思考正文不得丢').toContain('LIVE-DELTA');
    expect(pane.el.querySelectorAll('.msg.think-seg').length, 'live 思考段仍应存在').toBe(1);
  });
});

describe('W9222 · F-06 恢复中止必须回滚已发生的副作用', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('片间 guard 变假：restoreOps / histToolStep / 长条都必须还原，不得被清空', async () => {
    const { pane } = await bootPane('ws/f06', true);
    const restore = (await import(/* @vite-ignore */ at('ui/restore.ts'))) as RestoreMod;
    const railState = (await import(/* @vite-ignore */ at('ui/rail-state.ts'))) as {
      barCountOf(ctx: unknown): number;
    };
    stubHistory(100);

    // ① 先做一次**成功**的恢复：把旧 DOM 与对应的长条都建起来（长条由 railAdd 在
    //    离屏渲染时登记，见 user.ts / assistant.ts 的调用点）。
    await restore.restoreSessionHistory(pane);
    const barsBefore = railState.barCountOf(pane);
    expect(barsBefore, '前提：成功恢复后长条已建立').toBeGreaterThan(0);

    // ② 再留一笔「迟到 result 回填索引」与步数（真实会话里本就非空）。
    const keptRef = { marker: 'kept' };
    pane.restoreOps.set('call_kept', keptRef);
    pane.histToolStep = 7;

    // ③ 第 1 次 guard（入口）放行，第 2 次（片间）返回 false —— 与真实竞态同形，
    //    且不依赖任何时序（纯计数），因此不会 flake。
    let calls = 0;
    const guard = (): boolean => {
      calls += 1;
      return calls < 2;
    };
    await restore.restoreSessionHistory(pane, guard);
    expect(calls, '守卫必须真的被问到第二次（片间）').toBeGreaterThanOrEqual(2);

    // ★ 主断言 1：改动前 restoreOps.clear() 已执行且不回滚 ⇒ 这里为 undefined。
    expect(pane.restoreOps.get('call_kept'), '中止不得清掉迟到 result 的回填索引').toBe(keptRef);
    // ★ 主断言 2：改动前 histToolStep=0 已执行且不回滚 ⇒ 这里为 0。
    expect(pane.histToolStep, '中止不得把历史工具步数归零').toBe(7);
    // ★ 主断言 3：改动前 railReset 已执行且不回滚 ⇒ 长条整批消失（0）。
    expect(railState.barCountOf(pane), '中止不得把该会话的长条清空').toBe(barsBefore);
  });
});

describe('W9222 · F-07 restored 只能在收尾全部成功之后置位', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('收尾步骤抛错：Promise reject 但 restored 必须仍为 false，且切回可重试', async () => {
    const { pane } = await bootPane('ws/f07');
    const restore = (await import(/* @vite-ignore */ at('ui/restore.ts'))) as RestoreMod;
    stubHistory(20);
    // 先清掉 activatePane 排下的 rAF（它会在测试结束后写 scrollTop，撞上下面的毒 setter）。
    // 走 globalThis 取 rAF：本文件在 jsdom 环境跑，但根 tsconfig 的 lib 只有 ES2023
    // （无 DOM），直接写 requestAnimationFrame 会让 root typecheck 报 TS2304。
    const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => void }).requestAnimationFrame;
    await new Promise((r) => { if (raf) raf(() => r(null)); else r(null); });

    // 收尾的 autoscroll 会写 ctx.el.scrollTop —— 让它抛错，模拟「收尾任一步失败」。
    // （jsdom 允许遮蔽 scrollTop 访问器；实测 setter 抛出后 restore 的 Promise reject。）
    Object.defineProperty(pane.el, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set: () => { throw new Error('boom-autoscroll'); },
    });
    try {
      await expect(restore.restoreSessionHistory(pane), '失败必须如实 reject').rejects.toThrow('boom-autoscroll');
      // ★ 主断言：改动前 restored 在 autoscroll **之前**就置了 true ⇒ 这里为 true。
      expect(pane.restored, '收尾失败不得把会话标成「已恢复」').toBe(false);

      // 行为面：restored 为 false ⇒ 再切回该会话会重新拉历史（而不是永久停在半成品）。
      let fetches = 0;
      vi.stubGlobal('fetch', async () => {
        fetches += 1;
        return { ok: true, status: 200, json: async () => history(20) };
      });
      restore.openSession(pane.id);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(fetches, '未标已恢复 ⇒ 切回必须重试历史恢复').toBeGreaterThan(0);
    } finally {
      // 撤掉毒 setter，别把污染留给后续用例 / rAF（本仓要求测试自净）。
      delete (pane.el as unknown as { scrollTop?: number }).scrollTop;
    }
  });
});

describe('W9222 · F-11 容器整体重建必须同时复位思考账本', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('renderEmptyHint 之后账本归零，且新思考段不被误回收', async () => {
    const { pane } = await bootPane('ws/f11');
    const M = (await import(/* @vite-ignore */ at('ui/messages.ts'))) as MsgMod;

    // 先攒一笔账本（300K > THINK_RENDER_LIMIT ⇒ 单段钳到 64K，账本记 65536）。
    M.appendThinking(pane, 'x'.repeat(300000));
    expect(M.thinkRetained(pane.el), '前提：账本已被记入').toBeGreaterThan(0);

    // = 清空会话后前端实际走的重建路径（scroll.ts 的 replaceChildren）。
    M.renderEmptyHint(pane);
    // ★ 主断言 1：改动前这里是 65536（账本键是容器对象，不随子节点一起被 GC）。
    expect(M.thinkRetained(pane.el), '重建后账本必须归零').toBe(0);

    // ★ 主断言 2：新段必须完整显示 —— 改动前账本偏高会把**新段**当最旧的误回收。
    M.appendThinking(pane, 'y'.repeat(1000));
    expect(pane.el.querySelector('.think-seg-body')?.textContent, '新段不得被误回收').toBe('y'.repeat(1000));
    expect(M.thinkRetained(pane.el), '新段账本 = 新段长度').toBe(1000);
  });
});

describe('W9222 · F-12 摘列的**嵌套子树**也要减账', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('pruneThinkBudget 对 doomed 的嵌套 .mcol 一并减账（不双倍、不漏减）', async () => {
    const { pane } = await bootPane('ws/f12a');
    const M = (await import(/* @vite-ignore */ at('ui/messages.ts'))) as MsgMod;
    const cap = (await import(/* @vite-ignore */ at('ui/messages/dom-cap.ts'))) as CapMod;

    // 复刻 W1467 的 run_code 子调用树：顶层 .mcol > .toolcard-subs > 子 .mcol（思考段）。
    const parent = doc.createElement('div');
    parent.className = 'mcol';
    const subs = doc.createElement('div');
    subs.className = 'toolcard-subs';
    const seg = M.buildThinkSeg({ text: 'z'.repeat(500), collapsed: true });
    (subs as unknown as { appendChild(n: unknown): unknown }).appendChild(seg.root);
    (parent as unknown as { appendChild(n: unknown): unknown }).appendChild(subs);
    pane.el.appendChild(parent);
    M.noteRestoredThinkingBatch(pane.el, [seg]);
    expect(M.thinkRetained(pane.el)).toBe(500);

    // doomed 只含**顶层**父列 —— 嵌套思考列随父列一起离开文档，却不在 doomed 里。
    const released = cap.pruneThinkBudget(pane, [parent]);
    // ★ 主断言：改动前 released = 0、账本停在 500（子列的账没减）。
    expect(released, '嵌套子列的保留量必须被减掉').toBe(500);
    expect(M.thinkRetained(pane.el), '账本必须与「真正离开容器的段」一致').toBe(0);
  });

  it('真实 prunePaneDom 路径：边界切在父列上时账本收敛到 0', async () => {
    const { pane } = await bootPane('ws/f12b');
    const M = (await import(/* @vite-ignore */ at('ui/messages.ts'))) as MsgMod;
    const cap = (await import(/* @vite-ignore */ at('ui/messages/dom-cap.ts'))) as CapMod;

    // 父列（含 1 个思考子列）+ (MAX-1) 个普通列 ⇒ 总 MAX+1、超出 1 ⇒ doomed=[父列]。
    const parent = doc.createElement('div');
    parent.className = 'mcol';
    const subs = doc.createElement('div');
    subs.className = 'toolcard-subs';
    const seg = M.buildThinkSeg({ text: 'w'.repeat(300), collapsed: true });
    (subs as unknown as { appendChild(n: unknown): unknown }).appendChild(seg.root);
    (parent as unknown as { appendChild(n: unknown): unknown }).appendChild(subs);
    pane.el.appendChild(parent);
    for (let i = 0; i < cap.MAX_DOM_COLS - 1; i += 1) {
      const col = doc.createElement('div');
      col.className = 'mcol';
      pane.el.appendChild(col);
    }
    M.noteRestoredThinkingBatch(pane.el, [seg]);
    expect(M.thinkRetained(pane.el)).toBe(300);

    const dropped = cap.prunePaneDom(pane, true);
    expect(dropped, '超出 1 条 ⇒ 摘父列 1 条').toBe(1);
    // ★ 主断言：改动前账本停在 300（父列本身不是思考列，子列的账漏减）。
    expect(M.thinkRetained(pane.el), '被摘父列的思考子列账本必须清零').toBe(0);
  });
});
