// ============================================================================
// tests/w9300-f3-1-autoscroll-coalesce.test.ts — W9300/F3-1 门禁：
// 流式期间的贴底写入必须**一帧至多一次**（帧内合并），且闩锁语义一字未变。
//
// 背景（真机 Chrome 154 + CDP 实测，见 results/audit3-r2/F3/）：
//   · `autoscroll()` 每节拍写一次 `scrollTop = scrollHeight`；600 列下一次 200 帧
//     突发实测 scrollHeight 被读 136 次、scrollTop 被写 81 次 ⇒ 217 次强制同步布局；
//   · **读与写代价同阶**（只读 6.8ms / 只写 6.9ms / 读后写 7.2ms @600 列），
//     所以"不读 scrollHeight"**并不能**省下布局 —— 真正的杠杆是**一帧只写一次**。
//
// 本门禁跑**真实生产代码**（ui/messages/scroll.ts，esbuild 打包），断言：
//   A. 同一帧内 N 次 autoscrollSoon ⇒ 只排 1 个 rAF（合并生效）；
//   B. 跨帧后又能再排（合并窗口是一帧，不是一次）；
//   C. 闩锁为假时既不排也不写（读者往上滚后不被拽回，W12）；
//   D. 隐藏容器不排 rAF（W514）；
//   E. 回调执行前用户解锁 ⇒ 回调里不贴底（合并不能把读者拽回去）；
//   F. 回归：force=true 的 autoscroll 仍然**同步**写（W1524 的终态保证不变）。
// ============================================================================
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bundleFrontend, El, installDom, restoreDom } from "./lib/w1467-dom.js";

interface ScrollMod {
  autoscroll: (ctx: unknown, force?: boolean) => void;
  autoscrollSoon: (ctx: unknown) => void;
  AT_BOTTOM_PX: number;
}

let mod: ScrollMod;
let tmpDir = "";

/** 手动推进的 rAF 队列（本门禁要断言"一帧一次"，所以帧由测试自己掌控）。 */
let rafQueue: Array<() => void> = [];

beforeAll(async () => {
  installDom();
  // window === globalThis（见 w1467-dom.ts:186），所以这里装 rAF 即是页面上的 rAF。
  (globalThis as unknown as Record<string, unknown>)["requestAnimationFrame"] = (cb: () => void): number => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  tmpDir = mkdtempSync(join(tmpdir(), "w9300-f3-1-"));
  const out = join(tmpDir, "scroll.mjs");
  await bundleFrontend(
    "export { autoscroll, autoscrollSoon, AT_BOTTOM_PX } from './apps/web/src/ui/messages/scroll.ts';",
    out,
  );
  mod = (await import(pathToFileURL(out).href)) as ScrollMod;
});

afterAll(() => {
  delete (globalThis as unknown as Record<string, unknown>)["requestAnimationFrame"];
  restoreDom();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => { rafQueue = []; });

/** 推进一帧：按 FIFO 执行本帧排入的全部回调。 */
function frame(): void {
  const due = rafQueue;
  rafQueue = [];
  for (const cb of due) cb();
}

/** 可控几何的会话容器（浏览器语义：写 scrollTop 被钳制并派发 scroll）。 */
class Pane {
  el: El;
  hint: El;
  stickBottom: boolean;
  /** scrollTop 被**写**的次数（合并效果的可观测面）。 */
  writes = 0;
  private _top: number;
  private _content: number;
  readonly clientHeight: number;

  constructor(clientHeight = 300, content = 0) {
    this.el = new El("div");
    this.hint = new El("div");
    this.stickBottom = true;
    this.clientHeight = clientHeight;
    this._content = content;
    this._top = 0;
    Object.defineProperty(this.el, "clientHeight", { get: () => this.clientHeight });
    Object.defineProperty(this.el, "scrollHeight", { get: () => this._content });
    Object.defineProperty(this.el, "scrollTop", {
      get: () => this._top,
      set: (v: number) => {
        const max = Math.max(0, this._content - this.clientHeight);
        const next = Math.min(Math.max(0, Math.round(v)), max);
        const moved = next !== this._top;
        this._top = next;
        this.writes += 1;
        if (moved) (this.el as unknown as { _fire(k: string): void })._fire("scroll");
      },
    });
  }

  grow(px: number): void { this._content += px; }
  get top(): number { return this._top; }
  get content(): number { return this._content; }
  gap(): number { return this._content - this.clientHeight - this._top; }
  /** 用户滚动（派发 scroll ⇒ 触发闩锁重判）；清零计数以便只看合并的写入。 */
  userScrollTo(top: number): void { this.el.scrollTop = top; this.writes = 0; }
}

describe("W9300/F3-1 · stick-to-bottom coalesced to one write per frame", () => {  it("A. coalesces N ticks in one frame into a single write (the fix)", () => {
    const pane = new Pane(300, 1000);
    mod.autoscroll(pane); // 先贴一次底，闩锁与 writtenTop 建立
    frame(); // 把那一次同步写之后的队列清空
    pane.writes = 0;
    // 一个流式突发：20 个节拍落在**同一帧**内
    for (let i = 0; i < 20; i += 1) {
      pane.grow(40);
      mod.autoscrollSoon(pane);
    }
    expect(rafQueue).toHaveLength(1); // 只排了一个 rAF —— 合并生效
    expect(pane.writes).toBe(0); // 还没写：写入推迟到帧内
    frame();
    expect(pane.writes).toBe(1); // 整帧只写一次
    expect(pane.gap()).toBe(0); // 且确实贴住了底
  });

  it("B. coalesces again on the next frame (window is one frame, not once)", () => {
    const pane = new Pane(300, 1000);
    mod.autoscroll(pane);
    frame();
    pane.writes = 0;
    pane.grow(200);
    mod.autoscrollSoon(pane);
    frame();
    expect(pane.writes).toBe(1);
    // 下一帧：还能再合并一次（否则第二个节拍就永远不贴底了）
    pane.writes = 0;
    pane.grow(200);
    mod.autoscrollSoon(pane);
    frame();
    expect(pane.writes).toBe(1);
    expect(pane.gap()).toBe(0);
  });

  it("C. schedules nothing while the lock is off (never yanks the reader, W12)", () => {
    const pane = new Pane(300, 2000);
    mod.autoscroll(pane);
    pane.userScrollTo(200); // 用户往上滚 ⇒ 闩锁解锁
    frame();
    pane.writes = 0;
    pane.grow(400);
    mod.autoscrollSoon(pane);
    expect(rafQueue).toHaveLength(0); // 根本不排
    frame();
    expect(pane.writes).toBe(0);
    expect(pane.top).toBe(200); // 没有被拽回底部
  });

  it("D. schedules nothing for a hidden pane (W514)", () => {
    const pane = new Pane(300, 2000);
    pane.el.hidden = true;
    mod.autoscrollSoon(pane);
    expect(rafQueue).toHaveLength(0);
    expect(pane.writes).toBe(0);
  });

  it("E. does not stick when the user scrolls up before the frame runs", () => {
    const pane = new Pane(300, 2000);
    mod.autoscroll(pane);
    frame();
    pane.grow(500);
    mod.autoscrollSoon(pane); // 已排上，但帧还没跑
    pane.userScrollTo(300); // 用户在本帧内往上滚 ⇒ 闩锁解锁
    frame(); // 回调此刻必须看到闩锁为假
    expect(pane.writes).toBe(0);
    expect(pane.top).toBe(300);
  });

  it("F. regression: forced autoscroll still writes SYNCHRONOUSLY (W1524)", () => {
    const pane = new Pane(300, 2000);
    mod.autoscroll(pane);
    pane.userScrollTo(100); // 解锁
    frame();
    pane.writes = 0;
    pane.grow(500);
    mod.autoscroll(pane, true); // force：调用方随后立即依赖最终滚动位
    expect(pane.writes).toBe(1); // 同一调用栈内就写了
    expect(pane.gap()).toBe(0);
  });
});
