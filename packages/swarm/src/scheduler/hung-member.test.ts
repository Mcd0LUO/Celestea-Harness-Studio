/**
 * B1-02 回归：一个**无视 abort** 的成员（executor 的 Promise 永不 settle）不得再把整批
 * `run()` 钉死。
 *
 * 修复前（audit3-r2/B1/probe-hang.ts C1，退出码 7）：`timeoutMs=250` 下 1500ms 后
 * `snapshot = done 5/6, settled=false, active=1` —— 批次 Promise 永不 resolve。
 *
 * 修复后：超时兜底闸门把「executor 不配合」也变成一次正常的 settled(failed)，
 * 落位、判死、唤醒、批次收尾全部复用既有路径。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runSwarm } from "./index.js";
import { flush, specsOf } from "./test-harness.js";

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

/** 真实定时器注入（本用例要断言「定时器不残留」，故不用 test-harness 的假 deps）。 */
const clock = () => ({
  now: () => Date.now(),
  setTimeout: (h: () => void, ms: number) => setTimeout(h, ms),
  clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
});

describe("B1-02 · 成员不 settle 也不得钉死整批", () => {
  it("无视 abort 的成员 + 小 timeoutMs ⇒ run() 仍在有限时间内落定", async () => {
    const p = runSwarm(
      specsOf(6),
      {
        ...clock(),
        isRateLimitError: () => false,
        executor: {
          run: async (spec) => {
            if (spec.index === 1) await new Promise<never>(() => undefined);
            return { result: "ok-" + spec.index };
          },
        },
      },
      { initialLaunchLimit: 6, initialLaunchIntervalMs: 1, timeoutMs: 250, maxConcurrency: 16 },
    );

    // 远大于 timeoutMs(250) 的推进。修复前批次在这里仍未落定，await p 会把用例挂到超时。
    await flush(5_000);
    const results = await p;

    expect(results).toHaveLength(6);
    expect(results[0]?.outcome).toBe("failed");
    expect(results[0]?.error).toBe("Subagent timed out.");
    // 同一个闸门不能连坐：其余 5 个照常完成。
    expect(results.slice(1).every((r) => r.outcome === "completed")).toBe(true);
  });

  it("闸门不得留下未撤除的定时器（批次收尾后 getTimerCount 归零）", async () => {
    const p = runSwarm(
      specsOf(3),
      {
        ...clock(),
        isRateLimitError: () => false,
        executor: { run: async () => new Promise<never>(() => undefined) },
      },
      { initialLaunchLimit: 3, initialLaunchIntervalMs: 1, timeoutMs: 400, maxConcurrency: 16 },
    );

    await flush(400);
    const results = await p;
    expect(results.every((r) => r.outcome === "failed")).toBe(true);
    // 已被撤除的闸门若还在，就会把这个进程钉到 timeoutMs 之后才退出。
    expect(vi.getTimerCount()).toBe(0);
  });

  it("timeoutMs=0（禁用）时不武装闸门，行为与修复前逐字节等价", async () => {
    let settled = false;
    const p = runSwarm(
      specsOf(2),
      {
        ...clock(),
        isRateLimitError: () => false,
        executor: { run: async (spec) => ({ result: "ok-" + spec.index }) },
      },
      { initialLaunchLimit: 2, initialLaunchIntervalMs: 1, timeoutMs: 0 },
    );
    p.then(() => { settled = true; });
    await flush(1_000_000);
    expect(settled).toBe(true);
    expect((await p).every((r) => r.outcome === "completed")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
