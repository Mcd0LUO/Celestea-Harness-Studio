/**
 * W860 + W9322 — `GET /api/plugins` 必须是**真实装配出来的**两层插件清单，
 * 绝不是一份手抄的常量。
 *
 * 两层各有各的「真源」，而且各有一条反漂移断言：
 *
 *   · **host 层**：`composeStudio` 在 mount 时用 `pluginNames` 记录了它实际 mount 的
 *     两个数组（`StudioServices.hostPluginNames`），处理器读那条记录。本文件把它从
 *     `storePlugins()` / `hostPlugins()` **重新推导一遍**再逐名对比——所以
 *     `plugins.ts` 多一个插件而清单没跟上，这条用例立刻红（W860 的原设计）。
 *
 *   · **引擎层**（W9322 新增）：`ENGINE_PLUGIN_NAMES` 是清单里的名字表，而
 *     `RealRuntimeAdapter.pluginNames(session)` 返回**这个会话当前那一代真正 mount
 *     的插件名**。下面那条用例装配一个真实引擎会话并把两者逐一对比——这是引擎层
 *     清单唯一的防漂移闸门（`docs/feature-plugin-hotswap.md` §2/§6.1）。
 *
 * 边界也在这里被钉住：清单是**装配事实**，不是「配置快照」。开关一个插件会改变
 * `enabled`，但不会让任何一行凭空出现或消失——所以 `PUT` 前后行数与名字集合不变。
 */

import { afterEach, describe, expect, it } from "vitest";
import { pluginNames } from "@celestea/core";
import { ENGINE_PLUGIN_NAMES, pluginCatalog } from "./plugin-catalog.js";
import { FIXED_NOW, getJson, jsonRequest, makeHarness, type StudioHarness } from "./harness.test-util.js";
import { hostPlugins, storePlugins } from "./plugins.js";
import { engineOf, makeEngineHarness } from "./runtime/test-util.js";

const harnesses: StudioHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

function open(): StudioHarness {
  const h = makeHarness({ session: { name: "s1", log: "" } });
  harnesses.push(h);
  return h;
}

interface PluginRow {
  name: string;
  layer: string;
  hot: boolean;
  enabled: boolean;
  disable: string;
  reason?: string;
}

async function rowsOf(h: StudioHarness): Promise<PluginRow[]> {
  const res = await getJson(h.app, "/api/plugins");
  expect(res.status).toBe(200);
  expect(res.body["ok"]).toBe(true);
  return res.body["plugins"] as PluginRow[];
}

describe("W860 GET /api/plugins · host layer", () => {
  it("returns exactly the names storePlugins()/hostPlugins() mounted, in mount order", async () => {
    const h = open();
    const rows = await rowsOf(h);

    // Re-derived from the LIVE factories — the anti-drift assertion (a
    // hand-copied constant in the handler fails here the day plugins.ts grows).
    const expectedHost = [
      ...pluginNames(storePlugins(h.studio.services.config, () => FIXED_NOW)),
      ...pluginNames(hostPlugins(h.runtime, h.studio.services.bus)),
    ];
    const hostRows = rows.filter((row) => row.layer === "host");
    expect(hostRows.map((row) => row.name)).toEqual(expectedHost);
    // The record the handler reads IS that mount record.
    expect(h.studio.services.hostPluginNames).toEqual(expectedHost);

    // Frozen contents today: the five store plugins + the three host singletons.
    expect(hostRows.map((row) => row.name)).toEqual([
      "studio/workspaces",
      "studio/sessions",
      "studio/session-ops",
      "studio/providers",
      "studio/prompts",
      "studio/bus",
      "studio/runtime",
      "studio/settings",
    ]);
    expect(new Set(rows.map((row) => row.name)).size).toBe(rows.length);
  });
});

describe("W9322 GET /api/plugins · engine layer", () => {
  it("lists the engine plugins a REAL composed session mounts, name for name", async () => {
    // The engine layer can only be pinned against a REAL composition: the whole
    // point of W9322 is that these names were never in the host inventory.
    const h = makeEngineHarness({ sessions: { s1: [] } });
    harnesses.push(h);
    await getJson(h.app, "/api/sessions/sample-ws%2Fs1/activate", jsonRequest("POST"));

    const mounted = engineOf(h).pluginNames("sample-ws/s1");
    // `compose()` appends the workers plugin, the swarm plugin and the watchdog
    // to the host's plugin list, in that order — so the mounted list IS the
    // engine inventory. (W9322 had to fix `pluginNamesOf`: the swarm plugin was
    // really mounted — `agent_swarm` is in the registry — but was never NAMED.)
    expect(mounted).toEqual([...ENGINE_PLUGIN_NAMES]);

    const engineRows = (await rowsOf(h)).filter((row) => row.layer === "engine");
    expect(engineRows.map((row) => row.name)).toEqual(mounted);
    // Order is semantics (ARCHITECTURE.md §3.2): the inventory must keep it.
    expect(engineRows.map((row) => row.name)).toEqual([
      "studio.engine.llm",
      "studio.engine.agent-loop",
      "studio.engine.tools",
      "celestea.runtime.workers",
      "celestea.runtime.swarm",
      "celestea.runtime.watchdog",
    ]);
  });

  it("carries the tools/workers/swarm/watchdog functionality the user can recognise", async () => {
    // The complaint that started W9322: the panel showed only service tokens, so
    // no row named a capability a user could recognise. These four are exactly
    // those capabilities, and they are the four the user may switch OFF.
    const h = open();
    const rows = await rowsOf(h);
    const byName = new Map(rows.map((row) => [row.name, row]));
    for (const name of ["studio.engine.tools", "celestea.runtime.workers", "celestea.runtime.swarm", "celestea.runtime.watchdog"]) {
      expect(byName.get(name)?.layer).toBe("engine");
      expect(byName.get(name)?.disable).toBe("optional");
      expect(byName.get(name)?.enabled).toBe(true);
    }
  });

  it("is a startup inventory: activating a session adds no row", async () => {
    const h = open();
    const before = (await rowsOf(h)).map((row) => row.name);
    await getJson(h.app, "/api/sessions/sample-ws%2Fs1/activate", jsonRequest("POST"));
    const after = (await rowsOf(h)).map((row) => row.name);
    expect(after).toEqual(before);
  });
});

describe("W9322 GET /api/plugins · per-row honesty", () => {
  it("reports a REAL `hot` per row and a disable policy with a reason", async () => {
    const h = open();
    const rows = await rowsOf(h);

    // `hot` is no longer hardcoded false: it answers "is this row re-assembled per
    // generation?" (docs/feature-plugin-hotswap.md §3.2), which is true for every
    // row today — the field is reserved for a genuinely un-swappable row later.
    expect(rows.every((row) => row.hot === true)).toBe(true);
    // ...and it is NOT the same question as "may I switch this off".
    expect(rows.some((row) => row.hot === true && row.disable === "required")).toBe(true);

    // Every non-optional row MUST state why — a refusal has to be able to explain
    // itself, and this is where the explanation lives.
    for (const row of rows.filter((r) => r.disable !== "optional")) {
      expect(row.reason, `${row.name} must state why it is not freely switchable`).toBeTruthy();
    }
    // The frozen policy of today.
    expect(rows.find((row) => row.name === "studio/bus")?.disable).toBe("idle-only");
    expect(rows.find((row) => row.name === "studio/runtime")?.disable).toBe("idle-only");
    expect(rows.find((row) => row.name === "studio/workspaces")?.disable).toBe("required");
    expect(rows.find((row) => row.name === "studio.engine.tools")?.disable).toBe("optional");
    // `enabled` is the complement of the stored disabled list.
    expect(rows.every((row) => row.enabled === true)).toBe(true);
  });

  it("agrees with the catalog module row for row (one construction, two readers)", async () => {
    const h = open();
    const rows = await rowsOf(h);
    const catalog = pluginCatalog(h.studio.services.hostPluginNames);
    expect(rows.map((row) => ({ ...row }))).toEqual(catalog.map((row) => ({ ...row, enabled: true })));
  });
});
