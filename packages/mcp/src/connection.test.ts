/**
 * Connection lifecycle with a FAKE transport: no process, no socket
 * (docs/feature/mcp-client.md §6.2).
 *
 * Pinned here: the reconnect budget, the stability-window refresh, the "HTTP is not
 * supervised" rule, "a failed refresh keeps the previous generation", and "after
 * dispose nothing reconnects".
 */

import { describe, expect, it } from "vitest";

import { createServerConnection } from "./connection.js";
import { backoffDelayMs, isSupervisable } from "./reconnect.js";
import { fakeTransportFactory, manualScheduler } from "./test-util.js";
import type { McpReconnectPolicy, McpServerConfig } from "./types.js";

function server(extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: "memory",
    transport: "stdio",
    enabled: true,
    approval: "ask",
    toolApproval: {},
    timeoutMs: 60_000,
    toolAllow: [],
    toolDeny: [],
    pathAccess: "write",
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 3 },
    command: "npx",
    args: [],
    env: {},
    headers: {},
    scope: "global",
    source: "mcp.json",
    raw: {},
    ...extra,
  };
}

const TOOLS = [{ name: "remember", inputSchema: { type: "object", properties: {} } }];
/** Let the fake timer callbacks settle before asserting on the resulting state. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("backoffDelayMs / isSupervisable", () => {
  it("doubles per attempt and stops at maxDelay", () => {
    const policy: McpReconnectPolicy = { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 };
    expect([1, 2, 3, 4, 10].map((n) => backoffDelayMs(policy, n))).toEqual([500, 1_000, 2_000, 4_000, 30_000]);
  });

  it("supervises stdio only, and only while the policy is enabled", () => {
    expect(isSupervisable(server())).toBe(true);
    expect(isSupervisable(server({ transport: "http" }))).toBe(false);
    const off: McpReconnectPolicy = { enabled: false, initialDelayMs: 1, maxDelayMs: 1, maxAttempts: 1 };
    expect(isSupervisable(server({ reconnect: off }))).toBe(false);
  });
});

describe("createServerConnection · connect and discover", () => {
  it("connects, discovers, and reports the tools it found", async () => {
    const fake = fakeTransportFactory({ tools: TOOLS });
    const connection = createServerConnection(server(), { transportFactory: fake.factory });
    expect(await connection.connect()).toBe(true);
    expect(await connection.refresh()).toBe(true);
    expect(connection.tools()).toHaveLength(1);
    expect(connection.status()).toMatchObject({ server: "memory", state: "ready", toolCount: 1 });
    await connection.dispose();
  });

  it("keeps the previous generation when a later refresh fails", async () => {
    const fake = fakeTransportFactory({ tools: TOOLS });
    const connection = createServerConnection(server(), { transportFactory: fake.factory });
    await connection.connect();
    await connection.refresh();
    const broken = createServerConnection(server(), {
      transportFactory: fakeTransportFactory({ listError: new Error("server busy") }).factory,
    });
    expect(await broken.refresh()).toBe(false);
    expect(broken.tools()).toEqual([]);
    // A7: a failed discovery must not blank the model face — the previous
    // generation stays exactly as it was.
    expect(connection.tools()).toEqual(TOOLS);
    await connection.dispose();
    await broken.dispose();
  });
});

describe("createServerConnection · reconnect supervisor", () => {
  it("retries a failing stdio connection with growing backoff, then gives up", async () => {
    const fake = fakeTransportFactory({ failConnectTimes: 99 });
    const timers = manualScheduler();
    const connection = createServerConnection(server(), { transportFactory: fake.factory, scheduler: timers.scheduler });
    expect(await connection.connect()).toBe(false);
    expect(connection.status().state).toBe("backoff");
    expect(timers.delays).toEqual([500]);
    timers.runNext();
    await flush();
    expect(connection.status().state).toBe("backoff");
    expect(timers.delays).toEqual([500, 1_000]);
    timers.runNext();
    await flush();
    // maxAttempts (3) is now spent: the streak is over and nothing is armed.
    expect(connection.status().state).toBe("failed");
    expect(timers.pending()).toBe(0);
    await connection.dispose();
  });

  it("does NOT supervise http: one failure is reported, not retried", async () => {
    const fake = fakeTransportFactory({ failConnectTimes: 99 });
    const timers = manualScheduler();
    const connection = createServerConnection(server({ transport: "http", url: "https://x/mcp" }), {
      transportFactory: fake.factory,
      scheduler: timers.scheduler,
    });
    expect(await connection.connect()).toBe(false);
    expect(connection.status().state).toBe("failed");
    expect(timers.delays).toEqual([]);
    await connection.dispose();
  });

  it("refreshes the budget only after the connection survived the stability window", async () => {
    let clock = 0;
    const policy: McpReconnectPolicy = { enabled: true, initialDelayMs: 10, maxDelayMs: 1_000, maxAttempts: 1 };
    const fake = fakeTransportFactory();
    const timers = manualScheduler();
    const connection = createServerConnection(server({ reconnect: policy }), {
      transportFactory: fake.factory,
      scheduler: timers.scheduler,
      now: () => clock,
    });
    // Streak A: one failed attempt spends the whole budget => nothing armed.
    fake.setFailNext("memory");
    expect(await connection.connect()).toBe(false);
    expect(connection.status().state).toBe("failed");
    expect(timers.pending()).toBe(0);

    // The server comes back and STAYS up past the stability window (maxDelayMs).
    expect(await connection.reconnectOnce()).toBe(true);
    clock = 5_000;

    // Streak B: the transport dies again. Because the last connection survived
    // the stability window the budget is REFRESHED and a retry is armed; without
    // that rule the server would stay dead for the rest of the generation.
    connection.markLost();
    expect(connection.status().state).toBe("backoff");
    expect(timers.pending()).toBe(1);
    await connection.dispose();
  });
});

describe("createServerConnection · teardown", () => {
  it("stops reconnecting after dispose", async () => {
    const fake = fakeTransportFactory({ failConnectTimes: 99 });
    const timers = manualScheduler();
    const connection = createServerConnection(server(), { transportFactory: fake.factory, scheduler: timers.scheduler });
    await connection.connect();
    expect(timers.pending()).toBe(1);
    await connection.dispose();
    expect(connection.status().state).toBe("disposed");
    // Both a pending retry and a fresh connect() stay dead after disposal.
    expect(await connection.connect()).toBe(false);
    expect(await connection.reconnectOnce()).toBe(false);
    timers.runNext();
    await flush();
    expect(connection.status().state).toBe("disposed");
    expect(fake.log.connects).toHaveLength(1);
  });

  it("closes once, stops on the close deadline, and stays idempotent", async () => {
    const fake = fakeTransportFactory({ hangOnClose: true });
    const connection = createServerConnection(server(), { transportFactory: fake.factory, closeTimeoutMs: 20 });
    await connection.connect();
    const started = Date.now();
    await connection.dispose();
    // Fail-closed: disposal returns after the deadline instead of hanging, and it
    // says so on the status row rather than throwing at the disposal chain.
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(connection.status().failureKind).toBe("timeout");
    expect(fake.log.closes).toEqual(["memory"]);
    await connection.dispose();
    expect(fake.log.closes).toEqual(["memory"]);
  });
});
