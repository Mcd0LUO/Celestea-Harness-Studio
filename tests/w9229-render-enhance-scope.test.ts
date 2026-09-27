// @vitest-environment jsdom
/**
 * W9229 · P2批次1（前端）—— 渲染节的**增强遍作用域**与**淘汰容器的裁剪**。
 *
 * 覆盖审计 results/W9201-消息渲染管线.md §P2：
 *   F-13 `ensureAssistant` 每次都建 think/thinkBody/thinkTime/cards 四个从不挂载的节点；
 *   F-14 `renderTextView` 每节拍对**整条消息**跑增强遍（长消息流式期间的常数开销）；
 *   F-26 `view.root.isConnected !== false` 的判据让「容器已被淘汰但 SSE 还在增量」的
 *        会话**永远不裁剪** —— 那恰恰是最可能无界增长的一类。
 *
 * 证据口径：**不**断言「函数被调用过」，而是读增强遍实际拿到的**作用域内容**
 * （它 querySelectorAll 到的 `pre code` 个数）与容器里的真实列数。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness } from './lib/w795-dom.js';

interface El {
  className: string;
  textContent: string | null;
  appendChild(n: unknown): unknown;
  remove(): void;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): ArrayLike<El>;
}
interface Pane { id: string; el: El; streaming: boolean; assistant: unknown }
interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, k?: string, t?: string): Pane;
  activatePane(id: string, k?: string, t?: string): unknown;
}
interface AssistantMod {
  ensureAssistant(ctx: unknown): { content: El; root: El };
  appendText(ctx: unknown, view: unknown, delta: string): void;
  applyFinalText(ctx: unknown, view: unknown, text: string): void;
  flushVisible(): void;
}
/** 结构化接口（根 tsconfig 无 DOM lib，不引 Element 全局类型）。 */
interface ScopeLike {
  querySelectorAll(sel: string): ArrayLike<unknown>;
}
interface EnhanceMod {
  registerEnhancer(e: { id: string; order?: number; enhance(c: ScopeLike): void }): () => void;
}

/** 一个「数它看到了多少代码块」的增强遍 —— 这就是 F-14 的可观测面。 */
const seen: number[] = [];
let dispose: (() => void) | null = null;

async function boot(id: string): Promise<{ pane: Pane; M: AssistantMod }> {
  const V = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as unknown as ViewCtxMod;
  V.initViewCtx();
  const pane = V.ensurePane(id, 'session', '甲');
  V.activatePane(id, 'session', '甲');
  const M = (await import(/* @vite-ignore */ at('ui/messages/assistant.ts'))) as unknown as AssistantMod;
  return { pane, M };
}

beforeEach(async () => {
  resetHarness();
  seen.length = 0;
  const E = (await import(/* @vite-ignore */ at('ui/enhance/registry.ts'))) as unknown as EnhanceMod;
  // order 999：排在内置两遍之后，只看作用域、不改 DOM。
  dispose = E.registerEnhancer({
    id: 'w9229.counter',
    order: 999,
    enhance: (c) => { seen.push(c.querySelectorAll('pre code').length); },
  });
});
afterEach(() => {
  if (dispose) dispose();
  dispose = null;
  vi.unstubAllGlobals();
  doc.body.replaceChildren();
});

describe('W9229 · F-14 增强遍的作用域必须是「本 tick 新建的节点」', () => {
  it('已固化 N 个代码块后再来一小段文本：增强遍不得再看到那 N 个块', async () => {
    const { pane, M } = await boot('ws/f14');
    const view = M.ensureAssistant(pane);
    // 先灌入 12 个**已闭合**的代码块（围栏块会固化进 stable 区）。
    const blocks = Array.from({ length: 12 }, (_, i) => '\n\n```js\nconst a' + i + ' = ' + i + ';\n```\n').join('');
    M.applyFinalText(pane, view, '# 标题' + blocks);
    const total = view.content.querySelectorAll('pre code').length;
    expect(total, '前置：内容里确实有 12 个代码块').toBe(12);

    seen.length = 0;
    // 再追加一小段纯文本（不含代码块）—— 这是流式期间最常见的节拍。
    M.appendText(pane, view, '\n\n再来一段普通文字。');
    M.flushVisible();
    const maxSeen = Math.max(0, ...seen);
    // ★ 主断言：改动前这里恒为 12（每个节拍都扫整条消息）。
    expect(maxSeen, '增强遍不得在本 tick 再扫一遍已固化的 12 个代码块').toBeLessThan(total);
    expect(view.content.querySelectorAll('pre code').length, '对照：整条消息里仍有 12 个块').toBe(12);
  });

  it('新增代码块仍然被增强（作用域收窄不能变成「漏增强」）', async () => {
    const { pane, M } = await boot('ws/f14b');
    const view = M.ensureAssistant(pane);
    M.applyFinalText(pane, view, '# 标题');
    seen.length = 0;
    M.applyFinalText(pane, view, '# 标题\n\n```js\nconst x = 1;\n```\n');
    expect(Math.max(0, ...seen), '新代码块必须被增强遍看到').toBeGreaterThanOrEqual(1);
  });
});

describe('W9229 · F-26 容器被淘汰（不在宿主里）时也必须裁剪', () => {
  it('pane.el.remove() 之后继续 appendText：列数不得无界增长', async () => {
    const { pane, M } = await boot('ws/f26');
    const cap = (await import(/* @vite-ignore */ at('ui/messages/dom-cap.ts'))) as unknown as { MAX_DOM_COLS: number };
    // 把容器摘出宿主（= evictIfNeeded / dropPane 的形态），SSE 增量照旧到达。
    (pane.el as unknown as { remove(): void }).remove();
    const view = M.ensureAssistant(pane);
    for (let i = 0; i < 4; i++) {
      M.appendText(pane, view, '\n\n第' + i + '段' + 'x'.repeat(50));
      M.flushVisible();
    }
    // 每段都会固化一个块（段落），列数（.mcol）本身不会因此涨，但**节点总数**会。
    // 真正要守的是「裁剪确实跑了」——用强制阈值把超出量造出来，再断言它被压回。
    const many = Array.from({ length: cap.MAX_DOM_COLS + 50 }, (_, i) => {
      const col = doc.createElement('div');
      col.className = 'mcol';
      return col;
    });
    for (const c of many) (pane.el as unknown as { appendChild(n: unknown): unknown }).appendChild(c);
    const before = pane.el.querySelectorAll('.mcol').length;
    expect(before, '前置：已造出超过上限的列数').toBeGreaterThan(cap.MAX_DOM_COLS);
    // 裁剪按 PRUNE_INTERVAL_MS 节流（安全阀，不是每帧不变量）—— 把时钟推过窗口，
    // 让这一次渲染真的走到裁剪那一步（否则测的是节流而不是判据）。
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000);
    try {
      M.appendText(pane, view, '\n\n再一段');
      M.flushVisible();
    } finally { spy.mockRestore(); }
    const after = pane.el.querySelectorAll('.mcol').length;
    // ★ 主断言：改动前（isConnected===false 的淘汰容器）这里恒等于 before。
    expect(after, '淘汰容器的 DOM 也必须被裁回上限内').toBeLessThanOrEqual(cap.MAX_DOM_COLS);
  });
});

describe('W9229 · F-13 ensureAssistant 不得造从不挂载的节点', () => {
  it('新气泡只挂它真正使用的那棵树', async () => {
    const { pane, M } = await boot('ws/f13');
    const view = M.ensureAssistant(pane);
    const content = view.content as unknown as { isConnected?: boolean };
    // content 在文档里；root 的其它历史字段（think/cards）不得参与挂载。
    expect(content.isConnected, '前置：气泡确实挂上了').not.toBe(false);
    expect(pane.el.querySelectorAll('.msg.assistant').length).toBe(1);
  });
});
