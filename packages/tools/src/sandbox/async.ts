/**
 * Small async helpers shared by the sandbox and the process registry: a bounded
 * poll plus the deadline entry points.
 *
 * W2014: this used to be the only place in the repo that raced a promise against a
 * timer. Eight call sites across six files had hand-rolled that race, each with its
 * own timer, its own cleanup and its own answer to "what happens when the deadline
 * wins" — and those answers genuinely differed (throw / sentinel / set a flag).
 * Eight copies meant eight chances to drift, and timeout drift is precisely the
 * kind that only shows up on a slow path.
 *
 * **The race now lives in `packages/core/src/deadline.ts`.** It had to move: the
 * MCP client (`packages/mcp`) needs a bounded transport teardown too, and L1 ↔ L1
 * imports are forbidden (ARCHITECTURE.md §1.3 D2) — so §1.4 outlet 1 ("lift the
 * contract into core") is the only legal home, and core is where a pure, zero
 * dependency primitive belongs.
 *
 * This module stays the TOOLS-FACING face: same exported names, same three
 * policies, same behaviour, now delegating the mechanism. Do not reintroduce a
 * race here — `tests/w2014-timeout-ratchet.test.ts` counts the token and allows
 * exactly one line in the whole product tree.
 */
import {
  TIMED_OUT,
  bounded as coreBounded,
  delay as coreDelay,
  idle as coreIdle,
  withTimeout as coreWithTimeout,
} from "@celestea/core";
import type { DeadlinePolicy, ResolvePolicy, SentinelPolicy, ThrowPolicy, TimeoutResult } from "@celestea/core";

/** The three deadline policies and the result union, re-exported for tools' call sites. */
export type { DeadlinePolicy, ResolvePolicy, SentinelPolicy, ThrowPolicy, TimeoutResult };

/** Sentinel resolved by the `sentinel` policy when the deadline won the race. */
export { TIMED_OUT } from "@celestea/core";

/**
 * Race `work` against ONE TOTAL deadline — the clock starts at this call.
 *
 * Use this when the budget belongs to the OPERATION ("this whole call gets 5s"),
 * including when a loop re-reads the remaining time each pass.
 *
 * The `mode: "sentinel"` default is spelled out here on purpose: the gate
 * `tests/w2014-timeout-ratchet.test.ts` asserts this file still carries the three
 * policies, so the delegation must stay visible rather than collapsing into a
 * blanket re-export.
 */
export function bounded<T, R>(work: Promise<T>, timeoutMs: number, policy: ResolvePolicy<R>): Promise<T | R>;
export function bounded<T>(work: Promise<T>, timeoutMs: number, policy: ThrowPolicy): Promise<T>;
export function bounded<T>(work: Promise<T>, timeoutMs: number, policy?: SentinelPolicy): Promise<TimeoutResult<T>>;
export function bounded<T, R>(work: Promise<T>, timeoutMs: number, policy?: DeadlinePolicy<R>): Promise<T | R | typeof TIMED_OUT> {
  const chosen: DeadlinePolicy<R> = policy ?? { mode: "sentinel" };
  // Narrowed on the discriminant so each policy reaches the primitive through the
  // matching overload — a bare union would erase that and defeat the point.
  if (chosen.mode === "throw") return coreBounded(work, timeoutMs, chosen);
  if (chosen.mode === "resolve") return coreBounded(work, timeoutMs, chosen);
  return coreBounded(work, timeoutMs, chosen);
}

/** [bounded] in sentinel mode — the shorthand the sentinel call sites read as. */
export function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<TimeoutResult<T>> {
  return coreWithTimeout(work, timeoutMs);
}

/**
 * Race `work` against ONE FRESH budget for THIS demand (the IDLE clock).
 *
 * Total and idle are two different questions, and the call sites prove it:
 * `runTurn` computes ONE deadline outside its loop and passes the REMAINING time
 * each pass (total), while `captureSseWire` hands every `reader.read()` the SAME
 * 300 ms and gives up only when the stream itself goes quiet (idle). Mechanically
 * both are one race against one timer — the difference is WHOSE clock it is, and
 * only the caller can own that.
 */
export function idle<T, R>(work: Promise<T>, idleMs: number, policy: ResolvePolicy<R>): Promise<T | R>;
export function idle<T>(work: Promise<T>, idleMs: number, policy: ThrowPolicy): Promise<T>;
export function idle<T>(work: Promise<T>, idleMs: number, policy?: SentinelPolicy): Promise<TimeoutResult<T>>;
export function idle<T, R>(work: Promise<T>, idleMs: number, policy?: DeadlinePolicy<R>): Promise<T | R | typeof TIMED_OUT> {
  const chosen: DeadlinePolicy<R> = policy ?? { mode: "sentinel" };
  if (chosen.mode === "throw") return coreIdle(work, idleMs, chosen);
  if (chosen.mode === "resolve") return coreIdle(work, idleMs, chosen);
  return coreIdle(work, idleMs, chosen);
}

export function delay(ms: number): Promise<void> {
  return coreDelay(ms);
}