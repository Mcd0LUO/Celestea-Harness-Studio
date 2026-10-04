// @vitest-environment jsdom
// ============================================================================
// tests/w9298-p1-dedup-and-sse-done.test.ts — W9298（F1-02 / F1-03 · P1）
//
// F1-02：衔接去重的守卫**没有轮次身份** —— 它只按内容前缀判别（tail.startsWith(buf)），
//   于是「新一轮的首段文本恰好与已恢复尾部开头相同」也被当成重放整段吞掉。审计探针实测：
//   恢复尾部 "OK"、新一轮全文也是 "OK" ⇒ 新一轮输出在界面上**完全不可见**（探针 H）；
//   对照组把新文本改成 "OK then more" 即正常显示（探针 I，两次服务端同样投递 8 帧）。
//   修：守卫锚定「恢复尾部属于哪一轮」（noteRestoreTurn），只有该轮的增量才进守卫。
//
// F1-03：`done` 帧**无条件**调 `statusline.onSseDone()`，而它消费全局单例上的
//   `pendingPatch`/`pendingPick`（409 挂起的档位/模型切换）⇒ 任何会话的 done 都能消费
//   聚焦会话的挂起补丁。修：仅当「一个会话都不在跑」才推进（服务端 409 的判据是**全局**
//   的：config.ts → runtime.isBusy() 无参 = inFlightCount() > 0 —— 只判聚焦会话会在
//   「别的会话仍在跑」时白白消耗掉一次挂起补丁）。
//
// 变异负控制（逐条真实输出见 results/audit3-r2/F1/变异负控制-P1.md）：
//   · 去掉 feedAssistantDelta 的身份闸门（回到纯内容前缀判别）⇒ ① 红；
//   · noteRestoreTurn 改传 null（等于关闭守卫）⇒ ②「同轮重放仍被吞」红；
//   · onDoneGuarded 去掉 busyIds() 全局判据（只看 isActivePane）⇒ ③ 红。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness, stub } from './lib/w795-dom.js';

interface Dedup {
  tail: { role: string; content: string } | null;
  guardActive: boolean;
  guardBuf: string;
  guardAll: boolean;
  guardTurn: number | null;
}
interface Pane {
  dedup: Dedup;
  el: { querySelectorAll(s: string): ArrayLike<unknown> };
  streaming: boolean;
  turn: number | null;
  phase: string;
  assistant: unknown;
}
interface DedupMod {
  feedAssistantDelta(ctx: Pane, delta: string, turn?: number | null): string | null;
  finalAssistantDedup(ctx: Pane, text?: string): boolean;
  noteRestoreTurn(ctx: Pane, turn: number | null): void;
  resetRestore(ctx: Pane): void;
}

const paneWith = (tail: string | null, guardTurn: number | null): Pane => ({
  dedup: { tail: tail === null ? null : { role: 'assistant', content: tail },
          guardActive: false, guardBuf: '', guardAll: false, guardTurn },
  el: { querySelectorAll: () => [] as unknown as ArrayLike<unknown> },
  streaming: false, turn: null, phase: '', assistant: null,
});

describe('W9298 · F1-02 · 去重守卫必须带轮次身份', () => {
  let D: DedupMod;
  beforeEach(async () => {
    D = (await import(/* @vite-ignore */ at('ui/restore-dedup.ts'))) as unknown as DedupMod;
  });
  afterEach(() => { doc.body.replaceChildren(); });

  // ① 主断言：新一轮的同文开头必须**透传**，不能被当重放吞掉。
  it('① 新一轮（turn 变了）首段与尾部同文 ⇒ 必须透传，不得整段吞掉', () => {
    // 恢复尾部是 "OK"，属于第 1 轮（恢复时那一轮正在跑）。
    const ctx = paneWith('OK', 1);
    // 第 2 轮的第一个 delta —— 内容与尾部**完全相同**，但轮次已变。
    const out = D.feedAssistantDelta(ctx, 'OK', 2);
    expect(out, '新一轮的同文增量不是重放，必须原样透传').toBe('OK');
    expect(ctx.dedup.tail, '判定发散即丢弃锚点').toBeNull();
  });

  it('①b 新一轮多帧同文开头：每帧都要透传，不得只放行第一帧', () => {
    const ctx = paneWith('OK', 1);
    expect(D.feedAssistantDelta(ctx, 'OK', 2)).toBe('OK');
    // 锚点已丢，后续帧按普通增量放行
    expect(D.feedAssistantDelta(ctx, ' then more', 2)).toBe(' then more');
  });

  // ② 反向：同一轮的重放**必须**仍然被吞掉（守卫不能被彻底关掉）。
  it('② 同一轮（turn 未变）的重放仍被吞掉 ⇒ 守卫照旧生效', () => {
    const ctx = paneWith('OK', 1);
    expect(D.feedAssistantDelta(ctx, 'OK', 1), '同轮重放应被吞掉').toBeNull();
    expect(ctx.dedup.guardActive).toBe(true);
    // 整条吞完 ⇒ done 钩子判定为「重复气泡」并移除
    expect(D.finalAssistantDedup(ctx, 'OK')).toBe(true);
  });

  it('②b 同轮重放发散：吐出完整缓冲并解除守卫', () => {
    const ctx = paneWith('ABC', 1);
    expect(D.feedAssistantDelta(ctx, 'AB', 1)).toBeNull();
    expect(D.feedAssistantDelta(ctx, 'CDEFGH', 1)).toBe('ABCDEFGH');
  });

  // ③ guardTurn===null（恢复时无在跑的轮次）⇒ 守卫全程关闭。
  it('③ 恢复时该会话没有在跑的轮次 ⇒ 守卫关闭，任何 live 增量都透传', () => {
    const ctx = paneWith('OK', null);
    expect(D.feedAssistantDelta(ctx, 'OK', 5), '无锚定时不得吞掉同文新轮').toBe('OK');
  });

  // ④ 不可判定（旧后端不带 turn）⇒ 保持旧的内容前缀判别，不退化出同文吞新轮。
  it('④ 旧后端（turn 未知）⇒ 保持内容前缀判别，且不误吞真正的新内容', () => {
    const ctx = paneWith('OK', 1);
    // turn 传 undefined：判据不可判定 ⇒ 走旧的内容判别
    expect(D.feedAssistantDelta(ctx, 'OK', undefined), '同文重放仍被吞（旧后端同口径）').toBeNull();
    const ctx2 = paneWith('OK', 1);
    expect(D.feedAssistantDelta(ctx2, 'OK then more', undefined), '发散即透传').toBe('OK then more');
  });

  it('⑤ noteRestoreTurn 改锚后，同文的新一轮才被放行（与 ① 同一断言的因果两端）', () => {
    const ctx = paneWith('OK', null);      // 先：恢复时没在跑 ⇒ 守卫关
    D.noteRestoreTurn(ctx, 1);             // 再：锚定第 1 轮
    expect(D.feedAssistantDelta(ctx, 'OK', 2), '锚到第 1 轮后，第 2 轮必须放行').toBe('OK');
  });

  it('⑥ resetRestore 把身份一起复位（守卫与锚点不得跨会话残留）', () => {
    const ctx = paneWith('OK', 1);
    D.feedAssistantDelta(ctx, 'OK', 1);
    D.resetRestore(ctx);
    expect(ctx.dedup).toEqual({
      tail: null, guardActive: false, guardBuf: '', guardAll: false, guardTurn: null,
    });
  });
});

describe('W9298 · F1-03 · done 帧只在「全局空闲」时推进挂起切换', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  interface ViewCtxMod {
    initViewCtx(): unknown;
    ensurePane(id: string, kind?: string, title?: string): Pane;
    activatePane(id: string, kind?: string, title?: string): unknown;
  }
  interface ChatMod {
    onStatus(ctx: unknown, p: Record<string, unknown>): void;
    onDoneGuarded(ctx: unknown, p: Record<string, unknown>): void;
  }
  interface StatuslineMod {
    statusline: { onSseDone(): void; pendingPatch: Record<string, unknown> | null };
  }

  async function boot(): Promise<{ chat: ChatMod; sl: StatuslineMod['statusline']; ctx: ViewCtxMod }> {
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
    const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    ctxMod.initViewCtx();
    const sl = ((await import(/* @vite-ignore */ at('statusline.ts'))) as unknown as StatuslineMod).statusline;
    const chat = (await import(/* @vite-ignore */ at('chat.ts'))) as ChatMod;
    return { chat, sl, ctx: ctxMod };
  }

  // ① 主断言：**别的会话仍在跑**时，本会话的 done 不得消费挂起切换。
  //    这才是 F1-03 的真实形状：服务端 409 是**全局**的（isBusy() = inFlightCount()>0），
  //    只要还有任何一个会话在跑，此刻的 saveConfig 必被顶回 ⇒ 推进补丁等于白丢一次。
  //    注意「本会话自己」不算：后端顺序是 done 先于 status:completed，它马上就会收尾。
  it('① 别的会话仍在跑时，本会话的 done 不得消费挂起切换', async () => {
    const { chat, sl, ctx } = await boot();
    const a = ctx.ensurePane('ws/A', 'session', 'A');   // 聚焦、挂着一个 409 挂起的切换
    ctx.activatePane('ws/A', 'session', 'A');
    const b = ctx.ensurePane('ws/B', 'session', 'B');
    chat.onStatus(b, { phase: 'start', turn: 1, statusline: {} });  // B 在跑
    expect(b.streaming, '前提：B 在跑').toBe(true);
    sl.pendingPatch = { reasoning_effort: 'max' };

    // A 的一轮收尾（done 帧）。此刻 B 还在跑 ⇒ 全局仍有在途轮次 ⇒ 409 必顶回。
    chat.onStatus(a, { phase: 'start', turn: 1, statusline: {} });
    chat.onDoneGuarded(a, { turn: 1, text: 'x' });
    expect(sl.pendingPatch, 'B 仍在跑 ⇒ 409 会顶回，此刻推进等于白丢一次').not.toBeNull();
  });

  // ①b 反向：唯一在跑的就是本会话自己 ⇒ 排除自己后判定为「无他人在途」⇒ 照旧推进。
  //     这条钉住「排除自己」这一半，否则把 done 前置的正常收尾也一并挡掉。
  it('①b 只有本会话自己在跑 ⇒ 照旧消费（排除自己，不得误挡正常收尾）', async () => {
    const { chat, sl, ctx } = await boot();
    const a = ctx.ensurePane('ws/A', 'session', 'A');
    ctx.activatePane('ws/A', 'session', 'A');
    chat.onStatus(a, { phase: 'start', turn: 1, statusline: {} });
    sl.pendingPatch = { reasoning_effort: 'max' };
    chat.onDoneGuarded(a, { turn: 1, text: 'x' });
    expect(sl.pendingPatch, '没有他人在途时必须照旧消费').toBeNull();
  });

  // ② 反向：真正全局空闲时（聚焦会话自己的 done）照旧推进 —— 修复不能把 W750/W795 改坏。
  it('② 全局空闲（聚焦会话自己的 done）⇒ 照旧推进挂起切换', async () => {
    const { chat, sl, ctx } = await boot();
    const a = ctx.ensurePane('ws/A', 'session', 'A');
    ctx.activatePane('ws/A', 'session', 'A');
    chat.onStatus(a, { phase: 'start', turn: 1, statusline: {} });
    sl.pendingPatch = { reasoning_effort: 'max' };

    chat.onDoneGuarded(a, { turn: 1, text: 'x' });
    // 后端顺序（[drive]：runTurn 发完 done 帧**之后**才 emitStatus 发终态 status）
    // ⇒ 此刻 A 自己仍登记为 busy；守卫据此**排除自己**（它马上由那条 completed 收尾）。
    expect(sl.pendingPatch, '全局空闲时必须照旧消费（W750/W795 的既有契约）').toBeNull();
  });

  // ②b 判别用例：**聚焦会话自己**的 done 到达，而**别的**会话仍在跑。
  //    这一条是「只判 isActivePane」与「判全局空闲」的分水岭：
  //      · 只判 isActivePane ⇒ isActive(A)=true 直接放行，消费掉补丁；
  //        而 B 还在跑 ⇒ A 的 saveConfig 必被服务端的**全局** 409 顶回 ⇒ 补丁白丢一次。
  //      · 判全局空闲 ⇒ busyIds 里有 B ⇒ 保留补丁，等真正全局空闲时再推。
  it('②b 聚焦会话自己的 done 到达、但别的会话仍在跑 ⇒ 也不得消费补丁', async () => {
    const { chat, sl, ctx } = await boot();
    const a = ctx.ensurePane('ws/A', 'session', 'A');
    ctx.activatePane('ws/A', 'session', 'A');
    const b = ctx.ensurePane('ws/B', 'session', 'B');
    chat.onStatus(a, { phase: 'start', turn: 1, statusline: {} });  // A 在跑
    chat.onStatus(b, { phase: 'start', turn: 1, statusline: {} });  // B 也在跑
    sl.pendingPatch = { reasoning_effort: 'max' };

    chat.onDoneGuarded(a, { turn: 1, text: 'x' });                  // A 的 done，但 B 还在跑
    expect(sl.pendingPatch, 'B 仍在跑 ⇒ 409 会顶回，此刻推进等于白丢一次').not.toBeNull();
  });

  // ③ 无挂起补丁时不得凭空发起任何请求。
  it('③ 没有挂起补丁时，done 不得发起 /api/config', async () => {
    const { chat, ctx } = await boot();
    const a = ctx.ensurePane('ws/A', 'session', 'A');
    ctx.activatePane('ws/A', 'session', 'A');
    chat.onStatus(a, { phase: 'start', turn: 1, statusline: {} });
    const posts = () => stub.calls.filter((c) => c.url.startsWith('/api/config') && c.method === 'POST').length;
    const before = posts();
    chat.onDoneGuarded(a, { turn: 1, text: 'x' });
    const after = posts();
    expect(after, '无挂起补丁时不得凭空 POST /api/config').toBe(before);
  });
});
