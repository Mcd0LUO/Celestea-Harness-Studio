import { describe, it, expect } from "vitest";
import {
  MEMBER_VIEW_DETAIL_MAX_CHARS,
  MEMBER_VIEW_ITEM_MAX_CHARS,
  SwarmRegistry,
} from "./roster.js";

/**
 * 成员七态状态机（搬运自 dsh-agent-swarm tests/swarm-registry.test.ts 的 19-178 行）。
 *
 * 裁剪记录（Q3 裁定）：删掉 describe「SwarmRegistry framesFor stream」「framesFor：资源边界
 * 与并发批次」「独立审查回归：推流与批次状态」等帧推流整块——那是 DSH SSE 协议，本仓 §7.1
 * 明确不加 SSE 事件名。状态机断言全部保留（七态是面板徽标的数据源）。
 * 搬运断言一字未改；toRosterFrame(batch, now) 改为等价的 registry.snapshotOf(batch)
 * （同形状的只读投影；帧的 type/at 字段本仓不需要）。
 */
describe("SwarmRegistry state machine", () => {
  it("initializes members in pending phase and tracks counts correctly", () => {
    const reg = new SwarmRegistry();
    const specs = [
      { index: 1, item: "task 1" },
      { index: 2, item: "task 2" },
      { index: 3, item: "task 3" },
    ];
    const swarmId = reg.beginBatch("sess-1", "Test batch", specs, 1000);

    const batch = reg.getBatch(swarmId);
    expect(batch).toBeDefined();
    expect(batch?.total).toBe(3);
    expect(batch?.status).toBe("running");

    const roster1 = reg.snapshotOf(batch!);
    expect(roster1.activeCount).toBe(0);
    expect(roster1.completedCount).toBe(0);
    expect(roster1.failedCount).toBe(0);
    expect(roster1.abortedCount).toBe(0);
    expect(roster1.members.every((m) => m.phase === "pending")).toBe(true);

    // mark starting & agentId
    reg.markStarting(swarmId, 1);
    reg.setAgentId(swarmId, 1, "agent-1");
    expect(batch?.members.get(1)?.phase).toBe("starting");
    expect(batch?.members.get(1)?.agentId).toBe("agent-1");

    // mark ready (running)
    reg.markReady(swarmId, 1, 1100);
    expect(batch?.members.get(1)?.phase).toBe("running");
    expect(batch?.members.get(1)?.startedAt).toBe(1100);

    // mark suspended (retrying)
    reg.markSuspended(swarmId, 2, 1, 4000, "Rate limited");
    expect(batch?.members.get(2)?.phase).toBe("retrying");
    expect(batch?.members.get(2)?.retryCount).toBe(1);
    expect(batch?.members.get(2)?.retryReadyAt).toBe(4000);
    expect(batch?.members.get(2)?.detail).toBe("Rate limited");

    const roster2 = reg.snapshotOf(batch!);
    expect(roster2.activeCount).toBe(2); // running + retrying

    // mark completed, failed, aborted
    reg.markSettled(swarmId, 1, "completed", undefined, 2000);
    reg.markSettled(swarmId, 2, "failed", "Max retries exceeded", 2100);
    reg.markSettled(swarmId, 3, "aborted", "Cancelled by user", 2200);

    const roster3 = reg.snapshotOf(batch!);
    expect(roster3.activeCount).toBe(0);
    expect(roster3.completedCount).toBe(1);
    expect(roster3.failedCount).toBe(1);
    expect(roster3.abortedCount).toBe(1);

    // end batch
    reg.endBatch(swarmId, 2500);
    expect(batch?.endedAt).toBe(2500);
    expect(batch?.status).toBe("failed"); // has failed member
  });

  it("calculates batch completed status when all succeed", () => {
    const reg = new SwarmRegistry();
    const specs = [
      { index: 1, item: "task 1" },
      { index: 2, item: "task 2" },
    ];
    const swarmId = reg.beginBatch("sess-1", "All succeed", specs, 1000);
    reg.markSettled(swarmId, 1, "completed");
    reg.markSettled(swarmId, 2, "completed");
    reg.endBatch(swarmId, 1100);

    const batch = reg.getBatch(swarmId);
    expect(batch?.status).toBe("completed");
  });

  it("calculates batch aborted status when aborted and no failure", () => {
    const reg = new SwarmRegistry();
    const specs = [
      { index: 1, item: "task 1" },
      { index: 2, item: "task 2" },
    ];
    const swarmId = reg.beginBatch("sess-1", "Aborted batch", specs, 1000);
    reg.markSettled(swarmId, 1, "completed");
    reg.markSettled(swarmId, 2, "aborted");
    reg.endBatch(swarmId, 1100);

    const batch = reg.getBatch(swarmId);
    expect(batch?.status).toBe("aborted");
  });

  it("respects maxRetainedBatches per session（淘汰最旧的已结束批次）", () => {
    const reg = new SwarmRegistry({ maxRetainedBatches: 2 });
    const id1 = reg.beginBatch("sess-a", "Batch 1", [{ index: 1, item: "a" }]);
    reg.endBatch(id1);
    const id2 = reg.beginBatch("sess-a", "Batch 2", [{ index: 1, item: "b" }]);
    reg.endBatch(id2);
    const id3 = reg.beginBatch("sess-a", "Batch 3", [{ index: 1, item: "c" }]);

    expect(reg.getBatch(id1)).toBeUndefined();
    expect(reg.getBatch(id2)).toBeDefined();
    expect(reg.getBatch(id3)).toBeDefined();
    expect(reg.getLatestBatch("sess-a")?.swarmId).toBe(id3);
  });

  it("运行中的批次永不被淘汰（软上限）：否则它之后的相位更新会静默落空、面板停在中途", () => {
    const reg = new SwarmRegistry({ maxRetainedBatches: 2 });
    const running = reg.beginBatch("sess-a", "still running", [{ index: 1, item: "a" }]);
    const ended = reg.beginBatch("sess-a", "ended", [{ index: 1, item: "b" }]);
    reg.endBatch(ended);
    const newest = reg.beginBatch("sess-a", "newest", [{ index: 1, item: "c" }]);
    // 超出上限时跳过运行中的 running，淘汰已结束的 ended
    expect(reg.getBatch(running)).toBeDefined();
    expect(reg.getBatch(ended)).toBeUndefined();
    expect(reg.getBatch(newest)).toBeDefined();
    // 全是运行中的批次时允许暂时超出上限
    const another = reg.beginBatch("sess-a", "another", [{ index: 1, item: "d" }]);
    expect([running, newest, another].every((id) => reg.getBatch(id) !== undefined)).toBe(true);
    // 运行中批次的更新照常生效
    reg.markSettled(running, 1, "completed");
    expect(reg.getBatch(running)?.members.get(1)?.phase).toBe("completed");
  });

  it("会话数上限：按最近活跃淘汰空闲会话，有运行中批次的会话不淘汰（此前会话表只增不减）", () => {
    const reg = new SwarmRegistry({ maxRetainedSessions: 2 });
    const busy = reg.beginBatch("sess-busy", "running", [{ index: 1, item: "a" }]);
    const idle = reg.beginBatch("sess-idle", "done", [{ index: 1, item: "b" }]);
    reg.endBatch(idle);
    reg.beginBatch("sess-new", "new", [{ index: 1, item: "c" }]);
    // 超出 2 个会话：最久未活跃的 sess-busy 有运行中批次 → 跳过；淘汰空闲的 sess-idle
    expect(reg.getBatch(busy)).toBeDefined();
    expect(reg.getBatch(idle)).toBeUndefined();
    expect(reg.getLatestBatch("sess-idle")).toBeUndefined();
    expect(reg.getLatestBatch("sess-new")).toBeDefined();
  });

  it("成员视图只保留显示摘要：长 item / detail 截断，原长另给（XML 不受影响，它不读 registry）", () => {
    const reg = new SwarmRegistry();
    const longItem = "x".repeat(MEMBER_VIEW_ITEM_MAX_CHARS + 50);
    const swarmId = reg.beginBatch("sess-t", "trunc", [
      { index: 1, item: longItem },
      { index: 2, item: "short" },
    ]);
    const member = reg.getBatch(swarmId)?.members.get(1);
    expect(member?.item).toBe(`${"x".repeat(MEMBER_VIEW_ITEM_MAX_CHARS)}…`);
    expect(member?.itemChars).toBe(MEMBER_VIEW_ITEM_MAX_CHARS + 50);
    expect(reg.getBatch(swarmId)?.members.get(2)).not.toHaveProperty("itemChars");

    reg.markSettled(swarmId, 1, "failed", "e".repeat(MEMBER_VIEW_DETAIL_MAX_CHARS * 3));
    expect(reg.getBatch(swarmId)?.members.get(1)?.detail?.length).toBe(MEMBER_VIEW_DETAIL_MAX_CHARS + 1);
  });

  it("roster 帧里的成员是快照：之后的相位变化不会改写已经发出的帧", () => {
    const reg = new SwarmRegistry();
    const swarmId = reg.beginBatch("sess-snap", "snap", [{ index: 1, item: "a" }]);
    const frame = reg.snapshotOf(reg.getBatch(swarmId)!);
    reg.markSettled(swarmId, 1, "completed");
    expect(frame.members[0]?.phase).toBe("pending");
  });
});

/**
 * 终态粘性回归（WP-B 之后由父代理补的守卫）：
 * 中断时调度器会先把"尚未 ready"的成员落 aborted；而此刻可能仍有在飞的
 * ctx.subagents.start，它之后才 reject，宿主 catch 会再调一次 markSettled("failed")。
 * 若允许覆写，这次"后到者"会把 aborted 改成 failed，批次又被 endBatch 推导成 failed，
 * 与 XML 侧"全员 aborted"的结论重新矛盾。守卫语义：**先到的终态才是真实结局**。
 */
describe("markSettled 的终态粘性", () => {
  it("迟到的 start 失败不得把已落定的 aborted 改成 failed", () => {
    const registry = new SwarmRegistry();
    const swarmId = registry.beginBatch("sess-sticky", "中断竞态", [
      { index: 1, item: "a" },
      { index: 2, item: "b" },
    ]);

    // ① 中断路径：未 ready 的成员先落 aborted
    registry.markSettled(swarmId, 1, "aborted", "The swarm was interrupted before this member finished.");
    registry.markSettled(swarmId, 2, "aborted", "The swarm was interrupted before this member finished.");
    // ② 在飞的 start 随后 reject → 宿主 catch 再落一次 failed
    registry.markSettled(swarmId, 1, "failed", "Subagent could not be started: the run was aborted");

    const member = registry.getBatch(swarmId)?.members.get(1);
    expect(member?.phase).toBe("aborted");
    expect(member?.detail).toBe("The swarm was interrupted before this member finished.");

    registry.endBatch(swarmId);
    expect(registry.getBatch(swarmId)?.status).toBe("aborted");
  });

  it("反向时序一致：先落 failed 的成员不被后到的 aborted 改写", () => {
    const registry = new SwarmRegistry();
    const swarmId = registry.beginBatch("sess-sticky-2", "反序", [
      { index: 1, item: "a" },
      { index: 2, item: "b" },
    ]);

    registry.markSettled(swarmId, 1, "failed", "Subagent could not be started: boom");
    registry.markSettled(swarmId, 2, "completed");
    registry.markSettled(swarmId, 1, "aborted", "interrupted");

    expect(registry.getBatch(swarmId)?.members.get(1)?.phase).toBe("failed");
    registry.endBatch(swarmId);
    expect(registry.getBatch(swarmId)?.status).toBe("failed");
  });
});
