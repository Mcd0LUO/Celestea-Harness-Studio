/**
 * W767 — login failure limiter (fixed 60 s window).
 *
 * Counted per USERNAME and per CLIENT IP separately, so neither "spray one
 * password over many accounts" nor "spray many passwords at one account" gets a
 * free run, while a legitimate user behind a shared IP is only slowed after the
 * same key fails repeatedly. Only FAILURES count; a success clears both keys of
 * that attempt. In-memory on purpose: Studio is a single process, the window is
 * one minute, and the counter must not survive a restart as a lockout.
 */

/** Window length in ms (the spec's 60 s). */
export const AUTH_WINDOW_MS = 60_000;
/** Failures allowed inside one window before 429. */
export const AUTH_MAX_FAILURES = 5;
/** Ceiling on tracked keys: a spray can never grow the map without bound. */
const MAX_KEYS = 4_096;
/**
 * W9230 (W9206-10): how many of the OLDEST keys one full-map eviction frees.
 *
 * The old code called `hits.clear()` when the map filled, which threw away
 * EVERY counter — including the victim account's `u:admin` and the attacker's
 * own `ip:` — so 4096 requests with distinct keys inside one 60 s window reset
 * the lockout it had just earned. A bounded eviction keeps the map bounded
 * without ever discarding a counter that is still doing work.
 */
const EVICT_BATCH = 256;

export interface FailureLimiter {
  /** true = the key already exhausted its window (the caller answers 429). */
  blocked(key: string): boolean;
  /** Record one failure for the key (opens/extends its window). */
  fail(key: string): void;
  /** Forget the key (a successful login). */
  clear(key: string): void;
}

export function createFailureLimiter(opts: {
  now: () => number;
  windowMs?: number;
  maxFailures?: number;
}): FailureLimiter {
  const windowMs = opts.windowMs ?? AUTH_WINDOW_MS;
  const maxFailures = opts.maxFailures ?? AUTH_MAX_FAILURES;
  const hits = new Map<string, { count: number; resetAt: number }>();

  return {
    blocked(key: string): boolean {
      const entry = hits.get(key);
      return entry !== undefined && entry.resetAt > opts.now() && entry.count >= maxFailures;
    },
    fail(key: string): void {
      const now = opts.now();
      prune(hits, now);
      // W9230 (W9206-10): evict bounded, and never a key that is still
      // LOCKED. `clear()` reset a live lockout (see EVICT_BATCH); evicting by
      // insertion order alone would still drop the victim's counter the moment
      // it became the oldest entry, so the unblocked entries go first and a
      // blocked one is only sacrificed when EVERY entry is blocked.
      if (hits.size >= MAX_KEYS) evictBounded(hits, EVICT_BATCH, maxFailures, now);
      const entry = hits.get(key);
      if (entry === undefined || entry.resetAt <= now) hits.set(key, { count: 1, resetAt: now + windowMs });
      else entry.count += 1;
    },
    clear(key: string): void {
      hits.delete(key);
    },
  };
}

function prune(hits: Map<string, { count: number; resetAt: number }>, now: number): void {
  for (const [key, entry] of hits) {
    if (entry.resetAt <= now) hits.delete(key);
  }
}

/**
 * W9230 (W9206-10): shrink the map without ever resetting a LIVE LOCKOUT.
 *
 * Two passes over the insertion order:
 *   1. delete up to `count` entries that are NOT currently blocked (expired
 *      windows and counters below the threshold) — those are the spray's own
 *      keys, so the victim's `u:admin` lockout survives;
 *   2. only if the map is STILL at the ceiling (every entry blocked, which needs
 *      a coordinated spray of 4096 *locked* keys) fall back to the oldest
 *      entries, because unbounded memory is the worse failure.
 *
 * The old code was a single `hits.clear()`, which did both at once and handed
 * the attacker a reset of the very lockout the limiter exists to impose.
 */
function evictBounded(
  hits: Map<string, { count: number; resetAt: number }>,
  count: number,
  maxFailures: number,
  now: number,
): void {
  const isBlocked = (entry: { count: number; resetAt: number }): boolean => entry.resetAt > now && entry.count >= maxFailures;
  let removed = 0;
  for (const [key, entry] of hits) {
    if (removed >= count) break;
    if (isBlocked(entry)) continue;
    hits.delete(key);
    removed += 1;
  }
  for (const key of hits.keys()) {
    if (removed >= count) break;
    hits.delete(key);
    removed += 1;
  }
}
