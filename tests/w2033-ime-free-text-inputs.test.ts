// @vitest-environment jsdom
/**
 * W2033 · IME 组合中的 Enter **不得**触发自由文本输入框的提交 / 导航 / 关闭。
 *
 * 缺陷（真机实测，见 results/W2033-ime-inputs.md）：这些框的 Enter 处理器没有 IME 守卫，
 * 中文/日文用户按 Enter **确认候选词**时同时触发了那个不可逆动作。
 *
 * 本文件是**逐框**门禁：每个框都有两条断言 ——
 *   ① 组合中（isComposing:true 与 keyCode:229 各一条）⇒ 动作**不**发生；
 *   ② 非组合 Enter ⇒ 行为与改动前**逐字相同**（基线写在各用例里）。
 * jsdom 的 isComposing 是**构造**出来的，不是输入法产生的 ⇒ 真机证据在报告里（CDP +
 * Input.imeSetComposition + 截图），两者缺一不可。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flush, reply, resetHarness, type ElLike } from './lib/w795-dom.js';
import { until } from '../apps/studio/src/wait.test-util.js';

const KB = (globalThis as unknown as { KeyboardEvent: new (t: string, i?: Record<string, unknown>) => unknown }).KeyboardEvent;
/** 一次按键（bubbles：newsession 的处理器挂在弹窗根上，靠冒泡收键）。 */
const key = (target: ElLike, init: Record<string, unknown>): void => {
  target.dispatchEvent(new KB('keydown', { ...init, bubbles: true }));
};
/** IME 组合中（标准字段）。 */
const IME = { key: 'Enter', isComposing: true, keyCode: 13 };
/** compositionend 早于 keydown 的那一次：isComposing 已是 false，只剩 229。 */
const IME_229 = { key: 'Enter', isComposing: false, keyCode: 229 };
/** 非组合的普通 Enter（基线）。 */
const PLAIN = { key: 'Enter', isComposing: false, keyCode: 13 };

let calls: { url: string; method: string; body: string }[] = [];

const type = (n: ElLike, value: string): void => {
  n.value = value;
  n.dispatchEvent(new Ev('input', { bubbles: true }));
};
const chips = (): (string | undefined)[] =>
  Array.from(doc.querySelectorAll('.prov-effort-chip')).map((c) => c.dataset['effort']);
const browseCalls = (): { url: string }[] => calls.filter((c) => c.url.includes('/api/fs/browse'));
const createCalls = (): { url: string }[] => calls.filter((c) => c.method === 'POST' && c.url === '/api/sessions');

beforeEach(() => {
  calls = [];
  resetHarness();
  vi.stubGlobal('fetch', async (url: unknown, init?: { method?: string; body?: unknown }) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url: u, method, body: init?.body === undefined ? '' : String(init.body) });
    if (u.includes('/api/fs/browse')) {
      const p = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
      return reply(200, { path: p, dirs: [] });
    }
    if (u === '/api/sessions' && method === 'POST') return reply(200, { ok: true, id: 'ws/new' });
    if (u.startsWith('/api/config')) return reply(200, { ok: true, available: { models: [] } });
    if (u.startsWith('/api/prompts')) return reply(200, { ok: true, prompts: [] });
    return reply(200, { ok: true });
  });
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
  doc.body.replaceChildren();
});

// ---- 判据本身（纯函数） --------------------------------------------------------
describe('W2033 · IME 判据（两半各覆盖一段，互不替代）', () => {
  it('isImeKey：组合中 / 229 都算；普通按键都不算', async () => {
    const { isImeKey } = (await import(/* @vite-ignore */ at('ui/ime.ts'))) as { isImeKey(e: unknown): boolean };
    expect(isImeKey({ isComposing: true, keyCode: 13 })).toBe(true);
    // ★ 这一条就是 229 那一半存在的理由：compositionend 早到 ⇒ isComposing 已经是 false。
    expect(isImeKey({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeKey({ keyCode: 229 })).toBe(true); // isComposing 字段缺席（老引擎）
    expect(isImeKey({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeKey({})).toBe(false);
  });

  it('isSubmitEnter 扩了 IME 判据，元素判型 / Shift 的老语义一字未改', async () => {
    const m = (await import(/* @vite-ignore */ at('ui/sessiontree/newsession.ts'))) as {
      isSubmitEnter(e: unknown): boolean;
    };
    const input = { tagName: 'INPUT', type: 'text' };
    expect(m.isSubmitEnter({ ...IME, key: 'Enter', shiftKey: false, target: input })).toBe(false);
    expect(m.isSubmitEnter({ ...IME_229, key: 'Enter', shiftKey: false, target: input })).toBe(false);
    expect(m.isSubmitEnter({ ...PLAIN, key: 'Enter', shiftKey: false, target: input })).toBe(true);
    // 老语义：Shift 不提交；非单行文本控件不提交（逐条照抄既有断言的口径）
    expect(m.isSubmitEnter({ key: 'Enter', shiftKey: true, target: input })).toBe(false);
    expect(m.isSubmitEnter({ key: 'Enter', shiftKey: false, target: { tagName: 'SELECT' } })).toBe(false);
    expect(m.isSubmitEnter({ key: 'Enter', shiftKey: false, target: { tagName: 'TEXTAREA' } })).toBe(false);
    expect(m.isSubmitEnter({ key: 'a', shiftKey: false, target: input })).toBe(false);
  });
});

// ---- 逐框：① 组合中不动作 ② 非组合与基线逐字相同 --------------------------------
describe('W2033 · ui/confirm.ts 逐字确认词输入框', () => {
  async function open(): Promise<{ settled: () => boolean | null }> {
    const m = (await import(/* @vite-ignore */ at('ui/confirm.ts'))) as {
      confirmDialog(o: Record<string, unknown>): Promise<boolean>;
    };
    let value: boolean | null = null;
    void m.confirmDialog({ message: '确认吗', requireText: '允许', requireHint: '输入 允许' }).then((v) => { value = v; });
    await flush();
    return { settled: () => value };
  }
  const word = (): ElLike => doc.querySelector('.confirm-word-row input.cfg-input') as ElLike;

  it('组合中 Enter（isComposing / 229）⇒ 不结算，弹窗仍开着', async () => {
    const h = await open();
    type(word(), '允许');
    expect((doc.querySelector('.modal-card-actions .btn-accent') as ElLike).disabled).toBe(false);
    key(word(), IME);
    await flush();
    expect(h.settled()).toBeNull();
    expect(doc.querySelector('.modal-scrim')).not.toBeNull();
    key(word(), IME_229);
    await flush();
    expect(h.settled()).toBeNull();
    expect(doc.querySelector('.modal-scrim')).not.toBeNull();
  });

  it('基线：非组合 Enter ⇒ 立即结算 true 并关掉弹窗', async () => {
    const h = await open();
    type(word(), '允许');
    key(word(), PLAIN);
    await flush();
    expect(h.settled()).toBe(true);
    expect(doc.querySelector('.modal-scrim')).toBeNull();
  });
});

describe('W2033 · ui/fsbrowser.ts 目录地址栏', () => {
  async function open(): Promise<void> {
    const m = (await import(/* @vite-ignore */ at('ui/fsbrowser.ts'))) as {
      openFsBrowser(o: Record<string, unknown>): void;
    };
    m.openFsBrowser({ title: '选目录', confirmLabel: '确定', busyLabel: '处理中', onPick: () => {} });
    await until(() => browseCalls().length >= 1, 'the initial browse of the dialog');
    // 首次浏览的**回填**会把地址栏写成服务端返回的路径：等它落定再打字，
    // 否则断言读到的是那次异步回填，而不是本用例输入的内容。
    await flush();
  }
  const addr = (): ElLike => doc.querySelector('.ws-fs-addr input.cfg-input') as ElLike;

  it('组合中 Enter ⇒ 不发起目录浏览（不导航）', async () => {
    await open();
    const before = browseCalls().length;
    type(addr(), '/中文目录');
    key(addr(), IME);
    await flush();
    key(addr(), IME_229);
    await flush();
    expect(browseCalls().length).toBe(before);
    expect(addr().value).toBe('/中文目录'); // 文本本身不受影响
  });

  it('基线：非组合 Enter ⇒ 浏览该路径（= 点「转到」）', async () => {
    await open();
    const before = browseCalls().length;
    type(addr(), '/中文目录');
    key(addr(), PLAIN);
    await until(() => browseCalls().length > before, 'the browse of the typed path');
    expect(browseCalls().at(-1)!.url).toContain(encodeURIComponent('/中文目录'));
  });
});

describe('W2033 · ui/sessiontree/newsession.ts 新建会话标题框', () => {
  async function open(): Promise<void> {
    const m = (await import(/* @vite-ignore */ at('ui/sessiontree/newsession.ts'))) as {
      newSessionDialog(h: { loadSessions(): Promise<void> }): void;
    };
    m.newSessionDialog({ loadSessions: async () => {} });
    await flush();
  }
  const title = (): ElLike => doc.querySelector('.modal-card .prov-field input') as ElLike;

  it('组合中 Enter ⇒ 不发创建请求（弹窗保持打开、按钮不进入提交态）', async () => {
    await open();
    type(title(), '中文标题');
    key(title(), IME);
    await flush();
    key(title(), IME_229);
    await flush();
    expect(createCalls()).toHaveLength(0);
    expect(doc.querySelector('.modal-scrim')).not.toBeNull();
    expect(title().value).toBe('中文标题');
  });

  it('基线：非组合 Enter ⇒ 发出创建请求（一次）', async () => {
    await open();
    type(title(), '中文标题');
    key(title(), PLAIN);
    await until(() => createCalls().length > 0, 'the create-session POST');
    expect(createCalls()).toHaveLength(1);
  });
});

describe('W2033 · ui/providers/modelrow.ts 自定义推理档位输入框', () => {
  async function open(): Promise<ElLike> {
    const m = (await import(/* @vite-ignore */ at('ui/providers/modelrow.ts'))) as {
      addModelRow(e: unknown, id?: string, name?: string): void;
    };
    const box = doc.createElement('div') as ElLike;
    box.id = 'w2033Models';
    doc.body.appendChild(box);
    m.addModelRow({ modelsBox: box, rows: [], onLayout: () => {} }, 'perf-model', 'Perf');
    (box.querySelector('.prov-effort-chips .btn-mini') as ElLike).click();
    await flush();
    return box.querySelector('.prov-effort-chips input.cfg-input') as ElLike;
  }

  it('组合中 Enter ⇒ 不收框、不新增档位片', async () => {
    const tier = await open();
    const base = chips();
    type(tier, '中文档位');
    key(tier, IME);
    await flush();
    key(tier, IME_229);
    await flush();
    expect(tier.hidden).toBe(false);
    expect(chips()).toEqual(base);
    expect(tier.value).toBe('中文档位');
  });

  it('基线：非组合 Enter ⇒ 收框并按内容新增一枚档位片', async () => {
    const tier = await open();
    type(tier, '中文档位');
    key(tier, PLAIN);
    await flush();
    expect(tier.hidden).toBe(true);
    expect(chips()).toContain('中文档位');
  });
});

describe('W2033 · ui/workbench/browser.ts URL 框', () => {
  async function open(): Promise<{ input: ElLike; data: () => unknown; frame: () => ElLike | null }> {
    const st = (await import(/* @vite-ignore */ at('ui/workbench/browser.ts'))) as {
      renderBrowserPanel(body: ElLike, panel: unknown, isCurrent: (id: string, seq: number) => boolean): void;
      setLoadTimeout(ms: number): void;
    };
    st.setLoadTimeout(50);
    const body = doc.createElement('div') as ElLike;
    body.id = 'w2033Browser';
    doc.body.appendChild(body);
    const panel: Record<string, unknown> = { id: 'w2033', kind: 'browser', title: 'W2033', dock: 'right', size: 300, seq: 0 };
    st.renderBrowserPanel(body, panel, () => true);
    await flush();
    return {
      input: body.querySelector('.wb-url-input') as ElLike,
      data: () => (panel['data'] as { url?: string } | undefined)?.url,
      frame: () => body.querySelector('.wb-frame') as ElLike | null,
    };
  }

  it('组合中 Enter ⇒ 不导航（面板数据与 iframe 都不动）', async () => {
    const v = await open();
    type(v.input, '中文.example');
    key(v.input, IME);
    await flush();
    key(v.input, IME_229);
    await flush();
    expect(v.data()).toBeUndefined();
    expect(v.frame()?.getAttribute('src')).toBeNull();
    expect(v.input.value).toBe('中文.example');
  });

  it('基线：非组合 Enter ⇒ 导航（面板数据 + iframe.src 都写成归一化 URL）', async () => {
    const v = await open();
    type(v.input, '中文.example');
    key(v.input, PLAIN);
    await flush();
    expect(v.data()).toBe('https://中文.example');
    expect(v.frame()?.getAttribute('src')).toBe('https://中文.example');
  });
});
