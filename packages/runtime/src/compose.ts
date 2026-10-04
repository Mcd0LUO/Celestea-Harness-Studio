/**
 * compose — the composition root of `packages/runtime`
 * (`crates/runtime/src/compose.rs:74-234`).
 *
 * Assembly order is SEMANTICS, not taste (ARCHITECTURE.md §3.2), so it is
 * explicit and tested:
 *
 *   1. runtime services      event bus, usage accounting, status tracker;
 *   2. session binding       `sessionBinding` (if given) opens the host log;
 *   3. host plugins          `config.plugins` in order — a later `provide` of a
 *                            token REPLACES an earlier one (patch semantics, so
 *                            a test can mount a fake over a real implementation);
 *   4. worker wiring         mount the default workers plugin only when the host
 *                            did not provide a registry (worker tools must land
 *                            in the tool registry, hence last);
 *   4b. watchdog             W740: mount the liveness watchdog over the resolved
 *                            worker registry and keep its stop handle, so the
 *                            sweep timer dies with `shutdown`/`release`;
 *   4c. swarm wiring         mount the swarm plugin AFTER the tools plugin, so the
 *                            `agent_swarm` tool actually lands in the tool registry;
 *                            a host with no `loopFactory` mounts nothing (§5.3);
 *   4d. repetition guard     W9331: mount the degenerate-repetition guard so a
 *                            host cannot silently ship without it. Default ON, and
 *                            still switchable through the hot-swap catalog;
 *   5. seam resolution       session (required) + llm / tools / agentLoop
 *                            (optional, and `null` when no plugin provides them);
 *   6. driver attach         hand Llm/ToolRegistry/AgentLoop to the worker
 *                            registry so `spawn_worker` is driven, not merely
 *                            registered, and register the host conversation so
 *                            receipts have an address;
 *   7. turn runner           bind the per-turn loop factory, sink mapper, usage
 *                            accounting and receipt drain into one driver.
 *
 * Everything the runtime needs beyond `core` is injected: the concrete agent
 * loop arrives as a `loopFactory`, the frame mapper as `frameMapper`, the worker
 * log factory as `workers.logFactory`. That is what keeps this layer free of
 * L1 implementation imports (and lets P3 tests drive it with fakes).
 */

import {
  AGENT_LOOP_SERVICE,
  LLM_REGISTRY_SERVICE,
  LLM_SERVICE,
  SESSION_LOG_SERVICE,
  TOOL_REGISTRY_SERVICE,
  Context,
  createEventBus,
  EVENT_BUS_SERVICE,
  mountPlugins,
  pluginNames,
  type AgentConfig,
  type AgentLoop,
  type Llm,
  type LlmRegistry,
  type Plugin,
  type SessionLog,
  type ToolRegistry,
} from "@celestea/core";
import type { WorkerDrivers } from "@celestea/workers";
import { RETENTION_SERVICE, type ToolResultRetention } from "@celestea/agent-loop";
import { agentConfigFromProfile } from "./agent-config.js";
import { createToolResultRetention, retentionSettingsFromEnv } from "./retention.js";
import { ComposeError } from "./errors.js";
import { loopEventToFrame, type FrameMapper } from "./frames.js";
import type { Profile } from "./profile.js";
import { Runtime, type ContextUsagePlane, type RuntimeParts, type ShutdownHook } from "./runtime.js";
import { bindSession, type SessionBinding } from "./session-binding.js";
import { createStatusTracker, type StatusTracker } from "./status.js";
import type { TurnLedgerHooks } from "./ledger.js";
import type { MemoryExtractionScheduler } from "./memory-extraction.js";
import type { TurnContextRow } from "./turn-runner.js";
import { STATUS_TRACKER_SERVICE, USAGE_TRACKER_SERVICE } from "./tokens.js";
import { TurnRunner, type LoopFactory, type PendingReceipt } from "./turn-runner.js";
import { createUsageTracker, type UsageAccounting } from "./usage.js";
import type { InjectionLane, PendingInjection } from "@celestea/core";
import { createSessionInbox, type SessionInbox } from "./inbox.js";
import { checkpointInboxSink } from "./inbox-checkpoint.js";
import { ensureSwarmWiring, type SwarmHost, type SwarmWiring } from "./swarm-wiring.js";
import { ensureWorkerWiring, type WorkerHost, type WorkerWiring } from "./worker-wiring.js";
import { checkpointStoreOf } from "@celestea/session";
import { REPEAT_GUARD_PLUGIN_NAME, mountRepeatGuard, type RepeatGuardOptions } from "./repeat-guard-mount.js";
import {
  WATCHDOG_PLUGIN_NAME,
  celesteaWatchdogSettings,
  mountWatchdog,
  stopWatchdog,
  type MountedWatchdog,
  type WatchdogMountSettings,
} from "./watchdog-mount.js";

export interface ComposeConfig {
  profile: Profile;
  /** Seam providers, mounted in order (later wins). */
  plugins?: readonly Plugin[];
  /** Host conversation binding (dir + log opener); a rebind reuses it. */
  sessionBinding?: SessionBinding;
  /** Loop budget overrides (defaults derive from the profile). */
  agentConfig?: Partial<AgentConfig>;
  /** Concrete agent loop per turn; absent = `AGENT_LOOP_SERVICE` from the Context. */
  loopFactory?: LoopFactory;
  /** LoopEvent -> SSE frame mapping; defaults to the contract mapping. */
  frameMapper?: FrameMapper;
  /** Shared usage accounting (pass the loop's own tracker to share one object). */
  usage?: UsageAccounting;
  /** Shared statusline tracker (steps + rate window). */
  status?: StatusTracker;
  /**
   * Usage ledger turn hooks (W728 §3 P0): pass the session's `UsageLedger` so
   * every turn books a `turn_total` row. Absent = no ledgering in this
   * generation (the default; the studio host wires one).
   */
  ledger?: TurnLedgerHooks;
  /**
   * Background memory extraction (docs/feature-memory-extraction.md Phase 1):
   * the host builds the scheduler (its deps need the workspace memory store),
   * the runner schedules it at every turn end. Absent = no extraction.
   */
  extraction?: MemoryExtractionScheduler;
  /** Worker orchestration wiring; `false` disables it. */
  workers?: WorkerWiring | false;
  /**
   * W9322 (docs/feature-plugin-hotswap.md §3.1): **this generation's tool face is
   * EMPTY** — the host switched the tools plugin off.
   *
   * It is NOT the same as "mount no tools plugin": `resolveSeams()` treats
   * `TOOL_REGISTRY_SERVICE` as a REQUIRED seam and throws
   * `missing ToolRegistryService in context` when it is absent, so a generation
   * with no registry cannot run a single turn. The host therefore provides the
   * registry (empty) and asks this root to register nothing into it.
   *
   * Enforced HERE, in one place, because the tool face has three writers — the
   * tools plugin, the workers plugin and the swarm wiring — and a flag per writer
   * would let one of them quietly put back what the user switched off. `true`
   * also suppresses both orchestration wirings, so the face is really empty.
   *
   * Absent/false = the pre-W9322 behaviour, byte for byte.
   */
  emptyTools?: boolean;
  /**
   * Batch sub-agent wiring (`agent_swarm`); `false` disables it (default: off until
   * the host passes a `loopFactory` — a member turn cannot be built without one).
   */
  swarm?: SwarmWiring | false;
  /**
   * W9331: the degenerate-repetition guard (upstream `dsh-guard-repeat-output`
   * 2.1.6, MIT). `false` never mounts it; a partial object overrides the resolved
   * settings; omitted = the environment (`CELESTEA_REPEAT_GUARD=off` disables,
   * otherwise the shipped thresholds mount).
   *
   * It is **default ON** and that is the point of the plugin: before W9331 the
   * guard was a set of optional `AgentLoopBindings` a host had to know about, so a
   * host that did not wire it got no protection at all. Mounting it here means the
   * composition decides, and the hot-swap catalog can still switch it off.
   */
  repeatGuard?: RepeatGuardOptions | false;
  /**
   * W740: the liveness watchdog over this generation's worker registry.
   * `false` never mounts it; a partial object overrides the resolved settings
   * (`autostart: false` mounts the sweep but leaves the cadence to the caller,
   * which is how tests drive `tick()` by hand); omitted = the environment
   * (`celesteaWatchdogSettings(config.env)`, on by default).
   */
  watchdog?: Partial<WatchdogMountSettings> | false;
  /** Process environment the watchdog settings are read from. */
  env?: NodeJS.ProcessEnv;
  /** Mid-turn injection queue (default: a fresh one per generation). */
  inbox?: SessionInbox;
  /**
   * W515 §2: every message that LEAVES a lane (or the host mailbox) is reported
   * with the boundary that consumed it, so the host can publish
   * `placement: "context"` (the message is now model-visible) over SSE.
   */
  onInjected?: (messages: readonly PendingInjection[], boundary: "turn-start" | "step") => void;
  /**
   * W884: durable, engine-owned turn context (the skill catalog, name +
   * description only). Called once per turn start; each row is appended to the
   * log as user-role history BEFORE the receipts and the input. `[]` = nothing
   * (a workspace without skills pays nothing). The provider is the HOST's,
   * because only the host knows the session's workspace (W768).
   */
  turnContext?: () => readonly TurnContextRow[];
  /** Host teardown hooks (process kills) — run once, in order, by `shutdown`. */
  shutdownHooks?: readonly ShutdownHook[];
  /** Injectable clock (status tracker rate window). */
  now?: () => number;
  /**
   * W855: tool-result retention policy. Absent = built from the environment
   * and the session directory (`<dir>/spills/`), so the host gets the default
   * without wiring anything; `null` explicitly disables it.
   */
  retention?: ToolResultRetention | null;
}

/** Compose one engine generation. Throws [ComposeError] on a missing seam. */
export function compose(config: ComposeConfig): Runtime {
  const ctx = Context.root();
  const usage = config.usage ?? createUsageTracker();
  const status = config.status ?? createStatusTracker(config.now ?? Date.now);
  ctx.provide(EVENT_BUS_SERVICE, createEventBus());
  ctx.provide(USAGE_TRACKER_SERVICE, usage);
  ctx.provide(STATUS_TRACKER_SERVICE, status);

  const binding = config.sessionBinding ?? null;
  const bound = binding === null ? null : bindSession(ctx, binding);
  // 插件热插拔（W9322）：`emptyTools` = 这一代的工具面是空的。注册表**仍然**被
  // provide（`resolveSeams()` 把它当必需 seam，缺了整代跑不起来），但**没有任何东西
  // 注册进去**——包括下面两个会往注册表里塞工具的编排插件。
  //
  // 为什么要在这里判断，而不是让 host 传 `workers: false` + `swarm: false`：
  // 「空工具面」是一个整体语义，散成三个开关就有三种写错的方式（漏一个 =
  // 刚关掉的工具从后门回来）。host 说一次「这一代没有工具」，这里负责到底。
  const emptyTools = config.emptyTools === true;
  const plugins = config.plugins ?? [];
  mountPlugins(ctx, plugins);

  const workerHost = ensureWorkerWiring(ctx, emptyTools ? false : config.workers);
  const mounted = mountWatchdogOf(ctx, config, workerHost);
  // W9331: the repetition guard mounts AFTER the watchdog and BEFORE seam
  // resolution, so the loop factory (resolved below) can read the settings from
  // the Context. It is independent of the tool face, so `emptyTools` does not
  // suppress it: with no tools a model can still be driven into a collapse, and
  // that is precisely when the guard matters.
  const guardSettings = config.repeatGuard === false ? null : mountRepeatGuard(ctx, config.repeatGuard ?? {}, config.env ?? process.env);
  const session = requireSession(ctx);
  const sessionRef = { log: session };
  // W855: session-scoped tool-result retention (the loop reads this per turn).
  if (config.retention !== null) {
    ctx.provide(
      RETENTION_SERVICE,
      config.retention ?? createToolResultRetention(retentionSettingsFromEnv(binding?.dir ?? null, config.env ?? process.env)),
    );
  }
  const llm = ctx.get<LlmRegistry>(LLM_REGISTRY_SERVICE) ?? null;
  const tools = ctx.get<ToolRegistry>(TOOL_REGISTRY_SERVICE) ?? null;
  const agentLoop = ctx.get<AgentLoop>(AGENT_LOOP_SERVICE) ?? null;
  attachDrivers(workerHost, { llm: resolveDriverLlm(ctx, llm), tools, agentLoop });

  const agentConfig = agentConfigFromProfile(config.profile, config.agentConfig ?? {});
  // W9290 B1-01: the in-flight turn's cancel signal, late-bound. The swarm tool is
  // mounted BEFORE `runner` exists (below) and the cancel signal is created PER TURN, so
  // there is no concrete AbortSignal to hand over yet — only a holder to fill in once
  // `runner` is built. Same shape as the studio's questionHolder / runCodeHolder.
  // Without it a batch has NO cancel path: a member that ignores abort runs until its
  // own timeoutMs (2h by default) and the user's stop button cannot reach the batch.
  const swarmSignal: { current: AbortSignal | null } = { current: null };
  // 4c. swarm wiring: mounted AFTER the tools plugin (the plugin registers the tool
  // into the tool registry) and AFTER `agentConfig` is derived, because a member
  // inherits the host's model / system prompt / step budget from it.
  const swarmHost =
    emptyTools || config.swarm === false || config.swarm === undefined
      ? null
      : ensureSwarmWiring(ctx, { ...config.swarm, agentConfig, ...(config.loopFactory === undefined ? {} : { loopFactory: config.loopFactory }), signal: config.swarm.signal ?? (() => swarmSignal.current) });
  const inbox = config.inbox ?? createSessionInbox();
  // E §1.3 P1 ①: the lanes + the accepted-id ledger live in this session's
  // checkpoint sidecar when the log is a checkpointed persistent one; an
  // in-memory (detached) session has no sidecar and therefore no persistence.
  const store = bound === null ? null : checkpointStoreOf(bound);
  if (store !== null) inbox.bindPersistence(checkpointInboxSink(store));
  const receipts = (): PendingReceipt[] => workerHost?.drain() ?? [];
  const drained = (messages: PendingReceipt[], boundary: "turn-start" | "step"): PendingReceipt[] => {
    if (messages.length === 0) return messages;
    // A mailbox message never entered a lane: the BOUNDARY that consumed it is
    // what tells the client where it landed (W515 §1/§2).
    const lane: InjectionLane = boundary === "step" ? "next-step" : "next-turn";
    const annotated = messages.map((message) => (message.lane === undefined ? { ...message, lane } : message));
    // P1-6 (W836): the lane was ALREADY drained (the message left the queue and
    // the sidecar). A throwing observer must never take the message with it: the
    // callback is a notification, so its failure is a warning, not a loss.
    try {
      config.onInjected?.(annotated, boundary);
    } catch (e) {
      process.stderr.write(`[celestea-runtime] onInjected callback failed: ${String(e)}\n`);
    }
    return annotated;
  };
  // W1900: the late-bound water level (see the `contextUsage` line below).
  const usagePlane: ContextUsagePlane = { reader: null };
  const runner = new TurnRunner({
    ctx,
    session: () => sessionRef.log,
    status,
    usage,
    agentConfig,
    frameMapper: config.frameMapper ?? loopEventToFrame,
    ...(config.ledger === undefined ? {} : { ledger: config.ledger }),
    ...(config.extraction === undefined ? {} : { extraction: config.extraction }),
    ...(config.loopFactory === undefined ? {} : { loopFactory: config.loopFactory }),
    ...(config.turnContext === undefined ? {} : { turnContext: config.turnContext }),
    // W1900: ONE water-level plane. The nudge reads exactly what /api/status
    // reports, because the Runtime fills that holder with its OWN
    // `statusView()` reader — the turn runner is built before the Runtime
    // exists, so the plane travels as a late-bound holder, exactly like the
    // studio's questionHolder. It is never a second estimate computed here.
    contextUsage: () => usagePlane.reader?.() ?? null,
    drainPending: () => drained([...inbox.drain("next-turn"), ...receipts()], "turn-start"),
    injections: {
      drain: () => drained([...inbox.drain("next-step"), ...receipts()], "step"),
      pending: () => inbox.pending("next-step") + (workerHost?.pending() ?? 0),
    },
  });

  // W9290 B1-01: the runner exists now, so the in-flight turn's signal is readable.
  // `currentSignal` is null between turns, which batchSignalOf() treats as "no batch
  // cancellation" — byte-identical to the pre-fix behaviour when no turn is running.
  swarmSignal.current = runner.currentSignal;

  const parts: RuntimeParts = {
    ctx,
    profile: config.profile,
    agentConfig,
    sessionRef,
    binding,
    status,
    usage,
    inbox,
    runner,
    workerHost: watchdogHostOf(workerHost, mounted),
    swarmHost,
    llm,
    tools,
    agentLoop,
    plugins: pluginNamesOf(plugins, workerHost, mounted, swarmHost, guardSettings !== null),
    shutdownHooks: [...(config.shutdownHooks ?? []), stopWatchdog(mounted)],
    // W1900: the Runtime writes the single water-level reader here.
    usagePlane,
  };
  return new Runtime(parts);
}

/**
 * The plugin set that was mounted, in mount order (order is contract): the host
 * plugins, then the workers plugin (when this root mounted it), then the swarm
 * plugin, then the W740 watchdog — which is always LAST, because it may only
 * adjudicate rows a fully mounted worker registry already owns.
 *
 * W9322: the SWARM plugin used to be missing here. `ensureSwarmWiring` really
 * mounts it (step 4c, which is why `agent_swarm` is in the registry and in the
 * model's prompt), but `pluginNames` never named it — so this list, documented as
 * "the plugin set that was mounted", was incomplete for exactly the one plugin
 * the hot-swap inventory has to be able to switch off. The `swarmHost` handle was
 * already available at the call site; it is now threaded in like `workerHost`.
 */
export function pluginNamesOf(
  plugins: readonly Plugin[],
  workerHost: WorkerHost | null,
  mounted: MountedWatchdog | null = null,
  swarmHost: SwarmHost | null = null,
  repeatGuardMounted: boolean = false,
): string[] {
  const names = pluginNames(plugins);
  if (workerHost !== null && workerHost.mountedPlugin !== null) names.push(workerHost.mountedPlugin);
  if (swarmHost !== null && swarmHost.mountedPlugin !== null) names.push(swarmHost.mountedPlugin);
  if (repeatGuardMounted) names.push(REPEAT_GUARD_PLUGIN_NAME);
  if (workerHost !== null && mounted !== null) names.push(WATCHDOG_PLUGIN_NAME);
  return names;
}

/**
 * W740: mount the watchdog over the RESOLVED registry — the host-provided one or
 * the default this root mounted. It runs even when a host plugin provided the
 * registry: liveness judgement is exactly what is missing there. With no worker
 * wiring (`workers: false`) there is no registry to sweep and nothing mounts.
 */
function mountWatchdogOf(ctx: Context, config: ComposeConfig, workerHost: WorkerHost | null): MountedWatchdog | null {
  if (workerHost === null || config.watchdog === false) return null;
  const fromEnv = celesteaWatchdogSettings(config.env ?? process.env);
  return mountWatchdog(ctx, workerHost.registry, { ...fromEnv, ...config.watchdog });
}

/** Attach the watchdog handle to the host view (services stay in the Context). */
function watchdogHostOf(workerHost: WorkerHost | null, mounted: MountedWatchdog | null): WorkerHost | null {
  return workerHost === null ? null : { ...workerHost, watchdog: mounted?.watchdog ?? null };
}

function requireSession(ctx: Context): SessionLog {
  const session = ctx.get<SessionLog>(SESSION_LOG_SERVICE);
  if (session === undefined) {
    throw new ComposeError("no SessionLog: pass a sessionBinding or mount a session log plugin");
  }
  return session;
}

/**
 * The single adapter the worker driver uses: the composed `LlmService`, else the
 * registry's first registered provider (compose registers exactly one).
 */
function resolveDriverLlm(ctx: Context, registry: LlmRegistry | null): Llm | undefined {
  const direct = ctx.get<Llm>(LLM_SERVICE);
  if (direct !== undefined) return direct;
  const first = registry?.list()[0];
  return first === undefined ? undefined : registry?.resolve(first);
}

/** Attach every driver seam (all three, or none — a partial set cannot drive). */
function attachDrivers(
  host: WorkerHost | null,
  seams: { llm: Llm | undefined; tools: ToolRegistry | null; agentLoop: AgentLoop | null },
): void {
  if (host === null) return;
  const { llm, tools, agentLoop } = seams;
  const drivers: WorkerDrivers | null =
    llm === undefined || tools === null || agentLoop === null ? null : { llm, tools, agentLoop };
  host.attach(drivers);
}
