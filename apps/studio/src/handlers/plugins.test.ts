/**
 * W9322 — `PUT /api/plugins`（`docs/feature-plugin-hotswap.md` §3/§5/§6）。
 *
 * 这里测的是 **HTTP 面的判定**，不是引擎换代（那在
 * `runtime/plugin-hotswap.test.ts`）：
 *
 *   ① 停用一个 `required` 行 = **422 + 原因**，不是静默忽略（§6.3 的同一条纪律）；
 *   ② 有活跃会话时换 `studio/bus` / `studio/runtime` = **409 + 原因 + busy_sessions**，
 *      没有活跃会话时同一请求成功（§3.2 的 `idle-only`）；
 *   ③ 两个并发 `PUT` 不丢更新（专用 SerialQueue）；
 *   ④ 双向向后兼容：不发 `disabled` / 不发 `enabled` 都保留原值（§5）；
 *   ⑤ 形状与 `GET/PUT /api/display-plugins` 对齐，但**清单外的名字被丢弃**——
 *      因为服务端知道自己 mount 了什么（display-plugins 那里它不知道）。
 *
 * 「有活跃会话」在本文件里是**真的**：脚本回合有 `stepDelayMs`，测试在它跑着的时候
 * 发 PUT，所以 409 不是靠桩函数假装的。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeRuntimeAdapter, type FakeRuntimeAdapter } from "../fake-runtime-adapter.js";
import { getJson, jsonRequest, makeHarness, type StudioHarness } from "../harness.test-util.js";
import { PLUGINS_FILE, readPlugins } from "../store/plugins.js";

const harnesses: StudioHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** 一个脚本回合会「跑一会儿」的 harness —— 让 busy 窗口由测试控制。 */
function open(stepDelayMs = 0): StudioHarness {
  const runtime = createFakeRuntimeAdapter({ profile: { model: "test-model" }, stepDelayMs });
  const h = makeHarness({ runtime: runtime as unknown as FakeRuntimeAdapter, session: { name: "s1", log: "" } });
  harnesses.push(h);
  return h;
}

interface PluginRow {
  name: string;
  layer: string;
  hot: boolean;
  enabled: boolean;
  disable: string;
}

async function rowsOf(h: StudioHarness): Promise<PluginRow[]> {
  const res = await getJson(h.app, "/api/plugins");
  return res.body["plugins"] as PluginRow[];
}

async function put(h: StudioHarness, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return getJson(h.app, "/api/plugins", jsonRequest("PUT", body));
}

/**
 * 一条回合在跑（`POST /api/turn` 立刻返回 202，回合在后台）。
 *
 * 先 activate：`busySessions()` 报的是**有 id 的活跃会话**，而一个「没有活跃会话」
 * 的回合只会把 `null` 塞进 fake 的 live 表（随后被过滤掉），那样这个用例永远拿不到
 * 409 —— 而它要验的正是「有活跃会话时被拒」。
 */
async function startTurn(h: StudioHarness, input = "hi"): Promise<void> {
  await getJson(h.app, "/api/sessions/sample-ws%2Fs1/activate", jsonRequest("POST"));
  const res = await getJson(h.app, "/api/turn", jsonRequest("POST", { input }));
  expect(res.status).toBe(202);
  expect(h.runtime.isBusy()).toBe(true);
  expect(h.runtime.busySessions()).toEqual(["sample-ws/s1"]);
}

describe("W9322 PUT /api/plugins · required rows", () => {
  it("refuses to disable a required row with a reason (422), never silently", async () => {
    const h = open();
    for (const name of ["studio/workspaces", "studio/settings", "studio.engine.agent-loop", "studio.engine.llm"]) {
      const res = await put(h, { disabled: [name] });
      expect(res.status, name).toBe(422);
      expect(res.body["ok"], name).toBe(false);
      expect(res.body["plugin"], name).toBe(name);
      expect(String(res.body["error"]), name).toContain(`plugin '${name}' cannot be disabled`);
      expect(String(res.body["error"]).length, name).toBeGreaterThan(`plugin '${name}' cannot be disabled: `.length);
    }
    // Nothing was persisted by any of the refusals.
    expect((await rowsOf(h)).every((row) => row.enabled)).toBe(true);
    expect((await getJson(h.app, "/api/plugins")).body["disabled"]).toEqual([]);
  });

  it("drops names outside the catalog instead of persisting a row that can never take effect", async () => {
    const h = open();
    const res = await put(h, { disabled: ["ghost/plugin", "studio.engine.tools"] });
    expect(res.status).toBe(200);
    expect(res.body["disabled"]).toEqual(["studio.engine.tools"]);
    expect((await rowsOf(h)).find((row) => row.name === "studio.engine.tools")?.enabled).toBe(false);
  });
});

describe("W9322 PUT /api/plugins · idle-only rows (studio/bus, studio/runtime)", () => {
  it("is REFUSED with a reason while a turn is running", async () => {
    const h = open(30_000);
    await startTurn(h);
    try {
      for (const name of ["studio/bus", "studio/runtime"]) {
        const res = await put(h, { disabled: [name] });
        expect(res.status, name).toBe(409);
        expect(res.body["ok"], name).toBe(false);
        expect(res.body["plugin"], name).toBe(name);
        expect(String(res.body["error"]), name).toContain(`cannot change '${name}'`);
        expect(String(res.body["error"]), name).toContain("active");
        // The reason is the row's own documented one, and the blocker is named.
        expect(res.body["busy_sessions"], name).toEqual(["sample-ws/s1"]);
      }
      // A refused swap left the table untouched.
      expect((await rowsOf(h)).find((row) => row.name === "studio/bus")?.enabled).toBe(true);
    } finally {
      h.runtime.cancel();
      await (h.runtime as unknown as FakeRuntimeAdapter).whenIdle();
    }
  });

  it("is ACCEPTED once no session is running (the gate is the live busy set, not 'a session exists')", async () => {
    const h = open(30_000);
    // Activate a session first: it exists but runs no turn, so the gate is open.
    await getJson(h.app, "/api/sessions/sample-ws%2Fs1/activate", jsonRequest("POST"));
    expect(h.runtime.liveSessions()).toEqual(["sample-ws/s1"]);

    const res = await put(h, { disabled: ["studio/bus"] });
    expect(res.status).toBe(200);
    expect(res.body["disabled"]).toEqual(["studio/bus"]);
    expect((await rowsOf(h)).find((row) => row.name === "studio/bus")?.enabled).toBe(false);

    // ...and a no-op PUT of the SAME state is never refused, even mid-turn: it
    // changes nothing, so there is nothing to protect.
    await startTurn(h);
    try {
      const again = await put(h, { disabled: ["studio/bus"] });
      expect(again.status).toBe(200);
    } finally {
      h.runtime.cancel();
      await (h.runtime as unknown as FakeRuntimeAdapter).whenIdle();
    }
  });
});

describe("W9322 PUT /api/plugins · the enabled table", () => {
  it("replaces the table and reports the whole new shape back", async () => {
    const h = open();
    const res = await put(h, { disabled: ["studio.engine.tools", "celestea.runtime.swarm"] });
    expect(res.status).toBe(200);
    expect(res.body["ok"]).toBe(true);
    expect(res.body["disabled"]).toEqual(["studio.engine.tools", "celestea.runtime.swarm"]);
    const rows = res.body["plugins"] as PluginRow[];
    expect(rows.filter((row) => !row.enabled).map((row) => row.name)).toEqual(["studio.engine.tools", "celestea.runtime.swarm"]);
    // The response IS the GET body (one construction, two readers).
    expect(res.body).toEqual((await getJson(h.app, "/api/plugins")).body);
  });

  it("accepts the complement shape (`enabled`) and keeps the two projections consistent", async () => {
    const h = open();
    const all = (await rowsOf(h)).map((row) => row.name);
    const enabled = all.filter((name) => name !== "celestea.runtime.watchdog");
    const res = await put(h, { enabled });
    expect(res.status).toBe(200);
    expect(res.body["disabled"]).toEqual(["celestea.runtime.watchdog"]);
    const rows = res.body["plugins"] as PluginRow[];
    expect(rows.filter((row) => row.enabled).map((row) => row.name)).toEqual(enabled);
  });

  it("refuses a self-contradicting body (both fields, same name)", async () => {
    const h = open();
    const res = await put(h, { disabled: ["studio.engine.tools"], enabled: ["studio.engine.tools"] });
    expect(res.status).toBe(422);
    expect(String(res.body["error"])).toContain("contradict each other on 'studio.engine.tools'");
  });

  it("validates the array fields (422) and bounds their length", async () => {
    const h = open();
    expect((await put(h, { disabled: "studio.engine.tools" })).status).toBe(422);
    expect((await put(h, { disabled: [1, 2] })).status).toBe(422);
    expect((await put(h, { disabled: ["  "] })).status).toBe(422);
    const long = Array.from({ length: 65 }, (_v, i) => `p${i}`);
    const res = await put(h, { disabled: long });
    expect(res.status).toBe(422);
    expect(String(res.body["error"])).toContain("at most 64 names");
    // No body at all is still "nothing said" (415, the frozen convention).
    const empty = await getJson(h.app, "/api/plugins", { method: "PUT" });
    expect(empty.status).toBe(415);
  });
});

describe("W9322 PUT /api/plugins · back-compat and serialization", () => {
  it("an older client that sends NEITHER field keeps the stored table (both directions)", async () => {
    const h = open();
    expect((await put(h, { disabled: ["studio.engine.tools"] })).status).toBe(200);
    // A client from before `disabled` existed posts some unrelated body.
    const res = await put(h, { something_else: true });
    expect(res.status).toBe(200);
    expect(res.body["disabled"]).toEqual(["studio.engine.tools"]);
    // ...and one that only knows `enabled` still gets its complement stored.
    const back = await put(h, { enabled: (await rowsOf(h)).map((row) => row.name) });
    expect(back.status).toBe(200);
    expect(back.body["disabled"]).toEqual([]);
  });

  it("two concurrent PUTs do not lose an update", async () => {
    const h = open();
    const [a, b] = await Promise.all([
      put(h, { disabled: ["studio.engine.tools"] }),
      put(h, { disabled: ["studio.engine.tools", "celestea.runtime.swarm"] }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // The later request ran strictly after the earlier one (the dedicated
    // SerialQueue), so its list is the one on disk -- never a half-written blend.
    const after = await getJson(h.app, "/api/plugins");
    expect(after.body["disabled"]).toEqual(["studio.engine.tools", "celestea.runtime.swarm"]);
    expect((after.body["plugins"] as PluginRow[]).filter((row) => !row.enabled).map((row) => row.name)).toEqual([
      "studio.engine.tools",
      "celestea.runtime.swarm",
    ]);
  });

  it("persists to plugins.json, so the table outlives the process", async () => {
    const h = open();
    await put(h, { disabled: ["studio.engine.tools"] });
    // The file the next boot will read — the store's own reader is the ONE that
    // decides what "restart" means (`store/plugins.test.ts` covers its edge cases).
    const raw = JSON.parse(readFileSync(join(h.root, PLUGINS_FILE), "utf8")) as Record<string, unknown>;
    expect(raw["disabled"]).toEqual(["studio.engine.tools"]);
    expect(readPlugins(h.root).disabled).toEqual(["studio.engine.tools"]);
  });
});
