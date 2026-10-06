/**
 * W791 (P1) — the mode's OBSERVABLE tool face over the real engine (M7/M9/M10).
 *
 * `docs/modes-standard-vs-execution.md` §3.1 (P1) and §6. Three claims, all on
 * the HTTP contract against the real `packages/runtime` engine (offline LLM, real
 * tools, real registry):
 *
 *   M7  `execution` folds the direct face to the six kept names; `standard` keeps
 *       all eleven contract tools;
 *   M9  `GET /api/tools?session=X` answers the SAME name set `GET /api/config`
 *       (focused on X) renders into `{{tools}}` — one source, two readers;
 *   M10 `POST /api/sessions/{id}/mode` writes `session.json.mode`, drops THAT
 *       session's instance (the next turn recomposes it) and never touches
 *       another session.
 *
 * The 409 busy guard is asserted on the fake adapter (it can hold the slot on
 * demand); everything else runs the real one.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelRequest } from "@celestea/core";
import { getJson, busyRuntime, jsonRequest, makeHarness, type StudioHarness } from "./harness.test-util.js";
import { workspaceHome } from "./store/celestea-home.js";
import { activate, makeEngineHarness, waitIdle } from "./runtime/test-util.js";
import type { OfflineStep } from "./runtime/offline-llm.js";

// W1533: 18 -> 19 (`update_tasks` joins both faces -- it is in the execution keep list).
// W1900: 19 -> 22 -- the compression trio is in the keep list, so BOTH faces grow.
//
// W9331: `agent_swarm` is ABSENT from both, because the swarm plugin is default OFF
// — NOT because the execution mode folds it. It is in the execution KEEP list
// (`packages/tools/src/exposure.ts`), so the `W9331` case at the bottom of this file
// turns the plugin on and asserts the tool then appears in BOTH faces. That is the
// distinction worth keeping visible: the fold rule never changed, only the default
// registration did, and a reader must not conclude from these two arrays that
// execution mode folds `agent_swarm`.
const DEFAULT_EXECUTION_FACE = ["browser_act", "browser_open", "compress", "context_status", "decompress", "forget", "http_request", "load_skill", "process_control", "remember", "run_code", "send_message", "spawn_worker", "stop_worker", "update_tasks", "worker_status"];
const DEFAULT_STANDARD_FACE = ["ask_user_question", "browser_act", "browser_open", "compress", "context_status", "decompress", "forget", "http_request", "list_dir", "load_skill", "process_control", "read_file", "read_image", "remember", "run_code", "run_shell", "send_message", "spawn_worker", "stop_worker", "update_tasks", "worker_status", "write_file"];
/**
 * M2-B · the thirteen `desktop_*` tools are an **optional face** — `ensureDesktopWiring`
 * mounts them only when the host is win32 AND a built helper exists (规划 §5). They are
 * NOT written into the constant above: that one is the UNCONDITIONAL face, and folding
 * an optional mount into it would make "optional" read as "required" on every other host.
 * (The EXECUTION face needs no delta at all — the mode folds them, which is exactly the
 * property the M7 case below asserts.)
 */
const DESKTOP_FACE = ["desktop_activate_window", "desktop_click", "desktop_drag", "desktop_get_window", "desktop_get_window_state", "desktop_launch_app", "desktop_list_apps", "desktop_list_windows", "desktop_press_key", "desktop_scroll", "desktop_secondary_action", "desktop_set_value", "desktop_type_text"];
/** 本机默认面 = 无条件面 + 已挂载的可选面（见 DESKTOP_FACE 的理由）。 */
const MOUNTED_STANDARD_FACE = [...DEFAULT_STANDARD_FACE, ...DESKTOP_FACE].sort();
const EXECUTION_MARK = "Execution mode — prefer one program over many round trips";

/** W9331: the swarm capability, named once so the case below cannot drift from it. */
const SWARM_TOOL = "agent_swarm";
const SWARM_PLUGIN = "celestea.runtime.swarm";

const harnesses: StudioHarness[] = [];

const requests: ModelRequest[] = [];

function engine(): StudioHarness {
  const script: OfflineStep[] = [{ text: "ok" }, { text: "ok" }, { text: "ok" }];
  const h = makeEngineHarness({
    sessions: { std: [], exec: [], plain: [] },
    meta: { std: { mode: "standard" }, exec: { mode: "execution" } },
    llm: { script, onRequest: (req) => requests.push(req) },
  });
  harnesses.push(h);
  return h;
}

afterEach(() => {
  requests.length = 0;
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** The names `GET /api/tools?session=` answers, sorted. */
async function toolsOf(h: StudioHarness, session: string | null): Promise<string[]> {
  const url = session === null ? "/api/tools" : `/api/tools?session=${encodeURIComponent(session)}`;
  const body = (await getJson(h.app, url)).body;
  return (body["tools"] as Array<{ name: string }>).map((t) => t.name).sort();
}

/** The `{{tools}}` list `GET /api/config` renders for the FOCUSED session. */
async function renderedTools(h: StudioHarness): Promise<string[]> {
  const prompt = String((await getJson(h.app, "/api/config")).body["system_prompt"]);
  const match = /directly \(([^)]*)\)/.exec(prompt);
  expect(match, "the assembled prompt must render the {{tools}} list").not.toBeNull();
  return String(match?.[1]).split(", ").sort();
}

describe("W791 P1 mode tool face (real engine)", () => {
  it("M7: standard keeps 11 tools, execution folds the direct face to 6", async () => {
    const h = engine();
    await activate(h, "sample-ws/std");
    await activate(h, "sample-ws/exec");
    expect(await toolsOf(h, "sample-ws/std")).toEqual(MOUNTED_STANDARD_FACE);
    expect(await toolsOf(h, "sample-ws/exec")).toEqual(DEFAULT_EXECUTION_FACE);
    // The COMPOSED INSTANCE — the registry the agent loop really dispatches
    // through — carries the same face. `?session=` is derived from the mode, so
    // this is the independent half of M7: the wiring itself folded.
    const faceOf = (id: string): string[] => h.runtime.sessionContext(id).tools.map((t) => t.name).sort();
    expect(faceOf("sample-ws/std")).toEqual(MOUNTED_STANDARD_FACE);
    expect(faceOf("sample-ws/exec")).toEqual(DEFAULT_EXECUTION_FACE);
    // A session with no declared mode reads as standard (K8).
    await activate(h, "sample-ws/plain");
    expect(await toolsOf(h, "sample-ws/plain")).toEqual(MOUNTED_STANDARD_FACE);
    expect(faceOf("sample-ws/plain")).toEqual(MOUNTED_STANDARD_FACE);
  });

  it("M9: ?session= answers exactly the set the config prompt renders for that session", async () => {
    const h = engine();
    await activate(h, "sample-ws/std");
    await activate(h, "sample-ws/exec");
    for (const id of ["sample-ws/exec", "sample-ws/std"]) {
      await activate(h, id); // focusing X is what `/api/config` reads (S1)
      const asked = await toolsOf(h, id);
      expect(await renderedTools(h), `{{tools}} of ${id}`).toEqual(asked);
    }
    // The FOCUSED session is the default reading: focus the execution one last.
    await activate(h, "sample-ws/exec");
    expect(await toolsOf(h, null)).toEqual(DEFAULT_EXECUTION_FACE);
    expect(await renderedTools(h)).toEqual(DEFAULT_EXECUTION_FACE);
  });

  it("M10: the switch rewrites session.json, recomposes at the NEXT turn and spares other sessions", async () => {
    const h = engine();
    await activate(h, "sample-ws/plain");
    await activate(h, "sample-ws/std");
    // W9331: 23 -> 22 -- `agent_swarm` is no longer registered by default, so the
    // standard face is one name shorter. Asserted as a COUNT here on purpose: this
    // line is what catches a tool appearing or vanishing while the SET assertions
    // elsewhere still line up.
    // M2-B: the frozen count is the UNCONDITIONAL face's length; the mounted optional face
    // (the thirteen desktop tools) is a delta, so the number is derived, not re-typed.
    expect((await getJson(h.app, "/api/tools?session=sample-ws%2Fplain")).body["tools"]).toHaveLength(MOUNTED_STANDARD_FACE.length);

    const res = await getJson(h.app, "/api/sessions/sample-ws%2Fplain/mode", jsonRequest("POST", { mode: "execution" }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, session: "sample-ws/plain", mode: "execution", effective: "next_turn" });
    // The W729 writer, key-preserving: no title/model/prompt existed here.
    expect(readFileSync(join(h.workspace, "plain", "session.json"), "utf8")).toBe('{\n  "mode": "execution"\n}\n');
    // The switch drops THIS session's instance (`invalidateSession`, W516) and
    // the next observation/composition of an IDLE session adopts the new mode —
    // the other session never changed. A turn in flight is what the 409 guard
    // refuses outright, so no running turn can ever be re-pointed mid-flight.
    expect(await toolsOf(h, "sample-ws/plain")).toEqual(DEFAULT_EXECUTION_FACE);
    expect(await toolsOf(h, "sample-ws/std")).toEqual(MOUNTED_STANDARD_FACE);

    // Its prompt follows the mode too (one assembly, two readers: S1/S2).
    await activate(h, "sample-ws/plain");
    expect(String((await getJson(h.app, "/api/config")).body["system_prompt"])).toContain(EXECUTION_MARK);
    expect(await renderedTools(h)).toEqual(DEFAULT_EXECUTION_FACE);

    // Switching BACK restores the whole face.
    const back = await getJson(h.app, "/api/sessions/sample-ws%2Fplain/mode", jsonRequest("POST", { mode: "standard" }));
    expect(back.body["mode"]).toBe("standard");
    await activate(h, "sample-ws/plain");
    expect(await toolsOf(h, "sample-ws/plain")).toEqual(MOUNTED_STANDARD_FACE);
  });

  it("M10: the switch keeps title/model/prompt and rejects an unknown mode or session", async () => {
    const h = engine();
    const created = await getJson(h.app, "/api/sessions", jsonRequest("POST", { workspace: "sample-ws", title: "sw", model: "offline-model", prompt: "p-1" }));
    expect(created.body["ok"]).toBe(true);
    const id = String(created.body["id"]);
    const before = readFileSync(join(workspaceHome(h.workspace), "sessions", id.slice(id.indexOf("/") + 1), "session.json"), "utf8");
    expect(before).toContain('"model": "offline-model"');

    const switched = await getJson(h.app, `/api/sessions/${encodeURIComponent(id)}/mode`, jsonRequest("POST", { mode: "execution" }));
    expect(switched.status).toBe(200);
    const after = JSON.parse(readFileSync(join(workspaceHome(h.workspace), "sessions", id.slice(id.indexOf("/") + 1), "session.json"), "utf8")) as Record<string, unknown>;
    expect(after).toMatchObject({ title: "sw", model: "offline-model", prompt: "p-1", mode: "execution" });

    // Frozen 400 text (the same sentence `POST /api/sessions` freezes).
    const bad = await getJson(h.app, `/api/sessions/${encodeURIComponent(id)}/mode`, jsonRequest("POST", { mode: "fast" }));
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ ok: false, error: "invalid mode: fast" });
    // A missing field is the usual 422; an unknown session is the usual 404.
    const missing = await getJson(h.app, `/api/sessions/${encodeURIComponent(id)}/mode`, jsonRequest("POST", {}));
    expect(missing.status).toBe(422);
    expect(missing.body).toEqual({ ok: false, error: "field 'mode' must be a string" });
    const ghost = await getJson(h.app, "/api/sessions/sample-ws%2Fghost/mode", jsonRequest("POST", { mode: "execution" }));
    expect(ghost.status).toBe(404);
    expect(ghost.body).toEqual({ ok: false, error: "unknown session 'sample-ws/ghost'" });
  });

  it("M10 (U8): the busy guard is /compact's, in semantics and in shape", async () => {
    const h = makeHarness({ runtime: busyRuntime(), session: { name: "s1" } });
    harnesses.push(h);
    const res = await getJson(h.app, "/api/sessions/sample-ws%2Fs1/mode", jsonRequest("POST", { mode: "execution" }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: "turn 进行中，无法切换模式" });
    // Nothing was written while the turn owns the session.
    expect(await getJson(h.app, "/api/sessions/sample-ws%2Fs1/mode", jsonRequest("POST", { mode: "execution" }))).toMatchObject({ status: 409 });
  });

  it("a turn really OFFERS the folded face to the model (the request carries 6 schemas)", async () => {
    const h = engine();
    await activate(h, "sample-ws/exec");
    const res = await h.app.request("/api/turn", jsonRequest("POST", { input: "执行任务", session: "sample-ws/exec" }));
    expect(res.status).toBe(202);
    await waitIdle(h);
    // The folded tools are gone from the direct face but still registered (M8's
    // program path); the log therefore keeps naming them.
    expect(await toolsOf(h, "sample-ws/exec")).toEqual(DEFAULT_EXECUTION_FACE);
    // What the provider was ACTUALLY sent — not a re-derivation of the face.
    const sent = requests.filter((r) => r.tools.some((t) => t.name === "run_code" || t.name === "read_file"));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]?.tools.map((t) => t.name).sort()).toEqual(DEFAULT_EXECUTION_FACE);
  });
});

/**
 * W9331 — the swarm capability's default, asserted as a CONSEQUENCE instead of being
 * dropped from the frozen faces above.
 *
 * `agent_swarm` used to sit in BOTH arrays because the swarm plugin was on by
 * default. It is now off by default, so both arrays describe the default state, and
 * this case asserts what happens when the plugin is turned ON: the tool appears in
 * the standard face **and survives the execution fold**, because it is in the
 * execution KEEP list. That second half is the part worth pinning — it proves the
 * fold rule is untouched and that the capability did not quietly become
 * unreachable in execution mode.
 */
describe("W9331 · the swarm tool is default OFF, and the fold rule is unchanged", () => {
  /** A harness whose PLUGIN store has the swarm plugin explicitly ON. */
  function swarmEngine(): StudioHarness {
    const h = makeEngineHarness({
      sessions: { std: [], exec: [], plain: [] },
      meta: { std: { mode: "standard" }, exec: { mode: "execution" } },
      rawFiles: { "plugins.json": JSON.stringify({ version: 2, disabled: [], enabled: [SWARM_PLUGIN], updated_at: 0 }) },
    });
    harnesses.push(h);
    return h;
  }

  it("by default NEITHER face offers agent_swarm (the plugin is default OFF)", async () => {
    const h = engine();
    await activate(h, "sample-ws/std");
    await activate(h, "sample-ws/exec");
    const std = await toolsOf(h, "sample-ws/std");
    const exec = await toolsOf(h, "sample-ws/exec");
    expect(std).not.toContain(SWARM_TOOL);
    expect(exec).not.toContain(SWARM_TOOL);
    // The whole sets match the frozen defaults, so this is a one-name statement and
    // not a symptom of something bigger having drifted.
    expect(std).toEqual([...MOUNTED_STANDARD_FACE].sort());
    expect(exec).toEqual([...DEFAULT_EXECUTION_FACE].sort());
  });

  it("with the plugin ON it appears in BOTH faces — execution KEEPS it, it does not fold it", async () => {
    const h = swarmEngine();
    // Activated first, exactly like M7/M9: `?session=` derives the face from the
    // session's own mode, and an unactivated session does not answer for it.
    await activate(h, "sample-ws/std");
    await activate(h, "sample-ws/exec");
    const std = await toolsOf(h, "sample-ws/std");
    const exec = await toolsOf(h, "sample-ws/exec");

    expect(std).toContain(SWARM_TOOL);
    expect(exec).toContain(SWARM_TOOL);
    // Exactly the default faces plus the one tool: the fold removed nothing extra.
    expect(std).toEqual([...MOUNTED_STANDARD_FACE, SWARM_TOOL].sort());
    expect(exec).toEqual([...DEFAULT_EXECUTION_FACE, SWARM_TOOL].sort());

    // The prompt renders the SAME set for the FOCUSED session — the single-source
    // rule, checked in the state where the name is actually present.
    await activate(h, "sample-ws/exec");
    expect(await renderedTools(h)).toEqual([...DEFAULT_EXECUTION_FACE, SWARM_TOOL].sort());
  });
});
