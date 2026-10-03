// @vitest-environment jsdom
// ============================================================================
// tests/w9298-lagged-frame.test.ts — W9298（F1-01 · P0）lagged 丢帧帧不再被整帧吞掉
//
// 缺陷（审计 F1-01）：chat.ts 的 turn 守卫排在 `phase==='lagged'` 分支**之前**。
// 后端 apps/studio/src/sse.ts 的 laggedFrame 把 envelope.turn **硬编码为 0**（进程级
// 丢帧标记，不属于任何轮次）⇒ 守卫判 `p.turn(0) !== ctx.turn(1)` 后**整帧 return**，
// 告警块永不渲染。而 lagged 恰恰只在「某 session bucket 溢出、该 session 的帧被丢」
// 时发出 —— 被丢的帧通常就含该轮**终态帧**（status completed/cancelled/error）⇒
// 前端既收不到终态、也收不到告警 ⇒ `ctx.streaming` 永为 true、气泡永远带流式光标、
// 输入栏永远是「插话」——**永久卡「运行中」，只能刷新页面**。
//
// 修复（chat.ts onStatus）：把 lagged/hint 分支提到 turn 守卫**之前**并 return；并由
// recheckLagged() 向 `GET /api/status?session=` 复核 `busy` 真值 —— 该轮若其实已结束
// （终态帧正是被丢的那些帧之一）则补 finalizeTurn(ctx,'interrupted') 收尾。
//
// 本文件三层（缺一层就守不住）：
//   ① 行为·告警：turn=0 的 lagged 帧**必须**渲染出告警块（改动前一次都不出现）；
//   ② 行为·脱困：busy=false ⇒ streaming 落回 false（改动前永久卡 true）；
//   ③ 不误杀：busy=true / 字段缺失 / 请求失败 / 后台容器 ⇒ **都不得**收尾。
//
// 变异负控制（改坏必红，逐条真实输出见 results/audit3-r2/F1/变异负控制.md）：
//   · 把 lagged 分支挪回 turn 守卫之后 ⇒ ① ② 红；
//   · recheckLagged 删掉 `busy === undefined` 那条 early-return ⇒ ③ 的「字段缺失」红；
//   · recheckLagged 无条件 finalizeTurn（删掉 busy===true 早退）⇒ ③ 的 busy=true 红。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, flush, resetHarness, statusBySession } from './lib/w795-dom.js';

interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): Pane;
  activatePane(id: string, kind?: string, title?: string): unknown;
}
interface Pane {
  el: { querySelectorAll(s: string): ArrayLike<unknown> };
  streaming: boolean;
  turn: number | null;
  phase: string;
  assistant: unknown;
}
interface ChatMod {
  onStatus(ctx: unknown, p: Record<string, unknown>): void;
}

const SESSION = 'ws/lagged';

/**
 * lagged 告警块的正文（renderInfoBlock 画成 `.msg.info.warn` → `.info-content`）。
 * 只取正文而不是外层：外层 textContent 还含「系统 + 时刻」，按正则匹配会被时间戳干扰。
 */
const warnTexts = (): string[] =>
  Array.from(doc.querySelectorAll('.sess-pane .msg.info.warn .info-content'))
    .map((n) => (n.textContent ?? '').trim())
    .filter((s) => s !== '');

describe('W9298 · F1-01 · lagged 帧（turn=0）不再被 turn 守卫整帧吞掉', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  async function boot(): Promise<{ chat: ChatMod; pane: Pane }> {
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
    const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    ctxMod.initViewCtx();
    const pane = ctxMod.ensurePane(SESSION, 'session', '丢帧会话');
    ctxMod.activatePane(SESSION, 'session', '丢帧会话');
    const chat = (await import(/* @vite-ignore */ at('chat.ts'))) as ChatMod;
    return { chat, pane };
  }

  /** 帧序列 start(turn=1) → text，再补一帧 lagged（turn 硬编码 0，与后端逐字一致）。 */
  function startTurnThenLagged(chat: ChatMod, pane: Pane): void {
    chat.onStatus(pane, { phase: 'start', turn: 1, statusline: {} });
    expect(pane.streaming, '前提：start 之后必须在跑').toBe(true);
    expect(pane.turn).toBe(1);
    chat.onStatus(pane, { phase: 'lagged', turn: 0, dropped: 3, statusline: {} });
  }

  // ---- ① 告警必须出现（改动前 lagText 恒为 []） ----
  it('① turn=0 的 lagged 帧必须渲染出告警块', async () => {
    const { chat, pane } = await boot();
    startTurnThenLagged(chat, pane);
    const texts = warnTexts();
    expect(texts.length, 'lagged 帧被 turn 守卫吞掉了（告警一次都不出现）').toBeGreaterThan(0);
    expect(texts.join(' ')).toMatch(/合并|延迟|lagged|merged/i);
  });

  // ---- ② 终态帧被丢 ⇒ 必须靠复核脱困，不能永久卡「运行中」 ----
  it('② busy=false（该轮其实已结束）⇒ streaming 落回 false，不卡「运行中」', async () => {
    const { chat, pane } = await boot();
    // 服务端真值：这一轮已经不在跑了（终态帧正是被 bucket 丢掉的那批）。
    statusBySession[SESSION] = { ok: true, session: SESSION, busy: false };
    startTurnThenLagged(chat, pane);
    await flush();
    // ★ 主断言：改动前这里恒为 true —— 会话永久卡「运行中」，只能刷新。
    expect(pane.streaming, 'lagged 之后必须复核并收尾，否则永久卡运行中').toBe(false);
  });

  // ---- ③ 反向：不得误杀一个还在正常输出的轮次 ----
  it('③a busy=true（轮次真在跑）⇒ 不得收尾', async () => {
    const { chat, pane } = await boot();
    statusBySession[SESSION] = { ok: true, session: SESSION, busy: true };
    startTurnThenLagged(chat, pane);
    await flush();
    expect(pane.streaming, '轮次还在跑，收尾会把一个正常轮次误杀成「已结束」').toBe(true);
  });

  it('③b 旧后端不返回 busy 字段 ⇒ 保持原状，不得臆断成「不在跑」', async () => {
    const { chat, pane } = await boot();
    // 没有 busy：宁可继续显示运行中，也不要误杀。
    statusBySession[SESSION] = { ok: true, session: SESSION };
    startTurnThenLagged(chat, pane);
    await flush();
    expect(pane.streaming, '字段缺失必须保持原状（保守优先于脱困）').toBe(true);
  });

  it('③c 复核请求失败 ⇒ 保持原状，不得把「查不到」当成「已结束」', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('network down'); });
    const { chat, pane } = await boot();
    startTurnThenLagged(chat, pane);
    await flush();
    expect(pane.streaming, '复核失败必须保持原状').toBe(true);
  });

  it('③d 后台容器上的 lagged 不收尾（不抢聚焦会话的 chrome）', async () => {
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
    const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    ctxMod.initViewCtx();
    const chat = (await import(/* @vite-ignore */ at('chat.ts'))) as ChatMod;
    const bg = ctxMod.ensurePane('ws/background', 'session', '后台会话');
    chat.onStatus(bg, { phase: 'start', turn: 1, statusline: {} });
    expect(bg.streaming).toBe(true);
    // 告警**照画**（它是该会话的事实），但不得替它决定生命周期。
    statusBySession['ws/background'] = { ok: true, session: 'ws/background', busy: false };
    chat.onStatus(bg, { phase: 'lagged', turn: 0, dropped: 2, statusline: {} });
    await flush();
    expect(bg.streaming, '后台容器不得由一次 lagged 收尾').toBe(true);
  });

  // ---- ④ 回归：既有终态收尾语义不受本次改动影响 ----
  it('④ 回归：终态帧到达时照常收尾（本次把 lagged 提前不得改变这条）', async () => {
    const { chat, pane } = await boot();
    chat.onStatus(pane, { phase: 'start', turn: 1, statusline: {} });
    chat.onStatus(pane, { phase: 'completed', turn: 1, statusline: {} });
    expect(pane.streaming).toBe(false);
  });

  it('④b 回归：turn 不匹配的**轮次帧**仍被守卫拦下（守卫本身不能被拆掉）', async () => {
    const { chat, pane } = await boot();
    chat.onStatus(pane, { phase: 'start', turn: 1, statusline: {} });
    // 迟到的上一轮终态：必须被守卫拦下，不能把当前轮误收尾。
    chat.onStatus(pane, { phase: 'cancelled', turn: 0, statusline: {} });
    expect(pane.streaming, 'turn 不匹配的轮次帧必须仍被守卫拦下').toBe(true);
  });
});
