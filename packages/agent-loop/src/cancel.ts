/**
 * Cooperative cancellation — the AbortSignal counterpart of the legacy loop's
 * `watch::Receiver<bool>` checkpoints (`cancel_set` / `wait_cancel`).
 *
 * The legacy loop awaited every interruptible step inside a `tokio::select!`
 * against a cancellation future; the TS port races the same checkpoints against
 * an [AbortSignal]. The differences are deliberate and documented in README.md:
 *   - the signal is owned by the CALLER (host HTTP route / CLI), not built by
 *     the loop, so one controller can abort a whole turn and be reused by the
 *     next one;
 *   - `raceAbort` never rejects: a rejected `work` is reported as
 *     `{ outcome: "failed" }`, so the loop can keep the five-state contract
 *     instead of leaking a seam exception;
 *   - abandoning in-flight work must not raise an unhandled rejection, so the
 *     loser of every race gets a no-op catch attached.
 */

/** W267: canonical error text of a synthesized ToolResult for a call that
 * never ran because the turn was cancelled mid-dispatch. Shared by the session
 * append and the emitted event so both sides carry the exact same string. */
export const CANCELLED_BEFORE_EXECUTION = "cancelled before execution";

/** W9225 (F-08): the honest counterpart of [CANCELLED_BEFORE_EXECUTION] for a
 * call that was ALREADY dispatched when the turn was cancelled. Tools are not
 * interruptible, so the in-flight batch keeps running after the loop stops
 * waiting for it: the log may not claim that call never ran. */
export const CANCELLED_EXECUTION_UNCERTAIN = "cancelled; execution may have completed";

/** Why an in-flight promise stopped being awaited. */
export type RaceResult<T> =
  | { outcome: "ok"; value: T }
  | { outcome: "aborted" }
  | { outcome: "failed"; error: unknown };

function ignore(): void {
  // Deliberate no-op: the loser of a race only needs its rejection consumed.
}

function settled<T>(work: Promise<T>): Promise<RaceResult<T>> {
  return work.then(
    (value): RaceResult<T> => ({ outcome: "ok", value }),
    (error: unknown): RaceResult<T> => ({ outcome: "failed", error }),
  );
}

/** True when cancellation was already signalled (a synchronous checkpoint). */
export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * Await `work`, but give up as soon as `signal` aborts. Re-checks the current
 * value first, so it is safe to call at every checkpoint of a turn.
 *
 * W9225 (F-07): the loser of the race used to have only its REJECTION consumed
 * (`void work.catch(ignore)`). A loser that RESOLVES carries a value the caller
 * has stopped waiting for — and when that value is an `LlmStream`, it owns an
 * HTTP response and a socket. Dropping it leaked both (measured: the response
 * stayed open until the process ended). `onAbandon` is the teardown hook for
 * exactly that case; it runs whether the value arrives before or after the
 * abort, and a throw from it can never surface (the turn is already terminal).
 */
export function raceAbort<T>(
  signal: AbortSignal | undefined,
  work: Promise<T>,
  onAbandon?: (value: T) => void,
): Promise<RaceResult<T>> {
  const abandon = (): void => {
    void work.then(
      (value) => {
        try {
          onAbandon?.(value);
        } catch {
          /* teardown is best-effort: the abandoned value is already unreachable */
        }
      },
      ignore,
    );
  };
  if (signal === undefined) return settled(work);
  if (signal.aborted) {
    abandon();
    return Promise.resolve({ outcome: "aborted" });
  }
  return new Promise<RaceResult<T>>((resolve) => {
    const onAbort = (): void => {
      abandon();
      resolve({ outcome: "aborted" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ outcome: "ok", value });
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ outcome: "failed", error });
      },
    );
  });
}

/**
 * The out-of-band teardown a stream MAY carry, without this module depending on
 * the LLM package. Structural on purpose: agent-loop is above llm in the
 * dependency graph, so naming llm's own type here would invert the arrow.
 */
interface Releasable {
  release?(): void;
}

/**
 * Force-release an abandoned stream's resources, THEN ask the iterator to close.
 *
 * B3-04: the two steps are not redundant. `release()` is the part that actually
 * frees a socket — it does not depend on the generator making progress, so it
 * works while the generator is parked on a `await` that never settles. `return()`
 * alone queues behind that await and its `finally` may never run. `return()` is
 * still issued, because for a well-behaved generator it is what runs the
 * generator's own cleanup, and for a stream with no `release()` it is all we have.
 */
export function closeIterator<T>(iter: AsyncIterator<T>): void {
  releaseIterator(iter);
  const close = iter.return;
  if (close === undefined) return;
  void Promise.resolve(close.call(iter)).catch(ignore);
}

/**
 * B3-04: the out-of-band half of [closeIterator], split out because it must be
 * callable BEFORE the generator has been started, and WITHOUT issuing a
 * `return()`.
 *
 * Issuing `return()` early is actively harmful in the pre-stream window: it
 * queues behind the `next()` already in flight, so a stream that resolves late
 * would have its teardown stranded behind its own pending read. (Measured: doing
 * both in one step turned the repo's own `cancel.test.ts` case "closes a stream
 * that resolves AFTER the abort fired" red.) Releasing first costs nothing and
 * cannot be queued, so the two steps are ordered: release now, close after.
 */
function releaseIterator<T>(iter: AsyncIterator<T>): void {
  const releasable = iter as AsyncIterator<T> & Releasable;
  if (typeof releasable.release !== "function") return;
  try {
    releasable.release();
  } catch {
    /* teardown is best-effort: the turn is already terminal */
  }
}

/**
 * W9225 (F-07): tear down a stream nobody will iterate.
 *
 * `closeIterator` alone is NOT enough for the pre-stream cancellation window:
 * `LlmStream` is an async GENERATOR, and `return()` on a generator that was
 * never started does not run its body's `finally` at all (measured on node
 * v26: `ranFinally === false`). The provider's `finally { response.destroy() }`
 * is therefore unreachable, and the response + socket stay open. Starting the
 * iterator first is what makes the close real; the first event is discarded
 * because the turn is already cancelled.
 *
 * B3-04: starting the iterator is NECESSARY BUT NOT SUFFICIENT. A generator that
 * has started and is then parked on an `await` never settles (a provider that
 * stalls with its idle guard disabled) still never runs that `finally`. That is
 * why [closeIterator] now forces a `release()` when the stream carries one.
 */
export function closeStream<T>(stream: AsyncIterable<T>): void {
  const iter = stream[Symbol.asyncIterator]();
  // B3-04: force the release FIRST, unconditionally and without issuing a
  // `return()`. This is the only step that frees a socket held by a provider
  // that never settles, and it cannot be queued behind the pending read below.
  releaseIterator(iter);
  // The W9225 behaviour, kept exactly: start the iterator, THEN close it, in
  // that order and in a later tick. `return()` on a never-started generator does
  // not run its `finally`, and `return()` issued while a `next()` is in flight
  // queues behind it. The first event is discarded: the turn is already cancelled.
  void Promise.resolve(iter.next()).then(
    () => closeIterator(iter),
    () => closeIterator(iter),
  );
}

/** The message of a thrown value, for seam errors that arrive as `unknown`. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
