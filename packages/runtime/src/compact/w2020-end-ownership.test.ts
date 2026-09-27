/**
 * W2020 — who owns the pair-closing compaction_end, and what
 * CompactionResult.events is allowed to claim (section 2-(1) of the task).
 *
 * The end marker moved OUT of runCompaction and into the caller, so the result
 * can no longer honestly say "the log as it now is on disk" — it describes the
 * REWRITE this call performed, and the end row is a step the caller still owes.
 * These gates pin that reading, and pin the two ways installCompactionEnd can be
 * misused: an end on the skip branch (an ORPHAN end) and a swallowed append
 * failure (a success answer over an unpaired start).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "@celestea/core";
import {
  compactionMarkers,
  hasUnpairedCompactionStart,
  installCompactionEnd,
  parseEventLog,
  runCompaction,
  serializeEventLog,
} from "./index.js";

function turns(n: number): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (let i = 1; i <= n; i++) {
    const id = "turn-" + i;
    out.push({ type: "turn_start", id });
    out.push({ type: "user_message", text: "问 " + i });
    out.push({ type: "assistant_message", text: "答 " + i });
    out.push({ type: "turn_end", id, outcome: "completed" });
  }
  return out;
}

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "compact-w2020-end-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeLog(events: readonly SessionEvent[]): string {
  const path = join(scratch(), "cli-main.jsonl");
  writeFileSync(path, serializeEventLog(events));
  return path;
}

/** The on-disk log (the only source of truth these gates accept). */
const onDisk = (path: string): SessionEvent[] => parseEventLog(readFileSync(path, "utf8"));

describe("W2020 · section 2-(1): events describes the REWRITE, never a state that is not on disk", () => {
  it("★ equals the file right after the rewrite — with NO end row, on disk or in the result", async () => {
    const path = writeLog(turns(12));
    const out = await runCompaction({ logPath: path, summarize: () => Promise.resolve("摘要") });

    expect(out.compacted).toBe(true);
    // The result and the file agree EXACTLY, and both are missing the end row:
    // the result never claims a row this call did not write.
    expect(out.events).toEqual(onDisk(path));
    expect(out.events?.some((e) => e.type === "compaction_end")).toBe(false);
    // ...and the log is therefore genuinely UNPAIRED at this instant: the pair
    // stays open until the caller closes it.
    expect(hasUnpairedCompactionStart(onDisk(path))).toBe(true);
  });

  it("★ after the caller closes the pair, the file is exactly result.events + the end row", async () => {
    const path = writeLog(turns(12));
    const out = await runCompaction({ logPath: path, summarize: () => Promise.resolve("摘要") });

    installCompactionEnd(out, path, out.writeEndMarker);

    expect(onDisk(path)).toEqual([...(out.events ?? []), { type: "compaction_end" }]);
    expect(hasUnpairedCompactionStart(onDisk(path))).toBe(false);
    // The result is NOT retroactively rewritten — it still describes the rewrite.
    expect(out.events?.some((e) => e.type === "compaction_end")).toBe(false);
  });
});

describe("W2020 · installCompactionEnd closes a pair, never opens an orphan end", () => {
  it("★ writes NOTHING on the skip branch (a short history opens no pair)", async () => {
    const path = writeLog(turns(3));
    const before = readFileSync(path, "utf8");
    const out = await runCompaction({ logPath: path, summarize: () => Promise.resolve("never") });
    expect(out.compacted).toBe(false);
    expect(out.events).toBeNull();

    installCompactionEnd(out, path, out.writeEndMarker);

    // Byte-identical: an end here would be an ORPHAN end — it would close a pair
    // no compaction opened and make a healthy session read as broken.
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(onDisk(path).some((e) => e.type === "compaction_end")).toBe(false);
  });

  it("propagates an append failure rather than claiming the pair is closed", async () => {
    const path = writeLog(turns(12));
    const out = await runCompaction({ logPath: path, summarize: () => Promise.resolve("摘要") });

    expect(() =>
      installCompactionEnd(out, path, () => {
        throw new Error("磁盘写入失败");
      }),
    ).toThrow("磁盘写入失败");
    // The unpaired start survives: the failure is not papered over.
    expect(compactionMarkers(onDisk(path))).toEqual({ starts: 1, ends: 0, unpaired: true });
  });

  it("carries the write seam out of runCompaction so the caller cannot pick the wrong writer", async () => {
    const path = writeLog(turns(12));
    const calls: string[] = [];
    const out = await runCompaction({
      logPath: path,
      summarize: () => Promise.resolve("摘要"),
      writeEndMarker: (p) => {
        calls.push(p);
        writeFileSync(p, readFileSync(p, "utf8") + '{"type":"compaction_end"}' + "\n");
      },
    });

    installCompactionEnd(out, path, out.writeEndMarker);

    expect(calls).toEqual([path]);
    expect(hasUnpairedCompactionStart(onDisk(path))).toBe(false);
  });
});
