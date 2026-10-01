/**
 * Phase 1 — background memory extraction: the pure helpers (slicing, gates,
 * transcript, JSON parsing) and the scheduler itself (cursor advance/skip/
 * failure semantics, coalescing, drain, ledger booking) against fakes.
 */
import { describe, expect, it } from "vitest";
import type { Llm, Message, SessionEvent, StreamEvent, Usage } from "@celestea/core";
import { memoryLog } from "./fakes.test-util.js";
import {
  containsDirectMemoryWrite,
  createMemoryExtractionScheduler,
  extractionSystemPrompt,
  hasEligibleUserProse,
  parseExtractionOps,
  renderExtractionTranscript,
  sliceUnprocessedTurns,
  type ExtractionCursor,
  type ExtractionLedgerInput,
  type ExtractionOp,
} from "./memory-extraction.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const USAGE: Usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cache_read: 80, reasoning_tokens: 0 };

/** A scripted Llm: yields the given events per generate() call, records requests. */
function scriptedLlm(script: StreamEvent[][]): { llm: Llm; requests: unknown[] } {
  const requests: unknown[] = [];
  let call = 0;
  return {
    requests,
    llm: {
      generate(req) {
        requests.push(req);
        const events = script[Math.min(call++, script.length - 1)] ?? [];
        return Promise.resolve(
          (async function* () {
            for (const e of events) yield e;
          })(),
        );
      },
    },
  };
}

function doneWith(text: string): StreamEvent[] {
  const message: Message = { role: "assistant", content: [{ type: "text", content: text }], tool_call_id: null };
  return [{ kind: "text", text }, { kind: "usage", usage: USAGE }, { kind: "done", message }];
}

function turn(log: ReturnType<typeof memoryLog>, n: number, events: SessionEvent[]): void {
  log.append({ type: "turn_start", id: `turn-${n}` });
  for (const e of events) log.append(e);
  log.append({ type: "turn_end", id: `turn-${n}`, outcome: "completed" });
}

const userSays = (text: string): SessionEvent => ({ type: "user_message", text });
const assistantSays = (text: string): SessionEvent => ({ type: "assistant_message", text });

function deps(overrides: {
  script: StreamEvent[][];
  /**
   * Scripted STORE answers, consumed one per op (default: every op applies).
   * The recorder below is what the tests assert on; this is the input.
   */
  outcomes?: { applied: boolean; reason?: string }[];
  ledger?: ExtractionLedgerInput[];
  saved?: ExtractionCursor[];
}) {
  const { llm, requests } = scriptedLlm(overrides.script);
  const outcomes = [...(overrides.outcomes ?? [])];
  const writes: { op: ExtractionOp; result: { applied: boolean; reason?: string } }[] = [];
  const ledger = overrides.ledger ?? [];
  const saved = overrides.saved ?? [];
  return {
    requests,
    writes,
    ledger,
    saved,
    deps: {
      llm,
      model: "test-model",
      entryMaxBytes: 2048,
      write: (op: ExtractionOp) => {
        const result = outcomes.shift() ?? { applied: true };
        writes.push({ op, result });
        return result;
      },
      manifest: () => "m1 — user prefers pnpm",
      bookExtraction: (input: ExtractionLedgerInput) => void ledger.push(input),
      cursor: { load: () => null, save: (c: ExtractionCursor) => void saved.push(c) },
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("P1 · sliceUnprocessedTurns", () => {
  const log = memoryLog();
  turn(log, 1, [userSays("hello there world")]);
  turn(log, 2, [userSays("second turn words")]);
  const events = log.events();

  it("slices complete turns from a fresh cursor", () => {
    const { slices } = sliceUnprocessedTurns(events, { turn_id: "", event_count: 0 });
    expect(slices.map((s) => s.turn_id)).toEqual(["turn-1", "turn-2"]);
    expect(slices[1]?.event_count).toBe(events.length);
  });

  it("resumes after a valid cursor", () => {
    const count = events.findIndex((e) => e.type === "turn_end" && e.id === "turn-1") + 1;
    const { cursor, slices } = sliceUnprocessedTurns(events, { turn_id: "turn-1", event_count: count });
    expect(cursor.event_count).toBe(count);
    expect(slices.map((s) => s.turn_id)).toEqual(["turn-2"]);
  });

  it("resets a dangling cursor (compaction renumbered the turns)", () => {
    const { cursor, slices } = sliceUnprocessedTurns(events, { turn_id: "turn-9", event_count: 2 });
    expect(cursor).toEqual({ turn_id: "", event_count: 0 });
    expect(slices).toHaveLength(2);
  });

  it("resets a cursor past the log end (log shrank)", () => {
    const { cursor } = sliceUnprocessedTurns(events, { turn_id: "turn-1", event_count: 999 });
    expect(cursor).toEqual({ turn_id: "", event_count: 0 });
  });

  it("leaves a trailing partial turn for the next pass", () => {
    const partial = memoryLog();
    turn(partial, 1, [userSays("done turn words here")]);
    partial.append({ type: "turn_start", id: "turn-2" });
    partial.append(userSays("unfinished"));
    const { slices } = sliceUnprocessedTurns(partial.events(), { turn_id: "", event_count: 0 });
    expect(slices.map((s) => s.turn_id)).toEqual(["turn-1"]);
  });
});

describe("P1 · skip gates", () => {
  it("gate 1: remember/forget tool calls count as direct writes", () => {
    expect(containsDirectMemoryWrite([{ type: "tool_call", id: "c1", name: "remember", args: {} }])).toBe(true);
    expect(containsDirectMemoryWrite([{ type: "tool_call", id: "c1", name: "run_shell", args: {} }])).toBe(false);
    expect(containsDirectMemoryWrite([userSays("remember this please ok")])).toBe(false);
  });

  it("gate 2: whitespace words, CJK fallback, and origin filtering", () => {
    expect(hasEligibleUserProse("one two three", 3)).toBe(true);
    expect(hasEligibleUserProse("one two", 3)).toBe(false);
    expect(hasEligibleUserProse("记住这个偏好以后都这样", 3)).toBe(true); // CJK: no spaces
    expect(hasEligibleUserProse("好", 3)).toBe(false);
    // injected rows (skill/memory/…) never count as user prose
    const events: SessionEvent[] = [
      { type: "user_message", text: "catalog with many many words", origin: "skill" },
      { type: "user_message", text: "hi", origin: "user" },
    ];
    expect(hasEligibleUserProse(userProseOf2(events), 3)).toBe(false);
  });
});

// local import alias kept close to the gate test for readability
import { userProseOf as userProseOf2 } from "./memory-extraction.js";

describe("P1 · renderExtractionTranscript", () => {
  it("renders roles, skips thinking, caps with a head-truncation marker", () => {
    const events: SessionEvent[] = [
      { type: "turn_start", id: "turn-1" },
      userSays("please use pnpm"),
      assistantSays("will do"),
      { type: "thinking_delta", text: "secret reasoning" },
      { type: "tool_call", id: "c1", name: "run_shell", args: { cmd: "ls" } },
      { type: "tool_result", id: "c1", value: "ok", error: null },
      { type: "turn_end", id: "turn-1" },
    ];
    const t = renderExtractionTranscript(events, 100_000);
    expect(t).toContain("[user] please use pnpm");
    expect(t).toContain("[assistant] will do");
    expect(t).toContain("[tool_call run_shell]");
    expect(t).not.toContain("secret reasoning");
    const capped = renderExtractionTranscript(events, 120);
    expect(capped.startsWith("[transcript head truncated]")).toBe(true);
    expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(120);
  });
});

describe("P1 · parseExtractionOps", () => {
  it("parses add/update/forget; ignores prose around the JSON", () => {
    const text = 'Sure! {"ops":[{"op":"add","text":"likes pnpm","tags":["user"]},' +
      '{"op":"update","id":"m1","text":"now prefers npm","tags":["user"]},' +
      '{"op":"forget","id":"m9"}]} done.';
    const { ops, refused } = parseExtractionOps(text, 2048);
    expect(refused).toBe(0);
    expect(ops).toEqual([
      { op: "add", text: "likes pnpm", tags: ["user"] },
      { op: "update", id: "m1", text: "now prefers npm", tags: ["user"] },
      { op: "forget", id: "m9" },
    ]);
  });

  it("treats prose-only and junk as no-op", () => {
    expect(parseExtractionOps("Nothing to save.", 2048).ops).toEqual([]);
    expect(parseExtractionOps('{"ops": [broken', 2048).ops).toEqual([]);
    expect(parseExtractionOps('{"nope": true}', 2048).ops).toEqual([]);
  });

  it("refuses oversize entries and malformed ops without cutting text", () => {
    const big = "x".repeat(2100);
    const { ops, refused } = parseExtractionOps(
      JSON.stringify({ ops: [{ op: "add", text: big, tags: [] }, { op: "update", text: "no id" }, "junk"] }),
      2048,
    );
    expect(ops).toEqual([]);
    expect(refused).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

describe("P1 · scheduler", () => {
  it("extracts: applies ops, books usage, advances + persists the cursor", async () => {
    const log = memoryLog();
    turn(log, 1, [userSays("I prefer pnpm over npm always"), assistantSays("noted")]);
    const d = deps({ script: [doneWith('{"ops":[{"op":"add","text":"user prefers pnpm","tags":["user"]}]}')] });
    const sched = createMemoryExtractionScheduler(d.deps);
    sched.schedule(log);
    await sched.drain();
    expect(d.writes.map((w) => w.op)).toEqual([{ op: "add", text: "user prefers pnpm", tags: ["user"] }]);
    expect(d.ledger).toEqual([{ turn_id: "turn-1", usage: USAGE, entries: 1, status: "ok" }]);
    expect(d.saved.at(-1)).toEqual({ turn_id: "turn-1", event_count: log.events().length });
    // the request carried the constant system prompt + no tools + the cap
    const req = d.requests[0] as { tools: unknown[]; max_tokens: number | null; system: string };
    expect(req.tools).toEqual([]);
    expect(req.max_tokens).toBe(2048);
    expect(req.system).toBe(extractionSystemPrompt(2048));
  });

  it("gate 1: a direct remember write skips the LLM call but advances", async () => {
    const log = memoryLog();
    turn(log, 1, [
      userSays("remember that I like tabs indentation"),
      { type: "tool_call", id: "c1", name: "remember", args: { text: "x" } },
      { type: "tool_result", id: "c1", value: "m1", error: null },
    ]);
    const d = deps({ script: [doneWith("{}")] });
    const sched = createMemoryExtractionScheduler(d.deps);
    sched.schedule(log);
    await sched.drain();
    expect(d.requests).toHaveLength(0);
    expect(d.ledger).toHaveLength(0);
    expect(d.saved.at(-1)?.turn_id).toBe("turn-1");
  });

  it("gate 2: a turn with no real user prose skips the LLM call", async () => {
    const log = memoryLog();
    turn(log, 1, [{ type: "user_message", text: "skill catalog many words here", origin: "skill" }]);
    const d = deps({ script: [doneWith("{}")] });
    const sched = createMemoryExtractionScheduler(d.deps);
    sched.schedule(log);
    await sched.drain();
    expect(d.requests).toHaveLength(0);
    expect(d.saved.at(-1)?.turn_id).toBe("turn-1");
  });

  it("a failed call books an error row and does NOT advance the cursor", async () => {
    const log = memoryLog();
    turn(log, 1, [userSays("please always use tabs indentation")]);
    const d = deps({ script: [[{ kind: "failed", kindOf: "stream", message: "boom" }]] });
    const sched = createMemoryExtractionScheduler(d.deps);
    sched.schedule(log);
    await sched.drain();
    expect(d.ledger).toEqual([{ turn_id: "turn-1", usage: expect.objectContaining({ prompt_tokens: 0 }), entries: 0, status: "error" }]);
    expect(d.saved).toHaveLength(0);
  });

  it("an unparseable reply is a no-op that still advances (no retry storm)", async () => {
    const log = memoryLog();
    turn(log, 1, [userSays("some ordinary chat about nothing")]);
    const d = deps({ script: [doneWith("Nothing to save.")] });
    const sched = createMemoryExtractionScheduler(d.deps);
    sched.schedule(log);
    await sched.drain();
    expect(d.writes).toHaveLength(0);
    expect(d.ledger[0]?.status).toBe("no-op");
    expect(d.saved.at(-1)?.turn_id).toBe("turn-1");
  });

  it("a failure in the MIDDLE of a batch stops the pass instead of being walked over", async () => {
    // Two turns are waiting; the call for turn-1 fails and the one for turn-2
    // would succeed. The cursor is ONE position, so letting turn-2's success
    // move it past turn-1 would lose turn-1's extraction for good — the module
    // promises "a failed pass does not advance; the next turn's events retry
    // it", and with several slices in one pump that promise needs the pass to
    // STOP, not to continue.
    const log = memoryLog();
    turn(log, 1, [userSays("the first turn says something durable")]);
    turn(log, 2, [userSays("the second turn says something durable too")]);
    const d = deps({
      script: [
        [{ kind: "failed", kindOf: "stream", message: "boom" }],
        doneWith('{"ops":[{"op":"add","text":"a durable fact"}]}'),
      ],
    });
    const sched = createMemoryExtractionScheduler(d.deps);
    sched.schedule(log);
    await sched.drain();
    expect(d.requests).toHaveLength(1); // turn-2 was NOT called after the failure
    expect(d.ledger.map((l) => l.status)).toEqual(["error"]);
    expect(d.writes).toHaveLength(0);
    expect(d.saved).toHaveLength(0); // nothing advanced

    // The next schedule retries from the failed slice and gets through BOTH.
    sched.schedule(log);
    await sched.drain();
    expect(d.ledger.map((l) => l.status)).toEqual(["error", "ok", "ok"]);
    expect(d.saved.map((c) => c.turn_id)).toEqual(["turn-1", "turn-2"]);
  });

  it("a REFUSED write is not a failed pass: it advances, and counts only what landed", async () => {
    // The store may refuse an op (an entry over the cap, an unknown id). The
    // model answered and we read the answer, so retrying the same slice would
    // just ask the same question again — but `entries` must not claim a write
    // that never happened.
    const log = memoryLog();
    turn(log, 1, [userSays("please always use tabs indentation")]);
    const d = deps({
      script: [doneWith('{"ops":[{"op":"add","text":"a fact"}]}')],
      outcomes: [{ applied: false, reason: "too_long" }],
    });
    const sched = createMemoryExtractionScheduler(d.deps);
    sched.schedule(log);
    await sched.drain();
    expect(d.writes).toHaveLength(1);
    expect(d.ledger[0]?.entries).toBe(0);
    expect(d.ledger[0]?.status).toBe("no-op");
    expect(d.saved.at(-1)?.turn_id).toBe("turn-1");
  });

  it("a throwing HOST dep is a failed slice, never a rejected pump", async () => {
    // schedule() is fire-and-forget: a rejection out of the pump is an
    // unhandled rejection in the turn path, which is exactly what this module
    // promises never happens. A host renderer that throws is a failed slice.
    const log = memoryLog();
    turn(log, 1, [userSays("a turn with enough prose to pass gate two")]);
    const { llm } = scriptedLlm([doneWith('{"ops":[]}')]);
    const saved: ExtractionCursor[] = [];
    const lines: string[] = [];
    let boom = true;
    const sched = createMemoryExtractionScheduler({
      llm,
      model: "m",
      entryMaxBytes: 2048,
      write: () => ({ applied: true }),
      manifest: () => {
        if (boom) throw new Error("manifest blew up");
        return "";
      },
      cursor: { load: () => null, save: (c) => void saved.push(c) },
      stderr: (line) => void lines.push(line),
    });
    sched.schedule(log);
    await sched.drain(); // RESOLVES: the fence turned the throw into a stderr line
    expect(lines.some((l) => l.includes("raised"))).toBe(true);
    expect(saved).toHaveLength(0);
    // ...and the same slice is retried once the host recovers.
    boom = false;
    sched.schedule(log);
    await sched.drain();
    expect(saved.at(-1)?.turn_id).toBe("turn-1");
  });

  it("coalesces: two schedules while in-flight process only the latest log", async () => {
    const log = memoryLog();
    turn(log, 1, [userSays("first turn with enough prose words")]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const requests: unknown[] = [];
    const llm: Llm = {
      async generate(req) {
        requests.push(req);
        await gate;
        return (async function* () {
          for (const e of doneWith('{"ops":[]}')) yield e;
        })();
      },
    };
    const saved: ExtractionCursor[] = [];
    const sched = createMemoryExtractionScheduler({
      llm, model: "m", entryMaxBytes: 2048,
      write: () => ({ applied: true }),
      manifest: () => "",
      cursor: { load: () => null, save: (c) => void saved.push(c) },
    });
    sched.schedule(log);
    turn(log, 2, [userSays("second turn also has enough prose")]);
    sched.schedule(log); // coalesces into the in-flight pass
    release();
    await sched.drain();
    // one pump, both turns sliced from the latest log in a single drain
    expect(saved.at(-1)).toEqual({ turn_id: "turn-2", event_count: log.events().length });
  });
});

// ---------------------------------------------------------------------------
// Turn wiring (compose → TurnRunner → schedule at turn end)
// ---------------------------------------------------------------------------

describe("turn wiring", () => {
  it("schedules extraction at every turn end, with the live session log", async () => {
    const { compose } = await import("./compose.js");
    const { fakeLoop, memorySessionPlugin, testProfile } = await import("./fakes.test-util.js");
    const log = memoryLog();
    const loop = fakeLoop(() => ({ text: "hi" }));
    const scheduled: string[] = [];
    const runtime = compose({
      profile: testProfile(),
      plugins: [memorySessionPlugin(log)],
      loopFactory: loop.factory,
      workers: false,
      extraction: {
        schedule(l): void {
          scheduled.push(l.events().at(-1)?.type ?? "?");
        },
        drain: (): Promise<void> => Promise.resolve(),
      },
    });
    await runtime.runTurn("one");
    await runtime.runTurn("two");
    // Each schedule sees the JUST-CLOSED log (its last event is that turn's end).
    expect(scheduled).toEqual(["turn_end", "turn_end"]);
    await runtime.shutdown();
  });
});
