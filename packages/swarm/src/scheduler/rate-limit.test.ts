import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SwarmScheduler, runSwarm } from "./index.js";
import {
  SLOW,
  advanceClock,
  drain,
  driveRetry,
  flush,
  harness,
  specsOf,
} from "./test-harness.js";

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("限流退避序列", () => {
  it("重排队延迟 = 3000ms × 2^(n-1)，无抖动", async () => {
    const suspended: { retryCount: number; retryDelayMs: number; retryReadyAt: number }[] = [];
    const h = harness({ onSuspended: (e) => suspended.push(e) });
    const p = runSwarm(specsOf(6), h.deps, SLOW);
    expect(h.started()).toEqual([1]);
    await flush(0);

    // 第 1 次限流 → 3000ms。此刻容量空闲，故可精确断言"到点才重试"。
    h.rateLimit(1);
    await flush(0);
    expect(suspended[0]?.retryCount).toBe(1);
    expect(suspended[0]?.retryDelayMs).toBe(3000);
    expect(suspended[0]?.retryReadyAt).toBe(Date.now() + 3000);

    await flush(2999);
    expect(h.attemptsOf(1)).toBe(1); // 绝不早于 retryReadyAt
    await flush(1);
    expect(h.attemptsOf(1)).toBe(2);
    expect(h.runs.filter((r) => r.spec.index === 1)[1]?.attempt).toBe(2);

    // 第 2 次 → 6000ms
    h.rateLimit(1);
    await flush(0);
    expect(suspended[1]?.retryCount).toBe(2);
    expect(suspended[1]?.retryDelayMs).toBe(6000);
    expect(suspended[1]?.retryReadyAt).toBe(Date.now() + 6000);

    await driveRetry(h, 1);
    expect(h.attemptsOf(1)).toBe(3);

    // 第 3 次 → 12000ms
    h.rateLimit(1);
    await flush(0);
    expect(suspended[2]?.retryCount).toBe(3);
    expect(suspended[2]?.retryDelayMs).toBe(12_000);
    expect(suspended[2]?.retryReadyAt).toBe(Date.now() + 12_000);

    await driveRetry(h, 1);
    expect(h.attemptsOf(1)).toBe(4);

    await drain(h, p);
  });

  it("退避未到期前不放量；容量未腾出时也不放量", async () => {
    const h = harness();
    const p = runSwarm(specsOf(6), h.deps, { initialLaunchLimit: 2, maxConcurrency: 2 });
    await flush(0);
    expect(h.started()).toEqual([1, 2]);

    h.rateLimit(1);
    await flush(0);
    // 容量 = 已成功启动数(2) - 1 = 1，在跑的 2 号占满 → 即使退避已到期也不放量
    await flush(3000);
    expect(h.attemptsOf(1)).toBe(1);
    expect(h.started()).toEqual([1, 2]);

    // 2 号完成腾出容量 → 1 号立刻按退避就绪时间重试
    h.complete(2);
    await flush(0);
    expect(h.attemptsOf(1)).toBe(2);

    await drain(h, p);
  });

  it("重排队任务优先于尚未启动的新任务", async () => {
    const h = harness();
    const p = runSwarm(specsOf(6), h.deps, { initialLaunchLimit: 2, maxConcurrency: 2 });
    await flush(0);
    expect(h.started()).toEqual([1, 2]);

    h.rateLimit(1);
    await flush(0);
    h.complete(2);
    await flush(3000);

    // 1 号（重排队）先于 3 号（从未启动）被放量
    expect(h.started()).toEqual([1, 2, 1]);
    expect(h.attemptsOf(3)).toBe(0);

    await drain(h, p);
  });

  it("限流回调 onSuspended 带上 spec 与原因", async () => {
    const suspended: { index: number; reason: string }[] = [];
    const h = harness({ onSuspended: (e) => suspended.push({ index: e.spec.index, reason: e.reason }) });
    const p = runSwarm(specsOf(3), h.deps, SLOW);
    await flush(0);
    h.rateLimit(1);
    await flush(0);
    expect(suspended).toHaveLength(1);
    expect(suspended[0]?.index).toBe(1);
    expect(suspended[0]?.reason).toMatch(/rate limit/i);
    await drain(h, p);
  });
});

// ───────────────────────── 放量与 settle 交织（精确驱动） ─────────────────────────

describe("放量与 settle 交织", () => {
  it("放量由定时器按节流到点触发，settle 只负责腾容量，两者顺序不可互换", async () => {
    // 目的：用不反复结算的驱动（advanceClock）把 settle 钉在精确时刻，
    // 证明"放量"与"settle"是两条独立触发路径——drain 那种每轮全结算的写法
    // 会把两者揉在一起，看不出任何一条路径是否真的生效。
    const h = harness();
    const scheduler = new SwarmScheduler(specsOf(4), h.deps, { initialLaunchLimit: 2, maxConcurrency: 2 });
    const p = scheduler.run();
    await flush(0);
    expect(h.started()).toEqual([1, 2]);

    h.rateLimit(1); // t=1e6：容量降到 1，2 号占满
    await flush(0);
    expect(scheduler.snapshot().rateLimitCapacity).toBe(1);

    // 先推进 1000ms（远早于退避就绪的 t=1e6+3000），再 settle 2 号：
    // 腾出容量不等于能立刻放量——退避未到期就不许提前重试。
    await advanceClock(1000);
    h.complete(2);
    await flush(0);
    expect(h.attemptsOf(1)).toBe(1);

    // 退避到点（t = 1e6+3000）由定时器唤醒 1 号，而不是"settle 顺带放量"。
    await advanceClock(2000);
    expect(h.attemptsOf(1)).toBe(2);
    h.complete(1, { result: "retry-done" });

    // 1 号 settle 后容量空闲，但全局节流还有一个 globalRetryIntervalMs：
    // 3 号必须等到节流到点才放量，且放的是**新成员**而不是 1 号的第三次尝试。
    await flush(0);
    expect(h.attemptsOf(3)).toBe(0);
    await advanceClock(3000);
    expect(h.started()).toEqual([1, 2, 1, 3]);

    h.complete(3);
    await advanceClock(3000);
    h.complete(4);
    const results = await p;
    expect(results.map((r) => r.outcome)).toEqual(["completed", "completed", "completed", "completed"]);
  });
});

// ───────────────────────── 容量收缩 / 恢复 ─────────────────────────

describe("容量收缩与恢复", () => {
  it("进入限流模式时容量 = 已成功启动数 - 1", async () => {
    const h = harness();
    const scheduler = new SwarmScheduler(specsOf(10), h.deps);
    const p = scheduler.run();
    await flush(0);
    expect(scheduler.snapshot().startedSuccessCount).toBe(5);

    h.rateLimit(1);
    await flush(0);
    const snap = scheduler.snapshot();
    expect(snap.rateLimitMode).toBe(true);
    expect(snap.rateLimitCapacity).toBe(4); // max(1, 5) - 1

    await drain(h, p);
  });

  it("容量收缩有 2000ms 防抖，超过后才继续 -1", async () => {
    const h = harness();
    const scheduler = new SwarmScheduler(specsOf(10), h.deps);
    const p = scheduler.run();
    await flush(0);

    h.rateLimit(1);
    await flush(0);
    expect(scheduler.snapshot().rateLimitCapacity).toBe(4);

    // 防抖窗口内再来一次限流 → 容量不动
    await flush(1000);
    h.rateLimit(2);
    await flush(0);
    expect(scheduler.snapshot().rateLimitCapacity).toBe(4);

    // 跨过 2000ms 窗口后再限流 → 允许收缩
    await flush(1001);
    h.rateLimit(3);
    await flush(0);
    expect(scheduler.snapshot().rateLimitCapacity).toBe(3);

    await drain(h, p);
  });

  it("容量下限为 1", async () => {
    const h = harness();
    const scheduler = new SwarmScheduler(specsOf(4), h.deps, SLOW);
    const p = scheduler.run();
    await flush(0);
    expect(scheduler.snapshot().startedSuccessCount).toBe(1);

    // max(1, 1) = 1，再 -1 → 被下限钉在 1
    h.rateLimit(1);
    await flush(0);
    expect(scheduler.snapshot().rateLimitCapacity).toBe(1);

    await drain(h, p);
  });

  it("每 180s 容量 +1 恢复，并把放量时刻拉回当下", async () => {
    const h = harness();
    const scheduler = new SwarmScheduler(specsOf(10), h.deps, SLOW);
    const p = scheduler.run();
    await flush(0);
    h.rateLimit(1);
    await flush(0);
    expect(scheduler.snapshot().rateLimitCapacity).toBe(1);

    await flush(179_999);
    expect(scheduler.snapshot().rateLimitCapacity).toBe(1);

    await flush(1); // 满 180s
    expect(scheduler.snapshot().rateLimitCapacity).toBe(2);

    // 第二个 180s 窗口。
    //
    // 这里不能再断言「容量涨到 3」，因为 F3 放宽死锁防护后 1 号会被重排队并真的重启，
    // 于是 active 恒为 1；而容量恢复只在 #scheduleRateLimitLaunch 的一轮里发生，
    // 该方法开头先判 `active.size >= rateLimitCapacity` 就返回（尚未 +1）。
    // 换言之：**满载时容量恢复被并发闸门挡住**，这是既有设计，不是本次改动引入的。
    // 旧用例之所以能连涨到 3，恰恰是因为旧行为下 1 号首次限流即被判死、不再重排队，
    // active 才会在 t=180s 时归零。
    //
    // 因此本用例收敛为它真正要验的那一条：180s 时刻容量确实 +1（1 → 2）。
    // 「满载时恢复被挡」由下面的独立回归用例显式钉住。
    expect(scheduler.snapshot().rateLimitCapacity).toBe(2);

    await drain(h, p);
  });

  it("回归：满载（active 达到容量）时容量恢复照常推进，但放量仍被并发闸门挡住", async () => {
    // 把 F3 造成的行为变化钉成显式契约，避免以后有人误把它当成回归改回去：
    // 1 号首次限流 → 退避重排队（不再判死）；
    // 到 180s 容量恢复到 2 并真的重启 1 号；
    // 此后 active 恒为 1（maxConcurrency=1）→ **不启动任何新成员**。
    //
    // 订正（原用例在此断言"容量停在 2"，理由是"恢复被并发闸门挡住"）：那个断言实际钉住的
    // 是"唤醒定时器被丢掉"这一缺陷——容量恢复只在 #scheduleRateLimitLaunch 的一轮里发生，
    // 旧实现满并发时不再武装定时器，恢复链条随之冻结。保活修复后恢复**照常**继续
    // （容量 2 → 3），被闸门挡住的是**放量**（attemptsOf(1) 停在 2）——这才是本条要钉的契约。
    const h = harness();
    const scheduler = new SwarmScheduler(specsOf(10), h.deps, SLOW);
    const p = scheduler.run();
    await flush(0);
    h.rateLimit(1);
    await flush(0);
    expect(h.attemptsOf(1)).toBe(1);

    await flush(180_000);
    expect(scheduler.snapshot().rateLimitCapacity).toBe(2);
    expect(h.attemptsOf(1)).toBe(2); // 恢复瞬间真的重试了，不是判死

    await flush(180_000);
    expect(scheduler.snapshot().rateLimitCapacity).toBe(3); // 恢复照常（保活修复后不再冻结）
    expect(h.attemptsOf(1)).toBe(2); // 但 maxConcurrency=1 压住放量：没有新成员被启动

    await drain(h, p);
  });

  it("回归：限流模式满并发时仍装唤醒定时器，容量恢复不被饿死", async () => {
    // F5 修复引入的回归护栏：满并发时若直接 return 而不装唤醒定时器，
    // 180s 容量恢复将永远等不到 tick，恢复机制被静默饿死。
    const h = harness();
    const scheduler = new SwarmScheduler(specsOf(10), h.deps, {
      initialLaunchLimit: 1,
      maxConcurrency: 1,
    });
    const p = scheduler.run();
    await flush(0);
    h.rateLimit(1);
    await flush(0);

    // 推进到第一个恢复点：容量必须真的 +1（说明唤醒定时器被正确装上了）。
    await flush(180_000);
    expect(scheduler.snapshot().rateLimitCapacity).toBe(2);

    await drain(h, p);
  });

  it("回归：满并发时不得把唤醒丢掉——没有任何 settle，也必须始终留着未来唤醒", async () => {
    // 触发条件是三个条件的交集：① 限流模式；② 放量被 maxConcurrency 卡死；
    // ③ 全局节流与退避就绪时间都已是过去时。此时"下一个可放量时刻"算出来是过去时刻，
    // 旧实现直接 return 且不装定时器，于是 pending 还在、批次没结束、却没有任何唤醒——
    // 只能指望某个在跑成员恰好 settle（实测：推进 4.5e6ms 后仍 active=1/pending=7）。
    // 本用例全程不 settle 任何成员（advanceClock 不结算，drain 只在最后收尾），
    // 因此它断言的就是"定时器本身还在"以及"那个定时器真的会触发状态变化"。
    const h = harness();
    const scheduler = new SwarmScheduler(specsOf(8), h.deps, SLOW);
    const p = scheduler.run();
    await flush(0);
    h.rateLimit(1);
    await flush(0);
    expect(h.attemptsOf(1)).toBe(1);

    // 第一个恢复点：容量 1 → 2，1 号被重试并再次占满 maxConcurrency=1。
    await advanceClock(180_000);
    expect(scheduler.snapshot().rateLimitCapacity).toBe(2);
    expect(h.attemptsOf(1)).toBe(2);

    // 关键状态：有 pending、批次未结束、没有 settle 可指望。
    const snap = scheduler.snapshot();
    expect(snap.finished).toBe(false);
    expect(snap.pendingCount).toBe(7);
    expect(snap.activeCount).toBe(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0); // 修复前为 0：唤醒被丢掉

    // 再过一个恢复窗口：容量必须真的再 +1，证明留下的是"有效唤醒"而不是空转的定时器。
    await advanceClock(180_000);
    expect(scheduler.snapshot().rateLimitCapacity).toBe(3);
    // 但并发闸门照样压住放量：没有启动任何新成员（1 号仍是唯一在跑的）。
    expect(h.started()).toEqual([1, 1]);

    // 与题面实测口径对齐：继续推进到 4.5e6 虚拟毫秒（≈25 个恢复窗口），全程仍然零 settle。
    // 修复前这里就是"推进 4.5e6ms 后仍 active=1/pending=7 且没有任何定时器"；
    // 修复后容量持续推进、唤醒定时器始终在，批次只是被并发闸门合法地压住。
    // （容量不设上界是既有判定，故此处只断言"还在涨"，不钉具体数值。）
    await advanceClock(4_500_000, 18_000);
    expect(scheduler.snapshot().rateLimitCapacity).toBeGreaterThan(2);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(scheduler.snapshot().activeCount).toBe(1);
    expect(scheduler.snapshot().pendingCount).toBe(7);

    await drain(h, p);
  });
});

// ───────────────────────── 限流节奏（轻罚统一） ─────────────────────────

describe("限流重排队：一律轻罚，与 ready 与否无关", () => {
  it("ready 前被限流 → 全局间隔也只推 3000ms（重罚档已删除）", async () => {
    // 曾有「首个请求未发出 → 全局间隔翻倍」的重罚档，但宿主无法观测该状态
    //（DSH 的 start() 成功即意味着子代理已开始首轮），生产接线下永不可达，
    // 2026-10-01 连同 classify 依赖一并删除。本条钉住删除后的行为：
    // 未 ready 的成员被限流，节奏与已 ready 完全一致。
    const h = harness({ autoReady: false });
    const scheduler = new SwarmScheduler(specsOf(6), h.deps, SLOW);
    const p = scheduler.run();
    await flush(0);
    expect(h.runs[0]?.ready).toBe(false);

    h.rateLimit(1); // 从未 markReady
    await flush(0);

    const snap = scheduler.snapshot();
    expect(snap.rateLimitMode).toBe(true);
    expect(snap.startedSuccessCount).toBe(0);
    expect(snap.rateLimitCapacity).toBe(1); // max(1, 0) - 1 → 下限 1
    expect(snap.globalRetryIntervalMs).toBe(3000); // 轻罚：不翻倍
    expect(snap.nextRateLimitLaunchAt).toBe(Date.now() + 3000);

    await drain(h, p);
  });

  it("ready 后被限流 → 全局间隔只推 3000ms", async () => {
    const h = harness();
    const scheduler = new SwarmScheduler(specsOf(6), h.deps, SLOW);
    const p = scheduler.run();
    await flush(0);
    expect(h.runs[0]?.ready).toBe(true);

    h.rateLimit(1);
    await flush(0);
    const snap = scheduler.snapshot();
    expect(snap.globalRetryIntervalMs).toBe(3000);
    expect(snap.nextRateLimitLaunchAt).toBe(Date.now() + 3000);

    await drain(h, p);
  });

  it("限流模式下 markReady 重新锚定放量时刻（now + retryBaseMs）", async () => {
    // 成员发出首个请求说明 provider 在响应 → 调度器把放量锚点重置到「现在 + 基准间隔」，
    // 而不是继续沿用限流发生时刻算出的旧锚点。
    const h = harness({ autoReady: false });
    const scheduler = new SwarmScheduler(specsOf(6), h.deps, { initialLaunchLimit: 2, maxConcurrency: 2 });
    const p = scheduler.run();
    await flush(0);

    h.rateLimit(1);
    await flush(0);
    expect(scheduler.snapshot().globalRetryIntervalMs).toBe(3000);

    await flush(1000); // 时钟推进，限流时刻算出的旧锚点已成过去时
    h.markReady(2); // 2 号发出首个请求 → 重新锚定
    expect(scheduler.snapshot().globalRetryIntervalMs).toBe(3000);
    expect(scheduler.snapshot().nextRateLimitLaunchAt).toBe(Date.now() + 3000);

    await drain(h, p);
  });
});
