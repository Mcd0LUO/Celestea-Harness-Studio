// @vitest-environment jsdom
/**
 * W9333 验收：会话内「等待反馈」占位（发送之后、首个 token 之前）。
 *
 * 行为规格 = apps/web/prototype/thinking.html（联调定稿）。本文件守**后果**，
 * 每条都问过「它红的时候，是产品坏了，还是我换了实现？」（铁律 11）：
 *   ① 阶段推进真值表：**「思考中」只能由真的 reasoning 增量到达** —— 对非推理模型说
 *      「思考中」是假话。变异负控制：让 accepted 也给出 thinking ⇒ 红。
 *   ② 文案**真实已本地化**（不是 key、不是空串、两语不同）+ 排队/插话沿用既有 key。
 *   ③ 活路径（真 SSE 帧）：发送中 → 等待响应 → 思考中（空 delta 的 thinking 帧**不算**增量）。
 *   ④ 就地替换：首个 token 接管**占位那一列**（同一节点、同一位置、容器内无列增删）。
 *   ⑤ 计时从**按下发送**起（被接受不重置）。
 *   ⑥ 无障碍：阶段标签是唯一的 live region；**秒数不可播报**（aria-hidden）。
 *   ⑦ reduced-motion 下文字与秒数照常（动效的停与不停在真机探针里量）。
 *   ⑧ 策略：组件层零硬编码颜色（铁律 11 允许的唯一「策略」例外）。
 *
 * 量不了的（排版 / 动画相位）在 scripts/a11y/w9333-pending-probe.mjs 用真机定格量。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, flush, resetHarness, type ElLike, WEB } from './lib/w795-dom.js';

const LIVE = 'ws/s1';
const PEND = 'ui/messages/pending.ts';

interface El2 extends ElLike {
  children: ArrayLike<ElLike>;
  nextElementSibling: ElLike | null;
  previousElementSibling: ElLike | null;
}
interface PaneLike { el: ElLike }
interface PendMod {
  reducePhase(cur: string | null, ev: string): string | null;
  pendLabel(phase: string): string;
  PEND_PHASE_KEY: Record<string, string>;
  hasPending(ctx: unknown): boolean;
  pendingColOf(ctx: unknown): ElLike | null;
}
interface ViewMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): PaneLike;
  activatePane(id: string, kind?: string, title?: string): unknown;
}
interface MsgMod {
  ensureAssistant(ctx: unknown): { root: ElLike };
  appendThinking(ctx: unknown, delta: string): void;
  renderInfoBlock(ctx: unknown, text: string, cls?: string): unknown;
}
interface MoLike { observe(t: unknown, o: unknown): void; disconnect(): void }
interface RecLike { addedNodes: ArrayLike<ElLike>; removedNodes: ArrayLike<ElLike> }

let lastES: FakeES | null = null;
/** 最小 EventSource 替身（与 w895r 同一形状：真 SSE 帧 → 真 chat.ts 处理器）。 */
class FakeES {
  listeners: Record<string, Array<(e: unknown) => void>> = {};
  constructor() { lastES = this; }
  addEventListener(n: string, f: (e: unknown) => void): void { (this.listeners[n] ??= []).push(f); }
  close(): void { /* no-op */ }
  fire(name: string, payload: Record<string, unknown>): void {
    for (const f of this.listeners[name] ?? []) f({ data: JSON.stringify(payload) });
  }
}

const load = async (): Promise<PendMod> => (await import(/* @vite-ignore */ at(PEND))) as unknown as PendMod;
const labelText = (): string => doc.querySelector('.pend-lab')?.textContent ?? '';
const secsText = (): string => doc.querySelector('.pend-secs')?.textContent ?? '';
const colOf = (n: ElLike | null): El2 => n as unknown as El2;

/** 当前语言的字典（文案断言不写死中文：语言由 navigator 决定）。 */
async function dict(): Promise<Record<string, string>> {
  const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as {
    localeDict(l: string): Record<string, string>;
    getLocale(): string;
  };
  return i18n.localeDict(i18n.getLocale());
}

/** 夹具 HTML 缺 #inputbar / #btnSend（initInputBar 用 need() 取它们）——按需补上。 */
function addInputbar(): void {
  const main = doc.getElementById('main') as ElLike;
  const bar = doc.createElement('div') as ElLike;
  bar.id = 'inputbar';
  const mode = doc.createElement('button') as ElLike;
  mode.id = 'btnMode';
  const send = doc.createElement('button') as ElLike;
  send.id = 'btnSend';
  bar.appendChild(mode);
  bar.appendChild(send);
  main.appendChild(bar);
}

/** 装配：真 viewctx + 真 inputbar + 真 chat（SSE）+ 真 pending；/api/turn **永不返回**。 */
async function boot(): Promise<{ P: PendMod; pane: PaneLike }> {
  addInputbar();
  vi.stubGlobal('EventSource', FakeES);
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  vi.stubGlobal('fetch', async (url: unknown) => {
    if (String(url).indexOf('/api/turn') !== -1) return new Promise(() => { /* 请求在飞：永不返回 */ });
    return { ok: true, status: 200, json: async () => ({ ok: true, questions: [] }) };
  });
  const V = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as unknown as ViewMod;
  V.initViewCtx();
  const pane = V.ensurePane(LIVE, 'session', '甲会话');
  V.activatePane(LIVE, 'session', '甲会话');
  const bar = (await import(/* @vite-ignore */ at('ui/inputbar.ts'))) as { initInputBar(h: unknown): void };
  bar.initInputBar({ send: () => { /* 本文件只走 dispatchSend */ }, cancel: () => {} });
  const chat = (await import(/* @vite-ignore */ at('chat.ts'))) as { connectSse(): unknown };
  chat.connectSse();
  return { P: await load(), pane };
}

/** 走真发送路径（按下发送）。 */
async function press(text = '你好'): Promise<void> {
  (doc.getElementById('input') as ElLike).value = text;
  const send = (await import(/* @vite-ignore */ at('ui/send.ts'))) as { dispatchSend(t: string, m?: string): void };
  send.dispatchSend(text, 'steer');
}

/** 该节点的**可播报性**：往上走到 stop 之前，是否有 aria-hidden（读屏会跳过整棵子树）。 */
function ariaHiddenOnPath(node: ElLike | null, stop: ElLike | null): boolean {
  let cur: ElLike | null = node;
  while (cur !== null) {
    if (cur.getAttribute('aria-hidden') === 'true') return true;
    if (cur === stop) return false;
    cur = cur.parentElement;
  }
  return false;
}

/** 一条 mutation 记录是否动了「列」（.mcol）——「不插入再删除」的判据。 */
function touchesColumn(r: RecLike): boolean {
  const all = [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)];
  return all.some((n) => (n.className ?? '').indexOf('mcol') !== -1);
}

beforeEach(() => { resetHarness(); lastES = null; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); doc.body.replaceChildren(); });

describe('W9333 ① 阶段真值表（纯函数，无 DOM）', () => {
  const PHASES = ['delivering', 'queued', 'interjected', 'awaiting', 'thinking'];

  it('「思考中」只能由真的 reasoning 增量到达（send / accepted 永远到不了它）', async () => {
    const P = await load();
    const bad: string[] = [];
    for (const cur of [null, ...PHASES]) {
      if (cur === 'thinking') continue; // 已在「思考中」⇒ 停在原地不算「到达」
      for (const ev of ['send', 'accepted']) {
        if (P.reducePhase(cur, ev) === 'thinking') bad.push(String(cur) + ' + ' + ev);
      }
    }
    expect(bad, '对非推理模型说「思考中」是假话').toEqual([]);
    expect(P.reducePhase('delivering', 'reasoning')).toBe('thinking');
    expect(P.reducePhase('awaiting', 'reasoning')).toBe('thinking');
    expect(P.reducePhase('thinking', 'reasoning')).toBe('thinking');
  });

  it('accepted 只升级既有占位且不倒退；没有占位时不凭空造；send 重开一轮', async () => {
    const P = await load();
    expect(P.reducePhase(null, 'accepted'), '别人发起的轮次不长出占位').toBeNull();
    expect(P.reducePhase(null, 'reasoning')).toBeNull();
    expect(P.reducePhase('delivering', 'accepted')).toBe('awaiting');
    expect(P.reducePhase('awaiting', 'accepted')).toBe('awaiting');
    expect(P.reducePhase('thinking', 'accepted'), '迟到的 accepted 不得把思考中退回等待').toBe('thinking');
    expect(P.reducePhase('queued', 'send')).toBe('delivering');
  });
});

describe('W9333 ② 阶段 → 文案：真实已本地化，且沿用既有 key', () => {
  it('五个阶段的文案都不是 key、不是空串、两种语言是两句不同的话', async () => {
    const P = await load();
    const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as {
      localeDict(l: string): Record<string, string>;
      getLocale(): string;
    };
    const zh = i18n.localeDict('zh');
    const en = i18n.localeDict('en');
    const cur = i18n.localeDict(i18n.getLocale());
    const phases = Object.keys(P.PEND_PHASE_KEY);
    expect(phases.length).toBe(5);
    for (const phase of phases) {
      const key = P.PEND_PHASE_KEY[phase] as string;
      expect(zh[key], phase + ' zh').toBeTruthy();
      expect(en[key], phase + ' en').toBeTruthy();
      expect(zh[key], phase + ' 不得把 key 当文案').not.toBe(key);
      expect(en[key], phase + ' 不得把 key 当文案').not.toBe(key);
      expect(zh[key], phase + ' 两种语言必须是两句不同的话').not.toBe(en[key]);
      expect(P.pendLabel(phase), phase + ' 跟随当前语言').toBe(cur[key]);
    }
    // 同一件事只有一个说法：排队 / 插话沿用既有 key，不另造同义文案
    expect(P.PEND_PHASE_KEY['delivering']).toBe('chat.send.delivering');
    expect(P.PEND_PHASE_KEY['queued']).toBe('chat.send.queuedWaiting');
    expect(P.PEND_PHASE_KEY['interjected']).toBe('chat.send.interjectedWaiting');
  });
});

describe('W9333 ③ 活路径：真 SSE 帧驱动的阶段推进', () => {
  it('发送 → 发送中；被接受 → 等待响应；空 thinking 帧不算增量，真增量才说思考中', async () => {
    const { P, pane } = await boot();
    const d = await dict();
    const want = (phase: string): string => (d[P.PEND_PHASE_KEY[phase] as string] ?? '').replace('{seconds}', '');
    await press('你好');
    expect(P.hasPending(pane), '按下发送当帧就有占位').toBe(true);
    expect(labelText()).toBe(want('delivering'));
    await flush(4);
    expect(labelText(), '请求还在飞 ⇒ 仍是「发送中」').toBe(want('delivering'));
    lastES!.fire('status', { phase: 'start', turn: 1, session: LIVE });
    expect(labelText(), '已被接受 ⇒ 「等待响应」').toBe(want('awaiting'));
    lastES!.fire('thinking', { delta: '', turn: 1, session: LIVE });
    expect(labelText(), '空 delta 的 thinking 帧不是增量').not.toBe(want('thinking'));
    lastES!.fire('thinking', { delta: '先看下目录', turn: 1, session: LIVE });
    expect(labelText(), '真的 reasoning 增量 ⇒ 「思考中」').toBe(want('thinking'));
  });

  it('轮次结束（无正文）⇒ 占位被收掉，不留下永远等下去的占位', async () => {
    const { P, pane } = await boot();
    await press('你好');
    expect(P.hasPending(pane)).toBe(true);
    lastES!.fire('status', { phase: 'cancelled', turn: 1, session: LIVE });
    expect(P.hasPending(pane)).toBe(false);
    expect(doc.querySelector('.pend')).toBeNull();
  });
});

describe('W9333 ④ 就地替换（同一节点 / 同一位置 / 不插入再删除）', () => {
  it('首个 token 接管占位那一列：节点、位置、前后兄弟都不变，且容器内无列增删', async () => {
    const { P, pane } = await boot();
    await press('你好');
    const col = P.pendingColOf(pane) as ElLike;
    const host = pane.el as unknown as El2;
    const idx = Array.prototype.indexOf.call(host.children, col);
    const prev = colOf(col).previousElementSibling;
    const recs: RecLike[] = [];
    const Mo = (globalThis as unknown as { MutationObserver: new (cb: (r: RecLike[]) => void) => MoLike }).MutationObserver;
    const mo = new Mo((rs) => { for (const r of rs) recs.push(r); });
    mo.observe(host, { childList: true, subtree: true });
    const M = (await import(/* @vite-ignore */ at('ui/messages.ts'))) as unknown as MsgMod;
    const a = M.ensureAssistant(pane);
    await flush(2);
    mo.disconnect();
    expect(a.root.parentElement, '正文就住在占位那一列里').toBe(col);
    expect(Array.prototype.indexOf.call(host.children, col), '列的位置没变').toBe(idx);
    expect(colOf(col).previousElementSibling, '前一个兄弟没变').toBe(prev);
    expect(colOf(col).nextElementSibling, '仍在末尾').toBeNull();
    expect(doc.querySelector('.pend'), '占位内容已消失').toBeNull();
    expect(P.hasPending(pane)).toBe(false);
    expect(recs.filter(touchesColumn).length, '不得插入再删除列').toBe(0);
  });

  it('占位是助手那一格的哨兵：思考段排在它之前，接管后顺序仍是 思考 → 正文', async () => {
    const { P, pane } = await boot();
    await press('你好');
    const M = (await import(/* @vite-ignore */ at('ui/messages.ts'))) as unknown as MsgMod;
    M.appendThinking(pane, '推理一下');
    const col = P.pendingColOf(pane) as ElLike;
    const host = pane.el as unknown as El2;
    expect(colOf(col).nextElementSibling, '思考段先到 ⇒ 排在占位之前').toBeNull();
    expect(colOf(col).previousElementSibling?.querySelector('.msg.think-seg'), '占位上方就是思考段').not.toBeNull();
    const a = M.ensureAssistant(pane);
    expect(a.root.parentElement, '仍在原位接管').toBe(col);
    const think = doc.querySelector('.msg.think-seg') as ElLike;
    expect(Array.prototype.indexOf.call(host.children, col)).toBeGreaterThan(
      Array.prototype.indexOf.call(host.children, think),
    );
  });

  it('占位被更早的事件顶开时：正文落到末尾（事件顺序优先于原位）', async () => {
    const { P, pane } = await boot();
    await press('你好');
    const M = (await import(/* @vite-ignore */ at('ui/messages.ts'))) as unknown as MsgMod;
    M.renderInfoBlock(pane, '一条更早到达的提示', 'warn'); // 不认占位锚点 ⇒ 追加在末尾
    const col = P.pendingColOf(pane) as ElLike;
    expect(colOf(col).nextElementSibling, '占位已被顶开').not.toBeNull();
    const a = M.ensureAssistant(pane);
    expect(a.root.parentElement, '不在原位（原位已不是正文该在的地方）').not.toBe(col);
    expect(doc.querySelector('.pend'), '占位仍被收掉').toBeNull();
    const host = pane.el as unknown as El2;
    const info = doc.querySelector('.msg.info') as ElLike;
    expect(Array.prototype.indexOf.call(host.children, a.root.parentElement as ElLike)).toBeGreaterThan(
      Array.prototype.indexOf.call(host.children, info),
    );
  });
});

describe('W9333 ⑤ 计时从「按下发送」起（不是从被接受起）', () => {
  it('被接受不重置计时：8 秒时显示 8 秒，标签写明是「用时」', async () => {
    vi.useFakeTimers();
    const { P } = await boot();
    const d = await dict();
    const elapsed = (n: number): string => (d['chat.pend.elapsed'] ?? '').replace('{seconds}', String(n));
    await press('你好');
    expect(secsText()).toBe(elapsed(0));
    await vi.advanceTimersByTimeAsync(5000);
    expect(secsText(), '请求还在飞也照样走秒').toBe(elapsed(5));
    lastES!.fire('status', { phase: 'start', turn: 1, session: LIVE });
    await vi.advanceTimersByTimeAsync(3000);
    expect(secsText(), '从按下发送起算（不是被接受后的 3 秒）').toBe(elapsed(8));
    expect(P.hasPending).toBeTruthy();
  });
});

describe('W9333 ⑥ 无障碍：阶段标签是唯一的 live region，秒数不可播报', () => {
  it('role=status + aria-live=polite 在标签上；秒数 aria-hidden 且不在任何 live region 里', async () => {
    await boot();
    await press('你好');
    const lab = doc.querySelector('.pend-lab') as ElLike;
    const secs = doc.querySelector('.pend-secs') as ElLike;
    expect(lab.getAttribute('role')).toBe('status');
    expect(lab.getAttribute('aria-live')).toBe('polite');
    expect(secs.getAttribute('aria-hidden'), '删掉它 ⇒ 读屏每秒念一次数字').toBe('true');
    expect(secs.closest('[aria-live]'), '秒数不得落在 live region 里').toBeNull();
    expect(ariaHiddenOnPath(secs, lab), '秒数必须在 aria-hidden 子树里').toBe(true);
    expect(ariaHiddenOnPath(lab, lab), '标签自己不得被藏起来（否则永不播报）').toBe(false);
    expect(lab.textContent ?? '', 'live region 里不得出现秒数').not.toMatch(/\d/);
    expect(doc.querySelectorAll('.pend [aria-live]').length, '占位块里只有这一个 live region').toBe(1);
  });

  it('阶段变化只改标签文案（秒数节点与列都不重建）', async () => {
    const { P, pane } = await boot();
    const d = await dict();
    await press('你好');
    const lab = doc.querySelector('.pend-lab') as ElLike;
    const secs = doc.querySelector('.pend-secs') as ElLike;
    const col = P.pendingColOf(pane) as ElLike;
    lastES!.fire('status', { phase: 'start', turn: 1, session: LIVE });
    expect(doc.querySelector('.pend-lab')).toBe(lab);
    expect(doc.querySelector('.pend-secs')).toBe(secs);
    expect(P.pendingColOf(pane)).toBe(col);
    expect(lab.textContent).toBe(d['chat.pend.awaiting']);
  });
});

describe('W9333 ⑦ reduced-motion 下文字与秒数照常', () => {
  it('动效偏好为 reduce 时，阶段标签与「用时」照常渲染并继续走秒', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.indexOf('reduced-motion') !== -1,
      media: q,
      addEventListener: () => { /* no-op */ },
      removeEventListener: () => { /* no-op */ },
    }));
    vi.useFakeTimers();
    await boot();
    const d = await dict();
    await press('你好');
    expect(labelText()).toBe(d['chat.send.delivering']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(secsText()).toBe((d['chat.pend.elapsed'] ?? '').replace('{seconds}', '2'));
  });
});

describe('W9333 ⑧ 策略：组件层零硬编码颜色（铁律 11 允许的唯一「策略」例外）', () => {
  it('pending.ts / pending.css 里没有 hex / rgb() / hsl() 字面量', () => {
    const files = [join(WEB, 'src', 'ui', 'messages', 'pending.ts'), join(WEB, 'src', 'styles', 'pending.css')];
    const bad: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g)) bad.push(f + ' -> ' + String(m[0]));
    }
    expect(bad).toEqual([]);
  });

  it('脉冲星芒：三颗星 / 16 网格 / 装饰性 / currentColor 上色（跟随主题，不写死颜色）', async () => {
    await boot();
    await press('你好');
    const svg = doc.querySelector('.pend-ico') as ElLike;
    expect(svg.getAttribute('viewBox')).toBe('0 0 16 16');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    const stars = Array.from(doc.querySelectorAll('.pend-star'));
    expect(stars.length, '三颗小星芒').toBe(3);
    for (const s of stars) expect(s.getAttribute('fill')).toBe('currentColor');
  });
});
