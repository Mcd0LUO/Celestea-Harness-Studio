// @vitest-environment jsdom
// ============================================================================
// tests/w9315-f1-01-envelope-gap.test.ts — W9315（F1-01 · P1）
//   丢帧检测必须**逐条信封**观察，不能挑事件名。
//
// 缺陷（results/audit4/F1-SSE消息丢帧.md）：observe() 原来只被 paced() 调用，而 paced()
//   只包住 status/text/thinking/tool/tool_result/done 六个名字。seq 是**进程级**计数器
//   （apps/studio/src/sse.ts 的 emit：seq++，与事件名、与订阅者都无关），
//   compact / question / terminal 同样推进它，却不推进本观察器的基线
//   ⇒ **下一条真实帧必被算成「丢了 N 帧」**。
//
//   真机 CDP 复现（headless Chrome 154，指向未重建的 apps/web/dist）：
//     零丢失的流夹 1 个 question 帧 ⇒ 界面显示「连接中断，丢失了 1 帧输出」；
//     夹 3 个 terminal 帧          ⇒ 显示「丢失了 3 帧」——数字随旁路帧数线性放大。
//   ask_user_question 是常驻工具、终端每批 pty 字节一帧 ⇒ 每轮都会命中。
//
// 修：SseClient.onEnvelope 在**信封层**（withEnvelope 之后、事件分发之前）逐条交出
//   （sse.ts 的 emitEnvelope）。连「没有任何处理器的事件名」（terminal）也被看到，
//   且新增事件名不需要在接线层补任何东西。
//
// 变异负控制（真实输出见 results/audit4/F1/变异负控制-W9315.md）：
//   · 删掉 connect() 里的 emitEnvelope 调用      ⇒ ① 红；
//   · 把 emitEnvelope 挪到 emit 之后             ⇒ ①（terminal 无处理器）红；
//   · 把观察者从 onEnvelope 挪回 paced()          ⇒ ③ 红；
//   · 去掉 observe 的「只认单调前进」判据          ⇒ ④ 红（重复/回退被算成丢帧）。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness } from './lib/w795-dom.js';

interface SseLike {
  on(n: string, h: (p: unknown) => void): void;
  onEnvelope(cb: (p: unknown, name: string) => void): void;
  connect(): void;
}
type SseCtor = new () => SseLike;

/** 假 EventSource：按事件名注册监听，测试里手动 fire 一帧。 */
class FakeES {
  static last: FakeES | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private ls = new Map<string, ((e: unknown) => void)[]>();
  constructor(public url?: string) { FakeES.last = this; }
  addEventListener(n: string, f: (e: unknown) => void): void {
    const a = this.ls.get(n) ?? [];
    a.push(f);
    this.ls.set(n, a);
  }
  close(): void { /* noop */ }
  fire(event: string, data: unknown): void {
    for (const f of this.ls.get(event) ?? []) f({ data: JSON.stringify(data) });
  }
}

beforeEach(() => { resetHarness(); });
afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

/** 清掉可能由上一个用例残留的提示（setNote 有 6s 定时器，不清会串味）。 */
async function clearNote(): Promise<void> {
  const s = (await import(/* @vite-ignore */ at('statusline.ts'))) as {
    statusline: { setNote(t: string, ms: number): void };
  };
  s.statusline.setNote('', 0);
}

/** 起一条真实接线（connectSse），返回可手动投帧的假 EventSource。 */
async function connectWired(): Promise<FakeES> {
  vi.stubGlobal('EventSource', FakeES as unknown as typeof EventSource);
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  await clearNote();
  const chat = (await import(/* @vite-ignore */ at('chat.ts'))) as { connectSse(): unknown };
  chat.connectSse();
  return FakeES.last as FakeES;
}

describe('W9315 · F1-01 · 传输层：信封观察钩子', () => {
  // ① 根因所在：terminal 在接线层**没有任何处理器**，旧实现里它的 seq 没人看得到。
  it('① onEnvelope 对未注册处理器的事件名（terminal）也触发', async () => {
    vi.stubGlobal('EventSource', FakeES as unknown as typeof EventSource);
    const { SseClient } = (await import(/* @vite-ignore */ at('sse.ts'))) as { SseClient: SseCtor };
    const seen: string[] = [];
    const sse = new SseClient();
    sse.on('text', () => { /* 只处理 text，terminal 故意不注册 */ });
    sse.onEnvelope((p, name) => { seen.push(name + '#' + String((p as { seq?: unknown }).seq)); });
    sse.connect();
    (FakeES.last as FakeES).fire('terminal', { v: 2, session: 'ws/x', turn: 0, seq: 5, payload: { data: 'x' } });
    expect(seen, 'terminal 没有处理器，钩子仍必须看到它的 seq').toContain('terminal#5');
    (FakeES.last as FakeES).fire('text', { v: 2, session: 'ws/x', turn: 1, seq: 6, payload: { delta: 'a' } });
    expect(seen, 'text 也必须被看到').toContain('text#6');
  });

  // ② 记账必须排在预算队列/处理器之前，否则「预算还没排到的帧」会被误判成丢帧。
  it('② 每条信封恰好触发一次，且早于事件处理器', async () => {
    vi.stubGlobal('EventSource', FakeES as unknown as typeof EventSource);
    const { SseClient } = (await import(/* @vite-ignore */ at('sse.ts'))) as { SseClient: SseCtor };
    const order: string[] = [];
    const sse = new SseClient();
    sse.on('text', () => { order.push('handler'); });
    sse.onEnvelope(() => { order.push('envelope'); });
    sse.connect();
    (FakeES.last as FakeES).fire('text', { v: 2, session: 'ws/x', turn: 1, seq: 1, payload: { delta: 'a' } });
    expect(order, '每条信封恰好一次，且必须在处理器之前').toEqual(['envelope', 'handler']);
  });
});

describe('W9315 · F1-01 · 接线回归：旁路帧不得谎报丢帧', () => {
  // ③ 主回归：一条**完全连续**的流，夹 question / compact / terminal 三种旁路帧。
  //    这正是 F1-01 在真机上被观察到的那一幕（零丢失，却报「丢失了 N 帧」）。
  it('③ 连续流里夹 question/compact/terminal ⇒ 不得谎报丢帧', async () => {
    const es = await connectWired();
    const s = 'ws/fix1';
    const f = (event: string, seq: number, payload: unknown, turn = 1): void => {
      es.fire(event, { v: 2, session: s, turn, seq, payload });
    };
    f('text', 100, { delta: 'a' });
    f('question', 101, { id: 'q-1', questions: [], expires_at: 0, timeout_ms: 0 });
    f('text', 102, { delta: 'b' });
    f('compact', 103, { session: s, kept_turns: 1, note: 'n' }, 0);
    f('text', 104, { delta: 'c' });
    f('terminal', 105, { id: 't1', session: s, data: 'pty' }, 0);
    f('text', 106, { delta: 'd' });
    f('text', 107, { delta: 'e' });
    expect(doc.body.textContent ?? '', '一帧都没丢，却提示丢了帧 = F1-01 未修复').not.toContain('丢失');
  });

  it('③b 单个 question 帧也不得谎报（最小复现形状）', async () => {
    const es = await connectWired();
    const s = 'ws/fix1b';
    es.fire('text', { v: 2, session: s, turn: 1, seq: 0, payload: { delta: 'a' } });
    es.fire('question', { v: 2, session: s, turn: 1, seq: 1, payload: { id: 'q', questions: [] } });
    es.fire('text', { v: 2, session: s, turn: 1, seq: 2, payload: { delta: 'b' } });
    expect(doc.body.textContent ?? '', '零丢失 + 一个 question 帧 ⇒ 必须静默').not.toContain('丢失');
  });

  // ④ 反向护栏：修复不能把检测器弄瞎 —— 真断号仍然必须报。
  it('④ 真断号仍然如实报出（修复没把检测器弄瞎）', async () => {
    const es = await connectWired();
    const s = 'ws/fix2';
    es.fire('text', { v: 2, session: s, turn: 1, seq: 200, payload: { delta: 'a' } });
    // 201/202/203 没收到
    es.fire('text', { v: 2, session: s, turn: 1, seq: 204, payload: { delta: 'b' } });
    expect(doc.body.textContent ?? '', '真断号必须仍然提示').toContain('丢失');
    expect(doc.body.textContent ?? '', '必须报出真实缺口 3').toContain('3');
  });

  // ⑤ 第三条纪律保持：旧后端不带 seq ⇒ 不可判定 ⇒ 绝不误报。
  it('⑤ 旧后端无 seq ⇒ 不报（第三条纪律保持）', async () => {
    const es = await connectWired();
    const s = 'ws/fix3';
    es.fire('text', { v: 1, session: s, turn: 1, payload: { delta: 'a' } });
    es.fire('text', { v: 1, session: s, turn: 1, payload: { delta: 'b' } });
    expect(doc.body.textContent ?? '', '没有 seq 不可判定，不得误报成丢失').not.toContain('丢失');
  });
});
