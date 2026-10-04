/**
 * Studio store plugins — "everything is a plugin" at the host layer.
 *
 * Each store is mounted as a `Plugin` that `provide`s exactly one service into
 * the shared `Context`; nothing is `new`ed by a consumer, so a test can mount a
 * store over a temp directory and the handlers never learn the difference.
 * Mount order is semantic (a later plugin consumes an earlier service):
 *
 *   workspaces  -> registry (also the workspace-name -> path lookup)
 *   sessions    -> session scan / resolve / transcript (consumes workspaces)
 *   sessionOps  -> rename / branch / archive / trash (consumes both)
 *   providers   -> providers.json + public_view
 *   prompts     -> prompts.json registries
 *   bus         -> the SSE bus (the RuntimeAdapter attaches to it)
 *   runtime     -> the injected RuntimeAdapter (engine seam)
 *   settings    -> host-side overrides (system_prompt / base_url)
 */

import { Context, definePlugin, mountPlugins, pluginNames, type Plugin } from "@celestea/core";
import { dirname } from "node:path";
import { bindPluginSwitchToEngine, PluginSwitch } from "./plugin-hotswap.js";
import { createStudioBus, type StudioBus } from "./sse.js";
import { createGrantsServices, type GrantsServices } from "./store/grants-service.js";
import { SessionOps } from "./store/session-ops.js";
import { SessionsStore } from "./store/sessions.js";
import { ProvidersStore } from "./store/providers.js";
import { PromptsStore } from "./store/prompts.js";
import { WorkspacesStore } from "./store/workspaces.js";
import { StudioSettings } from "./settings.js";
import { SerialQueue } from "./serial-queue.js";
import type { StudioConfig } from "./config.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";

/** Service tokens: the typed keys of the studio Context. */
export const WORKSPACES_SERVICE = "studio.workspaces";
export const SESSIONS_SERVICE = "studio.sessions";
export const SESSION_OPS_SERVICE = "studio.sessionOps";
export const PROVIDERS_SERVICE = "studio.providers";
export const PROMPTS_SERVICE = "studio.prompts";
export const BUS_SERVICE = "studio.bus";
export const RUNTIME_SERVICE = "studio.runtime";
export const SETTINGS_SERVICE = "studio.settings";

/** The four data stores composed BEFORE the engine (the engine resolves sessions). */
export interface StoreServices {
  workspaces: WorkspacesStore;
  sessions: SessionsStore;
  sessionOps: SessionOps;
  providers: ProvidersStore;
  prompts: PromptsStore;
}

/**
 * Engine factory: the real adapter needs the session store to resolve
 * `<workspace>/<session>` -> directory, so the host may inject a factory that
 * receives the composed stores instead of a ready-made adapter.
 *
 * 第二个参数（插件热插拔）：开关在**工厂调用时**才存在，而适配器需要拿它当
 * 「每次 `compose()` 读一次」的钩子。可选，所以一个不关心热插拔的工厂
 * （测试里的假引擎）签名不用改。
 */
export type EngineFactory = (stores: StoreServices, plugins?: PluginSwitch) => RuntimeAdapter;

export interface ComposeInput {
  config: StudioConfig;
  /** Injected engine seam, or a factory over the composed stores. */
  runtime: RuntimeAdapter | EngineFactory;
  /** Process environment (grant audit channel, unsandboxed availability). */
  env?: NodeJS.ProcessEnv;
  /** Deterministic clock for tests (session dir suffixes, trash stamps). */
  now?: () => number;
  /**
   * 插件热插拔：本进程唯一的插件开关。缺省 = 就地新建一个（读
   * `<data dir>/plugins.json`）。
   *
   * 为什么可以注入：`createStudioApp` 需要**在** `composeStudio` 之前拿到它，
   * 才能把它交给引擎工厂（`pluginSwitches` 钩子），让适配器在每次 `compose()` 时
   * 读到当前开关。这是 app.ts 里 `HostRef` 同一形状的 late-binding。
   */
  plugins?: PluginSwitch;
}

export interface StudioServices {
  ctx: Context;
  config: StudioConfig;
  bus: StudioBus;
  runtime: RuntimeAdapter;
  settings: StudioSettings;
  workspaces: WorkspacesStore;
  sessions: SessionsStore;
  sessionOps: SessionOps;
  providers: ProvidersStore;
  prompts: PromptsStore;
  /** W516: grant file I/O helpers, audit channel, confirm tokens, limits. */
  grants: GrantsServices;
  /**
   * W815-N2: the ONE serial queue behind the studio's hot-apply writes — the
   * prompt registry (`POST /api/prompts`) and `POST /api/config` both snapshot,
   * mutate and `await` the engine, so the two must never interleave.
   */
  applyQueue: SerialQueue;
  /**
   * 插件热插拔（`docs/feature-plugin-hotswap.md`）：本进程唯一的插件开关。
   *
   * 它是 `GET/PUT /api/plugins` 的状态源，也是引擎**换代**的触发点：写入成功后
   * 通知 `runtime.invalidateAll()`，于是空闲实例立即重组、在跑的 turn 只被标记，
   * 下一个 turn 边界才换（§3.1 拍板的「生效时机 = turn 边界」）。
   *
   * 它**不在** `hostPluginNames` 里：清单由 `plugin-catalog.ts` 从 mount 记录 +
   * 引擎层的装配名单合成，而这个对象是那张表的**状态**，不是表本身。
   */
  plugins: PluginSwitch;
  /**
   * W860: the names of the plugins THIS composition mounted at startup, in mount
   * order (the store plugins, then the host singletons) — recorded with
   * `pluginNames` over the very arrays that were mounted, so
   * `GET /api/plugins` can never drift from `storePlugins`/`hostPlugins`.
   *
   * 边界（W9322 改写）：这里**仍然只是 host 启动层**。引擎层插件不在这条记录里，
   * 因为它们是**每会话**装配的、随换代变化，而这条记录是「本进程启动时 mount 了
   * 什么」的事实。`GET /api/plugins` 现在把两层一起列出来，引擎层的名单来自
   * `plugin-catalog.ts` 的 `ENGINE_PLUGIN_NAMES`（由 `plugin-inventory.test.ts`
   * 用真实会话的 `Runtime.pluginNames` 反漂移钉住）。
   */
  hostPluginNames: string[];
}

/**
 * Store plugins. `workspaces/sessions/sessionOps` share one clock so a test can
 * pin the `<secs>.<nanos>` suffix of a created session directory.
 */
export function storePlugins(config: StudioConfig, now: () => number): Plugin[] {
  return [
    definePlugin("studio/workspaces", (ctx) => ctx.provide(WORKSPACES_SERVICE, new WorkspacesStore(config.paths.workspacesFile))),
    definePlugin("studio/sessions", (ctx) =>
      ctx.provide(SESSIONS_SERVICE, new SessionsStore(ctx.require(WORKSPACES_SERVICE), now)),
    ),
    definePlugin("studio/session-ops", (ctx) =>
      ctx.provide(SESSION_OPS_SERVICE, new SessionOps(ctx.require(WORKSPACES_SERVICE), ctx.require(SESSIONS_SERVICE), now)),
    ),
    definePlugin("studio/providers", (ctx) => ctx.provide(PROVIDERS_SERVICE, new ProvidersStore(config.paths.providersFile))),
    definePlugin("studio/prompts", (ctx) => ctx.provide(PROMPTS_SERVICE, new PromptsStore(config.paths.promptsFile))),
  ];
}

/** Bus + runtime + settings: the three host singletons. */
export function hostPlugins(runtime: RuntimeAdapter, bus: StudioBus): Plugin[] {
  return [
    definePlugin("studio/bus", (ctx) => ctx.provide(BUS_SERVICE, bus)),
    definePlugin("studio/runtime", (ctx) => ctx.provide(RUNTIME_SERVICE, runtime)),
    definePlugin("studio/settings", (ctx) => ctx.provide(SETTINGS_SERVICE, new StudioSettings())),
  ];
}

/**
 * Compose the studio context in TWO phases: the stores first (so an engine
 * factory can resolve session directories), then the host singletons. The
 * caller owns the runtime adapter instance either way.
 */
export function composeStudio(input: ComposeInput): StudioServices {
  const ctx = Context.root();
  const storePluginList = storePlugins(input.config, input.now ?? Date.now);
  mountPlugins(ctx, storePluginList);
  const stores: StoreServices = {
    workspaces: ctx.require(WORKSPACES_SERVICE),
    sessions: ctx.require(SESSIONS_SERVICE),
    sessionOps: ctx.require(SESSION_OPS_SERVICE),
    providers: ctx.require(PROVIDERS_SERVICE),
    prompts: ctx.require(PROMPTS_SERVICE),
  };
  // 插件热插拔：开关在**引擎工厂之前**建好，因为工厂里的适配器要拿它当
  // `pluginSwitches` 钩子（每次 `compose()` 读一次，见 session-compose.ts）。
  const plugins =
    input.plugins ??
    new PluginSwitch({
      dir: dirname(input.config.paths.workspacesFile),
      hostNames: () => hostNames,
      now: () => Math.floor((input.now ?? Date.now)() / 1000),
    });
  const runtime = typeof input.runtime === "function" ? input.runtime(stores, plugins) : input.runtime;
  const bus = createStudioBus({ statusline: () => runtime.statusline() });
  runtime.attach(bus);
  const hostPluginList = hostPlugins(runtime, bus);
  mountPlugins(ctx, hostPluginList);
  const hostNames = [...pluginNames(storePluginList), ...pluginNames(hostPluginList)];
  // 换代通道：开关变更 -> 引擎在下一个 turn 边界重组实例。绑定发生在**装配期**，
  // 所以 `PUT /api/plugins` 的处理器不需要知道引擎是谁（它只调 `replace()`）。
  bindPluginSwitchToEngine(plugins, runtime);
  const grants = createGrantsServices({
    dataDir: dirname(input.config.paths.workspacesFile),
    workspacesFile: input.config.paths.workspacesFile,
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return {
    ctx,
    config: input.config,
    bus,
    runtime,
    settings: ctx.require(SETTINGS_SERVICE),
    grants,
    applyQueue: new SerialQueue(),
    plugins,
    hostPluginNames: hostNames,
    ...stores,
  };
}
