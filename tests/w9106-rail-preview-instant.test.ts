// @vitest-environment jsdom
/**
 * W9106 · 用户：「thread-rail 灵动条，的预览对话应该几乎立即渲染才对」。
 *
 * 现状差（改动前）：预览卡与全站纯文本提示共用引擎里的**一个** 150ms 停留阈值，而且
 * 每次换目标都重新起计时 —— 用户拿 5px 细条来回扫动时几乎永远看不到卡。
 *
 * 本文件钉五件事（真实模块 + 真实 rail 事件路径；断言口径见 ui/hint/registry.ts 的
 * delayMs 注释与 ui/hint/card.ts 的 hintDelayOf）：
 *   ① **按提供者区分**：rail 预览 = 0ms，内置纯文本卡 = 引擎缺省 150ms（同一份引擎）；
 *   ② 条带内换条**同一个卡节点就地换内容**（W9345：身份不变、无空窗、子节点不重建）；
 *   ③ 离开条带**立即**撤卡；键盘路径（focusin 直接弹）行为不变；
 *   ④ 延迟不靠「把全站阈值改成 0」实现 —— 密集控件仍是 149ms 不弹 / 150ms 弹。
 *   ⑤ 换**提供者**不复用：rail 富卡与纯文本卡各画各的（内容不串台）。
 *
 * W9345 口径变更：③ 原来钉的是**机制**（replaceWith 原子替换：second !== first、
 * first.isConnected === false、变更里同时有移除+添加）。现在改钉**后果**（前端铁律 11）：
 * 卡节点身份保持 / 全程没被摘掉 / 内容当帧就是新的 / 恰好一张卡 / 内部子节点是同一批对象。
 * 覆盖了旧断言判别力的全部维度，且每条都能让「产品坏了」的实现变红。
 *
 * 夹具沿用 tests/w867-rail-hit.test.ts 的写实桩（几何全用固定 rect，不依赖 jsdom 排版）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flushRaf, rafStub, resetHarness, type ElLike } from './lib/w795-dom.js';

const MAIN_W = 900;
const PANE_H = 600;
const GUTTER = 100;
const ROUNDS = 4;

interface HintMod {
  initHints(): void;
  setHint(t: ElLike, s: string | null): void;
  hoverHint(t: ElLike | null): void;
  hintCardEl(): ElLike | null;
  hintPlugins(): readonly { id: string; delayMs?: number }[];
}
interface RailMod {
  initRail(): void;
  railAdd(p: unknown, c: unknown, role: string): void;
  railHintPlugin(): { id: string; priority?: number; delayMs?: number };
}
interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): { el: ElLike };
  activatePane(id: string, kind?: string, title?: string): unknown;
}
interface RectLike { left: number; top: number; right: number; bottom: number; width: number; height: number }
interface RectHost { getBoundingClientRect(): RectLike }
/** 根 tsconfig 没有 DOM lib：变更观察者用最小结构类型 + 从全局取构造器。 */
interface MutRec { addedNodes: ArrayLike<unknown>; removedNodes: ArrayLike<unknown> }
interface MutObs { observe(n: unknown, o: unknown): void; takeRecords(): MutRec[]; disconnect(): void }
const MO = (globalThis as unknown as { MutationObserver: new (cb: (records: MutRec[]) => void) => MutObs }).MutationObserver;

const rect = (l: number, t: number, r: number, b: number): RectLike =>
  ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t });

/** 装一个「有条带、有留白、有 ROUNDS 轮」的会话容器（同 w867 夹具）。 */
async function bootRail(): Promise<{ main: ElLike; hint: HintMod }> {
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  // W9204：rAF 单独接管成显式队列（见 tests/lib/w795-dom.ts 的 rafStub）。
  vi.stubGlobal('requestAnimationFrame', rafStub);
  const hint = (await import(/* @vite-ignore */ at('ui/hint/index.ts'))) as HintMod;
  hint.initHints();
  const ctx = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
  ctx.initViewCtx();
  const pane = ctx.ensurePane('ws/s1', 'session', '甲会话');
  ctx.activatePane('ws/s1', 'session', '甲会话');
  const main = doc.getElementById('main') as ElLike;
  (main as unknown as RectHost).getBoundingClientRect = () => rect(0, 0, MAIN_W, PANE_H);
  const msgs = pane.el as unknown as ElLike;
  (msgs as unknown as RectHost).getBoundingClientRect = () => rect(0, 0, MAIN_W, PANE_H);
  const gutterCol = doc.createElement('div') as unknown as ElLike;
  gutterCol.className = 'mcol';
  (gutterCol as unknown as RectHost).getBoundingClientRect = () => rect(GUTTER, 0, MAIN_W, PANE_H);
  msgs.appendChild(gutterCol);
  const rail = (await import(/* @vite-ignore */ at('ui/rail.ts'))) as RailMod;
  rail.initRail();
  for (let i = 1; i <= ROUNDS; i++) {
    const round = doc.createElement('div') as unknown as ElLike;
    round.className = 'mcol';
    (round as unknown as RectHost).getBoundingClientRect = () => rect(GUTTER, 0, MAIN_W, PANE_H);
    const content = doc.createElement('div') as unknown as ElLike;
    content.className = 'content';
    content.textContent = '第 ' + i + ' 轮提问';
    round.appendChild(content);
    msgs.appendChild(round);
    rail.railAdd(pane, round, 'user');
  }
  flushRaf(); // W9204：建列走 rAF 合并（railAdd → queueSync），帧跑完长条才有位置
  return { main, hint };
}

const bars = (): ElLike[] => Array.from(doc.querySelectorAll('#main .railv3-item')) as ElLike[];
const barY = (i: number): number => Number.parseFloat(String(bars()[i]?.style?.['top'])) + 2.5;
const cardCount = (): number => doc.querySelectorAll('.hint-card').length;

/**
 * 给每个 DOM 节点发一个**稳定的进程内身份号**（WeakMap，弱引用不漏）。
 * 两次调用对同一节点返回同一个号 ⇒ 两份表逐项相等 ⇔ 「是同一批节点对象」。
 * 只量对象身份，不钉结构/类名/文本。
 */
const nodeIds = new WeakMap<object, number>();
let nextNodeId = 1;
function idOf(n: object): number {
  let id = nodeIds.get(n);
  if (id === undefined) {
    id = nextNodeId;
    nextNodeId += 1;
    nodeIds.set(n, id);
  }
  return id;
}

/** 一张卡**整棵子树**的节点身份序列（深度优先，与结构无关：逐项比就行）。 */
function childIds(node: ElLike): number[] {
  const all = Array.from(node.querySelectorAll('*')) as ElLike[];
  return [idOf(node), ...all.map((n) => idOf(n))];
}

/**
 * 推一次指针并跑**恰好一帧**（不推进提示停留的 150ms）。
 *
 * W9204：rail 的建列与命中判定都走 rAF（railAdd → queueSync，onMove → rAF → applyMove），
 * 而本仓 jsdom 夹具的 requestAnimationFrame 就是 setTimeout(cb, 0) ⇒ 用
 * advanceTimersByTime(FRAME) 会**连带**推进提示引擎的 150ms 停留，这一节要区分的
 * 「当帧弹卡 vs 停留后弹卡」就没了判别力。做法与真实浏览器一致：把 rAF 单独接管成
 * 一个队列（flushRaf），需要帧就 flush 它，需要停留才推进定时器。
 */
function moveOneFrame(main: ElLike, x: number, y: number): void {
  const e = new Ev('pointermove', { bubbles: true });
  Object.defineProperty(e, 'clientX', { value: x });
  Object.defineProperty(e, 'clientY', { value: y });
  main.dispatchEvent(e);
  flushRaf();
}

describe('W9106 · 条带预览零停留（延迟按提供者区分，不是全站一刀切）', () => {
  beforeEach(() => { resetHarness(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('① 提供者级口径：rail 声明 0ms，内置纯文本卡不声明（= 引擎缺省 150ms）', async () => {
    const { hint } = await bootRail();
    const rail = (await import(/* @vite-ignore */ at('ui/rail.ts'))) as RailMod;
    const builtin = (await import(/* @vite-ignore */ at('ui/hint/builtin.ts'))) as {
      textCardPlugin(): { delayMs?: number };
    };
    const card = (await import(/* @vite-ignore */ at('ui/hint/card.ts'))) as { HINT_DELAY_MS: number };
    expect(card.HINT_DELAY_MS, '引擎缺省仍是 150ms（密集控件的既有手感）').toBe(150);
    expect(rail.railHintPlugin().delayMs, 'rail 提供者 = 零停留').toBe(0);
    expect(rail.railHintPlugin().priority, '优先级不变（仍压过内置文本卡）').toBe(10);
    expect(builtin.textCardPlugin().delayMs, '内置文本卡不覆盖 → 走引擎缺省').toBeUndefined();
    // 真实注册表里两个提供者都在，且只有 rail 声明了零停留
    const byId = new Map(hint.hintPlugins().map((p) => [p.id, p]));
    expect(byId.get('rail-preview')?.delayMs).toBe(0);
    expect(byId.get('hint-text-card')?.delayMs).toBeUndefined();
  });

  it('② 条带：指针落到长条上，**当帧**（0ms 停留）卡已在 DOM；密集控件同刻仍不弹', async () => {
    const { main, hint } = await bootRail();
    const text = doc.createElement('div') as unknown as ElLike;
    doc.getElementById('main')?.appendChild(text);
    hint.setHint(text, '运行中');
    hint.hoverHint(text); // 先悬停一个纯文本目标（150ms 缺省，还没到点）
    moveOneFrame(main, 20, barY(0)); // 再扫到第 1 根条：rail 目标接管
    const card = hint.hintCardEl();
    expect(card, 'rail 预览在 rAF 帧内就出现（旧实现要等 150ms）').not.toBeNull();
    expect(card?.textContent, '内容取自消息 DOM').toContain('第 1 轮提问');
    expect(card?.className).toContain('railv3-card');
    expect(card?.className, '零停留的卡不播入场动画（观感上的「立即」）').toContain('hint-card-instant');
    expect(cardCount(), '同一时刻只有一张卡').toBe(1);
    // 反证：同一刻若换成内置文本卡（150ms），它不该弹 —— 证明零停留是 rail 专有
    hint.hoverHint(text);
    vi.advanceTimersByTime(149);
    expect(hint.hintCardEl(), '纯文本卡 149ms 仍不弹').toBeNull();
    vi.advanceTimersByTime(1);
    expect(hint.hintCardEl()?.textContent, '150ms 才弹').toContain('运行中');
    expect(hint.hintCardEl()?.className, '文本卡仍播入场动画（手感不变）').not.toContain('hint-card-instant');
  });

  it('③ 条带内换条：同一个卡节点就地换内容 —— 身份不变、全程在 DOM、当帧是新的', async () => {
    const { main, hint } = await bootRail();
    moveOneFrame(main, 20, barY(0));
    const first = hint.hintCardEl();
    expect(first?.textContent).toContain('第 1 轮提问');
    // 骨架子节点（Q 行 / 分隔线 / A 行）先记下身份：换条后必须是**同一批**节点
    const kidsBefore = childIds(first!);

    // 记录 body 上的卡片增删：只守「卡全程没被摘掉」这一条后果，不钉机制。
    const batches: { added: string[]; removed: string[] }[] = [];
    const cls = (n: unknown): string => (n as ElLike).className ?? '';
    const collect = (records: MutRec[]): void => {
      for (const r of records) {
        batches.push({ added: Array.from(r.addedNodes, cls), removed: Array.from(r.removedNodes, cls) });
      }
    };
    const obs = new MO((records) => collect(records));
    obs.observe(doc.body, { childList: true, subtree: true });

    // 换到第 2 根条。注意这里**只**推进 rAF 帧，整段不推进任何定时器 ——
    // 所以「内容要等一次停留/一个宏任务才换」的实现会当场被下面几条抓住。
    moveOneFrame(main, 20, barY(1));
    collect(obs.takeRecords()); // 同步取出（微任务可能还没跑）
    const second = hint.hintCardEl();
    // ① 同一节点身份保持（对象复用本身：卡不是每换一根条就重造的）
    expect(second, '换条后卡仍在（不撤卡）').not.toBeNull();
    expect(second, '换条不换节点（同一个卡对象）').toBe(first);
    expect(first?.isConnected, '旧节点仍挂在 DOM 里').toBe(true);
    // ② 无空窗：整段变更里**没有任何一次**把卡从 body 上摘掉
    const removedCard = batches.flatMap((b) => b.removed).filter((c) => c.includes('hint-card'));
    expect(removedCard, '换条全程卡都没被摘掉（没有空窗帧）').toEqual([]);
    // ③ 内容当帧就是新条的（不许等停留、不许闪旧内容）
    expect(second?.textContent, '内容立刻换成 B 的预览').toContain('第 2 轮提问');
    expect(second?.textContent, '当帧不再残留上一条的内容').not.toContain('第 1 轮提问');
    // ④ 同一刻恰好一张卡
    expect(cardCount(), '换条过程后仍恰好一张卡').toBe(1);
    // ⑤ 卡片内部子节点不是整批新造的（内容就地更新，只改文本/显隐/class）
    expect(childIds(second!), '换条后是同一批子节点（骨架只建一次）').toEqual(kidsBefore);
    obs.disconnect();
  });

  it('④ 离开条带立即撤卡；键盘路径（focusin 直接弹）行为不变', async () => {
    const { main, hint } = await bootRail();
    moveOneFrame(main, 20, barY(2));
    expect(hint.hintCardEl()).not.toBeNull();
    moveOneFrame(main, MAIN_W - 5, barY(2)); // 横向出带 → collapse()
    expect(hint.hintCardEl(), '出带立即撤卡（0ms）').toBeNull();

    // 键盘路径：focusin 由引擎直接 show()，不等待停留（改动前后一致）
    const text = doc.createElement('div') as unknown as ElLike;
    doc.getElementById('main')?.appendChild(text);
    hint.setHint(text, '键盘可达');
    text.dispatchEvent(new Ev('focusin', { bubbles: true }));
    expect(hint.hintCardEl()?.textContent, 'focusin 当帧弹（不等 150ms）').toContain('键盘可达');
  });

  /**
   * W9345：同源复用的**边界** —— 换一个提供者画的目标时，卡**必须换节点**。
   *
   * 为什么这条是后果而不是机制：不同提供者的内容不能互相塞（纯文本卡的内容进 rail 富卡
   * ⇒ 用户看到的是「长条旁边浮着别的控件的文案」）。引擎的判据来自注册缝（providerId）。
   *
   * 夹具用**第二个零停留提供者**（id 与 rail 的不同、自带 update）：这样从 A 换到 B 走的是
   * 与用例③ **同一条** show() 分支（同源就地更新那一支），差别只在身份 ⇒ 判别力来自
   * 「身份」本身，而不是来自「这次恰好撤了卡重建」（若用 150ms 文本卡，它先被 cancel
   * 掉，走不到 show 的复用分支，这条用例就成空转 —— 变异负控制实测过）。
   */
  it('⑤ 换提供者不复用：换到**另一个**提供者的卡必须换节点（内容不串台）', async () => {
    const { main, hint } = await bootRail();
    moveOneFrame(main, 20, barY(0));
    const railCard = hint.hintCardEl();
    expect(railCard?.textContent, '先是 rail 富卡').toContain('第 1 轮提问');

    // 第二个零停留提供者：它也提供 update（否则引擎本就不复用，测不到身份判据）
    const other = doc.createElement('div') as unknown as ElLike;
    doc.getElementById('main')?.appendChild(other);
    hint.setHint(other, '别的提供者');
    const mod = (await import(/* @vite-ignore */ at('ui/hint/index.ts'))) as HintMod;
    const reg = (await import(/* @vite-ignore */ at('ui/hint/registry.ts'))) as {
      registerHintPlugin(p: unknown): () => void;
    };
    const dispose = reg.registerHintPlugin({
      id: 'w9345-other', priority: 20, delayMs: 0,
      claim: (target: ElLike) => (target === other
        ? {
            build: (): ElLike => {
              const b = doc.createElement('div') as unknown as ElLike;
              b.textContent = '别的提供者';
              return b;
            },
            update: (box: ElLike) => { box.textContent = '别的提供者'; },
          }
        : null),
    });
    try {
      expect(mod.hintPlugins().some((p) => p.id === 'w9345-other'), '第二个提供者已注册').toBe(true);
      hint.hoverHint(other);
      const textCard = hint.hintCardEl();
      expect(textCard?.textContent, '换到另一个提供者的内容').toBe('别的提供者');
      expect(textCard, '跨提供者不复用（换了一个节点）').not.toBe(railCard);
      expect(railCard?.isConnected, '旧卡已被换下').toBe(false);
      expect(cardCount(), '任一时刻恰好一张卡').toBe(1);
    } finally {
      dispose();
    }
  });
});
