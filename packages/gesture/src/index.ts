/**
 * `@celestea/gesture` —— `/` 手势的**唯一**识别与规范化实现（零依赖纯函数叶子包）。
 *
 * 为什么它不是 `packages/core` 的一个模块：core 顶层 import `node:fs` / `node:path`
 * （`celestea-sources.ts`、`skills.ts` 等），而 `apps/web` 不经过 `runtime`、是 Vite 打包的
 * 纯前端——前端一旦依赖 core，打包即炸（浏览器没有 node 内建模块）。`
 * docs/feature/composer-surface.md` §7 的「落地注意」原本写的就是「若 core 不干净，
 * 备选是把这一个纯函数放进极小的共享包」；这条备选已成为事实：本包就是那个共享包。
 *
 * 层级：core 级叶子（与 core 同层、零 `@celestea/*` 依赖、零 Node API）。core 与各 TIER1
 * 包都可以依赖它（`eslint.config.js` 的 `SHARED_LEAVES` / `.dependency-cruiser.cjs`
 * 的同名常量登记了这条边）。
 *
 * Module map:
 *   name-patterns.ts 三种 kind 的名字字符集（**唯一定义处**：SKILL_NAME_PATTERN 从 core 迁来）
 *   slash-gesture.ts parseSlashGesture / canonicalSlash
 */

export * from "./name-patterns.js";
export * from "./slash-gesture.js";
