/**
 * W9331 — the retroactive decontamination layer, end to end.
 *
 * The claim this file has to earn is specific: a degenerate turn that is ALREADY in
 * the append-only log stops being replayed to the model, while **every original
 * byte stays in the log**. That is two assertions, and the second is the one that
 * matters — a "cleanup" that actually deleted history would pass a naive test.
 *
 * The mechanism under test is the repo's existing compression overlay
 * (`compressedLog` -> `deriveMessages`), reached through the same API surface the
 * `compress` tool uses. So these tests also pin that the port did NOT invent a
 * second surface-replacement path.
 *
 * ⚠️ The subject judged here is the model-VISIBLE text (`assistant_message`), NOT
 * reasoning. `projection.ts` projects `thinking_delta` to `null`, so reasoning in
 * this repo is never replayed — see the module header for the measurement and why
 * shadowing on reasoning would be actively harmful. One test below pins that
 * reasoning alone never triggers a shadowing.
 */

import { describe, expect, it } from "vitest";
import { InMemorySessionLog, MemoryCompressionStore, compressedLog } from "@celestea/session";
import type { SessionEvent, SessionLog } from "@celestea/core";
import { degenerateVerdict, findDegenerateTurns } from "@celestea/agent-loop";
import { cleanupTargetOf, shadowDegenerateTurns, type CleanupTarget } from "./repetition-cleanup.js";

/** The production collapse shape: "OK. Let me write. Let me go." xN. */
const COLLAPSE = "OK. Let me write. Let me go. ".repeat(200);

/** Healthy, varied prose that clears `minWindowChars` without looking repetitive. */
const HEALTHY_TEXT = Array.from(
  { length: 40 },
  (_, i) => `Step ${i} verifies shard ${(i * 7) % 251} against checksum ${i * 31}.`,
).join(" ");

/**
 * A log of `turns` degenerate turns followed by one healthy turn.
 *
 * The healthy trailing turn matters: `validateRange` refuses to cover the turn in
 * flight, so a log whose LAST turn is degenerate has nothing shadowable. That is
 * the engine's own rule, not a limitation of this module — and it is worth a test.
 */
function degenerateLog(turns: number, opts: { healthyTail?: boolean; toolCallIn?: number } = {}): InMemorySessionLog {
  const log = new InMemorySessionLog();
  for (let t = 0; t < turns; t++) {
    log.append({ type: "turn_start", id: `turn-${t}` });
    log.append({ type: "thinking_delta", text: `reasoning for turn ${t}` });
    log.append({ type: "assistant_message", text: COLLAPSE });
    if (opts.toolCallIn === t) log.append({ type: "tool_call", id: `c${t}`, name: "read_file", args: {} });
    log.append({ type: "turn_end", id: `turn-${t}`, outcome: "completed" });
  }
  if (opts.healthyTail !== false) {
    const t = turns;
    log.append({ type: "turn_start", id: `turn-${t}` });
    log.append({ type: "thinking_delta", text: "checked the shard index" });
    log.append({ type: "assistant_message", text: HEALTHY_TEXT });
    log.append({ type: "turn_end", id: `turn-${t}`, outcome: "completed" });
  }
  return log;
}

/** A log of one healthy turn only (the negative control). */
function healthyLog(): InMemorySessionLog {
  const log = new InMemorySessionLog();
  log.append({ type: "turn_start", id: "turn-0" });
  log.append({ type: "thinking_delta", text: "thought about it" });
  log.append({ type: "assistant_message", text: HEALTHY_TEXT });
  log.append({ type: "turn_end", id: "turn-0", outcome: "completed" });
  return log;
}

/** The decorated pair: the overlay the model sees, and the store underneath it. */
function decorate(log: SessionLog): { view: SessionLog; store: MemoryCompressionStore } {
  const store = new MemoryCompressionStore();
  return { view: compressedLog(log, store), store };
}

/**
 * The target of a DECORATED log, asserted non-null at the call site.
 *
 * `cleanupTargetOf` returns `null` for a log with no overlay — that is the
 * behaviour its own test pins. Every other test here decorates first, so a `null`
 * would mean the fixture stopped being decorated; failing loudly keeps such a test
 * from passing by silently doing nothing.
 */
function targetOf(view: SessionLog): CleanupTarget {
  const target = cleanupTargetOf(view);
  if (target === null) throw new Error("the fixture log must be decorated with a compression store");
  return target;
}

describe("W9331 findDegenerateTurns · the offline scan", () => {
  it("finds a degenerate turn and reports its model-visible size", () => {
    const found = findDegenerateTurns(degenerateLog(1).events());
    expect(found).toHaveLength(1);
    expect(found[0]?.turn).toBe(0);
    expect(found[0]?.chars).toBe(COLLAPSE.length);
    expect(found[0]?.hasToolCall).toBe(false);
  });

  it("stays silent on healthy text (the negative control)", () => {
    expect(findDegenerateTurns(healthyLog().events())).toEqual([]);
  });

  it("does NOT shadow a turn whose only fault is degenerate REASONING (this repo's divergence)", () => {
    // `thinking_delta` projects to null, so it is never replayed and cannot prime
    // the next request. Shadowing here would delete a healthy answer to hide text
    // the model never saw — strictly harmful. The reasoning size is still reported.
    const log = new InMemorySessionLog();
    log.append({ type: "turn_start", id: "turn-0" });
    log.append({ type: "thinking_delta", text: COLLAPSE });
    log.append({ type: "assistant_message", text: "The shard reindex completed successfully." });
    log.append({ type: "turn_end", id: "turn-0", outcome: "completed" });
    expect(findDegenerateTurns(log.events())).toEqual([]);
  });

  it("reports `hasToolCall` instead of deciding, so the caller can skip it", () => {
    const found = findDegenerateTurns(degenerateLog(2, { toolCallIn: 0 }).events());
    // Both turns are degenerate; only the first carries a tool call.
    expect(found.filter((e) => e.hasToolCall).map((e) => e.turn)).toEqual([0]);
    expect(found.map((e) => e.turn)).toEqual([0, 1]);
  });

  it("accumulates PER TURN, so one healthy turn cannot dilute another", () => {
    const events: SessionEvent[] = [
      { type: "turn_start", id: "turn-0" },
      { type: "assistant_message", text: COLLAPSE },
      { type: "turn_end", id: "turn-0", outcome: "completed" },
      { type: "turn_start", id: "turn-1" },
      { type: "assistant_message", text: "A short, entirely healthy answer about the shard layout." },
      { type: "turn_end", id: "turn-1", outcome: "completed" },
    ];
    expect(findDegenerateTurns(events).map((e) => e.turn)).toEqual([0]);
  });

  it("returns [] for a log with no turn markers (nothing is guessed at)", () => {
    expect(findDegenerateTurns([{ type: "assistant_message", text: COLLAPSE }])).toEqual([]);
  });

  it("degenerateVerdict is the LIVE judge: it refuses a window below the evidence floor", () => {
    // Shorter than `minWindowChars` => "not enough evidence", the same answer the
    // online guard gives. A cleanup with LOOSER thresholds than the guard would be
    // the one dangerous outcome, so this pins that it is not looser.
    expect(degenerateVerdict("OK. ".repeat(10))).toBeNull();
    expect(degenerateVerdict(COLLAPSE)).not.toBeNull();
    expect(degenerateVerdict(HEALTHY_TEXT)).toBeNull();
  });
});

describe("W9331 shadowDegenerateTurns · it really leaves the model-visible surface", () => {
  it("shadows a degenerate turn: the surface loses it, the LOG keeps every byte", () => {
    const log = degenerateLog(1);
    const before = log.events().map((e) => JSON.stringify(e));
    const { view, store } = decorate(log);

    // Before: the collapse IS on the model-visible surface.
    expect(JSON.stringify(view.deriveMessages())).toContain("Let me write");

    const result = shadowDegenerateTurns(targetOf(view));
    expect(result.shadowed).toEqual([0]);
    expect(result.skipped).toEqual([]);
    expect(store.blocks()).toHaveLength(1);

    // After: the collapse is GONE from the surface, replaced by the note...
    const afterSurface = JSON.stringify(view.deriveMessages());
    expect(afterSurface).not.toContain("Let me write");
    expect(afterSurface).toContain("guard-repeat-output");
    expect(afterSurface).toContain("Removed a degenerate block");

    // ...and the append-only log is untouched, byte for byte. This is the whole
    // promise of "surface replacement": nothing is deleted.
    expect(log.events().map((e) => JSON.stringify(e))).toEqual(before);
    // `events()` stays complete even through the overlay (extraction/audit replay it).
    expect(view.events().map((e) => JSON.stringify(e))).toEqual(before);
  });

  it("never shadows a turn that carries a tool call (the orphan rule)", () => {
    const log = degenerateLog(2, { toolCallIn: 1 });
    const { view, store } = decorate(log);
    const result = shadowDegenerateTurns(targetOf(view));

    expect(result.shadowed).toEqual([0]);
    expect(result.skipped).toEqual([{ turn: 1, reason: "tool-call" }]);
    expect(store.blocks().map((b) => b.from_turn)).toEqual([0]);
  });

  it("refuses to shadow the turn IN FLIGHT (the newest turn)", () => {
    const log = degenerateLog(1, { healthyTail: false });
    const { view, store } = decorate(log);
    const result = shadowDegenerateTurns(targetOf(view));

    expect(result.shadowed).toEqual([]);
    expect(result.skipped).toEqual([{ turn: 0, reason: "not-in-range" }]);
    expect(store.blocks()).toEqual([]);
  });

  it("writes NOTHING when there is nothing to shadow (no spurious epoch bump)", () => {
    const { view, store } = decorate(healthyLog());
    const versionBefore = store.version();
    const result = shadowDegenerateTurns(targetOf(view));

    expect(result.shadowed).toEqual([]);
    expect(result.blocks).toEqual([]);
    expect(store.version()).toBe(versionBefore);
  });

  it("is idempotent: a second pass finds nothing new and writes nothing", () => {
    const log = degenerateLog(1);
    const { view, store } = decorate(log);

    expect(shadowDegenerateTurns(targetOf(view)).shadowed).toEqual([0]);
    const versionAfterFirst = store.version();
    const blocksAfterFirst = store.blocks();
    const second = shadowDegenerateTurns(targetOf(view));

    // The scan still SEES the degenerate turn (the raw log is unchanged), but its
    // block is already in place, so nothing is written again and the report is
    // honest about it rather than claiming a second shadowing.
    expect(second.shadowed).toEqual([]);
    expect(second.skipped).toEqual([{ turn: 0, reason: "not-in-range" }]);
    expect(store.version()).toBe(versionAfterFirst);
    expect(store.blocks()).toEqual(blocksAfterFirst);
  });

  it("shadows every safe degenerate turn in one pass", () => {
    const log = degenerateLog(3);
    const { view, store } = decorate(log);
    const result = shadowDegenerateTurns(targetOf(view));

    expect(result.shadowed).toEqual([0, 1, 2]);
    for (const block of store.blocks()) {
      expect(block.summary).toContain("guard-repeat-output");
    }
    // Every degenerate turn really left the surface, and the healthy tail stayed.
    const surface = JSON.stringify(view.deriveMessages());
    expect(surface).not.toContain("Let me write");
    expect(surface).toContain("Step 39 verifies shard");
  });

  it("cleanupTargetOf returns null for a log with no overlay (nothing to persist into)", () => {
    expect(cleanupTargetOf(null)).toBeNull();
    expect(cleanupTargetOf(undefined)).toBeNull();
    // An UNDECORATED in-memory log carries no compression store.
    expect(cleanupTargetOf(new InMemorySessionLog())).toBeNull();
  });
});
