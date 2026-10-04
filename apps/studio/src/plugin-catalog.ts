/**
 * 插件热插拔：**两层装配清单**（`docs/feature-plugin-hotswap.md` §2/§3.2/§5）。
 *
 * 为什么需要这个文件。W860 的 `GET /api/plugins` 只列 host 启动层的 8 个注入 token
 * （`apps/studio/src/plugins.ts` 的 `storePlugins` + `hostPlugins`），真正的功能插件
 * 在引擎层，被 `plugins.ts` 的边界注释**刻意排除**。于是设置页的「插件」一格只显示
 * `studio/workspaces` 这类服务 token，用户认得出的功能（工具、worker、swarm、watchdog）
 * 一个都不在里面。本模块把两层合成一张清单，并逐行给出真实的 `hot` 与停用策略。
 *
 * ## 一行为什么是「必须存在」而不是「可以被删掉」
 *
 * 清单里的每个名字都必须对应一次**真实的装配**：
 *   - host 层：`storePlugins()` / `hostPlugins()` 的 `definePlugin` 名字；
 *   - 引擎层：`compose()`（`packages/runtime/src/compose.ts`）在一次会话装配里真正
 *     mount 的插件名。
 *
 * `plugin-inventory.test.ts` 用一条**反漂移**断言把这件事钉死：它装配一个真实会话，
 * 把 `Runtime.pluginNames` 与引擎层的行逐一对比。清单里多一行、少一行、或者引擎换了
 * 名字而清单没跟着换，那条用例立刻变红——所以这里不是第二份「手抄的常量」。
 *
 * ## `hot` 与 `disable` 是两件事（§3.2）
 *
 * `hot` 回答「这一行是不是按代重新装配的」。当前**每一行都是 `hot: true`**：host store
 * 层与引擎层都遵循「换代而不是卸载」（`Context` 没有移除原语，`Plugin` 没有 unmount，
 * 所以唯一安全的做法是按 mount 顺序在新 Context 里重建整代、再原子替换引用）。
 * 按 §3.2 的原话，`hot: false` **留给真正不可换的项**，当前为空——所以这个字段不再
 * 硬编码为 `false`，而是逐行如实。
 *
 * `disable` 回答「这一行能不能被用户关掉」，以及关掉需要什么前提：
 *   - `"optional"`  —— 可以随时关，下一 turn 边界生效；
 *   - `"idle-only"` —— 只有**没有活跃会话**时才能换（`studio/bus` 是所有 SSE 的连接点）；
 *   - `"required"`  —— 不能关（关掉它，`compose()` / 提示词装配会直接失败）。
 *
 * 把两者分开是**诚实**的要求：`studio/workspaces` 的 `hot` 确实是 `true`（换代机制
 * 对它成立），但它的 `disable` 是 `"required"`（`studio/sessions` 在 mount 里
 * `ctx.require(WORKSPACES_SERVICE)` 并把结果捕获进 `new SessionsStore(...)`，抽掉它
 * 整个 host 装配就起不来）。一个把 `hot: false` 当成「不可换」的客户端会得到错误结论，
 * 所以客户端要看 `required`，不要从 `hot` 反推。
 */

import { WATCHDOG_PLUGIN_NAME } from "@celestea/runtime";

/** 一层。`"host"` = 启动层注入 token；`"engine"` = 每会话由引擎装配的功能插件。 */
export type PluginLayer = "host" | "engine";

/** 一行的停用策略（见文件头：`hot` 与 `disable` 是两件事）。 */
export type PluginDisable = "optional" | "idle-only" | "required";

export interface PluginCatalogRow {
  name: string;
  layer: PluginLayer;
  /** 这一行是否按代重新装配（当前恒为 `true`；见文件头）。 */
  hot: boolean;
  /** 能否关掉、以及关掉的前提。 */
  disable: PluginDisable;
  /** `disable !== "optional"` 时，**必须**给出原因——拒绝必须说出来。 */
  reason?: string;
  /**
   * W9331：**这一行默认开不开**。缺省 `true`（与 W9322 的产品语义一致：清单里
   * 新加的插件默认是开的）。
   *
   * 它存在的**唯一**理由是 `celestea.runtime.swarm`：停用表只存 disabled，所以
   * 「不在表里」同时意味着「默认开」——一行改成默认关之后，「用户打开了它」就
   * 在停用表里**没有表示法**（见 `store/plugins.ts` 的文件头）。这个字段加上
   * store 的 `enabled` 数组，缺口才补上。
   *
   * **唯一真源就是这张目录**，不是散落在别处的常量：`PluginSwitch` 合成有效停用
   * 集合时只读这里，所以一行默认开不开只需要改这一处。
   */
  defaultEnabled?: boolean;
}

/**
 * 引擎层插件的装配名字。**顺序 = mount 顺序**（mount 顺序是语义，见
 * `ARCHITECTURE.md` §3.2 / `docs/feature-plugin-hotswap.md` §7）。
 *
 * 这些字符串是 `compose()` 真正用的名字，不是在这里发明的——`plugin-inventory.test.ts`
 * 会装配一个真实会话并把 `Runtime.pluginNames` 与这张表逐一对比，所以「我以为它叫
 * 什么」永远不会变成事实（本条注释的第一版就把工具插件写成了 `celestea.tools`，
 * 而它其实叫 `studio.engine.tools`——是那条断言当场抓出来的）：
 *   - `studio.engine.llm`            —— `enginePlugins()` -> `engineLlmPlugin()` 的默认名
 *   - `studio.engine.agent-loop`     —— `engineLoopPlugin()` 的默认名
 *   - `studio.engine.tools`          —— `engineTools()` 里 `definePlugin` 的字面名
 *   - `celestea.runtime.workers`     —— `worker-wiring.ts` 的 `DEFAULT_WORKER_PLUGIN`
 *   - `celestea.runtime.swarm`       —— `swarm-wiring.ts` 的 `DEFAULT_SWARM_PLUGIN`
 *   - `celestea.runtime.watchdog`    —— `WATCHDOG_PLUGIN_NAME`
 *
 * `TOOLS_PLUGIN_NAME`（`packages/tools` 的 `toolsPlugin()`）**不是**这里的一员：
 * studio 装配的是它自己的 `engineTools()` 包装（`studio.engine.tools`），
 * 因为只有它知道 session 的 workspace / grants / disclosure。两者的**工具面**是
 * 同一个 `assembleTools()`，所以「关掉工具插件」的语义完全相同。
 */

/** 引擎层的名字常量（`enginePluginSwitchesOf` 与 `ENGINE_PLUGIN_NAMES` 用）。 */
export const ENGINE_TOOLS_PLUGIN = "studio.engine.tools";
export const ENGINE_WORKERS_PLUGIN = "celestea.runtime.workers";
export const ENGINE_SWARM_PLUGIN = "celestea.runtime.swarm";
/** W9331: the degenerate-repetition guard, mounted by `compose()`. */
export const ENGINE_REPEAT_GUARD_PLUGIN = "celestea.runtime.repeat-guard";
export const ENGINE_WATCHDOG_PLUGIN = WATCHDOG_PLUGIN_NAME;

export const ENGINE_PLUGIN_NAMES: readonly string[] = [
  "studio.engine.llm",
  "studio.engine.agent-loop",
  ENGINE_TOOLS_PLUGIN,
  ENGINE_WORKERS_PLUGIN,
  ENGINE_SWARM_PLUGIN,
  ENGINE_REPEAT_GUARD_PLUGIN,
  ENGINE_WATCHDOG_PLUGIN,
];

/**
 * 引擎层的**装配开关**：`SessionComposerOptions.pluginSwitches` 的形状。
 *
 * 为什么这个类型住在这里（而不是 host 的 `plugin-hotswap.ts`）：`apps/studio/src/runtime/`
 * 是装配层，`plugin-hotswap.ts` 要 import 它，反向 import 会成环。这个模块只依赖
 * `@celestea/runtime` 与 `@celestea/tools` 两个包，是这条依赖链的叶子。
 */
export interface EnginePluginSwitches {
  /** 不再 mount `celestea.tools`（工具注册表 / sandbox / 进程表一起消失）。 */
  tools: boolean;
  /** `compose({ workers: false })`。 */
  workers: boolean;
  /** `compose({ swarm: false })`。 */
  swarm: boolean;
  /** `compose({ repeatGuard: false })` —— W9331 的重复崩塌守卫。 */
  repeatGuard: boolean;
  /** `compose({ watchdog: false })`。 */
  watchdog: boolean;
}

/**
 * 引擎层的停用集合 -> 装配开关。
 *
 * 每个引擎插件名对应一个**具体的装配开关**，这就是「关掉一个插件」的全部含义：
 *   - `celestea.tools`            -> `enginePlugins()` 不再 mount 工具插件，
 *                                    于是 `TOOL_REGISTRY_SERVICE` 缺失，`GET /api/tools`
 *                                    与提示词的 `{{tools}}` 同时变空；
 *   - `celestea.runtime.workers`  -> `workers: false`，三个 worker 工具不注册；
 *   - `celestea.runtime.swarm`    -> `swarm: false`，`agent_swarm` 不注册；
 *   - `celestea.runtime.repeat-guard` -> `repeatGuard: false`，在线崩塌检测不装配；
 *   - `celestea.runtime.watchdog` -> `watchdog: false`，不 mount 存活巡检。
 *
 * `studio.engine.llm` / `studio.engine.agent-loop` 不在这里：它们是 `required`，
 * 调用方必须先经过 `required` 过滤（`plugin-hotswap.ts` 的 `engineDisabledOf`）。
 */
export function enginePluginSwitchesOf(disabled: readonly string[]): EnginePluginSwitches {
  const off = new Set(disabled);
  return {
    tools: off.has(ENGINE_TOOLS_PLUGIN),
    workers: off.has(ENGINE_WORKERS_PLUGIN),
    swarm: off.has(ENGINE_SWARM_PLUGIN),
    repeatGuard: off.has(ENGINE_REPEAT_GUARD_PLUGIN),
    watchdog: off.has(ENGINE_WATCHDOG_PLUGIN),
  };
}

/** host store 层 + host 单例的停用策略（`plugins.ts` 的 `storePlugins`/`hostPlugins`）。 */
const HOST_POLICY: Readonly<Record<string, { disable: PluginDisable; reason?: string }>> = {
  // 五个 store：全部 required。它们互相 `ctx.require`，而且每个都被
  // `composeStudio` 的返回值 / 处理器直接持有，抽掉任何一个都不是「少一个功能」，
  // 而是「整个 host 起不来」。
  "studio/workspaces": {
    disable: "required",
    reason:
      "studio/sessions mounts on ctx.require(WORKSPACES_SERVICE) and captures it into `new SessionsStore(...)`, and the composed services expose the store directly: without it the host composition cannot be built",
  },
  "studio/sessions": {
    disable: "required",
    reason:
      "studio/session-ops consumes it and the composed services expose it; every /api/sessions route resolves through it",
  },
  "studio/session-ops": {
    disable: "required",
    reason: "the rename/branch/archive/trash routes are bound to this exact instance",
  },
  "studio/providers": {
    disable: "required",
    reason: "the startup engine profile and every /api/providers route are resolved from this store",
  },
  "studio/prompts": {
    disable: "required",
    reason: "the system prompt of every session is assembled from this registry",
  },
  // bus / runtime：可以换，但只在没有活跃会话时（§3.2）。
  "studio/bus": {
    disable: "idle-only",
    reason: "studio/bus is the connection point of every SSE stream",
  },
  "studio/runtime": {
    disable: "idle-only",
    reason: "studio/runtime is the engine seam every live session instance was composed against",
  },
  // settings：处理器直接调用它的方法（`deps.settings.systemPromptOverride()`），
  // 抽掉它 `assembleSystemPromptFor` 会抛。
  "studio/settings": {
    disable: "required",
    reason:
      "the prompt and base_url assembly read this instance on every request (deps.settings.systemPromptOverride()); removing it makes assembleSystemPromptFor throw",
  },
};

/** 一行策略里除 `disable` 之外的附加位；`defaultEnabled` 见 `PluginCatalogRow`。 */
interface RowPolicyExtra {
  /** 见 `PluginCatalogRow.defaultEnabled`——**只有写 false 的行才改默认行为**。 */
  defaultEnabled?: boolean;
}

/** 引擎层：三个真的能关（工具 / worker / swarm / repeat-guard / watchdog），两个 compose 必需。 */
const ENGINE_POLICY: Readonly<Record<string, { disable: PluginDisable; reason?: string } & RowPolicyExtra>> = {
  "studio.engine.llm": {
    disable: "required",
    reason:
      "compose() resolves LLM_SERVICE as a seam: without it the worker driver and the swarm member turns have no model, and the session prompt assembly would advertise tools nothing can call",
  },
  "studio.engine.agent-loop": {
    disable: "required",
    reason: "compose() throws ComposeError('no AgentLoop') when no plugin provides AGENT_LOOP_SERVICE",
  },
  [ENGINE_TOOLS_PLUGIN]: { disable: "optional" },
  [ENGINE_WORKERS_PLUGIN]: { disable: "optional" },
  // W9331：swarm **默认关**。它是一个编排能力（批量子代理），不是保护；默认打开
  // 会让每个新会话都带上一个用户从没要求过的委派面。`defaultEnabled: false` 是
  // 「默认关」这件事的**唯一**表示——它必须住在这张目录里，因为停用表无法表达它
  // （`store/plugins.ts` 的文件头解释了那个缺口）。
  //
  // 用户仍可打开：`disable: "optional"` 没变，打开它只需要往 `plugins.json` 的
  // `enabled` 里写一行（`PluginSwitch.enabledDisabled` 合成）。
  [ENGINE_SWARM_PLUGIN]: { disable: "optional", defaultEnabled: false },
  // W9331：重复崩塌守卫**默认开**（它是保护，且在 DeepSeek 上被 146/146 的实测
  // 支持）。它同样可以关，所以走同一条热插拔机制——只是默认方向相反，这正是
  // `defaultEnabled` 存在的意义：两个方向共用一套表示。
  [ENGINE_REPEAT_GUARD_PLUGIN]: { disable: "optional" },
  [ENGINE_WATCHDOG_PLUGIN]: { disable: "optional" },
};

/** 一行的策略；清单里没有的名字按 `required` 处理（fail-closed：未知 = 不许关）。 */
function policyOf(name: string, layer: PluginLayer): { disable: PluginDisable; reason?: string } & RowPolicyExtra {
  const table = layer === "host" ? HOST_POLICY : ENGINE_POLICY;
  return (
    table[name] ?? {
      disable: "required",
      reason: "this plugin is not in the hot-swap catalog: it has no documented disable semantics, so it cannot be switched off",
    }
  );
}

function rowOf(name: string, layer: PluginLayer): PluginCatalogRow {
  const policy = policyOf(name, layer);
  // §3.2：`hot` 描述「是不是按代重新装配」。当前两层都是，所以逐行都是 true——
  // 这正是「不再硬编码为 false」的含义。`hot: false` 留给将来真正不可换的项。
  return {
    name,
    layer,
    hot: true,
    disable: policy.disable,
    ...(policy.reason === undefined ? {} : { reason: policy.reason }),
    // W9331：只在**明确写 false** 时才带上这个键，所以「默认开」的行在 JSON 里
    // 的形状与 W9322 逐字节相同（`defaultEnabled` 缺省 = true，见类型注释）。
    ...(policy.defaultEnabled === false ? { defaultEnabled: false } : {}),
  };
}

/**
 * 装配清单：host 启动层（按 `composeStudio` 的 mount 顺序）在前，引擎层（按
 * `compose()` 的 mount 顺序）在后。
 *
 * `hostNames` 由调用方从**真实的 mount 记录**传入（`StudioServices.hostPluginNames`），
 * 所以 host 层的名字永远不会和 `storePlugins`/`hostPlugins` 漂移——这正是 W860 的
 * 反漂移设计，这里原样保留。
 */
export function pluginCatalog(hostNames: readonly string[]): PluginCatalogRow[] {
  return [
    ...hostNames.map((name) => rowOf(name, "host")),
    ...ENGINE_PLUGIN_NAMES.map((name) => rowOf(name, "engine")),
  ];
}

/** 清单里所有名字（host 在前），顺序与 [pluginCatalog] 一致。 */
export function pluginCatalogNames(hostNames: readonly string[]): string[] {
  return pluginCatalog(hostNames).map((row) => row.name);
}
