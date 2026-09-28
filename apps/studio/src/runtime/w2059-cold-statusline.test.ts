/**
 * W2059 — the COLD-session statusline must answer the SESSION's model, not the
 * global base.
 *
 * The bug (same class as the statusline's display regression): the statusline
 * badge polls `GET /api/status?session=<focus>` and renders its `model`. For a
 * session with a LIVE instance that value comes from the instance's profile
 * (global base + `session.json.model`). For a session with NO instance yet,
 * `RealEngine.statusline` fell back to `coldStatusline({ ...this.profileValue })`
 * — the GLOBAL base — so it reported `deepseek-flash` for a session whose own
 * `session.json.model` was `glm-5.3-flash`, while `model_covered` was already
 * `true`. Every server restart re-created the wrong answer until the session's
 * first turn built an instance.
 *
 * The fix reads `composer.profileFor(session)` — the ONE place a session's
 * profile is decided, shared with the warm path and the next turn — so cold and
 * warm can no longer disagree. `session === null` stays the base profile.
 *
 * Level: the REAL adapter through `createStudioEngine`, over the HTTP contract
 * (same harness as session-model.test.ts).
 */

import { afterEach, describe, expect, it } from "vitest";
import { getJson, jsonRequest, type StudioHarness } from "../harness.test-util.js";
import { makeEngineHarness, waitIdle } from "./test-util.js";

/** The session-level override the reporter's session carries. */
const OVERRIDE = "glm-5.3-flash";
/** The harness engine's BASE (global) model — `OFFLINE_PROFILE.model`. */
const BASE = "offline-model";

const COLD = "sample-ws/cold";
const PLAIN = "sample-ws/plain";

const harnesses: StudioHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** `cold` carries an override; `plain` does not. Neither is activated. */
function engine(): StudioHarness {
  const h = makeEngineHarness({
    sessions: { cold: [], plain: [] },
    meta: {
      cold: { title: "冷会话", model: OVERRIDE, mode: "standard" },
      plain: { title: "无覆盖" },
    },
  });
  harnesses.push(h);
  return h;
}

async function statusOf(h: StudioHarness, id: string | null): Promise<Record<string, unknown>> {
  const q = id === null ? "" : "?session=" + encodeURIComponent(id);
  const res = await getJson(h.app, "/api/status" + q);
  expect(res.status).toBe(200);
  return res.body;
}

describe("W2059 · cold-session statusline reports the session's own model", () => {
  it("a session with an override but NO instance answers its override, not the global base", async () => {
    const h = engine();
    // Deliberately NO activate(): the instance does not exist yet.
    const cold = await statusOf(h, COLD);
    expect(cold["model"], "cold session must report its own session.json.model").toBe(OVERRIDE);
    expect(cold["model_covered"], "…and it IS covered").toBe(true);
    // The global default is untouched by the reading.
    expect((await getJson(h.app, "/api/config")).body["model"]).toBe(BASE);
  });

  it("a session WITHOUT an override still answers the global base", async () => {
    const h = engine();
    const plain = await statusOf(h, PLAIN);
    expect(plain["model"]).toBe(BASE);
    expect(plain["model_covered"]).toBe(false);
  });

  it("cold and warm agree: after the session runs a turn the answer is unchanged", async () => {
    const h = engine();
    expect((await statusOf(h, COLD))["model"]).toBe(OVERRIDE);
    await h.app.request("/api/turn", jsonRequest("POST", { input: "hi", session: COLD }));
    await waitIdle(h);
    expect((await statusOf(h, COLD))["model"], "warm answer must equal the cold one").toBe(OVERRIDE);
  });
});
