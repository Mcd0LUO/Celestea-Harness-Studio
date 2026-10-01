/**
 * Phase 0b resident turn-context dedup — the three-state machine
 * (docs/feature-memory-extraction.md §4):
 *
 *   1. changed (or never injected) → append;
 *   2. unchanged and still model-visible → skip;
 *   3. unchanged but trimmed/compacted out of the view → re-inject.
 *
 * plus the TurnRunner wiring (a regression to unconditional appends must fail
 * here, not in production logs).
 */

import { describe, expect, it } from "vitest";
import { defaultAgentConfig, type AgentConfig, type SessionLog } from "@celestea/core";
import { InMemorySessionLog } from "@celestea/session";
import { trimContext } from "@celestea/agent-loop";
import { selectTurnContextRows, type ResidentContextRow } from "./turn-context-dedup.js";
import { compose } from "./compose.js";
import { fakeLoop, memoryLog, memorySessionPlugin, testProfile } from "./fakes.test-util.js";

const SKILL: ResidentContextRow = { text: "SKILL-CATALOG-V1", origin: "skill" };
const MEMORY: ResidentContextRow = { text: "MEMORY-CONTEXT-V1", origin: "memory" };

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { ...defaultAgentConfig(), system_prompt: "", ...overrides };
}

/** Append a row exactly the way TurnRunner.injectTurnContext does. */
function inject(log: SessionLog, row: ResidentContextRow): void {
  log.append({ type: "user_message", text: row.text, origin: row.origin });
}

/** Append `count` filler exchanges so trimming has something to cut. */
function fill(log: SessionLog, count: number): void {
  for (let i = 0; i < count; i++) {
    log.append({ type: "user_message", text: `filler question number ${i}` });
    log.append({ type: "assistant_message", text: `filler answer number ${i}` });
  }
}

describe("selectTurnContextRows", () => {
  it("appends every row on an empty log (never injected)", () => {
    const log = InMemorySessionLog.create();
    expect(selectTurnContextRows(log, [SKILL, MEMORY], config())).toEqual([SKILL, MEMORY]);
  });

  it("skips an unchanged row that is still model-visible", () => {
    const log = InMemorySessionLog.create();
    inject(log, SKILL);
    inject(log, MEMORY);
    fill(log, 2);
    expect(selectTurnContextRows(log, [SKILL, MEMORY], config())).toEqual([]);
  });

  it("appends a row whose text changed since the last injection", () => {
    const log = InMemorySessionLog.create();
    inject(log, SKILL);
    const updated: ResidentContextRow = { text: "SKILL-CATALOG-V2", origin: "skill" };
    expect(selectTurnContextRows(log, [updated], config())).toEqual([updated]);
  });

  it("re-injects an unchanged row that trimming has cut from the view", () => {
    const log = InMemorySessionLog.create();
    inject(log, SKILL);
    fill(log, 30);
    const cfg = config({ context_window_tokens: 100 });
    // Fixture precondition: the trim really engages and cuts the head.
    const sim = trimContext(log.deriveMessages(), 0, cfg.context_window_tokens, cfg.context_trim_threshold, cfg.context_keep_recent);
    expect(sim.outcome.trimmed).toBe(true);
    expect(sim.outcome.removedMessages).toBeGreaterThan(0);
    expect(selectTurnContextRows(log, [SKILL], cfg)).toEqual([SKILL]);
  });

  it("keeps skipping when the row survives the cut (recent tail)", () => {
    const log = InMemorySessionLog.create();
    fill(log, 30);
    inject(log, SKILL); // lands inside the keep-recent tail
    const cfg = config({ context_window_tokens: 100 });
    const sim = trimContext(log.deriveMessages(), 0, cfg.context_window_tokens, cfg.context_trim_threshold, cfg.context_keep_recent);
    expect(sim.outcome.trimmed).toBe(true);
    expect(selectTurnContextRows(log, [SKILL], cfg)).toEqual([]);
  });

  it("tracks origins independently", () => {
    const log = InMemorySessionLog.create();
    inject(log, SKILL);
    inject(log, MEMORY);
    const updated: ResidentContextRow = { text: "MEMORY-CONTEXT-V2", origin: "memory" };
    expect(selectTurnContextRows(log, [SKILL, updated], config())).toEqual([updated]);
  });

  it("does not mistake human input with identical text for an injection", () => {
    const log = InMemorySessionLog.create();
    log.append({ type: "user_message", text: SKILL.text }); // no origin = the human
    expect(selectTurnContextRows(log, [SKILL], config())).toEqual([SKILL]);
  });

  it("re-injects when the log no longer contains the row (compaction)", () => {
    const log = InMemorySessionLog.create();
    inject(log, SKILL);
    log.clear(); // a compaction rewrite removes the old rows
    expect(selectTurnContextRows(log, [SKILL], config())).toEqual([SKILL]);
  });

  it("resolves legacy duplicates to the last surviving copy", () => {
    const log = InMemorySessionLog.create();
    inject(log, SKILL);
    fill(log, 30);
    inject(log, SKILL); // duplicate near the tail — pre-0b logs look like this
    const cfg = config({ context_window_tokens: 100 });
    expect(selectTurnContextRows(log, [SKILL], cfg)).toEqual([]);
  });

  it("drops blank rows without touching the log", () => {
    const log = InMemorySessionLog.create();
    expect(selectTurnContextRows(log, [{ text: "", origin: "skill" }], config())).toEqual([]);
  });
});

describe("TurnRunner wiring", () => {
  it("appends an unchanged resident row only once across turns", async () => {
    const log = memoryLog();
    const rows: ResidentContextRow[] = [{ text: "SKILL-CATALOG", origin: "skill" }];
    const loop = fakeLoop(() => ({ outcome: "completed" }));
    const runtime = compose({
      profile: testProfile(),
      plugins: [memorySessionPlugin(log)],
      loopFactory: loop.factory,
      turnContext: () => rows,
      workers: false,
    });
    await runtime.runTurn("first question");
    await runtime.runTurn("second question");
    // The fake loop appends the human input itself (no origin); the resident
    // row carries origin "skill" and must appear exactly once.
    const injected = log.events().filter((ev) => ev.type === "user_message" && ev.origin === "skill");
    expect(injected).toHaveLength(1);
  });

  it("injects again on the turn after the row leaves the trimmed view", async () => {
    const log = memoryLog();
    const rows: ResidentContextRow[] = [{ text: "SKILL-CATALOG", origin: "skill" }];
    const loop = fakeLoop(() => ({ outcome: "completed" }));
    // A tiny context window makes trimContext cut the resident row between the
    // two turns; the runner must notice and re-inject (state 3).
    const runtime = compose({
      profile: testProfile({ context_window_tokens: 100 }),
      plugins: [memorySessionPlugin(log)],
      loopFactory: loop.factory,
      turnContext: () => rows,
      workers: false,
    });
    await runtime.runTurn("first question");
    // Bury the resident row under enough history that the next turn's
    // simulation trims it out of the view.
    for (let i = 0; i < 30; i++) {
      log.append({ type: "user_message", text: "filler question number " + i });
      log.append({ type: "assistant_message", text: "filler answer number " + i });
    }
    await runtime.runTurn("second question");
    const injected = log.events().filter((ev) => ev.type === "user_message" && ev.origin === "skill");
    expect(injected).toHaveLength(2);
  });
});
