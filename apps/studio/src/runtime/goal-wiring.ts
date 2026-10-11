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

import type { AfterInputRow } from "@celestea/agent-loop";
import { listSkills, memoryContextOf, readLayers, renderSkillCatalog } from "@celestea/core";
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
    const catalog = renderSkillCatalog(listSkills(readLayers(workspacePath, { env })));
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
 */
export function goalNotice(sessionId: string | null, dir: string | null): (() => AfterInputRow | null) | undefined {
  if (sessionId === null || dir === null) return undefined;
  return () => {
    const pending = readGoalState(dir, sessionId).pending;
    if (pending === null) return null;
    return { text: pending.text, delivered: () => consumePending(dir, sessionId) };
  };
}
