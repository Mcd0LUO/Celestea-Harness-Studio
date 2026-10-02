/**
 * 调度器测试的共享夹具（搬运自 dsh-agent-swarm tests/scheduler.test.ts 的前 194 行）。
 *
 * 为什么抽成独立模块：scheduler.test.ts 原本 1208 行（有效 860），超过本仓 450 有效行红线，
 * 按「被测源文件边界」拆成 core.test.ts 与 rate-limit.test.ts。两份测试共用同一套夹具，
 * 抽出来后只有一份——夹具分叉会让「两边断言同一件事却算出不同结果」，那比超行更糟。
 *
 * **抖动与「原样绿」的关系**：本夹具固定 randomFn = 1（即抖动系数的上界 1.0），因此
 * 搬运过来的全部精确毫秒断言（3000 / 6000 / 12000）在引入 jitter 后**一字不改**仍然成立。
 * jitter 自身的区间语义由 rate-limit.test.ts 用不同 randomFn 单独钉住。
 */

import { vi } from "vitest";

import type {
  SwarmAttemptContext,
  SwarmAttemptResult,
  SwarmSchedulerConfig,
  SwarmSchedulerDeps,
  SwarmTaskSpec,
} from "../types.js";

// ───────────────────────── 夹具 ─────────────────────────

/**
 * 单任务节奏配置：initialLaunchLimit=1 / maxConcurrency=1。
 *
 * 用它来断言"退避序列"本身。若沿用默认首波 5，限流后容量会落在 4，
 * 于是"何时重试"由**容量**而非**退避延迟**决定，退避序列就被掩盖了。
 */
export const SLOW: Partial<SwarmSchedulerConfig> = { initialLaunchLimit: 1, maxConcurrency: 1 };

export function specsOf(n: number): SwarmTaskSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: "spawn" as const,
    index: i + 1,
    item: `item-${String(i + 1)}`,
    prompt: `prompt-${String(i + 1)}`,
  }));
}

export const rateLimitError = (): Error => Object.assign(new Error("429"), { name: "RateLimitError" });

interface RunControl {
  spec: SwarmTaskSpec;
  attempt: number;
  ready: boolean;
  ctx: SwarmAttemptContext;
  resolve(result: SwarmAttemptResult): void;
  reject(error: unknown): void;
}

interface HarnessOptions extends Partial<SwarmSchedulerDeps> {
  /**
   * 是否自动 markReady（默认 true）。设为 false 后由测试显式 `markReady(index)`，
   * 用于构造「成员尚未 ready」的场景（中断放弃路径、ready 与限流节奏的正交性等）。
   */
  autoReady?: boolean;
}

/** 手动驾驶的执行器：时钟/定时器/执行函数全部注入，测试完全掌控节奏。 */
export function harness(over: HarnessOptions = {}) {
  const { autoReady = true, ...depsOver } = over;
  const runs: RunControl[] = [];
  // 同时在跑（已启动未结算）的最大数：用来盯并发闸门。
  // 为什么在这里计而不是读 snapshot().activeCount：闸门可能在两次读之间就变了，
  // 而「曾经达到过多少」是闸门是否生效的唯一可观测证据。
  let liveNow = 0;
  let maxLive = 0;

  const deps: SwarmSchedulerDeps = {
    // 必须与 setTimeout 共用同一时钟：vi.useFakeTimers() 会同步推进 Date.now()。
    // 注入冻结的 now() 会让调度器永远认为"还没到点"，退避与容量恢复全部失效。
    now: () => Date.now(),
    randomFn: () => 1,
    setTimeout: (handler, ms) => setTimeout(handler, ms) as unknown,
    clearTimeout: (handle) => {
      clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
    },
    isRateLimitError: (error: unknown) => error instanceof Error && error.name === "RateLimitError",
    executor: {
      run: (spec, ctx) => {
        let resolve!: (r: SwarmAttemptResult) => void;
        let reject!: (e: unknown) => void;
        const promise = new Promise<SwarmAttemptResult>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        const control: RunControl = {
          spec,
          attempt: ctx.attempt,
          ready: false,
          ctx,
          resolve,
          reject,
        };
        runs.push(control);
        liveNow += 1;
        if (liveNow > maxLive) maxLive = liveNow;
        // 结算即出队：任一分支落定（resolve / reject / 被 abort）都要减，
        // 否则闸门测试会数出一个虚高的"同时在跑"。
        const settle = (): void => {
          liveNow -= 1;
        };
        promise.then(settle, settle);
        ctx.setAgentId(`agent-${String(spec.index)}`);
        // 真实执行函数在 attempt 被中断（用户取消/超时）时会以该原因 reject。
        ctx.signal.addEventListener("abort", () => {
          reject(ctx.signal.reason ?? new Error("aborted"));
        });
        if (autoReady) {
          queueMicrotask(() => {
            if (ctx.signal.aborted) return;
            control.ready = true;
            ctx.markReady();
          });
        }
        return promise;
      },
    },
    ...depsOver,
  };

  const latest = (index: number): RunControl | undefined =>
    [...runs].reverse().find((r) => r.spec.index === index);

  return {
    deps,
    runs,
    /** 已启动的 spec.index 序列（按启动顺序，含重试）。 */
    started: () => runs.map((r) => r.spec.index),
    attemptsOf: (index: number) => runs.filter((r) => r.spec.index === index).length,
    /** 过程中的最大同时在跑数（并发闸门的可观测证据）。 */
    maxLive: () => maxLive,
    markReady: (index: number) => {
      const last = latest(index);
      if (last === undefined) throw new Error(`markReady: no run for index ${String(index)}`);
      last.ready = true;
      last.ctx.markReady();
    },
    complete: (index: number, result: SwarmAttemptResult = { result: `done-${String(index)}` }) => {
      latest(index)?.resolve(result);
    },
    rateLimit: (index: number, error: unknown = rateLimitError()) => {
      latest(index)?.reject(error);
    },
    fail: (index: number, error: unknown = new Error("boom")) => {
      latest(index)?.reject(error);
    },
  };
}

export const flush = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

/**
 * 不反复结算的驱动：把时钟按 `stepMs` 逐段推进，**不**自动结算任何在跑任务。
 *
 * 与 drain() 的分工（两者都保留）：drain 每轮无条件 resolve 所有在跑任务，settle 与
 * 放量的相对顺序被拉平，"先放量还是先 settle"这类竞态在它手里不可能暴露；本函数把每段
 * 的控制权交还测试，由测试在精确时刻结算精确成员。
 *
 * 顺带一提，"不结算"这一点本身就是断言对象：满并发时若唤醒定时器被丢掉，只要没有
 * settle，批次就再也不前进（见「容量收缩与恢复」里的保活回归用例）。
 */
export async function advanceClock(totalMs: number, stepMs = 250): Promise<void> {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    await flush(Math.min(stepMs, totalMs - elapsed));
  }
}

/**
 * 稳健收尾：反复结算所有已启动的尝试并推进时钟，直到批次 Promise 落定。
 * 对已结算的 Promise 再 resolve 是 no-op，所以重复调用安全；
 * 对已被 reject 的尝试再 resolve 同样是 no-op。
 */
export async function drain(h: ReturnType<typeof harness>, p: Promise<unknown>, maxRounds = 80): Promise<void> {
  let settled = false;
  void p.then(() => {
    settled = true;
  });
  for (let i = 0; i < maxRounds && !settled; i += 1) {
    for (const run of [...h.runs]) run.resolve({ result: `ok-${String(run.spec.index)}` });
    await flush(20_000);
  }
  await p;
}

/**
 * 推进时钟直到 `index` 的尝试次数增加。
 *
 * 为什么需要它：限流模式下新任务（retryReadyAt=0）与已退避任务竞争同一个容量槽位，
 * 每次放量还会把全局节流阀往前推一个 globalRetryIntervalMs。所以"第 n 次重试究竟
 * 落在第几毫秒"是**容量 + 全局节流 + 退避就绪时间**三者共同决定的复合结果，
 * 不适合作为退避公式的断言对象。这里改为：每步先让其它成员完成以腾出容量，
 * 再推进时钟，直到目标成员真的被重试——于是断言对象回到纯粹的重试延迟序列。
 */
export async function driveRetry(h: ReturnType<typeof harness>, index: number, maxMs = 120_000): Promise<void> {
  const before = h.attemptsOf(index);
  let elapsed = 0;
  while (h.attemptsOf(index) === before && elapsed < maxMs) {
    for (const run of [...h.runs]) if (run.spec.index !== index) run.resolve({ result: "ok" });
    await flush(500);
    elapsed += 500;
  }
  if (h.attemptsOf(index) === before) {
    throw new Error(`driveRetry: #${String(index)} was not retried within ${String(maxMs)}ms`);
  }
}


// ───────────────────────── 正常节奏 ─────────────────────────


