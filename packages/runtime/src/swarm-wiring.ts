/**
 * Swarm wiring — the part of composition that only `runtime` can do.
 *
 * Same shape as worker-wiring.ts: the swarm package is L1 and may import only
 * `@celestea/core`, so it cannot reach the tool package's `exposedRegistry` to build
 * the member-visible tool face (ARCHITECTURE.md §1.3 D2, and depcruise's
 * tier1-no-peer-deps-swarm). The composition root is the only legal place to fold the
 * orchestration tools out of a member's face, so that is where it happens.
 *
 * Two rules this file exists to enforce:
 *   1. **No loopFactory = no swarm.** A member turn needs a per-turn loop built with
 *      the member's own signal; `compose` only has one when the host passed a
 *      `loopFactory`. Without it the swarm cannot run a single member, so the wiring
 *      returns null (nothing mounted) instead of registering a tool that would fail
 *      every call. Host-visible and silent-failure-free either way: the tool simply
 *      never appears in the registry.
 *   2. **Member face = host face minus orchestration tools.** Exactly
 *      `agent_swarm` and `spawn_worker` are folded (§5.2, upstream maxDepth=1).
 *
 * Nothing here is mandatory: with `swarm: false` nothing is mounted and no hook
 * degrades, exactly as `workers: false` behaves (§5.3 — the host may turn it off).
 */

import {
  LLM_REGISTRY_SERVICE,
  LLM_SERVICE,
  TOOL_REGISTRY_SERVICE,
  Context,
  mountPlugins,
  zeroUsage,
  type AgentConfig,
  type Llm,
  type LlmRegistry,
  type ToolRegistry,
} from "@celestea/core";
import { exposedRegistry } from "@celestea/tools";
import {
  SWARM_NESTED_TOOL_NAMES,
  SWARM_TOOL_NAME,
  SwarmRegistry,
  swarmPlugin,
  type SwarmLoopBindings,
  type SwarmToolDeps,
} from "@celestea/swarm";
import type { LoopFactory } from "./turn-runner.js";

const DEFAULT_SWARM_PLUGIN = "celestea.runtime.swarm";

export interface SwarmWiring {
  /** false disables swarm wiring entirely (default: enabled when a loopFactory exists). */
  enabled?: boolean;
  /** The host's per-turn loop factory; WITHOUT it no member turn can be built. */
  loopFactory?: LoopFactory;
  /**
   * Optional: the agent config members inherit (model / system prompt / step budget).
   *
   * OPTIONAL because `compose()` always derives this from the session's own
   * profile and overwrites whatever a host passed — a member must inherit ITS
   * session's budget, not a host-chosen one. Requiring it here would have forced
   * every host to invent a value that compose throws away.
   */
  agentConfig?: AgentConfig;
  /** Mount name (auto-named when omitted). */
  name?: string;
  /** Extra deps merged into the tool's deps (tests / hosts). */
  deps?: Partial<SwarmToolDeps>;
  /**
   * The session id batches are recorded under. Omitted = the tool's own default.
   * It matters because the panel is per-session: two sessions sharing one id would
   * show each other's batches.
   */
  sessionId?: string;
  /** Pre-built roster (the host owns it); otherwise one is created here. */
  registry?: SwarmRegistry;
}

export interface SwarmHost {
  /** The member-visible tool face (orchestration tools folded). */
  memberTools: ToolRegistry;
  /**
   * The member roster: the statusline panel's data source (feature §7).
   *
   * The host reads the roster from HERE (the RuntimeAdapter.workersOf shape) rather
   * than resolving a Context token, because the roster is session-scoped and a global
   * token would leak one session's batch into another's panel.
   */
  registry: SwarmRegistry;
  /** Name of the plugin this wiring mounted (null when a host plugin provided it). */
  mountedPlugin: string | null;
  /** The registered tool name, for the compose-level assertion. */
  toolName: string;
}

/**
 * Fold the orchestration tools out of a member's tool face.
 *
 * `exposedRegistry` is the repo's ONE filter truth: it hides the names from
 * `schemas()` (so a member is never even told they exist) and folds a direct call
 * into a deny. A second filter here would be a second truth for the same rule.
 *
 * **Why the guidance is overridden.** The default refusal text is the EXECUTION-MODE
 * wording ("write ONE run_code program..."), because that is the only reason the
 * tools package folds anything. It is actively wrong here: a swarm member has no
 * execution mode, no `run_code`, and no way to become a host session. Telling it to
 * write a program sends it down a dead end and burns its turn. The member is told
 * the truth instead: it may not delegate, and it must do the work itself.
 */
export function memberToolFace(inner: ToolRegistry): ToolRegistry {
  return exposedRegistry(inner, {
    hidden: SWARM_NESTED_TOOL_NAMES,
    guidance: MEMBER_FOLDED_GUIDANCE,
    guidanceFor: () => MEMBER_FOLDED_GUIDANCE,
  });
}

/**
 * The refusal a MEMBER sees (model-facing, like the rest of the swarm XML text —
 * deliberately NOT in the i18n dictionaries: the consumer is a model, not a person,
 * and dictionarying it would cross the write scope of the swarm and web packages).
 */
export const MEMBER_FOLDED_GUIDANCE =
  "swarm members cannot delegate: a member has no host session and no way to spawn a " +
  "sub-task of its own. Do the work yourself, in this member, with the tools you already have.";

/**
 * Resolve and mount the swarm plugin. Returns null when disabled or when the host
 * gave no loopFactory (rule 1 above).
 */
export function ensureSwarmWiring(
  ctx: Context,
  wiring: SwarmWiring | false | undefined,
): SwarmHost | null {
  if (wiring === false || wiring?.enabled === false) return null;
  if (wiring === undefined) return null;
  if (wiring.loopFactory === undefined) return null;
  const tools = ctx.get<ToolRegistry>(TOOL_REGISTRY_SERVICE);
  // No tool registry = the tools plugin has not mounted yet. Registering is then
  // impossible, so this returns null rather than half-wiring a tool nothing can call.
  if (tools === undefined) return null;
  const loopFactory = wiring.loopFactory;
  // One registry per Runtime generation (session-scoped, Lead ruling): the statusline
  // is one row per session, so a process-wide registry would let session A's panel
  // show session B's batch. compose() builds one Runtime per session generation, so
  // constructing it HERE is what makes it session-scoped by construction.
  const registry = wiring.registry ?? new SwarmRegistry();
  // A member turn needs a config (model / system prompt / step budget). compose()
  // always supplies one, so this only trips a host that mounted the plugin by
  // hand WITHOUT going through compose — and it trips HERE, loudly, instead of
  // handing the member an undefined config three layers down.
  if (wiring.agentConfig === undefined) {
    throw new Error("swarm wiring needs an agentConfig: a member turn inherits the host's model and step budget");
  }
  const deps: SwarmToolDeps = {
    llm: ctx.get<Llm>(LLM_SERVICE) ?? unreachableLlm(),
    tools: memberToolFace(tools),
    config: wiring.agentConfig,
    loopFactory: (bindings: SwarmLoopBindings) => loopFactory({
      config: bindings.config,
      signal: bindings.signal,
      // A member's frames and usage are its OWN: forwarding the host's sink would
      // interleave N members into the host statusline, and forwarding the host's
      // usage would bill the members to the host turn (executor.test.ts pins this).
      sink: () => undefined,
      // A member's usage is its OWN recorder (a batch must not bill the host turn),
      // so the host's accounting object is deliberately not reused here. The loop
      // bindings require the full accounting shape, so the read side returns zeros:
      // nothing reads a member's usage — the batch result is the authority.
      usage: {
        record: (usage) => bindings.usage.record(usage),
        latest: () => zeroUsage(),
        total: () => zeroUsage(),
      },
    }),
    ...(ctx.get<LlmRegistry>(LLM_REGISTRY_SERVICE) === undefined
      ? {}
      : { llmRegistry: ctx.get<LlmRegistry>(LLM_REGISTRY_SERVICE) }),
    registry,
    ...(wiring.sessionId === undefined ? {} : { sessionId: wiring.sessionId }),
    ...(wiring.deps ?? {}),
  };
  mountPlugins(ctx, [swarmPlugin({ deps, name: wiring.name ?? DEFAULT_SWARM_PLUGIN })]);
  return {
    memberTools: deps.tools,
    mountedPlugin: wiring.name ?? DEFAULT_SWARM_PLUGIN,
    toolName: SWARM_TOOL_NAME,
    // The panel's data source, carried on the handle so the host can read the roster
    // off THIS runtime (the RuntimeAdapter.workersOf shape) instead of a global token.
    registry,
  };
}

/**
 * A stand-in Llm for a host that wired no LLM service.
 *
 * Fail-closed: every member attempt REJECTS with this, so a misconfigured host gets
 * a batch full of failed members rather than a crash at compose time. The batch result
 * is the authority (the XML), so the failure is reportable and correctable.
 */
function unreachableLlm(): Llm {
  return { generate: () => Promise.reject(new Error("no LlmService in context; swarm cannot run members")) };
}
