// @vitest-environment jsdom
// ============================================================================
// tests/w1467-scroll-follow.test.ts — W1467 问题 1 的机械门禁：
// **页面必须跟随模型输出向下滚动**。
//
// 真机复现到的根因（CDP 实测，见报告）：旧实现每一帧都算
//     scrollTop + clientHeight >= scrollHeight - AT_BOTTOM_PX
// 流式过程中一次渲染（一整块 markdown / 一张工具卡）就能把 scrollHeight 顶高远超
// 25px，那一帧判定为假 ⇒ **从此永久失跟**（实测第一次 +mcol 让 7932→8020，gap 停在
// 88px，其后 242/495 帧都不贴底，直到轮次结束）。
//
// 门禁跑**真实生产代码**（ui/messages/scroll.ts，真 jsdom 下直接 import），用可控的
// 几何序列复现那个场景，断言：
//   A. 内容一次长高远超阈值后，后续 autoscroll 仍然贴底（这是 bug 本体）；
//   B. 用户主动往上滚 → 解锁（不能把读者拽回去，W12）；
//   C. 用户滚回底部 → 重新上锁；
//   D. force 无视闩锁（完成/新消息路径）；
//   E. 隐藏容器不写布局，只记「期望贴底」（W514）。
//
// ★ W9395：原先用 esbuild 打包 + 手搓最小 DOM 垫片（tests/lib/w1467-dom.ts）；
//   现在改跑**真 jsdom**，生产模块直接 import，垫片已删除。
// ============================================================================
import { describe, expect, it, beforeAll } from "vitest";
import { at, Ev } from "./lib/w795-dom.js";
import { domEl, type DomEl } from "./lib/dom-tree.js";

interface ScrollMod {
  autoscroll: (ctx: unknown, force?: boolean) => void;
  AT_BOTTOM_PX: number;
}

let mod: ScrollMod;

beforeAll(async () => {
  mod = (await import(/* @vite-ignore */ at("ui/messages/scroll.ts"))) as ScrollMod;
});

/**
 * 一个可控几何的会话容器。
 *
 * 真 jsdom **不做布局**：它的 scrollTop/clientHeight/scrollHeight 恒为 0。所以这里在
 * **实例上**用 Object.defineProperty 定义这三个 own property（遮住原型 getter），
 * 并自己实现浏览器语义：写 scrollTop 会被钳到 [0, scrollHeight - clientHeight]，
 * 并且**派发 scroll 事件** —— 这正是闩锁与「用户滚动」相互作用的真实通路
 * （不派发事件，B/C 两条就永远测不到）。
 * 遮住原型 getter 这件事由本文件的第一条用例实测确认（不是口头假设）。
 */
class Pane {
  el: DomEl;
  hint: DomEl;
  stickBottom: boolean;
  private _top: number;
  private _content: number;
  readonly clientHeight: number;

  constructor(clientHeight = 300, content = 0) {
    this.el = domEl("div");
    this.hint = domEl("div");
    this.stickBottom = true;
    this.clientHeight = clientHeight;
    this._content = content;
    this._top = 0;
    // 实例上的 own property 遮住 jsdom Element.prototype 上的 getter。
    Object.defineProperty(this.el, "clientHeight", { get: () => this.clientHeight });
    Object.defineProperty(this.el, "scrollHeight", { get: () => this._content });
    Object.defineProperty(this.el, "scrollTop", {
      get: () => this._top,
      set: (v: number) => {
        const max = Math.max(0, this._content - this.clientHeight);
        const next = Math.min(Math.max(0, Math.round(v)), max);
        const moved = next !== this._top;
        this._top = next;
        // 浏览器在滚动位置**真的变了**之后才派发 scroll 事件。
        if (moved) this.el.dispatchEvent(new Ev("scroll"));
      },
    });
  }

  /** 内容长高（= 一次流式渲染）。不改变 scrollTop（与浏览器一致）。 */
  grow(px: number): void { this._content += px; }
  get top(): number { return this._top; }
  get content(): number { return this._content; }
  /** 距底像素（0 = 完全贴底）。 */
  gap(): number { return this._content - this.clientHeight - this._top; }
  /** 模拟用户滚动：写 scrollTop（会派发 scroll 事件 ⇒ 触发闩锁重判）。 */
  userScrollTo(top: number): void { this.el.scrollTop = top; }
}

describe("W1467 · the page follows the model output (scroll follow)", () => {
  it("fake geometry is an own property that really shadows the jsdom prototype getter", () => {
    const pane = new Pane(300, 1000);
    // ① 三个几何量都定义在**实例**上（不是原型）。
    expect(Object.prototype.hasOwnProperty.call(pane.el, "scrollTop")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(pane.el, "clientHeight")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(pane.el, "scrollHeight")).toBe(true);
    // ② 读到的确实是夹具几何 —— jsdom 原型的 clientHeight 恒为 0，这里必须是 300。
    expect(pane.el.clientHeight).toBe(300);
    expect(pane.el.scrollHeight).toBe(1000);
    // ③ 写入被钳制（jsdom 原型的 scrollTop 写入恒为 0）。
    pane.el.scrollTop = 12345;
    expect(pane.el.scrollTop).toBe(700); // 1000 - 300
    pane.el.scrollTop = -5;
    expect(pane.el.scrollTop).toBe(0);
    // ④ 位置真的变化才派发 scroll（浏览器语义）。
    let fired = 0;
    pane.el.addEventListener("scroll", () => { fired += 1; });
    pane.el.scrollTop = 100;
    pane.el.scrollTop = 100;
    expect(fired).toBe(1);
  });

  it("keeps following after content grows past the threshold in ONE frame (the bug)", () => {
    const pane = new Pane(300, 1000);
    mod.autoscroll(pane);
    expect(pane.gap()).toBe(0); // 起手贴底
    // 关键帧：一次渲染把内容顶高 88px —— 远超 AT_BOTTOM_PX(25)。
    // 旧实现在这里判定为假，从此不再跟随（真机实测 gap 停在 88）。
    pane.grow(88);
    mod.autoscroll(pane);
    expect(pane.gap()).toBe(0);
    // 再来几帧更大的增量，仍然要贴底。
    for (const px of [120, 300, 1500]) {
      pane.grow(px);
      mod.autoscroll(pane);
      expect(pane.gap()).toBe(0);
    }
  });

  it("unlocks when the user scrolls up (never yanks the reader back, W12)", () => {
    const pane = new Pane(300, 2000);
    mod.autoscroll(pane);
    pane.userScrollTo(200); // 用户往上滚
    expect(pane.gap()).toBeGreaterThan(mod.AT_BOTTOM_PX);
    pane.grow(200);
    mod.autoscroll(pane);
    expect(pane.top).toBe(200); // 没有被拽回底部
  });

  it("re-locks when the user scrolls back to the bottom", () => {
    const pane = new Pane(300, 2000);
    mod.autoscroll(pane);
    pane.userScrollTo(200);
    pane.grow(100);
    mod.autoscroll(pane);
    expect(pane.top).toBe(200); // 仍解锁
    pane.userScrollTo(pane.content); // 用户滚回底部
    pane.grow(150);
    mod.autoscroll(pane);
    expect(pane.gap()).toBe(0); // 恢复跟随
  });

  it("force always snaps to the bottom (done / new message paths)", () => {
    const pane = new Pane(300, 2000);
    mod.autoscroll(pane);
    pane.userScrollTo(100); // 解锁
    pane.grow(500);
    mod.autoscroll(pane, true); // force
    expect(pane.gap()).toBe(0);
  });

  it("does not write layout for a hidden pane, only records the intent (W514)", () => {
    const pane = new Pane(300, 2000);
    pane.el.hidden = true;
    pane.el.scrollTop = 50;
    mod.autoscroll(pane);
    expect(pane.top).toBe(50); // 后台容器一个字节都没写
    mod.autoscroll(pane, true);
    expect(pane.top).toBe(50); // force 也不写
    expect(pane.stickBottom).toBe(true); // 但记下了「切回时贴底」
  });

  it("is a no-op while the lock is off and nothing forces it", () => {
    const pane = new Pane(300, 2000);
    mod.autoscroll(pane);
    pane.userScrollTo(0);
    pane.grow(400);
    mod.autoscroll(pane);
    expect(pane.top).toBe(0);
  });
});
