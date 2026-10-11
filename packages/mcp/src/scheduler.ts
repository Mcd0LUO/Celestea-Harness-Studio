/**
 * The timer seam.
 *
 * It lives in its own module because BOTH the connection and the reconnect budget
 * need it, and a type-only back-import between those two would be a dependency
 * cycle (`lint:arch` is right: the two halves of one supervisor must not import
 * each other).
 *
 * Tests drive backoff deterministically through this seam instead of waiting for
 * real time; production timers are always `unref`'d so a pending retry can never
 * pin the process open.
 */

/** Run `fn` after `delayMs`; the returned function cancels it. */
export interface Scheduler {
  schedule(fn: () => void, delayMs: number): () => void;
}

/** Production scheduler: real timers, unref'd. */
export function systemScheduler(): Scheduler {
  return {
    schedule(fn, delayMs) {
      const timer = setTimeout(fn, delayMs);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
  };
}
