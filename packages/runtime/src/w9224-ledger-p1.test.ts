/**
 * W9224 P1-4 — the ledger parse is memoized on the file's IDENTITY, so a poll
 * that reads it several times parses it once.
 *
 * WHY: `readAll()` `readFileSync` + `JSON.parse`s the current file AND the
 * rolled `.1` on every call, and the callers are the statusline (2 s tick, every
 * SSE push) plus two HTTP endpoints. `latest()` / `total()` / `totals()` each
 * called `rows()` independently, so ONE poll could parse up to 32 MiB several
 * times over.
 *
 * The counter is the ledger-io module's own parse counter (DELTA, never an
 * absolute: other files in the same worker share the module instance). It is
 * deliberately NOT a `vi.mock`/fs spy: `vi.spyOn(node:fs, ...)` throws on an
 * ESM namespace, and mocking the module cannot intercept a call the SUT makes to
 * its own sibling binding.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ledgerParseCount } from "./ledger-io.js";
import { USAGE_LEDGER_FILE, UsageLedgerFile } from "./ledger.js";

const roots: string[] = [];
const NOW = 1_760_000_000_000;

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "w9224-ledger-"));
  roots.push(dir);
  return dir;
}

/** One ok step row, in the ledger's own shape. */
function stepRow(session: string, step: number): string {
  return JSON.stringify({
    v: 1,
    ts: Math.floor(NOW / 1000),
    kind: "ok",
    session,
    turn: 0,
    turn_id: "turn-0",
    step,
    attempt: 0,
    provider: "mock",
    model: "m",
    base_url_host: null,
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, cache_read: 0, reasoning_tokens: 0 },
    billed_unknown: false,
    error_kind: null,
    http_status: null,
    retryable: null,
    price: null,
    cost: null,
    priced_by: "unpriced",
    fallback_from: null,
  });
}

/** A ledger over a file that ALREADY holds `steps` rows. */
function seeded(steps: number): { file: UsageLedgerFile; path: string } {
  const path = join(tmpDir(), USAGE_LEDGER_FILE);
  const lines: string[] = [];
  for (let i = 1; i <= steps; i += 1) lines.push(stepRow("ws/s1", i));
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return { file: new UsageLedgerFile({ path, now: () => NOW }), path };
}

describe("W9224 P1-4: the ledger file is parsed once per identity", () => {
  it("a poll that reads four times parses ONCE (unchanged file)", () => {
    const { file } = seeded(3);
    const before = ledgerParseCount();
    // One statusline poll: contextUsage -> latest(), usageStatus -> latest()+total().
    expect(file.readAll()).toHaveLength(3);
    expect(file.readAll()).toHaveLength(3);
    expect(file.read()).toHaveLength(3);
    expect(file.readAll()).toHaveLength(3);
    // ONE parse for the current file, ONE for the (absent) rolled segment: the
    // four reads together cost two parses, not eight.
    expect(ledgerParseCount() - before).toBe(2);
  });

  it("a VIEW change is visible immediately (the memo is not a stale snapshot)", () => {
    const { file, path } = seeded(1);
    expect(file.readAll()).toHaveLength(1);
    const before = ledgerParseCount();
    // A second row arrives from OUTSIDE this writer (another instance, a
    // rotation): the identity key alone must catch it.
    writeFileSync(path, readFileSync(path, "utf8") + stepRow("ws/s1", 2) + "\n", "utf8");
    expect(file.readAll()).toHaveLength(2);
    expect(ledgerParseCount() - before).toBeGreaterThan(0);
  });

  it("an append by THIS writer invalidates the memo even at the same size+mtime", () => {
    const { file } = seeded(1);
    expect(file.readAll()).toHaveLength(1);
    // The identity key alone cannot prove freshness on a coarse mtime clock
    // (Windows ticks are ~15 ms), so the writer must drop the memo explicitly.
    expect(file.append(JSON.parse(stepRow("ws/s1", 2)) as never)).toBe(true);
    expect(file.readAll()).toHaveLength(2);
  });

  it("the cumulative view still spans the rolled .1 segment (P2-2 preserved)", () => {
    const { file, path } = seeded(1);
    // Roll the current file away by hand, then add a fresh current file.
    writeFileSync(path + ".1", readFileSync(path, "utf8"), "utf8");
    writeFileSync(path, stepRow("ws/s1", 2) + "\n", "utf8");
    expect(file.readAll().map((r) => (r as { step: number }).step)).toEqual([1, 2]);
  });

  it("the memo is dropped after a rotation (both paths change identity)", () => {
    const path = join(tmpDir(), USAGE_LEDGER_FILE);
    writeFileSync(path, stepRow("ws/s1", 1) + "\n", "utf8");
    // maxBytes 1: the next append rolls the file, replacing <path>.1.
    const file = new UsageLedgerFile({ path, now: () => NOW, maxBytes: 1 });
    expect(file.readAll()).toHaveLength(1);
    expect(file.append(JSON.parse(stepRow("ws/s1", 2)) as never)).toBe(true);
    // read() is current-only: after the roll the current file holds row 2 and
    // the rolled file holds row 1, so the CUMULATIVE view sees both.
    expect(file.read()).toHaveLength(1);
    expect(file.readAll()).toHaveLength(2);
  });

  it("the returned array is a COPY (a caller cannot poison the memo)", () => {
    const { file } = seeded(2);
    const first = file.readAll();
    first.length = 0;
    expect(file.readAll()).toHaveLength(2);
  });
});
