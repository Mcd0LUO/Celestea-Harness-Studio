/**
 * What ONE generation must release when it is torn down.
 *
 * W855 #1: detached `run_shell background:true` children — the composer holds the
 * registry from `engine.tools`, runtime is L2 and may not import @celestea/tools,
 * so the hook is wired host side. W-C1b (D7): the generation’s MCP connections —
 * a hook that never runs would leave a third-party stdio server alive past the
 * session that asked for it. Phase 1: queued memory extraction drains on the same
 * hooks (idle-TTL eviction runs them too, and `disposeRuntime` awaits
 * `runtime.shutdown()`).
 *
 * Why it is its own module: `session-compose.ts` sits on the 450-line ratchet, and
 * the merge that brought the skill + MCP producers into this tree (PR #7 × main)
 * put it over. Moving this whole function out is the same move W9346 made with
 * `goal-wiring.ts` — one concern, one file, no behaviour change.
 */
import type { MemoryExtractionScheduler, ShutdownHook } from "@celestea/runtime";
import type { EngineTools } from "./engine-plugins.js";

export function generationShutdownHooks(tools: EngineTools, extraction: MemoryExtractionScheduler | undefined): ShutdownHook[] {
  return [
    () => tools.processes.dispose(),
    async () => void tools.mcp?.dispose(),
    ...(extraction === undefined ? [] : [() => extraction.drain()]),
  ];
}
