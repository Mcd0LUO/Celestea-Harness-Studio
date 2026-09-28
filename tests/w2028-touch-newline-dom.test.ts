// @vitest-environment jsdom
/**
 * W2028 · 触摸设备的 Enter 必须能插入换行（本轮修的**真功能缺失**）。
 *
 * 缺陷（真机复现，390x844 + Emulation.setTouchEmulationEnabled）：inputbar 的 keydown
 *   把**所有**不带 shiftKey 的 Enter 都 preventDefault 掉改走发送，而软键盘 Enter 的
 *   shiftKey 恒为 false（触摸设备没有 Shift 键）⇒ 触摸端用户根本插不进换行。
 *
 * 修法（照微信 / iMessage）：触摸端 Enter = 换行、发送只走 #btnSend（它恒在输入栏的
 *   可见位置）；桌面端逐字不变（Enter 发送 / Shift+Enter 换行 / Ctrl-Cmd+Enter 切车道）。
 *   判定与插入在 apps/web/src/ui/inputbar/newline.ts。
 *
 * 本文件钉住五件事（每条都有对应的变异负控制，见报告）：
 *   ① 触摸端：无 shiftKey 的 Enter **插入换行**且不发送；
 *   ② 触摸端：#btnSend 点击仍发送（换行之后的整段文本一起发出）；
 *   ③ 桌面端：无 shiftKey 的 Enter 仍发送、Shift+Enter 仍不发送、Ctrl/Cmd+Enter 仍切车道；
 *   ④ enterkeyhint 与行为同源（触摸 enter / 桌面 send），能力位翻转后跟着变；
 *   ⑤ 桌面文案逐字不变（W2023 的回归护栏在本轮同样成立）。
 *
 * 判定真源是 ui/viewport.ts 的 isTouchInput()（(pointer: coarse) + maxTouchPoints）。
 * jsdom 没有 matchMedia（实测 undefined），故这里注入可控实现 —— 测的是本仓的判定与
 * 分流，不是 jsdom 的媒体查询引擎（与 tests/w2023-mobile-hint-dom.test.ts 同一套桩）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness } from './lib/w795-dom.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(HERE, '..', 'apps', 'web', 'index.html');

/** 改动前的桌面原文（从 git HEAD 抄录，逐字比对用）。 */
const DESKTOP_ZH_IDLE = '输入消息，Enter 发送，Shift+Enter 换行';

/** 可控的媒体查询桩：coarse 决定 (pointer: coarse)，其余查询恒 false。 */
interface MqStub { coarse: boolean; touchPoints: number; listeners: Array<() => void> }
const mq: MqStub = { coarse: false, touchPoints: 0, listeners: [] };

/** 翻转能力位并通知监听者（模拟 DevTools 设备仿真开关 / 二合一插拔鼠标）。 */
function setCapability(coarse: boolean, touchPoints: number): void {
  mq.coarse = coarse;
  mq.touchPoints = touchPoints;
  for (const cb of [...mq.listeners]) cb();
}

function installMatchMedia(): void {
  mq.listeners = [];
  const impl = (query: string) => ({
    matches: query.includes('pointer: coarse') ? mq.coarse : false,
    media: query,
    addEventListener: (_: string, cb: () => void) => { mq.listeners.push(cb); },
    removeEventListener: () => {},
  });
  vi.stubGlobal('matchMedia', impl);
  vi.stubGlobal('navigator', { get maxTouchPoints() { return mq.touchPoints; } });
}

/** 测试用的事件/元素形状（根 tsconfig 无 DOM lib，一律经 globalThis 取，见 w795-dom）。 */
interface KeyEventLike { defaultPrevented: boolean }
interface InputLike {
  value: string;
  placeholder: string;
  enterKeyHint: string;
  selectionStart: number;
  selectionEnd: number;
  setSelectionRange(a: number, b: number): void;
  dispatchEvent(e: unknown): boolean;
}
interface BtnLike { click(): void; title: string; getAttribute(k: string): string | null }
interface BarMod {
  initInputBar(h: { send(t: string, m: string): void; cancel(): void }): void;
  setSubmitMode(m: string): void;
  setInputMode(m: string): void;
}
interface I18nMod { setLocale(l: string): void }

const KB = (globalThis as unknown as {
  KeyboardEvent: new (t: string, i?: Record<string, unknown>) => KeyEventLike;
}).KeyboardEvent;

/** 派发一次 keydown，返回事件本身（看 defaultPrevented）。 */
function press(el: InputLike, init: Record<string, unknown>): KeyEventLike {
  const e = new KB('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

const inputEl = (): InputLike => doc.getElementById('input') as unknown as InputLike;
const sendBtn = (): BtnLike => doc.getElementById('btnSend') as unknown as BtnLike;

/** 记录 send 调用的 (text, lane) 二元组。 */
type Sends = Array<[string, string]>;

async function boot(locale: string): Promise<BarMod> {
  const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as I18nMod;
  i18n.setLocale(locale);
  const bar = (await import(/* @vite-ignore */ at('ui/inputbar.ts'))) as BarMod;
  return bar;
}

/** 装配真实输入栏，返回它调 send 的记录。 */
async function mount(locale: string, sends: Sends): Promise<BarMod> {
  const bar = await boot(locale);
  bar.initInputBar({ send: (t, m) => sends.push([t, m]), cancel: () => {} });
  return bar;
}

/** 在输入框里放一段文本并把光标放到末尾。 */
function type(text: string): InputLike {
  const el = inputEl();
  el.value = text;
  el.setSelectionRange(text.length, text.length);
  return el;
}

const bodyOf = (html: string): string => {
  const m = /<body>([\s\S]*)<\/body>/.exec(html);
  if (!m || m[1] === undefined) throw new Error('index.html 里找不到 <body>…</body>');
  return m[1];
};

describe('W2028 · 触摸端 Enter 换行', () => {
  beforeEach(() => {
    resetHarness();
    localStorage.clear();
    doc.body.innerHTML = bodyOf(readFileSync(INDEX_HTML, 'utf8'));
    installMatchMedia();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
    localStorage.clear();
  });

  it('触摸端：无 shiftKey 的 Enter 插入换行、不发送（并吃掉默认行为，防插两次）', async () => {
    setCapability(true, 5);
    const sends: Sends = [];
    await mount('zh', sends);
    const el = type('AAA');
    const e = press(el, { key: 'Enter', shiftKey: false });
    expect(JSON.stringify(el.value), '触摸端 Enter 必须插入换行').toBe(JSON.stringify('AAA\n'));
    expect(el.selectionStart, '光标落在换行之后').toBe(4);
    expect(sends, '触摸端 Enter 不得发送').toEqual([]);
    expect(e.defaultPrevented, '换行由我们插入 ⇒ 必须 preventDefault（否则浏览器可能再插一个）').toBe(true);
  });

  it('触摸端：外接键盘的 Shift+Enter 仍换行（不动默认行为，交浏览器插入）', async () => {
    setCapability(true, 5);
    const sends: Sends = [];
    await mount('zh', sends);
    const el = type('AAA');
    const e = press(el, { key: 'Enter', shiftKey: true });
    expect(sends, 'Shift+Enter 不发送').toEqual([]);
    expect(e.defaultPrevented, '保留浏览器默认 = 由浏览器插入换行').toBe(false);
  });

  it('触摸端：Ctrl+Enter 仍切另一条车道（没有 Shift 的键盘也有键盘发送路径）', async () => {
    setCapability(true, 5);
    const sends: Sends = [];
    const bar = await mount('zh', sends);
    type('AAA');
    press(inputEl(), { key: 'Enter', ctrlKey: true });
    expect(sends, 'Ctrl+Enter 走另一条车道（默认 steer ⇒ queue）').toEqual([['AAA', 'queue']]);
    bar.setSubmitMode('queue');
    type('BBB');
    press(inputEl(), { key: 'Enter', ctrlKey: true });
    expect(sends[1], '再切回 steer').toEqual(['BBB', 'steer']);
  });

  it('触摸端：换行之后点 #btnSend 仍能发出整段（含换行）—— 发送路径没丢', async () => {
    setCapability(true, 5);
    const sends: Sends = [];
    await mount('zh', sends);
    const el = type('AAA');
    press(el, { key: 'Enter', shiftKey: false });
    expect(JSON.stringify(el.value)).toBe(JSON.stringify('AAA\n'));
    sendBtn().click();
    expect(sends, '#btnSend 是触摸端唯一发送路径').toEqual([['AAA\n', 'steer']]);
  });

  it('触摸端：IME 组合中的 Enter 不插换行、不吞默认行为（中文输入法确认候选词）', async () => {
    setCapability(true, 5);
    const sends: Sends = [];
    await mount('zh', sends);
    const el = type('ni');
    const e = press(el, { key: 'Enter', isComposing: true });
    // 真机实测（Chromium + Input.imeSetComposition）：组合中按 Enter 浏览器自己会插入
    // 一个换行 ⇒ 这里再插一个，用户每确认一次候选词就多一个空行。
    expect(JSON.stringify(el.value), '组合中不得由我们插入换行').toBe(JSON.stringify('ni'));
    expect(e.defaultPrevented, '组合中的按键归 IME，不许 preventDefault').toBe(false);
    expect(sends, '组合中不发送').toEqual([]);
  });

  it('桌面：IME 组合中的 Enter 与改动前逐字相同（仍走发送 —— 本轮刻意不动它）', async () => {
    setCapability(false, 0);
    const sends: Sends = [];
    await mount('zh', sends);
    type('ni');
    press(inputEl(), { key: 'Enter', isComposing: true });
    expect(sends, '桌面组合中的 Enter 是既有行为，不在本轮范围内').toEqual([['ni', 'steer']]);
  });

  it('触摸端：enterkeyhint=enter（软键盘回车键上的字与行为同源）', async () => {
    setCapability(true, 5);
    await mount('zh', []);
    expect(inputEl().enterKeyHint, '行为是换行 ⇒ 键上写「换行」').toBe('enter');
  });

  it('触摸端：占位符教的是 Enter 换行 + 点发送键，且不提 Shift（W2023 语义延续）', async () => {
    setCapability(true, 5);
    await mount('zh', []);
    const ph = inputEl().placeholder;
    expect(ph, '占位符不得再教「Enter 发送」').not.toContain('Enter 发送');
    expect(ph, '占位符必须提换行').toContain('换行');
    expect(ph, '触摸端不得提 Shift').not.toContain('Shift');
    const title = sendBtn().title;
    expect(title, '发送键是触摸端唯一发送路径 ⇒ 标题不得再说「（Enter）」').not.toContain('Enter');
    expect(title.length).toBeGreaterThan(0);
  });

  it('触摸端：插话/排队两档的文案也不得教「Enter …」（Enter 已不是发送）', async () => {
    setCapability(true, 5);
    const bar = (await mount('zh', [])) as BarMod & { setSubmitMode(m: string): void };
    bar.setInputMode('interject');
    const seen: string[] = [];
    for (const lane of ['steer', 'queue']) {
      bar.setSubmitMode(lane);
      seen.push(lane + '|' + inputEl().placeholder);
    }
    const modeBtn = doc.getElementById('btnMode') as unknown as { title: string } | null;
    const bad = seen.filter((s) => s.includes('Enter'));
    expect(bad, '触摸端插话/排队档位仍在教 Enter').toEqual([]);
    expect(seen.every((s) => s.split('|')[1]?.includes('发送键')), '两档都要指向发送键').toBe(true);
    if (modeBtn) {
      expect(modeBtn.title, '车道键标题同样不得教 Enter').not.toContain('Enter');
    }
  });
});

describe('W2028 · 桌面端逐字不变', () => {
  beforeEach(() => {
    resetHarness();
    localStorage.clear();
    doc.body.innerHTML = bodyOf(readFileSync(INDEX_HTML, 'utf8'));
    installMatchMedia();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
    localStorage.clear();
  });

  it('桌面：无 shiftKey 的 Enter 仍发送（值与改动前逐字相同）', async () => {
    setCapability(false, 0);
    const sends: Sends = [];
    await mount('zh', sends);
    const el = type('AAA');
    const e = press(el, { key: 'Enter', shiftKey: false });
    expect(sends).toEqual([['AAA', 'steer']]);
    expect(e.defaultPrevented, '发送路径必须吃掉默认行为').toBe(true);
    expect(JSON.stringify(el.value), '桌面 Enter 不改输入框内容').toBe(JSON.stringify('AAA'));
  });

  it('桌面：Shift+Enter 仍换行（不发送、不动默认行为）', async () => {
    setCapability(false, 0);
    const sends: Sends = [];
    await mount('zh', sends);
    const el = type('AAA');
    const e = press(el, { key: 'Enter', shiftKey: true });
    expect(sends).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  it('桌面：Ctrl/Cmd+Enter 仍走另一条车道（且**不改**当前车道，与改动前逐字相同）', async () => {
    setCapability(false, 0);
    const sends: Sends = [];
    const bar = await mount('zh', sends);
    type('AAA');
    press(inputEl(), { key: 'Enter', ctrlKey: true });
    press(inputEl(), { key: 'Enter', metaKey: true });
    // 改动前的语义：Ctrl/Cmd+Enter **只**把这一条投到另一条车道，不切换当前车道
    // （两次都发到 queue，因为当前车道始终是 steer）。
    expect(sends).toEqual([['AAA', 'queue'], ['AAA', 'queue']]);
    bar.setSubmitMode('queue');
    type('BBB');
    press(inputEl(), { key: 'Enter', metaKey: true });
    expect(sends[2], '当前车道是 queue ⇒ 另一条是 steer').toEqual(['BBB', 'steer']);
  });

  it('桌面：enterkeyhint=send，占位符与发送键标题逐字不变', async () => {
    setCapability(false, 0);
    await mount('zh', []);
    expect(inputEl().enterKeyHint).toBe('send');
    expect(inputEl().placeholder, '桌面占位符（zh）').toBe(DESKTOP_ZH_IDLE);
    expect(sendBtn().title, '桌面发送键标题仍带（Enter）').toContain('（Enter）');
  });
});

describe('W2028 · 能力位翻转与分流真源', () => {
  beforeEach(() => {
    resetHarness();
    localStorage.clear();
    doc.body.innerHTML = bodyOf(readFileSync(INDEX_HTML, 'utf8'));
    installMatchMedia();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
    localStorage.clear();
  });

  it('桌面打开页面 → 插上触摸屏（能力位翻转）后 Enter 变成换行、hint 跟着变', async () => {
    setCapability(false, 0);
    const sends: Sends = [];
    await mount('zh', sends);
    expect(inputEl().enterKeyHint).toBe('send');
    setCapability(true, 5); // DevTools 打开设备仿真 / 二合一拔掉鼠标
    expect(inputEl().enterKeyHint, 'hint 必须与行为一起翻').toBe('enter');
    const el = type('AAA');
    press(el, { key: 'Enter', shiftKey: false });
    expect(JSON.stringify(el.value), '翻转后 Enter 插入换行').toBe(JSON.stringify('AAA\n'));
    expect(sends, '翻转后 Enter 不再发送').toEqual([]);
    setCapability(false, 0); // 翻回桌面
    expect(inputEl().enterKeyHint).toBe('send');
    const el2 = type('BBB');
    press(el2, { key: 'Enter', shiftKey: false });
    expect(sends, '翻回桌面后 Enter 恢复发送').toEqual([['BBB', 'steer']]);
  });

  it('判定真源是能力位（isTouchInput），不是布局宽度', async () => {
    const vp = (await import(/* @vite-ignore */ at('ui/viewport.ts'))) as {
      isTouchInput(): boolean;
      isMobileViewport(): boolean;
    };
    setCapability(true, 5);
    expect(vp.isTouchInput(), '触摸设备').toBe(true);
    setCapability(false, 0);
    expect(vp.isTouchInput(), '桌面（含窄窗口）').toBe(false);
  });
});
