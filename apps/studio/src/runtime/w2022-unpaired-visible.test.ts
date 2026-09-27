/**
 * W2022 — the P12 signal is now OPERATOR-VISIBLE (the dead detector gets a home).
 *
 * W2018/W2020 built `hasUnpairedCompactionStart` and its two markers, and W2020
 * moved the closing append into the caller so "rewrite landed, rebind failed"
 * leaves an unpaired `compaction_start`. Until this change NOTHING in production
 * ever called the detector — the state was detectable on disk and invisible to
 * every operator. It is now a field of `GET /api/status.recovery` (an EXISTING
 * endpoint, no new route), built from the same `log.events()` the sibling
 * `dangling_turns` is counted from: the markers are log-structural rows, so they
 * ARE in `events()` even though `deriveMessages()` projects them to nothing.
 *
 * The claims under test:
 *
 *   1. a log whose LAST `compaction_start` has no `compaction_end` => the block
 *      reports it (and the pre-compaction history really is gone from the log
 *      while `cli-main.jsonl.precompact` holds it — the P12 rollback edge);
 *   2. a log whose pair IS closed => not reported;
 *   3. a log with NO marker at all (EVERY production session today) => the block
 *      is field-for-field what it was BEFORE this change;
 *   4. `emptyRecoveryView` (no live instance) answers `unpaired_compaction:false`
 *      — the §2② decision: the block describes the LIVE generation and never
 *      opens a log of its own, so the value is asserted at exactly the strength
 *      the sibling `degraded:false` already is;
 *   5. the judgement is about the TRAILING marker: a log carrying an older,
 *      COMPLETED compaction still reports false.
 *
 * Every gate below was mutation-checked (red -> restore -> green); the three
 * transcripts are in the W2022 report.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "@celestea/core";
import { PersistentSessionLog } from "@celestea/session";
import { hasUnpairedCompactionStart, serializeEventLog } from "@celestea/runtime";
import { emptyRecoveryView, recoveryViewOf } from "./recovery-view.js";
import { getJson, type StudioHarness } from "../harness.test-util.js";
import { activate, makeEngineHarness, turns, type EngineHarnessOptions } from "./test-util.js";

const SESSION = "sample-ws/s1";
const LOG = "cli-main.jsonl";
/** The single-copy backup `rewriteAtomic` makes before it replaces the log. */
const BACKUP = "cli-main.jsonl.precompact";

const harnesses: StudioHarness[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function make(opts: EngineHarnessOptions = {}): StudioHarness {
  const h = makeEngineHarness(opts);
  harnesses.push(h);
  return h;
}

/** A temp session dir holding `events` as its `cli-main.jsonl`. */
function plantedLog(events: readonly SessionEvent[]): string {
  const dir = mkdtempSync(join(tmpdir(), "celestea-w2022-unpaired-"));
  dirs.push(dir);
  writeFileSync(join(dir, LOG), serializeEventLog(events));
  return dir;
}

/**
 * The EXACT P12 on-disk state, built the way the production pair builds it: the
 * compacted log STARTS with the marker (it rides inside the atomic rewrite) and
 * a `.precompact` copy of the pre-compaction history sits next to it. No end
 * row — that is what "rewrite landed, rebind failed" leaves behind.
 */
function p12Log(): string {
  // The pre-compaction history held turns 0..4; the compacted log kept only the
  // tail (0,1). Turn 4 is therefore the row that exists ONLY in the backup.
  const dir = plantedLog([{ type: "compaction_start" }, ...turns(2)]);
  writeFileSync(join(dir, BACKUP), serializeEventLog(turns(5)));
  return dir;
}

/** A COMPLETED compaction: the same rewrite, with the caller's append landed. */
function completedLog(): string {
  return plantedLog([{ type: "compaction_start" }, ...turns(2), { type: "compaction_end" }]);
}

/** The block for a REAL persistent log over `dir`, plus what the log holds. */
function blockOf(dir: string): { block: Record<string, unknown>; unpaired: boolean; projected: string } {
  const log = PersistentSessionLog.open(dir, "cli-main");
  try {
    return {
      block: recoveryViewOf(log, SESSION) as unknown as Record<string, unknown>,
      unpaired: hasUnpairedCompactionStart(log.events()),
      projected: JSON.stringify(log.deriveMessages()),
    };
  } finally {
    log.close();
  }
}

/** What the operator's poll actually answers (`GET /api/status.recovery`). */
async function recoveryFrom(h: StudioHarness): Promise<Record<string, unknown>> {
  const status = await getJson(h.app, `/api/status?session=${encodeURIComponent(SESSION)}`);
  return status.body["recovery"] as Record<string, unknown>;
}

describe("W2022 · the unpaired compaction_start is visible on GET /api/status.recovery", () => {
  it("★ reports an unpaired start, with the pre-compaction history surviving ONLY in the backup", () => {
    const dir = p12Log();
    const { block, unpaired } = blockOf(dir);

    expect(block["unpaired_compaction"]).toBe(true);
    // The field is the DETECTOR's answer, not a second opinion computed here.
    expect(unpaired).toBe(true);
    // The failure is REAL, not just a flag: the pre-compaction turns are gone
    // from the log and the backup is the single rollback edge P12 names.
    expect(readFileSync(join(dir, LOG), "utf8")).not.toContain("问 4");
    expect(readFileSync(join(dir, BACKUP), "utf8")).toContain("问 4");
    // The rest of the block is untouched by the marker: a P12 log can be
    // perfectly closed TURN-wise, which is why this is not `dangling_turns`.
    expect(block["dangling_turns"]).toBe(0);
    expect(block["session"]).toBe(SESSION);
  });

  it("does NOT report a log whose pair is closed (rewrite + successful rebind)", () => {
    const { block, unpaired } = blockOf(completedLog());

    expect(block["unpaired_compaction"]).toBe(false);
    expect(unpaired).toBe(false);
    expect(block["dangling_turns"]).toBe(0);
  });

  it("is about the TRAILING marker: an OLDER completed compaction still reports false", () => {
    const dir = plantedLog([
      { type: "compaction_start" },
      ...turns(2),
      { type: "compaction_end" },
      { type: "compaction_start" },
      ...turns(1),
      { type: "compaction_end" },
    ]);

    expect(blockOf(dir).block["unpaired_compaction"]).toBe(false);
  });

  it("★ a log with NO marker (every production session today) is field-for-field unchanged", () => {
    const { block } = blockOf(plantedLog(turns(2)));

    // ④ of the task: the addition changed no existing answer. The four
    // pre-W2022 fields are asserted as a whole, exactly as the block answered
    // before this change.
    expect(block).toEqual({
      session: SESSION,
      recovered_turns: [],
      dangling_turns: 0,
      unpaired_compaction: false,
      degraded: false,
      last_outcome: "completed",
    });
    const withoutNewKey = { ...block };
    delete withoutNewKey["unpaired_compaction"];
    expect(withoutNewKey).toEqual({ session: SESSION, recovered_turns: [], dangling_turns: 0, degraded: false, last_outcome: "completed" });
  });

  it("emptyRecoveryView: no live instance answers false (the §2② decision)", () => {
    expect(emptyRecoveryView(SESSION)).toEqual({
      session: SESSION,
      recovered_turns: [],
      dangling_turns: 0,
      unpaired_compaction: false,
      degraded: false,
      last_outcome: null,
    });
    // `recoveryViewOf(null, …)` IS the empty block — the same decision, reached
    // by the adapter path when the session has no live generation.
    expect(recoveryViewOf(null, SESSION)).toEqual(emptyRecoveryView(SESSION));
  });
});

describe("W2022 · the HOST path: GET /api/status.recovery carries the signal", () => {
  it("★ the operator sees a planted P12 log as unpaired_compaction:true", async () => {
    const dir = p12Log();
    const h = make({
      sessions: { s1: [{ type: "compaction_start" }, ...turns(2)] },
      rawFiles: { "sample-ws/s1/cli-main.jsonl.precompact": readFileSync(join(dir, BACKUP), "utf8") },
    });
    await activate(h, SESSION);

    const recovery = await recoveryFrom(h);
    expect(recovery["unpaired_compaction"]).toBe(true);
    // Same block, same session, same EXISTING endpoint.
    expect(recovery["session"]).toBe(SESSION);
    expect(recovery["dangling_turns"]).toBe(0);
  });

  it("a normal session answers false over the same endpoint", async () => {
    const h = make({ sessions: { s1: turns(2) } });
    await activate(h, SESSION);

    expect((await recoveryFrom(h))["unpaired_compaction"]).toBe(false);
  });

  it("a session with NO live instance answers the empty block (false), never a composed engine", async () => {
    // Deliberately NOT activated: the marker is on disk and the block still
    // answers false, because a status poll never composes an instance. This is
    // the honest boundary of the field — see the §2② answer in the report.
    const h = make({ sessions: { s1: [{ type: "compaction_start" }, ...turns(2)] } });
    expect(await recoveryFrom(h)).toEqual({
      session: SESSION,
      recovered_turns: [],
      dangling_turns: 0,
      unpaired_compaction: false,
      degraded: false,
      last_outcome: null,
    });
  });

  it("the marker really is read off the session's own log", async () => {
    const h = make({ sessions: { s1: [{ type: "compaction_start" }, ...turns(2), { type: "compaction_end" }] } });
    await activate(h, SESSION);
    expect((await recoveryFrom(h))["unpaired_compaction"]).toBe(false);
    expect(readFileSync(join(h.workspace, "s1", LOG), "utf8").startsWith('{"type":"compaction_start"}')).toBe(true);
  });
});

describe("W2022 · the detector is imported, not re-implemented", () => {
  it("recovery-view.ts calls the runtime rule and owns no marker scan of its own", () => {
    const source = readFileSync(new URL("./recovery-view.ts", import.meta.url), "utf8");
    expect(source).toContain('from "@celestea/runtime"');
    expect(source).toContain("hasUnpairedCompactionStart(events)");
    // A second, hand-rolled scan would be free to drift from markers.ts' rule.
    expect(source).not.toContain('=== "compaction_start"');
    expect(source).not.toContain("compactionMarkers");
  });

  it("reads `events()`, the seam that carries the markers (the projection drops them)", () => {
    const { unpaired, projected } = blockOf(p12Log());
    expect(unpaired).toBe(true);
    // This is WHY the field cannot be built from `deriveMessages()`: the markers
    // are log-structural rows and project to nothing (W2018's byte-identity).
    expect(projected).not.toContain("compaction");
  });
});
