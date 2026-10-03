/**
 * The session grant boundary at COMPOSE time (W516 §4.2, §4.4).
 *
 * One instance per session is composed per turn boundary, so this is where the
 * session's widenings are read, audited and (for one-shot entries) spent. "Read
 * at compose" is what makes a grant land in the NEXT turn and never inside the
 * running one: the instance a turn runs on keeps the boundary it was composed
 * with, whatever happens to `grants.json` meanwhile.
 *
 * Honest limits of this implementation (also listed in the W516 report): `use`
 * is sampled once per composed generation (i.e. per turn boundary) rather than
 * once per sandbox spawn, and a one-shot entry is spent at compose time — the
 * safe direction (it can only be lost earlier, never used twice).
 */

import { effectiveGrantsOf, expiredGrants, type EffectiveGrants } from "./engine-grants.js";
import type { EngineGrantAudit, EngineGrantEvent } from "./engine-grants.js";
import { GrantsAuditWriter } from "../store/grants-audit.js";
import { isExpired, readGrantsFile, writeGrantsFile, type GrantRecord, type GrantsFile } from "../store/grants.js";

/** Caps whose use changes the process environment → always sampled (§4.4). */
const HEAVY_CAPS: readonly string[] = ["network", "unsandboxed"];

export interface GrantsReadResult {
  grants: EffectiveGrants;
  warnings: string[];
}

export interface SessionGrantsReader {
  /** Effective grants of one session directory (never throws — §4.1). */
  read(sessionId: string | null, dir: string | null): GrantsReadResult;
  /** Audit the boundary + spend one-shot entries; called once per compose. */
  onComposed(sessionId: string | null, dir: string | null, read: GrantsReadResult): void;
  /** An audit sink already bound to one session. */
  audit(sessionId: string | null): EngineGrantAudit;
  /** Await in-flight platform-audit deliveries (tests / shutdown). */
  flush(): Promise<void>;
}

export interface SessionGrantsOptions {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  now?: () => number;
}

interface ComposedCtx {
  env: NodeJS.ProcessEnv;
  now: () => number;
}

export function createSessionGrants(opts: SessionGrantsOptions): SessionGrantsReader {
  const writer = new GrantsAuditWriter({ dataDir: opts.dataDir, env: opts.env, now: opts.now ?? Date.now });
  const audit = (sessionId: string | null): EngineGrantAudit => (event: EngineGrantEvent) =>
    writer.write({ session: sessionId ?? "", ...event });
  const ctx: ComposedCtx = { env: opts.env, now: opts.now ?? Date.now };
  return {
    read: (sessionId, dir) => effectiveGrantsOf(dir, sessionId, ctx.env, Math.floor(ctx.now() / 1000)),
    audit,
    flush: () => writer.flush(),
    onComposed: (sessionId, dir, result) => recordComposed(writer, sessionId, dir, result, ctx),
  };
}

/** Warnings → audit; heavyweight caps → `use`; expired / one-shot entries. */
function recordComposed(
  writer: GrantsAuditWriter,
  sessionId: string | null,
  dir: string | null,
  result: GrantsReadResult,
  ctx: ComposedCtx,
): void {
  const session = sessionId ?? "";
  const sink = (event: EngineGrantEvent): void => writer.write({ session, ...event });
  const seconds = Math.floor(ctx.now() / 1000);
  for (const warning of result.warnings) {
    const event = warning.startsWith("grants_unreadable") ? "grants_unreadable" : "deny";
    sink({ event, reason: warning });
  }
  for (const source of result.grants.sources) {
    if (!HEAVY_CAPS.includes(source.cap)) continue;
    sink({ event: "use", cap: source.cap, grant_id: source.grantId, detail: "active for the composed session instance" });
  }
  // W878: the file is self-describing, so validate it against the TRUSTED id
  // (never a path inference). A null id with a real dir reads nothing.
  const read = dir === null || sessionId === null ? null : readGrantsFile(dir, sessionId);
  if (read?.file === undefined) return;
  for (const grant of expiredGrants(read.file, seconds)) sink({ event: "expire", cap: grant.cap, grant_id: grant.id });
  spendOneShot(writer, { dir, sessionId, file: read.file, active: new Set(result.grants.sources.map((s) => s.grantId)), seconds, env: ctx.env });
}

interface SpendCtx {
  dir: string | null;
  /** W878: the trusted id the rewrite must self-describe as. */
  sessionId: string | null;
  file: GrantsFile;
  active: ReadonlySet<string>;
  seconds: number;
  env: NodeJS.ProcessEnv;
}

/**
 * Spend the bounded entries that were just composed in (§2.3).
 *
 * B5-03: this used to handle `uses_left === 1` only, so a grant the UI/API
 * describes as "3 uses" (`uses_left: 3`) was **never decremented** and stayed
 * valid forever — the counter the audit line and the UI both display was pure
 * decoration above 1. Measured before the fix: five consecutive composes left
 * `uses_left` at 3 after every one of them.
 *
 * `uses_left: null` still means UNLIMITED and is untouched: "no bound" is a
 * first-class value in the contract (`MAX_TTL_SEC`/`unsandboxed` both lean on it),
 * and silently turning it into "1 use" would revoke live grants on upgrade.
 *
 * The spend keeps the file's SAFE DIRECTION: an entry is spent when it is
 * composed, so a bounded grant can be lost early but never used twice. A failed
 * write leaves the entry valid for one more turn (the `catch` below) — the
 * same trade the one-shot path already documented.
 */
function spendOneShot(writer: GrantsAuditWriter, ctx: SpendCtx): void {
  // A bounded entry = one that was just composed AND has a finite count.
  // `uses_left === null` (unlimited) and `uses_left <= 0` (already exhausted)
  // are deliberately NOT in this set: a 0-count entry is dropped by the read
  // side, not re-spent here.
  // An entry whose count REACHES 0 is REMOVED, not stored with a 0: the read
  // side (`effectiveGrantsOf`) keys off the entry's presence and never inspects
  // `uses_left`, so a stored 0 would keep granting (measured: a hand-written
  // `uses_left: 0` read_roots is still in `effective.readRoots`). Removal is what
  // makes "exhausted" mean denied.
  const next: GrantRecord[] = [];
  const spent: Array<{ entry: GrantRecord; left: number }> = [];
  for (const entry of ctx.file.grants) {
    const bounded = entry.uses_left !== null && entry.uses_left > 0;
    const composed = ctx.active.has(entry.id) && !isExpired(entry, ctx.seconds);
    if (!bounded || !composed) {
      next.push(entry); // unlimited, not composed, or expired → untouched
      continue;
    }
    const left = (entry.uses_left ?? 1) - 1;
    if (left > 0) next.push({ ...entry, uses_left: left });
    spent.push({ entry, left });
  }
  if (ctx.dir === null || ctx.sessionId === null || spent.length === 0) return;
  try {
    writeGrantsFile(ctx.dir, { version: 1, session: ctx.sessionId, updated_at: ctx.seconds, grants: next }, { env: ctx.env, now: ctx.seconds });
  } catch {
    return; // best-effort: the entry stays and stays valid for one more turn
  }
  for (const { entry, left } of spent) {
    writer.write({
      session: ctx.sessionId,
      event: "use",
      cap: entry.cap,
      grant_id: entry.id,
      uses_left: left,
      detail: left === 0 ? "one-shot grant spent" : `grant used, ${left} use(s) left`,
    });
  }
}
