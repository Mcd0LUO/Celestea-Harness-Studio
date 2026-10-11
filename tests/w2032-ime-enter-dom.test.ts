// @vitest-environment jsdom
/**
 * W2032 · 中文/日文输入法（IME）组合中按 Enter **不得发送**（主输入框）。
 *
 * 缺陷（真机复现，1440x900 + Input.imeSetComposition）：组合中按 Enter 的本意是**确认
 * 候选词**，而当时 inputbar 的 keydown 无条件 preventDefault + send(input.value)
 * ⇒ **半截组合文字被发出**（实测 POST /api/turn {input:"nihaoni hao"}，输入框被清空）。
 *
 * ★ 本文件在 W2028/W2033 合并后的**新落点**上断言（W2032 返工）：
 *   Enter 的唯一决策点是 ui/inputbar/newline.ts 的纯函数 `enterAction(e, touch)`，
 *   装配走它的 `bindEnterKey`。所以断言分两层：
 *     ① 纯函数层：`enterAction` 对各种 (键, 设备) 组合返回什么；
 *     ② 集成层：真实 `initInputBar` / `bindEnterKey` 装出来的行为（发送、默认动作、补全框）。
 *   判定真源是 **ui/ime.ts 的 isImeKey**（W2033 建立）—— 本文件**不**复刻那份判据，
 *   只验证 enterAction 确实用了它（变异负控制见报告 §3）。
 *
 * 判据为什么是两半（isComposing + keyCode 229）：
 *   `isComposing` 的窗口是 (compositionstart, compositionend) **开区间**；而引擎可能先把
 *   `compositionend` 交给脚本（WebKit bug 165004）⇒ 那一刻读到 false。`keyCode === 229`
 *   （§7.3.1 的算法：「IME 正在处理这次 keydown 时返回 229」）正是它的**补集**。
 *
 * 本文件同时钉住**不许变**的既有行为：桌面 Enter 发送 / Shift+Enter 换行 /
 * Ctrl-Cmd+Enter 切车道 / 补全框优先 / 触摸端组合中仍是 'native'（W2028 语义不变）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at, doc, resetHarness } from "./lib/w795-dom.js";
// §9.2：输入栏 = Lexical editor root。夹具负责「写入 / 读回」两件事的桥（lib/composer-dom.ts）。
import { type EditorRoot, bridgeInput, loadComposer } from "./lib/composer-dom.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(HERE, "..", "apps", "web", "index.html");

/** 可控的媒体查询桩：coarse 决定 (pointer: coarse)，其余查询恒 false。 */
interface MqStub { coarse: boolean; touchPoints: number; listeners: Array<() => void> }
const mq: MqStub = { coarse: false, touchPoints: 0, listeners: [] };

function setCapability(coarse: boolean, touchPoints: number): void {
  mq.coarse = coarse;
  mq.touchPoints = touchPoints;
  for (const cb of [...mq.listeners]) cb();
}

function installMatchMedia(): void {
  mq.listeners = [];
  const impl = (query: string) => ({
    matches: query.includes("pointer: coarse") ? mq.coarse : false,
    media: query,
    addEventListener: (_: string, cb: () => void) => { mq.listeners.push(cb); },
    removeEventListener: () => {},
  });
  vi.stubGlobal("matchMedia", impl);
  vi.stubGlobal("navigator", { get maxTouchPoints() { return mq.touchPoints; } });
}

interface KeyEventLike { defaultPrevented: boolean }
interface InputLike {
  value: string;
  enterKeyHint: string;
  selectionStart: number;
  selectionEnd: number;
  setSelectionRange(a: number, b: number): void;
  dispatchEvent(e: unknown): boolean;
}
interface BarMod {
  initInputBar(h: { send(t: string, m: string): void; cancel(): void }): void;
  setSubmitMode(m: string): void;
}
interface NewlineMod {
  enterAction(e: Record<string, unknown>, touch: boolean): string;
}

const KB = (globalThis as unknown as {
  KeyboardEvent: new (t: string, i?: Record<string, unknown>) => KeyEventLike;
}).KeyboardEvent;

/** 一个完整的 EnterKeyLike（key/shiftKey/ctrlKey/metaKey 都是必填）。 */
const key = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, ...over,
});

/** 派发一次 keydown，返回事件本身（看 defaultPrevented）。 */
function press(el: InputLike, init: Record<string, unknown>): KeyEventLike {
  const e = new KB("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

const inputEl = (): InputLike => doc.getElementById("input") as unknown as InputLike;
type Sends = Array<[string, string]>;

/** 装配真实输入栏（Enter 车道在 Lexical 的 keydown 命令里），返回 send 记录。 */
async function mount(sends: Sends): Promise<BarMod> {
  const bar = (await import(/* @vite-ignore */ at("ui/inputbar.ts"))) as BarMod;
  bar.initInputBar({ send: (t, m) => sends.push([t, m]), cancel: () => {} });
  // §9.2：把夹具的 value 桥接上（textarea 时代的读法），既有断言一字不改。
  bridgeInput(inputEl() as unknown as EditorRoot);
  return bar;
}

/** 在输入栏里放一段文本（适配缝写入，光标落到末尾）。 */
async function type(text: string): Promise<InputLike> {
  const el = inputEl();
  (await loadComposer()).setComposerText(text);
  return el;
}

const bodyOf = (html: string): string => {
  const m = /<body>([\s\S]*)<\/body>/.exec(html);
  if (!m || m[1] === undefined) throw new Error("index.html 里找不到 <body>…</body>");
  return m[1];
};

const newline = async (): Promise<NewlineMod> =>
  (await import(/* @vite-ignore */ at("ui/inputbar/newline.ts"))) as NewlineMod;

beforeEach(() => {
  resetHarness();
  localStorage.clear();
  doc.body.innerHTML = bodyOf(readFileSync(INDEX_HTML, "utf8"));
  installMatchMedia();
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
  doc.body.replaceChildren();
  localStorage.clear();
});

// ───────────────────────── ① 纯函数层：enterAction ─────────────────────────
describe("W2032 · enterAction 纯函数：IME 组合中的 Enter（两个判据、两端分流）", () => {
  it("桌面 + isComposing ⇒ 'swallow'（吃掉默认动作，但不发送）", async () => {
    const { enterAction } = await newline();
    expect(enterAction(key({ isComposing: true }), false)).toBe("swallow");
  });

  it("桌面 + keyCode 229（isComposing 已复位成 false）⇒ 同样 'swallow'（Safari 兜底）", async () => {
    const { enterAction } = await newline();
    expect(enterAction(key({ isComposing: false, keyCode: 229 }), false)).toBe("swallow");
  });

  it("桌面 + isComposing + Ctrl/Cmd ⇒ 仍是 'swallow'（确认候选词不该被当成切车道）", async () => {
    const { enterAction } = await newline();
    expect(enterAction(key({ isComposing: true, ctrlKey: true }), false)).toBe("swallow");
    expect(enterAction(key({ isComposing: true, metaKey: true }), false)).toBe("swallow");
  });

  it("触摸 + isComposing ⇒ 仍是 'native'（W2028 语义不变：触摸端本来就要换行）", async () => {
    const { enterAction } = await newline();
    expect(enterAction(key({ isComposing: true }), true)).toBe("native");
  });

  it("触摸 + keyCode 229 ⇒ 'native'（触摸端的兜底同样生效）", async () => {
    const { enterAction } = await newline();
    expect(enterAction(key({ isComposing: false, keyCode: 229 }), true)).toBe("native");
  });

  it("非组合路径逐字不变（桌面/触摸 × 裸 Enter / Shift / Ctrl）", async () => {
    const { enterAction } = await newline();
    expect(enterAction(key(), false), "桌面裸 Enter 仍发送当前车道").toBe("send-current");
    expect(enterAction(key({ ctrlKey: true }), false), "桌面 Ctrl+Enter 仍切车道").toBe("send-other");
    expect(enterAction(key({ metaKey: true }), false), "桌面 Cmd+Enter 仍切车道").toBe("send-other");
    expect(enterAction(key({ shiftKey: true }), false), "桌面 Shift+Enter 仍是 native").toBe("native");
    expect(enterAction(key(), true), "触摸裸 Enter 仍是换行").toBe("newline");
    expect(enterAction(key({ ctrlKey: true }), true), "触摸 Ctrl+Enter 仍切车道").toBe("send-other");
    expect(enterAction(key({ shiftKey: true }), true), "触摸 Shift+Enter 仍是 native").toBe("native");
    expect(enterAction({ ...key(), key: "a" }, false), "非 Enter 键一律 native").toBe("native");
    expect(enterAction({ ...key(), key: "a" }, true), "非 Enter 键一律 native（触摸同）").toBe("native");
  });
});

// ───────────────────── ② 集成层：bindEnterKey / initInputBar ─────────────────────
describe("W2032 · 集成：桌面组合中的 Enter 不发送、内容保留、默认动作被吃掉", () => {
  it("isComposing=true 的 Enter：不发送、内容保留、preventDefault", async () => {
    setCapability(false, 0);
    const sends: Sends = [];
    await mount(sends);
    const el = await type("nihaoni hao"); // 组合中的半截文字
    const e = press(el, { key: "Enter", isComposing: true });
    expect(sends, "★ 组合中不得发送").toEqual([]);
    expect(el.value, "★ 组合文字必须保留在输入框里").toBe("nihaoni hao");
    expect(e.defaultPrevented, "★ 必须吃掉默认动作（否则桌面会插一个换行且留在框里）").toBe(true);
  });

  it("keyCode=229 的 Enter（isComposing 已复位）：同样不发送、内容保留", async () => {
    setCapability(false, 0);
    const sends: Sends = [];
    await mount(sends);
    const el = await type("にほんご");
    const e = press(el, { key: "Enter", isComposing: false, keyCode: 229 });
    expect(sends).toEqual([]);
    expect(el.value).toBe("にほんご");
    expect(e.defaultPrevented).toBe(true);
  });

  it("组合中不插换行（'swallow' 与 'newline' 的区别）", async () => {
    setCapability(false, 0);
    const sends: Sends = [];
    await mount(sends);
    const el = await type("ni hao");
    press(el, { key: "Enter", isComposing: true });
    expect(el.value, "桌面组合中绝不插换行").toBe("ni hao");
  });

  it("触摸端组合中仍是 'native'（不吃默认动作）—— W2028 语义未被破坏", async () => {
    setCapability(true, 5);
    const sends: Sends = [];
    await mount(sends);
    const el = await type("ni hao");
    const e = press(el, { key: "Enter", isComposing: true });
    expect(sends, "触摸端组合中同样不发送").toEqual([]);
    expect(e.defaultPrevented, "触摸端让给浏览器（W2028 的结论）").toBe(false);
    expect(el.value, "不由我们插换行").toBe("ni hao");
  });
});

describe("W2032 · 集成：非组合路径逐字不变（回归护栏）", () => {
  it("桌面普通 Enter 仍发送到当前车道，且 preventDefault（与改动前一致）", async () => {
    setCapability(false, 0);
    const sends: Sends = [];
    await mount(sends);
    await type("ABC");
    const e = press(inputEl(), { key: "Enter" });
    expect(sends).toEqual([["ABC", "steer"]]);
    expect(e.defaultPrevented).toBe(true);
  });

  it("桌面 Shift+Enter 仍是换行：不发送、不 preventDefault（交回浏览器）", async () => {
    setCapability(false, 0);
    const sends: Sends = [];
    await mount(sends);
    await type("第一行");
    const e = press(inputEl(), { key: "Enter", shiftKey: true });
    expect(sends).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  it("桌面 Ctrl/Cmd+Enter 仍切到另一条车道", async () => {
    setCapability(false, 0);
    const sends: Sends = [];
    await mount(sends);
    await type("排队这句");
    press(inputEl(), { key: "Enter", ctrlKey: true });
    press(inputEl(), { key: "Enter", metaKey: true });
    expect(sends).toEqual([["排队这句", "queue"], ["排队这句", "queue"]]);
  });

  it("触摸端裸 Enter 仍由我们自己插换行（W2028 的真功能）", async () => {
    setCapability(true, 5);
    const sends: Sends = [];
    await mount(sends);
    const el = await type("AAA");
    const e = press(el, { key: "Enter" });
    expect(el.value, "触摸端 Enter = 换行").toBe("AAA\n");
    expect(sends).toEqual([]);
    expect(e.defaultPrevented, "换行由我们插入 ⇒ 必须 preventDefault").toBe(true);
  });
});

describe("W2032 · 集成：命令补全框的优先级不被破坏", () => {
  /** 装配补全框：initCompletion 建 DOM，setProvider 给候选，showCompletion 显示。 */
  /**
   * 装配补全框**并把键盘拦截口接到编辑器上**。
   *
   * §9.2：补全框与 Enter 发送的先后现在是编排层的一个显式决定（
   * ui/composer 的 setKeyInterceptor，由 installCommands 装），不再是「谁的 DOM 监听器
   * 先注册」。所以这条用例走真实装配（installCommands），而不是单独调 popup 的引擎。
   */
  async function bootCompletion(): Promise<{ completionVisible(): boolean }> {
    const cmd = (await import(/* @vite-ignore */ at("ui/commands/index.ts"))) as unknown as { installCommands(): void };
    cmd.installCommands();
    const popup = (await import(/* @vite-ignore */ at("ui/commands/popup.ts"))) as unknown as {
      initCompletion(el: unknown, pick: (i: unknown) => void): void;
      setProvider(p: (prefix: string) => unknown[]): void;
      showCompletion(prefix: string): Promise<void>;
      completionVisible(): boolean;
    };
    popup.setProvider(() => [{ label: "/run", desc: "跑命令", value: "/run" }]);
    await popup.showCompletion("ru");
    return popup;
  }

  it("补全框可见时 Enter 被它消费：即使 isComposing 为 false 也不发送", async () => {
    setCapability(false, 0);
    const sends: Sends = [];
    await mount(sends);
    const popup = await bootCompletion();
    expect(popup.completionVisible()).toBe(true);
    await type("/ru");
    press(inputEl(), { key: "Enter" });
    expect(sends, "★ 补全框先消费（适配缝的键盘拦截口在 Enter 判定之前）").toEqual([]);
  });

  it("补全框不可见时同一个 Enter 正常发送（证明上一条不是「永远不发送」）", async () => {
    setCapability(false, 0);
    const sends: Sends = [];
    await mount(sends);
    await type("/ru");
    press(inputEl(), { key: "Enter" });
    expect(sends).toEqual([["/ru", "steer"]]);
  });
});