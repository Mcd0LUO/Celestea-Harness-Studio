/**
 * Profile -> `AgentConfig` projection (`runtime/src/compose.rs:196-204`).
 *
 * The step cap is floored at [MIN_STEPS]: the engine loop runs
 * `for step in 0..max_steps`, so `max_steps = 0` means ZERO steps (not
 * unlimited). A profile that leaves the cap unset therefore gets a high cap
 * instead of an engine that cannot take a single step (studio W218).
 */

import { compressionEnabled } from "./compression-switch.js";
import { defaultAgentConfig, withCompressionPhilosophy, type AgentConfig } from "@celestea/core";
import type { Profile } from "./profile.js";

/** Step-cap floor: covers realistic long turns while still bounding runaway loops. */
export const MIN_STEPS = 4096;
/** Trim factor of the window that triggers old-message trimming. */
export const CONTEXT_TRIM_THRESHOLD = 0.8;
/** How many most-recent messages survive a trim (plus the system message). */
export const CONTEXT_KEEP_RECENT = 10;

/**
 * Derive the loop configuration from a profile (identity prompt included).
 *
 * The compression philosophy is merged in HERE, not in the studio prompt chain
 * and not per step, because this is the last point that touches
 * `system_prompt`. Three consumers estimate it — the loop's trim budget, the
 * 0b dedup visibility simulation and the statusline's `contextUsage` — and they
 * only agree if all three read the SAME final string. Appending it at each
 * step instead would make the dedup simulation cut shallower than the real
 * loop does, which is exactly the divergence `turn-context-dedup.ts` is built
 * never to have; and routing it through the studio prompt chain would let a
 * `USER_OVERRIDE` system prompt drop the philosophy entirely. An explicit
 * `overrides.system_prompt` still wins, because that is the caller's own
 * configuration and a projection must not fight it.
 */
export function agentConfigFromProfile(profile: Profile, overrides: Partial<AgentConfig> = {}): AgentConfig {
  const base = defaultAgentConfig();
  const steps = profile.max_steps > 0 ? profile.max_steps : MIN_STEPS;
  const configured = {
    ...base,
    model: profile.model,
    system_prompt: profile.system_prompt,
    max_steps: steps,
    max_parallel_tool_calls: profile.max_parallel_tool_calls,
    context_window_tokens: profile.context_window_tokens,
    context_trim_threshold: CONTEXT_TRIM_THRESHOLD,
    context_keep_recent: CONTEXT_KEEP_RECENT,
    ...overrides,
  };
  return compressionEnabled()
    ? { ...configured, system_prompt: withCompressionPhilosophy(configured.system_prompt) }
    : configured;
}
