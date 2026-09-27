/**
 * W2014 · the ONE deadline primitive.
 *
 * These cases pin the THREE answers a deadline can give — sentinel / throw /
 * resolve — plus the two properties every call site depends on: the timer is
 * cleared when the work wins, and a late rejection from the losing promise is
 * swallowed instead of becoming an unhandled rejection.
 *
 * Why the three are tested TOGETHER: the whole point of the primitive is that
 * they stay distinguishable. A refactor that collapses "resolve a sentinel" into
 * "throw" would still pass a test that only ever checks the happy path.
 */
import { describe, expect, it, vi } from "vitest";

import { bounded, idle, TIMED_OUT, withTimeout } from "./async.js";

/** A promise that never settles (the deadline is the only way out). */
function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

describe("W2014 · bounded(): the three deadline policies", () => {
  it("sentinel: the deadline RESOLVES [TIMED_OUT] and the caller inspects it", async () => {
    expect(await bounded(never<string>(), 20)).toBe(TIMED_OUT);
    expect(await withTimeout(never<string>(), 20)).toBe(TIMED_OUT);
  });

  it("throw: the deadline REJECTS with the factory's error, built when it fires", async () => {
    const seen: string[] = [];
    const failure: Error = await bounded(never<string>(), 20, {
      mode: "throw",
      error: () => {
        seen.push("built");
        return new Error("摘要请求 timeout after 20ms");
      },
    }).then(
      () => new Error("the deadline must NOT resolve"),
      (e: Error) => e,
    );
    expect(failure.message).toBe("摘要请求 timeout after 20ms");
    // The factory runs ON THE DEADLINE, not at the call: that is what lets the
    // message name the operation and the budget that actually elapsed.
    expect(seen, "the error factory is invoked when the deadline fires").toEqual(["built"]);
  });

  it("resolve: the deadline runs its side effects and resolves with the sentinel value", async () => {
    const effects: string[] = [];
    const out = await bounded(never<string>(), 20, {
      mode: "resolve",
      value: () => {
        effects.push("killed");
        return null;
      },
    });
    expect(out, "a resolve-policy deadline widens the result to its own value").toBeNull();
    expect(effects, "the side effect ran exactly once").toEqual(["killed"]);
  });

  it("work wins: its value is returned unchanged under every policy", async () => {
    const work = Promise.resolve("done");
    expect(await bounded(work, 5_000)).toBe("done");
    expect(await bounded(Promise.resolve("done"), 5_000, { mode: "throw", error: () => new Error("no") })).toBe("done");
    expect(await bounded(Promise.resolve("done"), 5_000, { mode: "resolve", value: () => null })).toBe("done");
  });

  it("work wins ⇒ the timer is CLEARED (no handle left to keep the process alive)", async () => {
    const spy = vi.spyOn(globalThis, "clearTimeout");
    await bounded(Promise.resolve(1), 60_000);
    expect(spy, "a settled work must clear its deadline").toHaveBeenCalled();
    spy.mockRestore();
  });

  it("a rejection landing AFTER the deadline won is swallowed (no unhandled rejection)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const lateCtl: { reject: ((e: Error) => void) | null } = { reject: null };
    const late = new Promise<string>((_, reject) => {
      lateCtl.reject = reject;
    });
    expect(await bounded(late, 20)).toBe(TIMED_OUT);
    lateCtl.reject?.(new Error("write to a destroyed stdin"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled, "the losing promise's rejection must be parked, not raised").toEqual([]);
  });
});

describe("W2014 · idle(): a FRESH budget per demand", () => {
  it("each call gets the whole budget (two slow demands both fit)", async () => {
    // 2 × 40ms of work under a 60ms per-demand idle budget: a TOTAL budget of
    // 60ms would fail the second one. This is the total-vs-idle distinction.
    const slow = (ms: number): Promise<string> => new Promise((resolve) => setTimeout(() => resolve("ok"), ms));
    expect(await idle(slow(40), 60)).toBe("ok");
    expect(await idle(slow(40), 60)).toBe("ok");
  });

  it("an idle demand that never produces a value resolves the caller's sentinel", async () => {
    expect(await idle(never<string>(), 20, { mode: "resolve", value: () => null })).toBeNull();
  });
});
