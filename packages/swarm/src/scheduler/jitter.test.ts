import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SWARM_SCHEDULER_CONFIG, type SwarmSchedulerConfig } from "../types.js";
import { runSwarm } from "./index.js";
import { retryDelayMs } from "./rate-limit.js";
import { drain, harness, specsOf } from "./test-harness.js";

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

const CONFIG: Pick<SwarmSchedulerConfig, "retryBaseMs" | "retryFactor"> = { retryBaseMs: 3000, retryFactor: 2 };

describe("退避抖动（本仓新增，规避上游 D5 重试雷暴）", () => {
  it("randomFn 固定 0.5 → 恰好 0.75 倍基准", () => {
    expect(retryDelayMs(CONFIG, 1, 0.5)).toBe(2250);
    expect(retryDelayMs(CONFIG, 2, 0.5)).toBe(4500);
  });

  it("randomFn 固定 0 → 0.5 倍下界（抖动只缩不放，绝不提前重试）", () => {
    expect(retryDelayMs(CONFIG, 1, 0)).toBe(1500);
    expect(retryDelayMs(CONFIG, 3, 0)).toBe(6000);
  });

  it("抖动区间恒在 [0.5x, 1.0x] 内且单调（绝不越过上界）", () => {
    for (let n = 1; n <= 5; n += 1) {
      const base = 3000 * 2 ** (n - 1);
      expect(retryDelayMs(CONFIG, n, 0)).toBe(base * 0.5);
      expect(retryDelayMs(CONFIG, n, 1)).toBe(base);
      expect(retryDelayMs(CONFIG, n, 0.25)).toBeGreaterThan(retryDelayMs(CONFIG, n, 0));
      expect(retryDelayMs(CONFIG, n, 0.25)).toBeLessThan(retryDelayMs(CONFIG, n, 0.75));
    }
  });

  it("randomFn 真被调用（证明抖动不是死代码）", () => {
    let calls = 0;
    const rand = (): number => {
      calls += 1;
      return 0.5;
    };
    retryDelayMs(CONFIG, 1, rand());
    expect(calls).toBe(1);
  });
});

describe("本仓三条默认值（§4 契约，与源仓的差异都在这里）", () => {
  it("maxConcurrency 缺省 16（源仓是 undefined=无上限，本仓必须有闸门）", () => {
    expect(DEFAULT_SWARM_SCHEDULER_CONFIG.maxConcurrency).toBe(16);
  });

  it("timeoutMs 缺省 2 小时（7_200_000ms）", () => {
    expect(DEFAULT_SWARM_SCHEDULER_CONFIG.timeoutMs).toBe(7_200_000);
  });

  it("maxRateLimitRetries 缺省 3（源仓是 undefined=无限，本仓默认开启）", () => {
    expect(DEFAULT_SWARM_SCHEDULER_CONFIG.maxRateLimitRetries).toBe(3);
  });
});

/**
 * 缺省 maxConcurrency=16 这道闸门**真的生效**。
 *
 * 为什么这条必须存在：它是本仓相对源仓的**行为变更**——源仓 maxConcurrency 缺省
 * undefined（= 无上限），因为 DSH 有一个宿主派发池在闸门之外兜底；本仓没有那层兜底，
 * 闸门是并发失控的唯一防线（feature §4「真实接线」）。而 core.test.ts 里「128 成员规模」
 * 那条为了适配本仓前提**显式传了 maxConcurrency:128**，等于把闸门关掉——若没有本条，
 * 「缺省 16」这个决策就没有任何测试盯着，将来有人把默认值改回 undefined 也不会红。
 *
 * 测法：跑 60 个成员（远超 16），夹具在每次 executor.run 进入时累加 liveNow 并记录过程
 * 最大值；drain 边放边结算，于是闸门若失效会立刻冲到 60。
 */
describe("缺省并发闸门（本仓新增：缺省 16，非源仓的无上限）", () => {
  it("60 个成员下，同时在跑永不超过缺省上限 16", async () => {
    const h = harness();
    const p = runSwarm(specsOf(60), h.deps);
    await drain(h, p);

    expect(h.maxLive()).toBeLessThanOrEqual(DEFAULT_SWARM_SCHEDULER_CONFIG.maxConcurrency);
    // 反向钉住：闸门确实顶到过上限（否则 ≤16 可能来自闸门早退，那是假绿）。
    expect(h.maxLive()).toBe(DEFAULT_SWARM_SCHEDULER_CONFIG.maxConcurrency);
    // 全部 60 个都跑完并落位，证明闸门只是限流、不是饿死。
    const results = await p;
    expect(results).toHaveLength(60);
    expect(results.every((r) => r.outcome === "completed")).toBe(true);
  });
});
