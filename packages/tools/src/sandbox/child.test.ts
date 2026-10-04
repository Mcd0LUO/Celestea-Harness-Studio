/**
 * W885 — the Windows tree-kill BRANCH SELECTION (not the kill itself).
 *
 * `taskkill /PID <pid> /T /F` is the only tree-kill Windows ships, and it is
 * inherently racy (a child may re-parent between the walk and the kill), so this
 * slice treats it as best effort and leaves the real fix (Job Objects) to W885
 * slice 2. What IS testable on a Linux host is the decision: the POSIX path must
 * never shell out, and the Windows branch must decline rather than throw when
 * taskkill cannot run (there is no taskkill here, which is exactly the fallback
 * case `signalTree` relies on).
 *
 * NOT verified on this host: that taskkill actually reaps a real Windows tree.
 *
 * W9321 — plus the NON-BLOCKING contract, which is the one part of this function
 * that IS measurable here, and was the real defect: the loop used to run
 * `execFileSync` + `sleepSync`, so reaching it from an `abort` listener froze the
 * event loop for up to ~15s. The last describe block below is the mechanical
 * proof, with its negative control spelled out.
 */

import { describe, expect, it } from "vitest";

import { taskkillTree } from "./child.js";

describe("W885/W892 taskkillTree", () => {
  it("declines on POSIX — the group signal stays the only POSIX mechanism", async () => {
    expect(await taskkillTree(1, "linux")).toBe(false);
    expect(await taskkillTree(1, "darwin")).toBe(false);
  });

  // W892: there is deliberately NO "taskkill is unavailable ⇒ false" case here.
  // On Linux taskkill is missing (ENOENT) so it returns false, but on Windows it
  // EXISTS and a dead pid is reported true ("the tree is already gone") — so the
  // assertion was platform-dependent. The real distinction is pinned with an
  // injected ENOENT runner in the case below.

  it("does NOT run taskkill at all on POSIX", async () => {
    let runs = 0;
    expect(await taskkillTree(1, "linux", { run: () => void runs++ })).toBe(false);
    expect(runs).toBe(0);
  });

  /**
   * W892: the old body returned true whenever execFileSync did not throw, so a
   * taskkill that ran but did not reap the tree was reported as success and the
   * child.kill() fallback never happened. These cases pin the new verdict.
   */
  it("reports success only after the process is actually gone", async () => {
    let alive = true;
    let runs = 0;
    const ok = await taskkillTree(42, "win32", {
      run: () => {
        runs++;
        if (runs >= 2) alive = false; // second attempt reaps it
      },
      alive: () => alive,
      sleep: () => undefined,
    });
    expect(ok).toBe(true);
    expect(runs).toBe(2);
  });

  it("retries a transient failure (access denied) before giving up", async () => {
    let alive = true;
    const slept: number[] = [];
    let runs = 0;
    const denied = (): never => {
      runs++;
      if (runs >= 3) alive = false;
      const e = new Error("Access is denied.") as NodeJS.ErrnoException;
      e.code = "EPERM";
      throw e;
    };
    const ok = await taskkillTree(42, "win32", {
      run: denied,
      alive: () => alive,
      sleep: (ms) => {
        slept.push(ms);
      },
      delayMs: 10,
    });
    expect(ok).toBe(true);
    expect(runs).toBe(3);
    expect(slept).toEqual([10, 20]);
  });

  it("distinguishes 'taskkill missing' (false → caller falls back) from 'already gone' (true)", async () => {
    const missing = (): never => {
      const e = new Error("spawnSync taskkill ENOENT") as NodeJS.ErrnoException;
      e.code = "ENOENT";
      throw e;
    };
    // Mechanism unavailable: false, so signalTree falls back to child.kill().
    expect(await taskkillTree(42, "win32", { run: missing, alive: () => true, sleep: () => undefined })).toBe(false);
    // Process already gone: true — the tree is reaped even though taskkill erred.
    const gone = (): never => {
      const e = new Error("not found") as NodeJS.ErrnoException;
      e.code = "ESRCH";
      throw e;
    };
    expect(await taskkillTree(42, "win32", { run: gone, alive: () => false, sleep: () => undefined })).toBe(true);
  });

  it("gives up after the attempt budget when the process never dies", async () => {
    let runs = 0;
    const ok = await taskkillTree(42, "win32", { run: () => void runs++, alive: () => true, sleep: () => undefined, attempts: 3 });
    expect(ok).toBe(false);
    expect(runs).toBe(3);
  });
});

/**
 * W9321 — the mechanical proof that the retry loop no longer blocks the event
 * loop, and the negative control that gives it teeth.
 *
 * What is asserted is a FACT about the loop, not a duration guess: a 5ms interval
 * armed before the call must have run at least once BEFORE the call resolves.
 * Both halves of the injection come from the seam the task requires — `run` (a
 * deliberately slow taskkill) and `sleep` (the backoff) — so the loop has a real
 * in-flight window to be measured across.
 *
 * WHY THIS IS RED AGAINST THE SYNCHRONOUS IMPLEMENTATION (the negative control —
 * executed, not assumed: reverting `taskkillTree` to its old `execFileSync` +
 * `sleepSync` body and re-running this file fails BOTH assertions):
 *   * the old loop called `run(pid)` / `sleep(ms)` and DISCARDED whatever they
 *     returned, so this injected slow taskkill was never waited for — the three
 *     attempts completed synchronously;
 *   * `ticks` therefore stayed 0 (the 5ms interval never got a turn) and the
 *     measured elapsed time was ~0ms instead of the ~180ms the injected runner
 *     plus backoff must cost.
 * The test still COMPILES against the old signature, because a `() => Promise<void>`
 * is assignable to a `() => void` seam — which is what makes it a fair control
 * rather than a type-level trick.
 */
describe("W9321 taskkillTree keeps the event loop turning", () => {
  const SLOW_TASKKILL_MS = 40;
  const BACKOFF_MS = 20;
  const ATTEMPTS = 3;

  it("a timer armed before the call fires while a slow taskkill is still in flight", async () => {
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
    }, 5);
    const started = Date.now();
    let verdict: boolean;
    try {
      verdict = await taskkillTree(42, "win32", {
        // The injected "slow taskkill": what the real one costs when it has to
        // walk a tree, and what the synchronous version used to charge to the
        // whole process.
        run: () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, SLOW_TASKKILL_MS);
          }),
        // Never reaped ⇒ every attempt AND every backoff must actually run.
        alive: () => true,
        sleep: (ms) =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, ms);
          }),
        attempts: ATTEMPTS,
        delayMs: BACKOFF_MS,
      });
    } finally {
      clearInterval(interval);
    }
    const elapsed = Date.now() - started;

    // The budget ran out and the tree is still there — the same verdict as before.
    expect(verdict).toBe(false);
    // ① The event loop turned DURING the kill. A blocking implementation cannot
    //    do this: the interval callback has nowhere to run.
    expect(ticks, "the event loop must keep turning while taskkill is in flight").toBeGreaterThan(0);
    // ② The slow taskkill was AWAITED, not fired and forgotten.
    //    Lower bound is `attempts * SLOW_TASKKILL_MS` = 120ms, comfortably below
    //    the real ~180ms and far above the ~0ms a non-waiting loop produces.
    expect(elapsed, "the retry loop must actually wait for the injected taskkill").toBeGreaterThanOrEqual(
      ATTEMPTS * SLOW_TASKKILL_MS,
    );
  });

  it("issues the tree-kill in the SAME tick, so the abort path cannot lose it", async () => {
    // Going async must not turn "kill now" into "kill at some later tick": the
    // mechanism is invoked synchronously up to the first `await`, which is what
    // lets an abort listener fire-and-forget without deferring the signal.
    const issued: string[] = [];
    const pending = taskkillTree(42, "win32", {
      run: () => {
        issued.push("taskkill");
        return Promise.resolve();
      },
      alive: () => true,
      sleep: () => undefined,
      attempts: 1,
    });
    // Still in the caller's own tick: no await has happened yet.
    expect(issued).toEqual(["taskkill"]);
    expect(await pending).toBe(false);
  });
});
