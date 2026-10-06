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
  DESKTOP_M1_TOOL_NAMES,
  DESKTOP_SUPPORTED_PLATFORM,
  DesktopHelperClient,
  desktopPlugin,
  helperBinPath,
  type DesktopAttachmentStore,
} from "@celestea/desktop";

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
 * 委托给 **@celestea/desktop 自己的 `helperBinPath()`**：那个包既拥有这个相对路径常量，
 * 又在 src/ 与 dist/ 两种布局下都能从自身位置算出同一个绝对路径（见 types.ts 的
 * 「反例」：从本文件这里数层数，两种布局都落到 packages/ 而不是 packages/desktop/，
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
  mountPlugins(ctx, [desktopPlugin({ client, attachments: wiring.attachments ?? null, name })]);
  return { mountedPlugin: name, toolNames: DESKTOP_M1_TOOL_NAMES, client };
}