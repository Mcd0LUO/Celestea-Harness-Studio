// @vitest-environment node
/**
 * W9351 · `/{技能名}` direct invocation — the HOST half of
 * `docs/feature/skill-command.md` slice 3 (afterInput generalized + deterministic
 * injection).
 *
 * The whole point of the feature is that it does NOT depend on the model. A skill
 * used to arrive only because the model read a catalog and chose `load_skill`;
 * now the human names it and the host injects the body. That is a new failure
 * mode — the transcript can claim a skill loaded while nothing was injected — so
 * this suite is built around the four ways that shape breaks:
 *
 *   ① **the token survives** — the log would show the human typing `/review` and
 *      the model ALSO seeing `/review` in the task text, i.e. the gesture was
 *      never really consumed;
 *   ② **the origin collides** — the injected row reusing the catalog's origin makes
 *      the resident dedup compare against the BODY, so the catalog is re-appended
 *      every single turn (design §2.1's exact trap);
 *   ③ **a miss is silent** — `/ghost` (typed past a stale frontend) answering as
 *      if all were well is the one outcome the design forbids;
 *   ④ **a skill row silences the goal** — the after-input lane now carries more
 *      than one producer, and the suppression peek must ask about the GOAL origin
 *      specifically, or every `/review` turn would swallow the standing
 *      `[目标] …` line.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { AfterInputPlan } from "@celestea/agent-loop";
import { SESSION_EVENT_ORIGINS, type SessionEvent } from "@celestea/core";
import { parseSessionJsonl } from "@celestea/session";
import { getJson, jsonRequest, type StudioHarness } from "../apps/studio/src/harness.test-util.js";
import { mergeAfterInputs } from "../apps/studio/src/runtime/goal-wiring.js";
import {
  SKILL_CONTENT_TAG,
  SKILL_INVOCATION_ORIGIN,
  SKILL_INVOKE_TAG,
  renderSkillContent,
  skillInvocation,
} from "../apps/studio/src/runtime/skill-wiring.js";
import { activate, makeEngineHarness, readSessionLog, runTurnWithFrames } from "../apps/studio/src/runtime/test-util.js";

const harnesses: StudioHarness[] = [];

afterEach(() => {
  for (const made of harnesses.splice(0)) made.cleanup();
});

const WORKSPACE = "sample-ws";
const S1 = WORKSPACE + "/s1";
const S1_ID = encodeURIComponent(S1);
const URL_GOAL = `/api/sessions/${S1_ID}/goal`;

/**
 * A throwaway `$CELESTEA_HOME`, so the GLOBAL read layer cannot reach whatever
 * the machine running this suite happens to have installed. The harness workspace
 * is already a per-test temp dir, so with this pinned the whole listing is a
 * function of the fixtures planted here.
 */
const HOME = mkdtempSync(join(tmpdir(), "w9351-home-"));
const ENV: NodeJS.ProcessEnv = { CELESTEA_HOME: HOME, CELESTEA_PERMISSION_DEFAULT: "", CELESTEA_PERMISSION_MAX: "" };

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

/** One REAL-engine harness: one session, the offline engine, the host's own wiring. */
function engine(): StudioHarness {
  const made = makeEngineHarness({ sessions: { s1: [] }, env: ENV });
  harnesses.push(made);
  return made;
}

/** Plant the PROJECT layer of `readLayers`: `<ws>/.celestea/skills/<name>/SKILL.md`. */
function plantSkill(workspace: string, name: string, body: string): string {
  const dir = join(workspace, ".celestea", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Use this skill whenever the user asks for a ${name}.\n---\n\n${body}\n`,
  );
  return dir;
}

/** The `user_message` rows of the harness's `s1`, in order, as plain pairs. */
function userRows(h: StudioHarness): Array<{ text: string; origin: string | undefined }> {
  return parseSessionJsonl(readSessionLog(h, "s1")).events
    .filter((e): e is Extract<SessionEvent, { type: "user_message" }> => e.type === "user_message")
    .map((e) => ({ text: e.text, origin: e.origin }));
}

/** A temp workspace standing in for `<ws>`; the producer only needs a path. */
function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "w9351-ws-"));
}

/** The pure half runs against a fixed temp workspace, planted once for the suite. */
const ARBITRATION_WS = makeWorkspace();
plantSkill(ARBITRATION_WS, "review", "REVIEW BODY LINE\nsee references/api.md");

/** The producer under test, driven directly (the arbitration half, no engine). */
function plan(line: string): AfterInputPlan {
  const source = skillInvocation(ARBITRATION_WS, ENV);
  if (source === undefined) throw new Error("expected a producer");
  return source(line);
}

/* ================================= A · arbitration (the pure half) === */

describe("W9351 A · gesture syntax + manifest arbitration", () => {
  it("★ both spellings take the SAME path and produce the SAME injection (bare /review ≡ /skill:review)", () => {
    const bare = plan("/review 帮我看看这个 PR");
    const canonical = plan("/skill:review 帮我看看这个 PR");
    // Compared on the OBSERVABLE plan only: delivered is an acknowledgement
    // closure, so two calls necessarily hold different functions and comparing
    // them by reference would assert nothing about the injection itself.
    const shape = (p: AfterInputPlan): unknown => ({
      input: p.input,
      rows: p.rows.map((r) => ({ text: r.text, origin: r.origin })),
    });
    expect(shape(canonical)).toEqual(shape(bare));
    // The token is CONSUMED: what the human said is what is left, and the block
    // below carries the skill. A log that still says "/review …" as the task would
    // have handed the model a token it is supposed to have consumed.
    expect(bare.input).toBe("帮我看看这个 PR");
    expect(bare.rows).toHaveLength(1);
    expect(bare.rows[0]?.origin).toBe(SKILL_INVOCATION_ORIGIN);
    expect(bare.rows[0]?.text).toContain(`<${SKILL_CONTENT_TAG} name="review">`);
    expect(bare.rows[0]?.text).toContain("REVIEW BODY LINE");
  });

  it("a gesture-only line writes NO user row (an empty bubble would lie: the human typed something)", () => {
    expect(plan("/review").input).toBe("");
    expect(plan("/review").rows[0]?.text).toContain("REVIEW BODY LINE");
  });

  it("leading whitespace is tolerated and sliced by the same index (one parse, one cut)", () => {
    expect(plan("  /review 干活").input).toBe("干活");
    expect(plan("  /review 干活").rows[0]?.text).toContain("REVIEW BODY LINE");
  });

  it("★ MISS is LOUD: /ghost gets a visible failure row and NO body — never silence, never a fake success", () => {
    const miss = plan("/ghost 帮我看看");
    expect(miss.rows).toHaveLength(1);
    const text = miss.rows[0]?.text ?? "";
    // Two DISTINCT tags: `<skill_content>` means "a body follows", so a failure
    // must not wear it or no reader (the model included) can tell them apart.
    expect(text).toContain(`<${SKILL_INVOKE_TAG} name="ghost"`);
    expect(text).toContain("加载失败");
    expect(text).not.toContain(`<${SKILL_CONTENT_TAG}`);
    // The REASON is the manifest's, not the loader's: "this workspace has no such
    // skill" is a different answer from "it exists but the file broke", and only
    // the LISTING can tell them apart. If the arbitration were skipped this would
    // carry the loader's own wording instead.
    expect(text).toContain("本工作区没有这个技能");
    // The token is still consumed — otherwise the human's task text would carry a
    // gesture that was answered with an error.
    expect(miss.input).toBe("帮我看看");
  });

  it("a skill the LISTING REJECTED is a miss too (the catalog and the invocation must agree on what exists)", () => {
    const ws = makeWorkspace();
    const dir = join(ws, ".celestea", "skills", "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: broken\ndescription: ok\nversion: 1.0\n---\n\nBODY\n");
    const out = skillInvocation(ws, ENV)?.("/broken 干活") ?? { rows: [] };
    expect(out.rows[0]?.text).toContain("本工作区没有这个技能");
    // `loadSkillBody` would answer with the frontmatter complaint; the listing's
    // answer must NOT leak it, because the human never asked about frontmatter.
    expect(out.rows[0]?.text).not.toContain("unknown frontmatter key");
    expect(out.input).toBe("干活");
  });

  it("the canonical spelling misses just as loudly (there is no escape hatch that fails quietly)", () => {
    const miss = plan("/skill:ghost");
    expect(miss.rows[0]?.text).toContain(`<${SKILL_INVOKE_TAG} name="ghost"`);
    expect(miss.rows[0]?.text).not.toContain(`<${SKILL_CONTENT_TAG}`);
  });

  it("legal characters are NOT a skill: the LISTING is the truth, the character set is only syntax", () => {
    // `ghost` passes the name pattern and still misses; `Review` fails the
    // character set, so it is not even a gesture and passes through untouched.
    expect(plan("/Review 干活")).toEqual({ rows: [] });
  });

  it("a non-gesture line passes through byte-for-byte (fractions, paths and plain prose are not gestures)", () => {
    for (const line of ["帮我看看 3/4", "see a/b for details", "", "  ", "/", "/foo:bar baz"]) {
      expect(plan(line), line).toEqual({ rows: [] });
      expect(plan(line).input, line).toBeUndefined();
    }
  });

  it("an /mcp:<server> line is NOT ours: this repo has no MCP, so it must pass through untouched", () => {
    expect(plan("/mcp:memory 记一下")).toEqual({ rows: [] });
  });

  it("a detached generation (no workspace) has NO producer at all, not a failing one", () => {
    expect(skillInvocation(null, ENV)).toBeUndefined();
  });
});

/* ================================================ B · the injected block === */

describe("W9351 B · the injected block's shape", () => {
  it("carries the body with the frontmatter stripped AND the base directory declaration", () => {
    const dir = plantSkill(makeWorkspace(), "review", "REVIEW BODY LINE");
    const text = renderSkillContent("review", "REVIEW BODY LINE", dir);
    expect(text).toContain(`<${SKILL_CONTENT_TAG} name="review">`);
    expect(text).toContain("# Skill: review");
    expect(text).toContain("REVIEW BODY LINE");
    // The base is what lets the model resolve 「read references/api.md」 — without
    // it that sentence has no referent.
    expect(text).toContain(`Base directory for this skill: ${dir}`);
    expect(text).toContain("Relative paths in this skill are relative to this base directory.");
    expect(text.endsWith(`</${SKILL_CONTENT_TAG}>`)).toBe(true);
    // Frontmatter is not part of the BODY contract (parseSkillFrontmatter strips it).
    expect(text).not.toContain("description: Use this skill");
  });

  it("a child resource is still NOT inlined (progressive disclosure survives this lane)", () => {
    const ws = makeWorkspace();
    const dir = plantSkill(ws, "review", "REVIEW BODY LINE\nsee references/api.md");
    writeFileSync(join(dir, "api.md"), "SECRET CHILD CONTENT");
    const text = skillInvocation(ws, ENV)?.("/review 看看").rows[0]?.text ?? "";
    expect(text).toContain("see references/api.md");
    expect(text).not.toContain("SECRET CHILD CONTENT");
  });
});

/* ============================================ C · merging the two producers === */

describe("W9351 C · one lane, two producers", () => {
  const producer = (origin: "goal" | "skill-invocation", text: string, input?: string) => () => ({
    ...(input === undefined ? {} : { input }),
    rows: [{ text, origin, delivered: () => undefined }],
  });

  it("rows keep the ARGUMENT order, and the input comes from the first producer that rewrote it", () => {
    const merged = mergeAfterInputs(producer("goal", "NOTICE"), producer("skill-invocation", "BODY", "rest"));
    const out = merged?.("original") ?? { rows: [] };
    expect(out.rows.map((r) => r.text)).toEqual(["NOTICE", "BODY"]);
    expect(out.input).toBe("rest");
  });

  it("no producer at all answers undefined, so the loop stays byte-identical to a pre-W9351 one", () => {
    expect(mergeAfterInputs(undefined, undefined)).toBeUndefined();
  });
});

/* =============================================== D · the origin whitelist === */

describe("W9351 D · the origin whitelist and the frozen schema agree", () => {
  it("`skill-invocation` is in BOTH closed sets, round-trips through the codec, and is NOT the catalog's `skill`", async () => {
    expect(SESSION_EVENT_ORIGINS).toContain("skill-invocation");
    // Design §2.1: this value exists ONLY because sharing `skill` would make the
    // resident catalog dedup compare against the injected body.
    expect(SKILL_INVOCATION_ORIGIN).not.toBe("skill");
    const { validateSessionEvent, serializeSessionEvent, parseSessionEvent } = await import("@celestea/core");
    const ev: SessionEvent = { type: "user_message", text: "<skill_content/>", origin: "skill-invocation" };
    expect(validateSessionEvent(ev).ok).toBe(true);
    const back = parseSessionEvent(serializeSessionEvent(ev));
    expect(back.ok && back.event).toEqual(ev);
    // Adding a value must not have OPENED the set.
    expect(validateSessionEvent({ type: "user_message", text: "x", origin: "skillinvocation" }).ok).toBe(false);
  });

  it("contracts/session-event.schema.json declares the SAME enum as SESSION_EVENT_ORIGINS", async () => {
    const { loadSessionEventSchema } = await import("@celestea/core");
    const schema = loadSessionEventSchema();
    const defs = schema["$defs"] as { SessionEvent: { oneOf: Array<{ title?: string; properties?: Record<string, unknown> }> } };
    const userMessage = defs.SessionEvent.oneOf.find((v) => v.title === "user_message");
    const origin = userMessage?.properties?.["origin"] as { enum?: string[] };
    expect([...(origin?.enum ?? [])].sort()).toEqual([...SESSION_EVENT_ORIGINS].sort());
  });
});

/* ============================================== E · the real engine (e2e) === */

/**
 * The main scenario, over the REAL engine: the human types `/review …`, and the
 * log must show the human's own words (the token gone) followed by the skill
 * body, labelled as an injection rather than as something they typed.
 */
describe("W9351 E · the skill reaches the model", () => {
  it("★ ORDERING: the token is consumed, and <skill_content> follows the input row under its OWN origin", async () => {
    const h = engine();
    plantSkill(h.workspace, "review", "REVIEW BODY LINE");
    await activate(h, S1);

    await runTurnWithFrames(h, "/review 帮我看看这个 PR");
    const rows = userRows(h);
    // Exact order: catalog (resident) → the human's words → the body. The body
    // must NOT come before the input, and must not be merged into it.
    expect(rows.map((r) => r.origin)).toEqual(["skill", undefined, "skill-invocation"]);
    expect(rows[1]).toEqual({ text: "帮我看看这个 PR", origin: undefined });
    expect(rows[1]?.text).not.toContain("/review");
    expect(rows[2]?.text).toContain(`<${SKILL_CONTENT_TAG} name="review">`);
    expect(rows[2]?.text).toContain("REVIEW BODY LINE");
  });

  it("the canonical spelling reaches the model by the same road (design §4 item 7)", async () => {
    const h = engine();
    plantSkill(h.workspace, "review", "REVIEW BODY LINE");
    await activate(h, S1);
    await runTurnWithFrames(h, "/skill:review 帮我看看");
    const rows = userRows(h);
    expect(rows[1]?.text).toBe("帮我看看");
    expect(rows[2]?.origin).toBe("skill-invocation");
    expect(rows[2]?.text).toContain("REVIEW BODY LINE");
  });

  it("§2.1 TRAP: injecting a body does NOT knock the resident catalog out (it is deduped, not re-appended)", async () => {
    const h = engine();
    plantSkill(h.workspace, "review", "REVIEW BODY LINE");
    await activate(h, S1);
    await runTurnWithFrames(h, "/review 看看");
    await runTurnWithFrames(h, "继续普通聊天");
    await runTurnWithFrames(h, "再聊一句");

    // The catalog text must appear EXACTLY ONCE across three turns. If the body's
    // origin were the catalog's, the dedup's "last injected row of this origin"
    // would be the body, the catalog would look changed every turn, and this
    // would be 3.
    const catalog = userRows(h).filter((r) => r.origin === "skill");
    expect(catalog).toHaveLength(1);
  });

  it("★ /ghost is visibly answered and NOTHING is faked (design §3.2 + §4 item 3)", async () => {
    const h = engine();
    await activate(h, S1);
    await runTurnWithFrames(h, "/ghost 帮我看看");
    const rows = userRows(h);
    expect(rows.map((r) => r.origin)).toEqual([undefined, "skill-invocation"]);
    expect(rows[0]?.text).toBe("帮我看看");
    const failure = rows[1]?.text ?? "";
    expect(failure).toContain(`<${SKILL_INVOKE_TAG} name="ghost"`);
    expect(failure).toContain("加载失败");
    expect(failure).toContain("本工作区没有这个技能");
    expect(failure).not.toContain(`<${SKILL_CONTENT_TAG}`);
  });

  it("a session with no gesture pays nothing extra: no skill row at all", async () => {
    const h = engine();
    plantSkill(h.workspace, "review", "REVIEW BODY LINE");
    await activate(h, S1);
    await runTurnWithFrames(h, "只是普通聊天");
    expect(userRows(h).some((r) => r.origin === "skill-invocation")).toBe(false);
    expect(userRows(h).some((r) => r.text === "只是普通聊天")).toBe(true);
  });
});

/* ============================================ F · goal regression (lane) === */

/**
 * The after-input lane now carries TWO producers, so the goal's two channels are
 * the regression face of this change: a turn may hold a skill body AND a goal
 * notice, and the goal's suppression rule must still be decided by the GOAL
 * origin alone.
 */
describe("W9351 F · goal zero-regression across the generalized lane", () => {
  it("a skill row does NOT silence the standing goal line (the peek asks about the goal origin)", async () => {
    const h = engine();
    plantSkill(h.workspace, "review", "REVIEW BODY LINE");
    await activate(h, S1);
    await getJson(h.app, URL_GOAL, jsonRequest("POST", { text: "先做一个" }));
    await runTurnWithFrames(h, "开工"); // delivers the set notice, consumes it

    // This turn has NO pending notice, only a skill gesture — so the resident
    // `[目标] …` line must still appear, AND the body must follow the input.
    await runTurnWithFrames(h, "/review 看看");
    const rows = userRows(h);
    const goals = rows.filter((r) => r.origin === "goal");
    expect(goals.map((g) => g.text)).toEqual(["[目标] 已设定：先做一个", "[目标] 先做一个"]);
    expect(rows[rows.length - 2]).toEqual({ text: "看看", origin: undefined });
    expect(rows[rows.length - 1]?.origin).toBe("skill-invocation");
  });

  it("a turn carrying BOTH says the earlier change first, then answers this one", async () => {
    const h = engine();
    plantSkill(h.workspace, "review", "REVIEW BODY LINE");
    await activate(h, S1);
    await getJson(h.app, URL_GOAL, jsonRequest("POST", { text: "先做一个" }));

    await runTurnWithFrames(h, "/review 看看");
    const rows = userRows(h);
    // catalog, input, GOAL NOTICE, BODY — the notice describes an EARLIER change,
    // the body answers THIS turn, so the body is the row nearest the answer.
    expect(rows.map((r) => r.origin)).toEqual(["skill", undefined, "goal", "skill-invocation"]);
    expect(rows[2]?.text).toBe("[目标] 已设定：先做一个");
    expect(rows[3]?.text).toContain("REVIEW BODY LINE");
    // The suppression rule still held: the standing `[目标] 先做一个` line was
    // NOT also written, because the notice already said it.
    expect(rows.some((r) => r.text === "[目标] 先做一个")).toBe(false);
  });
});
