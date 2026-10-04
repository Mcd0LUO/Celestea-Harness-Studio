// @vitest-environment jsdom
// 根 tsconfig 的 lib 里**没有** DOM（jsdom 只在运行时提供 window）⇒ 一律用 globalThis，
// 与 tests/lib/w795-dom.ts 的做法一致（它也用 `globalThis as unknown as {...}`）。
/**
 * W9336 验收：「回到底部」浮标（apps/web/src/ui/messages/jump.ts）。
 *
 * 被守的后果（每条都问过「它红的时候，是产品坏了，还是我换了实现？」）：
 *   ① 出现 / 消失是**两个阈值**：离开底部 > JUMP_SHOW_PX 才出现，回到「贴底带」
 *      （AT_BOTTOM_PX）才消失 —— 轻轻一滚不弹浮标，出现后也不会在临界点闪；
 *   ② 数字 = **它出现之后**新增的消息数（出现之前已有的一个都不算），为 0 时
 *      **不显示数字**（徽标空且被 .hidden 摘掉）；
 *   ③ 点击：平滑（逐帧、单调向下、落点贴底）；`prefers-reduced-motion: reduce` 下
 *      **一个动画帧都不排**、一次写到位；
 *   ④ 键盘可达：控件是**原生 `<button type=button>`**（Tab 天然可达、Enter/Space 由
 *      浏览器翻成 click —— 故这里只断言「是原生 button + click 路径正确」）；
 *      焦点环由 styles/jump.css 的 `:focus-visible` 给（从 CSS 解析出来断言）；
 *   ⑤ 中英双语走既有 i18n：两条 key 在两语字典里都真实存在、两语不同，且可访问名
 *      随条数变化（0 条 = 按钮名；n 条 = 名字 + 条数）；
 *   ⑥ **既有行为不被破坏**：贴底时新消息仍自动跟随（闩锁语义一字未改）；用户上滚后
 *      浮标的出现**不写任何滚动位**（不把人拽回底部，W12）；多会话切走再切回，
 *      浮标记得该容器的基线（数字不从 0 重数）。
 *
 * 量不了的（真焦点环的可视像素、Tab 的实际停靠、原生 Enter/Space 的真实按键路径、
 * 平滑滚动的动画相位）按本仓铁律 11 移到真机探针 scripts/a11y/w9336-jump-probe.mjs：
 * 那里用 CDP 派发真实按键 + 逐帧采 scrollTop。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flush, flushRaf, rafStub, resetHarness, type ElLike } from './lib/w795-dom.js';

/**
 * shim 的 `ElLike` 故意很窄（只有结构与事件），本文件要读写滚动位 ⇒ 本地加宽。
 * 与 W9334 的 `PaneLike` 同一做法：**在测试里声明自己用到的形状**，而不是去改公共 shim
 * （改公共 shim 会让所有 120 个使用者一起承担）。
 */
interface ScrollElLike extends ElLike {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

const LIVE = 'ws/s1';
const STYLES = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'src', 'styles');

interface JumpMod {
  initJumpBottom(): void;
  toBottom(pane: unknown): void;
  JUMP_SHOW_PX: number;
  messageCount(pane: unknown): number;
  distanceFromBottom(el: unknown): number;
}
interface PaneLike { el: ElLike }
interface ViewMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): PaneLike;
  activatePane(id: string, kind?: string, title?: string): unknown;
}
interface MsgMod {
  appendThinking(ctx: unknown, delta: string): void;
  flushThinkSegment(ctx: unknown): void;
}
interface ScrollMod { autoscroll(ctx: unknown, force?: boolean): void; autoscrollSoon(ctx: unknown): void }
interface I18nMod { localeDict(l: string): Record<string, string>; setLocale(l: string): void }

/** 可控几何：jsdom 没有布局，滚动三件套必须自己定义（与 w1467 / w9300 的垫片同语义）。 */
interface Geo {
  el: ElLike;
  grow(px: number): void;
  gapTo(gap: number): void;
  top(): number;
  gap(): number;
}

const load = async <T>(rel: string): Promise<T> => (await import(/* @vite-ignore */ at(rel))) as unknown as T;
const loadJump = (): Promise<JumpMod> => load<JumpMod>('ui/messages/jump.ts');
const loadMsgs = (): Promise<MsgMod> => load<MsgMod>('ui/messages.ts');
const loadScroll = (): Promise<ScrollMod> => load<ScrollMod>('ui/messages/scroll.ts');

const btn = (): ElLike | null => doc.querySelector('.jump-bottom');
const numEl = (): ElLike | null => doc.querySelector('.jump-bottom-count');
const label = (): string => btn()?.getAttribute('aria-label') ?? '';
/** 全局 .hidden 是 display:none !important ⇒ 类在 = 不可见（base.css 的唯一真源）。 */
const shown = (): boolean => btn() !== null && !(btn() as ElLike).classList.contains('hidden');
const numeral = (): string => {
  const n = numEl();
  return n === null || n.classList.contains('hidden') ? '' : (n.textContent ?? '');
};
/** 容器里直接子节点中的 .mcol 数（**独立**于被测模块的自算，用于对拍）。 */
const colsIn = (el: ElLike): number =>
  Array.from((el as unknown as { children: ArrayLike<ElLike> }).children).filter((c) =>
    c.classList.contains('mcol'),
  ).length;

/** 给真实容器装上可控几何（写 scrollTop 被钳制，且**真的变了**才派发 scroll）。 */
function withGeometry(el: ElLike, client: number, content: number): Geo {
  let top = 0;
  let height = content;
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => client });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      const next = Math.min(Math.max(0, Math.round(v)), Math.max(0, height - client));
      const moved = next !== top;
      top = next;
      if (moved) el.dispatchEvent(new Ev('scroll'));
    },
  });
  return {
    el,
    grow: (px) => { height += px; },
    gapTo: (gap) => { (el as unknown as ScrollElLike).scrollTop = height - client - gap; },
    top: () => top,
    gap: () => Math.max(0, height - client - top),
  };
}

interface Booted { J: JumpMod; pane: PaneLike; geo: Geo }

/**
 * 装配真路径：真 viewctx（真 SessionPane）+ 真 scroll.ts 的装配调用（它才是滚动监听与
 * 闩锁的安装点 —— 真实应用在渲染首屏时就调过它）+ 真 jump。
 * 顺序：先摆几何 → 激活（排空它那一帧）→ 装闩锁 → 按 gap 摆位（派发 scroll ⇒ 解锁）。
 */
async function boot(opts: { client?: number; content?: number; gap?: number } = {}): Promise<Booted> {
  const client = opts.client ?? 300;
  const content = opts.content ?? 4000;
  const V = await load<ViewMod>('ui/viewctx.ts');
  V.initViewCtx();
  const pane = V.ensurePane(LIVE, 'session', '甲会话');
  const geo = withGeometry(pane.el, client, content);
  V.activatePane(LIVE, 'session', '甲会话');
  flushRaf();
  (await loadScroll()).autoscroll(pane); // 既有渲染路径的装配点（装上 scroll 监听 + 闩锁基线）
  geo.gapTo(opts.gap ?? 0);
  return { J: await loadJump(), pane, geo };
}

/**
 * 走**真实消息路径**追加一列（思考段 + 收段 ⇒ 下一次 appendThinking 开新的一列）。
 *
 * 两次让步都是必需的，少一次断言就会读到上一帧的态：
 *   ① `await flush(1)` —— MutationObserver 的回调投递在**微任务**里，本函数的后续
 *      代码与突变处在同一个 job；不让出一次，观察器根本还没被调用；
 *   ② `frames(1)` —— 观察器只是**排帧**（queueSync），判定发生在下一帧。
 */
async function addColumn(b: Booted): Promise<void> {
  const M = await loadMsgs();
  M.appendThinking(b.pane, '推理…');
  M.flushThinkSegment(b.pane);
  await flush(1);
  frames(1);
}

/** 推进 n 帧（每帧 16ms）或直到动画收口。 */
function frames(n: number): void {
  for (let i = 0; i < n; i += 1) {
    clock += 16;
    flushRaf();
  }
}

let clock = 0;

beforeEach(() => {
  resetHarness();
  vi.stubGlobal('requestAnimationFrame', rafStub); // 逐帧动画由测试自己推进
  clock = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('W9336 ① 出现 / 消失的两个阈值', () => {
  it('贴底不出现；滚离超过 JUMP_SHOW_PX 才出现；回到贴底带才消失', async () => {
    const b = await boot({ gap: 0 });
    b.J.initJumpBottom();
    expect(shown(), '贴底时不该有浮标').toBe(false);
    expect(b.J.distanceFromBottom(b.geo.el)).toBe(0);

    b.geo.gapTo(b.J.JUMP_SHOW_PX - 1);
    expect(shown(), '还差 1px：不该出现').toBe(false);

    b.geo.gapTo(b.J.JUMP_SHOW_PX + 1);
    expect(shown(), '越过阈值：必须出现').toBe(true);

    b.geo.gapTo(60); // 阈值内、贴底带外 = 滞回区
    expect(shown(), '滞回区内不该闪掉').toBe(true);

    b.geo.gapTo(0);
    expect(shown(), '回到贴底带：必须消失').toBe(false);
  });

  it('列**内部**长高（子树 DOM 变化、scrollTop 没变）也会把浮标顶出来', async () => {
    const b = await boot({ gap: 0 });
    await addColumn(b); // 先有一条真实消息列
    b.J.initJumpBottom();
    expect(shown()).toBe(false);
    const col = Array.from((b.pane.el as unknown as { children: ArrayLike<ElLike> }).children).find((c) =>
      c.classList.contains('mcol'),
    ) as ElLike;
    col.appendChild(doc.createElement('div')); // 列内部变化：容器子节点一个没动
    b.geo.grow(600); // 它带来的高度（jsdom 没有布局，只能自己给）
    await flush(1); // 观察器的回调在微任务里
    frames(1); // 观察器把本帧的变化合并成一次判定
    expect(shown(), '展开 details / 图片加载完也会这样长高 —— 不能只认「多了一条列」').toBe(true);
  });
});

describe('W9336 ② 数字 = 出现之后新增的消息数', () => {
  it('基线排除已有消息；之后每来一条 +1；为 0 时不显示数字', async () => {
    const b = await boot({ gap: 0 });
    await addColumn(b);
    await addColumn(b); // 出现**之前**的两条
    b.geo.gapTo(400);
    b.J.initJumpBottom();
    expect(shown()).toBe(true);
    expect(numeral(), '刚出现时数字为 0 ⇒ 不显示').toBe('');
    expect(label(), '0 条时可访问名 = 按钮名').toBe('回到底部');

    await addColumn(b);
    expect(numeral(), '新增 1 条').toBe('1');
    expect(label(), '可访问名必须带上条数（读屏用户也要知道有新消息）').toContain('1');

    await addColumn(b);
    await addColumn(b);
    expect(numeral(), '累计 3 条').toBe('3');
    expect(colsIn(b.pane.el), '真实 DOM 里 2（基线）+ 3（新增）列').toBe(5);
    expect(b.J.messageCount(b.pane), '与模块的口径一致').toBe(5);
  });

  it('收起再出现 ⇒ 基线重置（数字从 0 重新数）', async () => {
    const b = await boot({ gap: 0 });
    b.J.initJumpBottom();
    b.geo.gapTo(400);
    await addColumn(b);
    expect(numeral()).toBe('1');
    b.geo.gapTo(0); // 回到底部 ⇒ 收起
    expect(shown()).toBe(false);
    b.geo.gapTo(400); // 再上滚 ⇒ 重新出现
    expect(shown()).toBe(true);
    expect(numeral(), '重新出现后基线 = 当下的列数 ⇒ 0').toBe('');
  });
});

describe('W9336 ③ 点击：平滑滚到底 / reduce 下直接跳', () => {
  it('平滑：逐帧推进（不是一步到位），单调向下，落点贴底', async () => {
    const b = await boot({ client: 300, content: 6000, gap: 700 });
    b.J.initJumpBottom();
    expect(shown()).toBe(true);
    const from = b.geo.top();
    (btn() as ElLike).dispatchEvent(new Ev('click', { bubbles: true }));
    const path: number[] = [];
    for (let i = 0; i < 40 && b.geo.gap() > 0; i += 1) {
      frames(1);
      path.push(b.geo.top());
    }
    expect(path.length, '必须真的分多帧走（否则不是平滑）').toBeGreaterThan(2);
    expect(path[0], '第一帧不该一步到底').toBeLessThan(6000 - 300);
    for (let i = 1; i < path.length; i += 1) expect(path[i]!).toBeGreaterThanOrEqual(path[i - 1]!);
    expect(b.geo.top()).toBeGreaterThan(from);
    expect(b.geo.gap(), '落点必须贴底').toBe(0);
    expect(shown(), '到底之后浮标收起').toBe(false);
  });

  it('滚动期间内容继续长高：动画追得上（最后一帧仍贴底）', async () => {
    const b = await boot({ client: 300, content: 6000, gap: 700 });
    b.J.initJumpBottom();
    (btn() as ElLike).dispatchEvent(new Ev('click', { bubbles: true }));
    for (let i = 0; i < 40 && b.geo.gap() > 0; i += 1) {
      b.geo.grow(120); // 流式：每帧底部再远 120px
      frames(1);
    }
    expect(b.geo.gap(), '内容继续长高也必须落在当前底部').toBe(0);
  });

  it('reduced-motion：不排任何动画帧，一次写到位', async () => {
    const b = await boot({ client: 300, content: 6000, gap: 700 });
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (q: string) => ({
        matches: q.includes('prefers-reduced-motion'),
        media: q,
        addEventListener() {},
        removeEventListener() {},
      }),
    });
    const scheduled: unknown[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: unknown) => scheduled.push(cb));
    b.J.initJumpBottom();
    expect(shown()).toBe(true);
    (btn() as ElLike).dispatchEvent(new Ev('click', { bubbles: true }));
    expect(b.geo.gap(), '同一次调用栈内就到到底').toBe(0);
    expect(scheduled, 'reduce 下不得排动画帧').toHaveLength(0);
    expect(shown(), '浮标立刻收起').toBe(false);
  });

  it('用户中途自己往上滚 ⇒ 动画把滚轮交还给他（不与他抢）', async () => {
    const b = await boot({ client: 300, content: 6000, gap: 700 });
    b.J.initJumpBottom();
    (btn() as ElLike).dispatchEvent(new Ev('click', { bubbles: true }));
    frames(1);
    const mid = b.geo.top();
    b.geo.gapTo(b.geo.gap() + 800); // 用户往上滚 800px
    const parked = b.geo.top();
    expect(parked).toBeLessThan(mid);
    frames(10);
    expect(b.geo.top(), '不得把用户拽回底部').toBe(parked);
  });
});

describe('W9336 ④ 键盘可达 + 焦点环（CSS 面）', () => {
  it('控件是原生 button（Tab 天然可达；Enter/Space 由浏览器翻成 click）', async () => {
    const b = await boot({ gap: 0 });
    b.J.initJumpBottom();
    const c = btn() as unknown as { tagName: string; type: string; tabIndex: number; disabled: boolean };
    expect(c.tagName).toBe('BUTTON');
    expect(c.type, 'type=button：不得在表单里当提交键').toBe('button');
    expect(c.tabIndex, '默认可聚焦').toBe(0);
    expect(c.disabled, '不得禁用').toBe(false);
    expect(numEl()?.getAttribute('aria-hidden'), '数字对读屏是装饰（否则同一个数念两遍）').toBe('true');
  });

  it('隐藏即不可 Tab 到（走 base.css 的全局 .hidden）', async () => {
    const b = await boot({ gap: 0 });
    b.J.initJumpBottom();
    expect(shown()).toBe(false);
    const base = readFileSync(join(STYLES, 'base.css'), 'utf8');
    expect(base, '.hidden 的语义由 base.css 定义（唯一真源）').toMatch(/\.hidden\s*\{\s*display:\s*none/);
  });

  it('styles/jump.css：:focus-visible 有可见焦点环，且引用焦点环 token', () => {
    const css = readFileSync(join(STYLES, 'jump.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const i = css.indexOf('.jump-bottom:focus-visible');
    expect(i, '找不到焦点环规则').toBeGreaterThanOrEqual(0);
    const body = css.slice(css.indexOf('{', i), css.indexOf('}', i));
    expect(body, '焦点环必须真的画出来').not.toMatch(/outline:\s*none/);
    expect(body, '必须用 --c-focus-ring（W2006 的对比度不变量）').toContain('var(--c-focus-ring)');
  });
});

describe('W9336 ⑤ 中英双语（既有 i18n 机制）', () => {
  it('两条 key 在两语字典里都存在、都非空、且两语不同', async () => {
    const I = await load<I18nMod>('i18n/index.ts');
    const zh = I.localeDict('zh');
    const en = I.localeDict('en');
    for (const k of ['chat.jump.label', 'chat.jump.new']) {
      expect(zh[k], k + ' 的中文').toBeTruthy();
      expect(en[k], k + ' 的英文').toBeTruthy();
      expect(zh[k], k + ' 必须真的两语不同').not.toBe(en[k]);
    }
    expect(zh['chat.jump.new'], '{n} 是插值位').toContain('{n}');
    expect(en['chat.jump.new']).toContain('{n}');
  });

  it('英文界面下画出来的是英文（语言切换在本仓是整页重载，故文案在画出时取）', async () => {
    const b = await boot({ gap: 0 });
    const I = await load<I18nMod>('i18n/index.ts');
    b.J.initJumpBottom();
    b.geo.gapTo(500);
    expect(label()).toBe('回到底部');
    I.setLocale('en');
    b.geo.gapTo(0); // 收起
    b.geo.gapTo(500); // 再出现 ⇒ 重画
    expect(label(), '英文界面下必须是英文').toBe('Back to bottom');
    I.setLocale('zh');
  });
});

describe('W9336 ⑥ 既有行为不被破坏', () => {
  it('贴底时新消息仍自动跟随（闩锁语义一字未改）', async () => {
    const b = await boot({ gap: 0 });
    const S = await loadScroll();
    b.J.initJumpBottom();
    b.geo.grow(500); // 流式长高
    S.autoscroll(b.pane); // 流式的贴底节拍
    expect(b.geo.gap(), '闩锁为真 ⇒ 仍贴底').toBe(0);
    expect(shown(), '贴底时不该有浮标').toBe(false);
  });

  it('用户上滚后：浮标出现本身不写滚动位（不把人拽回底部，W12）', async () => {
    const b = await boot({ gap: 900 });
    const S = await loadScroll();
    b.J.initJumpBottom();
    const parked = b.geo.top();
    expect(shown()).toBe(true);
    expect(b.geo.top(), '出现本身不动滚动位').toBe(parked);

    await addColumn(b); // 新的列（内部走非 force 的贴底节拍）
    S.autoscrollSoon(b.pane);
    frames(2);
    expect(b.geo.top(), '上滚之后不得被拽回底部').toBe(parked);
    expect(shown(), '浮标仍在（用户还不在底部）').toBe(true);
  });

  it('多会话：切走再切回，浮标记得该容器的基线（数字不从 0 重数）', async () => {
    const b = await boot({ gap: 800 });
    const V = await load<ViewMod>('ui/viewctx.ts');
    b.J.initJumpBottom();
    await addColumn(b);
    expect(numeral()).toBe('1');

    const other = V.ensurePane('ws/s2', 'session', '乙会话');
    const geo2 = withGeometry(other.el, 300, 2000);
    V.activatePane('ws/s2', 'session', '乙会话');
    flushRaf();
    geo2.gapTo(0); // 乙会话贴底
    expect(shown(), '乙会话贴底 ⇒ 浮标收起').toBe(false);

    V.activatePane(LIVE, 'session', '甲会话');
    flushRaf();
    expect(shown(), '切回甲会话：它仍在上滚状态 ⇒ 浮标回来').toBe(true);
    expect(numeral(), '数字接着数，不从 0 重来').toBe('1');
  });
});
