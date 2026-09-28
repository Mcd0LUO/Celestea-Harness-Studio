// @vitest-environment jsdom
/**
 * W2036 · 主输入框的**命令补全框**在 IME 组合中不得消费按键。
 *
 * 缺陷（真机复现，桌面 1440x900 + CDP 原生事件，见交付报告 §真机证据）：
 *   输入框打 "/" ⇒ 补全框出现（首项 "/run"）⇒ 切中文输入法打拼音（组合串进 textarea
 *   ⇒ 值变成 "/run" 形状、补全框**仍然可见**）⇒ **按 Enter 确认候选词** —— 那一次 Enter
 *   被补全框当成「选中补全项」⇒ 输入框被写成 "/run "、补全框关闭。每确认一次候选词污染一次。
 *
 * 为什么 W2032/W2033 的守卫没挡住：那两轮的 isImeKey 守卫在 ui/inputbar/newline.ts 的
 * enterAction 内部，而 bindEnterKey 的第一行是 `if (interceptCommandKey(e)) return;`
 * —— 补全框**先**消费了这次按键，守卫根本跑不到。
 *
 * 本文件断言三层（判据真源是 **ui/ime.ts 的 isImeKey**，本文件不复刻它）：
 *   ① 引擎层：ui/commands/popup.ts 的 completionKey —— 组合中的 Enter/Tab/↑/↓/Esc 一律不消费；
 *   ② 装配层：installCommands 真装配出来的主输入框（组合中 Enter 不改值、不关框）；
 *   ③ 顺序层：installCommands 的监听器排在 bindEnterKey **之后**（证明「只改一个调用方会漏一半」）。
 *
 * ★ 引擎层为什么**直接调 completionKey** 而不是派发 DOM 事件：引擎自己不注册任何监听器
 *   （装配在 ui/commands/index.ts 的 installCommands 里）。往输入框派发事件测的是「谁注册了监听器」，
 *   不是 completionKey 本身 —— 本文件把这两件事分开测（②/③ 测装配，① 测引擎）。
 *
 * 非组合路径逐字不变是本文件的**另一半**：↑↓ 改高亮、Enter/Tab 选中、Esc 关框，
 * 都必须与改动前完全相同（否则守卫就是写太宽了）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at, doc, flush, resetHarness, type ElLike } from "./lib/w795-dom.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(HERE, "..", "apps", "web", "index.html");

interface InputLike extends ElLike {
  selectionStart: number;
  selectionEnd: number;
  setSelectionRange(a: number, b: number): void;
  focus(): void;
}
interface KeyEventLike { defaultPrevented: boolean }
interface PopupMod {
  initCompletion(el: unknown, pick: (i: { value: string }) => void): void;
  setProvider(p: (prefix: string) => unknown[]): void;
  showCompletion(prefix: string): Promise<void>;
  completionVisible(): boolean;
  activeItemLabel(): string;
  completionKey(e: Record<string, unknown>): boolean;
}

const KB = (globalThis as unknown as {
  KeyboardEvent: new (t: string, i?: Record<string, unknown>) => KeyEventLike;
}).KeyboardEvent;
const Ev = (globalThis as unknown as { Event: new (t: string, i?: { bubbles?: boolean }) => unknown }).Event;

const inputEl = (): InputLike => doc.getElementById("input") as unknown as InputLike;
const popupHidden = (): boolean =>
  (doc.getElementById("cmdPopup") as ElLike | null)?.classList.contains("hidden") ?? true;
const popupVisible = (): boolean => !popupHidden();
const rowNames = (): Array<string | null> =>
  Array.from(doc.querySelectorAll("#cmdPopup .cmd-row .cmd-name")).map((n) => n.textContent);

/** 组合中的两种判据形态：常规组合中 / compositionend 早到、只剩 keyCode=229 的那一次。 */
const IME_FORMS: Array<[string, Record<string, unknown>]> = [
  ["isComposing=true", { isComposing: true }],
  ["keyCode=229", { isComposing: false, keyCode: 229 }],
];

/** 把输入框置成 value 并把光标放末尾（不派发 input ⇒ 不触发 refresh）。 */
function type(value: string): InputLike {
  const el = inputEl();
  el.value = value;
  el.setSelectionRange(value.length, value.length);
  return el;
}

/** 打 "/" 让真提供者刷出补全框（与用户操作同路径：value + input 事件）。 */
async function slash(): Promise<void> {
  type("/").dispatchEvent(new Ev("input", { bubbles: true }));
  await flush();
}

/** 派发一次真实 keydown 到输入框（测装配层：谁注册了监听器）。 */
function press(k: string, init: Record<string, unknown> = {}): KeyEventLike {
  const e = new KB("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  inputEl().dispatchEvent(e);
  return e;
}

/** 装配**引擎本身**（不装任何调用方）：返回被选中的值列表。 */
async function bootEngine(): Promise<{ popup: PopupMod; picked: string[] }> {
  const popup = (await import(/* @vite-ignore */ at("ui/commands/popup.ts"))) as unknown as PopupMod;
  const picked: string[] = [];
  popup.initCompletion(doc.getElementById("input"), (i) => picked.push(i.value));
  popup.setProvider(() => [
    { label: "/run", desc: "执行", value: "/run" },
    { label: "/goal", desc: "目标", value: "/goal" },
  ]);
  await popup.showCompletion("r");
  return { popup, picked };
}

/** 直接调引擎的键盘入口（引擎不注册监听器 ⇒ 这是它的真实调用面）。 */
function engineKey(popup: PopupMod, k: string, init: Record<string, unknown> = {}) {
  let prevented = false;
  const consumed = popup.completionKey({ key: k, shiftKey: false, preventDefault() { prevented = true; }, ...init });
  return { consumed, prevented };
}

/** 装配**真调用方**：installCommands 自注册 keydown（它直接调 completionKey，不走 interceptKey）。 */
async function bootInstalled(): Promise<void> {
  vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => ({}) }));
  const cmd = (await import(/* @vite-ignore */ at("ui/commands/index.ts"))) as unknown as { installCommands(): void };
  cmd.installCommands();
  inputEl().focus();
  await flush();
}

const bodyOf = (html: string): string => {
  const m = /<body>([\s\S]*)<\/body>/.exec(html);
  if (!m || m[1] === undefined) throw new Error("index.html 里找不到 <body>…</body>");
  return m[1];
};

beforeEach(() => {
  resetHarness();
  localStorage.clear();
  doc.body.innerHTML = bodyOf(readFileSync(INDEX_HTML, "utf8"));
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
  doc.body.replaceChildren();
  localStorage.clear();
});
// ───────────────── ① 引擎层：completionKey 对组合中的按键零消费 ─────────────────
describe("W2036 · 引擎层：组合中的按键一律不被补全框消费", () => {
  for (const [label, init] of IME_FORMS) {
    it(label + " 的 Enter：不选中、不 preventDefault、补全框仍在、高亮不变", async () => {
      const { popup, picked } = await bootEngine();
      const before = popup.activeItemLabel();
      const r = engineKey(popup, "Enter", init);
      expect(r.consumed, "★ 组合中绝不消费（不选中补全项）").toBe(false);
      expect(picked, "★ 一个补全项都没被选中").toEqual([]);
      expect(r.prevented, "★ 不 preventDefault（这次按键归输入法）").toBe(false);
      expect(popup.completionVisible(), "★ 补全框必须仍在").toBe(true);
      expect(popup.activeItemLabel(), "高亮项不动").toBe(before);
    });

    it(label + " 的 ↑/↓/Esc/Tab：翻候选页/取消组合，一个都不该被补全框抢", async () => {
      const { popup, picked } = await bootEngine();
      const before = popup.activeItemLabel();
      for (const k of ["ArrowDown", "ArrowUp", "Escape", "Tab"]) {
        const r = engineKey(popup, k, init);
        expect(r.consumed, k + " 组合中不消费").toBe(false);
        expect(r.prevented, k + " 组合中不 preventDefault").toBe(false);
      }
      expect(popup.completionVisible(), "Esc 组合中是「取消组合」，不是关补全框").toBe(true);
      expect(popup.activeItemLabel(), "↑↓ 组合中是「翻候选页」，不改高亮").toBe(before);
      expect(picked).toEqual([]);
    });
  }

  it("非组合 ↑↓ 逐字不变：仍改高亮、仍被消费", async () => {
    const { popup } = await bootEngine();
    expect(engineKey(popup, "ArrowDown"), "↓ 仍被消费").toMatchObject({ consumed: true, prevented: true });
    expect(popup.activeItemLabel(), "↓ 仍下移一格").toBe("/goal");
    expect(engineKey(popup, "ArrowUp"), "↑ 仍被消费").toMatchObject({ consumed: true, prevented: true });
    expect(popup.activeItemLabel(), "↑ 仍回到首项").toBe("/run");
  });

  // ★ 「选中后关框」不在这里断言：引擎的 choose() 只回调 onPick，关框是**调用方**
  //   （ui/commands/index.ts 的 applyCommand/applyMention 里的 hideCompletion）的职责。
  //   引擎层断言「选中了哪一项」，关框由下方装配层的真调用方断言。
  it("非组合 Enter 逐字不变：仍选中当前高亮项", async () => {
    const { popup, picked } = await bootEngine();
    expect(engineKey(popup, "Enter"), "Enter 仍被消费").toMatchObject({ consumed: true, prevented: true });
    expect(picked, "Enter 仍选中当前高亮项").toEqual(["/run"]);
  });

  it("非组合 Tab 逐字不变：仍选中当前高亮项", async () => {
    const { popup, picked } = await bootEngine();
    expect(engineKey(popup, "Tab"), "Tab 仍被消费").toMatchObject({ consumed: true, prevented: true });
    expect(picked, "Tab 仍选中当前高亮项").toEqual(["/run"]);
  });

  it("非组合 Esc 逐字不变：仍关框、不选中", async () => {
    const { popup, picked } = await bootEngine();
    expect(engineKey(popup, "Escape"), "Esc 仍被消费").toMatchObject({ consumed: true, prevented: true });
    expect(popup.completionVisible(), "Esc 仍关补全框").toBe(false);
    expect(picked).toEqual([]);
  });

  it("补全框不可见时，非组合按键仍一律不消费（既有行为不变）", async () => {
    const popup = (await import(/* @vite-ignore */ at("ui/commands/popup.ts"))) as unknown as PopupMod;
    popup.initCompletion(doc.getElementById("input"), () => {});
    expect(popup.completionVisible()).toBe(false);
    for (const k of ["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown"]) {
      expect(engineKey(popup, k).consumed, k + " 无框时不消费").toBe(false);
    }
  });
});
// ───────────── ② 装配层：installCommands 真装配出来的主输入框 ─────────────
describe("W2036 · 装配层：主输入框打 / 后的组合按键", () => {
  it("打 / ⇒ 补全框出现、首项 /run（复核真机场景的前置）", async () => {
    await bootInstalled();
    await slash();
    expect(popupVisible(), "补全框出现").toBe(true);
    expect(rowNames()[0], "首项是 /run").toBe("/run");
  });

  for (const [label, init] of IME_FORMS) {
    it(label + " 的 Enter：★ 输入框值不变、补全框仍在（本工单的缺陷）", async () => {
      await bootInstalled();
      await slash();
      const el = inputEl();
      const e = press("Enter", init);
      expect(el.value, "★ 输入框值必须还是 /（不许被写成 /run 加空格）").toBe("/");
      expect(popupVisible(), "★ 补全框必须仍在").toBe(true);
      expect(e.defaultPrevented, "组合中的 Enter 不归补全框").toBe(false);
    });
  }

  it("对照：非组合 Enter ⇒ 照常选中 /run 写回输入框并关框（改动前逐字相同）", async () => {
    await bootInstalled();
    await slash();
    const el = inputEl();
    const e = press("Enter");
    expect(el.value, "★ 非组合 Enter 仍选中补全项").toBe("/run ");
    expect(popupVisible(), "选中后关框").toBe(false);
    expect(e.defaultPrevented, "仍被消费").toBe(true);
  });

  it("组合中的 ↑↓/Esc 不翻页、不关框；非组合的照常", async () => {
    await bootInstalled();
    await slash();
    const cmd = (await import(/* @vite-ignore */ at("ui/commands/index.ts"))) as unknown as { activeItemLabel(): string };
    expect(cmd.activeItemLabel()).toBe("/run");
    press("ArrowDown", { isComposing: true });
    expect(cmd.activeItemLabel(), "组合中 ↓ 是翻候选页，不改高亮").toBe("/run");
    press("ArrowDown");
    expect(cmd.activeItemLabel(), "非组合 ↓ 仍改高亮").toBe("/goal");
    press("Escape");
    expect(popupVisible(), "非组合 Esc 仍关框").toBe(false);
  });
});

// ───────── ③ 顺序层：两个调用方都要覆盖（只改 newline.ts 会漏一半） ─────────
describe("W2036 · 顺序层：守卫必须在引擎里（两个调用方都经过它）", () => {
  it("只有 installCommands（没有 bindEnterKey）时，组合中 Enter 同样不许被消费", async () => {
    await bootInstalled(); // 只装 installCommands：它的监听器直接调 completionKey
    await slash();
    expect(popupVisible()).toBe(true);
    press("Enter", { isComposing: true });
    expect(inputEl().value, "★ 这条路径不经过 newline.ts ⇒ 守卫只能在引擎里").toBe("/");
    expect(popupVisible()).toBe(true);
  });

  it("installCommands 晚于 initInputBar 装配 ⇒ 组合中 Enter 既不选中也不发送", async () => {
    const sends: Array<[string, string]> = [];
    const bar = (await import(/* @vite-ignore */ at("ui/inputbar.ts"))) as unknown as {
      initInputBar(h: { send(t: string, m: string): void; cancel(): void }): void;
    };
    bar.initInputBar({ send: (t, m) => sends.push([t, m]), cancel: () => {} });
    await bootInstalled(); // 真顺序：main.ts 里 installCommands() 在 initInputBar() 之后
    await slash();
    press("Enter", { isComposing: true });
    expect(sends, "★ 组合中不发送（W2032 的语义仍成立）").toEqual([]);
    expect(inputEl().value, "★ 也不被补全框写成 /run 加空格").toBe("/");
    expect(popupVisible()).toBe(true);
  });
});

// ───── ④ 浮层栈：全仓唯一的 document 级 Esc 监听也必须有 IME 守卫 ─────
// 真机实测（桌面 1440x900）：打 "/" ⇒ 补全框出现 ⇒ 拼音组合中按 Esc ⇒ 补全框**消失**
// （改动前）。那一次 Esc 是输入法的「取消组合」，不是「关掉这层浮层」。
// 这一条**不经过** completionKey（它在捕获阶段就先把层关掉了）⇒ 必须单独断言，
// 否则「只改引擎」会在真机上留一半没修。
describe("W2036 · 浮层栈：组合中的 Esc 不许关掉任何一层", () => {
  /** 压一层可观测的浮层；返回它被关掉的次数。 */
  async function pushProbe(): Promise<{ closed: () => number }> {
    const ov = (await import(/* @vite-ignore */ at("utils/overlays.ts"))) as unknown as {
      pushOverlay(close: () => void): unknown;
      overlayDepth(): number;
    };
    let n = 0;
    ov.pushOverlay(() => { n += 1; });
    return { closed: () => n };
  }

  for (const [label, init] of IME_FORMS) {
    it(label + " 的 Esc：不关层、不 preventDefault", async () => {
      const probe = await pushProbe();
      const e = press("Escape", init);
      expect(probe.closed(), "★ 组合中的 Esc 归输入法，不许关掉栈顶那层").toBe(0);
      expect(e.defaultPrevented, "★ 不消费（让输入法处理取消组合）").toBe(false);
    });
  }

  it("非组合 Esc 逐字不变：仍关掉栈顶那一层并 preventDefault", async () => {
    const probe = await pushProbe();
    const e = press("Escape");
    expect(probe.closed(), "非组合 Esc 仍关栈顶").toBe(1);
    expect(e.defaultPrevented, "仍被消费").toBe(true);
  });

  it("★ 端到端：组合中的 Esc 不关掉命令补全框（真机缺陷的 jsdom 对应）", async () => {
    await bootInstalled();
    await slash();
    expect(popupVisible()).toBe(true);
    press("Escape", { isComposing: true });
    expect(popupVisible(), "★ 组合中 Esc 不许关补全框").toBe(true);
    press("Escape");
    expect(popupVisible(), "非组合 Esc 仍关补全框").toBe(false);
  });
});
