// @vitest-environment jsdom
/**
 * W1534 · HTML 预览 —— 面板行为（真实 openPreview 路径）。
 *
 * ★ W9220（测试提速，用例与断言逐字未动）：本文件是原 ~tests/w1534-html-panel.test.ts~ 的
 *   **后半**（非 html / 降级 / 重开复位 / 幂等）。夹具与断言逐字同前，只改归属。
 *
 * 守四件事：
 *   ① 切换控件**常驻可见**（不是 hover 才显形）：html 内容就绪后 .preview-modes
 *      不带 .hidden，且两个按钮都带 aria-pressed（选中态靠它，不靠 opacity）；
 *   ② 默认进**预览**（iframe 在），点「源码」后 iframe 仍在 DOM（不重建）但被
 *      visibility 隐藏、源码视图显示（★ 不能是 display:none，真机实测会丢 iframe 滚动位）；
 *   ③ 来回切换**不重新加载**：同一份内容、同一个 iframe 节点（身份不变）；
 *   ④ 非 html 类型**不显示**切换控件（不给不存在的选择）。
 *
 * 几何（非零尺寸 / 与代码文字不相交）由真机 CDP 断言，见 results/W1534-html-preview.md。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, flush, resetHarness, type ElLike } from './lib/w795-dom.js';

interface PanelMod {
  openPreview(req: unknown): void;
  closePreview(): void;
  previewIsOpen(): boolean;
  previewView(): string;
}
const loadPanel = async (): Promise<PanelMod> =>
  (await import(/* @vite-ignore */ at('ui/preview/panel.ts'))) as PanelMod;
const cand = (path: string, kind = 'html'): unknown => ({ path, kind, source: 'label' });
const q = (s: string): ElLike | null => doc.querySelector(s) as unknown as ElLike | null;
const qa = (s: string): ElLike[] => Array.from(doc.querySelectorAll(s)) as unknown as ElLike[];

const HTML_DOC = '<!doctype html><html><head><title>t</title></head><body><p id="p">hi &amp; bye</p></body></html>';

/** 点一个按钮（派发真实 click）。 */
function click(n: ElLike | null): void {
  if (n === null) throw new Error('click(): target missing');
  n.dispatchEvent(new (globalThis as unknown as { Event: new (t: string) => unknown }).Event('click'));
}
/** 按可见文本找切换按钮。 */
function modeBtn(label: string): ElLike | null {
  return qa('.preview-mode').find((b) => (b.textContent ?? '').trim() === label) ?? null;
}
/** 打开一个 html 预览并等它画完。 */
async function openHtml(text: string = HTML_DOC, path = '/a/index.html'): Promise<void> {
  const p = await loadPanel();
  p.openPreview({ candidate: cand(path), loadFull: async () => ({ text }) });
  await flush(30);
}

beforeEach(() => { resetHarness(); });
afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

describe('W1534 · HTML 预览面板：类型判定 / 降级 / 复位 / 幂等', () => {
  it('非 html 类型不显示切换控件（不给不存在的选择）', async () => {
    const p = await loadPanel();
    p.openPreview({ candidate: cand('/a/b.ts', 'code'), loadFull: async () => ({ text: 'const x = 1;' }) });
    await flush(30);
    expect(q('.preview-modes')!.classList.contains('hidden'), 'code 文件没有两种看法 ⇒ 控件隐藏').toBe(true);
    expect(q('.preview-html-frame'), 'code 文件不该有 iframe').toBeNull();
  });

  it('打开另一个文件时控件先隐藏，内容就绪后再按新类型决定（不残留上一个文件的控件）', async () => {
    await openHtml();
    expect(q('.preview-modes')!.classList.contains('hidden')).toBe(false);
    const p = await loadPanel();
    p.openPreview({ candidate: cand('/a/note.md', 'markdown'), loadFull: async () => ({ text: '# T' }) });
    await flush(30);
    expect(q('.preview-modes')!.classList.contains('hidden'), 'markdown 没有双视图').toBe(true);
    expect(q('.preview-html-frame')).toBeNull();
  });

  it('降级态（内容不在会话里）不显示切换控件，也不产出 iframe', async () => {
    const p = await loadPanel();
    p.openPreview({ candidate: cand('/a/x.html'), loadFull: async () => ({ text: null }) });
    await flush(30);
    expect(q('.preview-modes')!.classList.contains('hidden'), '没有内容就没有两种看法').toBe(true);
    expect(q('.preview-html-frame')).toBeNull();
  });

  it('关闭面板后重开：回到默认「预览」视图（不把上次的选择带过来）', async () => {
    await openHtml();
    const p = await loadPanel();
    click(modeBtn('源码'));
    await flush(10);
    expect(p.previewView()).toBe('source');
    p.closePreview();
    await flush(5);
    await openHtml();
    expect(p.previewView(), '重开必须回到默认预览').toBe('preview');
    expect(q('.preview-mode[aria-pressed="true"]')?.textContent?.trim()).toBe('预览');
  });

  it('点当前已选中的按钮不重复触发（幂等；避免无谓重画）', async () => {
    await openHtml();
    const frameBefore = q('.preview-html-frame');
    click(modeBtn('预览')); // 已经是「预览」
    await flush(10);
    expect(q('.preview-html-frame'), '重复点当前项不得重画').toBe(frameBefore);
  });
});
