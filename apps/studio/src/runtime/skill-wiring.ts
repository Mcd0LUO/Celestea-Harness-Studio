/**
 * W9351 — `/{技能名}` direct invocation: the host side of
 * `docs/feature/skill-command.md` slice 3.
 *
 * Until now a skill had exactly ONE arrival path: the per-turn catalog (name +
 * description) and a MODEL decision to call `load_skill`. The human had no way to
 * name one. This module is the human's way, and it is deliberately deterministic:
 * the host recognises the gesture, reads the body off disk and injects it, so
 * nothing depends on the model choosing to look.
 *
 * Three rules this file exists to enforce, and each one has a failure that only
 * shows up in production:
 *
 *   1. **The gesture is parsed by ONE function** — `parseSlashGesture` from
 *      `@celestea/gesture`, the same leaf the composer uses. If the host grew its
 *      own looser regex the transcript would show 「技能已加载」 for a line the host
 *      never recognised (or the reverse), and that is worse than no feature.
 *   2. **The manifest is the SAME manifest** — [skillLayersOf], i.e. the very
 *      `readLayers` input the catalog and `GET /sessions/{id}/skills` use. A second
 *      read is how you get 「界面看得见、会话调不到」.
 *   3. **A miss is LOUD** — the human explicitly asked for a skill; injecting
 *      nothing and answering as if all were well is the one unacceptable answer.
 *      §3.2 of the design says so, and it is also the only outcome that lets a
 *      stale frontend cache be noticed.
 *
 * It lives beside `goal-wiring.ts` rather than inside `session-compose.ts` because
 * that file sits exactly on its 450-line cap and the ratchet only goes down.
 */

import type { AfterInputPlan, AfterInputRow, AfterInputSource } from "@celestea/agent-loop";
import { listSkills, loadSkillBody } from "@celestea/core";
import { parseSlashGesture, type SlashGesture } from "@celestea/gesture";
import { skillLayersOf } from "./goal-wiring.js";

/**
 * The injected block's origin. NOT `skill`: that value belongs to the per-turn
 * catalog and the resident dedup compares by origin, so sharing it would make the
 * catalog and this body knock each other out (design §2.1 — the trap this exact
 * value exists to avoid).
 */
export const SKILL_INVOCATION_ORIGIN = "skill-invocation" as const;

/**
 * The tag the model reads. It means ONE thing and only one: a skill BODY follows.
 * A failed invocation uses [SKILL_INVOKE_TAG] instead, so "there is a body here"
 * and "the human asked and we could not deliver" can never be confused — not by
 * the model, and not by a log reader either.
 */
export const SKILL_CONTENT_TAG = "skill_content" as const;

/** The visible failure row's tag (see [SKILL_CONTENT_TAG] for why it is not the same one). */
export const SKILL_INVOKE_TAG = "skill_invoke" as const;

/** No gesture token → this plan is "write the input exactly as it arrived". */
const PASSTHROUGH: AfterInputPlan = { rows: [] };

/** A row whose `delivered` has nothing to do — nothing is pending to consume. */
function row(text: string): AfterInputRow {
  return { text, origin: SKILL_INVOCATION_ORIGIN, delivered: () => undefined };
}

/**
 * The `<skill_content>` block of one loaded skill (design §3.3).
 *
 * The base-directory declaration is not decoration: a SKILL.md says 「read
 * `references/api.md`」, and without the base the model has no way to know that
 * means an ABSOLUTE path under the skill's own directory rather than under the
 * workspace. Child resources are still never inlined (progressive disclosure —
 * `loadSkillBody` returns the body only).
 */
export function renderSkillContent(name: string, body: string, dir: string): string {
  return [
    `<${SKILL_CONTENT_TAG} name="${name}">`,
    `# Skill: ${name}`,
    "",
    body,
    "",
    `Base directory for this skill: ${dir}`,
    "Relative paths in this skill are relative to this base directory.",
    `</${SKILL_CONTENT_TAG}>`,
  ].join("\n");
}

/** The visible failure row for a gesture that named no loadable skill. */
function failure(name: string, why: string): string {
  return [
    `<${SKILL_INVOKE_TAG} name="${name}" status="failed">`,
    `技能「${name}」加载失败：${why}`,
    "本轮没有加载任何技能正文。请确认该技能已安装在本工作区，或改用普通文字描述任务。",
    `</${SKILL_INVOKE_TAG}>`,
  ].join("\n");
}

/**
 * W9351: the skill half of this session's after-input lane, or `undefined` for a
 * generation with no workspace.
 *
 * `undefined` (rather than a source that always answers "nothing") is the same
 * shape `goalNotice` uses: a session with no workspace simply has no producer,
 * and `mergeAfterInputs` then keeps the loop byte-identical to a pre-W9351 one.
 *
 * Both accepted spellings go through the SAME arbitration and produce the SAME
 * injection (design §4 item 7): the canonical `/skill:<name>` and the bare
 * `/<name>` differ only in syntax, because `parseSlashGesture` judges a bare
 * token as a `command` and only a manifest can tell `/review` from `/help`.
 */
export function skillInvocation(workspacePath: string | null, env: NodeJS.ProcessEnv | undefined): AfterInputSource | undefined {
  if (workspacePath === null) return undefined;
  return (userInput: string | null): AfterInputPlan => {
    if (userInput === null) return PASSTHROUGH;
    // The gesture must open the line: `3/4` and `a/b` are fractions and paths,
    // not skill calls (design §3.2, and the same reason `isCommand` is
    // `startsWith("/")`).
    const gesture = parseSlashGesture(userInput.trimStart());
    if (gesture === null || gesture.kind === "mcp") return PASSTHROUGH;
    return invoke(workspacePath, env, gesture);
  };
}

/**
 * The arbitration + injection for one gesture. Split out so the lane stays a
 * one-liner and the decision can be read without the plumbing around it.
 */
function invoke(workspacePath: string, env: NodeJS.ProcessEnv | undefined, gesture: SlashGesture): AfterInputPlan {
  const layers = skillLayersOf(workspacePath, env);
  const listing = listSkills(layers);
  // A name that is not IN the listing is a miss even though its characters are
  // legal — the character set is syntax, the listing is the truth. `loadSkillBody`
  // would answer "unknown skill" too, but asking the listing first keeps the two
  // questions (does it exist / what does it say) from sharing one failure path.
  // `gesture.rest` is the user row in BOTH branches, miss included: the token has
  // been answered (by a body or by a visible failure), but the human's actual
  // words still belong to the human — swallowing them would make a mistyped skill
  // name cost the model the whole task.
  if (!listing.skills.some((skill) => skill.name === gesture.name)) {
    return { input: gesture.rest, rows: [row(failure(gesture.name, "本工作区没有这个技能（可能是技能清单已过期）"))] };
  }
  const loaded = loadSkillBody(layers, gesture.name);
  if (!loaded.ok) {
    // Listed a moment ago and unreadable now: the file moved or broke between the
    // two reads. Still a LOUD failure — the alternative is answering a question the
    // human believes was loaded.
    return { input: gesture.rest, rows: [row(failure(gesture.name, loaded.error))] };
  }
  // The token is consumed: the log keeps what the human actually said (the rest),
  // and the block below carries the skill. Design §3.2 — the rest is NOT extracted
  // into a second row; the model reads the human's own words.
  return {
    input: gesture.rest,
    rows: [row(renderSkillContent(gesture.name, loaded.body, loaded.skill.dir))],
  };
}
