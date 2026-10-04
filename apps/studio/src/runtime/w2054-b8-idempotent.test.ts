/**
 * W2054 — the B8 gate (E §2.4, docs/iteration-e/02-multi-agent.md): replaying the
 * boot recovery over the SAME wid must be a NO-OP — no new row, no new receipt,
 * zero action audit lines.
 *
 * WHY THIS FILE AND NOT packages/workers/src/registry.test.ts (the 落点 column of
 * §2.4). The entry point B8 names — "对同一 wid 跑两次 recoverOnBoot()" — is the
 * studio boot PAIR, not a package function: observeWorkerTableOnBoot +
 * recoverWorkerTableOnBoot, called back to back in [createStudioApp]'s boot sweep. That pair
 * lives here, and the third assertion B8 demands ("审计 0 行") is only expressible
 * against the studio's audit channel (RecoveryAuditWriter ->
 * <data dir>/recovery-audit.jsonl). A packages/workers copy would have to fake
 * both the entry point and the audit sink, i.e. test something other than what
 * actually runs at boot. §2.7's own evidence line already lists this file.
 *
 * WHAT "ZERO ACTION" ACTUALLY MEANS — measured, not assumed (probe transcript in
 * results/W2054-b8-idempotent.md §2):
 *
 *   run 1: judge -> W701 STALE -> claim -> DONE     => 1 x worker_recovered
 *   run 2: judge -> W701 is a TERMINAL row => FROZEN (§2.2.4 row 5)
 *          => report.stale is EMPTY => applyRecovery returns [] => nothing is
 *          written and ZERO worker_recovered lines appear.
 *
 * So a fresh second boot is case (a): the settled row never reaches the executor
 * again. The claim() refusal (outcome "refused", §2.2.4) is NOT what protects a
 * fresh boot — it protects the REPLAY of run 1's own report, which is pinned
 * separately at the bottom of this file.
 *
 * ★ THE ONE DIVERGENCE FROM THE DOC'S LITERAL "审计 0 行": the P0 sweep writes its
 * worker_observed SUMMARY line on EVERY boot, even when there is nothing to
 * observe ([observeWorkerTableOnBoot] always writes its SUMMARY line; [RecoveryAuditWriter]
 * documents it as "always
 * exactly one"). The second boot therefore writes exactly ONE audit line — the
 * summary — and zero ACTION lines. Both halves are asserted below so neither can
 * drift silently; the second test names the divergence explicitly.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseRegistryTsv, type RecoveryApplied, type WorkerRecoveryReport } from "@celestea/workers";
import { RecoveryAuditWriter } from "./recovery-audit.js";
import { observeWorkerTableOnBoot, recoverWorkerTableOnBoot, type WorkerBootObservationInput } from "./worker-recovery.js";

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true });
});

const WID = "W701";
const REPORT = WID + "-ghost-a0.md";
/** One RUNNING row whose owner (pid 999999) is not alive any more. */
const ROW =
  WID + "\t2026-09-23_11:00:00Z\tRUNNING\tsess=s1 title=ghost host=ws/gone attempt=0 lease=999999@1789000000 proc=999999\n";

/** A data dir with the ghost row AND its deliverable => run 1 closes it DONE. */
function ghostDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "w2054-b8-"));
  temps.push(dir);
  writeFileSync(join(dir, "worker-registry.tsv"), ROW, "utf8");
  mkdirSync(join(dir, "worker-results"), { recursive: true });
  writeFileSync(join(dir, "worker-results", REPORT), "report\n", "utf8");
  return dir;
}

/** The audit channel's lines, in order (the file the boot really appends to). */
function auditLines(dir: string): Array<Record<string, unknown>> {
  const path = join(dir, "recovery-audit.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** worker_recovered is the ACTION line; the others are P0 judgement lines. */
const actionLines = (dir: string): string[] =>
  auditLines(dir)
    .map((e) => String(e["event"]))
    .filter((name) => name === "worker_recovered");

/** The real boot pair of app.ts, over the real audit channel and a pinned clock. */
function harness(dir: string) {
  const input: WorkerBootObservationInput = {
    path: join(dir, "worker-registry.tsv"),
    // app.ts passes a probe, so a dead host is ALSO an orphan. Both candidate
    // lists are exercised, which is why the second boot must audit neither.
    knownHost: () => false,
    resultsDir: join(dir, "worker-results"),
    audit: new RecoveryAuditWriter({ dataDir: dir, now: () => 1 }),
    env: { CELESTEA_WORKER_RECOVER: "1" },
    now: () => 1,
    warn: () => undefined,
  };
  return {
    observe: (): WorkerRecoveryReport => observeWorkerTableOnBoot(input),
    act: (report: WorkerRecoveryReport): RecoveryApplied[] | null => recoverWorkerTableOnBoot(input, report),
    /** ONE boot = the P0 observation then the P2 action ([createStudioApp]'s boot sweep). */
    boot: (): RecoveryApplied[] | null => recoverWorkerTableOnBoot(input, observeWorkerTableOnBoot(input)),
    table: (): string => readFileSync(input.path as string, "utf8"),
    results: (): string[] => readdirSync(input.resultsDir),
    events: (): string[] => auditLines(dir).map((e) => String(e["event"])),
  };
}

describe("B8 (E §2.4): a second boot over the same wid is a no-op", () => {
  it("run 2 adds no row, no receipt and no ACTION audit line", () => {
    const dir = ghostDir();
    const h = harness(dir);
    // The control half: run 1 really DOES act — otherwise "run 2 did nothing"
    // would be trivially true because run 1 did nothing either.
    expect(h.boot()?.map((a) => [a.wid, a.action, a.outcome])).toEqual([[WID, "close_done", "closed_done"]]);
    const tableAfterFirst = h.table();
    const resultsAfterFirst = h.results();
    expect(actionLines(dir)).toEqual(["worker_recovered"]);

    const report = h.observe();
    // THE MECHANISM: a terminal row is frozen, so it is not even a candidate.
    expect(report.stale).toEqual([]);
    expect(report.orphans).toEqual([]);
    expect(report.frozen).toEqual([WID]);
    const second = h.act(report);

    // (1) NO NEW ROW: same line count, same bytes.
    expect(parseRegistryTsv(h.table()).entries).toHaveLength(1);
    expect(h.table()).toBe(tableAfterFirst);
    // (2) NO NEW RECEIPT / report file: the results dir is the same set.
    expect(h.results()).toEqual(resultsAfterFirst);
    expect(h.results()).toEqual([REPORT]);
    // (3) ZERO ACTION AUDIT LINES: the second boot appends no worker_recovered.
    expect(actionLines(dir)).toEqual(["worker_recovered"]);
    // ...and the executor reports zero actions: the same fact from the other
    // side (an EMPTY array, not an array of refusals).
    expect(second).toEqual([]);
  });

  it("★ the divergence: the P0 sweep still appends ONE summary line per boot", () => {
    const dir = ghostDir();
    const h = harness(dir);
    h.boot();
    const first = h.events();
    h.boot();
    const second = h.events();

    // The doc's literal "审计 0 行" cannot hold for the boot PAIR: the sweep's
    // summary write is unconditional. Exactly one line, and it is the summary.
    expect(second.slice(first.length)).toEqual(["worker_observed"]);
    // What IS zero is the ACTION half — and that is what the executor owns.
    expect(second.filter((e) => e === "worker_recovered")).toHaveLength(1);
    expect(first.filter((e) => e === "worker_recovered")).toHaveLength(1);
  });
});

describe("B8 (b): replaying run 1's OWN report is refused, not re-executed", () => {
  it("a stale report handed to the executor twice yields refused + an audited refusal", () => {
    const dir = ghostDir();
    const h = harness(dir);
    const report = h.observe();
    expect(h.act(report)?.map((a) => [a.wid, a.outcome])).toEqual([[WID, "closed_done"]]);
    const tableAfterFirst = h.table();
    const resultsAfterFirst = h.results();
    const actionsAfterFirst = actionLines(dir);

    // The SAME judgement — a report object that still names W701 as stale — is
    // handed to the executor again. This is the replay claim() exists for.
    expect(h.act(report)?.map((a) => [a.wid, a.outcome, a.reason])).toEqual([
      [WID, "refused", "row is not claimable (owned, frozen or another host's)"],
    ]);
    expect(h.table()).toBe(tableAfterFirst);
    expect(h.results()).toEqual(resultsAfterFirst);

    // ★ CHARACTERIZATION, NOT CONTRACT: the refusal is still AUDITED, so this
    // replay does add a worker_recovered line (detail outcome=refused).
    // §2.2.4 calls the replay "zero action"; the audit channel counts the
    // refusal as one. Pinned so the divergence stays visible — see
    // results/W2054-b8-idempotent.md §4 for why this is not a defect of the
    // executor (a refused row is a fact worth auditing) but IS a doc gap.
    expect(actionLines(dir)).toEqual([...actionsAfterFirst, "worker_recovered"]);
    expect(auditLines(dir).at(-1)).toMatchObject({
      event: "worker_recovered",
      wid: WID,
      action: "close_done",
      detail: "outcome=refused",
    });
  });
});
