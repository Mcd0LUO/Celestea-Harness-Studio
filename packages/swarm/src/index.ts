/**
 * `@celestea/swarm` — 把一批同形子任务展开为并行子代理的**纯逻辑 + 装配**层。
 *
 * Responsibility: 六道入参校验与模板展开、UTF-16 安全截断、并发调度（首波放量 + 限流退避 +
 * 双重判死）、`<agent_swarm_result>` XML 渲染、成员七态状态机（面板的数据源），以及
 * 轻量 turn 执行器与 agent_swarm 工具的装配。
 *
 * Dependency direction: swarm -> core only（ARCHITECTURE §1 L1）。驱动的 seam（`Llm`、
 * `ToolRegistry`、`AgentLoop`）由装配根 `packages/runtime` 注入，因此本包绝不横向 import
 * 同层实现。
 *
 * Module map:
 *   types.ts       纯类型 + 冻结常量（校验码表 / 调度参数 / 默认值）
 *   validate.ts    六道硬校验 + `{{item}}` 模板展开（失败是结果不是异常）
 *   text-clip.ts   UTF-16 安全截断的唯一出口（不劈代理对 / 不切碎 JSON 转义）
 *   scheduler/core.ts        主状态机：正常模式放量 + attempt 生命周期 + 中断/超时
 *   scheduler/rate-limit.ts  限流模式：容量收缩 / 退避（带抖动）/ 恢复 / 唤醒时刻
 *   scheduler/results.ts     结果构造与宿主回调容纳（纯函数）
 *   scheduler/index.ts       runSwarm 入口 + 类型重导出（调度器唯一的对外收口）
 *   result-xml.ts  `<agent_swarm_result>` 渲染（属性与 body 全部转义，1-based 编号钉死）
 *   roster.ts      成员七态状态机 + 会话订阅 + 合帧原语（Statusline.swarm? 的数据源）
 *   executor.ts    轻量 turn 执行器：每成员一个 fresh Context 跑展开后的 prompt
 *   tool.ts        agent_swarm 工具实现（校验 -> 装配调度器 -> 返回 XML）
 *   plugin.ts      Context 注册 + SwarmWiring 接线
 *
 * Public API = this file. Everything else is an internal module.
 */

// ── 类型与冻结常量 ──
export * from "./types.js";

// ── 入参校验与模板展开 ──
export * from "./validate.js";

// ── UTF-16 安全截断 ──
export * from "./text-clip.js";

// ── 调度器（core / rate-limit / results / index 统一从 index.ts 收口）──
export * from "./scheduler/index.js";

// ── 结果 XML 渲染 ──
export * from "./result-xml.js";

// ── 成员状态机（面板数据源）──
export * from "./roster.js";

// ── 轻量 turn 执行器（Lane B）──
export {
  SwarmMemberExecutor,
  SwarmModelError,
  SwarmMemberAbortedError,
  SwarmMemberFailedError,
  SWARM_MODEL_UNRESOLVED,
} from "./executor.js";
export type { SwarmExecutorDeps, SwarmLoopBindings, SwarmLoopFactory } from "./executor.js";

// ── agent_swarm 工具与插件装配（Lane B）──
// SWARM_TOOL_NAME 的唯一真源在 tool.ts；plugin.ts 只是 re-export，两处不得各写一份。
export {
  swarmTool,
  swarmToolSpec,
  SWARM_TOOL_NAME,
  SWARM_NESTED_TOOL_NAMES,
} from "./tool.js";
export type { SwarmToolDeps } from "./tool.js";
export { swarmPlugin } from "./plugin.js";
export type { SwarmPluginOptions } from "./plugin.js";
