/** 
 * `POST /api/sessions/{id}/goal` — the session's PERSISTENT GOAL (A3, W9209).
 *
 * The frontend half shipped long ago (ui/commands/builtin.ts registers `/goal`,
 * ui/commands/goal.ts calls `api.setGoal`, statusline/goal.ts renders the badge,
 * types/goal.ts declares the wire shape) but the endpoint never existed, so every
 * `/goal` fell through to the `/api/*` 404 fallback and could never succeed.
 * This file is the missing half.
 *
 * ## Storage: `<session-dir>/goal.json`
 *
 *   `{ version: 1, session, text, paused?, created_at, updated_at, pending? }`
 *
 * Deliberately NOT `session.json`: that file is a creation-time property bag whose
 * writer (store/session-meta.ts) drops every empty field and returns WITHOUT writing
 * when they are all empty — so a goal could never be CLEARED through it. A goal is
 * mutable state with a delete semantic, which is what a dedicated sidecar is for
 * (the grants.json / tools.json / permission.json precedent).
 *
 * ## Clear semantics
 *
 * `text: ""` (or whitespace-only) DELETES the goal. `created_at` is PRESERVED
 * across a replace (only `updated_at` moves), so "when was this goal set" survives
 * an edit.
 *
 * ## Fail-safe read
 *
 * A missing file is "no goal" with no warning; a corrupt / foreign /
 * unknown-version file is "no goal" PLUS one `warnings[]` entry — never a
 * repair, never a crash (the discipline of store/grants.ts and store/session-tools.ts).
 *
 * ## Wire shape
 *
 * `{ ok, session, goal }` with `goal` either `null` or
 * `{ text, paused, createdAt, updatedAt }`. The two timestamps are camelCase
 * ISO-8601 strings because that is what the ALREADY-SHIPPED frontend reads
 * (ui/commands/goal.ts `normalize()` reads `r['createdAt']` / `r['updatedAt']`) and
 * `apps/web` is outside this change's file boundary. On disk they are epoch SECONDS,
 * like every other `updated_at` in this repo. `paused` is ALWAYS present (false
 * while active) so a client never has to tell "absent" from "false".
 *
 * ## W9346 — the goal became MODEL-visible, through TWO artifacts
 *
 * A goal the model cannot see is a sticky note for the human only: `/goal` said
 * 「已设定」 and nothing in the conversation ever mentioned it. A change now leaves
 * two DIFFERENT artifacts, and this file only decides WHAT they say — the engine
 * (runtime/session-compose.ts) decides when either reaches a turn:
 *
 *   1. **the resident row** — NOT stored. It is a pure function of the CURRENT
 *      record (`[目标] <text>`, or `[目标·已暂停] …` while paused), recomputed at
 *      every turn start, so an edit never needs a second copy to keep in sync;
 *   2. **the pending notice** — stored, because it is NOT a function of the current
 *      state: `[目标] 已删除（原目标：X）` names a text that no longer exists
 *      anywhere, and a pause later resumed would leave the model having only ever
 *      seen the resumed state. Its text is frozen AT THE MOMENT OF THE CHANGE
 *      (`pending.text`) and delivered in the NEXT turn, then cleared.
 *
 * **An equivalent write produces NO notice** (same `text` AND same `paused` as the
 * file on disk ⇒ no `pending`), and neither does deleting a session that already
 * has no goal. Otherwise re-posting the same goal would stream an endless 「已更新」
 * into the transcript.
 *
 * ### The one place this file's W9209 rule had to be refined (named, not hidden)
 *
 * W9209 said "absence is the ONE representation of no goal, so clear DELETES the
 * file". W9346 requires the delete notice to survive until the next turn, and its
 * text is the text being deleted — so between the delete and the delivery the FILE
 * exists while the GOAL does not. The refinement: such a record is a valid
 * `goal.json` that `readGoalState` reports as `goal: null` + a `pending`, and the
 * delivery (one turn later) removes the file for real. The HTTP echo is `goal:null`
 * throughout, exactly as the contract requires; only the on-disk residue, whose
 * whole content is a note addressed to the model, is new.
 *
 * ## What is still NOT here — and why there is no busy guard
 *
 * The goal still does not DRIVE auto-continuation: a change never starts a turn
 * (the frozen P0 decision, docs/archive/decisions/iteration-g-workbench.md §2). The
 * notice is carried by the NEXT turn, whenever the human next speaks; an idle
 * session simply waits.
 *
 * Because nothing about a session's GENERATION changes here, no 409 guard is taken
 * and no session instance is invalidated — unlike PUT .../tools or PUT .../model,
 * whose writes DO swap a generation. What changes instead is the model's VIEW of the
 * next turn, which is the whole point (and the same shape as the resident skill
 * catalog: injected as history, never into the system prompt).
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import type { RouteTable } from "../routes.js";
import { SerialQueue } from "../serial-queue.js";
import { readJsonIfExists, writeJsonAtomic } from "../store/fs-json.js";
import { nowSec } from "../store/grants-service.js";
import { errText } from "../store/result.js";
import { failJson, readJsonBody, strField, storeFail, type Deps } from "./common.js";

/** The sidecar file, beside session.json inside the session directory. */
export const GOAL_FILE = "goal.json";

/** W9346: what a change did — the closed set stored in `pending.kind`. */
export type GoalChangeKind = "set" | "edit" | "pause" | "resume" | "delete";

/**
 * W9346: the one-shot notice waiting for the NEXT turn.
 *
 * `text` is rendered at the moment of the change and never re-rendered, because
 * the state it describes is gone by the time it is delivered (that is the whole
 * point of the delete notice quoting the text it deletes).
 */
export interface GoalPending {
  id: string;
  kind: GoalChangeKind;
  text: string;
  /** Epoch SECONDS, like every other `*_at` in this repo. */
  at: number;
}

/** One stored goal (epoch SECONDS; the wire view converts to ISO-8601). */
export interface GoalRecord {
  version: number;
  session: string;
  text: string;
  /** Optional on disk: a pre-W9346 file has none (absent = false). */
  paused?: boolean;
  created_at: number;
  updated_at: number;
  /** Optional on disk: absent = nothing is waiting to be delivered. */
  pending?: GoalPending;
}

/**
 * The READ OUTCOME, and the only thing the engine needs: the live goal, the
 * notice waiting for the next turn, and (only for a structurally unusable file)
 * why it was ignored.
 */
export interface GoalState {
  /** The goal as it stands, or null for "no goal". */
  goal: GoalRecord | null;
  /** The undelivered notice, or null. Survives a delete (the goal is null then). */
  pending: GoalPending | null;
  /** Set only when an EXISTING file was structurally unusable. */
  warning?: string;
}

/**
 * One queue per process: the write is a read-modify-write of `created_at`, so two
 * concurrent POSTs would otherwise interleave and lose the earlier timestamp (the
 * display-plugins precedent, handlers/display-plugins.ts).
 */
const writes = new SerialQueue();

/** Internal marker for the 422 the "no goal to pause" case answers. */
const NO_GOOD_TO_PAUSE = "cannot pause: no goal";

function goalPath(dir: string): string {
  return join(dir, GOAL_FILE);
}

/**
 * Read + validate; NEVER throws. A missing file and a void file both answer "no
 * goal" — the difference is only whether a warning is reported.
 *
 * W9346: `paused` and `pending` are OPTIONAL, so a pre-W9346 file (and one
 * hand-written by an older build) keeps reading. A `pending` that does not
 * validate is DROPPED, not fatal: losing one notice is recoverable, losing the
 * goal is not.
 */
export function readGoalState(dir: string, session: string): GoalState {
  const out = readJsonIfExists(goalPath(dir));
  if (!out.exists) return { goal: null, pending: null };
  const voided = (reason: string): GoalState => ({ goal: null, pending: null, warning: "goal_unreadable: " + reason });
  if (out.error !== undefined) return voided("unparsable goal.json: " + out.error);
  const value = out.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return voided("goal.json is not an object");
  const rec = value as Record<string, unknown>;
  if (rec["version"] !== 1) return voided("unknown goal.json version " + JSON.stringify(rec["version"]));
  if (rec["session"] !== session) return voided("goal.json belongs to " + JSON.stringify(rec["session"]));
  const text = rec["text"];
  if (typeof text !== "string" || text === "") return voided("goal.json has no non-empty text");
  const created = rec["created_at"];
  const updated = rec["updated_at"];
  if (typeof created !== "number" || typeof updated !== "number") return voided("goal.json has no numeric timestamps");
  const paused = rec["paused"] === true; // anything but `true` is the old default
  const pending = readPending(rec["pending"]);
  // A delete whose notice is still undelivered: the goal is ALREADY gone (the
  // echo must say `goal: null`), the record survives only to carry the notice.
  if (pending !== null && pending.kind === "delete") return { goal: null, pending };
  const goal: GoalRecord = { version: 1, session, text, created_at: created, updated_at: updated };
  if (paused) goal.paused = true;
  return { goal, pending };
}

/** Is this `pending` a usable notice? A malformed one is dropped, never fatal. */
function readPending(value: unknown): GoalPending | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const kind = rec["kind"];
  if (kind !== "set" && kind !== "edit" && kind !== "pause" && kind !== "resume" && kind !== "delete") return null;
  if (typeof rec["id"] !== "string" || rec["id"] === "") return null;
  if (typeof rec["text"] !== "string" || rec["text"] === "") return null;
  const at = rec["at"];
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  return { id: rec["id"], kind, text: rec["text"], at };
}

/** Delete the sidecar. Used by the no-goal paths and by the delivery. */
export function clearGoal(dir: string): void {
  rmSync(goalPath(dir), { force: true });
}

/**
 * Write the record. `paused` and `pending` are omitted when they are absent, so a
 * never-paused, never-pending goal is byte-shaped exactly like a pre-W9346 file
 * (the round-trip test pins this).
 */
export function writeGoal(dir: string, record: GoalRecord): void {
  const out: Record<string, unknown> = {
    version: 1,
    session: record.session,
    text: record.text,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
  if (record.paused === true) out["paused"] = true;
  if (record.pending !== undefined) out["pending"] = record.pending;
  writeJsonAtomic(goalPath(dir), out, { mode: 0o644 });
}

/**
 * W9346: the notice text, rendered AT THE MOMENT OF THE CHANGE.
 *
 * Every one of them names the goal's text: a notice that does not say WHICH goal
 * changed is unreadable in a transcript that may hold several goal changes over its
 * lifetime. The delete notice quotes the ORIGINAL text, because after the write
 * that text exists nowhere else.
 */
export function goalNoticeText(kind: GoalChangeKind, text: string): string {
  switch (kind) {
    case "set":
      return `[目标] 已设定：${text}`;
    case "edit":
      return `[目标] 已更新：${text}`;
    case "pause":
      return `[目标] 已暂停：${text}`;
    case "resume":
      return `[目标] 已恢复：${text}`;
    case "delete":
      return `[目标] 已删除（原目标：${text}）`;
  }
}

/** The notice id: never used for lookup (the pending slot is a singleton). */
function noticeId(now: number, session: string): string {
  return `goal-${now}-${session.replace(/[^a-zA-Z0-9]+/g, "-")}`;
}

function noticeFor(kind: GoalChangeKind, text: string, session: string, now: number): GoalPending {
  return { id: noticeId(now, session), kind, text: goalNoticeText(kind, text), at: now };
}

/** The wire view of one record (null = no goal). */
function goalView(record: GoalRecord | null): Record<string, unknown> | null {
  if (record === null) return null;
  return {
    text: record.text,
    // ALWAYS present (false while active): "absent" and "false" must be
    // indistinguishable to a client, or every renderer needs a tri-state.
    paused: record.paused === true,
    createdAt: new Date(record.created_at * 1000).toISOString(),
    updatedAt: new Date(record.updated_at * 1000).toISOString(),
  };
}

/**
 * W9346 · POST /api/sessions/{id}/goal — set/edit (`text` non-empty), clear
 * (`text: ""`) and pause/resume (`paused`). At least one of the two must be given.
 */
export function registerGoal(app: Hono, deps: Deps, table: RouteTable): string[] {
  const route = table.get("post_session_goal");
  app.on(route.method, route.honoPath, async (c) => {
    // `require` (not `resolve`): a goal needs a real session directory to live in,
    // so an id that names no session is the contract's 404 — and a `worker:<sid>` id
    // (no directory by construction) is rejected here as well.
    const resolved = deps.sessions.require(c.req.param("id") ?? "");
    if (!resolved.ok) return storeFail(c, resolved);
    const session = resolved.value.id;
    const body = await readJsonBody(c);
    if (!body.ok) return body.response;
    const field = strField(c, body.body, "text");
    if (!field.ok) return field.response;
    const pausedField = body.body["paused"];
    if (pausedField !== undefined && pausedField !== null && typeof pausedField !== "boolean") {
      return failJson(c, 422, "field 'paused' must be a boolean");
    }
    if (field.value === undefined && pausedField === undefined) {
      return failJson(c, 422, "field 'text' must be a string");
    }
    // Trimmed on the server too: the frontend already sends a trimmed value, so
    // this is a no-op on the UI path and normalization for an API caller. A
    // whitespace-only goal is indistinguishable from "clear" by design.
    const text = field.value?.trim();
    const now = nowSec(deps.grants);
    try {
      const outcome = await writes.run(async (): Promise<GoalState> => applyChange(resolved.value.dir, session, text, pausedField === true ? true : pausedField === false ? false : null, now));
      if (outcome.warning === NO_GOOD_TO_PAUSE) return failJson(c, 422, NO_GOOD_TO_PAUSE);
      const warnings = outcome.warning === undefined ? [] : [outcome.warning];
      return c.json({
        ok: true,
        session,
        goal: goalView(outcome.goal),
        ...(warnings.length === 0 ? {} : { warnings }),
      });
    } catch (e) {
      return failJson(c, 500, "cannot persist goal: " + errText(e));
    }
  });
  return [route.id];
}

/**
 * W9346 · the ONE write path. `text` lands first and `paused` second, so a single
 * `{text, paused}` request means "this goal, and it starts paused" rather than a
 * pause of a goal that does not exist yet.
 *
 * Returns the state as it is ON DISK afterwards (never as it was meant to be), and
 * the `NO_GOOD_TO_PAUSE` marker when the request tried to pause a session with no
 * goal. The two writes are re-read between them so the second sees the first.
 */
function applyChange(dir: string, session: string, text: string | undefined, paused: boolean | null, now: number): GoalState {
  let state = readGoalState(dir, session);
  if (text !== undefined) {
    const previous = state.goal;
    if (text === "") {
      // Deleting a session that already has no goal is a NO-OP: there is nothing
      // to tell the model about, and no file to rewrite.
      if (previous !== null) {
        writeGoal(dir, {
          version: 1,
          session,
          text: previous.text,
          created_at: previous.created_at,
          updated_at: now,
          pending: noticeFor("delete", previous.text, session, now),
        });
      }
      state = readGoalState(dir, session);
    } else if (previous !== null && previous.text === text && previous.pending === undefined) {
      // An equivalent text write earns NO notice; an undelivered older notice is
      // left alone rather than being replaced by a copy of itself.
    } else {
      writeGoal(dir, {
        version: 1,
        session,
        text,
        // `created_at` is inherited, so an edit does not look like a new goal.
        created_at: previous?.created_at ?? now,
        updated_at: now,
        pending: noticeFor(previous === null ? "set" : "edit", text, session, now),
      });
      state = readGoalState(dir, session);
    }
  }
  if (paused !== null) {
    const previous = state.goal;
    if (previous === null) {
      // A 422 (not a silent false): "pause" with no goal is a caller bug, and
      // answering "ok, nothing is paused" would hide it.
      return { goal: null, pending: state.pending, warning: NO_GOOD_TO_PAUSE };
    }
    if ((previous.paused === true) !== paused) {
      writeGoal(dir, {
        version: 1,
        session,
        text: previous.text,
        created_at: previous.created_at,
        updated_at: now,
        ...(paused ? { paused: true } : {}),
        pending: noticeFor(paused ? "pause" : "resume", previous.text, session, now),
      });
      state = readGoalState(dir, session);
    }
  }
  return state;
}

/**
 * W9346 · the delivery side: the turn has APPENDED the notice row, so the pending
 * slot is emptied on disk. A delivered delete finally removes the file.
 *
 * The caller is responsible for the order — it must reach this function only once
 * the row IS in the log. Clearing first and delivering after would LOSE the notice
 * if the append were refused.
 */
export function consumePending(dir: string, session: string): void {
  const state = readGoalState(dir, session);
  const pending = state.pending;
  if (pending === null) return;
  if (pending.kind === "delete") {
    clearGoal(dir);
    return;
  }
  const goal = state.goal;
  if (goal === null) return;
  // `updated_at` does NOT move: it answers "when did the goal last change", and a
  // delivery is not a change the client can observe.
  writeGoal(dir, {
    version: 1,
    session,
    text: goal.text,
    created_at: goal.created_at,
    updated_at: goal.updated_at,
    ...(goal.paused === true ? { paused: true } : {}),
  });
}
