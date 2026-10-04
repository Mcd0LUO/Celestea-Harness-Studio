/**
 * DefaultAgentLoop turn/step tests — the TS mirror of the turn-level cases of
 * `crates/agent-loop/src/lib.rs` (stream consumption, thinking aggregation,
 * deferred Done, five real terminal states, unique turn ids).
 */

import { describe, expect, it } from "vitest";
import {
  assistantText,
  AgentError,
  Context,
  LlmError,
  userMessage,
  type Llm,
  type Message,
  type StreamEvent,
  type TurnOutcome,
} from "@celestea/core";
import {
  eventsOfType,
  FailingLlm,
  FakeSessionLog,
  FakeToolRegistry,
  harness,
  HangingLlm,
  lastOutcome,
  loggedToolCalls,
  persistedKinds,
  makeLoop,
  ScriptedLlm,
  ScriptLlm,
  toolCallMessage,
  type Harness,
} from "./fakes.test-util.js";
import { errorOutcomeFromThrown } from "./loop.js";
import { estimateTokens, trimContext } from "./context-trim.js";
import { createUsageTracker } from "./usage.js";

/** `StreamEvent::Done(message)`. */
function done(message: Message): StreamEvent {
  return { kind: "done", message };
}

/** A registry whose spec read throws: a seam-contract violation (W813 P2). */
class ThrowingSchemasRegistry extends FakeToolRegistry {
  override schemas(): never {
    throw new Error("registry.schemas exploded");
  }
}

/** One harness per terminal state, all reaching the same single exit point. */
function terminalScenarios(): Array<{ name: string; outcome: TurnOutcome; make: () => Harness }> {
  const aborted = new AbortController();
  aborted.abort();
  return [
    {
      name: "completed",
      outcome: "completed",
      make: () => harness({ llm: new ScriptLlm([done(assistantText("done"))]) }),
    },
    {
      name: "error",
      outcome: { error: { kind: "generate", message: "provider timeout" } },
      make: () => harness({ llm: new FailingLlm() }),
    },
    {
      name: "step_limit",
      outcome: "step_limit",
      make: () => harness({ llm: new ScriptLlm([done(toolCallMessage(["c1"]))]), config: { max_steps: 1 } }),
    },
    {
      name: "interrupted",
      outcome: "interrupted",
      make: () => harness({ llm: new ScriptLlm([{ kind: "text", text: "trunc" }]) }),
    },
    {
      name: "cancelled",
      outcome: "cancelled",
      make: () => harness({ llm: new HangingLlm(), bindings: { signal: aborted.signal } }),
    },
  ];
}

describe("DefaultAgentLoop — stream consumption", () => {
  it("consumes a thinking stream and persists exactly one assistant message", async () => {
    const h = harness({
      llm: new ScriptLlm([
        { kind: "thinking", text: "Let me think." },
        { kind: "text", text: " answer" },
        done(assistantText(" answer")),
      ]),
    });

    const outcome = await h.run();

    expect(outcome).toBe("completed");
    expect(eventsOfType(h.session, "assistant_message").map((e) => e.text)).toEqual([" answer"]);
    expect(persistedKinds(h.session)).toEqual(["thinking:Let me think.", "assistant: answer"]);
  });

  it("logs turn_start/user_message then the reply, and ends with turn_end", async () => {
    const h = harness({ llm: new ScriptLlm([done(assistantText("done"))]) });

    await h.run("hi");

    expect(h.session.events().map((e) => e.type)).toEqual([
      "turn_start",
      "user_message",
      "assistant_message",
      "turn_end",
    ]);
    expect(eventsOfType(h.session, "turn_start")[0]?.id).toBe("turn-0");
    expect(eventsOfType(h.session, "user_message")[0]?.text).toBe("hi");
    expect(lastOutcome(h.session)).toBe("completed");
  });

  it("W855 C8: a null input writes NO user_message row (the drain supplies the content)", async () => {
    const h = harness({ llm: new ScriptLlm([done(assistantText("done"))]) });

    await h.loop.runTurn(h.ctx, null);

    expect(h.session.events().map((e) => e.type)).toEqual([
      "turn_start",
      "assistant_message",
      "turn_end",
    ]);
    expect(eventsOfType(h.session, "user_message")).toHaveLength(0);
    expect(lastOutcome(h.session)).toBe("completed");
  });

  it("W855 C8: null + attachments still writes the empty-text image row (W804 preserved)", async () => {
    const h = harness({ llm: new ScriptLlm([done(assistantText("done"))]) });
    const ref = { attachment_id: "a".repeat(64), media_type: "image/png" as const, width: 1, height: 1 };

    await h.loop.runTurn(h.ctx, null, [ref]);

    const rows = eventsOfType(h.session, "user_message");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("");
    expect(rows[0]?.attachments).toEqual([ref]);
  });

  it("delivers stream events to the sink in emission order", async () => {
    const h = harness({
      llm: new ScriptLlm([
        { kind: "thinking", text: "think." },
        { kind: "text", text: " hi" },
        done(assistantText(" hi")),
      ]),
    });

    await h.run();

    expect(h.sink.kinds()).toEqual(["thinking", "text", "done", "turn_end"]);
    const doneEvent = h.sink.events[2];
    expect(doneEvent).toMatchObject({ kind: "done", text: " hi", tool_calls: [] });
  });

});

describe("DefaultAgentLoop — tool steps", () => {
  it("runs a tool-call step and then the final answer", async () => {
    const h = harness({
      llm: new ScriptedLlm([
        [done(toolCallMessage(["c1"]))],
        [{ kind: "text", text: "all done" }, done(assistantText("all done"))],
      ]),
    });

    const outcome = await h.run();

    expect(outcome).toBe("completed");
    expect(loggedToolCalls(h.session)).toEqual(["c1"]);
    expect(persistedKinds(h.session)).toEqual(["toolcall:c1", "toolresult:c1", "assistant:all done"]);
    expect(h.sink.kinds()).toEqual(["done", "tool_call", "tool_result", "text", "done", "turn_end"]);
  });

});

describe("DefaultAgentLoop — terminal states", () => {
  it("marks a generation failure as error{generate} with a TurnEnd and no reply", async () => {
    const h = harness({ llm: new FailingLlm() });

    const outcome = await h.run();

    // The terminal state rides the log, the promise still resolves (P0-A).
    expect(outcome).toEqual({ error: { kind: "generate", message: "provider timeout" } });
    expect(lastOutcome(h.session)).toEqual({ error: { kind: "generate", message: "provider timeout" } });
    expect(eventsOfType(h.session, "assistant_message")).toHaveLength(0);
    expect(h.sink.kinds()).toEqual(["turn_end"]);
  });

  it("marks a stream failure as error{stream} and never flushes a partial reply", async () => {
    const h = harness({
      llm: new ScriptLlm([
        { kind: "text", text: "partial" },
        { kind: "failed", kindOf: "stream", message: "sse decode error: torn" },
      ]),
    });

    const outcome = await h.run();

    expect(outcome).toEqual({ error: { kind: "stream", message: "sse decode error: torn" } });
    expect(eventsOfType(h.session, "assistant_message")).toHaveLength(0);
  });

  it("marks a torn stream (no terminal frame) as interrupted", async () => {
    const h = harness({ llm: new ScriptLlm([{ kind: "text", text: "trunc" }]) });

    const outcome = await h.run();

    expect(outcome).toBe("interrupted");
    expect(eventsOfType(h.session, "assistant_message")).toHaveLength(0);
  });

  it("marks an exhausted step budget as step_limit, never completed", async () => {
    const h = harness({
      llm: new ScriptedLlm([
        [done(toolCallMessage(["c1"]))],
        [done(toolCallMessage(["c2"]))],
        [done(assistantText("never reached"))],
      ]),
      config: { max_steps: 2 },
    });

    const outcome = await h.run();

    expect(outcome).toBe("step_limit");
    expect(h.registry.order).toEqual(["c1", "c2"]);
    expect(eventsOfType(h.session, "assistant_message")).toHaveLength(0);
    expect(persistedKinds(h.session)).toEqual(["toolcall:c1", "toolresult:c1", "toolcall:c2", "toolresult:c2"]);
  });

});

describe("DefaultAgentLoop — bookkeeping", () => {
  it("treats max_steps = 0 as unlimited", async () => {
    const h = harness({
      llm: new ScriptedLlm([
        [done(toolCallMessage(["c1"]))],
        [done(toolCallMessage(["c2"]))],
        [done(toolCallMessage(["c3"]))],
        [done(assistantText("done"))],
      ]),
      config: { max_steps: 0 },
    });

    const outcome = await h.run();

    expect(outcome).toBe("completed");
    expect(h.registry.order).toEqual(["c1", "c2", "c3"]);
  });

  it("keeps turn ids unique across loop instances (the log owns the counter)", async () => {
    const session = new FakeSessionLog();
    const llm = new ScriptLlm([done(assistantText("a"))]);
    await harness({ llm, session }).run();
    await harness({ llm, session }).run();

    expect(eventsOfType(session, "turn_start").map((e) => e.id)).toEqual(["turn-0", "turn-1"]);
    expect(eventsOfType(session, "turn_end").map((e) => e.id)).toEqual(["turn-0", "turn-1"]);
  });

  it("aggregates one contiguous thinking burst into one persisted row", async () => {
    const h = harness({
      llm: new ScriptLlm([
        { kind: "thinking", text: "part one." },
        { kind: "thinking", text: " part two." },
        { kind: "text", text: " hi" },
        { kind: "thinking", text: "recheck." },
        done(assistantText(" hi")),
      ]),
    });

    await h.run();

    expect(persistedKinds(h.session)).toEqual(["thinking:part one. part two.", "thinking:recheck.", "assistant: hi"]);
    expect(eventsOfType(h.session, "thinking_delta")).toHaveLength(2);
    // live deltas are still emitted one by one
    expect(h.sink.kinds().filter((k) => k === "thinking")).toHaveLength(3);
  });

  it("persists aggregated thinking before the tool calls of the same step", async () => {
    const h = harness({
      llm: new ScriptedLlm([
        [{ kind: "thinking", text: "plan tool use." }, done(toolCallMessage(["c1"]))],
        [done(assistantText("done"))],
      ]),
    });

    await h.run();

    expect(persistedKinds(h.session)).toEqual(["thinking:plan tool use.", "toolcall:c1", "toolresult:c1", "assistant:done"]);
  });

  it("emits trailing reasoning before the deferred Done", async () => {
    const h = harness({
      llm: new ScriptLlm([
        { kind: "thinking", text: "early." },
        { kind: "text", text: " hi" },
        done(assistantText(" hi")),
        { kind: "thinking", text: "late." },
      ]),
    });

    const outcome = await h.run();

    expect(outcome).toBe("completed");
    expect(h.sink.kinds()).toEqual(["thinking", "text", "thinking", "done", "turn_end"]);
    // the late burst still lands before the reply it belongs to
    expect(persistedKinds(h.session)).toEqual(["thinking:early.", "thinking:late.", "assistant: hi"]);
  });

  it("writes exactly one TurnEnd on every terminal path", async () => {
    for (const scenario of terminalScenarios()) {
      const h = scenario.make();
      const outcome = await h.run();
      expect(outcome, scenario.name).toEqual(scenario.outcome);
      expect(eventsOfType(h.session, "turn_end"), scenario.name).toHaveLength(1);
      expect(h.sink.events.filter((e) => e.kind === "turn_end"), scenario.name).toHaveLength(1);
      expect(h.sink.events.at(-1)?.kind, scenario.name).toBe("turn_end");
    }
  });

  it("writes exactly one TurnEnd even when a seam throws before the step returns (W813 P2)", async () => {
    const h = harness({ llm: new ScriptLlm([]), registry: new ThrowingSchemasRegistry() });

    await expect(h.run()).rejects.toThrow("registry.schemas exploded");

    // The turn_start this throw used to strand is closed by exactly one turn_end
    // carrying the captured error, so the log the watchdog reads stays
    // consistent (turn_start count === turn_end count, no dangling turn).
    const starts = eventsOfType(h.session, "turn_start");
    const ends = eventsOfType(h.session, "turn_end");
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(ends[0]?.id).toBe(starts[0]?.id);
    expect(ends[0]?.outcome).toEqual({ error: { kind: "generate", message: "registry.schemas exploded" } });
    // The terminal frame is also the LAST event on the sink (single exit point).
    expect(h.sink.events.filter((e) => e.kind === "turn_end")).toHaveLength(1);
    expect(h.sink.events.at(-1)?.kind).toBe("turn_end");
  });

  it("rejects with AgentError when the Context is missing a driver seam", async () => {
    const h = harness({ llm: new ScriptLlm([done(assistantText("done"))]) });
    const bare = Context.root();
    bare.provide("celestea.core.Llm", h.ctx.get("celestea.core.Llm") as Llm);

    await expect(h.loop.runTurn(bare, "hi")).rejects.toThrow(AgentError);
    await expect(h.loop.runTurn(bare, "hi")).rejects.toThrow(/missing SessionLog service/);
  });

  it("exposes its config and the bound usage tracker", () => {
    const tracker = createUsageTracker();
    expect(makeLoop({ max_steps: 3 }, { usage: tracker }).agentConfig.max_steps).toBe(3);
    expect(makeLoop({}, { usage: tracker }).usageTracker).toBe(tracker);
    expect(makeLoop({}).usageTracker).toBeUndefined();
  });
});

describe("contextSnapshot (W725)", () => {
  it("is the loop's own request: system prompt, derived history and tool schemas", () => {
    const h = harness({ llm: new ScriptLlm([]) });
    h.session.setDerived([userMessage("hi"), assistantText("hello")]);
    const snapshot = h.loop.contextSnapshot(h.ctx);
    expect(snapshot.model).toBe(h.loop.agentConfig.model);
    expect(snapshot.system).toBe(h.loop.agentConfig.system_prompt);
    expect(snapshot.messages).toEqual(h.session.deriveMessages());
    expect(snapshot.tools).toEqual(h.registry.schemas());
    expect(snapshot.max_tokens).toBeNull();
  });

  it("trims exactly like the turn does, and never writes to the log", () => {
    const config = { context_window_tokens: 100, context_trim_threshold: 1, context_keep_recent: 1 };
    const h = harness({ llm: new ScriptLlm([]), config });
    h.session.setDerived([userMessage("x".repeat(4_000)), userMessage("y".repeat(4_000)), userMessage("z".repeat(4_000))]);
    const before = h.session.events().length;
    const snapshot = h.loop.contextSnapshot(h.ctx);
    // Read-only: taking a snapshot records no event of its own.
    expect(h.session.events()).toHaveLength(before);
    const expected = trimContext(h.session.deriveMessages(), estimateTokens(h.loop.agentConfig.system_prompt), 100, 1, 1);
    expect(expected.outcome.trimmed).toBe(true);
    expect(snapshot.messages).toEqual(expected.messages);
  });
});

/**
 * B2-02 / B2-03 — one failure, ONE terminal kind, whichever decorator is armed.
 *
 * Before: a provider 401 was `kind:"generate"` with no fallback decorator and
 * `kind:"stream"` with one, because the decorator re-threw out of its async
 * generator and the loop hard-coded `"stream"` for any iterator rejection. The
 * turn therefore reported a different terminal state for the same upstream
 * failure depending on a config switch, which makes every kind-based aggregate
 * (the usage ledger's `error_kind` column, the statusline) untrustworthy.
 */
describe("B2-02 — a thrown LlmError is believed, not relabelled", () => {
  it("maps a pre-stream LlmError to generate", () => {
    expect(errorOutcomeFromThrown(new LlmError("stream request failed: 401", "generate", { httpStatus: 401 }))).toEqual({
      error: { kind: "generate", message: "stream request failed: 401" },
    });
  });

  it("maps a mid-stream LlmError to stream", () => {
    expect(errorOutcomeFromThrown(new LlmError("sse decode error: hung up", "stream"))).toEqual({
      error: { kind: "stream", message: "sse decode error: hung up" },
    });
  });

  it("folds a timeout to the frozen outcome vocabulary, keeping the message", () => {
    // TurnOutcome.error.kind is frozen to generate|stream ([TurnOutcome]);
    // the timeout fact stays visible in the message, as the host adapter does.
    const outcome = errorOutcomeFromThrown(new LlmError("llm timeout: response headers not received within 60000ms", "timeout"));
    expect(outcome.error.kind).toBe("generate");
    expect(outcome.error.message).toContain("llm timeout:");
  });

  it("lets the CALL SITE decide an unclassified throw, because only it knows where it came from", () => {
    const bare = new Error("socket hang up");
    // From generate() → pre-stream. From iter.next() → the stream broke.
    expect(errorOutcomeFromThrown(bare)).toEqual({ error: { kind: "generate", message: "socket hang up" } });
    expect(errorOutcomeFromThrown(bare, "stream")).toEqual({ error: { kind: "stream", message: "socket hang up" } });
    // A bare string behaves identically — it carries no classification either.
    expect(errorOutcomeFromThrown("a bare string")).toEqual({ error: { kind: "generate", message: "a bare string" } });
    expect(errorOutcomeFromThrown("a bare string", "stream")).toEqual({ error: { kind: "stream", message: "a bare string" } });
  });

  it("reports the SAME kind whether the failure came from generate() or from mid-iteration", async () => {
    const upstream = new LlmError("stream request failed: 401 Unauthorized", "generate", { httpStatus: 401, retryable: false });

    // (a) the bare client: generate() itself rejects — the pre-stream path.
    const preStream = harness({ llm: { generate: () => Promise.reject(upstream) } as unknown as Llm });
    const a = await preStream.run("hi");

    // (b) the decorator shape: generate() RESOLVES to an async generator whose
    //     body throws on the first pull — the path that used to be hard-coded to
    //     "stream" no matter what the error actually said.
    const midStream = harness({
      llm: {
        generate: () =>
          Promise.resolve({
            async *[Symbol.asyncIterator]() {
              throw upstream;
            },
          }),
      } as unknown as Llm,
    });
    const b = await midStream.run("hi");

    expect(a).toEqual({ error: { kind: "generate", message: "stream request failed: 401 Unauthorized" } });
    expect(b).toEqual(a);
  });
});
