/**
 * W860 acceptance at the HTTP surface: the session-level TOOL SWITCHES
 * (GET|PUT /api/sessions/{id}/tools) over the REAL adapter.
 *
 * The invariant under test is W791 §10.5 #2 extended to the new deny source:
 * the stored disabled list reaches the COMPOSED instance (the registry the agent
 * loop dispatches through), the reported face of GET /api/tools?session= and the
 * adapter's own sessionTools seam — all three agree, and they only ever SUBTRACT.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getJson, jsonRequest, type StudioHarness } from "./harness.test-util.js";
import { effectiveGrantsOf } from "./runtime/engine-grants.js";
import type { RealRuntimeAdapter } from "./runtime/real-runtime-adapter.js";
import { engineOf, makeEngineHarness } from "./runtime/test-util.js";
import { FILE_MODES_MEANINGFUL } from "@celestea/tools";
import { checkDesktopMount } from "@celestea/runtime";

const S1 = "sample-ws/s1";
const S2 = "sample-ws/s2";
const EXEC = "sample-ws/exec";
const S1_URL = "/api/sessions/" + encodeURIComponent(S1) + "/tools";
/**
 * Pin the permission env the ENGINE reads so the developer's shell cannot decide
 * the preset these tests start from (the HTTP handlers read process.env, which
 * the suite never sets).
 */
const ENV: NodeJS.ProcessEnv = { CELESTEA_PERMISSION_DEFAULT: "", CELESTEA_PERMISSION_MAX: "" };

/**
 * The frozen standard face of the production registry at its DEFAULTS
 * (W791/W804/W7/W884/F4/B2: 18; W1533: 19; W1900: 22).
 *
 * W9331: `agent_swarm` is **deliberately absent**, and the constant's name now says
 * so. The swarm plugin is default OFF, so a default session is not offered its tool.
 * The guarantee was not deleted — it MOVED, and the tests at the bottom assert it
 * directly: `⑦` pins that the default face really has no `agent_swarm`, `⑦b` that
 * turning the plugin on in the plugin store puts it back, and `⑦c` that the session
 * switch still only SUBTRACTS from it. Naming the constant for the state it
 * describes is what keeps a reader from thinking a capability vanished.
 */
const DEFAULT_STANDARD_FACE: readonly string[] = [
  "ask_user_question",
  "browser_act",
  "browser_open",
  "compress",
  "context_status",
  "decompress",
  "forget",
  "http_request",
  "list_dir",
  "load_skill",
  "process_control",
  "read_file",
  "read_image",
  "remember",
  "run_code",
  "run_shell",
  "send_message",
  "spawn_worker",
  "stop_worker",
  "update_tasks",
  "worker_status",
  "write_file",
].sort();

/**
 * computer-use M2 · the thirteen `desktop_*` tools are an **optional face**, exactly
 * like `read_image` — `ensureDesktopWiring` mounts them only when the host is win32
 * AND a built helper exists (规划 §5：静态检查决定挂不挂).
 *
 * WHY THEY ARE NOT IN THE CONSTANT ABOVE: that one is the UNCONDITIONAL face. Writing
 * an optional mount into it would turn "optional" into "required" on paper — a reader
 * on Linux or on a machine without the helper would take all thirteen for granted, and
 * the constant's whole value is that it describes what is there whatever the host.
 * (Same reasoning that keeps `agent_swarm` out of it, from the other direction: that one
 * is default OFF, these are default ON but conditionally mounted.)
 *
 * What THIS machine sees is the optional face MOUNTED (win32 + helper built), so every
 * "the real face" assertion below is the unconditional face plus this one named delta.
 */
const DESKTOP_FACE: readonly string[] = [
  "desktop_activate_window", "desktop_click", "desktop_drag", "desktop_get_window",
  "desktop_get_window_state", "desktop_launch_app", "desktop_list_apps", "desktop_list_windows",
  "desktop_press_key", "desktop_scroll", "desktop_secondary_action", "desktop_set_value",
  "desktop_type_text",
];

/** 可选面挂没挂，用 plugins-inventory 的同一真实判据（win32 + helper 产物，静态检查）。 */
const DESKTOP_MOUNTED = checkDesktopMount().ok;
/** 本机默认面 = 无条件面 + 已挂载的可选面（见 DESKTOP_FACE 的理由）。 */
const MOUNTED_STANDARD_FACE: readonly string[] = [...DEFAULT_STANDARD_FACE, ...(DESKTOP_MOUNTED ? DESKTOP_FACE : [])].sort();

/**
 * The execution-mode face at its DEFAULTS (W791 M7; W884 load_skill, B2
 * remember/forget kept; W1900 compress trio kept): the fold, before any deny.
 *
 * W9331: `agent_swarm` is absent for the same reason as above, NOT because the mode
 * folds it — it is in the execution KEEP list (`packages/tools/src/exposure.ts`), so
 * `⑦b`'s enabled case asserts it survives the fold once the plugin is on. The fold
 * rule did not change; only the default registration did.
 */
const DEFAULT_EXECUTION_FACE: readonly string[] = [
  "browser_act",
  "browser_open",
  "compress",
  "context_status",
  "decompress",
  "forget",
  "http_request",
  "load_skill",
  "process_control",
  "remember",
  "run_code",
  "send_message",
  "spawn_worker",
  "stop_worker",
  "update_tasks",
  "worker_status",
].sort();

/**
 * W9331: the swarm capability, named once so the three assertions below cannot drift
 * from the plugin they are about.
 */
const SWARM_TOOL = "agent_swarm";
const SWARM_PLUGIN = "celestea.runtime.swarm";

/**
 * The plugin store that turns the swarm plugin ON — the same bytes a user produces
 * by flipping the row in the plugin panel, and the only representation that exists
 * for "a default-off plugin is wanted on" (the disabled table cannot express it).
 */
function swarmOnStore(): string {
  return JSON.stringify({ version: 2, disabled: [], enabled: [SWARM_PLUGIN], updated_at: 0 });
}


const harnesses: StudioHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

function track(h: StudioHarness): StudioHarness {
  harnesses.push(h);
  return h;
}

/** The standard two-session engine harness. */
function engine(): StudioHarness {
  return track(makeEngineHarness({ sessions: { s1: [], s2: [] }, env: ENV }));
}

/** Hand-write <session dir>/permission.json — the shape the W9 writer emits. */
function writePermission(h: StudioHarness, name: string, preset: string): void {
  writeFileSync(join(h.workspace, name, "permission.json"), JSON.stringify({ version: 1, session: "sample-ws/" + name, preset, updated_at: 1_700_000_000 }));
}

/** The adapter seam behind both reported faces. */
function adapterFace(adapter: RealRuntimeAdapter, session: string): string[] {
  const sessionTools = adapter.sessionTools;
  if (sessionTools === undefined) throw new Error("the real adapter must implement sessionTools");
  return sessionTools.call(adapter, session).map((tool) => tool.name).sort();
}

/** GET /api/tools?session=... — the HTTP report face. */
async function httpFace(h: StudioHarness, session: string): Promise<string[]> {
  const res = await getJson(h.app, "/api/tools?session=" + encodeURIComponent(session));
  expect(res.status).toBe(200);
  return (res.body["tools"] as Array<{ name: string }>).map((tool) => tool.name).sort();
}

/** Both report faces plus the composed instance, asserted equal. */
async function agree(h: StudioHarness, session: string): Promise<string[]> {
  const adapter = engineOf(h);
  const composed = adapter.sessionContext(session).tools.map((tool) => tool.name).sort();
  expect(await httpFace(h, session)).toEqual(composed);
  expect(adapterFace(adapter, session)).toEqual(composed);
  return composed;
}

describe("W1900 · the tool face is derived from the DETACHED generation", () => {
  it("the compression trio IS advertised on the detached face, and therefore on every session's", async () => {
    // `RealRuntimeAdapter.sessionTools` reads `registry.peek(null).runtime.tools`
    // — the DETACHED generation's registry — and only then applies the session's
    // mode. That is deliberate (its comment: the face must be a function of the
    // mode, never of "whichever instance happens to be live"), and it means the
    // detached generation is the process's canonical spec source: a tool that is
    // not mounted there is not mounted anywhere, for the prompt's `{{tools}}`
    // either. Measured while trying to gate this mount on "there is a session":
    // the face went from 22 names to 19 on EVERY session.
    const h = engine();
    const res = await getJson(h.app, "/api/tools");
    expect(res.status).toBe(200);
    const detached = (res.body["tools"] as Array<{ name: string }>).map((tool) => tool.name);
    expect(detached).toContain("compress");
    expect(detached).toContain("decompress");
    expect(detached).toContain("context_status");
    // ...and the session face agrees, which is the property that actually matters.
    expect(await httpFace(h, S1)).toEqual(detached);
  });
});

describe("W860 /api/sessions/{id}/tools", () => {
  it("① GET defaults to an empty disabled list and an empty effective deny", async () => {
    const h = engine();
    const res = await getJson(h.app, S1_URL);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, session: S1, disabled: [], effective: { toolDeny: [] } });
    // An unknown session is the store's own 404, never an empty success.
    const missing = await getJson(h.app, "/api/sessions/" + encodeURIComponent("sample-ws/nope") + "/tools");
    expect(missing.status).toBe(404);
    expect(missing.body["ok"]).toBe(false);
  });

  it("② PUT persists the list, GET reads it back and BOTH report faces lose the tool", async () => {
    const h = engine();

    const put = await getJson(h.app, S1_URL, jsonRequest("PUT", { disabled: ["write_file"] }));
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ ok: true, session: S1, disabled: ["write_file"], effective: { toolDeny: ["write_file"] } });

    const get = await getJson(h.app, S1_URL);
    expect(get.body).toEqual(put.body);

    // The frozen file shape + the 0600 mode (same durability as permission.json).
    const path = join(h.workspace, "s1", "tools.json");
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(onDisk).toEqual({ version: 1, session: S1, disabled: ["write_file"], updated_at: expect.any(Number) });
    if (FILE_MODES_MEANINGFUL) expect(statSync(path).mode & 0o777).toBe(0o600);

    // Composed instance = HTTP report = adapter seam, and all three dropped it.
    const expected = MOUNTED_STANDARD_FACE.filter((name) => name !== "write_file");
    expect(await agree(h, S1)).toEqual(expected);
    expect(await httpFace(h, S1)).not.toContain("write_file");

    // Writing the list back to [] restores the tool (the deny is not sticky).
    const cleared = await getJson(h.app, S1_URL, jsonRequest("PUT", { disabled: [] }));
    expect(cleared.status).toBe(200);
    expect(cleared.body["disabled"]).toEqual([]);
    expect(cleared.body["effective"]).toEqual({ toolDeny: [] });
    expect(await agree(h, S1)).toEqual(MOUNTED_STANDARD_FACE);
  });

  it("③ unions the preset deny with the session deny, preset first", async () => {
    const h = engine();
    writePermission(h, "s1", "read-only");

    const put = await getJson(h.app, S1_URL, jsonRequest("PUT", { disabled: ["http_request"] }));
    expect(put.status).toBe(200);
    // preset toolDeny first, session disabled second — the frozen union order.
    expect(put.body["effective"]).toEqual({ toolDeny: ["write_file", "http_request"] });

    const get = await getJson(h.app, S1_URL);
    expect(get.body["disabled"]).toEqual(["http_request"]);
    expect(get.body["effective"]).toEqual({ toolDeny: ["write_file", "http_request"] });

    const expected = MOUNTED_STANDARD_FACE.filter((name) => name !== "write_file" && name !== "http_request");
    expect(await agree(h, S1)).toEqual(expected);
  });

  it("③b execution mode: a disabled tool that was already folded never comes back", async () => {
    const h = track(makeEngineHarness({ sessions: { exec: [] }, meta: { exec: { mode: "execution" } }, env: ENV }));
    writePermission(h, "exec", "read-only");

    // The execution face first (no tools.json).
    //
    // M2-B: `agree()` 同时断言三件东西相等 —— 组合实例的 `sessionContext().tools`（**就是
    // loop 发给模型的 tool 数组**）、`GET /api/tools` 与 adapter 的 sessionTools 面。
    // 修复前它们在这里就已经不一致（组合面 29 名 vs 报告面 16 名），根因是 execution 的
    // 折叠名单是构造时的**快照**，而 desktop（4e）与 swarm（4c）都是晚挂的插件。
    expect(await agree(h, EXEC)).toEqual(DEFAULT_EXECUTION_FACE);
    // 把那 13 个名字显式点名：只比「等于 16 名」的话，一个把 desktop_* 换掉别的工具的实现
    // 也能通过。execution 模式的承诺是「按名字折叠」，所以这里按名字断言。
    const execFace = await agree(h, EXEC);
    expect(execFace.filter((name) => name.startsWith("desktop_"))).toEqual([]);
    expect(execFace).not.toContain(SWARM_TOOL);

    // read_file is folded by the mode AND denied by the preset AND disabled by
    // the session: the intersection stays the execution face.
    const put = await getJson(h.app, "/api/sessions/" + encodeURIComponent(EXEC) + "/tools", jsonRequest("PUT", { disabled: ["read_file"] }));
    expect(put.status).toBe(200);
    expect((put.body["effective"] as { toolDeny: string[] }).toolDeny).toContain("read_file");
    expect((put.body["effective"] as { toolDeny: string[] }).toolDeny).toContain("write_file");
    expect(await agree(h, EXEC)).toEqual(DEFAULT_EXECUTION_FACE);
    expect(await httpFace(h, EXEC)).not.toContain("read_file");
    expect(await httpFace(h, EXEC)).not.toContain("write_file");
  });

  it("④ rejects a non-array / non-string / blank entry with a 422 naming the field", async () => {
    const h = engine();
    for (const body of [{}, { disabled: "write_file" }, { disabled: [1] }, { disabled: [null] }, { disabled: [""] }, { disabled: ["  "] }]) {
      const res = await getJson(h.app, S1_URL, jsonRequest("PUT", body));
      expect(res.status).toBe(422);
      expect(res.body["ok"]).toBe(false);
      expect(String(res.body["error"])).toContain("disabled");
    }
    // None of the rejected bodies wrote a file: the session still runs untouched.
    expect(await getJson(h.app, S1_URL)).toMatchObject({ body: { disabled: [] } });
    expect(await agree(h, S1)).toEqual(MOUNTED_STANDARD_FACE);
  });

  it("⑤ disables per session: a neighbour is unaffected", async () => {
    const h = engine();
    await getJson(h.app, S1_URL, jsonRequest("PUT", { disabled: ["write_file"] }));

    const neighbour = await getJson(h.app, "/api/sessions/" + encodeURIComponent(S2) + "/tools");
    expect(neighbour.body).toEqual({ ok: true, session: S2, disabled: [], effective: { toolDeny: [] } });
    expect(await httpFace(h, S2)).toEqual(MOUNTED_STANDARD_FACE);
    expect(await httpFace(h, S1)).toEqual(MOUNTED_STANDARD_FACE.filter((name) => name !== "write_file"));
  });

  it("⑥ a void tools.json is fail-closed: 200, one warning, the session runs as if nothing were disabled", async () => {
    const h = engine();
    const path = join(h.workspace, "s1", "tools.json");
    const voidBodies = [
      "{ nope",
      JSON.stringify({ version: 2, session: S1, disabled: ["write_file"] }),
      JSON.stringify({ version: 1, session: "sample-ws/other", disabled: ["write_file"] }),
      JSON.stringify({ version: 1, session: S1, disabled: "write_file" }),
      JSON.stringify({ version: 1, session: S1, disabled: [1] }),
      JSON.stringify(["write_file"]),
    ];
    for (const body of voidBodies) {
      writeFileSync(path, body);
      const res = await getJson(h.app, S1_URL);
      expect(res.status).toBe(200);
      expect(res.body["disabled"]).toEqual([]);
      const warnings = res.body["warnings"] as string[];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("tools_unreadable");
      expect(warnings[0]).toContain("the session runs with no tools disabled");
      expect(await agree(h, S1)).toEqual(MOUNTED_STANDARD_FACE);
    }
    // A later PUT repairs the file by overwriting it.
    const put = await getJson(h.app, S1_URL, jsonRequest("PUT", { disabled: ["write_file"] }));
    expect(put.status).toBe(200);
    expect(await httpFace(h, S1)).toEqual(MOUNTED_STANDARD_FACE.filter((name) => name !== "write_file"));
  });
});

/**
 * W9331 — the swarm capability's default, asserted as a CONSEQUENCE rather than
 * removed from a list.
 *
 * Before W9331 `agent_swarm` sat in the frozen faces above because the swarm plugin
 * was on by default. It is now default OFF, so the faces describe the default state
 * and the capability's presence is asserted where it is now decided: the plugin
 * store. These three tests are also what makes the old guarantee (the tool really is
 * offered, and really is removable) survive the move.
 */
describe("W9331 · the swarm tool is default OFF and composes with the session switch", () => {
  /** A harness whose PLUGIN store has the swarm plugin explicitly ON. */
  function swarmEngine(): StudioHarness {
    return track(makeEngineHarness({ sessions: { s1: [], s2: [] }, env: ENV, rawFiles: { "plugins.json": swarmOnStore() } }));
  }

  it("⑦ the default face does NOT offer agent_swarm (the plugin is default OFF)", async () => {
    const h = engine();
    const face = await agree(h, S1);
    expect(face).not.toContain(SWARM_TOOL);
    // The rest of the frozen face is intact: this is a switch, not a teardown, and
    // asserting the WHOLE set is what keeps this from being a one-name check.
    expect(face).toEqual(MOUNTED_STANDARD_FACE);
  });

  it("⑦b turning the plugin ON in the plugin store puts agent_swarm back on the offered face", async () => {
    const h = swarmEngine();
    const face = await agree(h, S1);
    expect(face).toContain(SWARM_TOOL);
    // Exactly the default face plus the one tool — nothing else moved.
    expect(face).toEqual([...MOUNTED_STANDARD_FACE, SWARM_TOOL].sort());
    // Both report faces and the composed instance agree (the `agree` helper asserts
    // that), so the tool the model is offered is the tool GET reports.
  });

  it("⑦c with the plugin ON, the session switch still only SUBTRACTS", async () => {
    const h = swarmEngine();
    // The deny is written BEFORE S1 is ever composed, which is the same ordering
    // cases ②-⑥ use.
    const put = await getJson(h.app, S1_URL, jsonRequest("PUT", { disabled: [SWARM_TOOL] }));
    expect(put.status).toBe(200);
    expect(put.body["effective"]).toEqual({ toolDeny: [SWARM_TOOL] });

    // The REPORTED face loses exactly one name and nothing else. This is the same
    // face case ⑤'s neighbour assertion uses (`httpFace`), and the reason it is the
    // right one here: it is derived from the stored deny on every read, so it does
    // not depend on which generation happens to be cached.
    expect(await httpFace(h, S1)).toEqual([...MOUNTED_STANDARD_FACE].sort());
    expect(await httpFace(h, S1)).not.toContain(SWARM_TOOL);

    // The neighbour is untouched — case ⑤'s intent, now checked in the state where
    // the tool is actually PRESENT (asserting a neighbour while the tool is absent
    // everywhere would prove nothing about per-session isolation).
    const neighbour = await httpFace(h, S2);
    expect(neighbour).toContain(SWARM_TOOL);
    expect(neighbour).toEqual([...MOUNTED_STANDARD_FACE, SWARM_TOOL].sort());

    // ...and clearing the session deny brings it back.
    const cleared = await getJson(h.app, S1_URL, jsonRequest("PUT", { disabled: [] }));
    expect(cleared.status).toBe(200);
    expect(await httpFace(h, S1)).toEqual([...MOUNTED_STANDARD_FACE, SWARM_TOOL].sort());
  });
});

describe("W860 store + reader", () => {
  const roots: string[] = [];

  afterAll(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** A session dir at <tmp>/ws/s1 with a log; its trusted id is "ws/s1". */
  function sessionDir(name: string): string {
    const root = mkdtempSync(join(tmpdir(), "w860-tools-" + name + "-"));
    roots.push(root);
    const dir = join(root, "ws", "s1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cli-main.jsonl"), "");
    return dir;
  }

  function envOf(dir: string): NodeJS.ProcessEnv {
    return { CELESTEA_WORKSPACES_FILE: join(dirname(dir), "workspaces.json"), HOME: process.env["HOME"] ?? homedir() };
  }

  const NOW = 1_700_000_500;

  it("a session deny joins toolDeny and changes NO other cap; a broken file only warns", () => {
    const dir = sessionDir("cap");
    writeFileSync(
      join(dir, "grants.json"),
      JSON.stringify({
        version: 1,
        session: "ws/s1",
        updated_at: 1,
        grants: [{ id: "g-net", cap: "net_hosts", scope: { hosts: ["10.1.2.3"] }, granted_at: 1_700_000_000, granted_by: "hand", expires_at: null, uses_left: null, note: "" }],
      }),
    );
    const before = effectiveGrantsOf(dir, "ws/s1", envOf(dir), NOW);
    expect(before.grants.netHosts).toEqual(["10.1.2.3"]);
    expect(before.grants.toolDeny).toEqual([]);
    expect(before.warnings).toEqual([]);

    // Hand-written on purpose: blanks are dropped, duplicates collapse, order holds.
    writeFileSync(join(dir, "tools.json"), JSON.stringify({ version: 1, session: "ws/s1", disabled: ["write_file", " http_request ", "write_file", ""] }));
    const after = effectiveGrantsOf(dir, "ws/s1", envOf(dir), NOW);
    expect(after.grants.toolDeny).toEqual(["write_file", "http_request"]);
    expect(after.grants.netHosts).toEqual(before.grants.netHosts);
    expect(after.grants.readRoots).toEqual(before.grants.readRoots);
    expect(after.grants.writeRoots).toEqual(before.grants.writeRoots);
    expect(after.grants.toolExtra).toEqual(before.grants.toolExtra);
    expect(after.grants.unsandboxed).toBe(before.grants.unsandboxed);
    expect(after.grants.network).toBe(before.grants.network);
    expect(after.grants.workspaceWritable).toBe(before.grants.workspaceWritable);
    expect(after.warnings).toEqual([]);

    writeFileSync(join(dir, "tools.json"), "{ nope");
    const broken = effectiveGrantsOf(dir, "ws/s1", envOf(dir), NOW);
    expect(broken.grants.toolDeny).toEqual([]);
    expect(broken.grants.netHosts).toEqual(before.grants.netHosts);
    expect(broken.warnings).toHaveLength(1);
    expect(broken.warnings[0]).toContain("tools_unreadable");
  });

  it("keeps the no-sessionDir path byte-identical (toolDeny stays empty)", () => {
    expect(effectiveGrantsOf(null, null, {}, NOW).grants.toolDeny).toEqual([]);
  });
});
