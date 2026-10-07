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
 *      UNPAIRED start, and that is exactly what the detector reports (W2020
 *      moved that append to the caller, so the window now also covers the
 *      rebind — the dedicated gates for that live in w2020-rebind.test.ts);
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
  installCompactionEnd,
  parseEventLog,
  renderTranscript,
  runCompaction,
  serializeEventLog,
  transcriptLine,
} from "./index.js";

/** W2020: the end marker is the CALLER's step now — close the pair explicitly. */
function closePair(out: Awaited<ReturnType<typeof runCompaction>>, path: string): void {
  installCompactionEnd(out, path, out.writeEndMarker);
}

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
    // M2-B2b: the hand-copied 11 was replaced by a floor. This test is about
    // the MARKERS being declared, not about how many row types the enum has --
    // the exact count belongs to tests/contracts.test.ts, which checks it
    // against the schema. Pinning it in two places meant every future row type
    // had to edit two files to stay green.
    expect(SESSION_EVENT_TYPES.length).toBeGreaterThanOrEqual(11);
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


describe("M2-B2b · the compaction summary must not double-count a desktop confirmation", () => {
  const asked: SessionEvent = {
    type: "desktop_confirm",
    id: "q-7",
    method: "type_text",
    app: "notepad.exe",
    reason: "sensitive_method",
    timeout_ms: 60_000,
  };
  const answered: SessionEvent = { type: "desktop_confirm_answer", id: "q-7", outcome: "approve", elapsed_ms: 1500 };

  it("renderTranscript omits both rows, so a log with a gate summarizes like one without", () => {
    expect(transcriptLine(asked)).toBe("");
    expect(transcriptLine(answered)).toBe("");
    // The gate itself is already visible as the tool_call/tool_result pair, so a
    // line here would describe the same decision twice.
    expect(renderTranscript([asked, answered])).toBe(renderTranscript([]));
  });

  it("and the model-visible projection stays empty for them too", () => {
    expect(deriveMessagesFrom([asked, answered])).toEqual([]);
  });
});
describe("W2018 · a successful compaction leaves a PAIRED, correctly ordered log", () => {
  it("★ writes start FIRST and end LAST, exactly one of each", async () => {
    const path = writeLog(logOf(12));
    const out = await runCompaction({ logPath: path, summarize: () => Promise.resolve("摘要正文") });
    expect(out.compacted).toBe(true);
    closePair(out, path);

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

    // W2020: result.events is the log the REWRITE produced — the pair-closing
    // end row is the caller's step, so it is absent here and present on disk.
    expect(written).toEqual([...(out.events ?? []), { type: "compaction_end" }]);
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
      writeEndMarker: (p) => appendCompactionEnd(p),
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
      // only the pair-closing end append dies — the crash window this task is
      // about. W2020: the append is the caller's step, so the crash is modelled
      // by never reaching it (the seam is never invoked) — same durable state.
      writeEndMarker: () => {
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
    const out = await runCompaction({ logPath: path, summarize: () => Promise.resolve("摘要正文") });
    // W2020: the failure surfaces at the CALLER's pair-closing step, and it must
    // not be swallowed there either — the log keeps the unpaired start.
    const failing = { ...out, writeEndMarker: (): void => {
      throw new Error("磁盘写入失败");
    } };
    expect(() => closePair(failing, path)).toThrow("磁盘写入失败");
    expect(hasUnpairedCompactionStart(parseEventLog(readFileSync(path, "utf8")))).toBe(true);
  });

  it("does NOT flag a clean log, a completed compaction, or a later turn", async () => {
    expect(hasUnpairedCompactionStart(logOf(3))).toBe(false);
    const path = writeLog(logOf(12));
    const out = await runCompaction({ logPath: path, summarize: () => Promise.resolve("摘要正文") });
    closePair(out, path);
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
    const out = await runCompaction({ logPath: path, summarize: () => Promise.resolve("摘要正文") });
    closePair(out, path);
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
    const out = await runCompaction({ logPath: path, summarize: () => Promise.resolve("摘要正文") });
    closePair(out, path);
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
