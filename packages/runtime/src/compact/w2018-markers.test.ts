/**
 * W2018 (B1) — the two compaction markers and the crash signal they create.
 *
 * The claim under test is narrow and falsifiable:
 *
 *   1. a SUCCESSFUL compaction leaves the log with a PAIRED
 *      compaction_start/compaction_end, the start as the FIRST row and the end
 *      as the LAST row;
 *   2. the start row is installed by the SAME atomic rewrite as the compacted
 *      history, so it can never appear without it;
 *   3. a compaction that dies between the rewrite and the end append leaves an
 *      UNPAIRED start, and that is exactly what the detector reports;
 *   4. the markers do NOT change what any existing consumer sees — the log is
 *      byte-identical apart from the two marker rows, and the model-visible
 *      projection is untouched.
 *
 * Each gate was mutation-checked (red -> restore -> green); see the W2018 report
 * for the transcripts. The mutations were: drop the start, drop the end, and
 * swap the two markers' positions.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveMessagesFrom, SESSION_EVENT_TYPES, type SessionEvent } from "@celestea/core";
import { projectMessages } from "@celestea/session";
import {
  COMPACT_KEEP_TURNS,
  appendCompactionEnd,
  compactionMarkers,
  compactionStartEvent,
  hasUnpairedCompactionStart,
  parseEventLog,
  runCompaction,
  serializeEventLog,
} from "./index.js";

/** One complete turn (start + user + assistant + end). */
function turn(n: number): SessionEvent[] {
  const id = `turn-${n}`;
  return [
    { type: "turn_start", id },
    { type: "user_message", text: `用户第 ${n} 问` },
    { type: "assistant_message", text: `助手第 ${n} 答` },
    { type: "turn_end", id, outcome: "completed" },
  ];
}

function logOf(n: number): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (let i = 0; i < n; i++) out.push(...turn(i));
  return out;
}

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "compact-markers-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Write a log and return its path. */
function writeLog(events: readonly SessionEvent[]): string {
  const path = join(scratch(), "cli-main.jsonl");
  writeFileSync(path, serializeEventLog(events));
  return path;
}

describe("W2018 · the markers are declared by the contract", () => {
  it("names both markers in SESSION_EVENT_TYPES", () => {
    expect(SESSION_EVENT_TYPES).toContain("compaction_start");
    expect(SESSION_EVENT_TYPES).toContain("compaction_end");
    // 9 pre-existing + the two additive markers.
    expect(SESSION_EVENT_TYPES).toHaveLength(11);
  });

  it("round-trips each marker through the log codec, field-free", () => {
    const text = serializeEventLog([compactionStartEvent(), ...logOf(1), { type: "compaction_end" }]);
    // The tag IS the payload: no other key may be serialized.
    expect(text.split("\n")[0]).toBe('{"type":"compaction_start"}');
    expect(text.split("\n").filter((l) => l !== "")[5]).toBe('{"type":"compaction_end"}');
    const parsed = parseEventLog(text);
    expect(parsed[0]).toEqual({ type: "compaction_start" });
    expect(parsed[parsed.length - 1]).toEqual({ type: "compaction_end" });
  });
});

describe("W2018 · a successful compaction leaves a PAIRED, correctly ordered log", () => {
  it("★ writes start FIRST and end LAST, exactly one of each", async () => {
    const path = writeLog(logOf(12));
    const out = await runCompaction({ logPath: path, summarize: () => Promise.resolve("摘要正文") });
    expect(out.compacted).toBe(true);

    const written = parseEventLog(readFileSync(path, "utf8"));
    const census = compactionMarkers(written);
    expect(census.starts).toBe(1);
    expect(census.ends).toBe(1);
    expect(census.unpaired).toBe(false);

    // POSITION, not just presence: the start must precede the compacted history
    // and the end must follow it. A swap would satisfy a bare count.
    expect(written[0]?.type).toBe("compaction_start");
    expect(written[written.length - 1]?.type).toBe("compaction_end");
    expect(written.findIndex((e) => e.type === "compaction_start")).toBeLessThan(
      written.findIndex((e) => e.type === "turn_start"),
    );
    expect(written.findIndex((e) => e.type === "compaction_end")).toBeGreaterThan(
      written.findIndex((e) => e.type === "turn_end"),
    );

    // The start marker is part of the log the rewrite produced: result.events is
    // the on-disk log, so a marker that never reached the file would show here.
    expect(out.events).toEqual(written);
  });

  it("installs the start marker ATOMICALLY, inside the rewritten log", async () => {
    const path = writeLog(logOf(12));
    const seen: SessionEvent[][] = [];
    await runCompaction({
      logPath: path,
      summarize: () => Promise.resolve("摘要正文"),
      // The seam sees exactly the byte string that becomes the new log.
      write: (_p, events) => {
        seen.push([...events]);
        writeFileSync(path, serializeEventLog(events));
      },
      append: (p) => appendCompactionEnd(p),
    });
    expect(seen).toHaveLength(1);
    // The start row was already present in the ATOMIC write — not appended after.
    expect(seen[0]?.[0]).toEqual({ type: "compaction_start" });
    expect(seen[0]?.some((e) => e.type === "compaction_end")).toBe(false);
  });
});

describe("W2018 · an interrupted compaction is detectable", () => {
  it("★ reports an UNPAIRED start when the end marker never lands", async () => {
    const path = writeLog(logOf(12));
    // Simulate the crash window: the rewrite succeeded (start + compacted log are
    // on disk) but the process died before the end append.
    await runCompaction({
      logPath: path,
      summarize: () => Promise.resolve("摘要正文"),
      // The REAL rewrite runs (so the .precompact backup genuinely exists);
      // only the end append dies — the crash window this task is about.
      append: () => {
        throw new Error("模拟：end 标记写入前进程死亡");
      },
    }).catch(() => undefined);

    const written = parseEventLog(readFileSync(path, "utf8"));
    const census = compactionMarkers(written);
    expect(census.starts).toBe(1);
    expect(census.ends).toBe(0);
    expect(census.unpaired).toBe(true);
    // The state is genuinely "compacted but unfinished": the history is gone from
    // the log and survives only in the .precompact backup (P12's rollback edge).
    expect(written[0]?.type).toBe("compaction_start");
    expect(readFileSync(join(path, "..", "cli-main.jsonl.precompact"), "utf8")).toBe(serializeEventLog(logOf(12)));
  });

  it("propagates an end-append failure instead of claiming success", async () => {
    const path = writeLog(logOf(12));
    await expect(
      runCompaction({
        logPath: path,
        summarize: () => Promise.resolve("摘要正文"),
        append: () => {
          throw new Error("磁盘写入失败");
        },
      }),
    ).rejects.toThrow("磁盘写入失败");
  });

  it("does NOT flag a clean log, a completed compaction, or a later turn", async () => {
    expect(hasUnpairedCompactionStart(logOf(3))).toBe(false);
    const path = writeLog(logOf(12));
    await runCompaction({ logPath: path, summarize: () => Promise.resolve("摘要正文") });
    const after = parseEventLog(readFileSync(path, "utf8"));
    expect(hasUnpairedCompactionStart(after)).toBe(false);
    // A turn appended after the compaction must not resurrect the signal.
    expect(hasUnpairedCompactionStart([...after, ...turn(99)])).toBe(false);
  });

  it("judges the TRAILING marker only (an older unpaired start is superseded)", () => {
    // start, end, start -> the last start is the open one.
    expect(hasUnpairedCompactionStart([{ type: "compaction_start" }, { type: "compaction_end" }, { type: "compaction_start" }])).toBe(true);
    // start, start, end -> the end closes the log's trailing state.
    expect(hasUnpairedCompactionStart([{ type: "compaction_start" }, { type: "compaction_start" }, { type: "compaction_end" }])).toBe(false);
  });
});

describe("W2018 · the markers do not change what existing consumers see", () => {
  it("★ leaves the model-visible projection byte-identical", async () => {
    const path = writeLog(logOf(12));
    await runCompaction({ logPath: path, summarize: () => Promise.resolve("摘要正文") });
    const written = parseEventLog(readFileSync(path, "utf8"));
    // Same events with the two markers stripped == what the projection sees.
    const stripped = written.filter((e) => e.type !== "compaction_start" && e.type !== "compaction_end");
    expect(deriveMessagesFrom(written)).toEqual(deriveMessagesFrom(stripped));
    expect(projectMessages(written)).toEqual(projectMessages(stripped));
  });

  it("keeps the pre-compaction log untouched when nothing is compacted", async () => {
    const short = logOf(3);
    const path = writeLog(short);
    const out = await runCompaction({ logPath: path, summarize: () => Promise.resolve("never") });
    expect(out.compacted).toBe(false);
    expect(out.events).toBeNull();
    // No marker may be written on the skip branch: the log is byte-identical.
    expect(readFileSync(path, "utf8")).toBe(serializeEventLog(short));
  });

  it("keeps the kept turns byte-identical apart from renumbering", async () => {
    const path = writeLog(logOf(12));
    await runCompaction({ logPath: path, summarize: () => Promise.resolve("摘要正文") });
    const written = parseEventLog(readFileSync(path, "utf8"));
    // Skip the trailing end marker, then take the last surviving turn's rows.
    const keptTail = written.slice(-(turn(0).length + 1), -1);
    // The last surviving turn's body is the original turn 11's body, verbatim.
    expect(keptTail.filter((e) => e.type !== "turn_start" && e.type !== "turn_end")).toEqual(
      turn(11).filter((e) => e.type !== "turn_start" && e.type !== "turn_end"),
    );
    expect(COMPACT_KEEP_TURNS).toBe(4);
  });
});
