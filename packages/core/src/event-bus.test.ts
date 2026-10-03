/**
 * B4-02 / B4-03 — the bus can now SHRINK, and one dispatch means one dispatch.
 *
 * B4-02 (no unsubscribe): every register method returned `void`, so a plugin with
 * a lifecycle — mount, rebuild, teardown — could never drop its layer. A bus that
 * only grows is a bus whose cost is paid on every later event, forever.
 *
 * B4-03 (live-array dispatch): the runners iterated the Map's real array, and
 * `for...of` over an array sees elements appended during the walk. A listener that
 * registered another one was therefore called by the SAME dispatch that called it.
 *
 * Both are pinned here against the REAL bus, and the snapshot cases are the ones
 * that matter: they are the difference between "a listener added mid-dispatch" and
 * "a listener that cascades without bound".
 */

import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "./event-bus.js";

describe("B4-02 · every registration is removable", () => {
  it("on() returns a disposer that removes exactly that listener", () => {
    const bus = createEventBus();
    const seen: number[] = [];
    const stop = bus.on<number>("e", (v) => seen.push(v));

    bus.emit("e", 1);
    expect(bus.counts("e").on).toBe(1);

    stop();
    expect(bus.counts("e").on).toBe(0);
    bus.emit("e", 2);
    expect(seen).toEqual([1]); // the second emit reached nobody
  });

  it("two registrations of the SAME function each remove their own row", () => {
    const bus = createEventBus();
    const fn = vi.fn();
    const stopA = bus.on("e", fn);
    const stopB = bus.on("e", fn);
    expect(bus.counts("e").on).toBe(2);

    stopA();
    // Exactly one left — a disposer keyed on the FUNCTION would have removed both.
    expect(bus.counts("e").on).toBe(1);
    bus.emit("e", 1);
    expect(fn).toHaveBeenCalledTimes(1);

    stopB();
    expect(bus.counts("e").on).toBe(0);
  });

  it("a disposer is idempotent and safe after the key is gone", () => {
    const bus = createEventBus();
    const stop = bus.on("e", () => undefined);
    stop();
    expect(() => {
      stop();
      stop();
    }).not.toThrow();
    expect(bus.counts("e").on).toBe(0);
  });

  it("bail / waterfall / waterfallAsync disposers work the same way", async () => {
    const bus = createEventBus();
    const stopBail = bus.bail<number, string>("k", () => "b");
    const stopWf = bus.waterfall<number, number>("k", (_e, v) => v + 1);
    const stopAsync = bus.waterfallAsync<number, string>("k", () => Promise.resolve("a"));
    expect(bus.counts("k")).toEqual({ on: 0, bail: 1, waterfall: 2 });

    stopBail();
    stopWf();
    stopAsync();
    expect(bus.counts("k")).toEqual({ on: 0, bail: 0, waterfall: 0 });
    expect(bus.runBail("k", 1)).toBeUndefined();
    expect(bus.runWaterfall("k", 1, 0)).toBe(0);
    await expect(bus.runWaterfallAsync("k", 1, async () => "fallback")).resolves.toBe("fallback");
  });

  it("repeated mount/teardown cycles do NOT accumulate listeners (the leak itself)", () => {
    const bus = createEventBus();
    const hits = vi.fn();
    // 1000 generations, each mounting and tearing down its layer — the shape that
    // used to leak a listener per generation.
    for (let i = 0; i < 1000; i += 1) {
      const stop = bus.on("gen", hits);
      stop();
    }
    expect(bus.counts("gen").on).toBe(0);

    bus.emit("gen", 1);
    expect(hits).toHaveBeenCalledTimes(0);
  });

  it("a disposer dropped mid-chain still lets the current run finish", () => {
    const bus = createEventBus();
    const order: string[] = [];
    // Registration order IS chain order, so the layer that tears a later one down
    // must be registered FIRST. "a" walks the chain and unsubscribes "b" mid-run:
    // indexing the LIVE array would let that splice shift the next slot under the
    // walk and silently skip "c", while the snapshot finishes the run in order.
    let stopB: (() => void) | null = null;
    let stopC: (() => void) | null = null;
    const stopA = bus.bail<number, string>("k", () => {
      order.push("a");
      stopB?.();
      return undefined;
    });
    stopB = bus.bail<number, string>("k", () => {
      order.push("b");
      return undefined;
    });
    stopC = bus.bail<number, string>("k", () => {
      order.push("c");
      return undefined;
    });

    expect(bus.runBail("k", 1)).toBeUndefined();
    expect(order).toEqual(["a", "b", "c"]);

    // ...and the teardown really took effect for the NEXT run: "b" is gone from
    // the table, so only "a" and "c" run ("a" is still registered by design).
    order.length = 0;
    expect(bus.runBail("k", 1)).toBeUndefined();
    expect(order).toEqual(["a", "c"]);
    stopA();
    stopC?.();
  });
});

describe("B4-03 · one dispatch means the listeners that existed when it started", () => {
  it("emit does NOT call a listener registered by another listener, same round", () => {
    const bus = createEventBus();
    const late = vi.fn();
    bus.on("e", () => {
      bus.on("e", late); // registered DURING the dispatch below
    });

    bus.emit("e", 1);
    expect(late).toHaveBeenCalledTimes(0); // not this round

    bus.emit("e", 2); // now it is in the snapshot
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("a self-registering listener cannot cascade within one dispatch", () => {
    const bus = createEventBus();
    let calls = 0;
    let rows = 0;
    // The pathological shape: EVERY listener, when called, registers another,
    // so a runner that walks the LIVE array re-enters itself without end (the
    // first unbounded version of this test exhausted memory and killed the
    // worker -- proof the cascade is real, but a useless gate). The ceiling below
    // turns the same trap into an assertion failure instead.
    const registerAnother = (): void => {
      if (rows >= 6) return;
      rows += 1;
      bus.on("bomb", () => {
        calls += 1;
        registerAnother();
      });
    };
    registerAnother();

    bus.emit("bomb", 1);
    // With the live array the chain re-enters and runs every row it creates;
    // with the snapshot exactly ONE row ran -- the one present at entry.
    expect(calls).toBe(1);
    expect(bus.counts("bomb").on).toBe(2); // the original row + the one it added
  });

  it("runBail and runWaterfall snapshot too", () => {
    const bus = createEventBus();
    const seen: string[] = [];
    bus.bail<number, string>("k", () => {
      seen.push("first");
      bus.bail<number, string>("k", () => {
        seen.push("late");
        return undefined;
      });
      return undefined;
    });
    expect(bus.runBail("k", 1)).toBeUndefined();
    expect(seen).toEqual(["first"]);

    const values: number[] = [];
    const bus2 = createEventBus();
    bus2.waterfall<number, number>("k", (_e, v) => {
      values.push(v);
      bus2.waterfall<number, number>("k", (_e, w) => {
        values.push(w + 100);
        return w + 100;
      });
      return v + 1;
    });
    expect(bus2.runWaterfall("k", 1, 0)).toBe(1); // the late layer did not run
    expect(values).toEqual([0]);
  });

  it("runWaterfallAsync takes ONE snapshot for the whole chain", async () => {
    const bus = createEventBus();
    const seen: string[] = [];
    // An async chain is walked lazily through next(); an unsubscribe between two
    // awaits must not shift the indices under the walk.
    // Registration order IS the async chain order (outermost first), so the
    // layer that tears a later one down must be registered FIRST. `stopSecond` is
    // a `let` assigned right after, and only CALLED during dispatch -- after both
    // are bound -- so there is no temporal-dead-zone read here.
    let stopSecond: (() => void) | null = null;
    const stopFirst = bus.waterfallAsync<number, string>("k", async (e, next) => {
      seen.push("first");
      stopSecond?.(); // tear down the layer behind us mid-walk
      return next();
    });
    stopSecond = bus.waterfallAsync<number, string>("k", async (e, next) => {
      seen.push("second");
      return next();
    });

    const out = await bus.runWaterfallAsync("k", 1, async () => {
      seen.push("bottom");
      return "bottom";
    });
    expect(out).toBe("bottom");
    // The snapshot was taken before the teardown, so the walk still reaches the
    // bottom IN ORDER instead of skipping a slot under a shifted index.
    expect(seen).toEqual(["first", "second", "bottom"]);
    stopFirst();
    stopSecond();
  });

  it("preserves registration order for the listeners that ARE in the snapshot", () => {
    const bus = createEventBus();
    const order: string[] = [];
    bus.on("e", () => order.push("a"));
    bus.on("e", () => order.push("b"));
    bus.on("e", () => order.push("c"));
    bus.emit("e", 1);
    expect(order).toEqual(["a", "b", "c"]);
  });
});
