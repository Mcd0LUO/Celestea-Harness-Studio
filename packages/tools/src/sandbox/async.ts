/**
 * Small async helpers shared by the sandbox and the process registry: ONE
 * deadline primitive (three policies), its per-demand form, and a bounded poll.
 *
 * W2014: this module is the ONLY place in the repo that races a promise against
 * a timer. Eight call sites across six files used to hand-roll that race with
 * their own timer, their own cleanup and their own answer to "what happens when
 * the deadline wins" — and those answers genuinely differed. The primitive keeps
 * the difference EXPRESSIBLE (see [DeadlinePolicy]) instead of flattening it: a
 * caller that expects the [TIMED_OUT] sentinel and a caller that expects a THROW
 * must never be silently swapped for one another, because each one's control
 * flow is written around its own answer.
 *
 * The literal race token therefore appears ONCE in the whole product tree (in
 * [raceDeadline] below). That is what makes the count gate in
 * `tests/w2014-timeout-ratchet.test.ts` a meaningful number rather than a
 * coincidence, so do not reintroduce it anywhere else.
 */

/** Sentinel resolved by the `sentinel` policy when the deadline won the race. */
export const TIMED_OUT = Symbol("timed-out");

export type TimeoutResult<T> = T | typeof TIMED_OUT;

/** Deadline wins ⇒ resolve [TIMED_OUT]; the CALLER inspects the value. */
export interface SentinelPolicy {
  readonly mode: "sentinel";
}

/**
 * Deadline wins ⇒ reject with `error()`.
 *
 * `error` is a FACTORY, not an `Error`: the message is built the moment the
 * deadline actually fires, so it can name the operation and the budget that
 * elapsed. That is this repo's counterpart of the capability-owned `code` in
 * DSH's `@deepseek-ai/dsh-timeout` — it is what lets a caller tell ITS deadline
 * apart from a nested one whose rejection travelled through it.
 */
export interface ThrowPolicy {
  readonly mode: "throw";
  readonly error: () => Error;
}

/**
 * Deadline wins ⇒ resolve with `value()`, whose side effects do the bookkeeping.
 *
 * Parameterised on the value it produces, because the race result is the UNION of
 * the two: a deadline resolving `null` makes the caller's result nullable, which
 * is exactly the contract the hand-rolled races had (and what lets `frame === null`
 * mean "no frame in time" rather than "a frame that happens to be null").
 */
export interface ResolvePolicy<R> {
  readonly mode: "resolve";
  readonly value: () => R;
}

/**
 * What a deadline does when it wins — exactly the three answers the call sites use.
 *
 * `resolve` is not a catch-all: it is the shape for callers that treat the deadline
 * as a NORMAL outcome and do their own work (set a flag, kill a child, write a log
 * line, report "no frame yet"). Nothing is thrown and nothing is inspected.
 */
export type DeadlinePolicy<R> = SentinelPolicy | ThrowPolicy | ResolvePolicy<R>;

/**
 * The ONE race. Both entry points below are thin, differently-typed faces of it.
 *
 * The timer is ALWAYS cleared, so a settled `work` never leaves a handle behind
 * that would keep the process alive. `work` gets its rejection handler attached in
 * this tick — exactly as the built-in race does — so a rejection that lands after
 * the deadline already won is swallowed instead of surfacing as an unhandled
 * rejection.
 */
function raceDeadline<T, R>(
  work: Promise<T>,
  timeoutMs: number,
  policy: DeadlinePolicy<R>,
): Promise<T | R | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<T | R | typeof TIMED_OUT>((resolve, reject) => {
    timer = setTimeout(() => {
      if (policy.mode === "throw") reject(policy.error());
      else if (policy.mode === "resolve") resolve(policy.value());
      else resolve(TIMED_OUT);
    }, timeoutMs);
  });
  return Promise.race([work, expired]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Race `work` against ONE TOTAL deadline — the clock starts at this call.
 *
 * Use this when the budget belongs to the OPERATION ("this whole call gets 5s"),
 * including when a loop re-reads the remaining time each pass.
 */
export function bounded<T, R>(work: Promise<T>, timeoutMs: number, policy: ResolvePolicy<R>): Promise<T | R>;
export function bounded<T>(work: Promise<T>, timeoutMs: number, policy: ThrowPolicy): Promise<T>;
export function bounded<T>(work: Promise<T>, timeoutMs: number, policy?: SentinelPolicy): Promise<TimeoutResult<T>>;
export function bounded<T, R>(
  work: Promise<T>,
  timeoutMs: number,
  policy: DeadlinePolicy<R> = { mode: "sentinel" },
): Promise<T | R | typeof TIMED_OUT> {
  return raceDeadline(work, timeoutMs, policy);
}

/** [bounded] in sentinel mode — the shorthand the sentinel call sites read as. */
export function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<TimeoutResult<T>> {
  return bounded(work, timeoutMs);
}

/**
 * Race `work` against ONE FRESH budget for THIS demand (the IDLE clock).
 *
 * Total and idle are two different questions, and the call sites prove it:
 * `runTurn` computes ONE deadline outside its loop and passes the REMAINING time
 * each pass (total), while `captureSseWire` hands every `reader.read()` the SAME
 * 300 ms and gives up only when the stream itself goes quiet (idle). Mechanically
 * both are one race against one timer — the difference is WHOSE clock it is, and
 * only the caller can own that. Sharing [raceDeadline] keeps one implementation
 * while this name keeps the intent auditable at the call site.
 */
export function idle<T, R>(work: Promise<T>, idleMs: number, policy: ResolvePolicy<R>): Promise<T | R>;
export function idle<T>(work: Promise<T>, idleMs: number, policy: ThrowPolicy): Promise<T>;
export function idle<T>(work: Promise<T>, idleMs: number, policy?: SentinelPolicy): Promise<TimeoutResult<T>>;
export function idle<T, R>(
  work: Promise<T>,
  idleMs: number,
  policy: DeadlinePolicy<R> = { mode: "sentinel" },
): Promise<T | R | typeof TIMED_OUT> {
  return raceDeadline(work, idleMs, policy);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
