/**
 * `SandboxChild` over a `node:child_process` child.
 *
 * The wrapper gives every sandbox provider the same handle shape (pid + three
 * streams + wait/terminate/kill), so the process registry never touches
 * provider internals. Signals target the whole **process group** when the child
 * was spawned detached — a shell that forked grandchildren must die with its
 * tree, not leave orphans behind.
 *
 * W9321: `terminate()`/`kill()` are **asynchronous** because the Windows
 * tree-kill is. See [taskkillTree] for why that stopped being a synchronous
 * call, and what a caller is expected to do about it.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { SandboxChild, SandboxExit } from "@celestea/core";

import { isWindows } from "../platform/paths.js";
import { delay } from "./async.js";

export interface WrapOptions {
  /** Child was spawned with `detached: true` (it leads its own process group). */
  detached: boolean;
}

export function wrapChild(child: ChildProcess, options: WrapOptions): SandboxChild {
  let settled: SandboxExit | null = null;
  let resolveWait: ((exit: SandboxExit) => void) | null = null;
  const waitPromise = new Promise<SandboxExit>((resolve) => {
    resolveWait = resolve;
  });
  const settle = (exit: SandboxExit): void => {
    if (settled !== null) return;
    settled = exit;
    resolveWait?.(exit);
  };
  // `close` (not `exit`) fires once the stdio pipes are drained, so a reader
  // that starts after `wait()` never loses buffered output.
  child.once("close", (code, signal) => settle({ code, signal }));
  child.once("error", (error) => settle({ code: null, signal: error.name }));
  return {
    pid: child.pid ?? null,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    wait: () => waitPromise,
    terminate: () => signalTree(child, options, "SIGTERM"),
    kill: () => signalTree(child, options, "SIGKILL"),
  };
}

/**
 * Best-effort signal of the child's whole process group (falls back to child).
 *
 * The POSIX half stays SYNCHRONOUS in effect: `process.kill(-pid)` is one
 * syscall, so the group signal and the direct-child fallback still happen in the
 * same tick they always did, and the returned promise is already settled. Only
 * Windows defers, because only Windows has to shell out (see [taskkillTree]).
 */
export function signalTree(child: ChildProcess, options: WrapOptions, signal: NodeJS.Signals): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || !options.detached) {
    signalChild(child, signal);
    return Promise.resolve();
  }
  if (isWindows()) return signalTreeWindows(child, pid, signal);
  if (signalProcessGroup(pid, signal)) return Promise.resolve();
  signalChild(child, signal);
  return Promise.resolve();
}

/** Windows half of [signalTree]: the async tree-kill, then the direct child. */
async function signalTreeWindows(child: ChildProcess, pid: number, signal: NodeJS.Signals): Promise<void> {
  if (await taskkillTree(pid)) return;
  signalChild(child, signal);
}

/** POSIX only: negative pid targets the whole group (the child leads it). */
function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false; // group already gone, or not ours to signal
  }
}

/**
 * W885 — Windows process-tree recycling, BEST EFFORT.
 *
 * Windows has no POSIX process group and Node's `child.kill()` signals only the
 * DIRECT child (W883 B10), so a `cmd.exe` that forked grandchildren would leak
 * them. `taskkill /T` walks the parent-child chain and is the only tool the OS
 * ships for this, but it is NOT an atomic boundary — standard Windows: a child
 * can re-parent or die between the walk and the kill (TOCTOU) — which is why the
 * real fix is a **Job Object** and is deferred to W885 slice 2 (Job Objects +
 * resource limits + the Windows sandbox provider).
 *
 * Slice-2 TODO: create the child inside a Job Object with
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` so the tree dies atomically with the
 * parent, instead of racing `taskkill`. The behaviour here is therefore
 * "best-effort", never a guarantee.
 *
 * W9321 — ASYNC, and that is the point of this slice.
 *
 * The retry loop used to call `execFileSync` up to 3 times with a 5s timeout
 * each plus a `sleepSync` backoff, and it was reached from the `abort` listener
 * ITSELF (`broker.ts`'s `killChildOnAbort`, `launch.ts`'s `onAbort`). So "user
 * pressed Stop" **blocked the event loop for up to ~15s**: every other session,
 * timer and stream in the process stalled behind one taskkill. The tree-kill
 * was never the problem — a 20-round probe measured it at 91-182ms with the
 * grandchild dead and `wait()` settled 20/20 — the SYNCHRONOUS WAIT was.
 *
 * So the mechanism is unchanged (same command, same bounded attempts, same
 * liveness verdict) and only the waiting became `await`. Callers that must not
 * block (`abort` listeners) fire-and-forget; callers that are already finishing
 * (timeout / settle paths) await. The API-level seam
 * `run / alive / sleep / attempts / delayMs` is deliberately intact.
 *
 * NOT verifiable on this host (Linux): the branch selection is unit-tested
 * (`child.test.ts` injects `platform`), the actual kill is not.
 */
export interface TaskkillOptions {
  /**
   * Injected runner (tests); defaults to an async `taskkill /PID … /T /F`.
   * A promise-returning runner is AWAITED to completion; the return value of a
   * synchronous one is ignored (the old shape, kept so no injection is lost).
   */
  run?: (pid: number) => void | Promise<void>;
  /** Injected liveness probe (tests); defaults to `process.kill(pid, 0)`. */
  alive?: (pid: number) => boolean;
  /** Injected backoff (tests); defaults to [delay] — an awaited timer. */
  sleep?: (ms: number) => void | Promise<void>;
  /** Total attempts. Defaults to 3 (first try + 2 retries). */
  attempts?: number;
  /** Base backoff; attempt i waits `delayMs * (i + 1)`. Defaults to 50ms. */
  delayMs?: number;
}

export async function taskkillTree(
  pid: number,
  platform: string = process.platform,
  options: TaskkillOptions = {},
): Promise<boolean> {
  if (!isWindows(platform)) return false;
  const run = options.run ?? defaultTaskkillRun;
  const alive = options.alive ?? defaultAlive;
  const sleep = options.sleep ?? delay;
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 50;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await run(pid);
    } catch (error) {
      // taskkill not installed at all: the MECHANISM is unavailable, which is a
      // different fact from "the process is gone". Return false so the caller
      // falls back to the direct child instead of believing the tree was reaped.
      if (isMissingTool(error)) return false;
      // Otherwise the tree was mid-change (access denied, already exiting):
      // fall through to the liveness verdict and retry.
    }
    if (!alive(pid)) return true;
    if (attempt < attempts - 1) await sleep(delayMs * (attempt + 1));
  }
  return !alive(pid);
}

/**
 * The real taskkill call (bounded; never let a timeout path stall).
 *
 * `spawn`, not `execFileSync`: that IS the W9321 fix. `stdio: "ignore"` and the
 * 5s cap are the synchronous version's, so a hung taskkill is still bounded
 * exactly as before — it just no longer freezes the whole process while it runs.
 * A non-zero exit and a missing binary both REJECT, which is what the loop above
 * already knows how to read (`ENOENT` = mechanism missing, anything else = fall
 * through to the liveness verdict), so no error classification changed.
 */
function defaultTaskkillRun(pid: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      // The async counterpart of `execFileSync`'s `timeout`: the process is
      // killed and this promise rejects, so a wedged taskkill can never turn an
      // abort into an unbounded wait.
      timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`taskkill exited with code ${String(code)}`));
    });
  });
}

/**
 * Is `pid` still running? `kill(pid, 0)` performs the existence check without
 * delivering a signal; EPERM means "exists, but not ours to signal" — still alive.
 *
 * Deliberately NOT made async: it is one syscall, and keeping it synchronous is
 * what lets the verdict be read straight after `await run(pid)`.
 */
function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** ENOENT from the runner means the tool itself is missing, not the process. */
function isMissingTool(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** taskkill is a local, bounded operation; never let it stall a timeout path. */
const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;

function signalChild(child: ChildProcess, signal: NodeJS.Signals): boolean {
  try {
    return child.kill(signal);
  } catch {
    return false; // already reaped
  }
}
