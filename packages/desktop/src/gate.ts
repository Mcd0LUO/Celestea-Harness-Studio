/**
 * 写工具的**分级闸门**（规划 §4）。
 *
 * 为什么它是接口而不是一段实现：本包只依赖 core，闸门要读 grants（会话授权）、
 * preset deny 表和应用级 scope，那些都在别的层（engine-grants / core 的 ToolGuard）。
 * 所以这里只声明**形状**，真实判定由另一个子代理实现，双方靠这一个接口对接——
 * 两边都不用知道对方的内部。
 *
 * 闸门是唯一能给写方法注入 helper 侧应用批准的通道（`approvedApp`）。工具层**不得**
 * 自行预置批准：只读 4 的预置是 M1 明确记录的例外（见 types.ts::READ_ONLY_METHODS），
 * 写 9 没有任何例外——授权语义（会话级能力位 + 敏感操作逐次确认）只存在于闸门里。
 *
 * ---------------------------------------------------------------------------
 * M2 实现（本文件下半部分）
 *
 * 判定顺序固定，**deny 永远赢**（规划 §4.4 的优先级：apps deny > 未授权 deny >
 * confirm > allow；preset / session 的按工具名 deny 不在本文件——它在
 * `packages/tools/src/plugin.ts` 的 `toolDenyGuard` 里，跑在 `ToolRegistryImpl.dispatch()`
 * 的「schema 校验之后、执行之前」，而本闸门在 `tool.execute` 内部，所以那两层命中时
 * 闸门**根本不会被调用**）：
 *
 *   a. 只读 4 → allow（不带 approvedApp：只读面不需要它）
 *   b. 目标应用命中 apps.deny → deny（在任何「有没有授权」之前判：清单是天花板）
 *   c. 会话没有 desktop 能力位 → deny + 授权指引
 *   d. 需要人确认 = 敏感集（type_text / set_value / launch_app）
 *      ∪（apps.allow 非空且未命中）→ 冷却中 deny，否则挂起等人答
 *   e. 以上全过 → allow，并把目标应用作为 approvedApp 交给 helper
 *
 * **fail-closed 是默认，不是分支**：闸门缺配置、目标应用解析不出来、确认通道缺席、
 * 通道抛错、超时——每一个都落到 deny。唯一会放行的是「判定明确通过」。
 *
 * **文案纪律**：本文件的字符串全部是**固定常量**，只把「目标应用名」当**数据**填进
 * 固定句式。绝不把工具参数里的任意文本当作句式的一部分（那是模型可控输入）。
 * 面向模型的 reason 用英文，与仓库里其它模型面文案（工具 description、guard reason）一致。
 */

export interface DesktopGateCall {
  /** helper 方法名（`click` / `type_text` / …），与 DESKTOP_TOOL_METHODS 的值同形。 */
  method: string;
  /** 原样透传的工具参数（目标应用在 `window.app` 或 `app` 里，由闸门自己解析）。 */
  arguments: Record<string, unknown>;
}

export interface DesktopGateAllow {
  kind: "allow";
  /**
   * 这次调用放行的目标应用，传给 helper 的应用批准闸门。
   *
   * 不填 = 交给 helper 自己解析（只读发现类方法不需要）。
   */
  approvedApp?: string;
}

export interface DesktopGateDeny {
  kind: "deny";
  /** 具名原因码（`desktop_gate_unconfigured` / `desktop_app_denied` / …）。 */
  code: string;
  /** 面向模型的一句话：它要能据此改计划，而不是只看到「被拒绝」。 */
  reason: string;
}

export type DesktopGateVerdict = DesktopGateAllow | DesktopGateDeny;

/** 闸门接口。`check` 必须是纯判定：不 spawn、不改桌面、不写状态。 */
export interface DesktopGate {
  check(call: DesktopGateCall): Promise<DesktopGateVerdict>;
}

/** 闸门缺席时写工具用的原因码。 */
export const GATE_UNCONFIGURED_CODE = "desktop_gate_unconfigured";
/** 闸门缺席时写工具用的原话（M2 集成前的诚实说明，不是「未知错误」）。 */
export const GATE_UNCONFIGURED_REASON = "desktop gate 尚未启用（M2 集成中）";

/**
 * 一个把一切都拒掉的闸门：**「桌面能力面整体没启用」**这一状态的唯一表示。
 *
 * 它存在的意义是 fail-closed 的可表达性——M2 的真实闸门接上之前，写工具要有一个
 * **明确**的拒绝者，而不是「没人拦着所以放行」。宿主可以用它把桌面写能力整体关掉，
 * 面板上也就有一个可读的状态（每个写调用都回同一句话），而不是四个工具名安静地
 * 挂在提示词里、点了才发现没人接。
 */
export function denyAllGate(): DesktopGate {
  return {
    check: () => Promise.resolve({ kind: "deny", code: GATE_UNCONFIGURED_CODE, reason: GATE_UNCONFIGURED_REASON }),
  };
}

// ===========================================================================
// M2：方法分类、原因码与等待预算
// ===========================================================================

/**
 * 只读 4（规划 §4.1：自动放行）。
 *
 * 与 types.ts::READ_ONLY_METHODS 是**同一个集合**，这里独立列一份而不是 import 它：
 * types.ts 的那份带着「给 helper 预置批准」的语义（M1 的例外），本文件这份只表达
 * 「闸门不管它」。两者将来若分叉，分叉点应当被看见（测试钉住这份表）。
 */
export const DESKTOP_READ_ONLY_METHODS: readonly string[] = [
  "list_windows",
  "get_window",
  "list_apps",
  "get_window_state",
];

/** 写 9（规划 §4.1 第 3 层）。这张表同时是「未知方法一律拒绝」的判据。 */
export const DESKTOP_WRITE_METHODS: readonly string[] = [
  "click",
  "press_key",
  "type_text",
  "scroll",
  "set_value",
  "drag",
  "perform_secondary_action",
  "activate_window",
  "launch_app",
];

/**
 * 敏感 3（规划 §4.2）：会话授权之上，**每次调用**都要人点一次。
 *
 * 为什么是这三个：type_text 能往任意焦点控件里打字（可能提交表单、可能发消息），
 * set_value 能直接改写控件值（绕过用户的手），launch_app 会在这台机器上起一个
 * 新进程——三者的后果都不是「看一眼」能撤销的。其余 6 个写动作在授权期内自动放行，
 * 因为它们的效果局限在用户已经看着的那个窗口里。
 */
export const DESKTOP_SENSITIVE_METHODS: readonly string[] = ["type_text", "set_value", "launch_app"];

/** 一次确认的等待预算（规划 §4.2：超时 60s = deny，fail-closed）。 */
export const DESKTOP_CONFIRM_TIMEOUT_MS = 60_000;
/** 连续几次被拒进入冷却（照 grants-tokens.ts 的反疲劳先例）。 */
export const DESKTOP_DENIAL_THRESHOLD = 3;
/** 冷却时长（照 grants-tokens.ts::DENIAL_COOLDOWN_MS）。 */
export const DESKTOP_DENIAL_COOLDOWN_MS = 5 * 60_000;

export const DESKTOP_METHOD_UNKNOWN_CODE = "desktop_method_unknown";
export const DESKTOP_APP_DENIED_CODE = "desktop_app_denied";
export const DESKTOP_APP_UNRESOLVED_CODE = "desktop_app_unresolved";
export const DESKTOP_CAP_NOT_GRANTED_CODE = "desktop_cap_not_granted";
export const DESKTOP_CONFIRM_DENIED_CODE = "desktop_confirm_denied";
export const DESKTOP_CONFIRM_TIMEOUT_CODE = "desktop_confirm_timeout";
export const DESKTOP_CONFIRM_CANCELLED_CODE = "desktop_confirm_cancelled";
export const DESKTOP_CONFIRM_COOLDOWN_CODE = "desktop_confirm_cooldown";
export const DESKTOP_CONFIRM_UNAVAILABLE_CODE = "desktop_confirm_unavailable";
export const DESKTOP_CONFIRM_FAILED_CODE = "desktop_confirm_failed";

// ===========================================================================
// M2：授权与应用级 scope（结构化端口；本包只依赖 core，不 import 宿主类型）
// ===========================================================================

/** 一份应用清单（grants `kind:'apps'` 的 allow 或 deny 一侧）。 */
export interface DesktopAppAccessList {
  /** 可执行文件名（裸名或全路径，按 basename 比较）。 */
  exes?: readonly string[];
  /** 窗口标题（与 window.title 精确比较，大小写按平台折叠）。 */
  titles?: readonly string[];
}

/**
 * 应用级 scope 的形状（规划 §4.3）。
 *
 * 形状抄官方 CU 的 `defaultAppAccess`（本机 `~/.dsh/computer-use/config.json`），
 * 但用 exes/titles 而不是 aumids：UIA/EnumWindows 只能稳定拿到进程名 + 窗口标题，
 * AUMID 需要 UWP 包解析，属额外复杂度（规划 §4.3 列为 future work）。
 */
export interface DesktopAppScope {
  allow?: DesktopAppAccessList | null;
  deny?: DesktopAppAccessList | null;
}

/** 闸门读到的授权快照（由宿主从 EffectiveGrants 映射过来）。 */
export interface DesktopGateGrant {
  /** 会话是否持有 desktop 能力位。 */
  desktop: boolean;
  /** 应用级 scope；缺席 = 不限制（规划 §4.3：allow 为空 = 不限制）。 */
  apps?: DesktopAppScope | null;
}

/**
 * 授权提供方。
 *
 * 为什么是**函数**而不是一份快照：闸门实例活一代（一次 compose = 一个 turn 边界），
 * 而「闸门读到哪一刻的授权」应当是宿主可以决定的——传快照就把这个决定焊死在构造点。
 * 宿主今天的实现是返回 compose 时刻读到的 EffectiveGrants（与 grants 既有的
 * 「在 turn 边界采样」语义一致），将来要改成每次调用现读也不必动本文件。
 */
export interface DesktopGateGrantSource {
  read(): DesktopGateGrant;
}

// ===========================================================================
// M2：确认通道与反疲劳限流
// ===========================================================================

/** 为什么要问人：敏感方法，或应用不在 allow 清单里。 */
export type DesktopConfirmReason = "sensitive_method" | "app_not_allowlisted";

/**
 * 一次确认请求。
 *
 * **刻意不带任何面向用户的文案**：确认卡上的每一句话都由宿主用**固定常量**拼出
 * （文案纪律见 apps/web/src/ui/grants.ts:11-14），闸门只提供事实。模型可控的字符串
 * （应用名、窗口标题）只能作为**数据**出现在宿主固定句式里。
 */
export interface DesktopConfirmRequest {
  /** helper 方法名。 */
  method: string;
  /** 解析出的目标应用（window.app，或 launch_app 的 app 本身）。 */
  app: string;
  /** 窗口标题（有就带上：deny/allow 的 titles 一侧要它）。 */
  title?: string;
  reason: DesktopConfirmReason;
  /** 本次等待预算（ms）：传输按它 park，闸门按它兜底超时。 */
  timeoutMs: number;
}

/** 人的裁决。`cancelled` 与「拒绝」分开：一个是被拒，一个是被取消。 */
export type DesktopConfirmOutcome = "approve" | "deny" | "cancelled";

/**
 * 确认通道：把一次请求交给人，等一个裁决。
 *
 * 契约是**resolve**：取消要 resolve("cancelled")，而不是 reject——reject 表示通道
 * 自己坏了（闸门按 fail-closed 处理成 desktop_confirm_failed）。
 */
export interface DesktopConfirmChannel {
  confirm(request: DesktopConfirmRequest): Promise<DesktopConfirmOutcome>;
}

/** 反疲劳限流（照 grants-tokens.ts::GrantRateLimiter 的口径）。 */
export interface DesktopConfirmLimiter {
  /** 冷却剩余毫秒；0 = 不在冷却。 */
  cooldownRemainingMs(): number;
  /** 记一次裁决。只有**明确拒绝**计入阈值；批准清零；超时/取消不计。 */
  record(outcome: DesktopConfirmOutcome | "timeout"): void;
}

export interface DesktopConfirmLimiterOptions {
  threshold?: number;
  cooldownMs?: number;
  now?: () => number;
}

/**
 * 建一个限流器。
 *
 * **生命周期是宿主的责任**：闸门实例活一代，而「连续 3 次拒绝」必须跨代累计，
 * 否则每个 turn 边界都会把计数清零、反疲劳形同虚设。所以宿主应当**按会话**建一个
 * 并跨代复用（apps/studio/src/runtime/desktop-gate-host.ts 就是这么做的）；
 * 不传 limiter 时闸门自建一个（单实例场景与测试用，跨代语义不成立）。
 */
export function createDesktopConfirmLimiter(opts: DesktopConfirmLimiterOptions = {}): DesktopConfirmLimiter {
  const threshold = opts.threshold ?? DESKTOP_DENIAL_THRESHOLD;
  const cooldownMs = opts.cooldownMs ?? DESKTOP_DENIAL_COOLDOWN_MS;
  const now = opts.now ?? Date.now;
  let denials = 0;
  let cooldownUntil = 0;
  return {
    cooldownRemainingMs: () => Math.max(0, cooldownUntil - now()),
    record: (outcome) => {
      if (outcome === "approve") {
        denials = 0;
        cooldownUntil = 0;
        return;
      }
      if (outcome !== "deny") return;
      denials += 1;
      if (denials >= threshold) {
        denials = 0;
        cooldownUntil = now() + cooldownMs;
      }
    },
  };
}

// ===========================================================================
// M2：闸门本体
// ===========================================================================

export interface DesktopGateOptions {
  /** 授权提供方（会话能力位 + 应用级 scope）。 */
  grants: DesktopGateGrantSource;
  /** 确认通道；缺席 = 需要确认的调用一律 deny（fail-closed）。 */
  confirm?: DesktopConfirmChannel | null;
  /** 反疲劳限流器（宿主跨代复用；缺席 = 闸门自建一个）。 */
  limiter?: DesktopConfirmLimiter;
  /** 平台 id，**形参注入**（规划 §7）。只决定应用名/标题比较是否折叠大小写。 */
  platform?: string;
  /** 单次确认预算覆盖（缺省 60s）。 */
  timeoutMs?: number;
  now?: () => number;
}

/** 目标应用（解析结果）。 */
interface GateTarget {
  app: string;
  title?: string;
}

/** 归一化后的应用 scope。 */
interface GateScope {
  deny: DesktopAppAccessList | null;
  allow: DesktopAppAccessList | null;
  /** allow 非空 = 白名单模式：未命中要升级确认（规划 §4.3）。 */
  allowRestricted: boolean;
}

/**
 * 真实闸门。
 *
 * 纯判定：不 spawn、不碰桌面、不写状态。唯一的外部副作用是「问人」，而那是**请求**
 * 的语义本身（等人答），不是判定过程中的状态变更。
 */
export function createDesktopGate(opts: DesktopGateOptions): DesktopGate {
  const now = opts.now ?? Date.now;
  const platform = opts.platform ?? process.platform;
  const timeoutMs = opts.timeoutMs ?? DESKTOP_CONFIRM_TIMEOUT_MS;
  const limiter = opts.limiter ?? createDesktopConfirmLimiter({ now });
  const channel = opts.confirm ?? null;

  return {
    check: async (call) => {
      const method = call.method;
      if (DESKTOP_READ_ONLY_METHODS.includes(method)) return { kind: "allow" };
      if (!DESKTOP_WRITE_METHODS.includes(method)) {
        return deny(DESKTOP_METHOD_UNKNOWN_CODE, `'${method}' is not a desktop method this gate knows; no desktop action was taken.`);
      }
      const target = targetOf(call.arguments);
      if (target === null) {
        return deny(
          DESKTOP_APP_UNRESOLVED_CODE,
          `the call carries no target application (expected window.app, or 'app' for launch_app), so the session's application scope cannot be checked and no helper-side approval can be produced. Re-read desktop_list_windows and pass the {app, id} pair.`,
        );
      }
      const grant = opts.grants.read();
      const scope = scopeOf(grant.apps);
      // (b) apps deny 在「有没有授权」之前判：清单是天花板，命中即拒（deny 永远赢）。
      const denied = matchList(scope.deny, target, platform);
      if (denied !== null) {
        return deny(
          DESKTOP_APP_DENIED_CODE,
          `'${target.app}' is on this session's desktop deny list (entry '${denied}'); desktop actions on it are refused before anything reaches the desktop. Use another application.`,
        );
      }
      // (c) 会话能力位。
      if (!grant.desktop) {
        return deny(
          DESKTOP_CAP_NOT_GRANTED_CODE,
          `this session holds no 'desktop' capability, so desktop write tools cannot run. Ask the user to grant the 'desktop' capability for this session (permissions panel), then retry.`,
        );
      }
      // (d) 需要人确认的两条理由。
      const reason = confirmReasonOf(method, scope, target, platform);
      if (reason !== null) return confirmOrDeny(channel, limiter, { method, ...target, reason, timeoutMs });
      // (e) 放行，并把目标应用交给 helper。
      return { kind: "allow", approvedApp: target.app };
    },
  };
}

/** 需要确认时走这里：冷却 → 通道 → 超时，每一条都 fail-closed。 */
async function confirmOrDeny(
  channel: DesktopConfirmChannel | null,
  limiter: DesktopConfirmLimiter,
  request: DesktopConfirmRequest,
): Promise<DesktopGateVerdict> {
  const cooling = limiter.cooldownRemainingMs();
  if (cooling > 0) {
    return deny(
      DESKTOP_CONFIRM_COOLDOWN_CODE,
      `desktop confirmations were declined too many times in a row; they are paused for another ${Math.ceil(cooling / 1000)}s. Wait, then retry once, or ask the user what they want.`,
    );
  }
  if (channel === null) {
    return deny(
      DESKTOP_CONFIRM_UNAVAILABLE_CODE,
      `this host has no confirmation channel, so '${request.method}' on '${request.app}' cannot be approved by a human and is refused.`,
    );
  }
  const outcome = await settle(channel, request);
  limiter.record(outcome);
  if (outcome === "approve") return { kind: "allow", approvedApp: request.app };
  if (outcome === "timeout") {
    return deny(
      DESKTOP_CONFIRM_TIMEOUT_CODE,
      `nobody answered the desktop confirmation within ${Math.round(request.timeoutMs / 1000)}s, so '${request.method}' on '${request.app}' was refused (fail-closed). Ask the user whether to proceed before retrying.`,
    );
  }
  if (outcome === "cancelled") {
    return deny(
      DESKTOP_CONFIRM_CANCELLED_CODE,
      `the desktop confirmation for '${request.method}' on '${request.app}' was cancelled before it was answered, so the action was refused.`,
    );
  }
  if (outcome === "failed") {
    return deny(
      DESKTOP_CONFIRM_FAILED_CODE,
      `the desktop confirmation channel failed, so '${request.method}' on '${request.app}' was refused.`,
    );
  }
  return deny(
    DESKTOP_CONFIRM_DENIED_CODE,
    `the user declined '${request.method}' on '${request.app}'. Do not retry it as-is; change the approach or ask the user what they want.`,
  );
}

/**
 * 等一次确认，**永不抛**、**永不挂死**。
 *
 * 双保险的理由：通道自己也会按 `timeoutMs` park（这样 UI 能显示倒计时），但闸门不能
 * 把「一个不守约的通道」当成「一个可以无限等的通道」——超时必须在闸门这一侧也是真的。
 * 通道抛错 = 通道坏了 = fail-closed，与「人拒绝」区分开（不同的 code）。
 */
async function settle(
  channel: DesktopConfirmChannel,
  request: DesktopConfirmRequest,
): Promise<DesktopConfirmOutcome | "timeout" | "failed"> {
  const asked = Promise.resolve()
    .then(() => channel.confirm(request))
    .then(
      (value): DesktopConfirmOutcome => value,
      (): "failed" => "failed",
    );
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(0, request.timeoutMs));
    timer.unref?.();
  });
  try {
    return await Promise.race([asked, deadline]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** 目标应用解析：`window.app` 优先，其次参数自带的 `app`（launch_app 无 window）。 */
function targetOf(args: Record<string, unknown>): GateTarget | null {
  const window = args["window"];
  const app =
    isRecord(window) && isText(window["app"])
      ? window["app"].trim()
      : isText(args["app"])
        ? args["app"].trim()
        : "";
  if (app === "") return null;
  const title = isRecord(window) && isText(window["title"]) ? window["title"].trim() : "";
  return title === "" ? { app } : { app, title };
}

/** 归一化 scope：allow 为空 = 不限制（规划 §4.3）。 */
function scopeOf(apps: DesktopAppScope | null | undefined): GateScope {
  const allow = apps?.allow ?? null;
  const deny = apps?.deny ?? null;
  return { allow, deny, allowRestricted: allow !== null && !isEmptyList(allow) };
}

/** 需要人确认的理由，或 null（= 直接放行）。 */
function confirmReasonOf(method: string, scope: GateScope, target: GateTarget, platform: string): DesktopConfirmReason | null {
  if (DESKTOP_SENSITIVE_METHODS.includes(method)) return "sensitive_method";
  if (scope.allowRestricted && matchList(scope.allow, target, platform) === null) return "app_not_allowlisted";
  return null;
}

/** 命中的清单条目，或 null。deny 与 allow 共用同一套比较规则。 */
function matchList(list: DesktopAppAccessList | null, target: GateTarget, platform: string): string | null {
  if (list === null) return null;
  for (const entry of list.exes ?? []) {
    if (sameExe(entry, target.app, platform)) return entry;
  }
  if (target.title !== undefined) {
    for (const entry of list.titles ?? []) {
      if (fold(entry, platform) !== "" && fold(entry, platform) === fold(target.title, platform)) return entry;
    }
  }
  return null;
}

/**
 * exe 比较：**裸名按 basename 比**，全路径按整串比（都折叠大小写）。
 *
 * 为什么按 basename：契约里 window.app 的说明是「可能是裸进程名，也可能是完整 exe 路径」，
 * 而用户在面板里多半填 `notepad.exe`。只比整串会让 `C:\Windows\System32\notepad.exe`
 * 逃过 `notepad.exe` 这条 deny——对 deny 清单来说那是一个可绕过的规则。
 */
function sameExe(entry: string, app: string, platform: string): boolean {
  const left = fold(entry, platform);
  const right = fold(app, platform);
  if (left === "" || right === "") return false;
  if (left === right) return true;
  return basename(left) === basename(right);
}

/** 最后一个路径分隔符之后的部分（两种分隔符都认：清单可能由 Windows 用户手写）。 */
function basename(value: string): string {
  const cut = Math.max(value.lastIndexOf("\\"), value.lastIndexOf("/"));
  return cut === -1 ? value : value.slice(cut + 1);
}

/**
 * 大小写折叠**只按平台**：Windows 路径与进程名不区分大小写，POSIX 区分
 * （照 engine-grants.ts::samePath 的同一条理由——在那里折叠错了会「拒绝错的、放过错的」）。
 */
function fold(value: string, platform: string): string {
  const trimmed = value.trim();
  return platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function isEmptyList(list: DesktopAppAccessList): boolean {
  return (list.exes ?? []).every((e) => !isText(e)) && (list.titles ?? []).every((e) => !isText(e));
}

function deny(code: string, reason: string): DesktopGateDeny {
  return { kind: "deny", code, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
