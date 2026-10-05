// @vitest-environment node
/**
 * W9346 · the persistent goal became MODEL-VISIBLE: a resident row every turn
 * plus a one-shot change notice in the NEXT turn, and the origin whitelist that
 * labels both.
 *
 * The defect this fixes is not a crash: `/goal` answered 「已设定」 and NOTHING in
 * the conversation ever mentioned the goal, so the model could not act on it. The
 * two channels are therefore asserted apart, because they fail apart:
 *
 *   C1 **resident row** — `[目标] <text>` (or `[目标·已暂停] …`) at every turn
 *      start, deduped like the skill catalog so it is not re-appended每turn;
 *   C2 **one-shot notice** — the frozen `[目标] 已更新：…` text, appended AFTER
 *      the turn's user input row, then cleared.
 *
 * The ORDERING case below is the one with teeth: moving the notice back in front
 * of the input row (which is where every other injection lands) must turn it red.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_EVENT_ORIGINS, type SessionEvent } from "@celestea/core";
import { parseSessionJsonl } from "@celestea/session";
import { consumePending, goalNoticeText, readGoalState } from "../apps/studio/src/handlers/session-goal.js";
import { getJson, jsonRequest, makeHarness, type StudioHarness } from "../apps/studio/src/harness.test-util.js";
import { activate, makeEngineHarness, readSessionLog, runTurnWithFrames } from "../apps/studio/src/runtime/test-util.js";

const harnesses: StudioHarness[] = [];

afterEach(() => {
  for (const made of harnesses.splice(0)) made.cleanup();
});

const URL_GOAL = "/api/sessions/sample-ws%2Fs1/goal";

/** The `user_message` rows of a session log, in order. */
function userRows(h: StudioHarness, name = "s1"): Array<{ text: string; origin: string | undefined }> {
  return parseSessionJsonl(readSessionLog(h, name)).events
    .filter((e): e is Extract<SessionEvent, { type: "user_message" }> => e.type === "user_message")
    .map((e) => ({ text: e.text, origin: e.origin }));
}

/* ============================================================ A · storage === */

/** A throwaway session dir + id pair for the pure storage assertions. */
function goalDir(): { dir: string; session: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "w9346-goal-"));
  return { dir, session: "sample-ws/s1", cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("W9346 A · goal.json read/write", () => {
  it("round-trips the new fields, and omits them when absent (a never-paused, never-notified goal is byte-shaped like a pre-W9346 file)", () => {
    const g = goalDir();
    try {
      writeFileSync(
        join(g.dir, "goal.json"),
        JSON.stringify({
          version: 1,
          session: g.session,
          text: "做完 F2",
          paused: true,
          created_at: 100,
          updated_at: 200,
          pending: { id: "goal-200-x", kind: "pause", text: "[目标] 已暂停：做完 F2", at: 200 },
        }),
      );
      const full = readGoalState(g.dir, g.session);
      expect(full.goal).toEqual({ version: 1, session: g.session, text: "做完 F2", paused: true, created_at: 100, updated_at: 200 });
      expect(full.pending).toEqual({ id: "goal-200-x", kind: "pause", text: "[目标] 已暂停：做完 F2", at: 200 });
      expect(full.warning).toBeUndefined();

      // A PRE-W9346 file (no paused, no pending) still reads, and the two
      // defaults are the documented ones: paused = false, nothing to deliver.
      writeFileSync(join(g.dir, "goal.json"), JSON.stringify({ version: 1, session: g.session, text: "老目标", created_at: 1, updated_at: 2 }));
      const legacy = readGoalState(g.dir, g.session);
      expect(legacy.goal?.paused).toBeUndefined();
      expect(legacy.pending).toBeNull();
      expect(legacy.goal?.text).toBe("老目标");
    } finally {
      g.cleanup();
    }
  });

  it("DROPS a malformed pending instead of voiding the goal (one lost notice is recoverable; a lost goal is not)", () => {
    const g = goalDir();
    try {
      const base = { version: 1, session: g.session, text: "目标", created_at: 1, updated_at: 2 };
      const broken: unknown[] = [
        { id: "x", kind: "nope", text: "t", at: 1 },
        { kind: "set", text: "t", at: 1 },
        { id: "x", kind: "set", text: "", at: 1 },
        { id: "x", kind: "set", text: "t", at: "soon" },
        "a string",
        [1, 2],
      ];
      for (const pending of broken) {
        writeFileSync(join(g.dir, "goal.json"), JSON.stringify({ ...base, pending }));
        const state = readGoalState(g.dir, g.session);
        expect(state.pending, `pending ${JSON.stringify(pending)} should have been dropped`).toBeNull();
        expect(state.goal?.text, "the goal itself must survive a bad notice").toBe("目标");
        expect(state.warning).toBeUndefined();
      }
    } finally {
      g.cleanup();
    }
  });

  it("a non-boolean `paused` reads as the old default (absent = false), never as truthy", () => {
    const g = goalDir();
    try {
      for (const paused of ["true", 1, {}, []]) {
        writeFileSync(join(g.dir, "goal.json"), JSON.stringify({ version: 1, session: g.session, text: "t", paused, created_at: 1, updated_at: 2 }));
        expect(readGoalState(g.dir, g.session).goal?.paused, `paused=${JSON.stringify(paused)}`).toBeUndefined();
      }
    } finally {
      g.cleanup();
    }
  });

  it("consumePending empties the slot WITHOUT moving updated_at, and a delivered delete removes the file for real", () => {
    const g = goalDir();
    try {
      writeFileSync(join(g.dir, "goal.json"), JSON.stringify({ version: 1, session: g.session, text: "t", created_at: 10, updated_at: 20, pending: { id: "i", kind: "set", text: "[目标] 已设定：t", at: 20 } }));
      consumePending(g.dir, g.session);
      const after = JSON.parse(readFileSync(join(g.dir, "goal.json"), "utf8")) as Record<string, unknown>;
      expect(after["pending"]).toBeUndefined();
      expect(after["updated_at"]).toBe(20); // a delivery is not a user-visible change
      expect(after["text"]).toBe("t");

      // A delivered DELETE removes the file: the sidecar existed only to carry the
      // notice, and the goal it named is gone.
      writeFileSync(join(g.dir, "goal.json"), JSON.stringify({ version: 1, session: g.session, text: "t", created_at: 10, updated_at: 30, pending: { id: "i", kind: "delete", text: "[目标] 已删除（原目标：t）", at: 30 } }));
      consumePending(g.dir, g.session);
      expect(existsSync(join(g.dir, "goal.json"))).toBe(false);
    } finally {
      g.cleanup();
    }
  });

  it("renders the five notice texts, each naming the goal", () => {
    expect(goalNoticeText("set", "X")).toBe("[目标] 已设定：X");
    expect(goalNoticeText("edit", "X")).toBe("[目标] 已更新：X");
    expect(goalNoticeText("pause", "X")).toBe("[目标] 已暂停：X");
    expect(goalNoticeText("resume", "X")).toBe("[目标] 已恢复：X");
    // The delete notice quotes the text that is about to exist nowhere else.
    expect(goalNoticeText("delete", "X")).toBe("[目标] 已删除（原目标：X）");
  });
});

/* ======================================================= B · the endpoint === */

describe("W9346 B · POST /goal — every branch, over real HTTP", () => {
  /** A fake-adapter harness with one session dir. */
  function h(): StudioHarness {
    const made = makeHarness({ session: { name: "s1", log: "" } });
    harnesses.push(made);
    return made;
  }

  it("set / edit / pause / resume each write their own notice, and the echo carries `paused` at all times", async () => {
    const harness = h();
    const set = await getJson(harness.app, URL_GOAL, jsonRequest("POST", { text: "目标 A" }));
    expect(set.status).toBe(200);
    expect((set.body["goal"] as Record<string, unknown>)["paused"]).toBe(false);
    expect(onDisk(harness).pending).toMatchObject({ kind: "set", text: "[目标] 已设定：目标 A" });

    const edit = await getJson(harness.app, URL_GOAL, jsonRequest("POST", { text: "目标 B" }));
    expect((edit.body["goal"] as Record<string, unknown>)["text"]).toBe("目标 B");
    expect(onDisk(harness).pending).toMatchObject({ kind: "edit", text: "[目标] 已更新：目标 B" });

    const pause = await getJson(harness.app, URL_GOAL, jsonRequest("POST", { paused: true }));
    expect(pause.status).toBe(200);
    expect((pause.body["goal"] as Record<string, unknown>)["paused"]).toBe(true);
    expect(onDisk(harness).pending).toMatchObject({ kind: "pause", text: "[目标] 已暂停：目标 B" });
    expect(onDisk(harness).paused).toBe(true);

    const resume = await getJson(harness.app, URL_GOAL, jsonRequest("POST", { paused: false }));
    expect((resume.body["goal"] as Record<string, unknown>)["paused"]).toBe(false);
    expect(onDisk(harness).pending).toMatchObject({ kind: "resume", text: "[目标] 已恢复：目标 B" });
  });

  it("an EQUIVALENT write produces no notice (re-posting the same goal must not spam the transcript)", async () => {
    const harness = h();
    await getJson(harness.app, URL_GOAL, jsonRequest("POST", { text: "同一目标" }));
    // Deliver the set notice, so the only possible new pending would be from here.
    consumePending(dirOf(harness), "sample-ws/s1");
    expect(onDisk(harness).pending).toBeUndefined();

    const same = await getJson(harness.app, URL_GOAL, jsonRequest("POST", { text: "同一目标" }));
    expect(same.status).toBe(200);
    expect(onDisk(harness).pending).toBeUndefined();

    // Re-posting the same PAUSE is equally silent.
    await getJson(harness.app, URL_GOAL, jsonRequest("POST", { paused: true }));
    consumePending(dirOf(harness), "sample-ws/s1");
    await getJson(harness.app, URL_GOAL, jsonRequest("POST", { paused: true }));
    expect(onDisk(harness).pending).toBeUndefined();
    expect(onDisk(harness).paused).toBe(true);
  });

  it("422s a pause with no goal, 422s a non-boolean paused, and 422s a body with neither field", async () => {
    const harness = h();
    const noGoal = await getJson(harness.app, URL_GOAL, jsonRequest("POST", { paused: true }));
    expect(noGoal.status).toBe(422);
    expect(noGoal.body["error"]).toBe("cannot pause: no goal");
    expect(existsSync(join(harness.workspace, "s1", "goal.json"))).toBe(false);

    await getJson(harness.app, URL_GOAL, jsonRequest("POST", { text: "x" }));
    const wrongType = await getJson(harness.app, URL_GOAL, jsonRequest("POST", { paused: "yes" }));
    expect(wrongType.status).toBe(422);
    expect(wrongType.body["error"]).toBe("field 'paused' must be a boolean");

    const empty = await getJson(harness.app, URL_GOAL, jsonRequest("POST", {}));
    expect(empty.status).toBe(422);
    expect(empty.body["error"]).toBe("field 'text' must be a string");
  });

  it("deleting with no goal is a 200 no-op and writes NO notice", async () => {
    const harness = h();
    const res = await getJson(harness.app, URL_GOAL, jsonRequest("POST", { text: "" }));
    expect(res.status).toBe(200);
    expect(res.body["goal"]).toBeNull();
    expect(existsSync(join(harness.workspace, "s1", "goal.json"))).toBe(false);
  });

  it("{text, paused} in one request lands the text FIRST (a goal that starts paused, not a pause of nothing)", async () => {
    const harness = h();
    const res = await getJson(harness.app, URL_GOAL, jsonRequest("POST", { text: "先建后暂停", paused: true }));
    expect(res.status).toBe(200);
    expect(res.body["goal"]).toEqual(expect.objectContaining({ text: "先建后暂停", paused: true }));
  });
});

/* ============================================== C · model visibility (real) === */

/**
 * The main scenario, over the REAL engine: set a goal, run a turn (the resident
 * row appears and the set notice lands right after the human's message), then run
 * a second turn (the notice is gone, the resident row was NOT re-appended).
 */
describe("W9346 C · the goal reaches the model", () => {
  function engine(): StudioHarness {
    const made = makeEngineHarness({ sessions: { s1: [] } });
    harnesses.push(made);
    return made;
  }

  it("★ ORDERING: the notice lands IMMEDIATELY AFTER the input row, and the resident row is deduped away next turn", async () => {
    const h = engine();
    await activate(h, "sample-ws/s1");
    await getJson(h.app, URL_GOAL, jsonRequest("POST", { text: "把 F2 做完" }));

    // Turn 1: the set notice is the one-shot channel, and it must directly follow
    // the human's message — NOT sit with the receipts/receipts-land-before-input
    // group the way every other injection does. The order is the whole contract
    // here, so it is asserted as an exact array.
    await runTurnWithFrames(h, "开工");
    const first = userRows(h);
    expect(first).toEqual([
      { text: "开工", origin: undefined },
      { text: "[目标] 已设定：把 F2 做完", origin: "goal" },
    ]);
    // The file records the delivery, so the next turn does not repeat it.
    expect(onDisk(h).pending).toBeUndefined();

    // Turn 2: nothing to notify, so the RESIDENT row is what the model sees — and
    // the same text twice in a log is the bug the dedup exists to prevent.
    await runTurnWithFrames(h, "继续");
    const goals = userRows(h).filter((r) => r.origin === "goal");
    expect(goals).toEqual([
      { text: "[目标] 已设定：把 F2 做完", origin: "goal" },
      { text: "[目标] 把 F2 做完", origin: "goal" },
    ]);
    // The set notice appeared exactly ONCE even though a second turn ran: the
    // resident line is a different row, and it is deduped on the third turn too.
    expect(userRows(h).filter((r) => r.text === "[目标] 已设定：把 F2 做完")).toHaveLength(1);
    await runTurnWithFrames(h, "第三轮");
    expect(userRows(h).filter((r) => r.text === "[目标] 把 F2 做完")).toHaveLength(1);
  });

  it("the notice is delivered ONCE, then only the resident row follows", async () => {
    const h = engine();
    await activate(h, "sample-ws/s1");
    await getJson(h.app, URL_GOAL, jsonRequest("POST", { text: "先做一个" }));
    await runTurnWithFrames(h, "第一轮");

    // A change made while the session is IDLE waits: the notice is not lost, and
    // the goal change does not start a turn by itself.
    await getJson(h.app, URL_GOAL, jsonRequest("POST", { text: "再做一个" }));
    expect(userRows(h).some((r) => r.text.includes("已更新"))).toBe(false);

    await runTurnWithFrames(h, "第二轮");
    const goals = userRows(h).filter((r) => r.origin === "goal");
    // The second turn delivers the EDIT notice (the goal already existed, so the
    // change is an edit, not a set) — and the resident row is suppressed in that
    // same turn, so the change is announced exactly once.
    expect(goals.map((g) => g.text)).toEqual(["[目标] 已设定：先做一个", "[目标] 已更新：再做一个"]);

    // A third turn has nothing to announce, so the standing goal appears.
    await runTurnWithFrames(h, "第三轮");
    expect(userRows(h).filter((r) => r.origin === "goal").map((g) => g.text)).toEqual([
      "[目标] 已设定：先做一个",
      "[目标] 已更新：再做一个",
      "[目标] 再做一个",
    ]);
  });

  it("SUPPRESSION: the turn that delivers a notice does NOT also append the resident row (same change, said once)", async () => {
    const h = engine();
    await activate(h, "sample-ws/s1");
    await getJson(h.app, URL_GOAL, jsonRequest("POST", { text: "起始目标" }));
    await runTurnWithFrames(h, "第一轮"); // delivers the set notice

    // Edit: this turn will say 「已更新」, so it must NOT also say 「[目标] 起始目标」
    // — the notice already carries the new text.
    await getJson(h.app, URL_GOAL, jsonRequest("POST", { text: "改过的目标" }));
    await runTurnWithFrames(h, "第二轮");
    // Turn 1 contributed [input, notice]; this turn's own goal rows must be the
    // edit notice ALONE.
    const second = userRows(h).slice(2);
    expect(second.filter((r) => r.origin === "goal").map((r) => r.text)).toEqual(["[目标] 已更新：改过的目标"]);

    // The NEXT turn has nothing to announce, so the resident line appears — and it
    // is the new text, not the one that was just superseded.
    await runTurnWithFrames(h, "第三轮");
    const third = userRows(h).slice(4);
    expect(third.filter((r) => r.origin === "goal").map((r) => r.text)).toEqual(["[目标] 改过的目标"]);
    // The superseded text never appears as a standing line: a turn that announces
    // an edit does not also pin the old goal.
    expect(userRows(h).some((r) => r.text === "[目标] 起始目标")).toBe(false);
  });

  it("a PAUSED goal changes the resident row, and the delete notice names the deleted text", async () => {
    const h = engine();
    await activate(h, "sample-ws/s1");
    await getJson(h.app, URL_GOAL, jsonRequest("POST", { text: "会删掉的目标" }));
    await runTurnWithFrames(h, "第一轮");

    await getJson(h.app, URL_GOAL, jsonRequest("POST", { paused: true }));
    await runTurnWithFrames(h, "第二轮"); // delivers the PAUSE notice
    await runTurnWithFrames(h, "第三轮"); // nothing to announce ⇒ the paused resident row
    const paused = userRows(h).filter((r) => r.text.startsWith("[目标·已暂停]"));
    expect(paused).toHaveLength(1);
    expect(paused[0]?.text).toContain("会删掉的目标");
    expect(paused[0]?.text).toContain("不要推进");
    // …and the pause turn said it once, as a notice, not as both a notice and a
    // resident row.
    expect(userRows(h).filter((r) => r.text === "[目标] 已暂停：会删掉的目标")).toHaveLength(1);

    // Deleting while paused: the notice quotes the text that is about to vanish.
    const del = await getJson(h.app, URL_GOAL, jsonRequest("POST", { text: "" }));
    expect(del.body["goal"]).toBeNull();
    await runTurnWithFrames(h, "第四轮");
    expect(userRows(h).filter((r) => r.text.includes("已删除")).map((r) => r.text)).toEqual([
      "[目标] 已删除（原目标：会删掉的目标）",
    ]);
    // The delivered delete finally removes the sidecar, so the next turn has
    // neither a resident row nor a notice.
    await runTurnWithFrames(h, "第五轮");
    expect(existsSync(join(h.workspace, "s1", "goal.json"))).toBe(false);
    expect(userRows(h).filter((r) => r.origin === "goal").map((r) => r.text)).toEqual([
      "[目标] 已设定：会删掉的目标",
      "[目标] 已暂停：会删掉的目标",
      "[目标·已暂停] 会删掉的目标（暂停期间不要推进这个目标）",
      "[目标] 已删除（原目标：会删掉的目标）",
    ]);
  });

  it("a session with NO goal pays nothing: no goal row, ever", async () => {
    const h = engine();
    await activate(h, "sample-ws/s1");
    await runTurnWithFrames(h, "只是聊天");
    expect(userRows(h).some((r) => r.origin === "goal")).toBe(false);
  });
});

/* ================================================ D · the origin whitelist === */

describe("W9346 D · the origin whitelist and the frozen schema agree", () => {
  it("`goal` is in BOTH closed sets, and the codec round-trips it", async () => {
    expect(SESSION_EVENT_ORIGINS).toContain("goal");
    const { validateSessionEvent, serializeSessionEvent, parseSessionEvent } = await import("@celestea/core");
    const ev: SessionEvent = { type: "user_message", text: "[目标] 已设定：X", origin: "goal" };
    expect(validateSessionEvent(ev).ok).toBe(true);
    const back = parseSessionEvent(serializeSessionEvent(ev));
    expect(back.ok && back.event).toEqual(ev);
    // An UNKNOWN origin is still a hard error — adding one must not have opened
    // the set to anything.
    expect(validateSessionEvent({ type: "user_message", text: "x", origin: "goalz" }).ok).toBe(false);
  });

  it("contracts/session-event.schema.json declares the SAME enum as SESSION_EVENT_ORIGINS", async () => {
    const { loadSessionEventSchema } = await import("@celestea/core");
    const schema = loadSessionEventSchema();
    const defs = schema["$defs"] as { SessionEvent: { oneOf: Array<{ title?: string; properties?: Record<string, unknown> }> } };
    const userMessage = defs.SessionEvent.oneOf.find((v) => v.title === "user_message");
    const origin = userMessage?.properties?.["origin"] as { enum?: string[] };
    expect(origin?.enum).toBeDefined();
    expect([...(origin?.enum ?? [])].sort()).toEqual([...SESSION_EVENT_ORIGINS].sort());
  });
});

/** The raw on-disk goal record (so a test can see the OPTIONAL fields). */
function onDisk(h: StudioHarness): Record<string, unknown> {
  return JSON.parse(readFileSync(join(h.workspace, "s1", "goal.json"), "utf8")) as Record<string, unknown>;
}

/** The session directory of the harness's `s1`. */
function dirOf(h: StudioHarness): string {
  return join(h.workspace, "s1");
}
