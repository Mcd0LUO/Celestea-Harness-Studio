// ============================================================================
// types/skill.ts — `GET /api/sessions/{id}/skills`（技能显式调用 · 切片 2）。
//   冻结形状（W9350 / docs/feature/skill-command.md §4 切片 1）：
//     `{ ok, session, skills: [{ name, description, source, dir }], rejected: [] }`
//   四个键恒在。**skills: [] 是合法答案**（没有技能 / 会话没有工作区），不是错误、不是
//   404；404 是共享的 require() 拒绝——「这个会话不存在」与「这个会话没有技能」是
//   两件事，只有后者能答成空列表。
//   前端只用 name + description：dir 是给模型解析相对路径用的，不进补全框。
// ============================================================================

/** 清单里的一行技能（端点的四个线上键，缺一即视为非法行）。 */
export interface SkillEntry {
  /** 技能名：`skills/<name>/` 的目录名，也是 `/{name}` 直呼与 `/skill:<name>` 的名字。 */
  name: string;
  /** 一行说明（补全框里那一行 desc）。 */
  description: string;
  /** 来源层：global / project（project 覆盖 global）。 */
  source: string;
  /** 技能目录绝对路径。 */
  dir: string;
}

/** `GET /api/sessions/{id}/skills` 响应。 */
export interface SkillsResp {
  ok?: boolean;
  session?: string;
  skills?: SkillEntry[];
  /** 发现但被拒的技能（frontmatter 不合法 / 名字 ≠ 目录名）；前端不消费，但要留得住。 */
  rejected?: unknown[];
  error?: string;
}
