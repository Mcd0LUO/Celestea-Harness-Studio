/**
 * B7-2 (audit round 3) — `GET /api/events` writes a heartbeat while idle.
 *
 * The defect: `contracts/sse-events.json` declares
 * `transport.keepAlive: true` and `get_events`'s notes repeat "KeepAlive
 * enabled", but nothing implemented it. The read loop awaited `sub.next()`,
 * which a bus with no traffic never settles, so an idle connection wrote ZERO
 * bytes — measured 0 bytes over a 10s idle window. Every proxy and load
 * balancer then reaps the connection on its own idle timeout, and the client
 * sees the stream die silently: no error, no reconnect, the UI just stops
 * updating.
 *
 * What is pinned here:
 *   ① an idle stream DOES write bytes within the interval (the property that
 *      was entirely absent before the fix);
 *   ② the heartbeat is a COMMENT frame — no `event:`, no `data:`, so it
 *      reaches none of the ten frozen event listeners in `apps/web/src/sse.ts`
 *      and adds no name to the `check-sse-events.mjs` three-way gate
 *      (`contracts/**` therefore stays byte-identical);
 *   ③ a real frame is delivered UNCHANGED and keeps its own event name;
 *   ④ the heartbeat does NOT consume a `seq` number, so the P5 replay
 *      byte-comparison stays deterministic;
 *   ⑤ a busy stream emits no heartbeat noise (a real frame wins the race and
 *      resets the clock);
 *   ⑥ the race clears its timer when a frame wins — no timer leak on a busy
 *      stream (this is why the race is a function, not an inline Promise.race).
 *
 * Real timers on a short interval, not fake ones: vitest's clock cannot drive
 * a TransformStream-backed SSE body (the timer fires but `reader.read()` never
 * settles — the deadlock the first draft hit), so the interval is injected
 * through `registerDialog(..., { keepAliveMs })` and driven in real time.
 */

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createStudioBus, type StudioBus } from "./sse.js";
import { registerDialog } from "./handlers/dialog.js";
import { routeTable } from "./routes.js";

/** Short enough to keep the suite fast, long enough not to race the reader. */
const KEEPALIVE_MS = 60;

interface KeepaliveApp {
  app: Hono;
  bus: StudioBus;
  cleanup(): void;
}

/**
 * A minimal Hono app carrying ONLY the dialog routes, registered with a
 * test-sized keepalive.
 *
 * A bare `new Hono()` (not `createStudioApp`) is deliberate: composing the
 * full app here would register `registerDialog` a second time and the two
 * `get_events` handlers would both run. This mounts the route under test and
 * nothing else. `deps` is the `Deps` shape minus the services this route
 * never touches — `get_events` reads `deps.bus` alone.
 */
function appWithKeepalive(): KeepaliveApp {
  const bus = createStudioBus();
  const app = new Hono();
  registerDialog(app, { bus } as never, routeTable(), { keepAliveMs: KEEPALIVE_MS });
  return { app, bus, cleanup: () => undefined };
}

/** Read the next chunk, failing fast instead of hanging forever. */
async function readWithin(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number): Promise<string> {
  const read = reader.read();
  const guard = new Promise<"TIMEOUT">((resolve) => setTimeout(() => resolve("TIMEOUT"), ms));
  const got = await Promise.race([read, guard]);
  if (got === "TIMEOUT") throw new Error("stream wrote nothing within " + ms + "ms");
  return new TextDecoder().decode((got as { value: Uint8Array }).value ?? new Uint8Array());
}

describe("B7-2 · GET /api/events heartbeats while idle", () => {
  it("① an idle stream writes bytes within the interval (was: nothing, ever)", async () => {
    const { app } = appWithKeepalive();
    const res = await app.fetch(new Request("http://local/api/events"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = (res.body as ReadableStream).getReader();
    // No traffic at all: before the fix this read NEVER settles.
    const chunk = await readWithin(reader, 2000);
    expect(chunk.length).toBeGreaterThan(0);
    await reader.cancel();
  });

  it("② the heartbeat is a COMMENT frame: no event name, no data, invisible to the client", async () => {
    const { app } = appWithKeepalive();
    const res = await app.fetch(new Request("http://local/api/events"));
    const reader = (res.body as ReadableStream).getReader();
    const chunk = await readWithin(reader, 2000);
    // A comment line starts with ':' and dispatches to nothing — which is what
    // keeps the frontend's ten addEventListener names, and therefore
    // contracts/sse-events.json, untouched.
    expect(chunk.startsWith(":")).toBe(true);
    expect(chunk).not.toContain("event:");
    expect(chunk).not.toContain("data:");
    await reader.cancel();
  });

  it("③ a real frame is still delivered unchanged, with its event name", async () => {
    const { app, bus } = appWithKeepalive();
    const res = await app.fetch(new Request("http://local/api/events"));
    const reader = (res.body as ReadableStream).getReader();
    bus.emit("status", 1, { phase: "idle" }, "sample-ws/s1");
    const chunk = await readWithin(reader, 2000);
    expect(chunk).toContain("event: status");
    expect(chunk).toContain('"seq":');
    await reader.cancel();
  });

  it("④ the heartbeat does not consume a seq number (replay stays deterministic)", async () => {
    const { app, bus } = appWithKeepalive();
    const before = bus.seq();
    const res = await app.fetch(new Request("http://local/api/events"));
    const reader = (res.body as ReadableStream).getReader();
    // Three idle heartbeats...
    for (let i = 0; i < 3; i += 1) await readWithin(reader, 2000);
    // ...consumed zero sequence numbers.
    expect(bus.seq()).toBe(before);
    await reader.cancel();
  });

  it("⑤ a busy stream emits no heartbeat noise (a real frame wins the race)", async () => {
    const { app, bus } = appWithKeepalive();
    const res = await app.fetch(new Request("http://local/api/events"));
    const reader = (res.body as ReadableStream).getReader();
    // A frame lands well inside the interval, so the reader sees THAT frame.
    setTimeout(() => bus.emit("text", 1, { delta: "hi" }, "sample-ws/s1"), 5);
    const chunk = await readWithin(reader, 2000);
    expect(chunk).toContain("event: text");
    expect(chunk).not.toContain("keepalive");
    await reader.cancel();
  });

  it("⑥ the race clears its timer when a frame wins (no leak on a busy stream)", async () => {
    // nextFrameOrKeepalive is the unit under test here. The handler calls it
    // once per frame, so a missing clearTimeout would leave one live 25s timer
    // per frame on a busy stream — thousands of them. The observable symptom
    // is therefore "a timer was armed and never cleared", which is exactly
    // what the spy below measures.
    const { nextFrameOrKeepalive, SSE_KEEPALIVE_MS } = await import("./handlers/dialog.js");
    const armed: number[] = [];
    const cleared: unknown[] = [];
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const setSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      const handle = realSet(fn, ms);
      armed.push(handle as unknown as number);
      return handle;
    }) as unknown as typeof setTimeout);
    const clearSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((h?: unknown) => {
      cleared.push(h);
      return realClear(h as never);
    }) as unknown as typeof clearTimeout);
    try {
      const frame = { event: "status" as const, envelope: { v: 2 as const, session: null, turn: 0, seq: 0, payload: {} } };
      for (let i = 0; i < 200; i += 1) {
        const got = await nextFrameOrKeepalive({ next: () => Promise.resolve(frame) }, SSE_KEEPALIVE_MS);
        expect(got).toBe(frame);
      }
      // 200 frames arrived immediately, so the race resolved on the frame side
      // every time — and every one of those 200 timers must have been cleared.
      expect(armed.length).toBe(200);
      expect(cleared.length).toBe(200);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it("⑦ a CLOSED subscription ends the loop (not a heartbeat) — the sentinel is what tells them apart", async () => {
    // B7-2 regression guard. The first hand-rolled version returned `null` for
    // BOTH a quiet stream and a closed subscription, so the loop heartbeat-
    // continued forever on a dead subscription and never reached the pre-
    // keepalive `break`. TIMED_OUT is a distinct symbol, so the two exits are
    // separable; this pins that distinction at the unit level.
    const { nextFrameOrKeepalive } = await import("./handlers/dialog.js");
    const { TIMED_OUT } = await import("@celestea/tools");

    // Closed subscription: next() resolves null. The helper must pass that
    // null straight through (NOT convert it to the timeout sentinel).
    const closed = await nextFrameOrKeepalive({ next: () => Promise.resolve(null) }, 60);
    expect(closed).toBeNull();
    expect(closed).not.toBe(TIMED_OUT);

    // Quiet stream: next() never settles, the budget expires. The helper must
    // resolve the TIMED_OUT sentinel, which is what the loop turns into a
    // heartbeat — and, crucially, what keeps it apart from the `break` above.
    const never = new Promise<never>(() => {});
    const quiet = await nextFrameOrKeepalive({ next: () => never }, 30);
    expect(quiet).toBe(TIMED_OUT);
  });
});
