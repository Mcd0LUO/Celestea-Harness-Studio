// @vitest-environment node
/**
 * W9348 · `GET /api/sessions/{id}/goal` — the READ side of the persistent goal.
 *
 * The defect this closes is not a crash either: the goal was real, on disk, and
 * completely UNREACHABLE. `/goal` set it, the POST echo told the capsule what it
 * was, and then a page refresh left the goal on disk with nothing on screen —
 * every read path the UI could have used returned 404. The state existed; the
 * ability to observe it did not.
 *
 * Three properties are asserted, and they fail apart, so they are kept apart:
 *
 *   1. **the three states** — active / paused / none, over real HTTP;
 *   2. **purity** — GET must not write. Asserted on the BYTES *and* the mtime of
 *      `goal.json` (bytes alone would miss a rewrite that happens to reproduce the
 *      same content; mtime alone would miss a `utimes` lie — together they catch
 *      "read the goal, then tidy the file up");
 *   3. **the undelivered delete notice is NOT a goal** — a `pending` on disk is a
 *      note addressed to the model, and reading the goal must never promote it to
 *      one (nor consume it, which would swallow `[目标] 已删除（原目标：X）` before
 *      the model ever saw it).
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FROZEN_COUNTS, loadEndpoints, loadRouteSnapshot } from "@celestea/core";
import { API_ENDPOINT_COUNT } from "../apps/studio/src/routes.js";
import { getJson, jsonRequest, makeHarness, type StudioHarness } from "../apps/studio/src/harness.test-util.js";

const harnesses: StudioHarness[] = [];

afterEach(() => {
  for (const made of harnesses.splice(0)) made.cleanup();
});

const URL_GOAL = "/api/sessions/sample-ws%2Fs1/goal";

/** A harness with one real session directory (`sample-ws/s1`). */
function h(): StudioHarness {
  const made = makeHarness({ session: { name: "s1", log: "" } });
  harnesses.push(made);
  return made;
}

/** The sidecar path of `sample-ws/s1`. */
function goalFile(harness: StudioHarness): string {
  return join(harness.workspace, "s1", "goal.json");
}

/** Bytes + mtimeMs, the pair that together prove "nothing was written". */
function stamp(path: string): { bytes: string; mtimeMs: number } {
  return { bytes: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs };
}

describe("W9348 A · the contract registers the route (the frozen table is not optional)", () => {
  const c = loadEndpoints();
  const byId = new Map(c.endpoints.map((e) => [e.id, e]));

  it("declares GET /api/sessions/{id}/goal beside the POST, sharing its response shape", () => {
    const get = byId.get("get_session_goal");
    const post = byId.get("post_session_goal");
    expect(get?.path).toBe("/api/sessions/{id}/goal");
    expect(get?.method).toBe("GET");
    expect(get?.request.kind).toBe("none");
    // ★ The contract's real promise: the GET body IS the POST echo. Same key set,
    // same order, so a client reads the goal back with zero shape translation.
    expect(get?.response.fields.map((f) => f.name)).toEqual(post?.response.fields.map((f) => f.name));
    // `paused` is named in the GET's own type literal, because the response IS
    // the point of the endpoint (a client that has to re-derive it is a bug).
    expect(String(get?.response.fields.find((f) => f.name === "goal")?.type)).toContain("paused:boolean");
    // The one refusal it inherits, and it inherits rather than invents.
    expect(get?.errors).toEqual([{ status: 404, error: "unknown session '{id}'" }]);
    // The two properties a reader most needs stated IN THE CONTRACT, because
    // both look like bugs otherwise: an undelivered delete notice reads as
    // `goal: null`, and this endpoint never touches the notice.
    const notes = (get?.notes ?? []).join("\n");
    expect(notes).toContain("PURE READ");
    expect(notes).toContain("UNDELIVERED");
    expect(notes).toContain("consumePending");
  });

  it("moves all four counts by exactly one, and the snapshot registers the TS-only route", () => {
    // ① the frozen anchor, ② the file's count + its array length, ③ the constant
    // the boot assertion reads, ④ the snapshot's own two derived counts.
    // 这条钉的是「四个数永远一致」，常数随每次端点新增顺移：W9348 定稿时是 72，
    // M2-B2c 的 POST /api/questions/{id}/cancel 把它带到 73。
    expect(FROZEN_COUNTS.endpoints).toBe(73);
    expect(c.count).toBe(FROZEN_COUNTS.endpoints);
    expect(c.endpoints).toHaveLength(FROZEN_COUNTS.endpoints);
    expect(API_ENDPOINT_COUNT).toBe(FROZEN_COUNTS.endpoints);
    const snap = loadRouteSnapshot();
    const frozen = snap.routes.filter((r) => r.path.startsWith("/api/"));
    const tsOnly = snap.tsOnlyRoutes ?? [];
    expect(frozen, "the legacy extraction is a frozen historical fact").toHaveLength(39);
    expect(tsOnly).toHaveLength(FROZEN_COUNTS.endpoints - frozen.length);
    expect(tsOnly.map((r) => `${r.method} ${r.path}`)).toContain("GET /api/sessions/{id}/goal");
    expect(snap.tsApiEndpoints).toBe(FROZEN_COUNTS.endpoints);
    expect(snap.tsMethodPathCombos).toBe(FROZEN_COUNTS.endpoints + snap.staticRoutes.length);
    // The title is prose, so it is CHECKED rather than derived (W9213).
    expect(Number(/^(.*) \((\d+) endpoints\)$/.exec(c.title)?.[2])).toBe(FROZEN_COUNTS.endpoints);
  });
});

describe("W9348 B · GET /api/sessions/{id}/goal — the three states", () => {
  it("active: 200 {ok, session, goal} carrying the stored text, paused:false and ISO stamps", async () => {
    const harness = h();
    const set = await getJson(harness.app, URL_GOAL, jsonRequest("POST", { text: "把 F2 做完" }));
    const read = await getJson(harness.app, URL_GOAL, { method: "GET" });
    expect(read.status).toBe(200);
    expect(read.body["ok"]).toBe(true);
    expect(read.body["session"]).toBe("sample-ws/s1");
    // ★ Verbatim the POST echo: not "similar", the same object. This is the
    // assertion that would go red if the GET grew its own, subtler projection.
    expect(read.body["goal"]).toEqual(set.body["goal"]);
    const goal = read.body["goal"] as Record<string, unknown>;
    expect(goal["text"]).toBe("把 F2 做完");
    expect(goal["paused"]).toBe(false);
    expect(Object.keys(goal).sort()).toEqual(["createdAt", "paused", "text", "updatedAt"]);
    expect(Number.isNaN(Date.parse(String(goal["createdAt"])))).toBe(false);
  });

  it("paused: 200 with paused:true — and it survives a RELOAD, which is the whole point", async () => {
    const harness = h();
    await getJson(harness.app, URL_GOAL, jsonRequest("POST", { text: "把 F2 做完" }));
    const paused = await getJson(harness.app, URL_GOAL, jsonRequest("POST", { paused: true }));
    const read = await getJson(harness.app, URL_GOAL, { method: "GET" });
    expect((read.body["goal"] as Record<string, unknown>)["paused"]).toBe(true);
    expect(read.body["goal"]).toEqual(paused.body["goal"]);
  });

  it("no goal: 200 with goal:null — never a 404 and never an error envelope", async () => {
    const harness = h();
    const read = await getJson(harness.app, URL_GOAL, { method: "GET" });
    expect(read.status).toBe(200);
    expect(read.body["ok"]).toBe(true);
    expect(read.body["goal"]).toBeNull();
    // No goal is an ordinary answer, not a warning: the file was simply absent.
    expect(read.body["warnings"]).toBeUndefined();
    // And the read created nothing: still no sidecar.
    expect(() => statSync(goalFile(harness))).toThrow();
  });

  it("answers an unusable id EXACTLY as the POST does (it is literally the same require())", async () => {
    const harness = h();
    // Two classes of unusable id, asserted as PARITY rather than as a number I
    // picked: this endpoint is forbidden from inventing semantics, so the only
    // honest assertion is "the GET's answer equals the POST's answer".
    for (const id of ["sample-ws%2Fnope", "worker%3Asome-worker", "not-an-id", "sample-ws%2F"]) {
      const post = await getJson(harness.app, `/api/sessions/${id}/goal`, jsonRequest("POST", { text: "x" }));
      const get = await getJson(harness.app, `/api/sessions/${id}/goal`, { method: "GET" });
      expect(get.status, `GET ${id} must match POST ${id}`).toBe(post.status);
      expect(get.body["error"], `GET ${id} must carry POST's error text`).toBe(post.body["error"]);
      expect(get.body["ok"]).toBe(false);
    }
    // And the shape of the refusals is the contract's: an unknown SESSION is the
    // frozen 404 (not a bare SPA fallback), a malformed one keeps whatever
    // `resolve` already answered with.
    const missing = await getJson(harness.app, "/api/sessions/sample-ws%2Fnope/goal", { method: "GET" });
    expect(missing.status).toBe(404);
    expect(String(missing.body["error"])).toContain("unknown session");
    // Nothing was created by any of the refusals.
    expect(() => statSync(goalFile(harness))).toThrow();
  });

  it("degrades a structurally unusable file to goal:null + ONE warning, exactly like the POST", async () => {
    const harness = h();
    writeFileSync(goalFile(harness), JSON.stringify({ version: 1, session: "sample-ws/other", text: "别人的目标", created_at: 1, updated_at: 2 }));
    const read = await getJson(harness.app, URL_GOAL, { method: "GET" });
    expect(read.status).toBe(200);
    expect(read.body["goal"]).toBeNull();
    expect(read.body["warnings"]).toEqual(["goal_unreadable: goal.json belongs to \"sample-ws/other\""]);
  });
});

describe("W9348 C · GET is a PURE READ (no write, no notice, no pending consumption)", () => {
  it("leaves goal.json byte-identical AND mtime-identical across a GET", async () => {
    const harness = h();
    await getJson(harness.app, URL_GOAL, jsonRequest("POST", { text: "把 F2 做完" }));
    await getJson(harness.app, URL_GOAL, jsonRequest("POST", { paused: true }));

    const before = stamp(goalFile(harness));
    // Three reads, so a "first read tidies up, later ones are clean" defect
    // cannot hide behind the one case that happens to be checked.
    for (let i = 0; i < 3; i += 1) {
      const read = await getJson(harness.app, URL_GOAL, { method: "GET" });
      expect(read.status, `read #${i + 1}`).toBe(200);
    }
    const after = stamp(goalFile(harness));
    // Bytes alone would miss a rewrite that reproduces the same content; mtime
    // alone would miss a lie about mtime. Both are required to catch "read the
    // goal, then tidy the file up".
    expect(after.bytes, "GET must not rewrite the sidecar").toBe(before.bytes);
    expect(after.mtimeMs, "GET must not touch the sidecar at all").toBe(before.mtimeMs);
  });

  it("★ an UNDELIVERED delete notice reads as goal:null — the pending is a note, not a goal", async () => {
    const harness = h();
    await getJson(harness.app, URL_GOAL, jsonRequest("POST", { text: "临时目标" }));
    const cleared = await getJson(harness.app, URL_GOAL, jsonRequest("POST", { text: "" }));
    expect(cleared.body["goal"]).toBeNull();
    // The file EXISTS right now: it is the carrier of a notice that quotes the
    // text being deleted. A reader that mistook it for a goal would resurrect
    // 「临时目标」 in the UI after the human deleted it.
    const pending = (JSON.parse(readFileSync(goalFile(harness), "utf8")) as { pending: { kind: string; text: string } }).pending;
    expect(pending.kind).toBe("delete");
    expect(pending.text).toContain("临时目标");

    const before = stamp(goalFile(harness));
    const read = await getJson(harness.app, URL_GOAL, { method: "GET" });
    expect(read.status).toBe(200);
    expect(read.body["goal"], "there is no goal between the delete and the delivery").toBeNull();
    // …and the GET neither promoted the pending into a goal NOR consumed it: a
    // swallowed notice is a message the model never gets, and it only exists to
    // be delivered by the NEXT TURN.
    const after = stamp(goalFile(harness));
    expect(after.bytes, "the notice must still be waiting for the turn").toBe(before.bytes);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect((JSON.parse(after.bytes) as { pending: { kind: string } }).pending.kind).toBe("delete");
  });

  it("a GET produces NO notice of its own (reading a goal is not a change)", async () => {
    const harness = h();
    await getJson(harness.app, URL_GOAL, jsonRequest("POST", { text: "同一目标" }));
    // The set notice is still waiting; a GET that wrote anything would show up
    // here as a changed `pending` (a different id/timestamp, or its removal).
    const before = stamp(goalFile(harness));
    await getJson(harness.app, URL_GOAL, { method: "GET" });
    expect(stamp(goalFile(harness)).bytes).toBe(before.bytes);
  });
});
