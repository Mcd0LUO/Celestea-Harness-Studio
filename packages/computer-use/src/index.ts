/**
 * `@celestea/computer-use` — 桌面可见性能力的 TS 半边（规划 §2）。
 *
 * 职责：四个只读工具的 spec（直读契约）、helper 的 NDJSON stdio 客户端、截图经
 * AttachmentStore 落到工具结果顶层 attachments、以及 mount 时把工具注册进宿主
 * 注册表的插件装配。
 *
 * 执行体是**本仓自编译的 Rust helper**（packages/computer-use/helper，总规划 D6），
 * 协议真源是那份源码的 protocol.rs / main.rs / tools.rs ——不是任何第三方参考仓。
 *
 * 依赖方向：desktop -> core only（ARCHITECTURE §1 L1，与 packages/swarm 同层）。
 * 附件仓库、ToolRegistry、子进程 spawn 全部由装配根 packages/runtime 注入，所以
 * 本包不横向 import 任何同层实现。
 *
 * 本期是 M1：只读四个。写九个工具在 M2 才进来（闸门与它们一起进来）。
 *
 * Public API = this file。
 */

// ── 类型与冻结常量 ──
// helperBinPath 也从这里出：拥有该常量的包自己算路径（见 types.ts 的「反例」）。
export * from "./types.js";

// ── helper 客户端（协议）──
export { DESKTOP_CLIENT_SERVICE, DesktopHelperClient } from "./client.js";

// ── 截图桥 ──
export { helperImageBytes, storeHelperImages, type BridgeOutcome } from "./attachments.js";

// ── 分级闸门（M2 写工具的唯一放行通道）──
// 接口给 tool.ts 用；实现（createDesktopGate）与它的两个端口给宿主用：
// packages/runtime 注入闸门，apps/studio 提供授权源与确认通道。
export {
  createDesktopConfirmLimiter,
  createDesktopGate,
  denyAllGate,
  DESKTOP_APP_DENIED_CODE,
  DESKTOP_APP_UNRESOLVED_CODE,
  DESKTOP_CAP_NOT_GRANTED_CODE,
  DESKTOP_CONFIRM_CANCELLED_CODE,
  DESKTOP_CONFIRM_COOLDOWN_CODE,
  DESKTOP_CONFIRM_DENIED_CODE,
  DESKTOP_CONFIRM_FAILED_CODE,
  DESKTOP_CONFIRM_TIMEOUT_CODE,
  DESKTOP_CONFIRM_TIMEOUT_MS,
  DESKTOP_CONFIRM_UNAVAILABLE_CODE,
  DESKTOP_DENIAL_COOLDOWN_MS,
  DESKTOP_DENIAL_THRESHOLD,
  DESKTOP_APP_ID_PREFIXES,
  DESKTOP_METHOD_UNKNOWN_CODE,
  DESKTOP_READ_ONLY_METHODS,
  DESKTOP_SENSITIVE_METHODS,
  DESKTOP_SHELL_APPSFOLDER_PREFIXES,
  DESKTOP_TITLE_UNRESOLVED_CODE,
  DESKTOP_WINDOWLESS_METHODS,
  DESKTOP_WRITE_METHODS,
  normalizeAppId,
  GATE_UNCONFIGURED_CODE,
  GATE_UNCONFIGURED_REASON,
} from "./gate.js";
export type {
  DesktopAppAccessList,
  DesktopAppScope,
  DesktopConfirmChannel,
  DesktopConfirmLimiter,
  DesktopConfirmLimiterOptions,
  DesktopConfirmOutcome,
  DesktopConfirmReason,
  DesktopConfirmRequest,
  DesktopDeadline,
  DesktopGate,
  DesktopTitleResolver,
  DesktopGateAllow,
  DesktopGateCall,
  DesktopGateDeny,
  DesktopGateGrant,
  DesktopGateGrantSource,
  DesktopGateOptions,
  DesktopGateVerdict,
} from "./gate.js";

// ── 工具与插件装配 ──
export { desktopToolSpec, desktopTools, type DesktopToolDeps } from "./tool.js";
export { desktopPlugin, type DesktopPluginOptions } from "./plugin.js";