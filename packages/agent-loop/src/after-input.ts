/**
 * W9351 — the after-input lane's CONTRACT, kept out of loop.ts because that file
 * sits on its 450-line cap and the ratchet only goes down.
 *
 * What the host gets is an INPUT TRANSFORMER: it sees this turn's `userInput` and
 * answers with a plan — the user row to write, plus the rows to append right after
 * it. W9346 gave this lane one producer (the session goal's change notice, one
 * row, one hard-coded origin); W9351 ships a second (`/skill:<name>`), and two
 * producers on one lane is what turned the callback into these three types.
 *
 * The module is pure: no seam, no Context, no log. The loop owns the POSITION and
 * the containment, and calls [resolveAfterInput] to get the answer.
 */

import type { SessionEventOrigin } from "@celestea/core";

/**
 * W9351: ONE row appended right after this turn's input, plus the
 * acknowledgement that ends its life.
 *
 * `origin` is NOT optional and NOT free-form: the transcript labels the block
 * from it, and a row that could claim to be `user` would let a host forge the
 * human's own voice in the log — the one thing the whole origin whitelist exists
 * to prevent. The allowed values are the closed `SESSION_EVENT_ORIGINS` set minus
 * `user` (core/types.ts).
 *
 * `delivered` rather than a separate `clearPending` callback: the two can never
 * be called in the wrong order, because the loop only holds this one object, and
 * it is called ONLY after that row reached the log.
 */
export interface AfterInputRow {
  readonly text: string;
  readonly origin: Exclude<SessionEventOrigin, "user">;
  readonly delivered: () => void;
}

/** W9351: what an [AfterInputSource] answers for ONE turn. */
export interface AfterInputPlan {
  /**
   * The user row to append, or `undefined` = "append exactly what the caller
   * passed" (what the goal producer wants). `""` means "nothing survives the
   * transform" and writes NO row — a gesture-only `/review` leaves the skill
   * body as the turn's whole user content, so no empty bubble is ever written.
   */
  readonly input?: string;
  /** Appended in order right after the input row, each with its own origin. */
  readonly rows: readonly AfterInputRow[];
}

/**
 * W9351: the host hook, called once per turn with this turn's `userInput`
 * (`null` when the turn carries none).
 *
 * **Pure by contract.** The turn runner peeks it before the turn (`peekAfterInput`
 * needs to know whether a goal notice is coming) and the loop calls it at the input
 * row, so a source that mutated would deliver twice or contradict its own
 * suppression decision.
 */
export type AfterInputSource = (userInput: string | null) => AfterInputPlan;

/** No source at all: the turn keeps the input it was given and appends no row. */
const NONE: AfterInputPlan = { rows: [] };

/**
 * W9351: ask the host once, contained.
 *
 * A throwing source degrades to "no transform at all" — the same containment the
 * step-boundary drain applies: a broken host channel must not fail the turn the
 * human actually asked for. An absent source is byte-identical to a pre-W9346
 * loop, which is why the empty case is a value rather than a branch at the call.
 *
 * `report` is injected so this stays pure (no `process` here) and so a test can
 * see the failure without capturing stderr.
 */
export function resolveAfterInput(source: AfterInputSource | undefined, userInput: string | null, report: (line: string) => void): AfterInputPlan {
  if (source === undefined) return NONE;
  try {
    return source(userInput);
  } catch (e) {
    report(`[celestea-agent-loop] afterInput source failed: ${String(e)}`);
    return NONE;
  }
}
