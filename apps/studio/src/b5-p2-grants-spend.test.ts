/**
 * B5-03 · `uses_left` is a REAL budget, not a display field.
 *
 * Before the fix `spendOneShot` handled `uses_left === 1` only, so a grant
 * described as "3 uses" was never decremented and stayed valid forever. Measured
 * on the baseline: five consecutive composes left `uses_left` at 3 after every
 * one of them, while the audit line and the UI both showed the number.
 *
 * What is pinned here (each is a defect if it flips):
 *   1. a bounded grant decrements on EVERY compose, not just at 1;
 *   2. reaching 0 REMOVES the entry — a stored `uses_left: 0` is still honored by
 *      the read side (`effectiveGrantsOf` keys off presence, not the counter), so
 *      "left at 0" would be a cosmetic fix;
 *   3. `uses_left: null` stays UNLIMITED (it is a first-class value in the
 *      contract, and `unsandboxed` leans on it);
 *   4. the `use` audit line names what is left.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createSessionGrants } from "./runtime/session-grants.js";
import { effectiveGrantsOf } from "./runtime/engine-grants.js";
import { GRANTS_AUDIT_FILE } from "./store/grants-audit.js";

const SEC = 1_700_000_000;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A read-only permission baseline, so the grant's read root is the ONLY one.
 * The shipped default is `full-access`, whose `allPaths` rewrites BOTH root
 * lists to the all-paths capability ([ALL_PATHS_ROOT]) and would make every
 * "is this root still granted?" assertion vacuous.
 */
const RO: NodeJS.ProcessEnv = { CELESTEA_PERMISSION_DEFAULT: "read-only", CELESTEA_PERMISSION_MAX: "read-only" };

interface Fixture {
  dir: string;
  dataDir: string;
  id: string;
  extra: string;
}

/** A session holding ONE read_roots grant with the given `uses_left`. */
function fixture(uses: number | null): Fixture {
  const root = mkdtempSync(join(tmpdir(), "b5-spend-"));
  dirs.push(root);
  const dir = join(root, "s1");
  const dataDir = join(root, "data");
  const extra = join(root, "extra");
  mkdirSync(dir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(extra, { recursive: true });
  const id = "ws/s1";
  writeFileSync(
    join(dir, "grants.json"),
    JSON.stringify({
      version: 1,
      session: id,
      updated_at: 0,
      grants: [
        { id: "g1", cap: "read_roots", scope: { roots: [extra] }, granted_at: 1, granted_by: "x", expires_at: null, uses_left: uses, note: "" },
      ],
    }),
  );
  return { dir, dataDir, id, extra };
}

/** The stored counter, `null` when unlimited, or `"absent"` when removed. */
function stored(dir: string, id: string): number | null | "absent" {
  const p = join(dir, "grants.json");
  if (!existsSync(p)) return "absent";
  const file = JSON.parse(readFileSync(p, "utf8")) as { grants: Array<{ uses_left: number | null }> };
  const g = file.grants[0];
  return g === undefined ? "absent" : g.uses_left;
}

/** Compose once, the way the engine does at a turn boundary. */
function compose(f: Fixture): void {
  const grants = createSessionGrants({ dataDir: f.dataDir, env: RO, now: () => SEC * 1000 });
  const r = grants.read(f.id, f.dir);
  grants.onComposed(f.id, f.dir, r);
}

describe("B5-03 · a bounded grant is really spent", () => {
  it("uses_left: 3 decrements to 2, then 1, then the entry is removed", () => {
    const f = fixture(3);
    expect(stored(f.dir, f.id)).toBe(3);
    compose(f);
    expect(stored(f.dir, f.id)).toBe(2);
    compose(f);
    expect(stored(f.dir, f.id)).toBe(1);
    compose(f);
    expect(stored(f.dir, f.id), "reaching 0 REMOVES the entry").toBe("absent");
  });

  it("uses_left: 1 is spent on the first compose (the historical behaviour)", () => {
    const f = fixture(1);
    compose(f);
    expect(stored(f.dir, f.id)).toBe("absent");
  });

  it("an EXHAUSTED grant actually stops granting (the read side honours the entry's presence)", () => {
    const f = fixture(1);
    // Before: the extra root is readable.
    expect(effectiveGrantsOf(f.dir, f.id, RO, SEC).grants.readRoots).toContain(f.extra);
    compose(f);
    // After the spend it must be GONE — this is the assertion a stored-0 fix
    // would fail, because the read side never looks at the counter.
    expect(effectiveGrantsOf(f.dir, f.id, RO, SEC).grants.readRoots).not.toContain(f.extra);
  });

  it("uses_left: null stays UNLIMITED across many composes", () => {
    const f = fixture(null);
    for (let i = 0; i < 5; i++) compose(f);
    expect(stored(f.dir, f.id)).toBe(null);
    expect(effectiveGrantsOf(f.dir, f.id, RO, SEC).grants.readRoots).toContain(f.extra);
  });

  it("uses_left: null is NOT spent and emits NO use audit line (it is 'no bound', not '1 use')", () => {
    // This is the assertion a `uses_left !== null` regression turns red: a
    // "treat null as bounded" fix would silently REVOKE every live permanent
    // grant on upgrade, and the only symptom would be a grant that vanished.
    const f = fixture(null);
    const grants = createSessionGrants({ dataDir: f.dataDir, env: RO, now: () => SEC * 1000 });
    grants.onComposed(f.id, f.dir, grants.read(f.id, f.dir));
    grants.onComposed(f.id, f.dir, grants.read(f.id, f.dir));
    expect(stored(f.dir, f.id), "still stored, untouched").toBe(null);
    const auditPath = join(f.dataDir, GRANTS_AUDIT_FILE);
    if (existsSync(auditPath)) {
      const useLines = readFileSync(auditPath, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as { event: string })
        .filter((l) => l.event === "use");
      expect(useLines, "an unlimited grant is never 'used up'").toEqual([]);
    }
  });

  it("the use audit line names what is left, then the exhaustion", () => {
    const f = fixture(2);
    const grants = createSessionGrants({ dataDir: f.dataDir, env: RO, now: () => SEC * 1000 });
    for (let i = 0; i < 2; i++) grants.onComposed(f.id, f.dir, grants.read(f.id, f.dir));
    const lines = readFileSync(join(f.dataDir, GRANTS_AUDIT_FILE), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { event: string; uses_left: number | null; detail: string });
    const uses = lines.filter((l) => l.event === "use");
    expect(uses.length).toBe(2);
    expect(uses[0]?.uses_left).toBe(1);
    expect(uses[0]?.detail).toContain("1 use(s) left");
    expect(uses[1]?.uses_left).toBe(0);
    expect(uses[1]?.detail).toContain("one-shot grant spent");
  });
});
