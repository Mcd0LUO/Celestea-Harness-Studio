/**
 * W9224 P1-6 — the boot converger must not settle another conversation's rows.
 *
 * The defect: `recoverWorkerTableOnBoot` built its `WorkerRegistry` WITHOUT a
 * `hostSessionId`, and `mayInherit` answers "yes" for every row when the host is
 * null. So the `host=` guard that keeps one conversation out of another's rows
 * did not exist on the one path that writes rows without a session — with
 * `CELESTEA_WORKER_RECOVER=1` that is a real write, not a theoretical risk.
 *
 * The fix does NOT simply declare the studio's own host (the converger runs
 * before any session exists). It declares the SCOPE explicitly, which is both
 * safe (the table is the studio's own, per the schema's R2-1 ownership rule) and
 * necessary (a dead host's row is exactly what must converge — that is P1-3).
 *
 * The mutation is recorded in results/W9224-修复.md §3: deleting the
 * `mayAdoptHost` line turns the first case red.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerRegistry } from "@celestea/workers";
import { observeWorkerTableOnBoot, recoverWorkerTableOnBoot } from "./worker-recovery.js";

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true });
});

/** The boot converger's OWN constructor shape, as the product builds it. */
function bootRegistry(path: string, scope: ((host: string) => boolean) | undefined): WorkerRegistry {
  return new WorkerRegistry({ tsvPath: path, resultsDir: join(path, "..", "results"), mayAdoptHost: scope });
}

/** One dead RUNNING row naming a host conversation. */
const ROW = (host: string): string =>
  `W701\t2026-09-23_11:00:00Z\tRUNNING\tsess=s1 title=ghost host=${host} attempt=0 lease=999999@1789000000 proc=999999\n`;

function tempTable(): string {
  const dir = mkdtempSync(join(tmpdir(), "w9224-boot-"));
  temps.push(dir);
  return join(dir, "worker-registry.tsv");
}

describe("W9224 P1-6: a hostless registry needs an EXPLICIT scope to take a row over", () => {
  it("a hostless registry with NO scope refuses a row that names a host", () => {
    const path = tempTable();
    writeFileSync(path, ROW("celestea_studio-ts/OTHER"), "utf8");
    const before = readFileSync(path, "utf8");
    const hostless = bootRegistry(path, undefined);
    expect(hostless.claim("W701", () => false)).toBeNull();
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("the SAME registry takes it over once the scope is declared", () => {
    const path = tempTable();
    writeFileSync(path, ROW("celestea_studio-ts/OTHER"), "utf8");
    const scoped = bootRegistry(path, (host) => host === "celestea_studio-ts/OTHER");
    expect(scoped.claim("W701", () => false)?.status).toBe("RUNNING");
    expect(readFileSync(path, "utf8")).toContain("claimed=");
  });

  it("the real boot converger declares the scope, so a dead host still converges", () => {
    const dir = mkdtempSync(join(tmpdir(), "w9224-boot-real-"));
    temps.push(dir);
    const path = join(dir, "worker-registry.tsv");
    writeFileSync(path, ROW("celestea_studio-ts/DEAD"), "utf8");
    const input = {
      path,
      resultsDir: join(dir, "worker-results"),
      env: { CELESTEA_WORKER_RECOVER: "1" },
      now: () => 1,
      warn: () => undefined,
    };
    const applied = recoverWorkerTableOnBoot(input, observeWorkerTableOnBoot(input));
    // P1-3's whole point: a DEAD host's stale row must still converge at boot.
    expect(applied?.map((a) => [a.wid, a.outcome])).toEqual([["W701", "failed"]]);
    expect(readFileSync(path, "utf8")).toContain("FAILED");
  });
});
