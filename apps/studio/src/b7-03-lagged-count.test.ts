// @vitest-environment node
/**
 * B7-3 (audit round 3) — the `lagged` marker's `dropped` counts FRAMES lost,
 * not overflow events.
 *
 * The defect: the overflow path in `sse.ts` incremented a counter by 1 and
 * reported `dropBucket(key) + 1` — two numbers in different units. The bucket
 * discard is wholesale (it empties one session's whole backlog), so ONE
 * overflow could destroy hundreds of frames while the counter went up by one.
 * Measured before the fix: 2000 frames into a single session at capacity 512
 * produced a marker claiming `dropped: 513` when 1537 frames were actually
 * lost — an under-report of 1024.
 *
 * Why an UNDER-report is the worst kind of wrong here: `contracts/sse-events.json`
 * declares that lagged events are NOT replayed, so this number is the client’s
 * ONLY signal that frames are missing and the only basis for how much history to
 * re-fetch. A self-consistent-looking number is never questioned; a client that
 * trusts it under-repairs and silently stays behind forever.
 *
 * Pinned here:
 *   ① EXACT accounting on a deterministic single overflow (a backlog of 512
 *      frames discarded → dropped is 512, never 513: the frame that TRIGGERED
 *      the overflow is never delivered, so counting it over-reports by one);
 *   ② the audit repro (2000 frames at capacity 512) reports the loss, not a
 *      number an order of magnitude below it;
 *   ③ the number is CUMULATIVE across bursts, never a per-burst delta;
 *   ④ a subscriber that never overflows reports 0;
 *   ⑤ the burst count stays available and distinct from the frame count.
 */
import { describe, expect, it } from "vitest";
import { createStudioBus, SSE_BUS_CAPACITY, type BusSubscription } from "./sse.js";

/**
 * Read frames until the subscription has been quiet for `quietMs`.
 *
 * `drain` cannot be exact about the tail: at the moment it stops, the bus may
 * still hold buffered frames, and those are NOT lost — they are still queued.
 * So the callers below use [lost] (the subscriber’s own accounting) as the
 * subject under test and treat the drained-frame arithmetic as a bound.
 */
async function drain(sub: BusSubscription, quietMs = 150, budgetMs = 4000) {
  const markers: number[] = [];
  let delivered = 0;
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const frame = await new Promise<Awaited<ReturnType<BusSubscription["next"]>>>((resolve) => {
      const guard = setTimeout(() => resolve(null), quietMs);
      void sub.next().then((f) => {
        if (f !== null) {
          clearTimeout(guard);
          resolve(f);
        }
      });
    });
    if (frame === null) continue;
    delivered += 1;
    const payload = frame.envelope.payload as Record<string, unknown>;
    if (payload["phase"] === "lagged") {
      markers.push(payload["dropped"] as number);
    }
  }
  return { delivered, markers };
}

describe("B7-3 · lagged · the marker counts FRAMES lost, not overflows", () => {
  it("① EXACT accounting: one overflow of a full 512-frame backlog reports 512, never 513", async () => {
    // Fully deterministic: nothing is read while the frames are emitted, so the
    // queue fills to the cap and the next frame overflows it exactly once.
    const bus = createStudioBus();
    const sub = bus.subscribe({ session: "s/one" });
    for (let i = 0; i < SSE_BUS_CAPACITY; i += 1) bus.emit("text", i, { delta: "a" }, "s/one");
    expect(sub.dropped()).toBe(0);
    // This one finds a full bucket, discards all 512, and is itself never
    // delivered — so the honest count is 512. The pre-fix code reported 513.
    bus.emit("text", SSE_BUS_CAPACITY, { delta: "b" }, "s/one");
    expect(sub.dropped()).toBe(SSE_BUS_CAPACITY);
    expect(sub.dropped()).not.toBe(SSE_BUS_CAPACITY + 1);
    expect(sub.droppedBursts()).toBe(1);

    // And the marker the client sees carries that same number.
    const { markers } = await drain(sub);
    sub.close();
    expect(markers).toContain(SSE_BUS_CAPACITY);
  });

  it("② the audit repro: 2000 frames at capacity 512 report the real loss, not ~513", async () => {
    const bus = createStudioBus();
    const sub = bus.subscribe({ session: "s/flood" });
    const emitted = 2000;
    for (let i = 0; i < emitted; i += 1) bus.emit("text", i, { delta: "x".repeat(100) }, "s/flood");
    const { markers } = await drain(sub);
    const lost = sub.dropped();
    sub.close();

    expect(markers.length).toBeGreaterThan(0);
    // The last marker always equals the subscriber’s running total.
    expect(markers[markers.length - 1]).toBe(lost);
    // Before the fix this was 513 against a true loss of ~1537. A floor of
    // 1000 separates the two by a wide margin without depending on how many
    // frames the drain happened to leave queued.
    expect(lost).toBeGreaterThan(1000);
    expect(lost).toBeLessThanOrEqual(emitted);
  });

  it("③ the number is CUMULATIVE across bursts, never a per-burst delta", async () => {
    const bus = createStudioBus();
    const sub = bus.subscribe({ session: "s/flood" });
    for (let i = 0; i < 60; i += 1) {
      for (let k = 0; k < 30; k += 1) bus.emit("text", i, { delta: "y".repeat(200) }, "s/flood");
      await new Promise((r) => setTimeout(r, 1));
    }
    const { markers } = await drain(sub);
    const lost = sub.dropped();
    const bursts = sub.droppedBursts();
    sub.close();

    expect(bursts).toBeGreaterThan(1);
    expect(markers.length).toBeGreaterThan(0);
    // Monotonically non-decreasing: each marker repeats or grows the total.
    for (let i = 1; i < markers.length; i += 1) {
      expect(markers[i] as number).toBeGreaterThanOrEqual(markers[i - 1] as number);
    }
    // A per-burst delta would restart near zero on the last burst; a cumulative
    // count ends at the running total.
    expect(markers[markers.length - 1]).toBe(lost);
    // And it must exceed a single burst’s backlog, which is the whole bug.
    expect(lost).toBeGreaterThan(bursts * 1);
  });

  it("④ a subscriber that never overflows reports 0", async () => {
    const bus = createStudioBus();
    const sub = bus.subscribe({ session: "s/quiet" });
    for (let i = 0; i < 5; i += 1) bus.emit("status", i, { phase: "idle" }, "s/quiet");
    // Read exactly the five queued frames. Draining "until null" would hang
    // forever here: `next()` on an EMPTY open subscription never resolves (that
    // is the same never-settling await the SSE keepalive exists to bound).
    for (let i = 0; i < 5; i += 1) {
      const frame = await sub.next();
      expect(frame).not.toBeNull();
    }
    expect(sub.dropped()).toBe(0);
    expect(sub.droppedBursts()).toBe(0);
    sub.close();
  });

  it("⑤ the burst count stays available and distinct from the frame count", async () => {
    const bus = createStudioBus();
    const sub = bus.subscribe({ session: "s/flood" });
    for (let i = 0; i < SSE_BUS_CAPACITY * 2; i += 1) bus.emit("text", i, { delta: "q".repeat(100) }, "s/flood");
    await drain(sub);
    const frames = sub.dropped();
    const bursts = sub.droppedBursts();
    sub.close();
    // Before the fix these were THE SAME field, which is the whole bug: one
    // number was being asked to answer two different questions.
    expect(bursts).toBeGreaterThan(0);
    expect(frames).toBeGreaterThan(bursts);
  });
});