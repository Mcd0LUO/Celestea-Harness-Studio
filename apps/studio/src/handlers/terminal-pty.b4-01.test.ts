/**
 * B4-01 P0 — the pty table is now reachable and actually emptied.
 *
 * The defect this pins: `idleSince` + `TERMINAL_IDLE_MS` shipped as the
 * anti-leak backstop with ZERO callers, and the studio's `stop()` could not
 * reach the table at all (it was a bare closure local inside
 * `registerTerminal`). A pty is spawned `detached`, so it leads its own process
 * group and NOTHING in the parent's exit takes it down: a browser that
 * vanished left `python3` running until the machine rebooted.
 *
 * Both halves are pinned against REAL detached child processes, not mocks: the
 * shutdown step has to make the OS actually forget the pid, because a fake
 * child would pass even with the wiring absent.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxChild, SandboxExit } from "@celestea/core";
import {
  createTerminalTable,
  registerTerminalTable,
  releaseTerminalTable,
  startTerminalReaper,
  stopAllTerminalReapers,
  TERMINAL_IDLE_MS,
  terminalIdleMs,
  terminalTableOf,
  type TerminalTable,
} from "./terminal-pty.js";

/** A REAL long-lived child, spawned the way the pty is: detached (own group). */
function detachedChild(): ChildProcess {
  return spawn(process.execPath, ["-e", "setTimeout(()=>{}, 600000)"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

/** Is the OS still running this pid? The only honest orphan test. */
function pidAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const spawned: ChildProcess[] = [];
function track(child: ChildProcess): ChildProcess {
  spawned.push(child);
  return child;
}

/** Every table this file builds, so teardown can stop its REAPER. */
const tables: TerminalTable[] = [];

/**
 * Build a table and register it for teardown.
 *
 * B4-01 flake, root cause: a table built with the DEFAULT idleMs arms a real
 * 60 s interval, and three cases here never stopped it. That timer outlived
 * the file, stayed armed, and swept ptys belonging to OTHER tests in OTHER
 * files -- which is why the failure looked random and moved between assertions.
 * Measured before this fix: 2 live Timeout handles survived this file (probe
 * via process.getActiveResourcesInfo()), and stopAllTerminalReapers() did NOT
 * clear them, because those reapers belonged to tables teardown never touched.
 *
 * This is test hygiene, not a production change: the leak was never in
 * createTerminalTable -- it was in a test that forgot to stop what it started.
 */
function newTable(options: Parameters<typeof createTerminalTable>[0] = {}): TerminalTable {
  const table = createTerminalTable(options);
  tables.push(table);
  return table;
}

afterEach(() => {
  // Reapers FIRST: a timer that outlives its test would terminate a pty another
  // test is still using. Then the children, through their handles.
  for (const table of tables.splice(0)) table.reaper.stop();
  for (const c of spawned.splice(0)) {
    // Kill THROUGH the child handle, not by raw pid. A raw pid kill can land on a
    // RECYCLED pid: once a child is reaped the OS is free to hand that number to
    // a later spawn, and a stray SIGKILL would take out an unrelated process (in
    // this suite, possibly a sibling test's child -- the cross-test flake this
    // hook must never cause). ChildProcess.kill() targets the handle we spawned,
    // and is a no-op once that child is gone.
    try {
      c.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

/**
 * The real child behind the seam the sandbox provides. `terminateTree` signals the
 * whole group through this handle, so the pid itself is what is under test.
 */
function wrap(child: ChildProcess): SandboxChild {
  let settled: SandboxExit | null = null;
  let resolveWait: ((e: SandboxExit) => void) | null = null;
  const wait = new Promise<SandboxExit>((resolve) => {
    resolveWait = resolve;
  });
  child.once("close", (code, signal) => {
    if (settled !== null) return;
    settled = { code, signal };
    resolveWait?.({ code, signal });
  });
  return {
    pid: child.pid ?? null,
    stdin: null,
    stdout: null,
    stderr: null,
    wait: () => wait,
    // W9321: `terminate`/`kill` are `Promise<void>` on the seam now. This double
    // wraps a REAL ChildProcess, whose `kill` is a synchronous syscall, so the
    // promise is already settled — the shape changed, the timing did not.
    terminate: () => {
      child.kill("SIGTERM");
      return Promise.resolve();
    },
    kill: () => {
      child.kill("SIGKILL");
      return Promise.resolve();
    },
  } as SandboxChild;
}

/** Register one real detached child in a table; returns its pid. */
function addLive(table: TerminalTable): number | undefined {
  const child = track(detachedChild());
  const entry = table.registry.add(wrap(child), null, 80, 24);
  if (entry === null) throw new Error("table refused the entry (ceiling?)");
  return child.pid;
}

/**
 * Wait for the OS to actually forget a pid, with a BOUND.
 *
 * Why polling and not a sleep: a kill is delivered immediately, but the OS
 * reaping the process is ASYNCHRONOUS. A fixed sleep is a guess about
 * someone else's scheduler -- under a loaded machine (this file runs alongside
 * the rest of the suite) the reaping can outlast it, and the test then fails
 * for having been impatient rather than for having caught a real orphan. That
 * is the difference between a gate and a coin flip, so this polls a MONOTONIC
 * clock until the process is gone, and only then returns.
 *
 * The bound is deliberately generous (5 s against a normal reclaim well under
 * 50 ms): a slow machine should make this wait, not fail. The elapsed time is
 * returned so a FAILURE can say how long it actually waited, which is what
 * separates "we never killed it" from "we killed it and the OS was busy".
 */
const REAP_BOUND_MS = 5_000;
const REAP_POLL_MS = 20;

async function waitForExit(pid: number | undefined, boundMs: number = REAP_BOUND_MS): Promise<number> {
  const started = performance.now();
  while (pidAlive(pid)) {
    if (performance.now() - started > boundMs) return performance.now() - started;
    await new Promise((r) => setTimeout(r, REAP_POLL_MS));
  }
  return performance.now() - started;
}

/**
 * Assert the OS forgot this pid, having waited for it (bounded).
 *
 * The assertion still checks the REAL pid -- that is the entire value of this
 * file. Only the WAIT became bounded; a weaker check (not throwing, or
 * dropping the pid) would pass with the fix removed.
 */
/**
 * Assert the OS is STILL running this pid (the "we must not kill it" side).
 *
 * Bounded the same way as [expectDead]: a child that is still being SET UP can
 * briefly look absent, and that is a slow spawn, not a kill. Waiting makes the
 * negative case as trustworthy as the positive one.
 */
async function expectAlive(pid: number | undefined, what: string): Promise<void> {
  const started = performance.now();
  while (!pidAlive(pid)) {
    if (performance.now() - started > REAP_BOUND_MS) {
      expect(pidAlive(pid), `${what}: pid ${String(pid)} never came up within ${REAP_BOUND_MS}ms`).toBe(true);
      return;
    }
    await new Promise((r) => setTimeout(r, REAP_POLL_MS));
  }
  expect(pidAlive(pid), `${what}: pid ${String(pid)} should still be running`).toBe(true);
}

async function expectDead(pid: number | undefined, what: string): Promise<void> {
  const waited = await waitForExit(pid);
  expect(
    pidAlive(pid),
    `${what}: pid ${String(pid)} was still alive after waiting ${waited.toFixed(0)}ms (bound ${REAP_BOUND_MS}ms)`,
  ).toBe(false);
}

describe(`B4-01 P0 · shutdown drains the pty table and kills the process groups`, () => {
  it(`shutdown() empties the table AND the OS forgets every pty pid`, async () => {
    const table = newTable({ idleMs: 0 }); // no reaper: this is the shutdown half
    const pids = [addLive(table), addLive(table)];
    expect(table.registry.size()).toBe(2);
    for (const pid of pids) await expectAlive(pid, "a freshly spawned pty is running");

    const killed = await table.shutdown();

    // The table is drained ...
    expect(killed).toBe(2);
    expect(table.registry.size()).toBe(0);
    // ...and this is the half the fix exists for: the processes are REALLY gone.
    for (const pid of pids) await expectDead(pid, "shutdown()");
  });

  it(`shutdown() is idempotent (the W2029 repeat-SIGTERM path is a no-op)`, async () => {
    const table = newTable({ idleMs: 0 });
    addLive(table);
    expect(await table.shutdown()).toBe(1);
    expect(await table.shutdown()).toBe(0);
    expect(table.registry.size()).toBe(0);
  });

  it(`the published table is reachable by owner key; release drains exactly it`, async () => {
    const owner = `b4-01-app`;
    const table = newTable({ idleMs: 0 });
    const pid = addLive(table);
    registerTerminalTable(owner, table);

    expect(terminalTableOf(owner)).toBe(table);
    expect(await releaseTerminalTable(owner)).toBe(1);
    expect(terminalTableOf(owner)).toBeUndefined();
    await expectDead(pid, "releaseTerminalTable()");
    // A second release is safe: the teardown path may run twice.
    expect(await releaseTerminalTable(owner)).toBe(0);
  });

  it(`a wedged child cannot hold the teardown open: the table still empties`, async () => {
    const table = newTable({ idleMs: 0 });
    const pid = addLive(table);
    // A child that never settles would hang a naive await on wait().
    const entry = table.registry.all()[0]!;
    entry.child.wait = () => new Promise<SandboxExit>(() => {});

    await table.shutdown();
    expect(table.registry.size()).toBe(0);
    await expectDead(pid, "a wedged child is still killed");
  }, 20_000);
});

describe(`B4-01 P0 · the idle reaper finally has a caller`, () => {
  it(`a pty past the ceiling is reaped; a fresh one is left running`, async () => {
    // W9325: this case used to read `idleMs: 0` as "no idle reaping here", but
    // 0 is also the reaper's CEILING, so `idleSince` became "age > 0" and the
    // "fresh" entry became stale the instant the wall clock ticked past the ms it
    // was stamped with (`touchedAt = Date.now()` at stamp time vs a second
    // `Date.now()` inside sweep). Whether it read 1 or 2 depended on where the two
    // live clock reads landed on the millisecond grid -- a ~1/6 coin flip, not a bug
    // in the reaper. Fix: drive BOTH sides from one injected clock (the pattern the
    // standalone reaper case below already uses). The fresh entry is stamped at
    // exactly `now`, so its age is 0 and can never satisfy the strict `> idleMs`,
    // and the stale one is stamped a full ceiling + 1 past -- both independent of
    // how much real time elapsed between the two `addLive` spawns.
    const now = { t: 1_000_000 };
    const table = newTable({ idleMs: TERMINAL_IDLE_MS, now: () => now.t });
    const reapedPid = addLive(table);
    const keptPid = addLive(table);
    const entries = table.registry.all();
    // entries are in insertion order: mark the FIRST long-idle, leave the second fresh.
    entries[0]!.touchedAt = now.t - TERMINAL_IDLE_MS - 1;
    entries[1]!.touchedAt = now.t;

    const report = table.reaper.sweep();

    expect(report.reaped).toBe(1);
    expect(report.swept).toBe(1);
    expect(table.registry.size()).toBe(1);
    await expectDead(reapedPid, "the idle ceiling killed it"); // bounded poll, not a sleep
    await expectAlive(keptPid, "the reaper left the fresh pty alone");
  });

  it(`a second sweep reaps nothing (the drop happens before the slow signal)`, () => {
    const table = newTable({ idleMs: 0 });
    addLive(table);
    table.registry.all()[0]!.touchedAt = Date.now() - TERMINAL_IDLE_MS - 60_000;
    expect(table.reaper.sweep().reaped).toBe(1);
    expect(table.reaper.sweep().reaped).toBe(0);
    expect(table.registry.size()).toBe(0);
  });

  // B4-01 follow-up: the reaper arms ON DEMAND, not at construction. A sweep over
  // an EMPTY table can never reap anything, so a timer running before the first
  // pty is pure waste -- and waste that outlives the app is exactly what a
  // fake-timer gate fails on. The first pty arms it; the last one leaving stops it.
  it(`arms on the FIRST pty and disarms when the last one leaves`, async () => {
    const table = newTable();
    // Nothing opened yet: no timer, so a table that never hosted a pty arms nothing.
    expect(table.reaper.armed()).toBe(false);

    const first = addLive(table);
    expect(table.reaper.armed()).toBe(true);
    addLive(table);
    expect(table.reaper.armed()).toBe(true);

    // A close drains one row; a sweep past the ceiling drains the last one.
    table.registry.all()[0]!.touchedAt = Date.now() - TERMINAL_IDLE_MS - 60_000;
    expect(table.reaper.sweep().reaped).toBe(1);
    expect(table.reaper.armed()).toBe(true); // one pty still live
    table.registry.drop(table.registry.all()[0]!.id);
    expect(table.reaper.armed()).toBe(false); // the last one left: the timer is gone

    await expectDead(first, "the reaper killed the stale pty");
  });

  it(`stopAllTerminalReapers disarms every armed reaper (a teardown that cannot see the table)`, () => {
    const a = newTable();
    const b = newTable();
    addLive(a);
    addLive(b);
    expect(a.reaper.armed()).toBe(true);
    expect(b.reaper.armed()).toBe(true);
    stopAllTerminalReapers();
    expect(a.reaper.armed()).toBe(false);
    expect(b.reaper.armed()).toBe(false);
  });

  it(`idleMs <= 0 arms no timer, yet shutdown still drains (the two halves are independent)`, async () => {
    const table = newTable({ idleMs: 0 });
    expect(table.reaper.armed()).toBe(false);
    const pid = addLive(table);
    // The teardown path must never depend on the reaper being armed.
    expect(await table.shutdown()).toBe(1);
    await expectDead(pid, "shutdown() drains even with the reaper disarmed");
  });

  it(`the ceiling defaults to the documented value; the env knob retunes and can disable`, () => {
    expect(terminalIdleMs({})).toBe(TERMINAL_IDLE_MS);
    expect(terminalIdleMs({ CELESTEA_TERMINAL_IDLE_MS: "60000" })).toBe(60_000);
    expect(terminalIdleMs({ CELESTEA_TERMINAL_IDLE_MS: "0" })).toBe(0);
    // Unparsable input must NOT silently disable the backstop.
    expect(terminalIdleMs({ CELESTEA_TERMINAL_IDLE_MS: "nonsense" })).toBe(TERMINAL_IDLE_MS);
  });

  it(`a standalone reaper honours an injected clock (no real waiting)`, () => {
    const table = newTable({ idleMs: 0 });
    // addLive stamps touchedAt from the REAL clock, so the injected clock has to
    // start there — starting at an arbitrary small number would put the entry in
    // the future and it could never look idle.
    const now = { t: Date.now() };
    const reaper = startTerminalReaper(table.registry, { idleMs: 5_000, now: () => now.t });
    addLive(table);
    expect(reaper.sweep().reaped).toBe(0); // fresh
    now.t += 6_000;
    expect(reaper.sweep().reaped).toBe(1); // past the ceiling
    reaper.stop();
    expect(reaper.armed()).toBe(false);
  });
});


describe(`B4-01 P0 flake guard · this file leaks no reaper`, () => {
  it(`a default-idle table IS armed, and teardown can always stop it`, () => {
    // The precondition that made the flake possible at all.
    const table = newTable(); // default idleMs => a real 60 s interval
    addLive(table);
    expect(table.reaper.armed()).toBe(true);

    // afterEach routes every table through `tables`, so this is exactly what
    // teardown does for it. The bug was a test that never called this.
    table.reaper.stop();
    expect(table.reaper.armed()).toBe(false);
  });

  it(`an idleMs-0 table never arms, so it cannot leak either`, () => {
    const table = newTable({ idleMs: 0 });
    addLive(table);
    expect(table.reaper.armed()).toBe(false);
  });
});
