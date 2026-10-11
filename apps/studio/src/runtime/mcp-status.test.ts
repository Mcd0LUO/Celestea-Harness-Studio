/**
 * W-C1b · the MCP status surface behind `GET /api/plugins`.
 * (docs/feature/mcp-client.md §6.3.)
 *
 * Two readers, one construction (the invariant plugin-catalog.ts already keeps
 * with its host names): the aggregate is built in `mcp-status.ts`, and the
 * catalog row carries it — so the handler reads the same value the panel does.
 *
 * The row is asserted over the REAL HTTP endpoint on purpose: the failure mode
 * this guards against is a field that exists in the type and never reaches the
 * wire, which no unit test of the catalog could see.
 */

import { afterEach, describe, expect, it } from "vitest";

import { getJson, makeHarness, type StudioHarness } from "../harness.test-util.js";
import { ENGINE_MCP_PLUGIN, pluginCatalog } from "../plugin-catalog.js";
import { mcpCatalogStatus, publishMcpStatus, resetMcpStatus, type McpCatalogStatus } from "./mcp-status.js";

const harnesses: StudioHarness[] = [];

afterEach(() => {
  resetMcpStatus();
  for (const h of harnesses.splice(0)) h.cleanup();
});

function row(server: string, state: string, toolCount: number): McpCatalogStatus["rows"][number] {
  return { server, session: "s1", transport: "stdio", state, toolCount };
}

describe("W-C1b mcp-status aggregate", () => {
  it("reports nothing at all while no generation is mounted", () => {
    expect(mcpCatalogStatus()).toBeNull();
  });

  it("sums the generations and reports the WORST state, never the best", () => {
    publishMcpStatus("s1", { sessions: 1, servers: 2, tools: 5, state: "ready", error: null, rows: [row("memory", "ready", 3), row("wiki", "ready", 2)], issues: [] });
    publishMcpStatus("s2", { sessions: 1, servers: 1, tools: 1, state: "failed", error: null, rows: [row("git", "failed", 0)], issues: [] });

    const status = mcpCatalogStatus();

    expect(status?.sessions).toBe(2);
    expect(status?.servers).toBe(3);
    expect(status?.tools).toBe(6);
    // A row that read "ready" while one server is down would be a lying panel.
    expect(status?.state).toBe("failed");
    expect(status?.rows.map((r) => r.server)).toEqual(["git", "memory", "wiki"]);
  });

  it("withdraws a released generation instead of leaving its tools advertised", () => {
    publishMcpStatus("s1", { sessions: 1, servers: 1, tools: 3, state: "ready", error: null, rows: [row("memory", "ready", 3)], issues: [] });
    publishMcpStatus("s1", null);

    expect(mcpCatalogStatus()).toBeNull();
  });
});

describe("W-C1b the plugins endpoint carries the MCP row", () => {
  it("attaches `mcp` to the MCP row ONLY, and only when there is something to say", () => {
    const status = mcpCatalogStatus();
    expect(status).toBeNull();
    const silent = pluginCatalog(["studio/bus"], null);
    expect(silent.every((row) => row.mcp === undefined)).toBe(true);

    publishMcpStatus("s1", { sessions: 1, servers: 1, tools: 2, state: "ready", error: null, rows: [row("memory", "ready", 2)], issues: [] });
    const rows = pluginCatalog(["studio/bus"], mcpCatalogStatus());

    expect(rows.find((row) => row.name === ENGINE_MCP_PLUGIN)?.mcp?.tools).toBe(2);
    expect(rows.filter((row) => row.name !== ENGINE_MCP_PLUGIN).every((row) => row.mcp === undefined)).toBe(true);
  });

  it("reaches the wire: GET /api/plugins carries it, and a host with no MCP does not", async () => {
    const h = makeHarness({ session: { name: "s1", log: "" } });
    harnesses.push(h);

    const before = await getJson(h.app, "/api/plugins");
    expect(before.status).toBe(200);
    const beforeRows = before.body["plugins"] as Array<Record<string, unknown>>;
    expect(beforeRows.find((row) => row["name"] === ENGINE_MCP_PLUGIN)).toBeDefined();
    expect(beforeRows.every((row) => row["mcp"] === undefined)).toBe(true);

    publishMcpStatus("s1", { sessions: 1, servers: 1, tools: 2, state: "backoff", error: null, rows: [row("memory", "backoff", 2)], issues: [] });
    const after = await getJson(h.app, "/api/plugins");
    const afterRows = after.body["plugins"] as Array<Record<string, unknown>>;
    const mcpRow = afterRows.find((row) => row["name"] === ENGINE_MCP_PLUGIN);

    expect(mcpRow?.["mcp"]).toMatchObject({ servers: 1, tools: 2, state: "backoff" });
    expect(afterRows.filter((row) => row["name"] !== ENGINE_MCP_PLUGIN).every((row) => row["mcp"] === undefined)).toBe(true);
  });
});
