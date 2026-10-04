/**
 * W1528 — real-PTY plumbing for the workbench terminal.
 *
 * ## Why a `script(1)` shim and not a native PTY
 *
 * Node has no PTY API. The alternatives were a native addon (node-pty: a
 * compiled dependency, a rebuild per Node ABI, and a supply-chain surface this
 * repo does not take lightly) or an EXISTING setuid-free binary that already
 * allocates a pty. `util-linux`'s `script(1)` is the second: it opens
 * `/dev/ptmx`, forks the command onto the slave side, and relays the master to
 * its own stdio.
 *
 * ## The sandbox is NOT bypassed
 *
 * The command string built here is handed to the SAME `Sandbox.spawn()` the
 * engine's `run_shell background:true` uses, under the SAME permission gate
 * (`shellDeniedReason`) and the SAME provider selection (`sandboxFor`), so the
 * pty lives INSIDE bwrap. Verified live: `bwrap … -- /usr/bin/script -qfc …`
 * prints a prompt and `tty` answers `/dev/pts/0` (a pty inside the namespace,
 * not the host's).
 *
 * ## What this module deliberately does NOT do
 *
 * - **No shell of its own.** There is no `spawn` call here; the only process
 *   this file can start is the one `sandbox.spawn` starts.
 * - **No resize.** `script(1)` owns the pty MASTER; the host holds pipes to
 *   script's stdio and cannot issue `TIOCSWINSZ`. The size is therefore fixed
 *   when the terminal opens, and the command sets it once via `stty`. A resize
 *   is a re-open — the UI does exactly that, and says so.
 * - **No silent platform fallback.** A host without `script(1)` (Windows) gets a
 *   structured refusal, never a bare shell pretending to be a terminal.
 * - **B4-01: an idle pty is not a keeper.** `idleSince` existed with zero
 *   callers, so a browser that vanished left its detached process group running
 *   until the machine rebooted. `startTerminalReaper` is that missing caller and
 *   `terminateAll` is the shutdown half; see both below.
 */

import { randomUUID } from "node:crypto";
import type { SandboxChild } from "@celestea/core";
import { bounded, resolveShellKind, shellQuote, whichSync } from "@celestea/tools";

/** Structured refusal codes (mirrors the `shell_denied` convention in exec.ts). */
export const TERMINAL_UNAVAILABLE_CODE = "terminal_unavailable";
export const TERMINAL_LIMIT_CODE = "terminal_limit";
export const TERMINAL_GONE_CODE = "terminal_gone";

/** Concurrent pty ceiling per studio process (each one is a real process tree). */
export const MAX_TERMINALS = 8;
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
/** Bounds for the client-supplied geometry (`stty` rejects nonsense sizes). */
export const MIN_DIM = 20;
export const MAX_DIM = 500;

/** Clamp a client-supplied geometry into the range `stty` can carry. */
export function clampDim(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(MIN_DIM, Math.min(MAX_DIM, Math.round(value)));
}

export interface PtySupport {
  /** Absolute path of `script(1)`. */
  script: string;
  /** Absolute path of the interactive shell `script` will exec. */
  shell: string;
}

/**
 * Can this host carry a pty at all?
 *
 * Fail-closed on purpose: an absent `script(1)` is answered with a reason, and
 * the caller turns that into a structured 501 — it must never degrade into
 * running the user's keystrokes through a non-tty pipe (which would look like a
 * terminal and behave like one-shot execution, the exact lie W1528 removes).
 */
export function ptySupport(env: NodeJS.ProcessEnv = process.env): PtySupport | { reason: string } {
  if (process.platform === "win32") {
    return { reason: "a real pty needs util-linux script(1), which this platform does not provide" };
  }
  const script = whichSync("script", env);
  if (script === null) {
    return { reason: "util-linux script(1) was not found on PATH (install util-linux to enable the terminal)" };
  }
  // bash gives a proper prompt with cwd; /bin/sh is the guaranteed fallback.
  const shell = whichSync("bash", env) ?? resolveShellKind({ env }).path;
  return { script, shell };
}

/**
 * The command line the sandbox runs: `script` allocates the pty and execs an
 * interactive shell on the slave side, with the geometry the client asked for.
 *
 * `-e` makes script exit with the CHILD's status, so the UI can report the real
 * exit code instead of script's own. `stty` is best-effort (`2>/dev/null`);
 * a host without it still gets a working pty at the default size.
 */
export function ptyCommand(support: PtySupport, cols: number, rows: number): string {
  const inner = `stty cols ${String(cols)} rows ${String(rows)} 2>/dev/null; exec ${shellQuote(support.shell)} -i`;
  return `TERM=xterm-256color exec ${shellQuote(support.script)} -q -e -f -c ${shellQuote(inner)} /dev/null`;
}

/** One live pty plus the bookkeeping the reaper and the routes need. */
export interface TerminalEntry {
  readonly id: string;
  /** Routing key of the SSE frames (`null` = the detached scope). */
  readonly session: string | null;
  readonly child: SandboxChild;
  readonly cols: number;
  readonly rows: number;
  /** Bytes relayed so far (observability; never a cap — the bus is the cap). */
  bytes: number;
  /** Epoch ms of the last byte in EITHER direction (idle reaping). */
  touchedAt: number;
  closed: boolean;
}

/**
 * The per-app pty table.
 *
 * Deliberately an INSTANCE (not a module singleton): one studio process hosts
 * one table, but a test process hosts several apps, and a shared singleton would
 * let one harness close another harness's terminal.
 */
export class TerminalRegistry {
  private readonly entries = new Map<string, TerminalEntry>();
  /** Fired whenever the table crosses 0 <-> non-zero (the reaper's arm trigger). */
  private occupancy: Array<(live: boolean) => void> = [];

  constructor(private readonly limit: number = MAX_TERMINALS) {}

  /** Observe "the table became non-empty / became empty" (B4-01: arm-on-demand). */
  onOccupancy(fn: (live: boolean) => void): void {
    this.occupancy.push(fn);
  }

  /** Register a freshly spawned child; `null` when the ceiling is reached. */
  add(child: SandboxChild, session: string | null, cols: number, rows: number): TerminalEntry | null {
    if (this.entries.size >= this.limit) return null;
    const entry: TerminalEntry = {
      id: "term-" + randomUUID(),
      session,
      child,
      cols,
      rows,
      bytes: 0,
      touchedAt: Date.now(),
      closed: false,
    };
    this.entries.set(entry.id, entry);
    if (this.entries.size === 1) this.occupancy.forEach((fn) => fn(true));
    return entry;
  }

  get(id: string): TerminalEntry | undefined {
    return this.entries.get(id);
  }

  /** Forget an entry (the child is already gone or has been signalled). */
  drop(id: string): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    entry.closed = true;
    this.entries.delete(id);
    if (this.entries.size === 0) this.occupancy.forEach((fn) => fn(false));
  }

  /** Every live entry (the reaper and the shutdown path iterate this). */
  all(): TerminalEntry[] {
    return [...this.entries.values()];
  }

  size(): number {
    return this.entries.size;
  }

  /** Ids idle for longer than `idleMs` (the anti-leak backstop). */
  idleSince(idleMs: number, now: number = Date.now()): TerminalEntry[] {
    return this.all().filter((e) => now - e.touchedAt > idleMs);
  }

  /**
   * B4-01 P0: signal EVERY live entry's process group and forget it.
   *
   * The shutdown half of the anti-leak contract. A pty is spawned detached (it
   * LEADS its own group), so nothing in the parent's exit takes it down -- which
   * is what made the missing wiring an ORPHAN rather than a cosmetic leak. Each
   * tree gets graceMs to answer SIGTERM before the SIGKILL escalation, and
   * entries are dropped WHETHER or not the child answered, so a wedged shell
   * cannot hold the teardown budget open. Never rejects.
   */
  async terminateAll(graceMs: number = TERMINATE_GRACE_MS): Promise<number> {
    const entries = this.all();
    await Promise.all(
      entries.map((entry) =>
        terminateTree(entry, graceMs).catch(() => {
          /* one wedged tree must not strand the others */
        }),
      ),
    );
    for (const entry of entries) this.drop(entry.id);
    return entries.length;
  }
}

/** Default idle ceiling: a pty with no traffic for this long is reaped. */
export const TERMINAL_IDLE_MS = 30 * 60 * 1000;

/** How often the idle reaper sweeps (the ceiling itself is TERMINAL_IDLE_MS). */
export const TERMINAL_REAPER_MS = 60 * 1000;

/** How one idle sweep ended; the seam the tests and the host log both read. */
export interface ReaperReport {
  swept: number; // entries left in the table after the pass
  reaped: number; // entries the ceiling killed this pass
}

/** The reaper handle: a manual sweep, the armed flag, and a disarm. */
export interface TerminalReaper {
  /** One pass; exposed so a test can drive it without waiting on a timer. */
  sweep: () => ReaperReport;
  armed: () => boolean; // is the sweep timer armed?
  stop: () => void; // disarm (idempotent; safe twice)
}

/** Knobs the reaper takes; every one is pinned by the B4-01 test. */
export interface TerminalReaperOptions {
  idleMs?: number; // idle ceiling (default TERMINAL_IDLE_MS)
  periodMs?: number; // sweep period (default TERMINAL_REAPER_MS)
  now?: () => number; // clock; must match the one add() stamped with
  onReaped?: (report: ReaperReport) => void; // host log, only when something died
}

/**
 * B4-01 P0: the idle reaper that finally CALLS idleSince.
 *
 * An unref'd interval that reaps whatever outlived the ceiling, ARMED ON DEMAND
 * (first pty in, last pty out): a sweep over an EMPTY table can never reap
 * anything, so a timer running then is pure waste -- and waste outlives the app.
 */
export function startTerminalReaper(registry: TerminalRegistry, options: TerminalReaperOptions = {}): TerminalReaper {
  const idleMs = options.idleMs ?? TERMINAL_IDLE_MS;
  const now = options.now ?? Date.now;
  let timer: ReturnType<typeof setInterval> | null = null;

  const sweep = (): ReaperReport => {
    const stale = registry.idleSince(idleMs, now());
    for (const entry of stale) {
      registry.drop(entry.id);
      void terminateTree(entry).catch(() => undefined);
    }
    const report: ReaperReport = { swept: registry.size(), reaped: stale.length };
    if (stale.length > 0) options.onReaped?.(report);
    return report;
  };

  const arm = (): void => {
    if (timer !== null || idleMs <= 0) return;
    timer = setInterval(sweep, options.periodMs ?? TERMINAL_REAPER_MS);
    timer.unref?.();
    armedReapers.add(reaper);
  };
  const reaper: TerminalReaper = {
    sweep,
    armed: () => timer !== null,
    stop: () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
      armedReapers.delete(reaper); // the set must drain, or it is its own leak
    },
  };

  // B4-01: arm ON DEMAND, not at composition. A sweep over an EMPTY table can
  // never reap anything, so a timer running before the first pty is pure waste
  // -- and a waste that outlives the app (the teardown that stops it may never
  // run). The first pty arms it; the last one leaving disarms it. Same coverage,
  // zero idle wakeups, and a table that was never used arms nothing at all.
  registry.onOccupancy((live) => {
    if (live) arm();
    else reaper.stop();
  });
  if (registry.size() > 0) arm();
  return reaper;
}

/**
 * Every reaper this module armed, so a host teardown can stop all of them. A Set,
 * not a WeakSet: stopping requires ITERATION. Entries leave as their reaper stops.
 */
const armedReapers = new Set<TerminalReaper>();

/**
 * Disarm EVERY armed reaper (idempotent; never throws). Stopping an already-
 * stopped reaper is a no-op, so a double teardown is safe.
 */
export function stopAllTerminalReapers(): void {
  for (const reaper of [...armedReapers]) {
    try {
      reaper.stop();
    } catch {
      /* one uncooperative reaper must not strand the rest */
    }
  }
}

/** Env knob: the idle ceiling, so a host can tighten (or disable) the backstop. */
export const ENV_TERMINAL_IDLE_MS = "CELESTEA_TERMINAL_IDLE_MS";

/**
 * The effective idle ceiling: the env knob overrides the default, and 0 (or a
 * negative) DISABLES the sweep. Unparsable input falls back to the default
 * rather than disabling.
 */
export function terminalIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[ENV_TERMINAL_IDLE_MS] ?? "").trim();
  if (raw === "") return TERMINAL_IDLE_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : TERMINAL_IDLE_MS;
}

/** One app's pty table plus the reaper that guards it. */
export interface TerminalTable {
  registry: TerminalRegistry;
  reaper: TerminalReaper;
  /** Terminate every live pty and disarm the sweep (idempotent). */
  shutdown: () => Promise<number>;
}

/**
 * B4-01 P0: build ONE app's pty table with its idle reaper already armed.
 *
 * registerTerminal used to build the table as a bare closure local, which is
 * precisely why nothing outside the three routes could reach it.
 */
export function createTerminalTable(
  options: TerminalReaperOptions & { limit?: number; env?: NodeJS.ProcessEnv } = {},
): TerminalTable {
  const registry = new TerminalRegistry(options.limit);
  const idleMs = options.idleMs ?? terminalIdleMs(options.env);
  const reaper = startTerminalReaper(registry, { ...options, idleMs });
  return {
    registry,
    reaper,
    shutdown: async (): Promise<number> => {
      reaper.stop();
      return registry.terminateAll();
    },
  };
}

/**
 * B4-01 P0: the per-app table book, so a host can reach a table it never built.
 *
 * The routes are registered by handlers/index.ts, which this fix does not touch,
 * so the table cannot be threaded through that call chain. NOT the module-
 * singleton the class doc forbids: each app registers ITS OWN table under ITS
 * OWN key, and releaseTerminalTable removes it, so harnesses stay isolated.
 */
const tables = new Map<string, TerminalTable>();

/** Publish this app's table under `owner` (a later call replaces the earlier one). */
export function registerTerminalTable(owner: string, table: TerminalTable): void {
  tables.set(owner, table);
}

/** The table an app registered, if it is still live. */
export function terminalTableOf(owner: string): TerminalTable | undefined {
  return tables.get(owner);
}

/**
 * Drain and forget an app's table. Idempotent, and safe for an owner that
 * never registered: the second call is a no-op, which matters because a
 * shutdown path may run twice (W2029: the repeat SIGTERM only reports).
 */
export async function releaseTerminalTable(owner: string): Promise<number> {
  const table = tables.get(owner);
  if (table === undefined) return 0;
  tables.delete(owner);
  return table.shutdown();
}

/**
 * Grace allowed for a SIGTERM'd pty tree to be reaped before SIGKILL is sent.
 * Mirrors `launch.ts`'s REAP_GRACE_MS: the same 5s budget the timeout path uses.
 */
export const TERMINATE_GRACE_MS = 5_000;

/**
 * Terminate a pty tree, gracefully first and **bounded**.
 *
 * `script` and the shell it execs share ONE process group (the sandbox spawns
 * detached), so the group signal reaches every descendant — a `python3` REPL or
 * a `top` started inside the terminal dies with it.
 *
 * W1528 fix: SIGTERM first (so the shell can run its exit trap), then **escalate
 * to SIGKILL on a deadline**. The earlier version awaited `wait()` with no
 * deadline while its own comment claimed "the caller escalates to SIGKILL" — but
 * no caller did. A shell that ignores SIGTERM (or a `script` that will not
 * release its pty) therefore hung the close request **forever**: the handler
 * never returned, the id was never dropped, and the panel could not be reopened
 * (observed as a 30s test timeout under load). Escalation is what makes the
 * function's contract true; `launch.ts:108-109` is the same two-step pattern.
 *
 * W9220: graceMs is an OPTIONAL parameter (default unchanged) purely so the
 * W1528b fake child -- SIGTERM ignored, settles only on SIGKILL -- need not really
 * wait 5 s. It proves "bounded + escalates", not "must wait the full 5 s".
 */

export function terminateTree(entry: TerminalEntry, graceMs: number = TERMINATE_GRACE_MS): Promise<void> {
  entry.closed = true;
  // W9321: fire-and-forget, deliberately. `terminate()` is now async (on Windows
  // it runs `taskkill`), but the W1528 invariant below is that this function is
  // BOUNDED by `graceMs` — awaiting the signal would make the bound depend on the
  // signal implementation resolving, which is exactly the class of hang W1528b
  // guards against. The kill is issued in this tick; `reapBounded` stays the only
  // thing that decides when to stop waiting.
  void entry.child.terminate();
  return reapBounded(entry, graceMs);
}

/** Wait for the child, SIGKILL the tree if it outlives the grace, wait again. */
async function reapBounded(entry: TerminalEntry, graceMs: number): Promise<void> {
  if (await settlesWithin(entry.child.wait(), graceMs)) return;
  // W9321: the escalation is awaited — the second `wait()` below is exit
  // evidence, so it must not be consulted before the SIGKILL was asked for.
  await entry.child.kill();
  await settlesWithin(entry.child.wait(), graceMs);
}

/**
 * Race `promise` against a deadline; `true` when it settled in time.
 *
 * W2014: the race is now the shared deadline primitive. The `settled` mapping above
 * stays local because it is THIS function's contract (a rejected wait counts as
 * settled, so a dead child is never SIGKILLed twice) — the primitive supplies the
 * clock, not the meaning of "settled". Its timer is always cleared, so an
 * already-settled child never leaves a stray handle behind.
 */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  // A REJECTION is also "it settled": the child is gone either way, and the
  // SIGKILL escalation must not fire for a wait that already finished.
  const settled = promise.then(
    () => true,
    () => true,
  );
  return bounded(settled, ms, { mode: "resolve", value: () => false });
}
