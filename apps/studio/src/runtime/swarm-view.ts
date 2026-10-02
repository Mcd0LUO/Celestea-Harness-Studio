/**
 * swarm-view.ts — project one session's batch roster onto `Statusline.swarm?`.
 *
 * §7.1 的数据通道是**可选附加字段**，不是新事件、不是新端点、也不落盘：
 *   · 读侧 = session-scoped 的 `SwarmRegistry`（`Runtime.swarm`，与 `Runtime.workers` 同形）；
 *   · 写侧 = Statusline 上一个**可选**的 `swarm` 字段，随既有 status 帧一起发。
 *
 * 两条纪律（写在这里是因为它们容易被「顺手优化」掉）：
 *
 *   1. **缺省 = 整个字段不出现**，不是空对象、不是空数组。未挂载 swarm 插件
 *      或该会话没有批次时，前端据此零渲染且不报错 —— 老前端 / 老服务读到缺省
 *      必须照常渲染其余状态栏字段。
 *   2. **不得预先过滤单成员批次**。「同一次调用 >= 2 成员才聚合成卡片」是**呈现
 *      规则**，归前端 `apps/web/src/statusline/swarm.ts` 的纯函数所有；这里
 *      预过滤会让阈值出现两份实现，正是这个仓反复在消灭的东西（详见
 *      packages/core/src/types.ts 的 SwarmRosterView 注释）。
 *
 * 相位映射是本文件唯一的翻译层：roster 的七态（pending/starting/running/
 * retrying/completed/failed/aborted）压成面板的四组（running/failed/done/
 * cancelled），pending 也算「进行中」—— 它已经在批次里，只是还没拿到成员信号。
 */

import type { SwarmBatchView, SwarmMemberPhase, SwarmMemberView, SwarmRosterView } from "@celestea/core";
import type { SwarmMemberView as RosterMember, SwarmPhase } from "@celestea/swarm";

/** roster 的七态 -> 面板的四组。pending/starting/retrying 都算「进行中」。 */
export function panelPhaseOf(phase: SwarmPhase): SwarmMemberPhase {
  if (phase === "completed") return "done";
  if (phase === "failed") return "failed";
  if (phase === "aborted") return "cancelled";
  return "running";
}

/** 面板视图的成员：`label` 是 item 摘要（roster 侧已按 200 码元截断过）。 */
function memberViewOf(member: RosterMember): SwarmMemberView {
  return { id: String(member.index), label: member.item, phase: panelPhaseOf(member.phase) };
}

/**
 * 把 roster 快照投影成面板视图；没有快照就返回 null（字段缺省）。
 *
 * `active` 取自 activeCount 而不是「批次 status 是否 running」：一个批次收尾后
 * 仍可能短暂有成员在落终态，activeCount 是那一瞬间的真实读数。
 */
function batchViewOf(description: string, routeLabel: string | undefined, done: number, total: number, members: readonly RosterMember[]): SwarmBatchView {
  const batch: SwarmBatchView = {
    id: "latest",
    // 读不到就留空、不猜：UI 对空的模型标签就是留空（见 SwarmBatchView.model）。
    model: routeLabel ?? "",
    members: members.map(memberViewOf),
    done,
    total,
  };
  void description;
  return batch;
}

/**
 * 这一代会话的 roster（宿主组装 statusline 时调）。
 *
 * 冷会话（没有实例）根本不调它：那条 statusline 由 `coldStatusline` 拥有，
 * 一个没跑过批次的冷会话没有 roster 可挂，缺省就是正确答案。
 */
export function swarmRosterOf(roster: { snapshot(sessionId?: string): SwarmRosterSnapshotLike | undefined } | null, sessionId: string | null, sessionKey: string | null): SwarmRosterView | null {
  if (roster === null) return null;
  const snapshot = roster.snapshot(sessionKey ?? undefined);
  if (snapshot === undefined) return null;
  return {
    active: snapshot.activeCount > 0,
    batches: [batchViewOf(snapshot.description, snapshot.routeLabel, snapshot.done, snapshot.total, snapshot.members)],
  };
}

/** roster 快照的最小读侧形状（结构化取，只用投影需要的字段）。 */
export interface SwarmRosterSnapshotLike {
  readonly description: string;
  readonly routeLabel?: string;
  readonly total: number;
  readonly done: number;
  readonly activeCount: number;
  readonly members: ReadonlyArray<RosterMember>;
}

/**
 * 把 roster 挂到 statusline 上 —— 没有 roster 就原样返回。
 */
export function withSwarmRoster<T extends { swarm?: SwarmRosterView }>(statusline: T, roster: SwarmRosterView | null): T {
  if (roster === null) return statusline;
  return { ...statusline, swarm: roster };
}
