/**
 * EventBus seam — port of `crates/core/src/event_bus.rs`.
 *
 * A typed bus with three independent dispatch modes, keyed by event type:
 *   - on / emit          observe-only broadcast;
 *   - bail / runBail     intercept chain: first non-`undefined` answer
 *                        short-circuits (the guard primitive);
 *   - waterfall / runWaterfall
 *                        transform chain: each listener maps the running value
 *                        handed to the next one.
 *
 * The three modes live in separate maps, so a listener registered in one mode
 * never interferes with another. The event type is an explicit token — a
 * well-known string, a symbol, or a class constructor used by identity (see
 * `context.ts:ServiceToken`).
 *
 * `undefined` is `None`: a bail listener that returns `undefined` passes, and a
 * `null`/`false`/`0` answer short-circuits (unlike a truthiness check).
 * `runWaterfall` cannot verify at runtime that every listener shares one value
 * type (the legacy engine panics on a failed downcast); the TS generic makes
 * one value type per event type a compile-time contract — pass a `transform`
 * that keeps it.
 *
 * ## B4-02: every registration is removable
 *
 * The four register methods return an [Unsubscribe], because a bus without a
 * way to UN-register is a bus that only grows: any plugin with a lifecycle —
 * mount, rebuild, teardown — would leak a layer per generation. Returning the
 * disposer is source-compatible (a caller that ignored the old `void` still
 * compiles and behaves identically) and needs no bookkeeping on its side.
 *
 * The disposer is keyed on a per-registration id rather than on the function,
 * so registering one function twice yields two independent rows, and it is
 * idempotent, so a teardown path may call it twice without a guard.
 *
 * ## B4-03: dispatch walks a SNAPSHOT
 *
 * Every runner iterates a copy of the listener list, not the live array. For
 * `for...of` over the real array, a listener that registers another one is
 * called by the SAME dispatch that called it — a re-entrancy trap that can
 * cascade without bound if each new listener registers a further one. A
 * snapshot makes one dispatch mean exactly "the listeners that existed when it
 * started", which is also what a listener removed mid-dispatch should see.
 *
 * Snapshotting on unsubscribe is what keeps that promise true when a listener
 * disposes ITSELF: the copy is already taken, so the run finishes cleanly
 * instead of shifting indices under the chain.
 */

import type { ServiceToken } from "./context.js";

export type EventKey<E> = ServiceToken<E>;

type Listener = (...args: never[]) => unknown;

/** B4-02: the value every register method returns; calling it is idempotent. */
export type Unsubscribe = () => void;

/**
 * One registration. The `id` is what makes a disposer exact: two registrations
 * of the SAME function are two rows, and each disposer must remove its own.
 */
interface Slot {
  readonly id: number;
  readonly fn: Listener;
}

export interface EventBus {
  /** Observe-only broadcast listener. Returns its [Unsubscribe]. */
  on<E>(key: EventKey<E>, listener: (event: E) => void): Unsubscribe;
  /** Deliver to every listener registered with `on` for this key. */
  emit<E>(key: EventKey<E>, event: E): void;
  /** Intercept listener; returning `undefined` passes to the next one. */
  bail<E, R>(key: EventKey<E>, listener: (event: E) => R | undefined): Unsubscribe;
  /** First non-`undefined` answer in registration order, else undefined. */
  runBail<E, R>(key: EventKey<E>, event: E): R | undefined;
  /** Transform listener; each layer receives the previous layer's value. */
  waterfall<E, R>(key: EventKey<E>, listener: (event: E, value: R) => R): Unsubscribe;
  /** The value after every waterfall listener has run, in order. */
  runWaterfall<E, R>(key: EventKey<E>, event: E, init: R): R;
  /**
   * W783: ASYNC delegate chain. Each layer receives `(event, next)`: returning a
   * value CLAIMS the request, calling `next()` delegates to the layer behind it.
   * This is the cordis waterfall the sync `waterfall` cannot express, because a
   * claiming layer may have to PARK on a promise (user questions, §5.2).
   */
  waterfallAsync<E, R>(key: EventKey<E>, listener: (event: E, next: () => Promise<R>) => Promise<R>): Unsubscribe;
  /**
   * W783: run the async chain outermost-first. `init` is the bottom of the
   * chain (the fallback), reached only when every layer delegates.
   */
  runWaterfallAsync<E, R>(key: EventKey<E>, event: E, init: () => Promise<R>): Promise<R>;
  /**
   * Registered listener counts per mode (diagnostics / tests). The shape is
   * frozen: `on`/`bail`/`waterfall`, with the async chain folded into the last
   * one exactly as it always was.
   */
  counts(key: EventKey<unknown>): { on: number; bail: number; waterfall: number };
}

function busKey(key: EventKey<unknown>): unknown {
  return typeof key === "string" ? `event:${key}` : key;
}

export function createEventBus(): EventBus {
  const subs = new Map<unknown, Slot[]>();
  const bailers = new Map<unknown, Slot[]>();
  const waterfalls = new Map<unknown, Slot[]>();
  // W783: the async delegate chain lives in its own map, so a listener
  // registered in one mode can never interfere with another (same rule as the
  // three original modes).
  const asyncWaterfalls = new Map<unknown, Slot[]>();
  let nextId = 0;

  /**
   * Append a registration and hand back its exact disposer.
   *
   * The disposer closes over the slot's `id`, not over the function, so two
   * registrations of one function each remove their own row — and the empty
   * key is dropped from the map, so a long-lived bus that registers and
   * unregisters many event types does not accumulate dead keys.
   */
  const push = (map: Map<unknown, Slot[]>, key: EventKey<unknown>, fn: Listener): Unsubscribe => {
    const k = busKey(key);
    const slot: Slot = { id: nextId++, fn };
    const list = map.get(k);
    if (list) list.push(slot);
    else map.set(k, [slot]);
    return () => {
      const live = map.get(k);
      if (live === undefined) return;
      const at = live.findIndex((row) => row.id === slot.id);
      if (at >= 0) live.splice(at, 1);
      if (live.length === 0) map.delete(k);
    };
  };

  /** B4-03: the snapshot every runner dispatches over. */
  const listeners = (map: Map<unknown, Slot[]>, key: EventKey<unknown>): Listener[] => {
    const live = map.get(busKey(key));
    return live === undefined ? [] : live.map((row) => row.fn);
  };

  return {
    on(key, listener) {
      return push(subs, key, listener as Listener);
    },
    emit(key, event) {
      for (const fn of listeners(subs, key)) (fn as (e: unknown) => void)(event);
    },
    bail(key, listener) {
      return push(bailers, key, listener as Listener);
    },
    runBail(key, event) {
      for (const fn of listeners(bailers, key)) {
        const answer = (fn as (e: unknown) => unknown)(event);
        if (answer !== undefined) return answer as never;
      }
      return undefined;
    },
    waterfall(key, listener) {
      return push(waterfalls, key, listener as Listener);
    },
    runWaterfall(key, event, init) {
      let value = init;
      for (const fn of listeners(waterfalls, key)) {
        value = (fn as (e: unknown, v: unknown) => unknown)(event, value) as never;
      }
      return value;
    },
    waterfallAsync(key, listener) {
      return push(asyncWaterfalls, key, listener as Listener);
    },
    runWaterfallAsync(key, event, init) {
      // Outermost-first: each layer gets a `next` that walks to the layer
      // behind it and finally to `init`. Building the chain lazily (inside
      // `next`) keeps a delegating layer from running anything downstream
      // until it actually delegates.
      //
      // B4-03: the snapshot is taken ONCE, up front. Indexing the live array
      // instead would let an unsubscribe mid-chain shift the indices under the
      // walk and silently skip a layer.
      const layers = listeners(asyncWaterfalls, key);
      const step = (index: number): Promise<unknown> => {
        const fn = layers[index];
        if (fn === undefined) return init();
        return (fn as (e: unknown, n: () => Promise<unknown>) => Promise<unknown>)(event, () => step(index + 1));
      };
      return step(0) as never;
    },
    counts(key) {
      const k = busKey(key);
      return {
        on: (subs.get(k) ?? []).length,
        bail: (bailers.get(k) ?? []).length,
        waterfall: (waterfalls.get(k) ?? []).length + (asyncWaterfalls.get(k) ?? []).length,
      };
    },
  };
}

/** Well-known token for the engine event bus service. */
export const EVENT_BUS_SERVICE = "celestea.core.EventBus";
