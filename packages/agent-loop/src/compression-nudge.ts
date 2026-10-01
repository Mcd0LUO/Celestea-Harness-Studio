/**
 * W1900 (Phase 2) — the context-compression NUDGE: an ephemeral, system-role
 * reminder that the model may compress its own history.
 *
 * Why an ephemeral message at all, when the philosophy already lives in the
 * system prompt? Because the philosophy is STATIC (it teaches the discipline)
 * and this is DYNAMIC (it says what the current water level is). Putting a
 * number in the system prompt would change the frozen prefix on every crossing
 * and throw the prompt cache away — `loop.ts` sends ONE frozen system string,
 * and `packages/core/src/memory.ts` calls it a frozen cache-critical string.
 *
 * So the nudge takes the OTHER channel, the one `trimContext` already uses for
 * its `[context-trimmed]` marker: a synthetic message built into the derived
 * VIEW. Three properties follow, and all three are the point:
 *
 *   - it NEVER reaches the log. `buildRequest` assembles the array; nothing
 *     appends, so the reminder cannot accumulate across turns and cannot become
 *     history the model later treats as evidence of what it said;
 *   - it is never part of `config.system_prompt`, so the loop's trim budget,
 *     the 0b dedup visibility simulation and the statusline's estimate all keep
 *     reading the same string and cannot drift apart;
 *   - it is a SYSTEM-role message, which is what makes it safe here at all.
 *     `turn-context-dedup.ts` ranks NON-system messages when deciding whether a
 *     resident turn-context row is still visible; a system row is skipped by
 *     `isResident`, so a nudge can never be mistaken for a resident row and
 *     can never make one look invisible (which would force a re-injection loop).
 *     `trimContext` treats system and user as cut boundaries, so a trailing
 *     system message is also a legal cut point if a later pass trims further.
 *
 * The threshold is `COMPRESSION_NUDGE_RATIO` from core, so the number the
 * prompt quotes and the number the loop acts on are the same constant.
 */

import { COMPRESSION_NUDGE_RATIO, COMPRESSION_PREFLIGHT_RATIO, systemMessage, type ContextUsageFacts, type Message } from "@celestea/core";

/** The marker prefix, in the style of `TRIMMED_MARKER_PREFIX`. */
export const COMPRESSION_NUDGE_PREFIX = "[context-compression]";

/** The water level the nudge fires at. Re-exported so hosts quote one number. */
export const NUDGE_RATIO = COMPRESSION_NUDGE_RATIO;

/**
 * The nudge text.
 *
 * Tone is the only thing that changes with the ratio: at 0.5 it is a
 * suggestion, past the preflight ratio it is an instruction, because the
 * engine is about to start cutting the history FOR the model, and a model that
 * does not know why its context is disappearing will fight it. Between the two
 * it says which range to pick: a COLD one, never the turn in flight.
 *
 * The 0.8 branch IS the Phase 2 preflight, and it is deliberately the WHOLE of
 * it. There is no second water-level arithmetic anywhere in this feature: the
 * ratio arrives from the runtime's own `contextUsage` (the /api/status one),
 * and the fallback that already existed — `trimContext` firing at
 * `CONTEXT_TRIM_THRESHOLD`, which agent-config.ts pins to the same 0.8 — keeps
 * firing whether or not the model ever calls `compress`. So the preflight
 * promise is: the engine never sends an over-budget request, and at the exact
 * ratio where it would start, the model is told WHY one step earlier. Building
 * a separate preflight check would mean a second number that could disagree
 * with the one the statusline shows.
 */
export function compressionNudgeText(usage: ContextUsageFacts, currentTurn: number): string {
  const insisting = usage.ratio >= COMPRESSION_PREFLIGHT_RATIO;
  const head = COMPRESSION_NUDGE_PREFIX + " The context is at " + String(Math.round(usage.ratio * 100)) + "% of the window (turn " + String(currentTurn) + ").";
  if (insisting) {
    return (
      head +
      " The engine is close to trimming earlier history for you, which is LOSSY. If there is a COLD range" +
      " of earlier turns you can live without, compress it now with the compress tool: a summary you wrote" +
      " keeps the facts, a trim keeps nothing. Never compress the turn you are answering in."
    );
  }
  return (
    head +
    " You MAY compress a COLD range of earlier turns with the compress tool to buy headroom. It is optional:" +
    " if the recent history is all you need, leave it alone. Never compress the turn you are answering in," +
    " and never a range you are still reasoning across."
  );
}

/** True when the water level is at or past the nudge threshold. */
export function shouldNudge(usage: ContextUsageFacts | null): usage is ContextUsageFacts {
  return usage !== null && usage.window > 0 && usage.ratio >= COMPRESSION_NUDGE_RATIO;
}

/**
 * The nudge as ONE ephemeral message, or `null` when the level is below the
 * threshold — or unknown: an absent water level is never a reason to nag, and
 * a nudge that fires without a number is a nudge the model cannot act on.
 */
export function compressionNudgeMessage(usage: ContextUsageFacts | null, currentTurn: number): Message | null {
  if (!shouldNudge(usage)) return null;
  return systemMessage(compressionNudgeText(usage, currentTurn));
}
