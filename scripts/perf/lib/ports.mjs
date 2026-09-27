// ============================================================================
// scripts/perf/lib/ports.mjs — 侦测脚本的端口**统一走环境变量**（零依赖）
// ----------------------------------------------------------------------------
// 为什么需要它：`smoke.mjs` / `verify.mjs` / 5 个 `focus-*.mjs` / 4 个 `cases/q*.mjs`
// 各自把 `{ port: 3788, cdpPort: 9333 }` 写死在调用点。两个脚本同时跑（或上次的
// Chrome 还没退干净）就撞端口，而报错形态是"fetch 失败 / 连不上 CDP"，看不出是端口问题。
//
// 仓内**已有正确范例**：`w9113-p0.mjs` 的 `Number(process.env.W9113_PORT ?? 3788)`。
// 本模块把同一形状提取出来给其余脚本共用（`W9111_PORT` / `W9111_CDP_PORT`），
// **默认值逐字不变**（3788 / 9333）—— 于是"不设环境变量"时行为与改动前完全一致。
//
// 只认**正整数**：空串/NaN/0/负数/小数一律回落默认值。一个 `W9111_PORT=` 的空变量
// 不该让脚本去监听端口 0（那是"随机端口"，会让 CDP 端点的等待逻辑永远等不到）。
// ============================================================================

/** 环境变量覆盖的正整数解析；非法值回落 `fallback`（不抛错，不静默变 0）。 */
export function portFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** fixture 后端端口（默认 3788，与改动前逐字一致）。 */
export function backendPort() {
  return portFromEnv('W9111_PORT', 3788);
}

/** Chrome 远程调试端口（默认 9333，与改动前逐字一致）。 */
export function cdpPort() {
  return portFromEnv('W9111_CDP_PORT', 9333);
}
