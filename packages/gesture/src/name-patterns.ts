/**
 * `/` 手势的**字符集表**——每种 kind 一张，一份实现（ARCHITECTURE.md §1.4 的
 * 「一张表 + 一份实现」，这里就是那张表）。
 *
 * **为什么单独一个模块、为什么放在这个包里**：
 *
 * - **唯一定义处**。`SKILL_NAME_PATTERN` 原本住在 `packages/core/src/skills.ts`，
 *   现在定义搬到这里，`skills.ts` 从本包导入后再导出（`@celestea/core` 的公开面
 *   一字不变）。同一个「技能名长什么样」若有两份正则，`SKILL.md` 目录名校验与
 *   `/` 手势解析就会各自演化 —— 那正是 `docs/feature/composer-surface.md` §7 要消灭的分叉。
 * - **本包零依赖**。core 顶层 import `node:fs` / `node:path`（`celestea-sources.ts` 等），
 *   前端 `apps/web` 一旦依赖 core，打包即炸（Vite 没有 node 内建模块）。所以手势解析
 *   必须住在**不碰任何 Node API** 的叶子里，而不是 core。
 * - 这三条字符集都是**语法**，不是**清单**：函数只判「长得像不像」，「是不是真技能 /
 *   真 server」由调用方拿各自的清单判断。
 */

/** 技能名：全小写字母、数字、连字符（与 `skills/<name>/` 的目录名同一形状）。 */
export const SKILL_NAME_PATTERN = /^[a-z0-9-]+$/;

/**
 * MCP server 名（`docs/feature/mcp-client.md` §4.1）。
 * 它要进工具名前缀，所以字符集比工具名更严：首字符必须字母或数字，长度 1–32。
 */
export const MCP_SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * 命令名：按 `apps/web/src/ui/commands/registry.ts` 的**现状**归纳——
 * 内置四条都是「小写单词 + 可选连字符」（run / goal / model / compact），
 * 注册表按名字精确匹配、不接受大写与下划线。
 */
export const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** 带前缀的两种 kind 各自的规范前缀（裸 token 属命令，无前缀）。 */
export const SLASH_PREFIXES = { skill: "/skill:", mcp: "/mcp:" } as const;
