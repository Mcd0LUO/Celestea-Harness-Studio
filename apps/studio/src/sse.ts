/**
 * Studio SSE bus — the host side of `GET /api/events` (W513).
 *
 * Contract points implemented here:
 *   - envelope `{v:2, session, turn, seq, payload}`: `session` is the session the
 *     frame belongs to (`null` = process-level), `turn` is the SESSION-local turn
 *     number, `seq` stays a monotonic process-global counter and `payload` is
 *     byte-identical to the frozen 8-event contract;
 *   - exactly 8 event names (`SSE_EVENT_NAMES` lives in `@celestea/core`);
 *   - default = one connection receives EVERY session (the client routes
 *     locally); `subscribe({session})` = server-side split for narrow clients;
 *   - back-pressure is PER SESSION BUCKET: a background session's text flood can
 *     no longer evict the focused session's frames. Only the overflowing bucket
 *     is dropped, and the marker carries `{session, dropped, hint}`.
 *
 * NOTE (W513): the design sketch also proposed coalescing `status` frames per
 * session. That is NOT done here: the P5 replay harness compares the frame
 * stream byte-for-byte against the derived transcript, and dropping a status
 * frame silently is indistinguishable from losing a real frame. Per-session
 * bucketing alone provides the isolation the feature needs.
 *
 * The bus is push-based (each subscriber owns a bounded queue plus a waiter) so
 * a Hono `streamSSE` handler awaits frames instead of polling. Delivery is
 * deliberately lossy under back-pressure: that IS the contract.
 */

import {
  BUS_CAPACITY as CORE_CAPACITY,
  LAGGED_HINT,
  SSE_EVENT_NAMES,
  type SseEnvelope,
  type SseEventName,
  type Statusline,
} from "@celestea/core";

export { LAGGED_HINT };
/** Core keeps the canonical bus capacity; the host re-exports it under its own name. */
export const SSE_BUS_CAPACITY = CORE_CAPACITY;
/** Envelope version this bus writes (`2` = per-session envelope). */
export const SSE_ENVELOPE_VERSION = 2;
/** Smallest per-session bucket (never starve one session in a busy process). */
export const MIN_BUCKET_CAPACITY = 64;

export interface BusFrame {
  event: SseEventName;
  envelope: SseEnvelope;
}

export interface BusSubscription {
  /** Await the next frame; resolves to null once the subscription is closed. */
  next(): Promise<BusFrame | null>;
  close(): void;
  /**
   * Frames actually DISCARDED for this subscriber — the same number the
   * `lagged` marker carries (B7-3). It is a running total, so a client that
   * reads it knows how far behind it is and can re-fetch that much.
   */
  dropped(): number;
  /** How many times the bucket overflowed (a severity signal, not a frame count). */
  droppedBursts(): number;
}

/** Server-side split: keep only these sessions (plus process-level frames). */
export interface SubscribeOptions {
  /** One session id (`null` keeps only process-level frames). */
  session?: string | null;
  /** Several session ids (repeatable `?session=`). */
  sessions?: readonly string[];
}

export interface StudioBus {
  emit(event: SseEventName, turn: number, payload: Record<string, unknown>, session?: string | null): BusFrame;
  subscribe(opts?: SubscribeOptions): BusSubscription;
  /** Current global sequence counter (next value to be handed out). */
  seq(): number;
  subscriberCount(): number;
}

export interface StudioBusOptions {
  capacity?: number;
  /** Per-session bucket floor (default [MIN_BUCKET_CAPACITY], clamped to capacity). */
  minBucket?: number;
  /** Statusline snapshot embedded in the `lagged` marker. */
  statusline?: () => Statusline | Record<string, unknown>;
}

interface Waiter {
  resolve: (frame: BusFrame | null) => void;
}

function bucketKey(session: string | null): string {
  return session ?? "";
}

/** One subscriber: an ordered frame list plus per-session occupancy counts. */
class SessionBuckets {
  private readonly frames: BusFrame[] = [];
  private readonly counts = new Map<string, number>();
  private waiter: Waiter | null = null;
  private closed = false;
  /**
   * B7-3: how many FRAMES this subscriber has lost, not how many times the
   * bucket overflowed. Those are different units and the old code conflated
   * them: the overflow path discards a WHOLE bucket at a time, so a single
   * overflow can throw away hundreds of frames while the counter went up by
   * one. Measured before the fix (2000 frames into one session, capacity 512):
   * the marker claimed `dropped: 513` while 1537 frames were actually lost —
   * an under-report of 1024, and the client that trusts it under-repairs.
   *
   * `overflows` is kept separately because it answers a different question
   * ("how bad was the stall") that an operator reads, and because conflating
   * the two is exactly what produced the wrong number.
   */
  private lostFrames = 0;
  private overflows = 0;

  constructor(
    private readonly capacity: number,
    private readonly minBucket: number,
    private readonly accept: (frame: BusFrame) => boolean,
    private readonly lagged: (session: string | null, dropped: number) => BusFrame,
  ) {}

  push(frame: BusFrame): void {
    if (this.closed || !this.accept(frame)) return;
    const key = bucketKey(frame.envelope.session);
    if ((this.counts.get(key) ?? 0) >= this.bucketCap()) {
      this.overflows += 1;
      // The +1 accounted for the frame that TRIGGERED the overflow; that frame
      // is never appended (this branch returns), so counting it here would
      // over-report by one per overflow. The discarded backlog is the real loss.
      const discarded = this.dropBucket(key);
      this.lostFrames += discarded;
      // A cumulative count, not a per-overflow delta: contracts/sse-events.json
      // declares the marker as the client’s only signal that "you missed
      // things", and a per-event number would read as "this event dropped N"
      // and under-report the session as a whole.
      this.append(this.lagged(frame.envelope.session, this.lostFrames));
      return;
    }
    this.append(frame);
  }

  next(): Promise<BusFrame | null> {
    const frame = this.shift();
    if (frame !== undefined) return Promise.resolve(frame);
    if (this.closed) return Promise.resolve(null);
    return new Promise<BusFrame | null>((resolve) => {
      this.waiter = { resolve };
    });
  }

  close(): void {
    this.closed = true;
    this.frames.length = 0;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.resolve(null);
  }

  /** Frames actually discarded for this subscriber (the lagged marker’s number). */
  dropped(): number {
    return this.lostFrames;
  }

  /** How many times the bucket overflowed (an operator-facing severity signal). */
  droppedBursts(): number {
    return this.overflows;
  }

  /** Per-session bucket cap: the fair share, never below `minBucket`. */
  private bucketCap(): number {
    const buckets = Math.max(1, this.counts.size);
    return Math.max(Math.min(this.minBucket, this.capacity), Math.floor(this.capacity / buckets));
  }

  private append(frame: BusFrame): void {
    this.frames.push(frame);
    const key = bucketKey(frame.envelope.session);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.wake();
  }

  /** Drop ONE session's backlog; returns how many frames were discarded. */
  private dropBucket(key: string): number {
    const kept: BusFrame[] = [];
    let removed = 0;
    for (const frame of this.frames) {
      if (bucketKey(frame.envelope.session) === key) removed += 1;
      else kept.push(frame);
    }
    this.frames.length = 0;
    this.frames.push(...kept);
    this.counts.set(key, 0);
    return removed;
  }

  /** Dequeue one frame and release its bucket slot. */
  private shift(): BusFrame | undefined {
    const frame = this.frames.shift();
    if (frame === undefined) return undefined;
    const key = bucketKey(frame.envelope.session);
    this.counts.set(key, Math.max(0, (this.counts.get(key) ?? 1) - 1));
    return frame;
  }

  private wake(): void {
    const waiter = this.waiter;
    if (waiter === null) return;
    this.waiter = null;
    waiter.resolve(this.shift() ?? null);
  }
}

function assertEventName(event: string): asserts event is SseEventName {
  if (!(SSE_EVENT_NAMES as readonly string[]).includes(event)) {
    throw new Error(`unknown SSE event '${event}': the contract freezes ${SSE_EVENT_NAMES.length} names`);
  }
}

/** The `?session=` filter: matching sessions plus process-level frames. */
function sessionFilter(opts: SubscribeOptions): (frame: BusFrame) => boolean {
  const one = opts.session;
  const many = opts.sessions;
  if (one === undefined && many === undefined) return () => true;
  const wanted = new Set<string>(many ?? []);
  if (one !== undefined && one !== null) wanted.add(one);
  return (frame) => frame.envelope.session === null || wanted.has(frame.envelope.session);
}

/** One bus per Studio app; adapters and handlers share it. */
export function createStudioBus(opts: StudioBusOptions = {}): StudioBus {
  const capacity = opts.capacity ?? SSE_BUS_CAPACITY;
  const minBucket = Math.min(opts.minBucket ?? MIN_BUCKET_CAPACITY, capacity);
  const queues = new Set<SessionBuckets>();
  let seq = 0;

  const laggedFrame = (session: string | null, dropped: number): BusFrame => ({
    event: "status",
    envelope: {
      v: SSE_ENVELOPE_VERSION,
      session,
      turn: 0,
      seq: seq++,
      payload: {
        phase: "lagged",
        hint: LAGGED_HINT,
        session,
        dropped,
        statusline: opts.statusline ? opts.statusline() : {},
      },
    },
  });

  function emit(event: SseEventName, turn: number, payload: Record<string, unknown>, session: string | null = null): BusFrame {
    assertEventName(event);
    const frame: BusFrame = { event, envelope: { v: SSE_ENVELOPE_VERSION, session, turn, seq: seq++, payload } };
    for (const q of queues) q.push(frame);
    return frame;
  }

  function subscribe(sub?: SubscribeOptions): BusSubscription {
    const q = new SessionBuckets(capacity, minBucket, sessionFilter(sub ?? {}), laggedFrame);
    queues.add(q);
    return {
      next: () => q.next(),
      close: () => {
        q.close();
        queues.delete(q);
      },
      dropped: () => q.dropped(),
      droppedBursts: () => q.droppedBursts(),
    };
  }

  return { emit, subscribe, seq: () => seq, subscriberCount: () => queues.size };
}
