// ============================================================================
// scripts/perf/lib/repo-root.mjs — 从**本文件自身的位置**推导仓根（零依赖）
// ----------------------------------------------------------------------------
// 为什么需要它：`app.mjs` 的 `DEFAULT_REPO` 原来写死
// `C:/Users/lenovo/AppData/Local/Temp/perf-w9111/repo` —— 一个**只在作者那台 Windows
// 上存在**的临时目录。换一台机器（或 Linux）不设 `W9111_REPO` 就直接指向不存在的路径，
// 而失败发生在"静态服务器 404 → 页面里没有 .sess-pane"这种**下游**位置，很难看出根因。
//
// 推导规则（机械、可复核）：从 `import.meta.url` 所在目录起，逐级上溯，第一个含
// `package.json` 的目录即仓根。在 `<repo>/scripts/perf/lib/` 下 ⇒ 三次上溯即命中
// `<repo>/package.json`。找不到时返回 `null`（**不编造路径**），由调用方决定回落。
//
// 平台是参数，不是常量（AGENT.md §8）：路径运算全部走 `node:path`，Windows 上
// `C:\repo\scripts\perf\lib` 同样能上溯到 `C:\repo`。
// ============================================================================
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 从一个起点目录上溯，找第一个含 `package.json` 的目录。
 * @param {string} startDir 起点（绝对路径）
 * @returns {string|null} 仓根；到根仍找不到返回 `null`
 */
export function findRepoRoot(startDir) {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // 到文件系统根了
    dir = parent;
  }
}

/** 本文件所在目录（`<repo>/scripts/perf/lib`）。 */
export function moduleDir(importMetaUrl) {
  return dirname(fileURLToPath(importMetaUrl));
}

/**
 * 仓根：默认 = 从本模块位置推导；推导不出来返回 `null`。
 * @param {string} importMetaUrl 调用方的 `import.meta.url`
 */
export function repoRootFrom(importMetaUrl) {
  return findRepoRoot(moduleDir(importMetaUrl));
}
