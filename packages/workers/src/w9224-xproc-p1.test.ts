/**
 * W9224 P1-5 — the cross-process half of the shared table's write lock.
 *
 * WHY A REAL SECOND PROCESS: the defect is a TOCTOU between two processes
 * (read the table -> merge -> rename over it). Same-process writers can never
 * hit it because `persist()` is fully synchronous, which is exactly why every
 * in-process test in this repo stayed green while the table lost rows. A mock
 * would therefore prove nothing — the probes below spawn real `node` children
 * that import the REAL `WorkerRegistry`.
 *
 * The child is TypeScript, run through the repo's own `tsx` (a devDependency,
 * the same loader `pnpm start`/scripts use) with the module path resolved from
 * THIS file, so nothing here depends on an absolute checkout path.
 *
 * The mutation control is recorded in results/W9224-修复.md §3: removing the
 * `acquireTableLock` call from `WorkerRegistry.persist` makes the concurrent
 * case lose rows (measured 292/300).
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acquireTableLock } from "./registry-tsv.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY_TS = join(HERE, "registry.ts");
const TSX_CLI = join(HERE, "..", "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

/**
 * The child: a real registry that writes `n` rows, optionally behind a barrier
 * (both children start writing at the same instant, which is what makes the
 * interleave reproducible).
 */
const CHILD_SOURCE = `
import { existsSync, writeFileSync } from "node:fs";
import { WorkerRegistry } from REGISTRY_SPEC;
const [path, wid, pidS, nS, goFile, readyFile] = process.argv.slice(2);
// The acquire budget comes from the environment so a probe can make a child
// give up QUICKLY instead of waiting out the (deliberately generous) stale
// window — see the "refused while another process holds the lock" case.
const reg = new WorkerRegistry({
  tsvPath: path,
  pid: Number(pidS),
  resultsDir: "results",
  lock: { attempts: Number(process.env.W9224_LOCK_ATTEMPTS ?? 25), delayMs: Number(process.env.W9224_LOCK_DELAY_MS ?? 20) },
});
writeFileSync(readyFile, "1");
const start = Date.now();
while (!existsSync(goFile)) { if (Date.now() - start > 30000) throw new Error("barrier timeout"); }
for (let i = 0; i < Number(nS); i += 1) {
  reg.upsert({ wid: wid + i, started_at: "t", status: "RUNNING", extra: "sess=s" + i });
}
process.stdout.write(String(reg.persistFailures().length));
`;

interface ChildResult {
  failures: number;
  /** "ok" when the child exited 0, otherwise its status. */
  status: string;
}

function runChild(script: string, args: readonly string[], env: Record<string, string> = {}): ChildResult {
  try {
    // cwd = the REPO ROOT (this file's package dir): the child imports
    // `registry.ts`, which imports `@celestea/core` through the repo's tsconfig
    // path alias — a temp cwd would not resolve it.
    const out = execFileSync(process.execPath, [TSX_CLI, script, ...args], {
      encoding: "utf8",
      cwd: HERE,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { failures: Number(out.trim()), status: "ok" };
  } catch (error) {
    const e = error as { status?: number | null; stdout?: string; stderr?: string };
    return { failures: -1, status: `exit ${e.status ?? "?"}: ${(e.stderr ?? "").slice(0, 200)}` };
  }
}

/** The child script + its table path, written into a fresh temp dir. */
function fixture(): { dir: string; script: string; table: string } {
  const dir = mkdtempSync(join(tmpdir(), "w9224-xproc-"));
  roots.push(dir);
  const script = join(dir, "child.ts");
  // JSON.stringify, NOT a raw interpolation: the module path is a WINDOWS path,
  // and dropping `D:\tools\...` into a JS string literal would turn `\t` into a
  // tab (measured: tsx then reports "Cannot find module 'D:<tab>ools...'").
  writeFileSync(script, CHILD_SOURCE.replace("REGISTRY_SPEC", JSON.stringify(REGISTRY_TS)), "utf8");
  return { dir, script, table: join(dir, "registry.tsv") };
}

/** Poll a filesystem/process condition with a hard ceiling (no fixed sleeps). */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Resolve with the child's exit code (null = killed). */
function exitOf(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.on("exit", (code) => resolve(code)));
}

function rowCount(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").length;
}

describe("W9224 P1-5: the table write is serialized ACROSS processes", () => {
  it("a contended write is refused while another process holds the lock, then succeeds", () => {
    const { dir, script, table } = fixture();
    // A base row that must survive whatever the child does.
    writeFileSync(table, "Wbase\t2026-09-10_12:00:00Z\tRUNNING\tproc=999\n", "utf8");
    // No barrier here: the child may start writing immediately.
    const go = join(dir, "go");
    writeFileSync(go, "1", "utf8");

    // THIS process holds the real lock, so the child is a genuine contender.
    const held = acquireTableLock(table, { attempts: 1 });
    expect(held).not.toBeNull();
    // This process deliberately holds the lock for the whole child run, so the
    // child must be given a SHORT budget: waiting out the 10 s stale window
    // would (correctly) let it take the lock over and this probe would measure
    // the stale-reclaim path instead of the contention path.
    const refused = runChild(script, [table, "W", "1111", "3", go, join(dir, "ra")], { W9224_LOCK_ATTEMPTS: "2", W9224_LOCK_DELAY_MS: "1" });
    expect(refused.status).toBe("ok");
    // One refused persist PER WRITE, each reported (fail closed, never silent).
    expect(refused.failures).toBe(3);
    // The child wrote NOTHING: the alternative is the lost update.
    expect(rowCount(table)).toBe(1);

    held?.release();
    // Same child, lock free: it now writes and the base row is still there.
    const accepted = runChild(script, [table, "W", "2222", "3", go, join(dir, "rb")]);
    expect(accepted.status).toBe("ok");
    expect(accepted.failures).toBe(0);
    expect(rowCount(table)).toBe(4);
    expect(readFileSync(table, "utf8")).toContain("Wbase");
  }, 60_000);

  /**
   * The lost-update case itself: two children released from a barrier at the
   * same instant, each writing 120 rows. Every row of BOTH must survive.
   *
   * The child loops synchronously, so without the lock one child's whole batch
   * is overwritten by the other's (measured: 292/300 rows). With the lock the
   * batches serialize and the count is exact.
   */
  it("two simultaneous writers keep EVERY row of both (no lost update)", async () => {
    const { dir, script, table } = fixture();
    const go = join(dir, "go");
    const readyA = join(dir, "readyA");
    const readyB = join(dir, "readyB");
    // Both children reach the barrier BEFORE either starts writing, so the
    // interleave is caused by real concurrency, not by a start-time skew.
    const children = [
      spawn(process.execPath, [TSX_CLI, script, table, "A", "1111", "120", go, readyA], { cwd: HERE, stdio: "ignore" }),
      spawn(process.execPath, [TSX_CLI, script, table, "B", "2222", "120", go, readyB], { cwd: HERE, stdio: "ignore" }),
    ];
    await waitFor(() => existsSync(readyA) && existsSync(readyB), "both children reached the barrier");
    writeFileSync(go, "1", "utf8");
    const exits = await Promise.all(children.map(exitOf));
    expect(exits, "both writers must exit cleanly").toEqual([0, 0]);
    // Every row of both batches: the lock serializes the read-modify-write.
    expect(rowCount(table)).toBe(240);
  }, 90_000);
});
