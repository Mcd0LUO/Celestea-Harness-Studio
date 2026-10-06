/**
 * 十三个桌面工具（M1 只读 4 + M2 写 9，helper 的 window2 核心面）。
 *
 * 三个设计决定，各有其代价，写在这里免得被后人「顺手优化」掉：
 *
 * 1. **spec 直读契约，不复制 schema。** desktopToolSpec() 是
 *    loadTools().tools.find(...)——contracts/tools.json 是唯一真源，所以
 *    GET /api/tools、模型提示词和这份实现永远说同一件事。契约里少一个条目就
 *    **抛错**（fail-closed，照 workerToolSpec() 的先例）：那说明契约与代码漂移了，
 *    挂一个静默失败的工具比不挂更糟。
 *
 * 2. **失败是结果不是异常。** helper 起不来、桌面被锁、闸门拒绝、用户抢了鼠标——
 *    这些是预期内的运行时状态，一律渲染成 {ok:false, step, code, error} 交给模型，
 *    它能据此改参数或改计划。抛异常只会让整个 turn 死掉，而模型看不到发生了什么。
 *    闸门的拒绝码原样出现在 code 上，helper 的原句原样出现在 error 上。
 *
 * 3. **写 9 每一个都先过闸门，没有例外。** 只读 4 自动放行（规划 §4.1），写工具
 *    要查会话授权与应用级 scope，而授权语义只存在于 gate.ts 里。工具层**不得**自行
 *    给写方法预置应用批准——那正是本文件与 client.ts 一起守着的 fail-closed。
 *
 * 参数形状**不**在这里二次校验：JSON Schema 由契约声明，registry 的分发链负责
 * 拒不合规的调用；本文件只负责把合规的调用翻译成一次「闸门 + helper 往返」。
 */

import { loadTools, type Tool, type ToolSpec } from "@celestea/core";
import { storeHelperImages } from "./attachments.js";
import type { DesktopHelperClient, GateApproval } from "./client.js";
import { GATE_UNCONFIGURED_CODE, GATE_UNCONFIGURED_REASON, type DesktopGate, type DesktopGateVerdict } from "./gate.js";
import {
  DESKTOP_ACTIVATE_WINDOW_TOOL,
  DESKTOP_CLICK_TOOL,
  DESKTOP_DRAG_TOOL,
  DESKTOP_GET_WINDOW_STATE_TOOL,
  DESKTOP_GET_WINDOW_TOOL,
  DESKTOP_LAUNCH_APP_TOOL,
  DESKTOP_LIST_APPS_TOOL,
  DESKTOP_LIST_WINDOWS_TOOL,
  DESKTOP_PRESS_KEY_TOOL,
  DESKTOP_SCROLL_TOOL,
  DESKTOP_SECONDARY_ACTION_TOOL,
  DESKTOP_SET_VALUE_TOOL,
  DESKTOP_TOOL_METHODS,
  DESKTOP_TYPE_TEXT_TOOL,
  DesktopError,
  type DesktopAttachmentStore,
} from "./types.js";

/** spec 直读冻结契约（契约丢了它就抛）。 */
export function desktopToolSpec(name: string): ToolSpec {
  const found = loadTools().tools.find((t) => t.name === name);
  if (found === undefined) throw new Error("contracts/tools.json has no tool: " + name);
  return { name: found.name, description: found.description, parameters: found.parameters };
}

export interface DesktopToolDeps {
  /** 唯一的 helper 客户端（十三个工具共用一个进程：这是「单例」的具体形态）。 */
  client: DesktopHelperClient;
  /**
   * 写工具的分级闸门。
   *
   * absent = **没有闸门**，于是写工具一律拒绝（fail-closed），只读 4 不受影响。
   * 这个默认值不是「方便」：M2 的真实闸门由另一个子代理实现，在这之前写工具必须
   * 明确不可用，而不是「没人拦着所以放行」。只读面保持 M1 的行为不变。
   */
  gate?: DesktopGate;
  /**
   * 会话附件仓库（截图落点）。
   *
   * null/absent 是**允许**的：十个不产出图片的工具照样能跑；get_window_state 会
   * 诚实地降级（见 attachments.ts）。这里不因缺仓库而拒绝挂载。
   */
  attachments?: DesktopAttachmentStore | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArgs(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** 目标应用 id（只读预置用；写方法的批准只来自闸门判决）。 */
function appOf(args: Record<string, unknown>): string | undefined {
  const window = args["window"];
  if (isRecord(window) && typeof window["app"] === "string" && window["app"].trim() !== "") return window["app"];
  if (typeof args["app"] === "string" && args["app"].trim() !== "") return args["app"];
  return undefined;
}

function methodOf(toolName: string): string {
  const method = DESKTOP_TOOL_METHODS[toolName];
  if (method === undefined) throw new Error("no helper method is mapped for tool " + toolName);
  return method;
}

/** 工具层的统一失败信封（与 swarm/workers 同形）。 */
function failure(step: string, e: unknown): Record<string, unknown> {
  if (e instanceof DesktopError) return { ok: false, step, code: e.code, error: e.message, ...(Object.keys(e.detail).length === 0 ? {} : { detail: e.detail }) };
  return { ok: false, step, code: "tool_error", error: e instanceof Error ? e.message : String(e) };
}

/** 闸门拒绝的信封：**保留闸门自己的 code 与 reason**，不替换成自己的文案。 */
function gateRefusal(method: string, code: string, reason: string): Record<string, unknown> {
  return { ok: false, step: method, code, error: reason, source: "desktop_gate" };
}

/** 数组型 helper 结果（list_windows / list_apps）：形状不对就报协议错，不静默当空。 */
function rowsOf(value: unknown, method: string): unknown[] {
  if (!Array.isArray(value)) throw new DesktopError("protocol_error", `helper ${method} did not return an array`);
  return value;
}

export function desktopTools(deps: DesktopToolDeps): Tool[] {
  const listWindows: Tool = {
    spec: () => desktopToolSpec(DESKTOP_LIST_WINDOWS_TOOL),
    execute: (args) =>
      callReadOnly(deps, DESKTOP_LIST_WINDOWS_TOOL, asArgs(args), (value) => {
        const windows = rowsOf(value, 'list_windows');
        return { ok: true, count: windows.length, windows };
      }),
  };

  const getWindow: Tool = {
    spec: () => desktopToolSpec(DESKTOP_GET_WINDOW_TOOL),
    execute: (args) =>
      callReadOnly(deps, DESKTOP_GET_WINDOW_TOOL, asArgs(args), (value) => ({ ok: true, window: value ?? null })),
  };

  const listApps: Tool = {
    spec: () => desktopToolSpec(DESKTOP_LIST_APPS_TOOL),
    execute: (args) =>
      callReadOnly(deps, DESKTOP_LIST_APPS_TOOL, asArgs(args), (value) => {
        const apps = rowsOf(value, 'list_apps');
        return { ok: true, count: apps.length, apps };
      }),
  };

  const getWindowState: Tool = {
    spec: () => desktopToolSpec(DESKTOP_GET_WINDOW_STATE_TOOL),
    execute: (args) =>
      callReadOnly(deps, DESKTOP_GET_WINDOW_STATE_TOOL, asArgs(args), (value, attachments) => {
        const payload = isRecord(value) ? value : {};
        // value 顶层就是投影入口（core/src/projection.ts::toolResultOf 扫顶层
        // attachments），所以截图引用放这里、截图描述留在 screenshots 数组里。
        return { ok: true, window: payload["window"] ?? null, screenshots: payload["screenshots"] ?? [], accessibility: payload["accessibility"] ?? null, cacheDiagnostics: payload["cacheDiagnostics"] ?? null, attachments };
      }, deps.attachments),
  };

  // ── 写 9：每一个都先过闸门（M2）──
  // 写工具几乎都是 void 的：helper 的 tools::is_void 把它们的 value 变成 null，
  // 所以成功信封只报「做了什么」，真实状态要靠再读一次 get_window_state 拿——
  // 这一点写在这里，免得有人以为 value:null 意味着「桌面上现在有变化」。
  const writer =
    (toolName: string) =>
    (args: unknown): Promise<Record<string, unknown>> => callWrite(deps, toolName, asArgs(args));

  const click: Tool = { spec: () => desktopToolSpec(DESKTOP_CLICK_TOOL), execute: writer(DESKTOP_CLICK_TOOL) };
  const pressKey: Tool = { spec: () => desktopToolSpec(DESKTOP_PRESS_KEY_TOOL), execute: writer(DESKTOP_PRESS_KEY_TOOL) };
  const typeText: Tool = { spec: () => desktopToolSpec(DESKTOP_TYPE_TEXT_TOOL), execute: writer(DESKTOP_TYPE_TEXT_TOOL) };
  const scroll: Tool = { spec: () => desktopToolSpec(DESKTOP_SCROLL_TOOL), execute: writer(DESKTOP_SCROLL_TOOL) };
  const setValue: Tool = { spec: () => desktopToolSpec(DESKTOP_SET_VALUE_TOOL), execute: writer(DESKTOP_SET_VALUE_TOOL) };
  const drag: Tool = { spec: () => desktopToolSpec(DESKTOP_DRAG_TOOL), execute: writer(DESKTOP_DRAG_TOOL) };
  const secondaryAction: Tool = { spec: () => desktopToolSpec(DESKTOP_SECONDARY_ACTION_TOOL), execute: writer(DESKTOP_SECONDARY_ACTION_TOOL) };
  const activateWindow: Tool = { spec: () => desktopToolSpec(DESKTOP_ACTIVATE_WINDOW_TOOL), execute: writer(DESKTOP_ACTIVATE_WINDOW_TOOL) };
  const launchApp: Tool = { spec: () => desktopToolSpec(DESKTOP_LAUNCH_APP_TOOL), execute: writer(DESKTOP_LAUNCH_APP_TOOL) };

  return [listWindows, getWindow, listApps, getWindowState, click, pressKey, typeText, scroll, setValue, drag, secondaryAction, activateWindow, launchApp];
}

/** 只读四：自动放行（规划 §4.1），自备 M1 的应用预置。 */
async function callReadOnly(
  deps: DesktopToolDeps,
  toolName: string,
  args: Record<string, unknown>,
  shape: (value: unknown, attachments: readonly unknown[]) => Record<string, unknown>,
  store?: DesktopAttachmentStore | null,
): Promise<Record<string, unknown>> {
  const method = methodOf(toolName);
  try {
    const result = await deps.client.callTool(method, args, appOf(args));
    const bridge = await storeHelperImages(result.images, store);
    return { ...shape(result.value, bridge.attachments), ...(bridge.notes.length === 0 ? {} : { notes: bridge.notes }) };
  } catch (e) {
    return failure(method, e);
  }
}

/**
 * 写九：闸门 -> helper。**顺序是语义**——闸门是纯判定、不碰桌面，所以先跑它不会
 * 「批准了但没执行」；反过来则会出现「已经点下去了才被拒绝」。
 */
async function callWrite(deps: DesktopToolDeps, toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const method = methodOf(toolName);
  if (deps.gate === undefined) return gateRefusal(method, GATE_UNCONFIGURED_CODE, GATE_UNCONFIGURED_REASON);
  let verdict: DesktopGateVerdict;
  try {
    verdict = await deps.gate.check({ method, arguments: args });
  } catch (e) {
    // 闸门自己抛错 = 判定失败。按 deny 处理（fail-closed）：一个坏掉的闸门不许变成
    // 一个放行的闸门。
    return gateRefusal(method, "desktop_gate_failed", e instanceof Error ? e.message : String(e));
  }
  if (verdict.kind === "deny") return gateRefusal(method, verdict.code, verdict.reason);
  try {
    // 批准只来自闸门判决（带 via 标签），工具层不自行预置——client.ts 对裸字符串在
    // 写方法上 fail-closed。
    const approval: GateApproval | undefined =
      verdict.approvedApp === undefined || verdict.approvedApp === "" ? undefined : { via: "gate", app: verdict.approvedApp };
    const result = await deps.client.callTool(method, args, approval);
    // 写工具的截图（若有）同样进附件链——闸门放行不改变投影规则。
    const bridge = await storeHelperImages(result.images, deps.attachments);
    return {
      ok: true,
      method,
      // void 工具这里就是 null；非空时原样透传（helper 偶尔带诊断字段）。
      value: result.value ?? null,
      ...(bridge.attachments.length === 0 ? {} : { attachments: bridge.attachments }),
      ...(bridge.notes.length === 0 ? {} : { notes: bridge.notes }),
    };
  } catch (e) {
    // helper 的结构化错误原样透传（lease_violation、桌面被锁、批准被拒……）：
    // 它的原句就是模型需要看到的诊断，翻译它只会丢掉信息。
    return failure(method, e);
  }
}
