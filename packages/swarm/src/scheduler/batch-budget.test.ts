/**
 * W9290 P1 批次回归：B1-03（批次预算）/ B1-04（副作用重放）/ B1-05（非法配置抛工具外）。
 *
 * 三条钉在同一个文件里：它们共用同一条链（配置 -> 调度器 -> 落定 -> 渲染），
 * 任何一条松了，另外两条的断言都还可能绿。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runSwarm, validateSchedulerConfig } from "./index.js";
import type { SwarmExecutor, SwarmSchedulerDeps, SwarmTaskSpec } from "../types.js";
import { DEFAULT_SWARM_SCHEDULER_CONFIG } from "../types.js";
import { swarmTool, type SwarmToolDeps } from "../tool.js";
import { flush, specsOf } from "./test-harness.js";

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

/** 真实定时器注入（本文件要断言「定时器不残留」，故不用 test-harness 的假 deps）。 */
interface Harness extends SwarmSchedulerDeps {
  controller: AbortController;
}

const clock = (executor: SwarmExecutor, isRateLimitError: (e: unknown) => boolean = () => false): Harness => {
  const controller = new AbortController();
  return {
    now: () => Date.now(),
    setTimeout: (h: () => void, ms: number) => setTimeout(h, ms),
    clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
    signal: controller.signal,
    randomFn: () => 0.5,
    executor,
    isRateLimitError,
    controller,
  };
};
describe("B1-05 非法 schedulerConfig 必须变成结果，不能抛", () => {
  it("每一个数值字段的 NaN / Infinity / 负数 / 非整数 一律拒绝", () => {
    const bad: [string, Record<string, unknown>][] = [
      ["timeoutMs: NaN", { timeoutMs: Number.NaN }],
      ["timeoutMs: Infinity", { timeoutMs: Number.POSITIVE_INFINITY }],
      ["timeoutMs: -1", { timeoutMs: -1 }],
      ["initialLaunchLimit: 0", { initialLaunchLimit: 0 }],
      ["initialLaunchLimit: NaN", { initialLaunchLimit: Number.NaN }],
      ["initialLaunchLimit: Infinity", { initialLaunchLimit: Number.POSITIVE_INFINITY }],
      ["initialLaunchIntervalMs: NaN", { initialLaunchIntervalMs: Number.NaN }],
      ["initialLaunchIntervalMs: -1", { initialLaunchIntervalMs: -1 }],
      ["retryBaseMs: NaN", { retryBaseMs: Number.NaN }],
      ["retryFactor: 0", { retryFactor: 0 }],
      ["capacityShrinkDebounceMs: NaN", { capacityShrinkDebounceMs: Number.NaN }],
      ["capacityRecoveryIntervalMs: 0", { capacityRecoveryIntervalMs: 0 }],
      ["maxConcurrency: 0", { maxConcurrency: 0 }],
      ["maxConcurrency: 1.5", { maxConcurrency: 1.5 }],
      ["maxRateLimitRetries: 0", { maxRateLimitRetries: 0 }],
      ["maxTotalMs: NaN", { maxTotalMs: Number.NaN }],
      ["maxBatchRateLimitRetries: -1", { maxBatchRateLimitRetries: -1 }],
    ];
    for (const [label, cfg] of bad) {
      expect(() => validateSchedulerConfig(cfg as never), label).toThrow();
    }
  });

  it("合法边界值仍被接受（0 = 禁用 是有意语义，不得误伤）", () => {
    const ok = [
      { timeoutMs: 0 },
      { maxTotalMs: 0 },
      { maxBatchRateLimitRetries: 0 },
      { initialLaunchIntervalMs: 0 },
      { retryBaseMs: 0 },
      { maxConcurrency: 1 },
    ];
    for (const cfg of ok) {
      expect(() => validateSchedulerConfig(cfg as never), JSON.stringify(cfg)).not.toThrow();
    }
  });

  it("默认值本身全部合法（否则一开箱就抛）且预算非零", () => {
    expect(() => validateSchedulerConfig()).not.toThrow();
    expect(DEFAULT_SWARM_SCHEDULER_CONFIG.maxTotalMs).toBeGreaterThan(0);
    expect(DEFAULT_SWARM_SCHEDULER_CONFIG.maxBatchRateLimitRetries).toBeGreaterThan(0);
  });

  it("工具把非法配置变成 ok:false/step:config，绝不抛出 execute()", async () => {
    const tool = swarmTool({
      llm: { generate: () => Promise.reject(new Error('unused')) },
      tools: { register: () => undefined, addGuard: () => undefined, get: () => undefined, schemas: () => [], dispatch: () => Promise.resolve({}) },
      loopFactory: () => ({ runTurn: async () => undefined }),
      config: { model: 'm' },
      schedulerConfig: { timeoutMs: Number.NaN },
    } as unknown as SwarmToolDeps);

    const out = await tool.execute({ description: 'p', prompt_template: 'x {{item}}', items: ['a', 'b'] });
    expect(out).toMatchObject({ ok: false, step: 'config' });
    expect(String((out as { error: string }).error)).toContain('finite');
  });
});

describe("B1-03 整批预算：批次必须有一个与 attempt 无关的上界", () => {
  it("maxTotalMs 到点 ⇒ 整批取消，未落定的成员记 aborted（不是 failed）", async () => {
    const deps = clock({
      run: async (spec: SwarmTaskSpec) => { await new Promise((r) => setTimeout(r, 5_000)); return { result: 'ok-' + spec.index }; },
    });
    const p = runSwarm(specsOf(4), deps, {
      initialLaunchLimit: 4, initialLaunchIntervalMs: 1, timeoutMs: 60_000, maxTotalMs: 300, maxConcurrency: 16,
    });

    await flush(500);
    const results = await p;

    expect(results).toHaveLength(4);
    expect(results.every((r) => r.outcome === 'aborted')).toBe(true);
  });

  it("maxTotalMs = 0 时预算关闭（显式禁用，不得误伤既有行为）", async () => {
    const deps = clock({ run: async (spec: SwarmTaskSpec) => ({ result: 'ok-' + spec.index }) });
    const results = await runSwarm(specsOf(3), deps, {
      initialLaunchLimit: 3, initialLaunchIntervalMs: 1, timeoutMs: 0, maxTotalMs: 0, maxConcurrency: 16,
    });

    expect(results.every((r) => r.outcome === 'completed')).toBe(true);
  });

  it("预算到点后不留调度器自己的定时器（收尾必须 disarm）", async () => {
    // 成员**永不 settle**（只等 abort），于是留下的定时器只可能来自调度器自身。
    const deps = clock({
      run: async (_spec: SwarmTaskSpec, ctx: { signal: AbortSignal }) =>
        new Promise<never>((_res, rej) => {
          if (ctx.signal.aborted) { rej(ctx.signal.reason); return; }
          ctx.signal.addEventListener('abort', () => rej(ctx.signal.reason), { once: true });
        }),
    });
    const p = runSwarm(specsOf(2), deps, {
      initialLaunchLimit: 2, initialLaunchIntervalMs: 1, timeoutMs: 60_000, maxTotalMs: 200, maxConcurrency: 16,
    });
    await flush(300);
    await p;
    // 预算定时器已自己触发（置 undefined）；成员的闸门已由 releaseAttempt 撤除。
    expect(vi.getTimerCount()).toBe(0);
  });

  it("maxBatchRateLimitRetries 到顶 ⇒ 判 failed，且批次仍然落定", async () => {
    const deps = clock(
      { run: async () => { throw Object.assign(new Error('429'), { httpStatus: 429 }); } },
      () => true,
    );
    const p = runSwarm(specsOf(3), deps, {
      initialLaunchLimit: 3, initialLaunchIntervalMs: 1, retryBaseMs: 1, retryFactor: 1,
      capacityShrinkDebounceMs: 0, capacityRecoveryIntervalMs: 5, maxRateLimitRetries: 9,
      maxBatchRateLimitRetries: 2, timeoutMs: 30_000, maxTotalMs: 0,
    });
    // 退避与容量恢复都靠虚拟时钟推进；不推进就永远轮不到「批次预算到顶」。
    await flush(20_000);
    const results = await p;

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.outcome === 'failed')).toBe(true);
    expect(results[0]?.error).toContain('batch-wide rate limit budget');
  });
});

describe("B1-04 限流重试不得重放已经动过外部世界的 attempt", () => {
  it("成员已调过工具再被限流 ⇒ 直接判 failed，绝不重试（副作用不会跑第二次）", async () => {
    let calls = 0;
    let effects = 0;
    const deps = clock({
      run: async () => {
        calls += 1;
        effects += 1;   // 假装这是一次 write_file / run_shell
        throw Object.assign(new Error('429'), { httpStatus: 429, usedTool: true });
      },
    }, (e: unknown) => String((e as Error)?.message || '').includes('429'));
    const results = await runSwarm(specsOf(1), deps, {
      initialLaunchLimit: 1, initialLaunchIntervalMs: 1, retryBaseMs: 1, maxRateLimitRetries: 3,
      maxBatchRateLimitRetries: 12, timeoutMs: 10_000, maxTotalMs: 0,
    });

    expect(results[0]?.outcome).toBe('failed');
    expect(results[0]?.error).toContain('already run its tools');
    expect(calls).toBe(1);      // 没有第二次 attempt
    expect(effects).toBe(1);    // 副作用只发生了一次
  });

  it("没有副作用的成员仍能退避重试（不得把限流恢复能力一起取消掉）", async () => {
    const perMember = new Map();
    const deps = clock({
      run: async (spec) => {
        const n = (perMember.get(spec.index) || 0) + 1;
        perMember.set(spec.index, n);
        if (spec.index === 2 && n === 1) { throw Object.assign(new Error('429'), { httpStatus: 429, usedTool: false }); }
        return { result: 'ok after ' + n };
      },
    }, (e: unknown) => String((e as Error)?.message || '').includes('429'));
    const p = runSwarm(specsOf(3), deps, {
      initialLaunchLimit: 3, initialLaunchIntervalMs: 1, retryBaseMs: 1, maxRateLimitRetries: 3,
      maxBatchRateLimitRetries: 12, timeoutMs: 10_000, maxTotalMs: 0,
    });
    // 退避要靠虚拟时钟推进才到期（retryBaseMs=1，故几毫秒足够）。
    await flush(5_000);
    const results = await p;

    expect(results.every((r) => r.outcome === 'completed')).toBe(true);
    expect(perMember.get(2)).toBe(2);   // 第 2 号退避后成功
  });
});
