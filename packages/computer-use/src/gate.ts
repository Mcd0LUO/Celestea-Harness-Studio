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

/**
 * 只有「针对某个已存在窗口」的方法才有标题可查。
 *
 * `launch_app` 是启动一个新程序，**没有目标窗口**，所以 titles 清单对它不适用
 * （它的风险面在 exe/`app` 一侧，那里由前缀规范化 + deny/allow.exes 管）。
 */
export const DESKTOP_WINDOWLESS_METHODS: readonly string[] = ["launch_app"];

/** 一次确认的等待预算（规划 §4.2：超时 60s = deny，fail-closed）。 */
export const DESKTOP_CONFIRM_TIMEOUT_MS = 60_000;
/** 连续几次被拒进入冷却（照 grants-tokens.ts 的反疲劳先例）。 */
export const DESKTOP_DENIAL_THRESHOLD = 3;
/** 冷却时长（照 grants-tokens.ts::DENIAL_COOLDOWN_MS）。 */
export const DESKTOP_DENIAL_COOLDOWN_MS = 5 * 60_000;

export const DESKTOP_METHOD_UNKNOWN_CODE = "desktop_method_unknown";
export const DESKTOP_APP_DENIED_CODE = "desktop_app_denied";
export const DESKTOP_APP_UNRESOLVED_CODE = "desktop_app_unresolved";
export const DESKTOP_TITLE_UNRESOLVED_CODE = "desktop_title_unresolved";
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
 * （文案纪律见 apps/web/src/ui/grants.ts），闸门只提供事实。模型可控的字符串
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

/**
 * 人的裁决。
 *
 * `cancelled` 与「拒绝」分开（一个是被拒、一个是被取消），`timeout` 又与两者分开：
 * 传输自己也有一个同长的截止时间（这样 UI 能显示倒计时），它先到时必须如实报告
 * 「没人答」，而不是把空答案伪装成一次拒绝——那会让审计与模型都读错事实。
 */
export type DesktopConfirmOutcome = "approve" | "deny" | "cancelled" | "timeout";

/**
 * 确认通道：把一次请求交给人，等一个裁决。
 *
 * 契约是**resolve**：取消要 resolve("cancelled")，而不是 reject——reject 表示通道
 * 自己坏了（闸门按 fail-closed 处理成 desktop_confirm_failed）。
 */
export interface DesktopConfirmChannel {
  confirm(request: DesktopConfirmRequest): Promise<DesktopConfirmOutcome>;
}

/**
 * 「一个 work 与一个总超时赛跑」这件事的端口（M2-B，W2014 超时原语棘轮）。
 *
 * 为什么不直接 import `packages/tools` 的 `bounded`：`packages/computer-use` 只依赖 `core`
 * （ARCHITECTURE §1：L1 包之间不得横向依赖），而那个原语住在 `packages/tools`。直接
 * import 会在 tsc 与 node 两侧都解析不到（包下没有那条 symlink），还会在依赖图上多出
 * 一条 L1↔L1 边（要改三处登记 + 评审）。
 *
 * 所以这里声明**结构化端口**，形状就是 `bounded` 的 resolve 策略签名；宿主
 * （apps/studio，本来就依赖 tools）注入真身。于是全仓仍然只有**一处** race
 * （packages/tools/src/sandbox/async.ts），而闸门的超时语义一字未变。
 *
 * 它是**必填**的：少了它，闸门就失去「通道不守约也照样 fail-closed」那条兜底，
 * 而那正是这个端口存在的理由——让「忘了注入」在编译期就红，而不是在慢路径上静默挂死。
 */
export type DesktopDeadline = <T, R>(work: Promise<T>, timeoutMs: number, onTimeout: () => R) => Promise<T | R>;

/**
 * 解析目标窗口的**真实**标题（helper 读侧，只读调用不需要授权）。
 *
 * 为什么必须是 helper 侧：`window.title` 是模型可控的字符串，而 titles 清单是用户的
 * 策略 —— 拿被检查方给的字符串去比对用户的策略，等于让它自己写检查结果：省略它就能
 * 绕过 `deny.titles`，伪造它就能跳过 `allow.titles` 的逐次确认。
 *
 * 返回 `null` = 拿不到（窗口已关 / helper 报错 / 该窗口没有标题）。titles 清单非空时
 * 拿不到就是 **fail-closed**（见 [titleFor]）。
 */
export type DesktopTitleResolver = (target: { app: string; windowId: number }) => Promise<string | null>;

/** 反疲劳限流（照 grants-tokens.ts::GrantRateLimiter 的口径）。 */
export interface DesktopConfirmLimiter {
  /** 冷却剩余毫秒；0 = 不在冷却。 */
  cooldownRemainingMs(): number;
  /** 记一次裁决。只有**明确拒绝**计入阈值；批准清零；超时/取消不计。 */
  record(outcome: DesktopConfirmOutcome): void;
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
  /** 超时原语（宿主注入 `bounded`；见 [DesktopDeadline]）。**必填**：闸门不自己造 race。 */
  deadline: DesktopDeadline;
  /**
   * 真实标题的解析器（宿主注入，走 helper 读侧）。缺席 = 拿不到真实标题，于是
   * **titles 清单非空时一律 fail-closed**（见 [titleFor]）—— 这是刻意的：宁可拒绝，
   * 也不能拿模型给的标题去比对用户的策略。
   */
  titleResolver?: DesktopTitleResolver;
  /** 反疲劳限流器（宿主跨代复用；缺席 = 闸门自建一个）。 */
  limiter?: DesktopConfirmLimiter;
  /** 平台 id，**形参注入**（规划 §7）。只决定应用名/标题比较是否折叠大小写。 */
  platform?: string;
  /** 单次确认预算覆盖（缺省 60s）。 */
  timeoutMs?: number;
  now?: () => number;
}

/** 目标窗口（解析结果）。 */
interface GateTarget {
  /** 目标应用，**原始形态**（判定前由 [normalizeAppId] 规范化）。 */
  app: string;
  /** 目标窗口 id（有则可向 helper 取**真实**标题）。 */
  windowId?: number;
  /**
   * 模型声明的标题 —— **只作显示**，永不参与判定。
   *
   * 为什么不能参与判定：它是模型可控的字符串，而 titles 清单是用户的策略。信任它等于
   * 让被检查方自己写检查结果——省略它就绕过 deny.titles，伪造它就跳过 allow.titles 的
   * 逐次确认。真实标题只能问 helper（见 [DesktopTitleResolver]）。
   */
  claimedTitle?: string;
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
      // (b0) 标题：titles 清单非空时，判定只能用 **helper 侧的真实标题**。
      // 模型传的 window.title 从不参与判定（只作卡片显示），见 GateTarget.claimedTitle。
      const resolvedTitle = await titleFor(method, scope, target, opts.titleResolver);
      if (!resolvedTitle.ok) {
        return deny(
          DESKTOP_TITLE_UNRESOLVED_CODE,
          `this session restricts desktop apps by window TITLE, but the real title of the target window could not be read, so '${method}' on '${target.app}' cannot be checked and is refused. Re-read desktop_list_windows (or desktop_get_window) and pass the {app, id} pair of a window that is still open.`,
        );
      }
      const title = resolvedTitle.title;
      // (b) apps deny 在「有没有授权」之前判：清单是天花板，命中即拒（deny 永远赢）。
      const denied = matchList(scope.deny, target.app, title, platform);
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
      const reason = confirmReasonOf(method, scope, target.app, title, platform);
      if (reason !== null) {
        // 卡片上的标题：**解析到就用真实的那一个**（模型声明的只在没有解析时兜底显示）。
        const cardTitle = title ?? target.claimedTitle;
        return confirmOrDeny(
          channel,
          limiter,
          { method, app: target.app, ...(cardTitle === undefined ? {} : { title: cardTitle }), reason, timeoutMs },
          opts.deadline,
        );
      }
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
  deadline: DesktopDeadline,
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
  const outcome = await settle(channel, request, deadline);
  // 只有**真实裁决**进限流器：通道故障（failed）不是用户的选择，不该影响反疲劳计数。
  if (outcome !== "failed") limiter.record(outcome);
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
 *
 * W2014：这里的赛跑**不自己写**，交给注入的 [DesktopDeadline]（生产上是 tools 的
 * `bounded`）—— 全仓只留一处 race。计时器的清理、迟到的响应、以及「截止已到之后
 * 才落地的 rejection 不许冒成 unhandled rejection」都由那个原语统一处理；闸门只回答
 * 「超时了算什么」（= `timeout`，然后 fail-closed）。
 */
async function settle(
  channel: DesktopConfirmChannel,
  request: DesktopConfirmRequest,
  deadline: DesktopDeadline,
): Promise<DesktopConfirmOutcome | "failed" | "timeout"> {
  const asked = Promise.resolve()
    .then(() => channel.confirm(request))
    .then(
      (value): DesktopConfirmOutcome => value,
      (): "failed" => "failed",
    );
  return deadline(asked, Math.max(0, request.timeoutMs), () => "timeout" as const);
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
  const rawId = isRecord(window) ? window["id"] : undefined;
  const windowId = typeof rawId === "number" && Number.isInteger(rawId) ? rawId : undefined;
  const claimed = isRecord(window) && isText(window["title"]) ? window["title"].trim() : undefined;
  return {
    app,
    ...(windowId === undefined ? {} : { windowId }),
    ...(claimed === undefined ? {} : { claimedTitle: claimed }),
  };
}

/** 归一化 scope：allow 为空 = 不限制（规划 §4.3）。 */
function scopeOf(apps: DesktopAppScope | null | undefined): GateScope {
  const allow = apps?.allow ?? null;
  const deny = apps?.deny ?? null;
  return { allow, deny, allowRestricted: allow !== null && !isEmptyList(allow) };
}

/** 需要人确认的理由，或 null（= 直接放行）。 */
function confirmReasonOf(method: string, scope: GateScope, app: string, title: string | null, platform: string): DesktopConfirmReason | null {
  if (DESKTOP_SENSITIVE_METHODS.includes(method)) return "sensitive_method";
  if (scope.allowRestricted && matchList(scope.allow, app, title, platform) === null) return "app_not_allowlisted";
  return null;
}

/**
 * 命中的清单条目，或 null。deny 与 allow 共用同一套比较规则。
 *
 * `title` 是**已经解析过的真实标题**（或 null = 本次判定不涉及标题）；模型声明的标题
 * 从不进入这里 —— 见 [GateTarget.claimedTitle]。
 */
function matchList(list: DesktopAppAccessList | null, app: string, title: string | null, platform: string): string | null {
  if (list === null) return null;
  for (const entry of list.exes ?? []) {
    if (sameApp(entry, app, platform)) return entry;
  }
  if (title !== null) {
    for (const entry of list.titles ?? []) {
      if (fold(entry, platform) !== "" && fold(entry, platform) === fold(title, platform)) return entry;
    }
  }
  return null;
}

/** 这一侧清单里有没有 titles 条目（有 ⇒ 判定必须拿到真实标题）。 */
function hasTitleEntries(list: DesktopAppAccessList | null): boolean {
  return (list?.titles ?? []).some((entry) => isText(entry));
}

/**
 * 本次判定要用哪个标题。
 *
 * 三种结果：`title === null` = 不涉及标题（清单里没有 titles 条目，或方法没有目标窗口）；
 * `ok: false` = **需要标题但拿不到** ⇒ 调用方必须 fail-closed。
 *
 * 为什么拿不到就拒，而不是「退回用模型给的标题」或「升级为确认」：
 *   · 退回模型标题 = 把检查权交给被检查方，正是这条修复要堵的洞；
 *   · 升级为确认 = 让人的一次点击**代替一次没做成的检查**。若那个窗口真在 deny 清单上，
 *     确认就成了绕开「deny 永远赢」的通道；而且用户看到的应用名同样来自模型，
 *     他并没有能力替系统补上这次判定。
 * 所以：**拒绝**，并给一个能据此改计划的具名原因。
 *
 * 空标题也算拿不到：`WindowRef::to_json` 在标题为空时**不写这个键**，而模型完全可以
 * 去操作一个没有标题的窗口来制造「解析失败」——那条路必须同样被拒。
 */
async function titleFor(
  method: string,
  scope: GateScope,
  target: GateTarget,
  resolver: DesktopTitleResolver | undefined,
): Promise<{ ok: true; title: string | null } | { ok: false }> {
  if (!hasTitleEntries(scope.deny) && !hasTitleEntries(scope.allow)) return { ok: true, title: null };
  if (DESKTOP_WINDOWLESS_METHODS.includes(method)) return { ok: true, title: null };
  const windowId = target.windowId;
  if (resolver === undefined || windowId === undefined) return { ok: false };
  try {
    const resolved = await resolver({ app: target.app, windowId });
    return resolved === null || resolved.trim() === "" ? { ok: false } : { ok: true, title: resolved };
  } catch {
    return { ok: false };
  }
}

/**
 * helper 认得的**全部**标识符前缀（真源是 helper 源码，本表是它的逐字镜像）：
 *
 *   · `enum_windows.rs::APP_ID_PREFIXES` —— 5 个官方 AppIdentifier 前缀（CW-5）；
 *   · `app_catalog.rs::strip_known_prefixes` 额外认的 shell 命名空间形式
 *     `shell:AppsFolder\` / `shell:AppsFolder/`（`launch_app` 的 app 参数走这一支）。
 *
 * 为什么必须照抄而不是「大概剥一下」：模型传 `process:cmd.exe` 时，只做 basename 提取
 * 会得到 `process:cmd.exe`（没有分隔符），于是**绕过** `deny.exes` 里的 `cmd.exe` 条目，
 * 而 helper 剥掉前缀后**真的会去点/打字/启动那个 cmd**。少一个前缀就是一条绕过路径。
 * 漂移由 gate.test.ts 里那条「读 helper 源码逐个比对」的用例机械钉住。
 */
export const DESKTOP_APP_ID_PREFIXES: readonly string[] = [
  "process:",
  "path:",
  "registry:",
  "app-user-model-id:",
  "window-app:",
];
/** `app_catalog.rs::strip_known_prefixes` 在官方前缀之外额外认的两种写法（小写比较）。 */
export const DESKTOP_SHELL_APPSFOLDER_PREFIXES: readonly string[] = ["shell:appsfolder\\", "shell:appsfolder/"];

/**
 * 与 helper 同口径的标识符规范化：trim → 去引号 → 去已知前缀（大小写不敏感）→ trim → 去引号。
 *
 * 逐字镜像 `enum_windows.rs::strip_app_prefix` + `app_catalog.rs::strip_known_prefixes`：
 * 官方前缀取**第一个**命中的就停，shell 命名空间形式在其后单独判一次。
 */
export function normalizeAppId(raw: string): string {
  let value = stripQuotes(raw.trim());
  for (const prefix of DESKTOP_APP_ID_PREFIXES) {
    if (value.length >= prefix.length && value.slice(0, prefix.length).toLowerCase() === prefix) {
      value = stripQuotes(value.slice(prefix.length).trim());
      break;
    }
  }
  const lower = value.toLowerCase();
  for (const prefix of DESKTOP_SHELL_APPSFOLDER_PREFIXES) {
    if (lower.startsWith(prefix)) return tidyAppPath(stripQuotes(value.slice(prefix.length).trim()));
  }
  return tidyAppPath(value);
}

/**
 * Windows 语义的收尾清理。**helper 不做这一步，但闸门必须做** —— 因为 helper 那边
 * 「同一个程序」是内核解析出来的事实，而闸门这边只有字符串：
 *
 *   · **折叠重复分隔符**并把 `/` 归一到 `\`：`C:\\Windows\\notepad.exe` 与
 *     `C:/Windows/notepad.exe` 在 Win32 下是同一个文件，字符串比较看不出这一点；
 *   · **去掉每一段末尾的尾随点与空格**：Win32 解析路径时就会丢掉它们，所以
 *     `notepad.exe.` 与 `notepad.exe` 是同一个程序。不清理的话，模型用 `notepad.exe.`
 *     就能让 `deny.exes` 里的 `notepad.exe` 条目失效——这正是本轮要堵的那类绕过。
 *     `.` / `..` 两个目录段保持原样（否则相对路径会被拆掉）。
 *
 * **已知限制（不在此处解决）**：8.3 短名（`EXCEL~1.EXE`）与长名是同一个程序，但要
 * 认出这一点必须调 Win32（`GetLongPathName`），而闸门是**纯计算**、不碰系统。这条
 * 限制记在 docs/feature/computer-use/01-usage.md 的已知限制节。
 */
function tidyAppPath(value: string): string {
  return value
    .replace(/[\\/]+/g, "\\")
    .split("\\")
    .map((segment) => (segment === "." || segment === ".." ? segment : segment.replace(/[. ]+$/, "")))
    .join("\\");
}

/** Rust 的 `trim_matches('"')`：两侧的引号全部去掉，再 trim。 */
function stripQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "").trim();
}

/**
 * 应用比较：**与 helper 的 `app_identity_matches` 同口径**（CW-5）。
 *
 * 三步，顺序与 helper 一致：① 两侧都规范化后整串比；② 叶名（basename）比；
 * ③ 叶名那一档**只对裸名一侧生效** —— helper 的原话是「两个同名 exe 在不同目录里
 * 必须保持可区分，否则 get_window/activate_window 会认错应用」。
 *
 * 闸门必须与 helper 同口径，而不是「更宽松地按 basename 比」：更宽松会让 `allow.exes`
 * 里的 `C:\A\msedge.exe` 放行 `C:\B\msedge.exe`（那是**放宽**），而同口径既不会
 * 放过 deny，也不会把两个不同目录的同名程序混为一谈。
 */
function sameApp(entry: string, app: string, platform: string): boolean {
  const found = normalizeAppId(app);
  const expected = normalizeAppId(entry);
  if (found === "" || expected === "") return false;
  if (fold(found, platform) === fold(expected, platform)) return true;
  const foundBase = appBaseName(found);
  const expectedBase = appBaseName(expected);
  if (foundBase === "" || fold(foundBase, platform) !== fold(expectedBase, platform)) return false;
  return isBareApp(found) || isBareApp(expected);
}

/** 叶名：`\` 与 `/` 都当分隔符（helper 的 `app_base_name` 先把 `/` 换成 `\`）。 */
function appBaseName(value: string): string {
  const normalized = value.replace(/\//g, "\\");
  const cut = normalized.lastIndexOf("\\");
  return cut === -1 ? normalized : normalized.slice(cut + 1);
}

/** 裸名（不含任何路径分隔符）—— helper 的叶名兜底只对裸名一侧生效。 */
function isBareApp(value: string): boolean {
  return !value.includes("\\") && !value.includes("/");
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
