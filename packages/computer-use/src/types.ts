/**
 * `@celestea/computer-use` 的类型与冻结常量。
 *
 * 依赖方向：desktop -> core only（ARCHITECTURE §1 L1），与 packages/swarm 同层同形。
 * 驱动的 seam（ToolRegistry、AttachmentStore、子进程 spawn）全部由装配根
 * `packages/runtime` 注入，所以本包绝不横向 import 同层实现——这也意味着
 * `AttachmentStore` 只能以**结构化端口**出现在这里（见 `DesktopAttachmentStore`）。
 *
 * 本文件只放类型、常量与「本包自己算得出的路径」；协议在 client.ts，工具在 tool.ts。
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 契约里的四个只读工具名（contracts/tools.json · desktopDelta）。 */
export const DESKTOP_LIST_WINDOWS_TOOL = "desktop_list_windows";
export const DESKTOP_GET_WINDOW_TOOL = "desktop_get_window";
export const DESKTOP_LIST_APPS_TOOL = "desktop_list_apps";
export const DESKTOP_GET_WINDOW_STATE_TOOL = "desktop_get_window_state";

/** 写九工具的契约名（M2）。 */
export const DESKTOP_CLICK_TOOL = "desktop_click";
export const DESKTOP_PRESS_KEY_TOOL = "desktop_press_key";
export const DESKTOP_TYPE_TEXT_TOOL = "desktop_type_text";
export const DESKTOP_SCROLL_TOOL = "desktop_scroll";
export const DESKTOP_SET_VALUE_TOOL = "desktop_set_value";
export const DESKTOP_DRAG_TOOL = "desktop_drag";
export const DESKTOP_SECONDARY_ACTION_TOOL = "desktop_secondary_action";
export const DESKTOP_ACTIVATE_WINDOW_TOOL = "desktop_activate_window";
export const DESKTOP_LAUNCH_APP_TOOL = "desktop_launch_app";

/**
 * M1 的工具面：只读四个。
 *
 * 保留这个名字而不是就地改名：装配根与插件目录都按「M1 就只读四个」理解它，而它是
 * 规划与决策笔记里一个可引用的既有事实。写九个在下面单独列。
 */
export const DESKTOP_M1_TOOL_NAMES: readonly string[] = [
  DESKTOP_LIST_WINDOWS_TOOL,
  DESKTOP_GET_WINDOW_TOOL,
  DESKTOP_LIST_APPS_TOOL,
  DESKTOP_GET_WINDOW_STATE_TOOL,
];

/** M2 的写九工具。**每一个都必须先过闸门**（见 gate.ts）。 */
export const DESKTOP_WRITE_TOOL_NAMES: readonly string[] = [
  DESKTOP_CLICK_TOOL,
  DESKTOP_PRESS_KEY_TOOL,
  DESKTOP_TYPE_TEXT_TOOL,
  DESKTOP_SCROLL_TOOL,
  DESKTOP_SET_VALUE_TOOL,
  DESKTOP_DRAG_TOOL,
  DESKTOP_SECONDARY_ACTION_TOOL,
  DESKTOP_ACTIVATE_WINDOW_TOOL,
  DESKTOP_LAUNCH_APP_TOOL,
];

/** 全部十三个（M1 只读 4 + M2 写 9）。 */
export const DESKTOP_TOOL_NAMES: readonly string[] = [...DESKTOP_M1_TOOL_NAMES, ...DESKTOP_WRITE_TOOL_NAMES];

/**
 * helper 侧的对应方法名（helper/src/tools.rs 的 window2 工具表）。
 *
 * 工具名与 helper 方法名是**两套字符串**（一个带 desktop_ 前缀、契约用；一个不带、
 * helper 用），所以这张表是那张映射的**唯一真源**：tool.ts 按它转发，client.ts 按它
 * 认白名单。两处各写一份字面量的话，加一个工具漏改一处就会变成「注册了但调用
 * unsupported method」。
 */
export const DESKTOP_TOOL_METHODS: Readonly<Record<string, string>> = {
  [DESKTOP_LIST_WINDOWS_TOOL]: "list_windows",
  [DESKTOP_GET_WINDOW_TOOL]: "get_window",
  [DESKTOP_LIST_APPS_TOOL]: "list_apps",
  [DESKTOP_GET_WINDOW_STATE_TOOL]: "get_window_state",
  [DESKTOP_CLICK_TOOL]: "click",
  [DESKTOP_PRESS_KEY_TOOL]: "press_key",
  [DESKTOP_TYPE_TEXT_TOOL]: "type_text",
  [DESKTOP_SCROLL_TOOL]: "scroll",
  [DESKTOP_SET_VALUE_TOOL]: "set_value",
  [DESKTOP_DRAG_TOOL]: "drag",
  [DESKTOP_SECONDARY_ACTION_TOOL]: "perform_secondary_action",
  [DESKTOP_ACTIVATE_WINDOW_TOOL]: "activate_window",
  [DESKTOP_LAUNCH_APP_TOOL]: "launch_app",
};

/**
 * **M1 只读白名单**——也是「给 helper 预置应用批准」的唯一适用范围。
 *
 * 为什么需要它：helper 自己有一层应用批准闸门（helper/src/main.rs 的
 * `gate_and_dispatch` 查 `st.approved`，而 helper/src/tools.rs 的
 * `skip_approval` 只放行 list_windows / list_apps）。get_window / get_window_state
 * 不在放行名单里，所以 DSH 必须把目标应用带进请求 meta，否则只读面在真机上永远
 * 只会回一句 `Computer Use requires approval to use …`。
 *
 * 这**不是**授权机制，是一次单向传递：规划 §4.1 已经判定「只读 4 → allow」，
 * 这里只是把这个判定翻译成 helper 认识的形状。**M2 的写工具不得复用这条预置**——
 * 写侧授权由 gate.ts 的桌面能力位（grants `kind:'apps'` + per-call confirm）决定，
 * 那里才有真正的用户授权语义。把这份白名单扩大就是绕开那道闸门。
 */
export const READ_ONLY_METHODS: readonly string[] = [
  "list_windows",
  "list_apps",
  "get_window",
  "get_window_state",
];

/** 握手方法名（helper/src/main.rs：ping 刻意绕开 turn 中断 / 桌面锁 / 托管策略闸门）。 */
export const HELPER_HANDSHAKE_METHOD = "ping";

/** 请求 meta 里承载「本次已批准应用」的键（helper/src/protocol.rs 的 APPROVED_APP_META_KEY）。 */
export const HELPER_APPROVED_APP_META_KEY = "x-oai-cua-approved-app";

/** 请求 meta 里承载时间预算的键（helper/src/protocol.rs 的 BUDGET_HEADER）。 */
export const HELPER_BUDGET_META_KEY = "x-oai-cua-request-budget-ms";

/**
 * 单次调用的超时上限（规划 §5：20s，压 DSH 25s 的 turn 预算）。
 *
 * 超时**只杀这一次调用**、不杀 helper：helper 内可能正跑着一段 UI 线程动作，
 * 把它带走会让下一次调用重新握手（多一次 20s 风险），而本次调用已经超时无救。
 */
export const DESKTOP_CALL_TIMEOUT_MS = 20_000;

/** 握手自身的超时（比调用短：它只是 spawn + 三个字段）。 */
export const DESKTOP_HANDSHAKE_TIMEOUT_MS = 10_000;

/** 规划 §5 定死的 helper 产物路径（相对本包根；含 .exe 后缀）。 */
export const HELPER_BIN_RELATIVE_PATH = 'helper/bin/win32-x64/celestea-desktop-helper.exe';

/**
 * helper 产物的**绝对路径**。
 *
 * 为什么由本包算而不是由装配根（packages/runtime）算：本文件与编译产物分别住在
 * packages/computer-use/src/ 与 packages/computer-use/dist/，两者都恰好在**包根的正下方**，
 * 所以 `dirname(本文件) / ..` 在源码布局与发布布局下是同一个目录，路径不需要分支。
 *
 * 反例（踩过，记在这里）：从 packages/runtime 的模块位置往上数层数，src 布局与 dist
 * 布局层数相同却落在**不同**的目录（都指向 packages/ 而不是 packages/computer-use/），
 * 于是永远算出一个不存在的路径、4e 静态检查永远不通过、工具面永远不挂——而且不报错。
 * 让**拥有这个常量**的包自己算，是这里唯一不会算错的写法。
 *
 * 宿主仍可用 `helperPath` 覆盖（自定义构建位置）。
 */
export function helperBinPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', ...HELPER_BIN_RELATIVE_PATH.split('/'));
}

/** 本期唯一支持的平台（D3：Windows 先实现；features 字段是未来的跨平台开关）。 */
export const DESKTOP_SUPPORTED_PLATFORM = "win32";

/**
 * 失败原因码。**具名**而非裸字符串：调用方（工具层、面板、测试）要能区分
 * 「helper 起不来」（可重试/可提示先构建）与「helper 报错了」（该改调用参数）。
 */
export type DesktopErrorCode =
  | "unsupported_platform"
  | "helper_missing"
  | "spawn_failed"
  | "handshake_failed"
  | "helper_crashed"
  | "timeout"
  | "protocol_error"
  | "tool_error";

/** 结构化失败；工具层把它渲染成 `{ok:false, step, code, error}` 结果而不是抛异常。 */
export class DesktopError extends Error {
  readonly code: DesktopErrorCode;
  readonly detail: Record<string, unknown>;
  constructor(code: DesktopErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "DesktopError";
    this.code = code;
    this.detail = detail;
  }
}

/** helper 的握手信封（helper/src/main.rs::handshake）。 */
export interface HelperHandshake {
  version: string;
  platform: string;
  features: readonly string[];
}

/** helper 从工具结果里拆出来的截图（helper/src/images.rs 的 `{mimeType,data,name}`）。 */
export interface HelperImage {
  mimeType: string;
  /** base64（**无** data: 前缀——images.rs 已经把头切掉了）。 */
  data: string;
  name?: string;
}

/** 一次 helper 工具调用的结果。 */
export interface HelperCallResult {
  value: unknown;
  images: readonly HelperImage[];
}

/**
 * 会话附件仓库的**结构化端口**。
 *
 * 为什么在这里重新声明而不用 @celestea/tools 的 AttachmentStore：本包只依赖 core
 * （L1 不许横向依赖同层的 tools），而 AttachmentStore 住在 tools 里。结构化类型是
 * 装配根把真仓库塞进来的零成本方式——createAttachmentStore() 的返回值天然满足它。
 * 只取 `put`：desktop 只写不读，别的能力（readById / readDataUrl）用不上。
 */
export interface DesktopAttachmentStore {
  put(input: { bytes: Uint8Array; name?: string }): Promise<import("@celestea/core").ImageRef>;
}

/** helper 侧的窗口/应用记录（原样透传给模型，不在此处改形状）。 */
export interface HelperWindow {
  app?: string;
  id?: number | string;
  title?: string;
  [key: string]: unknown;
}

/** 客户端的可注入依赖（测试用假子进程驱动；生产走 node:child_process）。 */
export interface DesktopClientOptions {
  /** helper 可执行文件的绝对路径。 */
  helperPath: string;
  /**
   * 平台 id，**形参注入**（规划 §7；先例 packages/tools/src/platform/paths.ts）。
   *
   * 缺省值写在这里而不是散在各个分支点，是本仓已有的做法：整个仓库里
   * `process.platform` 的字面量只出现一次，而每个决策点都拿到显式的形参，
   * 所以 win32 分支在任何 CI 机器上都可被单测证明。
   */
  platform?: string;
  /** 单次调用超时（缺省 20s）。 */
  timeoutMs?: number;
  /** 握手超时（缺省 10s）。 */
  handshakeTimeoutMs?: number;
  /** 传给 helper 的环境变量（缺省透传 process.env）。 */
  env?: Record<string, string | undefined>;
  /** 进程创建 seam（测试注入假进程；缺省 node:child_process 的 spawn）。 */
  spawn?: DesktopSpawner;
  /** stderr 落点（缺省 process.stderr）。 */
  stderr?: { write(chunk: string): unknown };
}

/** 子进程创建 seam 的最小形状——只写 stdin、只读 stdout/stderr。 */
export interface DesktopChildProcess {
  readonly stdin: { write(chunk: string): unknown; end?(): unknown } | null;
  readonly stdout: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  readonly stderr: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  on(event: "error" | "exit" | "close", listener: (...args: unknown[]) => void): unknown;
  /**
   * 杀进程，**不带信号参数**。
   *
   * 收窄成零参是刻意的：node 的 `ChildProcess.kill(signal?: number | Signals)` 用
   * number|Signals 收信号，而一个 `(signal?: string)` 的端口类型与它**双向不兼容**
   * （方法参数是双变的，但 number|Signals 不是 string 的超集）——写成零参之后
   * node 的实现反而可赋值，因为可选参数可以被省略。本包只 kill 不发信号，
   * 所以这个窄化没有代价。
   */
  kill(): unknown;
  readonly pid?: number;
}

/** spawn 工厂签名。 */
export type DesktopSpawner = (command: string, args: readonly string[], options: { env: Record<string, string | undefined>; windowsHide: boolean }) => DesktopChildProcess;
