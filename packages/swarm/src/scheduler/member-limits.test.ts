/**
 * W9290 P2 批次回归：B1-06 / B1-07 / B1-08 / B3-03。
 *
 * 前两条守「静默失效」（漏一个字段不报错，只在慢路径上变成看似生效的行为），
 * 后两条守「结论口径」（取消送没送到、超时说的是不是超时）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwarmScheduler, runSwarm, validateSchedulerConfig } from "./index.js";
import { SWARM_MEMBER_BODY_MAX_CHARS, bodyLimitChars, renderSwarmResult } from "../result-xml.js";
import type { SwarmExecutor, SwarmSchedulerDeps } from "../types.js";
import { flush, specsOf } from "./test-harness.js";

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

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

const member = (len: number) => ({
  spec: { kind: 'spawn' as const, index: 1, item: 'i1', prompt: 'p1' },
  outcome: 'completed' as const,
  state: 'started' as const,
  result: 'Z'.repeat(len),
});


// ── B1-06 ──

describe("B1-06 每一个数值字段都必须被校验（穷尽，不靠反射）", () => {
  it('11 个字段 x NaN/Infinity/负数 一律拒绝', () => {
    const keys = [
      'initialLaunchLimit', 'initialLaunchIntervalMs', 'retryBaseMs', 'retryFactor',
      'capacityShrinkDebounceMs', 'capacityRecoveryIntervalMs', 'maxConcurrency',
      'timeoutMs', 'maxRateLimitRetries', 'maxTotalMs', 'maxBatchRateLimitRetries',
    ];
    expect(keys).toHaveLength(11);
    for (const key of keys) {
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
        expect(() => validateSchedulerConfig({ [key]: value } as never), key + '=' + String(value)).toThrow();
      }
    }
  });

  it('表与 interface 同步：新增数值字段若忘记入表，本用例抓不到但表会漏 —— 故再钉一条下界语义', () => {
    // 0 = 禁用 的字段不得被误伤（它们的下界就是 0）。
    for (const cfg of [{ timeoutMs: 0 }, { maxTotalMs: 0 }, { maxBatchRateLimitRetries: 0 }]) {
      expect(() => validateSchedulerConfig(cfg as never), JSON.stringify(cfg)).not.toThrow();
    }
    // 必须 >= 1 的字段不得被放宽。
    for (const cfg of [{ initialLaunchLimit: 0 }, { maxConcurrency: 0 }, { capacityRecoveryIntervalMs: 0 }]) {
      expect(() => validateSchedulerConfig(cfg as never), JSON.stringify(cfg)).toThrow();
    }
  });
});
// ── B1-07 ──

describe("B1-07 成员正文必须有界，且截断必须如实标注", () => {
  it('百万字正文被裁到有界，并带可见的截断标记', () => {
    const xml = renderSwarmResult([member(1_000_000)]);
    expect(xml.length).toBeLessThan(SWARM_MEMBER_BODY_MAX_CHARS * 2);
    expect(xml).toContain('truncated');
  });

  it('边界：恰好等于上限不截断，多一个码元就截断', () => {
    expect(renderSwarmResult([member(SWARM_MEMBER_BODY_MAX_CHARS)])).not.toContain('truncated');
    expect(renderSwarmResult([member(SWARM_MEMBER_BODY_MAX_CHARS + 1)])).toContain('truncated');
  });

  it('可配：override 生效', () => {
    const xml = renderSwarmResult([member(100_000)], { memberBodyMaxChars: 50 });
    expect(xml.length).toBeLessThan(500);
    expect(xml).toContain('truncated');
  });

  it('无效 override 归一到默认值，绝不归一到「不限」', () => {
    for (const v of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(bodyLimitChars(v), String(v)).toBe(SWARM_MEMBER_BODY_MAX_CHARS);
      const xml = renderSwarmResult([member(1_000_000)], { memberBodyMaxChars: v });
      expect(xml.length, String(v)).toBeLessThan(SWARM_MEMBER_BODY_MAX_CHARS * 2);
    }
  });

  it('截断不劈开代理对（emoji 不得变乱码）', () => {
    const emoji = String.fromCodePoint(0x1F600).repeat(500);
    const clipped = renderSwarmResult([{ ...member(0), result: emoji }], { memberBodyMaxChars: 11 });
    expect(clipped).not.toContain(String.fromCharCode(0xFFFD));
  });
});
// ── B1-08 ──

describe("B1-08 取消必须真的送达每一个成员", () => {
  it('批次取消：每个在跑成员都收到 abort，并各自落成 aborted', async () => {
    let sawAbort = 0;
    const deps = clock({
      run: async (_spec: unknown, ctx: { signal: AbortSignal }) =>
        new Promise<never>((_res, rej) => {
          if (ctx.signal.aborted) { sawAbort += 1; rej(new Error('aborted')); return; }
          ctx.signal.addEventListener('abort', () => { sawAbort += 1; rej(new Error('aborted')); }, { once: true });
        }),
    });
    const p = new SwarmScheduler(specsOf(3), deps, { initialLaunchLimit: 3, initialLaunchIntervalMs: 1, timeoutMs: 0, maxTotalMs: 0 }).run();
    deps.controller.abort(new Error('user stop'));
    const results = await p;

    expect(sawAbort).toBe(3);
    expect(results.every((r) => r.outcome === 'aborted')).toBe(true);
  });

  it('在跑成员被取消后仍会被释放（activeCount 归零，不占并发槽）', async () => {
    const deps = clock({
      run: async (_spec: unknown, ctx: { signal: AbortSignal }) =>
        new Promise<never>((_res, rej) => {
          if (ctx.signal.aborted) { rej(new Error('aborted')); return; }
          ctx.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
        }),
    });
    const sched = new SwarmScheduler(specsOf(2), deps, { initialLaunchLimit: 2, initialLaunchIntervalMs: 1, timeoutMs: 0, maxTotalMs: 0 });
    const p = sched.run();
    await flush(1);
    expect(sched.snapshot().activeCount).toBe(2);
    deps.controller.abort(new Error('user stop'));
    await p;
    expect(sched.snapshot().activeCount).toBe(0);
  });
});
// ── B3-03 ──

describe("B3-03 超时必须真的说出「超时」", () => {
  it('成员不配合 abort 时，落定文案仍是 Subagent timed out.（不是它自己的错误）', async () => {
    const deps = clock({
      run: async () => {
        await new Promise((r) => setTimeout(r, 5000));
        throw new Error('some unrelated late failure');
      },
    });
    const p = runSwarm(specsOf(2), deps, { initialLaunchLimit: 2, initialLaunchIntervalMs: 1, timeoutMs: 200, maxTotalMs: 0 });
    await flush(300);
    const results = await p;

    expect(results[0]?.outcome).toBe('failed');
    expect(results[0]?.error).toBe('Subagent timed out.');
  });

  it('成员在被 abort 后抢先 reject 自己的错误 —— 文案仍必须是超时（顺序由结构保证）', async () => {
    const deps = clock({
      run: async (_spec: unknown, ctx: { signal: AbortSignal }) =>
        new Promise<never>((_res, rej) => {
          if (ctx.signal.aborted) { rej(new Error('aborted, but a member-authored message')); return; }
          ctx.signal.addEventListener('abort', () => rej(new Error('aborted, but a member-authored message')), { once: true });
        }),
    });
    const p = runSwarm(specsOf(1), deps, { initialLaunchLimit: 1, initialLaunchIntervalMs: 1, timeoutMs: 200, maxTotalMs: 0 });
    await flush(300);
    const results = await p;

    expect(results[0]?.error).toBe('Subagent timed out.');
  });
});
