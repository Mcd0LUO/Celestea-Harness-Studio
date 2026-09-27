/**
 * Internal helpers of the usage ledger (W836 R3 batch F), split out so
 * `ledger.ts` stays inside the repository file budget:
 *   - [readLedgerRecords] parses ONE ledger file (current or rolled `.1`);
 *   - [readLedgerRecordsCached] is the W9224 P1-4 memo: the same parse, but
 *     reused while the file's identity (size + mtimeMs) is unchanged;
 *   - [LedgerKeySet] is the BOUNDED idempotency-key memory (P2-5): keys are
 *     evicted per closed turn, with a size cap as the backstop.
 */

import { readFileSync, statSync } from "node:fs";

/**
 * How many times a ledger file was actually PARSED in this process.
 *
 * This is the honest observable of W9224 P1-4: the defect was "parsed once per
 * read", so the only way a test can pin the fix is to count the parses. Exported
 * as a diagnostic (not a behaviour switch): nothing in production reads it.
 */
let PARSE_COUNT = 0;

/** Parses so far (monotonic; tests assert the DELTA, never an absolute). */
export function ledgerParseCount(): number {
  return PARSE_COUNT;
}

/** Every readable record of one ledger path (an unparsable line is skipped). */
export function readLedgerRecords<T>(path: string): T[] {
  PARSE_COUNT += 1;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null) out.push(parsed as T);
    } catch {
      // A torn/foreign line never hides the rows around it.
    }
  }
  return out;
}

/** Identity of one file on disk (W9224 P1-4: what a memo may be keyed on). */
export interface FileStamp {
  size: number;
  mtimeMs: number;
}

/** `stat` of one path; `null` = absent (ENOENT is "no file", not an error). */
export function fileStampOf(path: string): FileStamp | null {
  try {
    const s = statSync(path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/** Stable string form of a stamp (absent is its own key). */
export function stampKey(stamp: FileStamp | null): string {
  return stamp === null ? "absent" : `${stamp.size}:${stamp.mtimeMs}`;
}

/**
 * W9224 P1-4 — the parsed rows of one ledger path, reused while the file is
 * unchanged.
 *
 * WHY: `UsageLedgerFile.readAll()` used to `readFileSync` + `JSON.parse` the
 * current file AND the rolled `.1` on EVERY call, and the callers are the
 * statusline (2 s tick, every SSE push) and two HTTP endpoints — each of which
 * could parse up to 16 MiB + 16 MiB per request, several times per poll
 * (`latest()` / `total()` / `totals()` each re-read independently). The ledger
 * is append-only and has ONE writer per process by construction, so the parse
 * result is a pure function of the file's identity.
 *
 * The memo is keyed on (path, size, mtimeMs). The writer additionally calls
 * [invalidateLedgerRecords] after every successful append, so a same-size write
 * inside one filesystem timestamp tick cannot serve a stale view.
 */
const PARSE_CACHE = new Map<string, { key: string; records: unknown[] }>();

export function readLedgerRecordsCached<T>(path: string): T[] {
  const key = stampKey(fileStampOf(path));
  const hit = PARSE_CACHE.get(path);
  if (hit !== undefined && hit.key === key) return hit.records as T[];
  const records = readLedgerRecords<T>(path);
  PARSE_CACHE.set(path, { key, records });
  return records;
}

/** Drop the memo of one ledger path (the writer calls this after a write). */
export function invalidateLedgerRecords(path: string): void {
  PARSE_CACHE.delete(path);
}

/** Bounded in-process idempotency keys: per-turn eviction + a size cap. */
export class LedgerKeySet {
  private readonly keys = new Set<string>();

  constructor(private readonly max: number) {}

  /** True when this writer already booked the key (the row must be skipped). */
  has(key: string): boolean {
    return this.keys.has(key);
  }

  /** Size of the memory (bounded-memory diagnostics / tests). */
  get size(): number {
    return this.keys.size;
  }

  /** Remember one booked key, trimming the OLDEST keys past the cap. */
  add(key: string): void {
    this.keys.add(key);
    if (this.keys.size <= this.max) return;
    let excess = this.keys.size - this.max;
    for (const key2 of this.keys) {
      if (excess <= 0) break;
      this.keys.delete(key2);
      excess -= 1;
    }
  }

  /**
   * Drop the keys of ONE closed turn: an in-flight turn keeps its keys, so a
   * duplicate step booked while it is still open is still refused. A `null`
   * turn id (an out-of-turn row) is left to the size cap.
   */
  evictTurn(session: string, turnId: string | null): void {
    if (turnId === null) return;
    const prefix = `${session}|${turnId}|`;
    for (const key of this.keys) if (key.startsWith(prefix)) this.keys.delete(key);
  }
}
