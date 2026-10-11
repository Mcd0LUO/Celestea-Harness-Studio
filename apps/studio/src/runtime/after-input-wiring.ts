/**
 * W9346 + W9351 + W-C1b: the after-input lane’s producers of ONE generation,
 * assembled in the order the model must read them.
 *
 * Each producer’s reasoning lives in its own module (`goal-wiring.ts` /
 * `skill-wiring.ts` / `mcp-wiring.ts`); this file only fixes the ORDER, which is
 * the one thing that is nobody’s single-producer business. Order is semantic
 * (argument order = read order): the goal’s change notice, then the `/skill:`
 * body, then `/mcp:<server>` — the MCP producer goes LAST so it can never reorder
 * the two above it.
 *
 * Why it is not inline in `session-compose.ts`: that file sits on the 450-line
 * ratchet, and the merge that brought the skill + MCP producers into this tree
 * (PR #7 × main) put it over — the assembly has to happen after `enginePlugins()`
 * (the MCP producer reads `engine.tools.mcp`), which is exactly the spot that ran
 * out of room.
 */
import type { EngineTools } from "./engine-plugins.js";
import { goalNotice, mergeAfterInputs } from "./goal-wiring.js";
import { mcpInvocation } from "./mcp-wiring.js";
import { skillInvocation } from "./skill-wiring.js";

/** The lane for one generation, or `undefined` when no producer applies. */
export function afterInputPlan(
  sessionId: string | null,
  dir: string | null,
  workspacePath: string | null,
  env: NodeJS.ProcessEnv | undefined,
  tools: EngineTools,
) {
  return mergeAfterInputs(
    goalNotice(sessionId, dir),
    skillInvocation(workspacePath, env),
    mcpInvocation(() => tools.mcp?.manifest() ?? []),
  );
}
