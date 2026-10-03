// @vitest-environment jsdom
// ============================================================================
// tests/w9300-f3-1-autoscroll-wiring.test.ts — W9300/F3-1 的**接线**门禁。
//
// 为什么单独一个文件：w9300-f3-1-autoscroll-coalesce.test.ts 跑的是 scroll.ts 的
// 合并逻辑本身；这里钉的是 **assistant.ts 把哪条调用接到合并路径上**。
//
// 变异负控制（缺了这条，assistant.ts 改回直连也不会红 —— 实测过）：
//   · `if (force) autoscroll(ctx, true); else autoscrollSoon(ctx);` 改成
//     `autoscrollSoon(ctx);`（force 也异步）⇒ 用例 ② 红；
//   · `else autoscrollSoon(ctx);` 改成 `else autoscroll(ctx);`（节拍直连）⇒ 用例 ① 红。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness } from './lib/w795-dom.js';

interface View { text: string; content: { textContent: string | null }; root: { remove(): void; isConnected: boolean } }
interface Pane {
  el: { querySelectorAll(s: string): ArrayLike<unknown> };
  render: { timer: number | null; deadline: number; cost?: number };
  stickBottom: boolean;
}
interface MessagesMod {
  appendText(ctx: unknown, view: unknown, delta: string): void;
  ensureAssistant(ctx: unknown): View;
}
interface AssistantMod {
  applyFinalText(ctx: unknown, view: unknown, text: string): void;
  finalizeAssistant(ctx: unknown, view: unknown): void;
}

// 记 scroll.ts 侧两个入口各被调了几次。
//
// 为什么用 spy 真实模块而不是 vi.mock：assistant.ts 走的是**相对**说明符
// `'./scroll'`，而 vi.mock 只能拦它在解析器里解析出的**绝对 id**；用
// `'ui/messages/scroll'` 注册不会命中（实测 calls 全 0）。所以直接 spy 真实
// 模块导出的绑定 —— vitest 的 ESM 变换允许把命名导出改写成 getter。
const calls = { soon: 0, sync: 0, syncForce: 0 };

async function boot(): Promise<{ msg: MessagesMod; asst: AssistantMod; view: View; ctx: Pane }> {
  resetHarness();
  calls.soon = 0; calls.sync = 0; calls.syncForce = 0;
  // 在 assistant.ts 被 import **之前**把 scroll 模块的导出换成计数的 spy。
  const scroll = (await import(/* @vite-ignore */ at('ui/messages/scroll.ts'))) as Record<string, unknown>;
  const realSoon = scroll.autoscrollSoon as (c: unknown) => void;
  const realScroll = scroll.autoscroll as (c: unknown, f?: boolean) => void;
  Object.defineProperty(scroll, 'autoscrollSoon', { configurable: true, get: () => (c: unknown): void => { calls.soon += 1; realSoon(c); } });
  Object.defineProperty(scroll, 'autoscroll', { configurable: true, get: () => (c: unknown, f?: boolean): void => { calls.sync += 1; if (f === true) calls.syncForce += 1; realScroll(c, f); } });
  const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as {
    initViewCtx(): unknown; ensurePane(id: string, k?: string, t?: string): Pane;
    activatePane(id: string, k?: string, t?: string): unknown;
  };
  ctxMod.initViewCtx();
  const ctx = ctxMod.ensurePane('ws/f3-1', 'session', '甲会话');
  ctxMod.activatePane('ws/f3-1', 'session', '甲会话');
  const msg = (await import(/* @vite-ignore */ at('ui/messages.ts'))) as MessagesMod;
  const asst = (await import(/* @vite-ignore */ at('ui/messages/assistant.ts'))) as AssistantMod;
  const view = msg.ensureAssistant(ctx);
  return { msg, asst, view, ctx };
}
describe('W9300/F3-1 · assistant.ts 的贴底接线（节拍合并 / force 同步）', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('① 普通节拍的贴底走**合并**入口（autoscrollSoon），不是直连 autoscroll', async () => {
    const { msg, view, ctx } = await boot();
    // 前提：ensureAssistant 本身会 autoscroll(ctx, true) 建首帧贴底，那是**既有**
    // 行为（W867），不是节拍路径。所以这里量的是「节拍追加」带来的增量。
    const soon0 = calls.soon;
    const syncForce0 = calls.syncForce;
    msg.appendText(ctx, view, '第一段正文');
    msg.appendText(ctx, view, '第二段正文');
    expect(calls.soon - soon0, '节拍渲染必须走帧内合并入口').toBeGreaterThan(0);
    expect(calls.syncForce - syncForce0, '节拍路径不得新增 force 同步写').toBe(0);
  });

  it('② force=true 的贴底仍然**同步**（W1524 终态保证：done 之后滚动位立即对齐）', async () => {
    const { msg, asst, view, ctx } = await boot();
    msg.appendText(ctx, view, '正文');
    const before = calls.syncForce;
    // finalizeAssistant → flushTextView → autoscrollView(ctx, view, true)
    asst.finalizeAssistant(ctx, view);
    expect(calls.syncForce, '终态贴底必须同步写（force 路径没有被合并掉）').toBeGreaterThan(before);
  });

  it('③ 空文本 done 不新增同步贴底，也不改 view.text', async () => {
    const { msg, asst, view, ctx } = await boot();
    msg.appendText(ctx, view, '已有正文');
    const textBefore = view.text;
    const forceBefore = calls.syncForce;
    asst.applyFinalText(ctx, view, '');
    expect(view.text, '空文本 done 不得改写正文').toBe(textBefore);
    expect(calls.syncForce, '无排队渲染时空文本 done 不得凭空多一次同步贴底').toBe(forceBefore);
  });
});
