/**
 * W9224 — the runtime/workers P1 batch, in ONE file per package so the probes
 * that need a REAL second process (P1-5) sit next to the ones that do not.
 *
 * Findings covered here (audit: results/W9207-runtime与workers.md §3):
 *   P1-5  the shared table's read-modify-write loses updates across processes;
 *   P1-6  the boot converger claims rows of OTHER host conversations;
 *   P1-7  the staleness judgement trusts a bare pid, so a RECYCLED pid (or a
 *         lease that stopped renewing) reads as "alive" forever.
 *
 * Every case is written so reverting its fix makes it fail; the mutation
 * commands are recorded in results/W9224-修复.md §3.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordingSessionLog } from "./log.js";
import { WorkerRegistry } from "./registry.js";
import { acquireTableLock, getExtra, tableLockPath } from "./registry-tsv.js";
import { scriptedDrivers, scriptedLoop, waitUntil } from "./fakes.test-util.js";
import type { WorkerEntry } from "@celestea/core";
import { WORKER_LEASE_TTL_MS, observeWorkerTable } from "./recovery.js";
import { DRIVER_HEARTBEAT_MS } from "./registry.js";

const FIXED_NOW = Date.parse("2026-09-10T12:00:00Z");
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "w9224-workers-"));
  roots.push(dir);
  return dir;
}

function registryAt(path: string, pid: number, extra: Record<string, unknown> = {}): WorkerRegistry {
  return new WorkerRegistry({ tsvPath: path, logFactory: recordingSessionLog, now: () => FIXED_NOW, pid, resultsDir: "results", ...extra });
}

/** One row as the table's own parser sees it (a missing table = no rows). */
function rowsOf(path: string): Array<{ wid: string; status: string; extra: string }> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const parts = line.split("\t");
      return { wid: parts[0] ?? "", status: parts[2] ?? "", extra: parts[3] ?? "" };
    });
}

describe("W9224 P1-5: the table lock is cross-process and self-healing", () => {
  it("is exclusive: a second acquire of the SAME path fails while the first is held", () => {
    const path = join(tmpDir(), "registry.tsv");
    const first = acquireTableLock(path, { attempts: 1 });
    expect(first).not.toBeNull();
    // The lock is the file's EXISTENCE: an O_EXCL create by anyone else fails.
    expect(acquireTableLock(path, { attempts: 1 })).toBeNull();
    first?.release();
    // Released: the next writer can take it (the write path must not wedge).
    const again = acquireTableLock(path, { attempts: 1 });
    expect(again).not.toBeNull();
    again?.release();
  });

  it("reclaims a lock whose holder CRASHED (older than the stale window)", () => {
    const path = join(tmpDir(), "registry.tsv");
    // A lock file left behind by a process that died mid-write: its stamp is
    // ancient, so a boot must take it over instead of blocking the table forever.
    writeFileSync(tableLockPath(path), "999999@1@deadbeef\n", "utf8");
    // The injected clock is 60 s AHEAD of the freshly written lock, so the age
    // is deterministic on every platform (mtime granularity is not).
    const taken = acquireTableLock(path, { attempts: 2, staleMs: 1_000, sleep: () => undefined, now: () => Date.now() + 60_000 });
    expect(taken).not.toBeNull();
    taken?.release();
  });

  it("does NOT rob a LIVE holder: a fresh lock is respected, then fails closed", () => {
    const path = join(tmpDir(), "registry.tsv");
    const holder = acquireTableLock(path, { attempts: 1 });
    // The stale window is huge relative to a real hold, so this must NOT be
    // taken over — the contended writer gives up (null) instead of clobbering.
    expect(acquireTableLock(path, { attempts: 3, staleMs: 60_000, sleep: () => undefined })).toBeNull();
    holder?.release();
  });

  it("a contended write FAILS CLOSED (reported, never a silent lost update)", () => {
    const path = join(tmpDir(), "registry.tsv");
    const holder = acquireTableLock(path, { attempts: 1 });
    const reg = registryAt(path, 4242, { lock: { attempts: 1 } });
    // The registry cannot take the lock, so its persist must be refused and
    // RECORDED — the alternative (write anyway) is exactly the lost update.
    expect(reg.upsert({ wid: "W1", started_at: "t", status: "RUNNING", extra: "sess=s1" })).toContain("could not lock");
    expect(reg.persistFailures()).toHaveLength(1);
    expect(rowsOf(path)).toEqual([]);
    holder?.release();
    // Once the lock is free the same write goes through.
    expect(reg.upsert({ wid: "W1", started_at: "t", status: "RUNNING", extra: "sess=s1" })).toBeNull();
    expect(rowsOf(path).map((r) => r.wid)).toEqual(["W1"]);
  });

  it("the lock file is a SIBLING of the table (same volume, no /tmp dependency)", () => {
    const path = join(tmpDir(), "nested", "registry.tsv");
    expect(tableLockPath(path)).toBe(path + ".lock");
  });
});

describe("W9224 P1-6: a hostless registry cannot claim another conversation's row", () => {
  /** A row that NAMES a host conversation, owned by a process that is gone. */
  const FOREIGN = "W1\t2026-09-23_11:00:00Z\tRUNNING\tsess=other-session-0 title=x host=celestea_studio-ts/OTHER attempt=0 lease=9999@1789000000 proc=9999\n";

  it("refuses to claim a row that names a host when it declares none", () => {
    const path = join(tmpDir(), "registry.tsv");
    writeFileSync(path, FOREIGN, "utf8");
    // No hostSessionId and no scope: this is the shape that used to claim EVERY
    // row (mayInherit is vacuously true), i.e. the cross-conversation overreach.
    const hostless = registryAt(path, 2222);
    const before = readFileSync(path, "utf8");
    expect(hostless.claim("W1", () => false)).toBeNull();
    expect(hostless.getEntry("W1")?.extra).not.toContain("claimed=");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("still claims it when the caller DECLARES the scope (the boot converger)", () => {
    const path = join(tmpDir(), "registry.tsv");
    writeFileSync(path, FOREIGN, "utf8");
    const scoped = registryAt(path, 2222, { mayAdoptHost: (host: string) => host === "celestea_studio-ts/OTHER" });
    const taken = scoped.claim("W1", () => false);
    expect(taken?.status).toBe("RUNNING");
    expect(taken?.extra).toContain("claimed=2222@");
  });

  it("a row with NO host token stays claimable by proc (the legacy rule is intact)", () => {
    const path = join(tmpDir(), "registry.tsv");
    writeFileSync(path, "W1\t2026-09-23_11:00:00Z\tRUNNING\tsess=legacy-0 attempt=0 lease=9999@1789000000 proc=9999\n", "utf8");
    const hostless = registryAt(path, 2222);
    expect(hostless.claim("W1", () => false)?.status).toBe("RUNNING");
  });
});

describe("W9224 P1-7: staleness is not decided by a bare pid", () => {
  /**
   * A DRIVEN row (the only kind that promises a heartbeat) whose lease names a
   * pid that IS alive but whose stamp is ancient — the recycled-pid shape.
   */
  function expiredRow(pid: number, at: number): string {
    return (
      "W1\t2026-09-23_11:00:00Z\tRUNNING\tsess=s1 title=x host=ws/s1 driven=yes attempt=0 lease=" +
      pid +
      "@" +
      at +
      " proc=" +
      pid +
      "\n"
    );
  }

  /** One RUNNING row with the tokens varied (driven= gates the TTL). */
  function entry(tokens: string, leaseAt: number): WorkerEntry {
    return { wid: "W1", started_at: "2026-09-23_11:00:00Z", status: "RUNNING", extra: "sess=s1 host=ws/s1 " + tokens + " lease=4242@" + leaseAt + " proc=4242" };
  }

  it("calls a row STALE when its lease stopped renewing, even though the pid exists", () => {
    const nowSecs = Math.floor(FIXED_NOW / 1000);
    const expired = nowSecs - Math.floor(WORKER_LEASE_TTL_MS / 1000) - 60;
    const report = observeWorkerTable(
      [{ wid: "W1", started_at: "2026-09-23_11:00:00Z", status: "RUNNING", extra: "sess=s1 host=ws/s1 driven=yes attempt=0 lease=4242@" + expired + " proc=4242" }],
      // The pid IS alive (the recycled-pid / heartbeat-stopped shape) — the pid
      // answer alone must not be enough to call this row healthy.
      { pidAlive: () => true, now: FIXED_NOW },
    );
    expect(report.live).toEqual([]);
    expect(report.stale.map((c) => [c.wid, c.reason])).toEqual([["W1", "stale_lease_expired"]]);
  });

  it("keeps a row whose lease was RENEWED recently live", () => {
    const nowSecs = Math.floor(FIXED_NOW / 1000);
    const report = observeWorkerTable(
      [entry("driven=yes attempt=0", nowSecs - 5)],
      { pidAlive: () => true, now: FIXED_NOW },
    );
    expect(report.stale).toEqual([]);
    expect(report.live).toEqual(["W1"]);
  });

  it("a dead pid is STALE regardless of the lease age (the original rule)", () => {
    const nowSecs = Math.floor(FIXED_NOW / 1000);
    const report = observeWorkerTable(
      [entry("driven=yes attempt=0", nowSecs - 5)],
      { pidAlive: () => false, now: FIXED_NOW },
    );
    expect(report.stale.map((c) => c.reason)).toEqual(["stale_lease"]);
  });

  it("a row that was NEVER driven is not judged by the heartbeat it never promised", () => {
    // `driven=no` has no renewal path at all, so its one-shot stamp says nothing
    // about life. Treating it as expired would FALSELY converge a live host's
    // row — a worse failure than the one this fix removes.
    const nowSecs = Math.floor(FIXED_NOW / 1000);
    const report = observeWorkerTable(
      [entry("driven=no attempt=0", nowSecs - 86_400 * 30)],
      { pidAlive: () => true, now: FIXED_NOW },
    );
    expect(report.stale).toEqual([]);
    expect(report.live).toEqual(["W1"]);
  });

  it("a legacy row with NO lease keeps the proc fallback and is NOT expired", () => {
    // workerOwner() synthesises { pid, at: 0 } for a lease-less row; treating
    // at=0 as "expired" would declare every pre-W787 row stale on the spot.
    const report = observeWorkerTable(
      [{ wid: "W1", started_at: "2026-09-23_11:00:00Z", status: "RUNNING", extra: "sess=s1 host=ws/s1 driven=yes proc=4242" }],
      { pidAlive: () => true, now: FIXED_NOW },
    );
    expect(report.stale).toEqual([]);
    expect(report.live).toEqual(["W1"]);
  });

  it("the TTL is a real multiple of the renewal cadence (never a one-tick race)", () => {
    // Both numbers are exported so this relationship is checkable, not a prose
    // claim: a TTL at or below the cadence would flag a healthy worker.
    expect(WORKER_LEASE_TTL_MS).toBeGreaterThanOrEqual(DRIVER_HEARTBEAT_MS * 5);
  });

  it("heartbeat RENEWS the lease of a DRIVEN row (the promise the TTL relies on)", async () => {
    const path = join(tmpDir(), "registry.tsv");
    const reg = registryAt(path, 4242);
    // A driven worker whose stamp is already past the TTL: without a renewal it
    // would be judged stale while its driver is genuinely alive.
    const staleAt = Math.floor(FIXED_NOW / 1000) - Math.floor(WORKER_LEASE_TTL_MS / 1000) - 60;
    const session = reg.sessions.create({ title: "W1·t" });
    reg.upsert({
      wid: "W1",
      started_at: "t",
      status: "RUNNING",
      extra: `sess=${session.meta.id} driven=yes attempt=0 lease=4242@${staleAt}`,
    });
    // No driver task yet: a row nobody is driving must NOT be renewed.
    expect(reg.heartbeat()).toEqual([]);

    reg.attachDrivers(scriptedDrivers(scriptedLoop()));
    reg.driveIfPossible(session.meta.id, "brief", false);
    await waitUntil(() => reg.isDriving(session.meta.id));
    // The driver's own state change already renewed the stamp, so age the row
    // BACK to the stale value: this isolates the HEARTBEAT from setWorkerState,
    // which is the whole point (a parked worker makes no state changes).
    reg.upsert({
      wid: "W1",
      started_at: "t",
      status: "RUNNING",
      extra: `sess=${session.meta.id} driven=yes attempt=0 lease=4242@${staleAt}`,
    });
    expect(reg.heartbeat()).toEqual(["W1"]);
    expect(getExtra(reg.getEntry("W1")!, "lease")).toBe(`4242@${Math.floor(FIXED_NOW / 1000)}`);
    reg.shutdown();
    await reg.joinDrivers();
  });

  it("the heartbeat is a real TIMER: it renews on its own and stops on shutdown", async () => {
    vi.useFakeTimers();
    try {
      // A CLOCK WE MOVE, so a renewal is distinguishable from the driver's own
      // state change (which also stamps `lease`). Without this the two paths
      // write the same value and the probe cannot tell the timer apart.
      let clockMs = FIXED_NOW;
      const path = join(tmpDir(), "registry.tsv");
      const reg = new WorkerRegistry({ tsvPath: path, logFactory: recordingSessionLog, now: () => clockMs, pid: 4242, resultsDir: "results" });
      const session = reg.sessions.create({ title: "W1·t" });
      const oldAt = Math.floor(FIXED_NOW / 1000) - 3_600;
      reg.upsert({ wid: "W1", started_at: "t", status: "RUNNING", extra: `sess=${session.meta.id} driven=yes attempt=0 lease=4242@${oldAt}` });
      reg.attachDrivers(scriptedDrivers(scriptedLoop()));
      reg.driveIfPossible(session.meta.id, "brief", false);
      // Wait until the driver has PARKED (state=idle): after that it makes no
      // more state changes, so anything that renews the stamp is the timer.
      await vi.waitFor(() => expect(getExtra(reg.getEntry("W1")!, "state")).toBe("idle"));

      // Age the row back and move the clock forward one full heartbeat period.
      reg.upsert({ wid: "W1", started_at: "t", status: "RUNNING", extra: `sess=${session.meta.id} driven=yes attempt=0 lease=4242@${oldAt}` });
      clockMs += DRIVER_HEARTBEAT_MS;
      await vi.advanceTimersByTimeAsync(DRIVER_HEARTBEAT_MS);
      // The TIMER renewed it: no manual heartbeat() call anywhere in this block.
      expect(getExtra(reg.getEntry("W1")!, "lease")).toBe(`4242@${Math.floor(clockMs / 1000)}`);

      // shutdown() stops it: the timer must not outlive the registry.
      reg.shutdown();
      await reg.joinDrivers();
      reg.upsert({ wid: "W1", started_at: "t", status: "RUNNING", extra: `sess=${session.meta.id} driven=yes attempt=0 lease=4242@${oldAt}` });
      clockMs += DRIVER_HEARTBEAT_MS * 3;
      await vi.advanceTimersByTimeAsync(DRIVER_HEARTBEAT_MS * 3);
      expect(getExtra(reg.getEntry("W1")!, "lease")).toBe(`4242@${oldAt}`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("claim re-checks the lease itself, so a stale-lease row is takeable", () => {
    const path = join(tmpDir(), "registry.tsv");
    const nowSecs = Math.floor(FIXED_NOW / 1000);
    const expired = nowSecs - Math.floor(WORKER_LEASE_TTL_MS / 1000) - 60;
    writeFileSync(path, expiredRow(4242, expired), "utf8");
    // The row names host=ws/s1, so this registry declares that conversation —
    // otherwise P1-6's (independent) guard would refuse the claim first and this
    // probe would not be testing P1-7 at all.
    const reg = registryAt(path, 2222, { hostSessionId: "ws/s1" });
    // The pid is "alive" per the caller, but the lease says the owner stopped:
    // the same evidence the observer used must license the takeover here.
    expect(reg.claim("W1", () => true)?.status).toBe("RUNNING");
  });
});
