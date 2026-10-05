// ============================================================================
// types/goal.ts — A3：持久目标（POST /api/sessions/{id}/goal）。
//   冻结契约 v1（W9347）：请求体 `{ text?, paused? }`（至少给一个）——
//     · text：空串 / 纯空白 = 删除；非空 = 设定/编辑；
//     · paused：必须是 boolean；**当前没有目标**时 422（cannot pause: no goal）；
//     · 两个都给：先落 text、再落 paused。
//   200 = { ok, session, goal: { text, paused, createdAt, updatedAt } | null }。
//     paused **恒在**（active 时 false）；goal:null = 无目标。
//   目标不驱动自动续跑（P0 明确不做）：只做「持久可见 + 每轮注入上下文」。
// ============================================================================

/** 一个持久目标（服务端回声）。paused 恒在（活跃时为 false）。 */
export interface GoalInfo {
  text: string;
  /** true = 已暂停（模型下一轮会看到「暂停期间不要推进」）；字段恒在。 */
  paused: boolean;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/sessions/{id}/goal 请求体（至少给一个字段）。 */
export interface GoalReq {
  /** 空串 / 纯空白 = 删除；非空 = 设定或编辑。 */
  text?: string;
  /** true = 暂停（无目标时后端 422）；false = 恢复。 */
  paused?: boolean;
}

/** POST /api/sessions/{id}/goal 响应；goal=null 表示当前无目标。 */
export interface GoalResp {
  ok?: boolean;
  goal?: GoalInfo | null;
  error?: string;
}
