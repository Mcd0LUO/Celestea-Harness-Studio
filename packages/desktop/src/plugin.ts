/**
 * `@celestea/desktop` as a plugin — 把四个只读工具注册进宿主已挂载的 ToolRegistry。
 *
 * 形状照 packages/swarm/src/plugin.ts：解析宿主已经 provide 的 ToolRegistry，把工具
 * 注册进去；没有 registry 时**整件事不做**（返回），而不是注册到一个没人能调用的地方。
 *
 * **为什么在 mount 时注册。** 契约（contracts/tools.json）是 GET /api/tools 与模型
 * 提示词的唯一真源，而不在注册表里的工具两者都看不见。懒注册会让契约与提示词各说
 * 各话——所以工具在插件挂载那一刻就落进注册表。
 *
 * **挂载顺序是硬约束。** compose 把 tools 插件排在 desktop 之前（4e），所以这里
 * ctx.get(TOOL_REGISTRY_SERVICE) 一定拿得到；desktop-wiring 也在挂之前再查一次，
 * 不信任顺序（照 swarm-wiring 的同款防御）。
 *
 * 本插件**不持有** helper 进程：client 由装配根构造后注入（单例，四个工具共用），
 * 回收走 compose 的 shutdownHooks——core 的 Plugin 没有 unmount 原语，Context 也没有
 * effect，所以「挂载时登记一个 stop」是本仓唯一真实的回收 seam。
 */

import { definePlugin, TOOL_REGISTRY_SERVICE, type Plugin, type ToolRegistry } from "@celestea/core";
import { DESKTOP_CLIENT_SERVICE, type DesktopHelperClient } from "./client.js";
import { desktopTools, type DesktopToolDeps } from "./tool.js";
import type { DesktopGate } from "./gate.js";
import type { DesktopAttachmentStore } from "./types.js";

export interface DesktopPluginOptions {
  /** helper 客户端（单例；由装配根构造，所以它活过本插件的挂载期）。 */
  client: DesktopHelperClient;
  /** 会话附件仓库（截图落点；null = 诚实降级，不拒绝挂载）。 */
  attachments?: DesktopAttachmentStore | null;
  /**
   * 写工具的分级闸门（M2）。
   *
   * absent = 写工具一律拒绝（fail-closed），只读 4 不受影响。真实闸门由 M2 的另一个
   * 子代理实现并在这里注入；本包只声明形状。
   */
  gate?: DesktopGate;
  /** Mount name (auto-named when omitted). */
  name?: string;
}

export function desktopPlugin(opts: DesktopPluginOptions): Plugin {
  const name = opts.name ?? "celestea.desktop.Desktop";
  return definePlugin(name, (ctx) => {
    // 客户端 token 由提供它的模块自己声明（client.ts），与 WORKER_REGISTRY_SERVICE
    // / SWARM_REGISTRY_SERVICE 同一条规矩：core 只放 seam 级 token。
    ctx.provide(DESKTOP_CLIENT_SERVICE, opts.client);
    const tools = ctx.get<ToolRegistry>(TOOL_REGISTRY_SERVICE);
    if (tools === undefined) return;
    const deps: DesktopToolDeps = {
      client: opts.client,
      attachments: opts.attachments ?? null,
      ...(opts.gate === undefined ? {} : { gate: opts.gate }),
    };
    for (const tool of desktopTools(deps)) tools.register(tool);
  });
}