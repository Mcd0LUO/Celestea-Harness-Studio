/**
 * W1900 (Phase 2) — the compression HOST's single-water-level guarantee.
 *
 * The host is where the statusline's reading becomes the port the tools act
 * on. The regression these tests pin: the port's `usage()` must be the host's
 * OWN reader, not a local `null` — a `compress` call records
 * `CompressionBlock.context_ratio` from `port.usage()`, and a port that
 * answered `null` would stamp every block with `0`, claiming the context
 * was empty at the exact moment the model decided it was full (and
 * `/api/status`'s `compression.last_ratio` would echo the lie).
 */

import { InMemorySessionLog, MemoryCompressionStore, compressedLog } from "@celestea/session";
import type { ContextUsageFacts, SessionLog } from "@celestea/core";
import { describe, expect, it } from "vitest";

import { compressionHostOf, compressionViewOf, newestTurnOf } from "./compression-host.js";

const USAGE: ContextUsageFacts = { used: 61_000, window: 100_000, ratio: 0.61, estimated: false, method: "usage_prompt_tokens", projected: false };

/** A three-turn log behind the overlay decorator, store attached. */
function stagedLog(): { log: SessionLog; store: MemoryCompressionStore } {
  const inner = new InMemorySessionLog();
  for (const n of [1, 2, 3]) {
    inner.append({ type: "turn_start", id: `turn-${n}` });
    inner.append({ type: "user_message", text: `human ${n}` });
    inner.append({ type: "turn_end", id: `turn-${n}`, outcome: "completed" });
  }
  const store = new MemoryCompressionStore();
  return { log: compressedLog(inner, store), store };
}

describe("W1900 · the port speaks the host's water level", () => {
  it("port().usage() is the injected reader, so a block records the real ratio", () => {
    const { log } = stagedLog();
    const host = compressionHostOf({ log: () => log, usage: () => USAGE });
    expect(host).not.toBeNull();
    const port = host!.port();
    expect(port).not.toBeNull();
    expect(port!.usage()).toEqual(USAGE);
  });

  it("a log with no store yields no port, and the view says disabled", () => {
    const plain = new InMemorySessionLog();
    const host = compressionHostOf({ log: () => plain, usage: () => USAGE });
    expect(host!.port()).toBeNull();
    expect(compressionViewOf(plain).enabled).toBe(false);
  });

  it("the view reports the newest block's recorded ratio as last_ratio", () => {
    const { log, store } = stagedLog();
    store.save([{ from_turn: 1, to_turn: 2, summary: "folded", created_turn: 3, context_ratio: 0.61 }]);
    const view = compressionViewOf(log);
    expect(view).toEqual({ enabled: true, blocks: 1, ranges: [[1, 2]], last_ratio: 0.61 });
  });

  it("newestTurnOf answers the log's own last turn, and -1 when there is none", () => {
    expect(newestTurnOf(new InMemorySessionLog())).toBe(-1);
    expect(newestTurnOf(stagedLog().log)).toBe(3);
  });

  it("newestTurnOf reports 0 for a log whose only turn is the FIRST one", () => {
    // W1900 skipped turn-0 (`n > 0`) and then FABRICATED a 1. That is the
    // numbering bug in one line: the value is compared against `to_turn` by
    // validateRange and quoted to the model by context_status, so a fabricated
    // 1 both mis-reported the current turn and hid the real first turn.
    const inner = new InMemorySessionLog();
    inner.append({ type: "turn_start", id: "turn-0" });
    inner.append({ type: "user_message", text: "only" });
    inner.append({ type: "turn_end", id: "turn-0", outcome: "completed" });
    expect(newestTurnOf(inner)).toBe(0);
  });
});
