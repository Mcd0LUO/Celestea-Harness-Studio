/**
 * Boot observation of a `registry.tsv` table (iteration E §2.2.4).
 *
 * WHY this exists: the studio used to keep its worker table in memory only, so
 * after a restart a RUNNING row simply did not exist any more — and with a
 * PERSISTED table the opposite failure appears: rows of a dead process would
 * read as live forever. This module is the judgement that tells those apart,
 * from evidence only:
 *
 *   - `lease=<pid>@<unix>` — is the owning process still alive? (`pidAlive`);
 *   - the deliverable (`results/<wid>*.md`, `hasDeliverable`) — did the worker
 *     already produce the thing it was asked for?
 *   - `host=<sid>` — does the host session that dispatched it still exist?
 *
 * P0 IS OBSERVATION ONLY (this is the whole point of the phase split): the
 * decision table's actions (auto-close, re-dispatch, FAILED) belong to P2 behind
 * `CELESTEA_WORKER_RECOVER=1`. Nothing here writes, settles or re-dispatches a
 * row — it returns a report, the caller writes one audit line and shows it in
 * `GET /api/worker/status` (`stale[]` / `orphans[]`).
 *
 * The judgement NEVER throws: an unreadable table, a malformed lease or a dead
 * pid all degrade to "unknown", and `unknown` is never a reason to act.
 *
 * W1470: the ACTIONS the decision table describes are implemented in
 * `recover-apply.ts` behind `CELESTEA_WORKER_RECOVER=1`. Nothing in THIS module
 * changed: it is still pure, still read-only, and still the only judge.
 */

import type { WorkerEntry } from "@celestea/core";
import { getExtra, workerAttempt, workerHost, workerLease, workerProc, workerRetries, type WorkerLease } from "./registry-tsv.js";

/** Why a RUNNING row is considered left behind (P0: reported, never acted on). */
export type WorkerRecoveryReason = "stale_lease" | "stale_lease_expired" | "orphan_host";

/**
 * W9224 P1-7 — how long a `lease=` stamp is evidence of life.
 *
 * THE BUG: liveness was decided by `pidAlive(lease.pid)` ALONE, so the two
 * failures the lease exists to catch both read as "alive":
 *   - PID RECYCLING: the OS handed the number to an unrelated process, so a row
 *     whose owner died months ago is judged live forever and never converges;
 *   - A STOPPED HEARTBEAT: `setWorkerState` only renews `lease=` when the driver
 *     changes state, so a hung owner keeps an old stamp while still holding the
 *     pid.
 *
 * The rule is deliberately NARROW, because a TTL is only sound for a row that
 * promised a heartbeat:
 *   - `driven=yes` means a driver task exists and renews the lease (the driver's
 *     state changes, plus `WorkerRegistry`'s own heartbeat while that task is
 *     alive), so a stamp older than the TTL is real evidence the owner stopped;
 *   - a row with NO `lease=` token keeps the historical `proc=`-only rule (see
 *     [workerOwner]) — it has no timestamp, and inventing one would declare every
 *     pre-W787 row stale on the spot;
 *   - a row that was never driven (`driven=no`) has no renewal path at all, so
 *     its one-shot stamp says nothing about life: pid-only stays the rule.
 * Without that last exemption the TTL would FALSELY converge a live host's
 * non-driven row — a worse failure than the one this fixes.
 *
 * Ten minutes is ~20 missed heartbeats ([DRIVER_HEARTBEAT_MS] = 30 s): far above
 * any scheduling hiccup, far below the days-old stamps a crashed process leaves.
 */
export const WORKER_LEASE_TTL_MS = 10 * 60 * 1000;

/** What the P2 decision table WOULD do (declared so the report is forward-compatible). */
export type WorkerRecoveryAction = "close_done" | "respawn" | "fail" | "observe";

/** One RUNNING row that needs attention, with the evidence that says so. */
export interface WorkerRecoveryCandidate {
  wid: string;
  status: string;
  /**
   * Which try this row is (`attempt=`; 0 when the token is absent — see
   * contracts/data-files/registry-tsv.schema.json).
   */
  attempt: number;
  /** The host session that dispatched it (`host=`; null on a legacy row). */
  host_session: string | null;
  /** The worker conversation of the row (`sess=`), for diagnostics. */
  sess: string | null;
  reason: WorkerRecoveryReason;
  /** `lease=` evidence: null when the row carries no lease at all. */
  lease_pid: number | null;
  lease_at: number | null;
  /** `retries=` (the watchdog's counter) at observation time. */
  retries: number;
  /** Does a deliverable (`results/<wid>*.md`) exist? (R2-4: any attempt counts.) */
  artifact: boolean;
  /** What P2 would do — P0 only reports it. */
  action: WorkerRecoveryAction;
}

export interface WorkerRecoveryReport {
  observed_at: number;
  /** Rows judged to be left behind by a dead process (P2 would act on them). */
  stale: WorkerRecoveryCandidate[];
  /** RUNNING rows whose `host=` session no longer exists (§2.2.4 row 6). */
  orphans: WorkerRecoveryCandidate[];
  /** wid of every RUNNING row whose owner is alive — nothing to do. */
  live: string[];
  /** wid of every terminal row (DONE/FAILED are frozen, §2.2.4 row 5). */
  frozen: string[];
}

export interface WorkerRecoveryOptions {
  /** Is this process id alive? (default: `process.kill(pid, 0)`.) */
  pidAlive?: (pid: number) => boolean;
  /** Does the host session still exist? (absent = "cannot tell" → never an orphan.) */
  knownHost?: (sid: string) => boolean;
  /** Deliverable probe (the caller owns the results dir; §2.4 R2-4). */
  artifactExists?: (entry: WorkerEntry) => boolean;
  now?: number;
  /**
   * W9224 P1-7: how long a `lease=` stamp counts as evidence of life
   * (default [WORKER_LEASE_TTL_MS]). `Infinity` restores the old pid-only rule.
   */
  leaseTtlMs?: number;
}

/**
 * W9224 P1-7: is this owner's lease still fresh? `at === 0` is the synthesised
 * stamp of a lease-less legacy row ([workerOwner]) — it has no evidence either
 * way, so it is NEVER expired by this rule.
 *
 * `entry` is the ROW the owner came from: only a `driven=yes` row promised the
 * heartbeat that makes a stale stamp meaningful (see [WORKER_LEASE_TTL_MS]).
 */
export function leaseExpired(entry: WorkerEntry, owner: WorkerLease, nowMs: number, ttlMs: number): boolean {
  if (owner.at <= 0) return false;
  if (getExtra(entry, "driven") !== "yes") return false;
  return nowMs - owner.at * 1_000 > ttlMs;
}

/** `process.kill(pid, 0)` — signal 0 asks "may I signal it at all?". */
export function pidAliveDefault(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = the process exists but belongs to someone else; only ESRCH is dead.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Judge every row of a table (pure: the caller supplies liveness + the probe). */
export function observeWorkerTable(entries: readonly WorkerEntry[], opts: WorkerRecoveryOptions = {}): WorkerRecoveryReport {
  const alive = opts.pidAlive ?? pidAliveDefault;
  const artifact = opts.artifactExists ?? ((): boolean => false);
  const now = opts.now ?? Date.now();
  const ttl = opts.leaseTtlMs ?? WORKER_LEASE_TTL_MS;
  const report: WorkerRecoveryReport = { observed_at: now, stale: [], orphans: [], live: [], frozen: [] };
  for (const entry of entries) judgeRow(entry, opts, { alive, artifact, now, ttl }, report);
  return report;
}

/** The evidence one row is judged from (bundled so the judge stays small). */
interface JudgeEvidence {
  alive: (pid: number) => boolean;
  artifact: (entry: WorkerEntry) => boolean;
  now: number;
  ttl: number;
}

function judgeRow(
  entry: WorkerEntry,
  opts: WorkerRecoveryOptions,
  ev: JudgeEvidence,
  report: WorkerRecoveryReport,
): void {
  if (entry.status !== "RUNNING") {
    report.frozen.push(entry.wid);
    return;
  }
  const lease = workerOwner(entry);
  const host = workerHost(entry);
  // An orphan is a row whose host session vanished — auditable without any
  // liveness evidence, and NEVER auto re-dispatched (§2.2.4 row 6). It is not a
  // healthy row either, so it never appears in `live[]`; a row can be both an
  // orphan AND stale, because both facts are true and each list is a fact list.
  const orphan = host !== null && opts.knownHost !== undefined && !opts.knownHost(host);
  if (orphan) report.orphans.push(candidate(entry, "orphan_host", ev.artifact(entry)));
  // W9224 P1-7: the pid is necessary but NOT sufficient. A lease that stopped
  // renewing — or a pid the OS recycled to an unrelated process — is stale
  // evidence, not life; trusting it is exactly why such a row never converges.
  if (lease === null) {
    if (!orphan) report.live.push(entry.wid);
    return;
  }
  if (!ev.alive(lease.pid)) {
    report.stale.push(candidate(entry, "stale_lease", ev.artifact(entry)));
    return;
  }
  if (leaseExpired(entry, lease, ev.now, ev.ttl)) {
    report.stale.push(candidate(entry, "stale_lease_expired", ev.artifact(entry)));
    return;
  }
  if (!orphan) report.live.push(entry.wid);
}

/**
 * The liveness evidence of a row: `lease=<pid>@<unix>` is what P1 writes, and
 * `proc=<pid>` (the W234 ownership token every row has had since W180) is the
 * fallback — a row written before leases existed still names its owner, so it is
 * judged instead of being declared immortal.
 */
export function workerOwner(entry: WorkerEntry): WorkerLease | null {
  const lease = workerLease(entry);
  if (lease !== null) return lease;
  const proc = workerProc(entry);
  return proc === null ? null : { pid: proc, at: 0 };
}

function candidate(entry: WorkerEntry, reason: WorkerRecoveryReason, artifact: boolean): WorkerRecoveryCandidate {
  const lease = workerOwner(entry);
  return {
    wid: entry.wid,
    status: entry.status,
    attempt: workerAttempt(entry),
    host_session: workerHost(entry),
    sess: getExtra(entry, "sess"),
    reason,
    lease_pid: lease?.pid ?? null,
    lease_at: lease?.at ?? null,
    retries: workerRetries(entry),
    artifact,
    action: actionOf(reason, artifact, workerRetries(entry)),
  };
}

/**
 * §2.2.4 actions, computed but NEVER executed in P0. `maxRetries` is the value
 * the DSH-side plugin uses (R2-2: two different thresholds must not fight).
 */
export const WORKER_MAX_RETRIES = 2;

function actionOf(reason: WorkerRecoveryReason, artifact: boolean, retries: number): WorkerRecoveryAction {
  if (reason === "orphan_host") return "observe";
  if (artifact) return "close_done";
  return retries < WORKER_MAX_RETRIES ? "respawn" : "fail";
}
