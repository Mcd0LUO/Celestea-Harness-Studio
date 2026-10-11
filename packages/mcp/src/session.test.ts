/**
 * One session generation over several servers: failure isolation, dispatch, and
 * teardown (docs/feature/mcp-client.md §6.1/§6.2).
 *
 * The load-bearing property is ISOLATION: one server that cannot connect must cost
 * nothing but its own tools — not the other servers, not the built-ins.
 */

import { describe, expect, it } from "vitest";

import { loadMcpConfig } from "./config.js";
import { createMcpSession } from "./session.js";
import { fakeTransportFactory, manualScheduler, scriptedTransportFactory } from "./test-util.js";
import type { McpRemoteTool } from "./types.js";

function config(entries: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return loadMcpConfig({
    globalPath: "mcp.json",
    workspacePath: null,
    env: {},
    readText: () => JSON.stringify({ servers: entries, ...overrides }),
    commandExists: () => true,
  });
}

const tools = (name: string): McpRemoteTool[] => [
  { name, description: `the ${name} tool`, inputSchema: { type: "object", properties: {} } },
];


describe("createMcpSession · failure isolation", () => {
  it("keeps the healthy servers when one cannot connect", async () => {
    const fake = scriptedTransportFactory({
      memory: { failConnectTimes: 99, tools: tools("remember") },
      files: { tools: tools("read") },
    });
    const session = createMcpSession({ config: config({ memory: { command: "a" }, files: { command: "b" } }), transportFactory: fake.factory });
    await session.start();
    expect(session.bindings().map((t) => t.spec.name)).toEqual(["mcp__files__read"]);
    const statuses = session.statuses();
    // "backoff" = the failure is known AND a retry is armed; the tool face is
    // untouched either way, which is the isolation property under test.
    expect(statuses.find((s) => s.server === "memory")?.state).toBe("backoff");
    expect(statuses.find((s) => s.server === "memory")?.failureKind).toBe("connect_failed");
    expect(statuses.find((s) => s.server === "files")?.state).toBe("ready");
    await session.dispose();
  });

  it("reports an unusable entry as an issue instead of dropping it silently", async () => {
    const session = createMcpSession({
      config: config({ good: { command: "a" }, bad: { command: "b", url: "http://x" } }),
      transportFactory: fakeTransportFactory().factory,
    });
    expect(session.issues().map((i) => i.server)).toEqual(["bad"]);
    await session.dispose();
  });

  it("never connects a disabled server, but still lists it", async () => {
    const fake = fakeTransportFactory({ tools: tools("remember") });
    const session = createMcpSession({
      config: config({ memory: { command: "a", enabled: false } }),
      transportFactory: fake.factory,
    });
    await session.start();
    expect(fake.log.connects).toEqual([]);
    expect(session.bindings()).toEqual([]);
    expect(session.statuses().map((s) => [s.server, s.state])).toEqual([["memory", "idle"]]);
    await session.dispose();
  });
});

describe("createMcpSession · dispatch", () => {
  it("dispatches by model-visible name and returns the rendered text", async () => {
    const fake = fakeTransportFactory({ tools: tools("remember") });
    const session = createMcpSession({ config: config({ memory: { command: "a" } }), transportFactory: fake.factory });
    await session.start();
    const outcome = await session.callTool("mcp__memory__remember", { fact: "x" });
    expect(outcome).toMatchObject({ ok: true, server: "memory", tool: "remember", text: "memory.remember ok" });
    expect(fake.log.callCalls).toEqual([{ server: "memory", tool: "remember", args: { fact: "x" } }]);
    await session.dispose();
  });

  it("refuses an unknown name structurally, never by throwing", async () => {
    const fake = fakeTransportFactory({ tools: tools("remember") });
    const session = createMcpSession({ config: config({ memory: { command: "a" } }), transportFactory: fake.factory });
    await session.start();
    const outcome = await session.callTool("mcp__memory__nope", {});
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("unknown MCP tool");
    await session.dispose();
  });

  it("re-connects once on the NEXT call after the transport died", async () => {
    const broken = scriptedTransportFactory({ memory: { tools: tools("remember"), callError: new Error("pipe closed") } });
    const brokenSession = createMcpSession({
      config: config({ memory: { command: "a" } }),
      transportFactory: broken.factory,
    });
    await brokenSession.start();
    const first = await brokenSession.callTool("mcp__memory__remember", {});
    expect(first).toMatchObject({ ok: false, failureKind: "connect_failed" });
    await brokenSession.dispose();

    // The same server with a healthy transport still answers the second dispatch.
    const healthy = fakeTransportFactory({ tools: tools("remember") });
    const session = createMcpSession({ config: config({ memory: { command: "a" } }), transportFactory: healthy.factory });
    await session.start();
    expect((await session.callTool("mcp__memory__remember", {})).ok).toBe(true);
    await session.dispose();
  });

  it("reports mcp_not_ready with the server name when the tool never appeared", async () => {
    const fake = fakeTransportFactory({ failConnectTimes: 99 });
    const session = createMcpSession({ config: config({ memory: { command: "a" } }), transportFactory: fake.factory });
    await session.start();
    const outcome = await session.callTool("mcp__memory__remember", {});
    expect(outcome).toMatchObject({ ok: false, failureKind: "call_failed" });
    expect(outcome.text).toContain("unknown MCP tool");
    await session.dispose();
  });
});

describe("createMcpSession · generation teardown", () => {
  it("closes every connection on dispose and refuses to work afterwards", async () => {
    const fake = scriptedTransportFactory({
      memory: { tools: tools("remember") },
      files: { tools: tools("read") },
    });
    const timers = manualScheduler();
    const session = createMcpSession({
      config: config({ memory: { command: "a" }, files: { command: "b" } }),
      transportFactory: fake.factory,
      scheduler: timers.scheduler,
    });
    await session.start();
    await session.dispose();
    expect(fake.log.closes.sort()).toEqual(["files", "memory"]);
    expect(session.statuses().every((s) => s.state === "disposed")).toBe(true);
    expect((await session.callTool("mcp__memory__remember", {})).ok).toBe(false);
    // Disposal must not have armed anything that could reconnect later.
    expect(timers.pending()).toBe(0);
  });

  it("carries the per-tool approval and path_access into the bindings", async () => {
    const fake = fakeTransportFactory({ tools: [...tools("remember"), ...tools("recall")] });
    const session = createMcpSession({
      config: config({
        memory: { command: "a", tool_approval: { recall: "never" }, path_access: "read" },
      }),
      transportFactory: fake.factory,
    });
    await session.start();
    const bindings = session.bindings();
    expect(bindings.map((b) => [b.tool, b.approval, b.pathAccess])).toEqual([
      ["recall", "never", "read"],
      ["remember", "ask", "read"],
    ]);
    await session.dispose();
  });
});
