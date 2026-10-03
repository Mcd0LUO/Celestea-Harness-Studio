// @vitest-environment jsdom
// ============================================================================
// tests/w9298-p2-seq-gap.test.ts — W9298（F1-06 · P2）丢帧可检测
//
// 缺陷：契约信封带 `seq`（进程级单调计数器，apps/studio/src/sse.ts 的 `seq: seq++`），
//   而重连时 `bus.subscribe()` 建的是**全新订阅、不重放**（handlers/dialog.ts）。于是
//   **一次重连必然在 seq 上留下断号**，断掉的段永远补不回来。改动前前端**从不读 `p.seq`**
//   （apps/web/src 内的 seq 命中全是无关的本地计数器），这段丢失对用户完全不可见。
//
// 修：ui/sse-wire.ts 的 `SeqGapWatcher` —— 在**进帧预算之前**记 seq，断号则如实提示
//   「丢了 N 帧，且无法补发」。**不试图补齐**：没有补发端点，补齐需要改契约+后端
//   （超出本 worker 范围，已在报告写为后续项）。
//
// 三条纪律各有用例：只认单调前进 / 一次断连只提示一次 / 旧后端无 seq 绝不误报。
//
// 变异负控制见 results/audit3-r2/F1/变异负控制-P2.md：
//   · observe 去掉断号判定（恒返回 0）⇒ ① ② 红；
//   · 去掉 reset() 的重置 ⇒ ③ 红；
//   · 去掉「非有限/非数字」守卫（把 undefined 当 0 参与运算）⇒ ④ 红。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { at, doc, resetHarness } from './lib/w795-dom.js';

interface Watcher {
  observe(seq: unknown): number;
  reset(): void;
  stats(): { last: number | null; reported: boolean };
}
type WatcherCtor = new () => Watcher;

let W: WatcherCtor;
beforeEach(async () => {
  resetHarness();
  const mod = (await import(/* @vite-ignore */ at('ui/sse-wire.ts'))) as { SeqGapWatcher: WatcherCtor };
  W = mod.SeqGapWatcher;
});
afterEach(() => { doc.body.replaceChildren(); });

describe('W9298 · F1-06 · SeqGapWatcher 必须如实报出丢帧', () => {
  // ① 主断言：一次重连造成的 seq 断号要报出「丢了多少帧」。
  it('① seq 断号 ⇒ 报出丢失帧数（3 → 跳到 7 = 丢了 3 帧）', () => {
    const w = new W();
    expect(w.observe(3)).toBe(0);          // 起点：谈不上断号
    expect(w.observe(7), '4,5,6 三帧没收到').toBe(3);
  });

  it('①b 连续前进（seq+1）不误报', () => {
    const w = new W();
    w.observe(0);
    for (const s of [1, 2, 3, 4]) expect(w.observe(s), '连续前进不是丢帧').toBe(0);
  });

  it('①c 首帧不报（没有「上一条」，谈不上断号）', () => {
    const w = new W();
    expect(w.observe(99), '首帧无论多大都不该报').toBe(0);
    expect(w.stats().last).toBe(99);
  });

  // ② 重复投递 / 回退不是丢帧。
  it('② seq 不前进（重复或回退）⇒ 一律不报', () => {
    const w = new W();
    w.observe(5);
    expect(w.observe(5), '重复投递不是丢帧').toBe(0);
    expect(w.observe(3), '回退不是丢帧').toBe(0);
    expect(w.observe(5)).toBe(0);
  });

  // ③ 一次断连只提示一次；重连后允许再提示。
  it('③ 一次断连只报一次；reset() 后可再报（新的断连是新的事实）', () => {
    const w = new W();
    w.observe(0);
    expect(w.observe(5)).toBe(4);
    expect(w.observe(9), '同一次断连内不再提示（不刷屏）').toBe(0);
    expect(w.observe(20), '仍未重连 ⇒ 不提示').toBe(0);
    expect(w.stats().reported).toBe(true);
    w.reset();                                 // 连接重建
    expect(w.observe(21), '重连后恢复可提示').toBe(0);
    expect(w.observe(30), '新的一次断号要能再报一次').toBe(8);
  });

  // ④ 旧后端不带 seq：不可判定 ⇒ 绝不误报成「丢了」。
  it('④ 无 seq 的旧后端 ⇒ 一律不报（不得把「没有序号」误报成「丢了」）', () => {
    const w = new W();
    expect(w.observe(undefined)).toBe(0);
    expect(w.observe(null)).toBe(0);
    expect(w.observe('7')).toBe(0);
    expect(w.observe(NaN)).toBe(0);
    expect(w.observe(Infinity)).toBe(0);
    expect(w.stats().last, '不可判定的帧不得改动基线').toBeNull();
  });

  it('④b 混入无 seq 帧后，带 seq 的断号仍能判出', () => {
    const w = new W();
    w.observe(10);
    expect(w.observe(undefined)).toBe(0);
    expect(w.observe(14), '不可判定的帧没有打断基线').toBe(3);
  });

  // ⑤ 真实形状：事件负载被 withEnvelope 合并后 seq 在 payload 顶层。
  it('⑤ 端到端：断号经由 payload.seq 被如实检测（真实 withEnvelope 形状）', async () => {
    const mod = (await import(/* @vite-ignore */ at('ui/sse-wire.ts'))) as { SeqGapWatcher: WatcherCtor };
    const w = new mod.SeqGapWatcher();
    // sse.ts 的 withEnvelope 把 envelope.seq 合并到 payload（out.seq = env.seq）
    const frameA = { delta: 'a', seq: 100 };
    const frameB = { delta: 'b', seq: 104 };   // 101-103 丢了
    expect(w.observe(frameA.seq)).toBe(0);
    expect(w.observe(frameB.seq)).toBe(3);
  });
});

// ============================================================================
// ⑥ 接线：断号必须真的到达用户（statusline 的提示），而不只是算出数字。
//    这里走真实 connectSse + 假 EventSource 投递 seq 断号的两帧。
// ============================================================================
describe('W9298 · F1-06 · 断号要真的告知用户（接线）', () => {
  class FakeES {
    static last: FakeES | null = null;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private ls = new Map<string, ((e: unknown) => void)[]>();
    constructor(public url?: string) { FakeES.last = this; }
    addEventListener(n: string, f: (e: unknown) => void): void {
      const a = this.ls.get(n) ?? []; a.push(f); this.ls.set(n, a);
    }
    close(): void { /* noop */ }
    fire(event: string, data: unknown): void {
      for (const f of this.ls.get(event) ?? []) f({ data: JSON.stringify(data) });
    }
  }

  // ⑦ 回归护栏：上一轮这个 key **根本没写进 locale 文件**，t() 回落成 key 原文，
  //    界面上给用户显示 'chat.status.seqGap'，而 check-ui-copy **不会报错**
  //    （它只对拍 zh/en 集合一致 + 死键，不查「代码里用到但字典里没有」）。
  //    所以这里直接把「两种语言都必须能解析出真文案」钉住。
  it('⑦ chat.status.seqGap 必须在 zh/en 两个字典里都存在，且 {n} 占位不被吃掉', async () => {
    const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as {
      t(key: string, params?: Record<string, string | number>): string;
      localeDict(locale: 'zh' | 'en'): Record<string, string>;
    };
    for (const loc of ['zh', 'en'] as const) {
      const dict = i18n.localeDict(loc);
      const raw = dict['chat.status.seqGap'];
      expect(raw, loc + ' 字典缺少 chat.status.seqGap（t() 会回落成 key 原文）').toBeTruthy();
      expect(raw, loc + ' 的文案必须含 {n} 占位，否则丢帧数不会显示').toContain('{n}');
      // 实际取值：不得等于 key 本身，且占位要被替换成数字
      const rendered = i18n.t('chat.status.seqGap', { n: 7 });
      expect(rendered, loc + ' 取值回落成了 key 原文').not.toBe('chat.status.seqGap');
      expect(rendered, loc + ' 取值里应出现 7').toContain('7');
      expect(rendered, loc + ' 取值不应残留 {n}').not.toContain('{n}');
    }
    // zh 必须含「丢失」二字（用户可理解的措辞），en 必须是英文而非中文
    expect(i18n.localeDict('zh')['chat.status.seqGap']).toContain('丢失');
    expect(i18n.localeDict('en')['chat.status.seqGap'], 'en 字典混进了中文').not.toMatch(/[\u4e00-\u9fa5]/);
  });

  it('⑥ seq 断号 ⇒ statusline 出现「丢失 N 帧」提示', async () => {
    const { vi } = await import('vitest');
    vi.stubGlobal('EventSource', FakeES as unknown as typeof EventSource);
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
    const chat = (await import(/* @vite-ignore */ at('chat.ts'))) as { connectSse(): unknown };
    chat.connectSse();
    const es = FakeES.last;
    expect(es, 'connectSse 必须建立一条 EventSource').not.toBeNull();
    // 两帧 text，seq 连续 ⇒ 无提示
    es!.fire('text', { v: 2, session: 'ws/gap', turn: 1, seq: 10, payload: { delta: 'a' } });
    expect(doc.body.textContent ?? '', '连续 seq 不该有提示').not.toContain('丢失');
    // 断号：11/12/13 没收到
    es!.fire('text', { v: 2, session: 'ws/gap', turn: 1, seq: 14, payload: { delta: 'b' } });
    expect(doc.body.textContent ?? '', '断号必须如实提示丢了多少帧').toContain('丢失');
    expect(doc.body.textContent ?? '').toContain('3');
    vi.unstubAllGlobals();
  });
});
