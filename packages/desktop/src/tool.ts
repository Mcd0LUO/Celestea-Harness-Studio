/**
 * M1 的四个只读工具（规划 §3 的「只读 4」，写 9 个在 M2）。
 *
 * 两个设计决定，各有其代价，写在这里免得被后人「顺手优化」掉：
 *
 * 1. **spec 直读契约，不复制 schema。** `desktopToolSpec()` 是
 *    `loadTools().tools.find(...)`——contracts/tools.json 是唯一真源，所以
 *    GET /api/tools、模型提示词和这份实现永远说同一件事。契约里少一个条目就
 *    **抛错**（fail-closed，照 workerToolSpec() 的先例）：那说明契约与代码漂移了，
 *    挂一个静默失败的工具比不挂更糟。
 *
 * 2. **失败是结果不是异常。** helper 起不来、桌面被锁、窗口已经被关掉——这些是
 *    预期内的运行时状态，一律渲染成 `{ok:false, step, code, error}` 交给模型，
 *    它能据此改参数或改计划。抛异常只会让整个 turn 死掉，而模型看不到发生了什么。
 *
 * 参数形状**不**在这里二次校验：JSON Schema 由契约声明，registry 的分发链负责
 * 拒不合规的调用；本文件只负责把合规的调用翻译成一次 helper 往返。
 */

import { loadTools, type Tool, type ToolSpec } from "@celestea/core";
import { storeHelperImages } from "./attachments.js";
import type { DesktopHelperClient } from "./client.js";
import {
  DESKTOP_GET_WINDOW_STATE_TOOL,
  DESKTOP_GET_WINDOW_TOOL,
  DESKTOP_LIST_APPS_TOOL,
  DESKTOP_LIST_WINDOWS_TOOL,
  DESKTOP_TOOL_METHODS,
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
  /** 唯一的 helper 客户端（四个工具共用一个进程：这是「单例」的具体形态）。 */
  client: DesktopHelperClient;
  /**
   * 会话附件仓库（截图落点）。
   *
   * null/absent 是**允许**的：三个 list 工具不产出图片，没有仓库照样能跑；
   * get_window_state 会诚实地降级（见 attachments.ts）。这里不因缺仓库而拒绝挂载。
   */
  attachments?: DesktopAttachmentStore | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArgs(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** 目标应用 id：helper 的应用批准闸门按这个值查表，缺失就退化成 helper 自己解析。 */
function appOf(args: Record<string, unknown>): string | undefined {
  const window = args["window"];
  if (isRecord(window) && typeof window["app"] === "string" && window["app"].trim() !== "") return window["app"];
  if (typeof args["app"] === "string" && args["app"].trim() !== "") return args["app"];
  return undefined;
}

/** 工具层的统一失败信封（与 swarm/workers 同形）。 */
function failure(step: string, e: unknown): Record<string, unknown> {
  if (e instanceof DesktopError) return { ok: false, step, code: e.code, error: e.message, ...(Object.keys(e.detail).length === 0 ? {} : { detail: e.detail }) };
  return { ok: false, step, code: "tool_error", error: e instanceof Error ? e.message : String(e) };
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
      call(deps, DESKTOP_LIST_WINDOWS_TOOL, asArgs(args), (value) => {
        const windows = rowsOf(value, 'list_windows');
        return { ok: true, count: windows.length, windows };
      }),
  };

  const getWindow: Tool = {
    spec: () => desktopToolSpec(DESKTOP_GET_WINDOW_TOOL),
    execute: (args) =>
      call(deps, DESKTOP_GET_WINDOW_TOOL, asArgs(args), (value) => ({ ok: true, window: value ?? null })),
  };

  const listApps: Tool = {
    spec: () => desktopToolSpec(DESKTOP_LIST_APPS_TOOL),
    execute: (args) =>
      call(deps, DESKTOP_LIST_APPS_TOOL, asArgs(args), (value) => {
        const apps = rowsOf(value, 'list_apps');
        return { ok: true, count: apps.length, apps };
      }),
  };

  const getWindowState: Tool = {
    spec: () => desktopToolSpec(DESKTOP_GET_WINDOW_STATE_TOOL),
    execute: (args) =>
      call(deps, DESKTOP_GET_WINDOW_STATE_TOOL, asArgs(args), (value, attachments) => {
        const payload = isRecord(value) ? value : {};
        // value 顶层就是投影入口（core/src/projection.ts::toolResultOf 扫顶层
        // attachments），所以截图引用放这里、截图描述留在 screenshots 数组里。
        return { ok: true, window: payload["window"] ?? null, screenshots: payload["screenshots"] ?? [], accessibility: payload["accessibility"] ?? null, cacheDiagnostics: payload["cacheDiagnostics"] ?? null, attachments };
      }, deps.attachments),
  };

  return [listWindows, getWindow, listApps, getWindowState];
}

/** 一次 helper 往返的统一外壳：转发、附件桥、失败信封。 */
async function call(
  deps: DesktopToolDeps,
  toolName: string,
  args: Record<string, unknown>,
  shape: (value: unknown, attachments: readonly unknown[]) => Record<string, unknown>,
  store?: DesktopAttachmentStore | null,
): Promise<Record<string, unknown>> {
  const method = DESKTOP_TOOL_METHODS[toolName];
  if (method === undefined) throw new Error("no helper method is mapped for tool " + toolName);
  try {
    const result = await deps.client.callTool(method, args, appOf(args));
    const bridge = await storeHelperImages(result.images, store);
    return { ...shape(result.value, bridge.attachments), ...(bridge.notes.length === 0 ? {} : { notes: bridge.notes }) };
  } catch (e) {
    return failure(method, e);
  }
}
