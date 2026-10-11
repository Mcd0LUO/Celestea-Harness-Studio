/**
 * Desktop wiring — 只有 runtime 能做的那一半（与 swarm-wiring / worker-wiring 同层职责）。
 *
 * 本文件只做两件事，各有其硬理由：
 *
 * 1. **挂不挂在 mount 时静态判定，挂的时候不 spawn 任何进程**（规划 §5）。
 *    判定两条，缺一即不挂：
 *      - 平台是 win32（platform 是**形参注入**，先例 packages/tools/src/guard/write-deny-list.ts
 *        的「Platform is a PARAMETER」小节）；
 *      - helper 产物存在（helper/bin/win32-x64/celestea-desktop-helper.exe，由
 *        scripts/build-desktop-helper.mjs 写入，不进 git）。
 *    缺一不挂的理由是「必然失败的工具不如不挂」：挂上去的每个名字都会进 GET /api/tools
 *    与模型提示词，而模型点了只会拿到一句必然发生的错误。规划 §2 要消灭的正是这个
 *    「挂了但报错」的中间态。
 *
 * 2. **懒启动在 client.ts 里**：这里只构造客户端，第一次工具调用才 spawn + 握手。
 *    「静态检查决定挂不挂、懒启动决定跑不跑」两件事不矛盾——前者回答「这台机器上有没有
 *    这项能力」，后者回答「这一轮要不要真把它跑起来」。
 *
 * helper 路径为什么要拼而不是直接 import 包内常量：产物在**磁盘上**（构建产物、不进 git），
 * 所以要从本包根解析出仓库里那个路径。本文件从自身位置倒推包根（dist/../..），
 * 宿主也可以用 helperPath 覆盖。
 */

import { existsSync } from "node:fs";
import { TOOL_REGISTRY_SERVICE, mountPlugins, type Context, type ToolRegistry } from "@celestea/core";
import {
  DESKTOP_SUPPORTED_PLATFORM,
  DESKTOP_TOOL_NAMES,
  DesktopHelperClient,
  desktopPlugin,
  helperBinPath,
  type DesktopAttachmentStore,
  type DesktopGate,
  type DesktopTitleResolver,
} from "@celestea/computer-use";

// ── computer-use M2：把闸门的**宿主面向 surface** 从本模块转发出去 ──
//
// 为什么需要这一层转发：闸门由**宿主**（apps/studio）构造 —— 它才拿得到会话授权与
// 「问人」的通道 —— 而 apps/studio 的依赖表里没有 @celestea/computer-use（桌面能力的装配缝
// 在 packages/runtime，宿主从来只经 desktop-wiring 说话）。宿主直接 import
// @celestea/computer-use 会在 tsc 与 node 两侧都解析不到（那是个没有 symlink 的包），
// 而 runtime 本来就依赖它。
//
// 转发的是**构造闸门所需的最小集合**：两个工厂 + 原因码常量 + 端口类型。
// 工具面的东西（desktopTools / DesktopHelperClient）**不**在这里转发 —— 它们是
// @celestea/computer-use 自己的 surface，宿主不需要。
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
  DESKTOP_TITLE_UNRESOLVED_CODE,
} from "@celestea/computer-use";
export type {
  DesktopAppAccessList,
  DesktopAppScope,
  DesktopConfirmChannel,
  DesktopConfirmLimiter,
  DesktopConfirmOutcome,
  DesktopConfirmReason,
  DesktopConfirmRequest,
  DesktopDeadline,
  DesktopGate,
  DesktopGateCall,
  DesktopGateGrant,
  DesktopGateGrantSource,
  DesktopGateVerdict,
  DesktopTitleResolver,
} from "@celestea/computer-use";

const DEFAULT_DESKTOP_PLUGIN = 'celestea.runtime.desktop';

export interface DesktopWiring {
  /** false 不挂 desktop 工具面（缺省：静态检查通过就挂——总规划 D7「默认开」）。 */
  enabled?: boolean;
  /** 平台 id，**形参注入**（规划 §7）。缺省 process.platform 只在这一处发生。 */
  platform?: string;
  /** helper 可执行文件的绝对路径（宿主算好；缺省见 defaultHelperPath）。 */
  helperPath?: string;
  /** 会话附件仓库（截图落点）。缺省 = 诚实降级（get_window_state 不带图）。 */
  attachments?: DesktopAttachmentStore | null;
  /**
   * 写工具的分级闸门（M2）。缺席 = 写 9 一律拒绝（fail-closed），只读 4 不受影响。
   *
   * 为什么由宿主注入而不是本文件构造：闸门要读会话授权（grants）与应用级 scope，
   * 还要有一条问人的通道（进程级挂起问题表 + SSE 发布）——那些都在 apps/studio 一侧。
   * runtime 是装配层，拿不到也不该拿到它们（ARCHITECTURE §1 的分层）；它只负责把
   * 「有没有闸门」原样交给插件。
   *
   * 两种形态：已经建好的 `DesktopGate`，或 [DesktopGateFactory]（当会话的 apps scope
   * 里出现 titles 清单时**必须**用后者 —— 真实标题只能由本层解析，见 titleResolverOver）。
   */
  gate?: DesktopGate | DesktopGateFactory;
  /** 单次调用超时（缺省 20s，规划 §5）。 */
  timeoutMs?: number;
  /** Mount name (auto-named when omitted). */
  name?: string;
}

export interface DesktopHost {
  /** 挂上去的插件名（compose 的 pluginNamesOf 靠它记账）。 */
  mountedPlugin: string;
  /** 本次挂载注册进注册表的工具名（M1 四个）。 */
  toolNames: readonly string[];
  /** helper 客户端：宿主在引擎关闭时调 stop() 回收 helper 进程。 */
  client: DesktopHelperClient;
}

/** 静态检查的结果。两条都不满足就不挂——这是 M1「不挂空壳」纪律的落点。 */
export interface DesktopMountCheck {
  readonly ok: boolean;
  readonly platform: string;
  readonly helperPath: string;
  /** ok=false 时给日志/面板看的一句话（两个方向都能自解释）。 */
  readonly reason: string;
}

/**
 * 规划 §5 定死的 helper 产物路径。
 *
 * 委托给 **@celestea/computer-use 自己的 `helperBinPath()`**：那个包既拥有这个相对路径常量，
 * 又在 src/ 与 dist/ 两种布局下都能从自身位置算出同一个绝对路径（见 types.ts 的
 * 「反例」：从本文件这里数层数，两种布局都落到 packages/ 而不是 packages/computer-use/，
 * 会得到一个永远不存在的路径，于是工具面永远不挂且不报错）。宿主仍可用 helperPath 覆盖。
 */
export function defaultHelperPath(): string {
  return helperBinPath();
}

/**
 * 挂不挂的静态判定。**纯判定**：不 spawn、不握手、不改任何状态。
 *
 * existsSync 是这里唯一被允许的同步 I/O：它发生在 mount 期的装配路径上，一次会话一发；
 * 异步化只会让 compose 多一个 await 却换不到任何东西。exists 是形参，所以宿主与测试
 * 都能换掉它（不用在测试机上真的去构建 helper）。
 */
export function checkDesktopMount(options: DesktopMountCheckOptions = {}): DesktopMountCheck {
  const platform = options.platform ?? process.platform;
  const helperPath = options.helperPath ?? defaultHelperPath();
  const exists = options.exists ?? ((path: string) => existsSync(path));
  if (platform !== DESKTOP_SUPPORTED_PLATFORM) {
    return {
      ok: false,
      platform,
      helperPath,
      reason: `desktop tools need the ${DESKTOP_SUPPORTED_PLATFORM} helper; this host reports ${platform} (规划 §7: 非 win32 整个工具面缺席)`,
    };
  }
  if (!exists(helperPath)) {
    return {
      ok: false,
      platform,
      helperPath,
      reason: `the desktop helper is not built: ${helperPath} is absent. Build it with: node scripts/build-desktop-helper.mjs`,
    };
  }
  return { ok: true, platform, helperPath, reason: '' };
}

export interface DesktopMountCheckOptions {
  platform?: string;
  helperPath?: string;
  exists?: (path: string) => boolean;
}

/**
 * 解析并（可能）挂载 desktop 插件。不开 / 无注册表 / 静态检查不通过 → 返回 null。
 *
 * 与 swarm-wiring 同款的三道拒绝：开关关掉、注册表还没 mount、静态检查不通过。每一道
 * 都返回 null（什么都没挂），不是抛错——工具面缺席是一种合法状态（D7 默认开，但
 * 「没构建 helper」的用户看到的就是一个安静的缺席，而不是四个必然失败的名字）。
 */
/**
 * 闸门工厂（M2 审查修复④）：宿主把「建闸门」交出来，由**本层**把 `resolveTitle`
 * 交给它 —— 只有这里能建出真解析器（它需要 helper 客户端）。
 *
 * 与 `gate` 是同一个字段的两种形态：`DesktopGate` 是对象、本类型是函数，
 * `typeof === "function"` 即可判别。需要 titles 清单时宿主**必须**用这一种。
 */
export type DesktopGateFactory = (deps: { resolveTitle: DesktopTitleResolver }) => DesktopGate;

/**
 * helper 读侧的标题解析器。
 *
 * `desktop_get_window` 是**只读**方法（不需要授权，也不落任何状态），契约里它的参数是
 * 扁平的 `{id, app?}`、结果就是一条 window 记录。任何失败（helper 没起来、窗口已关、
 * 超时、协议错）都返回 `null` —— 闸门那边对「拿不到真实标题 + titles 清单非空」
 * 是 fail-closed 的，所以这里的兜底方向必须是 null 而不是空串或猜测值。
 */
function titleResolverOver(client: DesktopHelperClient): DesktopTitleResolver {
  return async ({ app, windowId }) => {
    try {
      const result = await client.callTool("get_window", { id: windowId, app });
      const value = result.value;
      if (typeof value !== "object" || value === null) return null;
      const title = (value as Record<string, unknown>)["title"];
      return typeof title === "string" ? title : null;
    } catch {
      return null;
    }
  };
}

export function ensureDesktopWiring(
  ctx: Context,
  wiring: DesktopWiring | false | undefined,
): DesktopHost | null {
  if (wiring === false || wiring?.enabled === false) return null;
  if (wiring === undefined) return null;
  const tools = ctx.get<ToolRegistry>(TOOL_REGISTRY_SERVICE);
  // 没有注册表 = tools 插件还没 mount，注册无处可去。返回 null 而不是半接线。
  if (tools === undefined) return null;
  const check = checkDesktopMount(wiring);
  if (!check.ok) {
    process.stderr.write(`[celestea-runtime] desktop tools not mounted: ${check.reason}\n`);
    return null;
  }
  const client = new DesktopHelperClient({
    helperPath: check.helperPath,
    platform: check.platform,
    ...(wiring.timeoutMs === undefined ? {} : { timeoutMs: wiring.timeoutMs }),
  });
  const name = wiring.name ?? DEFAULT_DESKTOP_PLUGIN;
  // M2 审查修复④：titles 清单的判定必须用 helper 侧的真实标题，而**本层是唯一持有
  // 客户端的地方** —— 所以解析器在这里建，通过工厂交给闸门（宿主自己建不出它）。
  const gate = typeof wiring.gate === "function" ? wiring.gate({ resolveTitle: titleResolverOver(client) }) : wiring.gate;
  mountPlugins(ctx, [
    desktopPlugin({
      client,
      attachments: wiring.attachments ?? null,
      ...(gate === undefined ? {} : { gate }),
      name,
    }),
  ]);
  // M2：注册面是十三个（只读 4 + 写 9）。写 9 在注册表里、由**闸门**在调用时放行，
  // 所以这里如实报十三个，而不是 M1 的四个。
  return { mountedPlugin: name, toolNames: DESKTOP_TOOL_NAMES, client };
}