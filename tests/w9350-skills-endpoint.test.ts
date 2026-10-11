// @vitest-environment node
/**
 * W9350 · `GET /api/sessions/{id}/skills` — the session's SKILL LISTING
 * (docs/feature/skill-command.md §4 slice 1).
 *
 * Skills had exactly one arrival path until now: the engine injects the catalog
 * every turn and the MODEL decides whether to call `load_skill`. The human had
 * no way to name one. This endpoint is the half that makes `/{skill}` reachable
 * at all — and the half that can go wrong in exactly one way.
 *
 * **The one failure this suite is built around**: "visible in the UI, unreachable
 * in the session". ZCode shipped it (its UI scanned the disk itself while the
 * session loaded from the engine), and it is invisible in review because both
 * halves look right in isolation. So these are not four happy-path cases:
 *
 *   ① the answer must come from the SESSION'S OWN workspace (the temp dir the
 *     harness created), which no constant path can answer;
 *   ② "no skills" is `[]` — not an error, not a 404, not an absent key;
 *   ③ no workspace (the detached generation) is `[]` too, and it is the ENGINE
 *     that says so, not the handler inventing an answer;
 *   ④ an id that names no session is the shared `require()` 404 — because
 *     "this session does not exist" and "this session has no skills" are
 *     different answers and only one of them may be an empty list.
 *
 * Plus the structural gate: `apps/studio` must contain exactly ONE `readLayers(`
 * call site. Two reads of "which skills can this session load" is the divergence,
 * however correct each copy looks on its own.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { FROZEN_COUNTS, loadEndpoints, loadRouteSnapshot, repoRoot } from "@celestea/core";
import { API_ENDPOINT_COUNT } from "../apps/studio/src/routes.js";
import { getJson, type StudioHarness } from "../apps/studio/src/harness.test-util.js";
import { engineOf, makeEngineHarness } from "../apps/studio/src/runtime/test-util.js";

const harnesses: StudioHarness[] = [];

afterEach(() => {
  for (const made of harnesses.splice(0)) made.cleanup();
});

/**
 * A throwaway `$CELESTEA_HOME`, so the GLOBAL read layer cannot reach whatever
 * the machine running the suite happens to have installed. The harness workspace
 * (the PROJECT layer) is already a per-test temp dir, so with this pinned the
 * whole listing is a function of the fixtures this file plants.
 */
const HOME = mkdtempSync(join(tmpdir(), "w9350-home-"));

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

const ENV: NodeJS.ProcessEnv = { CELESTEA_HOME: HOME, CELESTEA_PERMISSION_DEFAULT: "", CELESTEA_PERMISSION_MAX: "" };
const S1_ID = "sample-ws/s1";
const S1 = "/api/sessions/" + encodeURIComponent(S1_ID) + "/skills";

/** One REAL-engine harness: one session, the offline engine, the host's own wiring. */
function engine(): StudioHarness {
  const made = makeEngineHarness({ sessions: { s1: [] }, env: ENV });
  harnesses.push(made);
  return made;
}

/** Plant the PROJECT layer of `readLayers`: `<ws>/.celestea/skills/<name>/SKILL.md`. */
function plantSkill(workspace: string, name: string, frontmatter: string): string {
  const dir = join(workspace, ".celestea", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n正文\n`);
  return dir;
}

/** A well-formed skill: name must equal the directory name (the core contract). */
function validSkill(name: string, description: string): string {
  return `name: ${name}\ndescription: ${description}`;
}

/** Repo-relative, slash-normalized: the assertion must not read Windows-vs-POSIX. */
function relPath(abs: string): string {
  return abs.slice(repoRoot().length + 1).split(sep).join("/");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

describe("W9350 A · the contract registers the route (the frozen table is not optional)", () => {
  const c = loadEndpoints();
  const byId = new Map(c.endpoints.map((e) => [e.id, e]));

  it("declares GET /api/sessions/{id}/skills with four response keys and one refusal", () => {
    const get = byId.get("get_session_skills");
    expect(get?.path).toBe("/api/sessions/{id}/skills");
    expect(get?.method).toBe("GET");
    expect(get?.request.kind).toBe("none");
    expect(get?.response.fields.map((f) => f.name)).toEqual(["ok", "session", "skills", "rejected"]);
    // Both arrays are REQUIRED keys. A client must not have to tell "absent" from
    // "none" — that is the tri-state every renderer would otherwise grow.
    for (const name of ["skills", "rejected"]) {
      expect(get?.response.fields.find((f) => f.name === name)?.required).toBe(true);
    }
    // Exactly one refusal, and it is the SHARED session one — this handler adds
    // no semantics of its own.
    expect(get?.errors).toEqual([{ status: 404, error: "unknown session '{id}'" }]);
  });

  it("states the two promises a reader cannot verify from the handler: same source, no snapshot", () => {
    const notes = (byId.get("get_session_skills")?.notes ?? []).join("\n");
    // Why there is one read and not two (the ZCode failure), and why nothing is
    // cached even though "a session listing" is the classic thing to cache.
    expect(notes).toContain("SAME SOURCE AS THE MODEL");
    expect(notes).toContain("NO SNAPSHOT");
  });

  it("moves all four counts by exactly one, and the snapshot registers the TS-only route", () => {
    // ① the frozen anchor, ② the file's count + its array length, ③ the constant
    // the boot assertion reads, ④ the snapshot's own two derived counts.
    // main 的 M2-B2c（POST /api/questions/{id}/cancel）与本 PR 的 W9350（GET /api/sessions/{id}/skills）
    // 撞号在 73 ⇒ 并集是 74。
    expect(FROZEN_COUNTS.endpoints).toBe(74);
    expect(c.count).toBe(FROZEN_COUNTS.endpoints);
    expect(c.endpoints).toHaveLength(FROZEN_COUNTS.endpoints);
    expect(API_ENDPOINT_COUNT).toBe(FROZEN_COUNTS.endpoints);
    const snap = loadRouteSnapshot();
    const frozen = snap.routes.filter((r) => r.path.startsWith("/api/"));
    const tsOnly = snap.tsOnlyRoutes ?? [];
    expect(frozen, "the legacy extraction is a frozen historical fact").toHaveLength(39);
    expect(tsOnly).toHaveLength(FROZEN_COUNTS.endpoints - frozen.length);
    expect(tsOnly.map((r) => `${r.method} ${r.path}`)).toContain("GET /api/sessions/{id}/skills");
    expect(snap.tsApiEndpoints).toBe(FROZEN_COUNTS.endpoints);
    expect(snap.tsMethodPathCombos).toBe(FROZEN_COUNTS.endpoints + snap.staticRoutes.length);
    // The title is prose, so it is CHECKED rather than derived.
    expect(Number(/^(.*) \((\d+) endpoints\)$/.exec(c.title)?.[2])).toBe(FROZEN_COUNTS.endpoints);
  });
});

describe("W9350 B · GET /api/sessions/{id}/skills — the four answers", () => {
  it("① has skills: 200 with the four wire keys, read from the SESSION'S OWN workspace", async () => {
    const harness = engine();
    const dir = plantSkill(harness.workspace, "review", validSkill("review", "Use this skill whenever a PR needs review."));
    const res = await getJson(harness.app, S1, { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.body["ok"]).toBe(true);
    expect(res.body["session"]).toBe(S1_ID);
    expect(res.body["rejected"]).toEqual([]);
    const skills = res.body["skills"] as Record<string, unknown>[];
    expect(skills.map((s) => s["name"])).toEqual(["review"]);
    // Exactly four keys — the rest of SkillDefinition (license, metadata, file
    // path) stays inside the process.
    expect(Object.keys(skills[0] ?? {}).sort()).toEqual(["description", "dir", "name", "source"]);
    expect(skills[0]?.["description"]).toBe("Use this skill whenever a PR needs review.");
    // ★ The load-bearing two: the layer AND the absolute directory of THIS
    // harness's workspace. A hardcoded path cannot produce them, which is why the
    // mutation control breaks here and not on a row count.
    expect(skills[0]?.["source"]).toBe("project");
    expect(skills[0]?.["dir"]).toBe(dir);
  });

  it("② no skills: 200 with skills:[] — an empty list, never an error and never a 404", async () => {
    const harness = engine();
    const res = await getJson(harness.app, S1, { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.body["ok"]).toBe(true);
    expect(res.body["skills"]).toEqual([]);
    expect(res.body["rejected"]).toEqual([]);
  });

  it("③ no workspace: the ENGINE answers [] for the detached generation and for an unresolvable id", () => {
    const harness = engine();
    // `null` IS the detached generation (the one /api/tools is composed for): no
    // session id, no directory, no workspace — so no skills, stated by the seam
    // rather than invented by the handler.
    expect(engineOf(harness).sessionSkills(null)).toEqual({ skills: [], rejected: [] });
    // An id whose WORKSPACE does not resolve is the same case one step earlier in
    // the chain, and it must reach the same answer (the handler still owns the 404).
    expect(engineOf(harness).sessionSkills("no-such-ws/s1")).toEqual({ skills: [], rejected: [] });
  });

  it("④ unknown id: the shared require() 404 — 'no such session' is NOT 'no skills'", async () => {
    const harness = engine();
    const missing = await getJson(harness.app, "/api/sessions/" + encodeURIComponent("sample-ws/nope") + "/skills", { method: "GET" });
    expect(missing.status).toBe(404);
    expect(missing.body["ok"]).toBe(false);
    expect(String(missing.body["error"])).toContain("unknown session");
    expect(missing.body["skills"], "a refusal is not an empty listing").toBeUndefined();
    // A malformed id keeps whatever `resolve` already answered with (same rule as
    // the goal endpoints): the handler adds no semantics of its own.
    const bad = await getJson(harness.app, "/api/sessions/not-an-id/skills", { method: "GET" });
    expect(bad.status).toBe(400);
    expect(bad.body["skills"]).toBeUndefined();
  });

  it("a skill that exists but is BROKEN is reported in rejected[] — never silently dropped", async () => {
    const harness = engine();
    // Frontmatter name != directory name: core rejects it, so it is absent from
    // `skills` AND named in `rejected` with the reason. That is the difference
    // between "I have no such skill" and "the skill you installed is broken".
    plantSkill(harness.workspace, "broken", validSkill("some-other-name", "x"));
    const res = await getJson(harness.app, S1, { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.body["skills"]).toEqual([]);
    const rejected = res.body["rejected"] as Record<string, unknown>[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.["name"]).toBe("broken");
    expect(String(rejected[0]?.["reason"])).toContain("does not match directory name");
  });

  it("★ ONE read: apps/studio has exactly one readLayers() call site (goal-wiring)", () => {
    // The endpoint and the per-turn catalog row both go through skillListingOf.
    // A second readLayers(...) in the host tree is a second ANSWER to "which
    // skills can this session load" — the ZCode divergence — and it would stay
    // green in review, because each copy is correct on its own.
    //
    // Only real CODE counts: comments name the function to explain why, and a
    // test may call it (store/celestea-layout.test.ts asserts the pure helper).
    const hits = walk(join(repoRoot(), "apps", "studio", "src"))
      .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
      .filter((f) => readFileSync(f, "utf8").split("\n").some((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && line.includes("readLayers(")))
      .map(relPath);
    expect(hits).toEqual(["apps/studio/src/runtime/goal-wiring.ts"]);
  });
});
