import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SwarmScheduler, runSwarm, validateSchedulerConfig } from "./index.js";
import type { SwarmAttemptResult } from "../types.js";
import {
  SLOW,
  drain,
  driveRetry,
  flush,
  harness,
  rateLimitError,
  specsOf,
} from "./test-harness.js";

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("正常模式节奏", () => {
  it("首波立即起 5 个，之后每 700ms 放 1 个", async () => {
    const h = harness();
    const p = runSwarm(specsOf(8), h.deps);

    expect(h.started()).toEqual([1, 2, 3, 4, 5]);

    await flush(699);
    expect(h.started()).toHaveLength(5);

    await flush(1); // t=700
    expect(h.started()).toEqual([1, 2, 3, 4, 5, 6]);

    await flush(700); // t=1400
    expect(h.started()).toEqual([1, 2, 3, 4, 5, 6, 7]);

    await flush(700); // t=2100
    expect(h.started()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    for (const i of [1, 2, 3, 4, 5, 6, 7, 8]) h.complete(i);
    const results = await p;
    expect(results.map((r) => r.outcome)).toEqual(Array(8).fill("completed"));
    expect(results.map((r) => r.spec.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("任务少于首波时全部立即启动，不等 700ms", async () => {
    const h = harness();
    const p = runSwarm(specsOf(3), h.deps);
    expect(h.started()).toEqual([1, 2, 3]);
    for (const i of [1, 2, 3]) h.complete(i);
    expect((await p).every((r) => r.outcome === "completed")).toBe(true);
  });

  it("空 spec 集合立即完成", async () => {
    const h = harness();
    expect(await runSwarm([], h.deps)).toEqual([]);
  });

  it("maxConcurrency 压住首波，完成后放行下一个", async () => {
    const h = harness();
    const p = runSwarm(specsOf(6), h.deps, { maxConcurrency: 2 });
    expect(h.started()).toEqual([1, 2]);

    h.complete(1);
    await flush(0);
    expect(h.started()).toEqual([1, 2, 3]);

    await drain(h, p);
  });
});
describe("死锁防护", () => {
  /**
   * 判死门槛：只剩它一个未完成 **且** retryCount >= 1（已退避重试过一次仍限流）。
   * 相对上游是有意放宽（见 src/scheduler.ts #handleAttemptOutcome 的偏离说明）。
   */
  it("只剩一个未完成任务且它持续限流（已重试过）→ 判 failed 并回调 onAbandoned", async () => {
    const abandoned: { index: number; outcome: string }[] = [];
    const h = harness({ onAbandoned: (e) => abandoned.push({ index: e.spec.index, outcome: e.outcome }) });
    const p = runSwarm(specsOf(3), h.deps);
    await flush(0);

    h.complete(2);
    h.complete(3);
    await flush(0);

    // 第一次限流：不再直接判死，退避重排队（这是与上游的差异点）。
    h.rateLimit(1);
    await flush(3000);
    expect(abandoned).toHaveLength(0);

    // 重试后仍然限流 → 此刻 retryCount >= 1，判死。
    h.rateLimit(1);
    const results = await p;

    expect(results[0]?.outcome).toBe("failed");
    expect(results[0]?.error).toMatch(/rate limit/i);
    expect(results[0]?.state).toBe("started");
    expect(results[1]?.outcome).toBe("completed");
    expect(results[2]?.outcome).toBe("completed");
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.index).toBe(1);
    expect(abandoned[0]?.outcome).toBe("failed");
  });

  it("回归：只剩一个未完成任务时的首次限流不判死，退避后重试仍可成功", async () => {
    const abandoned: unknown[] = [];
    const h = harness({ onAbandoned: (e) => abandoned.push(e) });
    const p = runSwarm(specsOf(3), h.deps);
    await flush(0);

    h.complete(2);
    h.complete(3);
    await flush(0);

    // 首次限流：只重排队，不放弃（F3 修复前这里会立刻判 failed）。
    h.rateLimit(1);
    await flush(3000);
    expect(abandoned).toHaveLength(0);
    expect(h.attemptsOf(1)).toBe(2);

    // 标题声称的"退避后重试仍可成功"必须**真的**被验证到重试那一次上，而不是靠
    // "批次最后 completed 了"倒推：这里显式钉住重试尝试的编号与它拿到的 previousAgentId
    // （契约要求执行函数优先复用上次 agentId 做"重试原 agent"）。
    const retry = h.runs.filter((r) => r.spec.index === 1)[1];
    expect(retry?.attempt).toBe(2);
    expect(retry?.ctx.previousAgentId).toBe("agent-1");

    // 第二次尝试成功 → 该成员正常完成，没有任何成员被放弃。
    // 用带标记的结果文本证明 completed 来自**重试的那一次**（旧尝试早已 reject，再 resolve 是空操作）。
    h.complete(1, { result: "retry-succeeded" });
    const results = await p;
    expect(results[0]?.outcome).toBe("completed");
    expect(results[0]?.result).toBe("retry-succeeded");
    expect(results[0]?.agentId).toBe("agent-1");
    expect(abandoned).toHaveLength(0);
  });

  it("还有别的未完成任务时限流只重排队，不判 failed", async () => {
    const abandoned: unknown[] = [];
    const h = harness({ onAbandoned: (e) => abandoned.push(e) });
    const p = runSwarm(specsOf(3), h.deps);
    await flush(0);

    h.complete(3);
    await flush(0);
    h.rateLimit(1);
    await flush(3000);
    expect(abandoned).toHaveLength(0);
    expect(h.attemptsOf(1)).toBe(2);

    await drain(h, p);
  });

  /**
   * 回归（2026-10-01 审查缺陷 1）：≥2 个成员**同时**持续限流时批次曾永久卡死。
   *
   * 锁定的不变量：判死条件是**双重（or）**，其中"per-task 重试上限"与"是否唯一未完成"无关。
   * 原实现只有单成员尾部判死，于是每个成员都觉得"还有别人没完成"→ 恒不判死 →
   * 退避分支又没有次数上限 → 无限重排队、批次 Promise 永不 resolve。
   * 修复前实测：2 成员 / 3 成员各推进 1 小时虚拟时间，settled 恒 false、onAbandoned 0 次。
   *
   * 断言三件事，缺一不可：
   *   ① 批次**最终落定**（推进 1 小时虚拟时间后 settled 变 true）——这正是修复前失败的那一条；
   *   ② 触顶成员 outcome=failed 且文案指出"重试次数到顶"（可与批次尾部判死区分）；
   *   ③ onAbandoned 真的被调用（判死不是只改结果、忘了通知宿主）。
   * 用假 executor + advanceTimersByTimeAsync 推进虚拟时间，不真等。
   */
  it("回归：2 个成员同时持续限流 → 到重试上限即判死，批次不再永久卡死", async () => {
    const abandoned: { index: number; outcome: string; error: string }[] = [];
    const h = harness({ onAbandoned: (e) => abandoned.push({ index: e.spec.index, outcome: e.outcome, error: e.error }) });
    // maxConcurrency=2 让两个成员同时在跑——正是"谁都不是唯一未完成"的场景。
    const p = runSwarm(specsOf(2), h.deps, { initialLaunchLimit: 2, maxConcurrency: 2, maxRateLimitRetries: 2 });
    await flush(0);
    expect(h.started()).toEqual([1, 2]);

    let settled = false;
    void p.then(() => { settled = true; });

    // 推进 1 小时虚拟时间：期间每次重试都限流，成员各自累计 retryCount。
    // 修复前这里跑完仍是 settled=false（无限重排队）。
    for (let i = 0; i < 240 && !settled; i += 1) {
      for (const run of [...h.runs]) run.reject(rateLimitError());
      await flush(15_000);
    }

    const results = await p;
    expect(settled).toBe(true);
    expect(results.map((r) => r.outcome)).toEqual(["failed", "failed"]);
    for (const r of results) {
      // 两条判死路径的文案都以 "rate limited" 收口，故这里断言共同前缀。
      expect(r.error).toMatch(/rate limit/i);
    }
    // 且**至少有一个**走的是新增的"per-task 重试上限"那条（文案里带 retried 次数）。
    // 为什么不是两个都走那条：先触顶的那个由上限判死，剩下那个随之变成"唯一未完成"，
    // 下一次限流由原有的批次尾部条件判死——两条路径都真实生效，顺序不同而已。
    expect(results.some((r) => /retries/i.test(r.error ?? ""))).toBe(true);
    expect(abandoned).toHaveLength(2);
    expect(abandoned.map((e) => e.index).sort()).toEqual([1, 2]);
    expect(abandoned.every((e) => e.outcome === "failed")).toBe(true);
  });

  /**
   * 回归（同上缺陷的反面对照）：上限是 **per-task** 的，不连坐。
   *
   * 钉住的是"一个成员限流到顶 ≠ 整批陪葬"：成员 1 持续限流，成员 2 正常完成。
   * 若实现写成"批次级上限"（比如用一个共享计数器判死全部未完成成员），
   * 这个用例会失败——因为成员 2 会被无理由放弃。
   */
  it("回归：per-task 上限不连坐——一个成员限流到顶，同批健康成员照常完成", async () => {
    const abandoned: number[] = [];
    const h = harness({ onAbandoned: (e) => abandoned.push(e.spec.index) });
    const p = runSwarm(specsOf(2), h.deps, { initialLaunchLimit: 2, maxConcurrency: 2, maxRateLimitRetries: 1 });
    await flush(0);

    h.complete(2, { result: "healthy-done" });
    await flush(0);

    // 成员 1 一直限流：首次限流不判死（retryCount 0 < 上限 1），重试后仍限流即判死。
    let settled = false;
    void p.then(() => { settled = true; });
    for (let i = 0; i < 60 && !settled; i += 1) {
      h.rateLimit(1);
      await flush(3_000);
    }

    const results = await p;
    expect(settled).toBe(true);
    expect(results[0]?.outcome).toBe("failed");
    expect(results[1]?.outcome).toBe("completed");
    expect(results[1]?.result).toBe("healthy-done");
    expect(abandoned).toEqual([1]);
  });

  /**
   * 向后兼容守卫：maxRateLimitRetries **未设**（undefined）时行为与该字段引入前一致——
   * 即只有批次尾部那条判死条件生效，成员之间同时限流仍会一直重排队。
   *
   * 这条看似在断言一个"坏行为"，实则是把"未接线 ≠ 默认有上限"钉死：
   * 若有人日后给 DEFAULT_SWARM_SCHEDULER_CONFIG 填了默认值，
   * "宿主未接线"就会被静默变成"有上限"，现网行为被无声改变而不自知。
   */
  it("向后兼容：maxRateLimitRetries 未设时，多成员同时限流仍不因上限判死", async () => {
    const h = harness();
    const p = runSwarm(specsOf(2), h.deps, { initialLaunchLimit: 2, maxConcurrency: 2 });
    await flush(0);

    for (let i = 0; i < 8; i += 1) {
      for (const run of [...h.runs]) run.reject(rateLimitError());
      await flush(6_000);
    }
    // 未设上限：两个成员都还在重排队，谁都没被判死。
    expect(h.attemptsOf(1)).toBeGreaterThan(1);
    expect(h.attemptsOf(2)).toBeGreaterThan(1);

    // 收尾：让两者都成功，批次正常落定（该用例只关心判死条件，不关心卡死）。
    for (const run of [...h.runs]) run.resolve({ result: "late-ok" });
    await drain(h, p);
  });

  it("maxRateLimitRetries 给定则必须是 >= 1 的整数，否则构造期抛错", () => {
    const h = harness();
    // 0 意味着"第一次限流就判死"（与"先退避一次再放弃"的设计相反）；
    // NaN / 小数会让 `retryCount >= limit` 比较恒假或语义不明——都是静默失效，故构造期挡掉。
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => new SwarmScheduler(specsOf(2), h.deps, { maxRateLimitRetries: bad })).toThrow(/maxRateLimitRetries/);
    }
    expect(() => new SwarmScheduler(specsOf(2), h.deps, {})).not.toThrow();
    expect(() => new SwarmScheduler(specsOf(2), h.deps, { maxRateLimitRetries: 1 })).not.toThrow();
  });
  it("死锁防护只对限流生效；普通失败本来就判 failed", async () => {
    const h = harness();
    const p = runSwarm(specsOf(2), h.deps);
    await flush(0);
    h.fail(1, new Error("hard failure"));
    h.complete(2);
    const results = await p;
    expect(results[0]?.outcome).toBe("failed");
    expect(results[0]?.error).toBe("hard failure");
  });
});

// ───────────────────────── 中断 ─────────────────────────

describe("中断", () => {
  it("abort → 已完成保留、在跑标 aborted、未启动不再启动", async () => {
    const controller = new AbortController();
    const h = harness({ signal: controller.signal });
    const p = runSwarm(specsOf(10), h.deps);
    await flush(0);

    h.complete(1);
    await flush(0);
    const runsBefore = h.runs.length;

    controller.abort();
    const results = await p;

    expect(results).toHaveLength(10);
    expect(results[0]?.outcome).toBe("completed");
    expect(results[1]?.outcome).toBe("aborted");
    expect(results[1]?.state).toBe("started");
    expect(results[1]?.error).toMatch(/interrupted/i);
    expect(results[5]?.outcome).toBe("aborted");
    expect(results[5]?.state).toBe("not_started");
    expect(h.runs.length).toBe(runsBefore);
  });

  it("传入已 aborted 的 signal → 全部 aborted 且不启动任何任务", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({ signal: controller.signal });
    const results = await runSwarm(specsOf(3), h.deps);
    expect(h.runs).toHaveLength(0);
    expect(results.map((r) => r.outcome)).toEqual(["aborted", "aborted", "aborted"]);
    expect(results.every((r) => r.state === "not_started")).toBe(true);
  });

  it("abort 触发 onAbandoned(cancelled)，只针对建了但没跑起来的成员", async () => {
    const controller = new AbortController();
    const abandoned: string[] = [];
    const h = harness({
      signal: controller.signal,
      autoReady: false,
      onAbandoned: (e) => abandoned.push(e.outcome),
    });
    const p = runSwarm(specsOf(2), h.deps, { maxConcurrency: 2 });
    await flush(0);
    expect(h.runs.every((r) => r.ready)).toBe(false);

    controller.abort();
    await p;
    expect(abandoned).toEqual(["cancelled", "cancelled"]);
  });

  it("已 ready 的成员不计入挂起清理（由 abort 路径处理终态）", async () => {
    const controller = new AbortController();
    const abandoned: string[] = [];
    const h = harness({ signal: controller.signal, onAbandoned: (e) => abandoned.push(e.outcome) });
    const p = runSwarm(specsOf(3), h.deps);
    await flush(0);
    expect(h.runs.every((r) => r.ready)).toBe(true);

    controller.abort();
    await p;
    expect(abandoned).toEqual([]);
  });

  it("中断时在跑任务的 attempt signal 被 abort", async () => {
    const controller = new AbortController();
    let aborted = 0;
    const h = harness({
      signal: controller.signal,
      executor: {
        run: (_spec, ctx) =>
          new Promise<SwarmAttemptResult>((_res, rej) => {
            ctx.signal.addEventListener("abort", () => {
              aborted += 1;
              rej(ctx.signal.reason ?? new Error("aborted"));
            });
          }),
      },
    });
    const p = runSwarm(specsOf(2), h.deps);
    await flush(0);
    controller.abort();
    await p;
    expect(aborted).toBe(2);
  });

  it("回归：批次中断时，从未启动的排队成员也必须收到 onAbandoned(cancelled)", async () => {
    const controller = new AbortController();
    const abandoned: { index: number; agentId?: string }[] = [];
    const h = harness({
      signal: controller.signal,
      onAbandoned: (e) =>
        abandoned.push({ index: e.spec.index, ...(e.agentId === undefined ? {} : { agentId: e.agentId }) }),
    });
    const p = runSwarm(specsOf(8), h.deps, { initialLaunchLimit: 1 });
    await flush(0);
    expect(h.started()).toEqual([1]); // 首波只放 1 个，其余 7 个仍在队列里

    controller.abort();
    await p;

    // 跑起来的 #1 由 abort 路径处理终态；从未启动的 #2..#8 必须走同一条放弃路径，
    // 否则宿主（registry）永远不知道它们已经不可能再启动。
    expect(abandoned.map((e) => e.index)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    // 从未启动的成员没有 agentId —— 事件里不得伪造
    expect(abandoned.every((e) => e.agentId === undefined)).toBe(true);
    // 中断路径必须把那支"首波之后每 700ms 放一个"的定时器清干净（leftovers=0 回归护栏）
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ───────────────────────── 超时 ─────────────────────────

describe("超时", () => {
  it("超过 timeoutMs 判 failed，文案为超时", async () => {
    const h = harness();
    const p = runSwarm(specsOf(2), h.deps, { timeoutMs: 5000 });
    await flush(0);
    h.complete(2);
    await flush(5000);
    const results = await p;
    expect(results[0]?.outcome).toBe("failed");
    expect(results[0]?.error).toBe("Subagent timed out.");
    expect(results[1]?.outcome).toBe("completed");
  });

  it("timeoutMs 为 0 或未设时不超时", async () => {
    const h = harness();
    // maxTotalMs: 0 —— 本用例断言的是「单任务不超时」，而它把时钟推进了 10^7 ms；
    // 整批预算（B1-03）默认 30 分钟会在那之前取消整批，两者断言的是不同的闸门。
    const p = runSwarm(specsOf(2), h.deps, { timeoutMs: 0, maxTotalMs: 0 });
    await flush(0);
    await flush(10_000_000);
    h.complete(1);
    h.complete(2);
    const results = await p;
    expect(results.every((r) => r.outcome === "completed")).toBe(true);
  });
});

// ───────────────────────── 结果落位 ─────────────────────────

describe("结果落位", () => {
  it("结果按 index 落位，乱序完成也不乱序", async () => {
    const h = harness();
    const p = runSwarm(specsOf(3), h.deps);
    await flush(0);
    h.complete(3, { result: "c" });
    h.complete(1, { result: "a" });
    h.complete(2, { result: "b" });
    const results = await p;
    expect(results.map((r) => r.result)).toEqual(["a", "b", "c"]);
    expect(results.map((r) => r.spec.index)).toEqual([1, 2, 3]);
  });

  it("非限流失败判 failed 并带错误文案，state=started", async () => {
    const h = harness();
    const p = runSwarm(specsOf(2), h.deps);
    await flush(0);
    h.fail(1, new Error("provider exploded"));
    h.complete(2);
    const results = await p;
    expect(results[0]?.outcome).toBe("failed");
    expect(results[0]?.error).toBe("provider exploded");
    expect(results[0]?.state).toBe("started");
  });

  it("stopReason 透传", async () => {
    const h = harness();
    const p = runSwarm(specsOf(2), h.deps);
    await flush(0);
    h.complete(1, { result: "partial", stopReason: "max_tokens" });
    h.complete(2);
    const results = await p;
    expect(results[0]?.stopReason).toBe("max_tokens");
  });

  it("执行器同步抛出（非 reject）也判 failed", async () => {
    const h = harness({
      executor: {
        run: () => {
          throw new Error("sync boom");
        },
      },
    });
    const results = await runSwarm(specsOf(2), h.deps);
    expect(results.every((r) => r.outcome === "failed")).toBe(true);
    expect(results[0]?.error).toBe("sync boom");
  });
});

// ───────────────────────── 配置 ─────────────────────────

describe("配置校验与自定义", () => {
  it("非法 config 直接抛错", () => {
    const h = harness();
    expect(() => new SwarmScheduler(specsOf(2), h.deps, { initialLaunchLimit: 0 })).toThrow(/initialLaunchLimit/);
    expect(() => new SwarmScheduler(specsOf(2), h.deps, { retryFactor: 0.5 })).toThrow(/retryFactor/);
    expect(() => new SwarmScheduler(specsOf(2), h.deps, { retryBaseMs: -1 })).toThrow(/retryBaseMs/);
    // NaN 与任何数比较都为 false：旧写法 `x < 1` 会让 NaN 静默通过，现统一按"必须满足下界"判定。
    expect(() => new SwarmScheduler(specsOf(2), h.deps, { initialLaunchLimit: Number.NaN })).toThrow(
      /initialLaunchLimit/,
    );
    expect(() => new SwarmScheduler(specsOf(2), h.deps, { retryFactor: Number.NaN })).toThrow(/retryFactor/);
    expect(() => new SwarmScheduler(specsOf(2), h.deps, { retryBaseMs: Number.NaN })).toThrow(/retryBaseMs/);
  });

  it("validateSchedulerConfig 与构造期校验同一口径，可供宿主在加载期提前 fail-fast", () => {
    expect(() => validateSchedulerConfig({ initialLaunchLimit: 0 })).toThrow(/initialLaunchLimit/);
    expect(() => validateSchedulerConfig({ maxRateLimitRetries: 0 })).toThrow(/maxRateLimitRetries/);
    expect(() => validateSchedulerConfig({})).not.toThrow();
    expect(() => validateSchedulerConfig(undefined)).not.toThrow();
    expect(() => validateSchedulerConfig({ retryFactor: 1.5, maxConcurrency: 3 })).not.toThrow();
  });

  it("maxConcurrency 给定则必须是 >= 1 的整数，否则构造期抛错", () => {
    const h = harness();
    // 0 尤其危险：active(0) >= 0 恒真 → 静默不返回（与"只有非法 config 才会抛"的契约矛盾）。
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => new SwarmScheduler(specsOf(2), h.deps, { maxConcurrency: bad })).toThrow(/maxConcurrency/);
    }
    // 不传（无上限）与合法的 1 都必须照常构造。
    expect(() => new SwarmScheduler(specsOf(2), h.deps, {})).not.toThrow();
    expect(() => new SwarmScheduler(specsOf(2), h.deps, { maxConcurrency: 1 })).not.toThrow();
  });

  it("run() 重复调用返回同一个 Promise：不覆盖 #resolve，也不重复调度", async () => {
    const h = harness();
    const scheduler = new SwarmScheduler(specsOf(2), h.deps);
    const first = scheduler.run();
    const second = scheduler.run();
    expect(second).toBe(first); // 修复前是另一个 Promise：首个批次会永挂
    expect(h.started()).toEqual([1, 2]); // 也没有被调度两遍

    for (const i of [1, 2]) h.complete(i);
    const results = await first;
    expect(results.map((r) => r.outcome)).toEqual(["completed", "completed"]);
    expect(await second).toEqual(results);
  });

  it("自定义节奏参数生效", async () => {
    const h = harness();
    const p = runSwarm(specsOf(4), h.deps, { initialLaunchLimit: 1, initialLaunchIntervalMs: 100 });
    expect(h.started()).toEqual([1]);
    await flush(100);
    expect(h.started()).toEqual([1, 2]);
    await flush(100);
    expect(h.started()).toEqual([1, 2, 3]);
    await flush(100);
    expect(h.started()).toEqual([1, 2, 3, 4]);
    for (const i of [1, 2, 3, 4]) h.complete(i);
    expect((await p).length).toBe(4);
  });

  it("自定义 retryBaseMs / retryFactor 影响退避序列", async () => {
    const suspended: { retryCount: number; retryDelayMs: number; retryReadyAt: number }[] = [];
    const h = harness({ onSuspended: (e) => suspended.push(e) });
    const p = runSwarm(specsOf(3), h.deps, { ...SLOW, retryBaseMs: 100, retryFactor: 3 });
    await flush(0);

    h.rateLimit(1);
    await flush(0);
    expect(suspended[0]?.retryDelayMs).toBe(100); // 100 × 3^0
    expect(suspended[0]?.retryReadyAt).toBe(Date.now() + 100);

    await flush(99);
    expect(h.attemptsOf(1)).toBe(1);
    await flush(1);
    expect(h.attemptsOf(1)).toBe(2);

    h.rateLimit(1);
    await flush(0);
    expect(suspended[1]?.retryDelayMs).toBe(300); // 100 × 3^1
    expect(suspended[1]?.retryReadyAt).toBe(Date.now() + 300);

    await driveRetry(h, 1);
    expect(h.attemptsOf(1)).toBe(3);

    await drain(h, p);
  });
});

// ───────────────────────── 规模 ─────────────────────────

describe("规模", () => {
  it("128 个成员全部完成，结果长度与编号一致", async () => {
    const h = harness();
    // 【前提改动，不是断言改动】源仓这里不传 maxConcurrency，因为它缺省 undefined = 无上限；
    // 本仓 maxConcurrency 缺省 16（没有宿主派发池兜底，这道闸门是并发失控的唯一防线），
    // 于是 128 个成员在纯节奏下只会被放到 16 个就停住。
    // 本用例要验的是**128 成员规模**（结果落位与编号连续），不是并发闸门——闸门另有专测
    // （见「正常模式节奏 > maxConcurrency 压住首波」）。故显式把上限提到 128，
    // 断言本身一字未改。
    const p = runSwarm(specsOf(128), h.deps, { maxConcurrency: 128 });
    await flush(0);
    expect(h.started()).toHaveLength(5);

    // 放量完 128 个需要 (128 - 5) × 700ms
    await flush(123 * 700 + 10);
    expect(h.runs).toHaveLength(128);

    for (const r of h.runs) r.resolve({ result: `ok-${String(r.spec.index)}` });
    const results = await p;
    expect(results).toHaveLength(128);
    expect(results.map((r) => r.spec.index)).toEqual(Array.from({ length: 128 }, (_, i) => i + 1));
  });
});