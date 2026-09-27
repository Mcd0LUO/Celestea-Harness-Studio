// @vitest-environment jsdom
/**
 * W2023 · 触摸设备的输入提示不得教用户按 Shift。
 *
 * 缺陷（真机复现，390x844 + Emulation.setTouchEmulationEnabled）：
 *   空闲占位符与空态引导都写「Shift+Enter 换行」，而触摸设备**没有 Shift 键** ——
 *   软键盘 Enter 的 shiftKey 恒为 false（真机实测：按下去直接 POST /api/turn 发送，
 *   输入框被清空）。于是这两条提示在触摸端教不会用户任何东西。
 *
 * 本文件把三件事变成机械断言：
 *   ① 触摸能力下，占位符与空态引导**不含 Shift**；
 *   ② 桌面能力下，两者与改动前**逐字相同**（回归护栏：桌面一个字都不许变）；
 *   ③ 能力位翻转（coarse pointer 变化）后文案会重画（不是只算一次）。
 *
 * 判定真源是 apps/web/src/ui/viewport.ts 的 isTouchInput()：它读
 * `(pointer: coarse)` + navigator.maxTouchPoints。jsdom 没有 matchMedia
 * （实测 typeof window.matchMedia === 'undefined'），故这里注入一个可控实现 ——
 * 测的是**本仓的判定与分流**，不是 jsdom 的媒体查询引擎。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness } from './lib/w795-dom.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(HERE, '..', 'apps', 'web', 'index.html');

/** 改动前的桌面原文（从 git HEAD 抄录，逐字比对用）。 */
const DESKTOP_ZH = {
  hint: '在下方输入消息开始对话 · Enter 发送 · Shift+Enter 换行',
  idle: '输入消息，Enter 发送，Shift+Enter 换行',
};
const DESKTOP_EN = {
  hint: 'Type a message below to start · Enter to send · Shift+Enter for a new line',
  idle: 'Type a message; Enter to send, Shift+Enter for a new line',
};

/** 可控的媒体查询桩：`coarse` 决定 (pointer: coarse)，其余查询恒 false。 */
interface MqStub {
  coarse: boolean;
  touchPoints: number;
  /** 视口是否 ≤640px（(max-width: 640px) 的桩值）。 */
  narrow: boolean;
  listeners: Array<() => void>;
}
const mq: MqStub = { coarse: false, touchPoints: 0, narrow: false, listeners: [] };

/** 翻转能力位并通知监听者（模拟 DevTools 设备仿真开关 / 二合一插拔鼠标）。 */
function setCapability(coarse: boolean, touchPoints: number): void {
  mq.coarse = coarse;
  mq.touchPoints = touchPoints;
  for (const cb of [...mq.listeners]) cb();
}

/**
 * 装 matchMedia + navigator 桩。
 *
 * 根 tsconfig 的 lib 是 `["ES2023"]`（无 DOM），所以测试文件里不能直接写
 * window/navigator —— 本仓约定是经 `globalThis as unknown as {…}` 取（见
 * tests/frontend-batch-a-dom.ts 的 doc/Ev 写法）。jsdom 环境里 globalThis 就是 window。
 */
function installMatchMedia(): void {
  mq.listeners = [];
  const impl = (query: string) => ({
    matches: query.includes('pointer: coarse') ? mq.coarse : query.includes('max-width') ? mq.narrow : false,
    media: query,
    addEventListener: (_: string, cb: () => void) => { mq.listeners.push(cb); },
    removeEventListener: () => {},
  });
  vi.stubGlobal('matchMedia', impl);
  // maxTouchPoints 用 getter ⇒ 永远反映当前 mq.touchPoints（不必重装桩）。
  vi.stubGlobal('navigator', { get maxTouchPoints() { return mq.touchPoints; } });
}

interface InputBarMod {
  initInputBar(h: { send(t: string, m: string): void; cancel(): void }): void;
  setInputMode(m: string): void;
}
interface ViewCtxMod {
  initViewCtx(): { hint: { querySelector(s: string): { textContent: string | null } | null } };
}
interface I18nMod { setLocale(l: string): void }

const bodyOf = (html: string): string => {
  const m = /<body>([\s\S]*)<\/body>/.exec(html);
  if (!m || m[1] === undefined) throw new Error('index.html 里找不到 <body>…</body>');
  return m[1];
};

const placeholder = (): string =>
  (doc.getElementById('input') as unknown as { placeholder: string }).placeholder;
const emptySub = (): string =>
  doc.querySelector('.empty-sub')?.textContent ?? '';

async function boot(locale: string): Promise<void> {
  const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as I18nMod;
  i18n.setLocale(locale);
}

/** 装配输入栏（真实 initInputBar：占位符由它按模式写）。 */
async function mountInputBar(): Promise<void> {
  const bar = (await import(/* @vite-ignore */ at('ui/inputbar.ts'))) as InputBarMod;
  bar.initInputBar({ send: () => {}, cancel: () => {} });
}

/** 装配视图容器（真实 initViewCtx：空态由它画）。 */
async function mountViewCtx(): Promise<void> {
  const ctx = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
  ctx.initViewCtx();
}

describe('W2023 · 触摸设备输入提示', () => {
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

  it('触摸能力（coarse + 触摸点）：占位符与空态引导都不含 Shift', async () => {
    setCapability(true, 5);
    await boot('zh');
    await mountInputBar();
    await mountViewCtx();
    // 先证明夹具真的装上了（否则「不含 Shift」可能只是空跑）。
    expect(placeholder(), '占位符必须非空').not.toBe('');
    expect(emptySub(), '空态引导必须非空').not.toBe('');
    expect(placeholder(), '触摸端占位符不得提 Shift').not.toContain('Shift');
    expect(emptySub(), '触摸端空态引导不得提 Shift').not.toContain('Shift');
    // Enter 仍要教（那是触摸端真实可用的键）。
    expect(placeholder()).toContain('Enter');
    expect(emptySub()).toContain('Enter');
  });

  it('触摸能力 · 英文：同样不含 Shift', async () => {
    setCapability(true, 5);
    await boot('en');
    await mountInputBar();
    await mountViewCtx();
    expect(placeholder()).not.toContain('Shift');
    expect(emptySub()).not.toContain('Shift');
    expect(placeholder()).toContain('Enter');
    expect(emptySub()).toContain('Enter');
  });

  it('桌面能力：占位符与空态引导与改动前**逐字相同**', async () => {
    setCapability(false, 0);
    await boot('zh');
    await mountInputBar();
    await mountViewCtx();
    expect(placeholder(), '桌面占位符（zh）').toBe(DESKTOP_ZH.idle);
    expect(emptySub(), '桌面空态引导（zh）').toBe(DESKTOP_ZH.hint);
  });

  it('桌面能力 · 英文：与改动前逐字相同', async () => {
    setCapability(false, 0);
    await boot('en');
    await mountInputBar();
    await mountViewCtx();
    expect(placeholder(), '桌面占位符（en）').toBe(DESKTOP_EN.idle);
    expect(emptySub(), '桌面空态引导（en）').toBe(DESKTOP_EN.hint);
  });

  it('能力位翻转：桌面 → 触摸后占位符与空态引导都会重画', async () => {
    setCapability(false, 0);
    await boot('zh');
    await mountInputBar();
    await mountViewCtx();
    expect(placeholder()).toBe(DESKTOP_ZH.idle); // 装配时是桌面文案
    setCapability(true, 5); // 用户打开设备仿真 / 拔掉鼠标
    expect(placeholder(), '翻转后占位符必须更新').not.toContain('Shift');
    expect(emptySub(), '翻转后空态引导必须更新').not.toContain('Shift');
    setCapability(false, 0); // 再翻回去
    expect(placeholder(), '翻回桌面必须还原').toBe(DESKTOP_ZH.idle);
    expect(emptySub(), '翻回桌面必须还原').toBe(DESKTOP_ZH.hint);
  });

  it('插话 / 排队 / worker 三档在触摸端也不含 Shift（原本就不含，防回归）', async () => {
    setCapability(true, 5);
    await boot('zh');
    await mountInputBar();
    const bar = (await import(/* @vite-ignore */ at('ui/inputbar.ts'))) as InputBarMod & {
      setSubmitMode(m: string): void;
    };
    const seen: string[] = [];
    for (const mode of ['idle', 'interject', 'worker']) {
      bar.setInputMode(mode);
      for (const lane of ['steer', 'queue']) {
        bar.setSubmitMode(lane);
        seen.push(mode + '/' + lane + ': ' + placeholder());
      }
    }
    const bad = seen.filter((s) => s.includes('Shift'));
    expect(bad, '触摸端出现 Shift 的档位').toEqual([]);
    expect(seen.every((s) => s.split(': ')[1]?.trim() !== ''), 'placeholder 不得为空').toBe(true);
  });

  it('判定真源：isTouchInput 只在「粗指针 + 有触摸点」时为真', async () => {
    const vp = (await import(/* @vite-ignore */ at('ui/viewport.ts'))) as {
      isTouchInput(): boolean;
      isMobileViewport(): boolean;
    };
    setCapability(false, 0);
    expect(vp.isTouchInput(), '桌面鼠标').toBe(false);
    setCapability(true, 0);
    expect(vp.isTouchInput(), '粗指针但无触摸点（异常组合）').toBe(false);
    setCapability(true, 5);
    expect(vp.isTouchInput(), '触摸设备').toBe(true);
  });

  it('两个判定互不替代：窄桌面有 Shift，宽触摸设备没有', async () => {
    const vp = (await import(/* @vite-ignore */ at('ui/viewport.ts'))) as {
      isTouchInput(): boolean;
      isMobileViewport(): boolean;
    };
    // 500px 窄桌面：移动布局，但有物理 Shift 键 ⇒ 文案必须是桌面版。
    setCapability(false, 0);
    mq.narrow = true;
    expect(vp.isMobileViewport(), '窄桌面属于移动布局档').toBe(true);
    expect(vp.isTouchInput(), '窄桌面仍有 Shift 键').toBe(false);
    await boot('zh');
    await mountInputBar();
    expect(placeholder(), '窄桌面必须保留 Shift 提示').toBe(DESKTOP_ZH.idle);
  });
});
