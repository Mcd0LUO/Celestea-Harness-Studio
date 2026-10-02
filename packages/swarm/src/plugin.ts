/**
 * `@celestea/swarm` as a plugin — registers `agent_swarm` into the host's tool registry.
 *
 * Same shape as `workersPlugin()` in packages/workers/src/plugin.ts: resolve whatever
 * `ToolRegistry` the host already mounted and register the tool into it. A later
 * `provide` of the same token wins, so a test can swap the wiring wholesale.
 *
 * **Why registration happens at mount time.** The contract (contracts/tools.json)
 * is the single source for `GET /api/tools` and the model prompt; a tool that is not
 * in the registry is not in either. A lazy registration would let the contract and
 * the prompt disagree, so the tool lands in the registry as the plugin mounts.
 *
 * **Mount order is a real constraint.** If no `ToolRegistry` is provided when this
 * plugin mounts, there is nowhere to register and the plugin is a no-op — exactly
 * like `workersPlugin()`. That is why compose mounts the tools plugin BEFORE swarm
 * (the same reason the workers plugin is last), and it is why the swarm wiring in
 * `runtime` re-checks the registry after mounting instead of trusting the order.
 *
 * The plugin holds no scheduler and no batch state: `runSwarm` is constructed per
 * call inside tool.ts, so a batch never outlives the tool call that started it and
 * there is nothing to release on plugin disposal.
 */

import { definePlugin, TOOL_REGISTRY_SERVICE, type Plugin, type ToolRegistry } from "@celestea/core";
import { SWARM_REGISTRY_SERVICE } from "./roster.js";
import { swarmTool, type SwarmToolDeps } from "./tool.js";

// The roster token lives in roster.ts (the module that OWNS the registry), styled
// like PROCESS_REGISTRY_SERVICE in packages/tools/src/process/registry.ts: a token
// belongs in the package that provides the service, not in core — core only holds
// the seam-level tokens. Re-exported here so a host mounting the plugin can reach it
// from the same import it already uses for the plugin itself.

// SWARM_TOOL_NAME is NOT re-declared here: it is the CONTRACT name, and the contract
// has exactly one home (tool.ts, beside the spec loader that reads it). A second
// literal would be a second truth for the one string the tool is registered and
// folded under, and the two could drift without any test noticing.
export { SWARM_TOOL_NAME } from "./tool.js";

export interface SwarmPluginOptions {
  /**
   * Everything the tool needs to run a batch, built by the composition root.
   *
   * Why a whole deps object instead of a constructed `Tool`: the batch is a
   * PER-CALL thing (a fresh scheduler, a fresh executor over the current seams),
   * while the plugin itself is a long-lived singleton. Passing deps keeps the
   * tool stateless and lets a test drive a batch with fakes.
   */
  deps: SwarmToolDeps;
  /** Mount name (auto-named when omitted). */
  name?: string;
}

export function swarmPlugin(opts: SwarmPluginOptions): Plugin {
  const name = opts.name ?? "celestea.swarm.Swarm";
  return definePlugin(name, (ctx) => {
    // The registry is provided HERE, not by the caller, so the service and the tool
    // that feeds it mount together and can never be half-wired. Providing it in one
    // place also avoids the silent hazard of providing the same token twice (patch
    // semantics: the later registration would quietly win).
    //
    // Its own statement, never spliced into another provider's block: Context.provide
    // is order-sensitive, so an explicit call site is easier to audit.
    ctx.provide(SWARM_REGISTRY_SERVICE, opts.deps.registry);
    const tools = ctx.get<ToolRegistry>(TOOL_REGISTRY_SERVICE);
    if (tools === undefined) return;
    tools.register(swarmTool(opts.deps));
  });
}