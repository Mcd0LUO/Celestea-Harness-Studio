/**
 * W2011 — the two compaction improvements, and the gates that keep them honest.
 *
 * B2: the plan keeps BOTH ends of a session (head + tail) and inserts one
 *     explicit elision row for the hole in the middle.
 * B5: the summary prompt requires a "still unverified / unknown" section, and
 *     that section is placed so the summary clip cannot eat it.
 *
 * Every gate here was mutation-checked (see the file header of the W2011 report
 * for the red/green transcripts): deleting the elision row, inserting it
 * unconditionally, deleting prompt section 1, or moving it last each turn
 * exactly one gate red — never zero, never all of them.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "@celestea/core";
import {
  COMPACT_ELISION_PREFIX,
  COMPACT_HEAD_PREFIX,
  COMPACT_HEAD_TURNS,
  COMPACT_KEEP_TURNS,
  COMPACT_SYSTEM_PROMPT,
  COMPACT_THRESHOLD,
  SUMMARY_KEEP_MAX_CHARS,
  clip,
  compactNote,
  countCompleteTurns,
  parseEventLog,
  planCompaction,
  renderTranscript,
  runCompaction,
  selectTurns,
  serializeEventLog,
} from "./index.js";

/** One complete turn: start + user + [thinking + tool_call + tool_result] + assistant + end. */
function fullTurn(n: number, withTools: boolean, answer = `助手第 ${n} 答`): SessionEvent[] {
  const id = `turn-${n}`;
  const v: SessionEvent[] = [
    { type: "turn_start", id },
    { type: "user_message", text: `用户第 ${n} 问` },
  ];
  if (withTools) {
    v.push({ type: "thinking_delta", text: `思考 ${n}` });
    v.push({ type: "tool_call", id: `c${n}`, name: "read_file", args: { path: `/tmp/f${n}.rs` } });
    v.push({ type: "tool_result", id: `c${n}`, value: { ok: true }, error: null });
  }
  v.push({ type: "assistant_message", text: answer });
  v.push({ type: "turn_end", id, outcome: "completed" });
  return v;
}

function logOf(n: number): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (let i = 0; i < n; i++) out.push(...fullTurn(i, i % 2 === 0));
  return out;
}

function turnIds(events: readonly SessionEvent[]): string[] {
  return events.filter((e) => e.type === "turn_start").map((e) => (e.type === "turn_start" ? e.id : ""));
}

function texts(events: readonly SessionEvent[]): string[] {
  return events.filter((e) => e.type === "user_message").map((e) => (e.type === "user_message" ? e.text : ""));
}

function elisionIndex(events: readonly SessionEvent[]): number {
  return events.findIndex((e) => e.type === "user_message" && e.text.startsWith(COMPACT_ELISION_PREFIX));
}

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "compact-w2011-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("B2 · head + tail plan", () => {
  it("keeps the session's OPENING turns next to the newest ones", () => {
    const out = planCompaction(logOf(12), "摘要正文", COMPACT_KEEP_TURNS) ?? [];
    // turn-1 = summary, turn-2/3 = the two oldest turns, turn-4..7 = the four newest.
    expect(turnIds(out)).toEqual(["turn-1", "turn-2", "turn-3", "turn-4", "turn-5", "turn-6", "turn-7"]);
    const rows = texts(out);
    expect(rows[0]).toBe(`${COMPACT_HEAD_PREFIX}摘要正文`);
    expect(rows[1]).toBe("用户第 0 问"); // ← the opening requirement used to be dropped
    expect(rows[2]).toBe("用户第 1 问");
    expect(rows.slice(4)).toEqual(["用户第 8 问", "用户第 9 问", "用户第 10 问", "用户第 11 问"]);
    // The turns that were dropped are really gone (not duplicated).
    expect(rows).not.toContain("用户第 2 问");
    expect(rows).not.toContain("用户第 7 问");
    expect(countCompleteTurns(out)).toBe(1 + COMPACT_HEAD_TURNS + COMPACT_KEEP_TURNS);
  });

  it("inserts ONE elision row, between the head turns and the tail turns", () => {
    const events = logOf(12);
    const out = planCompaction(events, "摘要正文", COMPACT_KEEP_TURNS) ?? [];
    const at = elisionIndex(out);
    expect(at).toBeGreaterThan(0);
    expect(out.filter((e) => e.type === "user_message" && e.text.startsWith(COMPACT_ELISION_PREFIX))).toHaveLength(1);

    const headRow = out.findIndex((e) => e.type === "user_message" && e.text === "用户第 1 问");
    const tailRow = out.findIndex((e) => e.type === "user_message" && e.text === "用户第 8 问");
    expect(headRow).toBeLessThan(at);
    expect(at).toBeLessThan(tailRow);

    // The row states HOW MUCH is missing and WHERE its content went, and its
    // numbers are the plan's own selection (no invented unit).
    const sel = selectTurns(events, COMPACT_KEEP_TURNS, COMPACT_HEAD_TURNS);
    expect(sel.dropped).toBe(6);
    const text = out[at]?.type === "user_message" ? out[at].text : "";
    expect(text).toContain(`${sel.dropped} 个完整轮`);
    expect(text).toContain(`约 ${sel.droppedTokens} tokens`);
    expect(text).toContain("第 1 轮的摘要");

    // Shape: it is an ordinary compact-origin user row, NOT a turn boundary.
    expect(out[at]).toMatchObject({ type: "user_message", origin: "compact" });
    const ids = turnIds(out);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does NOT insert an elision row when nothing was dropped (over-fix control)", () => {
    // head 2 + tail 10 = 12 ≥ 12 ⇒ every turn survives ⇒ nothing to elide.
    const out = planCompaction(logOf(12), "s", 10, COMPACT_HEAD_TURNS) ?? [];
    expect(elisionIndex(out)).toBe(-1);
    expect(countCompleteTurns(out)).toBe(1 + 12);
    // Overlapping budgets must not duplicate a turn either: 9 turns, keep 8.
    const overlapping = planCompaction(logOf(9), "s", 8, COMPACT_HEAD_TURNS) ?? [];
    expect(elisionIndex(overlapping)).toBe(-1);
    const ids = turnIds(overlapping);
    expect(ids).toEqual(["turn-1", "turn-2", "turn-3", "turn-4", "turn-5", "turn-6", "turn-7", "turn-8", "turn-9", "turn-10"]);
  });

  it("★ boundary: head + tail > the log is clamped, never padded", () => {
    // keep 10 > 9 turns, head 2 ⇒ head is clamped to what the tail leaves (0).
    const out = planCompaction(logOf(9), "s", 10, COMPACT_HEAD_TURNS) ?? [];
    expect(turnIds(out)).toEqual(["turn-1", "turn-2", "turn-3", "turn-4", "turn-5", "turn-6", "turn-7", "turn-8", "turn-9", "turn-10"]);
    // head 0 = the pre-W2011 pure-tail SELECTION (the migration seam). The
    // elision row is still emitted: it reports the hole, whichever end caused it.
    const pure = planCompaction(logOf(12), "s", 4, 0) ?? [];
    expect(turnIds(pure)).toEqual(["turn-1", "turn-2", "turn-3", "turn-4", "turn-5"]);
    expect(selectTurns(logOf(12), 4, 0).dropped).toBe(8);
    expect(elisionIndex(pure)).toBe(4);
    expect(compactNote(4)).toBe("已压缩：摘要轮 + 最近4轮");
    expect(compactNote(4, 0)).toBe("已压缩：摘要轮 + 最近4轮");
    expect(compactNote(4, COMPACT_HEAD_TURNS)).toBe("已压缩：摘要轮 + 最早2轮 + 最近4轮");
  });

  it("★ boundary: the threshold still decides BEFORE any head/tail split", () => {
    expect(planCompaction(logOf(COMPACT_THRESHOLD), "s", 4, 2)).toBeNull();
    expect(planCompaction(logOf(COMPACT_THRESHOLD + 1), "s", 4, 2)).not.toBeNull();
    // A just-compactable log (9 turns) must really lose something, otherwise the
    // plan would rewrite the file without shrinking it.
    const out = planCompaction(logOf(COMPACT_THRESHOLD + 1), "s", 4, 2) ?? [];
    expect(countCompleteTurns(out)).toBe(1 + 2 + 4);
    expect(elisionIndex(out)).toBeGreaterThan(0);
  });

  it("round-trips the elision row through the log codec", () => {
    const out = planCompaction(logOf(12), "摘要", 4) ?? [];
    const parsed = parseEventLog(serializeEventLog(out));
    expect(parsed).toEqual(out);
    expect(elisionIndex(parsed)).toBe(elisionIndex(out));
  });
});

describe("B2 · runCompaction end to end", () => {
  it("writes head + elision + tail, and reports the real kept count", async () => {
    const dir = scratch();
    const path = join(dir, "cli-main.jsonl");
    writeFileSync(path, serializeEventLog(logOf(12)));

    const out = await runCompaction({ logPath: path, summarize: () => Promise.resolve("摘要正文") });
    expect(out.compacted).toBe(true);
    expect(out.kept_turns).toBe(COMPACT_HEAD_TURNS + COMPACT_KEEP_TURNS);
    expect(out.note).toBe(compactNote(COMPACT_KEEP_TURNS, COMPACT_HEAD_TURNS));
    expect(out.turns_before).toBe(12);

    const written = parseEventLog(readFileSync(path, "utf8"));
    expect(written).toEqual(out.events);
    expect(texts(written)[1]).toBe("用户第 0 问");
    expect(elisionIndex(written)).toBeGreaterThan(0);
    // The new log is genuinely smaller than the old one (the elision row is a
    // stand-in, not a copy of what it replaced).
    expect(countCompleteTurns(written)).toBeLessThan(out.turns_before);
    // …so a second compaction is refused (7 complete turns <= threshold).
    const again = await runCompaction({ logPath: path, summarize: () => Promise.resolve("摘要2") });
    expect(again.compacted).toBe(false);
  });
});

describe("B5 · the summary prompt and the clip that follows it", () => {
  it("asks for AT LEAST five sections, including the unverified one", () => {
    expect(COMPACT_SYSTEM_PROMPT).toContain("至少包含以下五个小节");
    expect(COMPACT_SYSTEM_PROMPT).not.toContain("必须且只需");
    expect(COMPACT_SYSTEM_PROMPT).toContain("仍未验证 / 未知");
    // The named failure mode: a claim that was never checked must not be restated as fact.
    expect(COMPACT_SYSTEM_PROMPT).toContain("不得写成事实");
  });

  it("★ places the unverified section where clip() cannot eat it", () => {
    // plan.ts runs the summary through clip(summary, SUMMARY_KEEP_MAX_CHARS) and
    // clip keeps the HEAD — so the section order decides what survives.
    const first = COMPACT_SYSTEM_PROMPT.indexOf("1) 仍未验证 / 未知");
    expect(first).toBeGreaterThan(-1);
    for (const heading of ["2) 正在进行的任务", "3) 已做的决策", "4) 关键事实与文件改动", "5) 待办"]) {
      expect(first).toBeLessThan(COMPACT_SYSTEM_PROMPT.indexOf(heading));
    }

    const filler = "填充内容".repeat(3_000); // 12k chars per section (> the 20k budget)
    const promptOrdered = ["1) 仍未验证 / 未知：X 从未验证。", filler, "2) 正在进行的任务：Y", filler].join("\n");
    const sectionLast = [filler, filler, filler, "5) 仍未验证 / 未知：X 从未验证。"].join("\n");
    expect(promptOrdered.length).toBeGreaterThan(SUMMARY_KEEP_MAX_CHARS);
    expect(sectionLast.length).toBeGreaterThan(SUMMARY_KEEP_MAX_CHARS);
    expect(clip(promptOrdered, SUMMARY_KEEP_MAX_CHARS)).toContain("仍未验证");
    // The trap is real, and this is the control that keeps the gate meaningful:
    // the same section placed LAST is cut away by the very call plan.ts makes.
    expect(clip(sectionLast, SUMMARY_KEEP_MAX_CHARS)).not.toContain("仍未验证");
  });

  it("carries a five-section summary into the head row, section 1 intact", async () => {
    // A ≥9-turn session in which one turn CLAIMS a fix that was never verified.
    const events = logOf(11);
    const claim = fullTurn(4, false, "已修复 X（未跑测试）");
    const session: SessionEvent[] = [];
    for (let i = 0; i < 11; i++) session.push(...(i === 4 ? claim : fullTurn(i, i % 2 === 0)));

    // ① the claim reaches the summariser: it is in the transcript …
    const transcript = renderTranscript(session);
    expect(transcript).toContain("已修复 X（未跑测试）");
    expect(events.length).toBeGreaterThan(0);

    // ② … and the prompt tells the model what to do with it.
    expect(COMPACT_SYSTEM_PROMPT).toContain("声称做完但从未验证");

    // ③ the summary the model returns lands in the head row unclipped.
    //    OFFLINE LIMIT: the summary below is produced by a STUB, not by a model —
    //    this asserts the prompt contract, the clip behaviour and the summary
    //    SHAPE, never a real model's output (see the report's honesty list).
    const summary = [
      "1) 仍未验证 / 未知：第 5 轮声称「已修复 X」，但从未跑过测试、未看过 diff —— 按未验证处理。",
      "2) 正在进行的任务：压缩改进。",
      "3) 已做的决策：head + tail 双预算。",
      "4) 关键事实与文件改动：plan.ts / transcript.ts。",
      "5) 待办：跑门禁。",
    ].join("\n");
    const dir = scratch();
    const path = join(dir, "cli-main.jsonl");
    writeFileSync(path, serializeEventLog(session));
    const out = await runCompaction({ logPath: path, summarize: () => Promise.resolve(summary) });
    expect(out.compacted).toBe(true);
    const head = out.events?.find((e) => e.type === "user_message" && e.text.startsWith(COMPACT_HEAD_PREFIX));
    expect(head?.type === "user_message" ? head.text : "").toContain("仍未验证 / 未知");
    expect(head?.type === "user_message" ? head.text : "").toContain("按未验证处理");
  });
});
