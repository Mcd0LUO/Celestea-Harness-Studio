/**
 * W2020 — the P12 failure is now DETECTABLE (the end marker moved to the caller).
 *
 * W2018 installed the pair but registered an honest boundary: the end marker was
 * appended by runCompaction itself, i.e. BEFORE compactSession rebound the
 * engine, so the failure docs/pitfalls.md P12 names — the log has already been
 * atomically replaced, and the rebind then fails, leaving the history only in
 * cli-main.jsonl.precompact — happened after the pair was already complete and
 * left a log that looked FINISHED.
 *
 * The claim under test here is the one W2018 could not make:
 *
 *   1. ★ rewrite succeeds + REBIND FAILS  => the log keeps an UNPAIRED start
 *      (hasUnpairedCompactionStart === true), and the failure still surfaces;
 *   2. rewrite succeeds + REBIND SUCCEEDS => the pair is CLOSED (false);
 *   3. the SKIP branch (history too short) writes NO marker at all — an end
 *      there would be an ORPHAN end, not a completion.
 *
 * The section 2-(1) claim about CompactionResult.events lives next to the code
 * that owns it: packages/runtime/src/compact/w2020-end-ownership.test.ts.
 *
 * Every gate below was mutation-checked (red -> restore -> green); the
 * transcripts are in the W2020 report.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@celestea/core";
import { PersistentSessionLog } from "@celestea/session";
import {
  SESSION_LOG_ID,
  SessionRuntimeRegistry,
  compactionMarkers,
  hasUnpairedCompactionStart,
  parseEventLog,
  serializeEventLog,
  type Runtime,
} from "@celestea/runtime";
import { EngineError } from "../runtime-adapter.js";
import { compactSession } from "./session-lifecycle.js";

const SESSION = "sample-ws/s1";
const LOG = "cli-main.jsonl";
const BACKUP = "cli-main.jsonl.precompact";

/** n complete turns. 9 > COMPACT_THRESHOLD (8) so compaction plans; 3 does not. */
function turns(n: number): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (let i = 1; i <= n; i++) {
    const id = "turn-" + i;
    events.push({ type: "turn_start", id });
    events.push({ type: "user_message", text: "问 " + i });
    events.push({ type: "assistant_message", text: "答 " + i });
    events.push({ type: "turn_end", id, outcome: "completed" });
  }
  return events;
}

function makeDir(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), "celestea-w2020-rebind-"));
  writeFileSync(join(dir, LOG), serializeEventLog(turns(n)));
  return dir;
}

/** What is actually on disk right now (the only source of truth for the gates). */
function onDisk(dir: string): SessionEvent[] {
  return parseEventLog(readFileSync(join(dir, LOG), "utf8"));
}

/**
 * A registry of REAL persistent logs whose build FAILS from call failFrom on.
 *
 * The first ensure (the test own setup) composes a live instance; the
 * compaction evicts it; the ensure that follows the rewrite is the REBIND, and
 * that is the call made to throw — exactly the P12 window, and the only way to
 * reach it from the real compactSession rather than a mock of it.
 */
function registryFailingRebind(dir: string, failFrom: number): SessionRuntimeRegistry {
  let builds = 0;
  return new SessionRuntimeRegistry({
    build: (_sessionId, targetDir) => {
      builds += 1;
      if (builds >= failFrom) throw new Error("模拟：重绑引擎失败（compose 抛错）");
      return { session: PersistentSessionLog.open(targetDir ?? dir, SESSION_LOG_ID) } as unknown as Runtime;
    },
    dispose: (runtime) => (runtime.session as PersistentSessionLog).close(),
  });
}

/** A registry whose instances are real persistent logs and whose rebind succeeds. */
function healthyRegistry(dir: string): SessionRuntimeRegistry {
  return registryFailingRebind(dir, Number.POSITIVE_INFINITY);
}

const deps = (registry: SessionRuntimeRegistry, dir: string) => ({
  registry,
  resolve: () => ({ sessionId: SESSION, dir }),
  summarizer: () => async () => "摘要",
});

describe("W2020 · ★ the P12 rebind failure is detectable", () => {
  it("★ leaves an UNPAIRED compaction_start when the rewrite lands but the rebind fails", async () => {
    const dir = makeDir(9);
    const registry = registryFailingRebind(dir, 2); // build #1 = setup, #2 = the rebind
    registry.ensure(SESSION, dir);

    await expect(compactSession(deps(registry, dir), SESSION)).rejects.toThrow(/重绑引擎失败/);

    const written = onDisk(dir);
    // THE core claim: the rewrite landed (start + compacted history) and the pair
    // was NEVER closed, because the step that closes it is the rebind.
    const census = compactionMarkers(written);
    expect(census.starts).toBe(1);
    expect(census.ends).toBe(0);
    expect(hasUnpairedCompactionStart(written)).toBe(true);
    // The state is genuinely "compacted but unfinished", not "untouched": the
    // pre-compaction history is gone from the log and survives only in the
    // single-copy backup (the P12 rollback edge).
    expect(written[0]?.type).toBe("compaction_start");
    expect(readFileSync(join(dir, BACKUP), "utf8")).toBe(serializeEventLog(turns(9)));
  });

  it("surfaces the rebind failure as an EngineError (HTTP 500), not a silent success", async () => {
    const dir = makeDir(9);
    const registry = registryFailingRebind(dir, 2);
    registry.ensure(SESSION, dir);

    // A swallowed rebind failure would report "compacted" over a log the engine
    // is not serving — the false-success W825 P0 was about.
    await expect(compactSession(deps(registry, dir), SESSION)).rejects.toBeInstanceOf(EngineError);
  });

  it("still closes the pair when the rebind SUCCEEDS", async () => {
    const dir = makeDir(9);
    const registry = healthyRegistry(dir);
    const before = registry.ensure(SESSION, dir);

    const out = await compactSession(deps(registry, dir), SESSION);

    expect(out.compacted).toBe(true);
    expect(out.rebound).toBe(true);
    const written = onDisk(dir);
    const census = compactionMarkers(written);
    expect(census.starts).toBe(1);
    expect(census.ends).toBe(1);
    expect(hasUnpairedCompactionStart(written)).toBe(false);
    // Position, not just presence: the end follows the compacted history.
    expect(written[written.length - 1]?.type).toBe("compaction_end");
    expect(registry.peek(SESSION)?.runtime).not.toBe(before.runtime);
  });

  it("closes the pair for a session with NO live instance (nothing to rebind)", async () => {
    const dir = makeDir(9);
    const registry = healthyRegistry(dir);

    const out = await compactSession(deps(registry, dir), SESSION);

    expect(out.compacted).toBe(true);
    expect(out.rebound).toBe(false); // no instance existed, so none was rebuilt
    expect(hasUnpairedCompactionStart(onDisk(dir))).toBe(false);
  });
});

describe("W2020 · section 2-(3): the skip branch writes NO marker (no orphan end)", () => {
  it("★ leaves a short history byte-identical — no start, no end", async () => {
    const dir = makeDir(3); // below COMPACT_THRESHOLD: runCompaction returns compacted:false
    const registry = healthyRegistry(dir);
    registry.ensure(SESSION, dir);
    const before = readFileSync(join(dir, LOG), "utf8");

    const out = await compactSession(deps(registry, dir), SESSION);

    expect(out.compacted).toBe(false);
    // Byte-identical: an end here would be an ORPHAN (it closes a pair this
    // compaction never opened), and would make a healthy session look broken.
    expect(readFileSync(join(dir, LOG), "utf8")).toBe(before);
    expect(onDisk(dir).some((e) => e.type === "compaction_end")).toBe(false);
    expect(existsSync(join(dir, BACKUP))).toBe(false);
  });
});
