/**
 * B4-04 P2 -- the startup sweep for crash residue.
 *
 * The defect this pins: attachments/store.ts and run-code/broker.ts both
 * clean up in a finally, which a CRASH never runs, and nothing swept the
 * residue afterwards. Every crash therefore left a permanent file behind -- and
 * the run-code ones are the whole assembled program, source included, sitting
 * in the user data root.
 *
 * Every filesystem case below runs against a REAL temp directory with REAL
 * files. A fake filesystem would let a policy bug pass, and sparing the WRONG
 * file is the only way this sweep can hurt anyone -- so the real thing is what
 * has to be right.
 */

import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isSweepable,
  sweepCrashResidue,
  sweepSummaryLine,
  SWEEP_MIN_AGE_MS,
  type SweepTarget,
} from "./crash-sweep.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A real temp directory whose files carry the given AGES in ms. */
function dirWith(files: Record<string, number>): { dir: string; now: number } {
  const dir = mkdtempSync(join(tmpdir(), "b4-04-"));
  roots.push(dir);
  const now = 1_700_000_000_000;
  for (const [name, ageMs] of Object.entries(files)) {
    writeFileSync(join(dir, name), "x", "utf8");
    // Backdate the mtime: residue is by definition NOT fresh.
    const secs = (now - ageMs) / 1000;
    utimesSync(join(dir, name), secs, secs);
  }
  return { dir, now };
}

const OLD = SWEEP_MIN_AGE_MS * 10; // comfortably past the grace window
const FRESH = 1_000; // written just now

describe("B4-04 P2 · the crash-residue sweep", () => {
  it(`removes a stranded run_code program AND a stranded attachment tmp`, async () => {
    const { dir: programs, now } = dirWith({
      "run_code_999_0.mts": OLD,
      "run_code_888_3.py": OLD,
    });
    const { dir: attachments } = dirWith({
      "abc.png.tmp-999-1700000000000": OLD,
    });
    const report = await sweepCrashResidue(
      [
        { dir: programs, kind: "run-code" },
        { dir: attachments, kind: "attachments" },
      ],
      { now: () => now, pid: 4242 },
    );

    expect(report.scanned).toBe(2);
    expect(report.removed[programs]).toBe(2);
    expect(report.removed[attachments]).toBe(1);
    expect(() => statSync(join(programs, "run_code_999_0.mts"))).toThrow();
    expect(() => statSync(join(attachments, "abc.png.tmp-999-1700000000000"))).toThrow();
  });

  it(`NEVER deletes a program belonging to the live pid (rule 2)`, async () => {
    const { dir, now } = dirWith({ "run_code_777_0.mts": OLD, "run_code_999_1.mts": OLD });
    const report = await sweepCrashResidue([{ dir, kind: "run-code" }], { now: () => now, pid: 777 });

    // The live one survives; only the other pid is swept.
    expect(report.removed[dir]).toBe(1);
    expect(() => statSync(join(dir, "run_code_777_0.mts"))).not.toThrow();
    expect(() => statSync(join(dir, "run_code_999_1.mts"))).toThrow();
  });

  it(`NEVER touches a file it does not recognise (rule 1: whitelist)`, async () => {
    const names = ["notes.md", "important.png", "run_code_999_0.mts.bak", "run_code999_0.mts", "my-run_code_999_0.mts"];
    const { dir, now } = dirWith(Object.fromEntries(names.map((n) => [n, OLD])));
    const report = await sweepCrashResidue([{ dir, kind: "run-code" }], { now: () => now, pid: 1 });

    expect(report.removed[dir]).toBeUndefined();
    for (const name of names) {
      expect(() => statSync(join(dir, name)), name).not.toThrow();
    }
  });

  it(`NEVER deletes a file younger than the grace window (rule 3)`, async () => {
    // DISTINCT dirs: one file each, so the skipped count is unambiguous (pointing
    // both targets at one dir would scan it twice and count every file twice).
    const { dir: programs, now } = dirWith({ "run_code_999_0.mts": FRESH });
    const { dir: attachments } = dirWith({ "abc.png.tmp-999-1": FRESH });
    const report = await sweepCrashResidue(
      [
        { dir: programs, kind: "run-code" },
        { dir: attachments, kind: "attachments" },
      ],
      { now: () => now, pid: 1 },
    );

    expect(report.removed[programs]).toBeUndefined();
    expect(report.removed[attachments]).toBeUndefined();
    expect(report.skipped).toBe(2);
    expect(() => statSync(join(programs, "run_code_999_0.mts"))).not.toThrow();
  });

  it(`is idempotent: a second sweep finds nothing and changes nothing`, async () => {
    const { dir, now } = dirWith({ "run_code_999_0.mts": OLD });
    const targets: SweepTarget[] = [{ dir, kind: "run-code" }];
    const first = await sweepCrashResidue(targets, { now: () => now, pid: 1 });
    const second = await sweepCrashResidue(targets, { now: () => now, pid: 1 });

    expect(first.removed[dir]).toBe(1);
    expect(second.removed[dir]).toBeUndefined();
    expect(second.scanned).toBe(1);
  });

  it(`never throws on a missing directory, and caps its scan (rule 4)`, async () => {
    const { dir, now } = dirWith({ "run_code_999_0.mts": OLD });
    const targets: SweepTarget[] = [
      { dir: join(dir, "does-not-exist"), kind: "run-code" },
      { dir: "", kind: "run-code" },
      { dir, kind: "run-code" },
    ];
    // maxEntries 1 bounds HOW MANY names one directory may contribute. It does
    // not promise WHICH name that is (readdir order is unspecified), so this
    // asserts the bound itself rather than a specific file surviving.
    const report = await sweepCrashResidue(targets, { now: () => now, pid: 1, maxEntries: 1 });

    expect(report.scanned).toBe(1); // the missing dir and the empty dir contribute 0
    expect(report.errors).toBe(0);

    // A separate case proves the cap really bounds the work: 5 residue files,
    // cap 2, and the mtime seam reports exactly how many were even looked at.
    const { dir: many, now: manyNow } = dirWith({
      "run_code_991_0.mts": OLD,
      "run_code_992_1.mts": OLD,
      "run_code_993_2.mts": OLD,
      "run_code_994_3.mts": OLD,
      "run_code_995_4.mts": OLD,
    });
    let seen = 0;
    const bounded = await sweepCrashResidue([{ dir: many, kind: "run-code" }], {
      now: () => manyNow,
      pid: 1,
      maxEntries: 2,
      mtime: () => {
        seen += 1;
        return Promise.resolve(0);
      },
    });
    expect(seen).toBe(2);
    expect(Object.values(bounded.removed).reduce((a, b) => a + b, 0)).toBe(2);
  });

  it(`a readdir failure is non-fatal and silent`, async () => {
    const report = await sweepCrashResidue(
      [{ dir: "X:/nope", kind: "run-code" }],
      { readDir: () => Promise.reject(new Error("EACCES")), now: () => 1, pid: 1 },
    );
    expect(report.scanned).toBe(0);
    expect(report.errors).toBe(0);
    expect(sweepSummaryLine(report)).toBeNull();
  });

  it(`a delete failure is REPORTED, not swallowed`, async () => {
    const { dir, now } = dirWith({ "run_code_999_0.mts": OLD });
    const report = await sweepCrashResidue([{ dir, kind: "run-code" }], {
      now: () => now,
      pid: 1,
      remove: () => Promise.reject(new Error("EBUSY")),
    });
    expect(report.errors).toBe(1);
    expect(sweepSummaryLine(report)).toContain("error(s)");
  });
});

describe(`B4-04 P2 · the sweep policy, without touching a filesystem`, () => {
  const old = { mtimeMs: 0, nowMs: SWEEP_MIN_AGE_MS, minAgeMs: SWEEP_MIN_AGE_MS, livePid: 7 };

  it(`accepts exactly the shapes the two writers produce`, () => {
    expect(isSweepable("a1b2.png.tmp-123-1700000000000", "attachments", old)).toBe(true);
    expect(isSweepable("run_code_123_0.mts", "run-code", old)).toBe(true);
    expect(isSweepable("run_code_123_9.py", "run-code", old)).toBe(true);
  });

  it(`rejects anything else, including near-misses`, () => {
    const nearMisses = [
      "readme.md",
      "a.png",
      "a.png.tmp",
      "a.png.tmp-1",
      "run_code_1.mts",
      "run_code_1_1.txt",
      "run_code__1.mts",
    ];
    for (const name of nearMisses) {
      expect(isSweepable(name, "run-code", old), name).toBe(false);
      expect(isSweepable(name, "attachments", old), name).toBe(false);
    }
  });

  it(`refuses the live pid and anything inside the grace window`, () => {
    expect(isSweepable("run_code_7_0.mts", "run-code", old)).toBe(false);
    expect(isSweepable("run_code_8_0.mts", "run-code", { ...old, nowMs: SWEEP_MIN_AGE_MS - 1 })).toBe(false);
  });

  it(`the summary line stays silent when there is nothing to report`, () => {
    expect(sweepSummaryLine({ scanned: 3, removed: {}, skipped: 9, errors: 0 })).toBeNull();
    expect(sweepSummaryLine({ scanned: 1, removed: { "/x": 2 }, skipped: 0, errors: 0 })).toContain("2 file(s)");
  });
});
