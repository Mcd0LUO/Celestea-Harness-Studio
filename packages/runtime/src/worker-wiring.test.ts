/**
 * W787 (E §2.2.3 P1 ②/B3): the host DRAIN is where a worker receipt enters the
 * engine, and where its idempotency key is decided.
 *
 * A receipt must be keyed by `receipt:<wid>:<attempt>` — stable across processes,
 * so a receipt replayed after a restart (or delivered by two generations of the
 * same session) is dropped by the inbox's ordinary duplicate rule. Everything
 * else keeps the in-process mailbox sequence, because keying a deliberate relay
 * by `(wid, attempt)` would silently drop the SECOND intentional message.
 */

import { Context, type ToolRegistry } from "@celestea/core";
import { InMemorySessionLog } from "@celestea/session";
import { WorkerRegistry } from "@celestea/workers";
import { describe, expect, it } from "vitest";
import { ensureWorkerWiring } from "./worker-wiring.js";

/** A no-op tool registry (the driver seam this probe never exercises). */
function emptyToolRegistry(): ToolRegistry {
  return {
    register: () => undefined,
    addGuard: () => undefined,
    get: () => undefined,
    schemas: () => [],
    dispatch: (input) => Promise.resolve({ call_id: input.call_id, value: null, render: null, error: null, decision: null }),
  };
}

/** Poll a condition with a hard ceiling (W9225: wait for a fact, not a duration). */
async function waitUntil(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const NOW = 1_700_000_000_000;

function setup(hostSessionId = "ws/s1"): { registry: WorkerRegistry; drain: () => Array<{ id: string; text: string }> } {
  const ctx = Context.root();
  const host = ensureWorkerWiring(ctx, {
    tsvPath: null,
    resultsDir: "results",
    logFactory: () => new InMemorySessionLog(),
    hostSessionId,
    sessionIdPrefix: "worker-",
  });
  if (host === null) throw new Error("wiring disabled");
  return { registry: host.registry, drain: () => host.drain() as unknown as Array<{ id: string; text: string }> };
}

describe("worker receipt drain key (E §2.2.3)", () => {
  it("B3: a receipt is keyed by (wid, attempt) and a second delivery of the same row is dropped", () => {
    const { registry, drain } = setup();
    const sid = registry.sessions.create({ title: "W1·T", workspace: null, model: null, mode: null }).meta.id;
    registry.upsert({ wid: "W1", started_at: "t", status: "RUNNING", extra: `sess=${sid} host=ws/s1 attempt=1` });
    registry.rememberSpawn(sid, { wid: "W1", short: "T", brief: "b", reportTo: "ws/s1", mode: null });

    // The registry knows the key of the row it will deliver for.
    expect(registry.receiptKeyFor(sid)).toBe("receipt:W1:1");
    // A settlement notice carries it through the drain (`kind: receipt`).
    registry.mailbox.send("ws/s1", "WORKER_W1_DONE", sid, { kind: "receipt", source: { kind: "subagent-settled", form: "notice", summary: "s", senderSessionId: sid } });
    const drained = drain();
    expect(drained.map((m) => m.id)).toEqual(["receipt:W1:1"]);

    // The SAME key arrives again (a replayed driver): the key is what lets the
    // inbox — not the mailbox sequence — decide.
    registry.mailbox.send("ws/s1", "WORKER_W1_DONE", sid, { kind: "receipt", source: { kind: "subagent-settled", form: "notice", summary: "s", senderSessionId: sid } });
    expect(drain().map((m) => m.id)).toEqual(["receipt:W1:1"]);
  });

  it("a RELAY from the same worker keeps the mailbox sequence (two relays are two messages)", () => {
    const { registry, drain } = setup();
    const sid = registry.sessions.create({ title: "W2·T", workspace: null, model: null, mode: null }).meta.id;
    registry.upsert({ wid: "W2", started_at: "t", status: "RUNNING", extra: `sess=${sid} host=ws/s1 attempt=1` });
    registry.mailbox.send("ws/s1", "first", sid);
    registry.mailbox.send("ws/s1", "second", sid);
    const ids = drain().map((m) => m.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^mailbox:\d+$/);
    expect(ids[1]).not.toBe(ids[0]);
    expect(ids.every((id) => !id.startsWith("receipt:"))).toBe(true);
  });

  it("attaching the driver seams STARTS the lease heartbeat (W9224 P1-7)", async () => {
    // The production path is `compose.ts` -> `host.attach(drivers)`; attaching is
    // what turns `lease=` from a one-shot stamp into a heartbeat, which is the
    // precondition the staleness rule (recovery.leaseExpired) relies on.
    const ctx = Context.root();
    const host = ensureWorkerWiring(ctx, { tsvPath: null, resultsDir: "results", logFactory: () => new InMemorySessionLog(), hostSessionId: "ws/s1", sessionIdPrefix: "worker-" });
    if (host === null) throw new Error("wiring disabled");
    const sid = host.registry.sessions.create({ title: "W9·T", workspace: null, model: null, mode: null }).meta.id;
    const staleAt = Math.floor(Date.now() / 1000) - 3_600;
    const row = (): string => `sess=${sid} host=ws/s1 driven=yes attempt=1 lease=4242@${staleAt}`;
    host.registry.upsert({ wid: "W9", started_at: "t", status: "RUNNING", extra: row() });
    // Nothing renews yet: nobody is driving this row.
    expect(host.registry.heartbeat()).toEqual([]);

    const started = host.attach({
      llm: { generate: () => Promise.reject(new Error("no llm in this probe")) },
      tools: emptyToolRegistry(),
      agentLoop: { runTurn: async () => undefined },
    });
    expect(started).toBe(true);
    host.registry.driveIfPossible(sid, "brief", false);
    // Wait for the DRIVER TASK (not a duration): the registry must know it drives
    // this session before its heartbeat can renew the row.
    await waitUntil(() => host.registry.isDriving(sid));
    // The driver's own state change also stamped the lease; age the row BACK so
    // the only thing that can renew it is the heartbeat.
    host.registry.upsert({ wid: "W9", started_at: "t", status: "RUNNING", extra: row() });
    // `heartbeat()` is what the TIMER calls, so polling it with a real timer is
    // exactly the production renewal. It must have replaced the aged stamp.
    await waitUntil(() => host.registry.heartbeat().length > 0);
    expect(host.registry.getEntry("W9")!.extra).not.toContain(`lease=4242@${staleAt}`);
    expect(host.registry.getEntry("W9")!.extra).toMatch(new RegExp(`lease=${process.pid}@\\d+`));
    host.registry.shutdown();
    await host.registry.joinDrivers();
  });

  it("stamps the dispatching host session on the rows it writes (`host=`)", () => {
    const { registry } = setup("ws/host");
    expect(registry.hostSessionId).toBe("ws/host");
    const sid = registry.sessions.create({ title: "W3·T", workspace: null, model: null, mode: null }).meta.id;
    registry.upsert({ wid: "W3", started_at: "t", status: "RUNNING", extra: `sess=${sid} host=ws/host attempt=1 lease=${registry.lease()}` });
    expect(registry.getEntry("W3")!.extra).toContain("host=ws/host");
    // The lease names THIS process and a whole number of seconds.
    expect(registry.lease()).toMatch(new RegExp(`^${process.pid}@\\d+$`));
    void NOW;
  });
});
