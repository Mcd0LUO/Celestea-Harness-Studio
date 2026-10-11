/**
 * W9350: `GET /api/sessions/{id}/skills` — the session's SKILL LISTING
 * (docs/feature/skill-command.md §4 slice 1).
 *
 * ## Why the frontend cannot do without it
 *
 * Skills used to have exactly ONE arrival path: the model read the catalog the
 * engine injects every turn and decided for itself whether to call `load_skill`.
 * The human had no way to ask for one by name. This endpoint is the missing half
 * of that story — without it the completion box cannot list the skills, cannot
 * validate a typed name, and cannot group them, so `/{skill}` stays unreachable.
 *
 * ## What this file is NOT allowed to do
 *
 * It does **not** read the disk. Discovery belongs to the engine: the skills a
 * model can load are whatever `listSkills(readLayers(workspace, {env}))` returns,
 * and a host-side scan would be a SECOND answer to the same question — the
 * "visible in the UI, unreachable in the session" bug. So the handler asks the
 * adapter seam ([sessionSkills]) and projects what it is handed. The session's
 * workspace path and the env that resolves `$CELESTEA_HOME` are chosen by the
 * composer, exactly as they are for the per-turn catalog row.
 *
 * ## Shape and the four answers
 *
 * `{ ok, session, skills, rejected }`, always all four keys:
 *
 *   · skills[]  — the four wire keys per row (name / description / source /
 *     dir). The rest of core's SkillDefinition (frontmatter metadata, the file
 *     path) stays inside the process: this is a LISTING, not a dump.
 *   · rejected[] — skills found but refused (bad frontmatter, name ≠ directory).
 *     A broken override is VISIBLE here instead of silently vanishing from the
 *     list, which is the difference between "I have no such skill" and "your
 *     skill is broken and here is why".
 *   · an unknown id is the shared `require()` refusal (404), never an empty
 *     list — "this session does not exist" and "this session has no skills" are
 *     different answers.
 *   · no workspace (the detached generation) = an empty listing, not an error:
 *     the engine reports the empty listing there too (see [skillListingOf]).
 *
 * ## No caching, no generation swap
 *
 * The catalog is re-read at the START OF EVERY TURN, so this endpoint reads live
 * and stores nothing — a per-session snapshot would be the only stale answer the
 * system could give. It invalidates nothing either: a read cannot change what the
 * running turn sees.
 */

import type { Hono } from "hono";
import type { SkillDefinition, SkillListing, SkillRejection } from "@celestea/core";
import type { RouteTable } from "../routes.js";
import { storeFail, type Deps } from "./common.js";

/** The answer of an adapter that owns no skill discovery (the fake engine). */
const NO_SKILLS: SkillListing = { skills: [], rejected: [] };

/** One skill as the wire sees it: four keys, nothing else leaves the process. */
function skillRow(skill: SkillDefinition): Record<string, unknown> {
  return { name: skill.name, description: skill.description, source: skill.source, dir: skill.dir };
}

/** One rejected skill, with the reason `listSkills` recorded. */
function rejectedRow(rejected: SkillRejection): Record<string, unknown> {
  return { name: rejected.name, dir: rejected.dir, file: rejected.file, source: rejected.source, reason: rejected.reason };
}

export function registerSessionSkills(app: Hono, deps: Deps, table: RouteTable): string[] {
  const route = table.get("get_session_skills");
  app.on(route.method, route.honoPath, (c) => {
    // `require`, like every other session-scoped read: an id that names no live
    // session is the contract's 404, and the handler adds no semantics of its own.
    const resolved = deps.sessions.require(c.req.param("id") ?? "");
    if (!resolved.ok) return storeFail(c, resolved);
    // Optional seam (same rule as `sessionTools`): an adapter without workspace
    // resolution answers the empty listing. It is a PURE projection — the body is
    // built once, from the listing the engine hands over.
    const listing = deps.runtime.sessionSkills?.(resolved.value.id) ?? NO_SKILLS;
    return c.json({
      ok: true,
      session: resolved.value.id,
      skills: listing.skills.map(skillRow),
      rejected: listing.rejected.map(rejectedRow),
    });
  });
  return [route.id];
}
