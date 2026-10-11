/**
 * A4a · 输入栏适配缝的**共用测试夹具**（jsdom）。
 *
 * 为什么单独一个文件：Lexical 迁移（composer-surface §9）之后，既有前端测试里凡是
 *   「往 #input 里打字 / 按键 / 读回内容」的夹具都变成了同一段代码（textarea 时代它们
 *   靠 input.value + dispatchEvent("input") + keydown 这三件套）。抄六遍就是六处会一起
 *   腐烂的复制品 —— 这里只放**机制**，不放断言。
 *
 * ★ 为什么自己声明 EditorRoot 而不是用 HTMLElement：根 tsconfig **没有 DOM lib**
 *   （tests/ 的既有约定，见 lib/w795-dom.ts 的 ElLike / DocLike）。这里沿用同一条路。
 *
 * ★ 关键的一条：value 桥。既有断言写的是 el.value（textarea 时代的读法），迁移后
 *   #input 是 Lexical 的 editor root，没有 .value。这里在**测试夹具**上定义一个 getter，
 *   把它接到适配缝的规范文本上 —— 于是几十条既有断言一字不用改，却仍然在断「输入栏里
 *   真的有这些字」。产品代码不定义这个桥（那是 textarea 时代的语义）；它是夹具。
 * ========================================================================== */
import { at } from './w795-dom.js';

/** 编辑器根元素的结构子集（≡ lib/w795-dom.ts 的 ElLike + dataset）。 */
export interface EditorRoot {
  id: string;
  dataset: Record<string, string | undefined>;
  focus(): void;
  dispatchEvent(e: unknown): boolean;
  getAttribute(k: string): string | null;
  setAttribute(k: string, v: string): void;
}

interface El {
  id: string;
  focus(): void;
  dispatchEvent(e: unknown): boolean;
}

export interface ComposerHandle {
  root: El;
  /** 读规范文本（等价于夹具上的 el.value）。 */
  text(): string;
  /** 置一段文本并把光标落到末尾。 */
  type(text: string): void;
  /** 派发一次 keydown（Lexical 的按键链从这里进）。 */
  press(init: Record<string, unknown>): unknown;
  /** 卸载（让下一个用例能重新装配同一个模块实例）。 */
  destroy(): void;
}

interface ComposerMod {
  mountComposer(o: Record<string, unknown>): { root: El };
  canonicalText(): string;
  setComposerText(t: string): void;
  textBeforeCaret(): string;
  setComposerPlaceholder(t: string): void;
  replaceComposerRange(a: number, b: number, t: string): void;
  draftPayload(): string;
  restoreDraftPayload(p: string): 'state' | 'text' | 'empty';
  setComposerKeyInterceptor(fn: ((e: Record<string, unknown>) => boolean) | null): void;
  resetComposer(): void;
}

export async function loadComposer(): Promise<ComposerMod> {
  return (await import(/* @vite-ignore */ at('ui/composer/index.ts'))) as unknown as ComposerMod;
}

/**
 * 在**已装配**的输入栏上接上夹具的 value 桥。
 *
 * 为什么需要：#input 现在是 Lexical 的 editor root，没有 .value。既有断言（几十条
 * 「组合中的 Enter 不许改值」之类）写的是 el.value —— 桥把它们接到适配缝的规范文本上，
 * 于是断言一字不用改，却仍然在断「输入栏里真的有这些字」。
 */
export async function bridgeInput(el: EditorRoot): Promise<void> {
  const mod = await loadComposer();
  Object.defineProperty(el, 'value', { configurable: true, get: () => mod.canonicalText() });
  // selectionStart/End：textarea 时代的读法 = 光标位置。编辑器里它就是「光标前文本的长度」
  // （适配缝的 textBeforeCaret），所以「光标落在换行之后」那条断言一字不用改。
  const caret = (): number => mod.textBeforeCaret().length;
  Object.defineProperty(el, 'selectionStart', { configurable: true, get: caret });
  Object.defineProperty(el, 'selectionEnd', { configurable: true, get: caret });
}

/** 取出夹具里的 #input；没有就现造一个（Lexical 需要一个真实可挂载的元素）。 */
export async function ensureInput(): Promise<EditorRoot> {
  const g = globalThis as unknown as {
    document: { getElementById(id: string): EditorRoot | null; createElement(t: string): EditorRoot; body: { appendChild(n: unknown): unknown } };
  };
  const doc = g.document;
  const found = doc.getElementById('input');
  if (found) return found;
  const el = doc.createElement('div');
  el.id = 'input';
  doc.body.appendChild(el);
  return el;
}

/** 把适配缝装到给定的根元素上，并在夹具上定义 value 桥。 */
export async function mountOn(root: EditorRoot, opts: Partial<Record<string, unknown>> = {}): Promise<ComposerHandle> {
  const mod = await loadComposer();
  mod.mountComposer({
    mount: root,
    send: () => {},
    lane: () => 'steer',
    otherLane: () => 'queue',
    isTouch: () => false,
    ...opts,
  });
  Object.defineProperty(root, 'value', {
    configurable: true,
    get: () => mod.canonicalText(),
  });
  return {
    root,
    text: () => mod.canonicalText(),
    type: (t: string) => mod.setComposerText(t),
    press: (init: Record<string, unknown>) => {
      const KB = (globalThis as unknown as {
        KeyboardEvent: new (t: string, i?: Record<string, unknown>) => unknown;
      }).KeyboardEvent;
      const ev = new KB("keydown", { bubbles: true, cancelable: true, ...init });
      root.dispatchEvent(ev);
      return ev;
    },
    destroy: () => mod.resetComposer(),
  };
}

/** 派发一次键盘事件（不带适配缝，例如补全框那条路的独立用例）。 */
export function pressKey(el: El, init: Record<string, unknown>): { defaultPrevented: boolean } {
  const KB = (globalThis as unknown as {
    KeyboardEvent: new (t: string, i?: Record<string, unknown>) => { defaultPrevented: boolean };
  }).KeyboardEvent;
  const ev = new KB("keydown", { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(ev);
  return ev;
}
