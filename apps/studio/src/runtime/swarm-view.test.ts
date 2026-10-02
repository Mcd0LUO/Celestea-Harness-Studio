/**
 * swarm-view 的投影断言（§7.1 数据通道）。
 *
 * 被测的是**唯一的翻译层**：roster 七态 -> 面板四组。两条纪律也有断言护着：
 *   · 没有 roster / 没有批次 => 整个字段缺省（不是空对象）；
 *   · 单成员批次【照常投影】（>=2 阈值归前端，这里预过滤就成两份真源）。
 */

import { describe, expect, it } from "vitest";

import { panelPhaseOf, swarmRosterOf, withSwarmRoster, type SwarmRosterSnapshotLike } from "./swarm-view.js";
import type { SwarmMemberView as RosterMember, SwarmPhase } from "@celestea/swarm";
import type { SwarmRosterView } from "@celestea/core";

/** statusline 的最小形状：只留与挂载断言有关的字段。 */
type StatuslineLike = { model: string; steps: number; swarm?: SwarmRosterView | undefined };

/** 假快照显式声明成读侧形状，省掉成员其余必填字段的样板。 */
type FakeSnapshot = SwarmRosterSnapshotLike;

/** 假成员：只填投影读得到的字段，其余（retryCount 等）给中性值。 */
function memberOf(index: number, item: string, phase: SwarmPhase): RosterMember {
  return { index, item, phase, retryCount: 0 };
}

function snapshotOf(over: Partial<FakeSnapshot> = {}): FakeSnapshot {
  return {
    description: "批次一",
    total: 2,
    done: 0,
    activeCount: 2,
    members: [memberOf(1, "a.ts", "running"), memberOf(2, "b.ts", "pending")],
    ...over,
  };
}

/** 一个只会回答 snapshot() 的假 registry。 */
function registryOf(snap: ReturnType<typeof snapshotOf> | undefined) {
  return {
    snapshot: (): ReturnType<typeof snapshotOf> | undefined => snap,
  };
}

describe("panelPhaseOf — roster 七态 -> 面板四组", () => {
  it("completed/failed/aborted 直译，其余三类都算进行中", () => {
    expect(panelPhaseOf("completed")).toBe("done");
    expect(panelPhaseOf("failed")).toBe("failed");
    expect(panelPhaseOf("aborted")).toBe("cancelled");
    expect(panelPhaseOf("pending")).toBe("running");
    expect(panelPhaseOf("starting")).toBe("running");
    expect(panelPhaseOf("running")).toBe("running");
    expect(panelPhaseOf("retrying")).toBe("running");
  });
});

describe("swarmRosterOf — 投影与缺省", () => {
  it("没有接线 => null（字段整个缺省）", () => {
    expect(swarmRosterOf(null, "s1", "s1")).toBeNull();
  });

  it("接了线但没有批次 => null（不是空 batches）", () => {
    expect(swarmRosterOf(registryOf(undefined), "s1", "s1")).toBeNull();
  });

  it("投影批次与成员：done/total、模型标签、相位归并", () => {
    const view = swarmRosterOf(
      registryOf(snapshotOf({ routeLabel: "deepseek-chat", done: 1, activeCount: 1, members: [memberOf(1, "a", "completed"), memberOf(2, "b", "running")] })),
      "s1",
      "s1",
    );
    expect(view).not.toBeNull();
    expect(view?.active).toBe(true);
    expect(view?.batches).toHaveLength(1);
    expect(view?.batches[0]?.done).toBe(1);
    expect(view?.batches[0]?.total).toBe(2);
    expect(view?.batches[0]?.model).toBe("deepseek-chat");
    expect(view?.batches[0]?.members.map((m) => m.phase)).toEqual(["done", "running"]);
    expect(view?.batches[0]?.members.map((m) => m.id)).toEqual(["1", "2"]);
    expect(view?.batches[0]?.members[0]?.label).toBe("a");
  });

  it("模型标签读不到就留空、不猜", () => {
    const view = swarmRosterOf(registryOf(snapshotOf()), "s1", "s1");
    expect(view?.batches[0]?.model).toBe("");
  });

  it("全部落定 => active=false（徽标可整体隐藏）", () => {
    const view = swarmRosterOf(
      registryOf(snapshotOf({ activeCount: 0, done: 2, members: [memberOf(1, "a", "completed"), memberOf(2, "b", "completed")] })),
      "s1",
      "s1",
    );
    expect(view?.active).toBe(false);
  });

  it("★ 不预过滤单成员批次：>=2 阈值归前端（预过滤会变两份真源）", () => {
    const view = swarmRosterOf(registryOf(snapshotOf({ total: 1, done: 0, activeCount: 1, members: [memberOf(1, "only", "running")] })), "s1", "s1");
    expect(view?.batches).toHaveLength(1);
    expect(view?.batches[0]?.total).toBe(1);
  });
});

describe("withSwarmRoster — 挂载与缺省", () => {
  it("无 roster 时原样返回（statusline 不被复制）", () => {
    const line: StatuslineLike = { model: "m", steps: 0, swarm: undefined };
    const out = withSwarmRoster(line, null);
    expect(out).toBe(line);
    expect(out.swarm).toBeUndefined();
  });

  it("有 roster 时挂上去，其余字段原样", () => {
    const line: StatuslineLike = { model: "m", steps: 0, swarm: undefined };
    const view = swarmRosterOf(registryOf(snapshotOf()), "s1", "s1");
    const out = withSwarmRoster(line, view);
    expect(out.swarm).toBe(view);
    expect(out.model).toBe("m");
    expect(out.steps).toBe(0);
  });
});
