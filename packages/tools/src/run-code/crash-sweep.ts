/**
 * B4-04 P2 -- the startup sweep for crash residue.
 *
 * Two writers leave temporary files that a CRASH can strand, because a crash
 * runs no finally:
 *
 *   - attachments/store.ts writes <id>.<ext>.tmp-<pid>-<ts> then renames it
 *     into place. A rename failure unlinks the tmp, but a hard kill does not.
 *   - run-code/broker.ts writes run_code_<pid>_<n>.{mts,py} -- the whole
 *     assembled program, source included -- and removes it in a finally. A
 *     hard kill leaves the program on disk under the user data root.
 *
 * Both accumulate monotonically with every crash, and the run-code directory
 * holds program SOURCE, which may embed credentials.
 *
 * ## What makes this safe to run at boot
 *
 * The rules below are the whole safety argument, and each is a rule a future
 * edit could violate, so each is stated as a test:
 *
 *   1. WHITELIST shapes only. A file is a candidate only if its name matches
 *     the exact shape its writer produces, so a user file in the same
 *     directory is never touched.
 *   2. The writer own pid is never a candidate. A run_code_<pid>_ file is
 *     deleted ONLY when the embedded pid is not this process. That is what
 *     makes the sweep safe to run from INSIDE a live process, and why a
 *     concurrent run_code cannot lose its program.
 *   3. An mtime older than the grace window. A file younger than minAgeMs is
 *     left alone: a just-written tmp belongs to a rename still in flight, and
 *     deleting it would turn a residue sweep into a data-loss bug.
 *   4. Bounded and best-effort. A cap on entries examined, and no throw on a
 *     single unreadable entry: a sweep must never fail a boot.
 *
 * Idempotent by construction: deleting an already-deleted file is a no-op, and
 * a second sweep finds nothing to do.
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** attachments/store.ts temp shape: <id>.<ext>.tmp-<pid>-<ms>. */
export const ATTACHMENT_TMP_PATTERN = /\.tmp-\d+\-\d+$/;
/** run-code/broker.ts program shape: run_code_<pid>_<n>.{mts,py}. */
export const RUN_CODE_PROGRAM_PATTERN = /^run_code_(\d+)_\d+\.(?:mts|py)$/;
/** Entry cap: a sweep examines at most this many names per directory. */
export const SWEEP_MAX_ENTRIES = 2_000;
/** Default grace: a file must be at least this old to count as residue. */
export const SWEEP_MIN_AGE_MS = 60 * 60 * 1000;

/** What one sweep found and did. The boot log and the tests both read it. */
export interface SweepReport {
  /** Directories the sweep actually looked at. */
  scanned: number;
  /** Residue files removed, keyed by directory (for the boot line). */
  removed: Record<string, number>;
  /** Files seen but deliberately LEFT alone (too young, or our own pid). */
  skipped: number;
  /** Non-fatal failures (unreadable dir, undeletable file). Never throws. */
  errors: number;
}

/** One directory to sweep. */
export interface SweepTarget {
  /** Directory holding the residue. Empty = skipped entirely. */
  dir: string;
  /** Which writer files this directory holds. */
  kind: "attachments" | "run-code";
}

/** Injectable clock/filesystem seam; every field defaults to the real one. */
export interface SweepDeps {
  now?: () => number;
  readDir?: (dir: string) => Promise<string[]>;
  remove?: (path: string) => Promise<void>;
  mtime?: (path: string) => Promise<number>;
  /** The live pid; a program file carrying it is never swept. */
  pid?: number;
  /** Grace window (default SWEEP_MIN_AGE_MS). */
  minAgeMs?: number;
  /** Entry cap (default SWEEP_MAX_ENTRIES). */
  maxEntries?: number;
}

/** The fully-defaulted dependency bundle (computed once per sweep). */
interface ResolvedDeps {
  now: () => number;
  readDir: (dir: string) => Promise<string[]>;
  remove: (path: string) => Promise<void>;
  mtime: (path: string) => Promise<number>;
  pid: number;
  minAgeMs: number;
  maxEntries: number;
}

/**
 * Is this name residue WE may delete, and is it old enough?
 *
 * Split out so the policy is unit-testable without touching a filesystem, and
 * so rules 1 (whitelist), 2 (own pid) and 3 (mtime) are each one readable line
 * rather than three conditions buried in a loop.
 */
export function isSweepable(
  name: string,
  kind: SweepTarget["kind"],
  options: { mtimeMs: number; nowMs: number; minAgeMs: number; livePid: number },
): boolean {
  if (kind === "attachments") {
    if (!ATTACHMENT_TMP_PATTERN.test(name)) return false;
    return options.nowMs - options.mtimeMs >= options.minAgeMs;
  }
  const program = RUN_CODE_PROGRAM_PATTERN.exec(name);
  if (program === null) return false;
  // Rule 2: never delete a program this process is still using.
  if (Number(program[1]) === options.livePid) return false;
  return options.nowMs - options.mtimeMs >= options.minAgeMs;
}

/** Sweep one directory. Never throws: a residue sweep must not fail a boot. */
async function sweepOne(target: SweepTarget, deps: ResolvedDeps, report: SweepReport): Promise<void> {
  let names: string[];
  try {
    names = await deps.readDir(target.dir);
  } catch {
    // A missing or unreadable directory is the NORMAL case for a workspace that
    // never ran a tool; it is not an error worth reporting.
    return;
  }
  report.scanned += 1;
  const nowMs = deps.now();
  for (const name of names.slice(0, deps.maxEntries)) {
    const path = join(target.dir, name);
    let mtimeMs: number;
    try {
      mtimeMs = await deps.mtime(path);
    } catch {
      report.errors += 1;
      continue;
    }
    if (!isSweepable(name, target.kind, { mtimeMs, nowMs, minAgeMs: deps.minAgeMs, livePid: deps.pid })) {
      report.skipped += 1;
      continue;
    }
    try {
      await deps.remove(path);
      report.removed[target.dir] = (report.removed[target.dir] ?? 0) + 1;
    } catch {
      // In use by another process, or read-only: leave it for the next boot.
      report.errors += 1;
    }
  }
}

/**
 * The boot sweep. Idempotent, bounded, best-effort, never throws.
 *
 * The HOST calls this at startup (that call site is apps/studio s, not this
 * package s); everything deciding WHAT gets deleted lives here, in the package
 * that WRITES those files, so the writer and the sweeper cannot drift apart
 * into two different file-name grammars.
 */
export async function sweepCrashResidue(targets: readonly SweepTarget[], deps: SweepDeps = {}): Promise<SweepReport> {
  const resolved: ResolvedDeps = {
    now: deps.now ?? Date.now,
    readDir: deps.readDir ?? ((dir: string) => readdir(dir)),
    remove: deps.remove ?? ((path: string) => rm(path, { force: true }).then(() => undefined)),
    mtime: deps.mtime ?? ((path: string) => stat(path).then((s) => s.mtimeMs)),
    pid: deps.pid ?? process.pid,
    minAgeMs: deps.minAgeMs ?? SWEEP_MIN_AGE_MS,
    maxEntries: deps.maxEntries ?? SWEEP_MAX_ENTRIES,
  };
  const report: SweepReport = { scanned: 0, removed: {}, skipped: 0, errors: 0 };
  for (const target of targets) {
    if (target.dir === "") continue;
    await sweepOne(target, resolved, report);
  }
  return report;
}

/** One human line for the boot log, or null when there was nothing to say. */
export function sweepSummaryLine(report: SweepReport): string | null {
  const removed = Object.values(report.removed).reduce((a, b) => a + b, 0);
  if (removed === 0 && report.errors === 0) return null;
  let line = "crash residue: " + String(removed) + " file(s) in " + String(report.scanned) + " dir(s)";
  if (report.errors > 0) {
    line += ", " + String(report.errors) + " error(s) (left for the next boot)";
  }
  return "[" + line + "]";
}
