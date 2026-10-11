/**
 * W9346 — the session GOAL's two model-facing wirings, kept out of
 * `session-compose.ts` so that file stays inside its line budget.
 *
 * A goal the model cannot see is a sticky note for the human only, so `/goal`
 * now produces TWO artifacts (see `handlers/session-goal.ts` for the storage and
 * the notice texts):
 *
 *   · the RESIDENT row — recomputed at every turn start from the current
 *     `goal.json`, because it is a pure function of `text` + `paused`. It rides
 *     the same dedup as the skill catalog, so an unchanged goal is not appended
 *     once per turn;
 *   · the CHANGE NOTICE — the stored `pending`, appended AFTER the turn's user
 *     input row and cleared only once it is in the log.
 *
 * Both are absent for a detached generation, which has no session directory and
 * therefore nowhere for a goal to live.
 */

import type { AfterInputPlan, AfterInputRow, AfterInputSource } from "@celestea/agent-loop";
import { listSkills, memoryContextOf, readLayers, renderSkillCatalog, type SkillListing, type SourceLayer } from "@celestea/core";
import type { TurnContextRow } from "@celestea/runtime";
import { consumePending, readGoalState } from "../handlers/session-goal.js";

/**
 * The resident rows of THIS session's goal, or none for a generation with no dir.
 *
 * Exported through [goalTurnContext] so `session-compose.ts` keeps a single
 * provider: the goal is turn context like the skill catalog, just with no
 * workspace to read.
 */
export function goalResidentRow(sessionId: string | null, dir: string | null): (() => readonly TurnContextRow[]) | undefined {
  if (sessionId === null || dir === null) return undefined;
  return (): readonly TurnContextRow[] => {
    const goal = readGoalState(dir, sessionId).goal;
    if (goal === null) return [];
    const text = goal.paused === true ? `[目标·已暂停] ${goal.text}（暂停期间不要推进这个目标）` : `[目标] ${goal.text}`;
    return [{ text, origin: "goal" }];
  };
}

/** [goalResidentRow], defaulted to the empty provider a session without one gets. */
export function goalTurnContext(sessionId: string | null, dir: string | null): () => readonly TurnContextRow[] {
  return goalResidentRow(sessionId, dir) ?? ((): readonly TurnContextRow[] => []);
}

/**
 * W9350: the ONE skill read of a workspace — shared by the per-turn catalog row
 * ([turnContextFor]) and by `GET /api/sessions/{id}/skills` (the real adapter's
 * [sessionSkills]). Both call THIS, so the `readLayers` input (the workspace path
 * AND the env that resolves `$CELESTEA_HOME`) is written down once.
 *
 * **Why that matters more than it looks.** ZCode shipped the bug this exists to
 * prevent: its UI discovered skills by scanning disk itself, and a skill that
 * loaded in the session was invisible in the box (and the reverse). Two reads of
 * the same concept drift the moment one of them is edited. The frontend does NOT
 * get a second read either — it asks this endpoint, which asks this function.
 *
 * `null` workspace = a generation with no workspace (the detached one): the
 * honest answer is an EMPTY listing, never a throw and never a fallback path —
 * the same rule the catalog row follows (it simply contributes nothing).
 *
 * It lives here rather than in a new module because this file is already the
 * owner of "the workspace rows a turn reads"; the skill WIRING proper (loading a
 * body, injecting it) is `skill-wiring.ts`, which reaches the SAME layers through
 * [skillLayersOf] below.
 */
export function skillListingOf(workspacePath: string | null, env: NodeJS.ProcessEnv | undefined): SkillListing {
  return listSkills(skillLayersOf(workspacePath, env));
}

/**
 * W9351: the READ LAYERS themselves — the one place `readLayers` is called with a
 * workspace path and the env that resolves `$CELESTEA_HOME`.
 *
 * Why the layers and not just the listing: the endpoint and the catalog need the
 * NAMES, but a `/skill:<name>` invocation needs the BODY of the very same
 * discovery (`loadSkillBody` walks the same array in the same priority order). So
 * both sides go through this function rather than the second one re-deriving a path
 * or reading a different env — "the skill the box listed" and "the skill the turn
 * loaded" are the same fact only while they are the same call.
 *
 * `null` workspace (the detached generation) = NO layers, never a fallback root:
 * the honest answer is "this session can load nothing", which is exactly what the
 * empty listing said before it.
 */
export function skillLayersOf(workspacePath: string | null, env: NodeJS.ProcessEnv | undefined): readonly SourceLayer[] {
  if (workspacePath === null) return [];
  return readLayers(workspacePath, { env });
}

/**
 * W884 + F3 + W9346: the engine-owned TURN CONTEXT of one session generation.
 *
 * The skill catalog (name + description ONLY) and the workspace MEMORY.md are
 * re-read at EVERY turn start from the SAME workspace the sandbox/guard use
 * (W768) and injected as durable user-role history. Neither is ever put in the
 * system prompt. W9346's goal is the THIRD row, and the one nearest the human's
 * message — it is what the turn is about.
 *
 * It lives here rather than beside the composer because that file sits exactly at
 * the 450-line cap and the ratchet only goes down. A workspace with neither
 * catalog nor memory produces NO rows (zero cost); a generation with no workspace
 * (detached) contributes nothing but the goal.
 */
export function turnContextFor(
  workspacePath: string | null,
  goal: () => readonly TurnContextRow[],
  env: NodeJS.ProcessEnv | undefined,
): () => readonly TurnContextRow[] {
  if (workspacePath === null) return goal;
  return (): readonly TurnContextRow[] => {
    const rows: TurnContextRow[] = [];
    const catalog = renderSkillCatalog(skillListingOf(workspacePath, env));
    if (catalog !== null) rows.push({ text: catalog, origin: "skill" });
    const memory = memoryContextOf(workspacePath, { env });
    if (memory !== null) rows.push({ text: memory, origin: "memory" });
    rows.push(...goal());
    return rows;
  };
}

/**
 * The after-input notice source, and the ONLY place the pending slot is emptied.
 *
 * The read is a PEEK: the turn runner calls it once before selecting the resident
 * rows — to suppress the duplicate goal line in a turn that will deliver a notice
 * — and the loop calls it again at the input row. Neither call mutates. Only
 * `delivered`, which the loop runs AFTER the row reached the log, calls
 * `consumePending`; a turn that dies before the append therefore leaves the
 * notice for the next turn instead of losing it, and a delivered delete removes
 * the sidecar at last.
 *
 * W9351: it answers with a PLAN whose `input` is left undefined — "write the user
 * row exactly as it arrived". It never rewrites what the human said; only a
 * gesture producer does, and only for the token it consumed.
 */
export function goalNotice(sessionId: string | null, dir: string | null): AfterInputSource | undefined {
  if (sessionId === null || dir === null) return undefined;
  return () => {
    const pending = readGoalState(dir, sessionId).pending;
    if (pending === null) return { rows: [] };
    return { rows: [{ text: pending.text, origin: "goal", delivered: () => consumePending(dir, sessionId) }] };
  };
}

/**
 * W9351: ONE after-input lane out of the producers that want one.
 *
 * Two producers ship today — the goal notice and the `/skill:<name>` body — and
 * they are combined HERE rather than by letting each write its own lane, because
 * the lane's contract is a single ordered list of rows in a single position (right
 * after the input). Two lanes would make "which came first" a per-pair accident
 * instead of the argument order written down once.
 *
 * The order is the argument order, and it is semantic: the goal notice describes
 * an EARLIER change and the skill body answers THIS turn, so the body is the row
 * nearest the model's answer.
 *
 * `input` is taken from the FIRST producer that rewrote it (last-writer-wins would
 * make "who gets to eat the gesture token" a race between producers). `undefined`
 * from every producer means "append exactly what the caller passed".
 *
 * No producer at all answers `undefined`, which is what keeps a session with
 * neither a goal nor a gesture byte-identical to a pre-W9346 loop.
 */
export function mergeAfterInputs(...sources: readonly (AfterInputSource | undefined)[]): AfterInputSource | undefined {
  const present = sources.filter((source): source is AfterInputSource => source !== undefined);
  if (present.length === 0) return undefined;
  return (userInput: string | null): AfterInputPlan => {
    const rows: AfterInputRow[] = [];
    let input: string | undefined;
    for (const source of present) {
      const plan = source(userInput);
      if (input === undefined && plan.input !== undefined) input = plan.input;
      rows.push(...plan.rows);
    }
    return { ...(input === undefined ? {} : { input }), rows };
  };
}
