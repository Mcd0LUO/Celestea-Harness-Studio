/**
 * W1900 (Phase 2) — the compression nudge.
 *
 * The nudge is advice, and advice that lies is worse than no advice at all, so
 * these tests pin three things: it fires at the level it claims to fire at, it
 * says the level it actually measured, and — the load-bearing one — it is
 * EPHEMERAL. It is assembled into the request and thrown away. Nothing appends
 * it, so it cannot become history, and it never touches the frozen system
 * prompt, so the loop's trim budget, the 0b dedup visibility simulation and the
 * statusline estimate keep reading one string.
 *
 * The last group is the regression guard for a failure mode that would be
 * invisible in a happy-path test: a reader that throws, or a host that never
 * injected one, must leave the turn running exactly as it did before Phase 2.
 */

import { assistantText, type ContextUsageFacts, type Message, type StreamEvent } from "@celestea/core";
import { describe, expect, it } from "vitest";

import { COMPRESSION_NUDGE_PREFIX, compressionNudgeMessage, compressionNudgeText, NUDGE_RATIO, shouldNudge } from "./compression-nudge.js";
import { harness, ScriptLlm } from "./fakes.test-util.js";

function usage(ratio: number): ContextUsageFacts {
  return { used: Math.round(ratio * 100_000), window: 100_000, ratio, estimated: true, method: "assembled_estimate", projected: false };
}

function textOf(message: Message): string {
  let out = "";
  for (const part of message.content) if (part.type === "text") out += part.content;
  return out;
}

const DONE: StreamEvent[] = [{ kind: "done", message: assistantText("ok") }];

describe("W1900 · the nudge text", () => {
  it("quotes the level it was given, to the whole percent", () => {
    const text = compressionNudgeText(usage(0.534), 7);
    expect(text.startsWith(COMPRESSION_NUDGE_PREFIX)).toBe(true);
    expect(text).toContain("53%");
    expect(text).toContain("turn 7");
  });

  it("is OPTIONAL at the nudge ratio and INSISTING past the preflight ratio", () => {
    // The optional branch offers; the insisting branch orders. The two must not
    // be mistakable, because the difference is "the engine is about to delete
    // history for you" — a model that does not expect that will fight it.
    expect(compressionNudgeText(usage(NUDGE_RATIO), 3)).toContain("MAY");
    expect(compressionNudgeText(usage(NUDGE_RATIO), 3)).toContain("optional");
    expect(compressionNudgeText(usage(NUDGE_RATIO), 3)).not.toContain("LOSSY");
    expect(compressionNudgeText(usage(0.8), 3)).toContain("LOSSY");
    expect(compressionNudgeText(usage(0.8), 3)).toContain("compress it now");
    expect(compressionNudgeText(usage(0.8), 3)).not.toContain("MAY");
  });

  it("always forbids the one range that must never be folded", () => {
    for (const ratio of [NUDGE_RATIO, 0.79, 0.8, 0.99]) {
      expect(compressionNudgeText(usage(ratio), 2)).toContain("Never compress the turn you are answering in");
    }
  });
});

describe("W1900 · when the nudge fires", () => {
  it("stays silent below the threshold, and on an unknown level", () => {
    expect(shouldNudge(usage(0.49))).toBe(false);
    expect(shouldNudge(null)).toBe(false);
    // A window of 0 means "we could not measure", which is not half full.
    expect(shouldNudge({ ...usage(0.9), window: 0 })).toBe(false);
    expect(compressionNudgeMessage(usage(0.49), 2)).toBeNull();
    expect(compressionNudgeMessage(null, 2)).toBeNull();
  });

  it("fires AT the threshold, not above it", () => {
    expect(shouldNudge(usage(NUDGE_RATIO))).toBe(true);
    expect(compressionNudgeMessage(usage(NUDGE_RATIO), 4)?.role).toBe("system");
  });

  it("is a SYSTEM message, so dedup cannot read it as a resident row", () => {
    const message = compressionNudgeMessage(usage(0.6), 4);
    expect(message?.role).toBe("system");
  });
});

describe("W1900 · the nudge is ephemeral (W1900 core promise)", () => {
  it("appears at the TAIL of the request and never in the log", async () => {
    const llm = new ScriptLlm(DONE);
    const h = harness({
      llm,
      config: { system_prompt: "SYSTEM", context_window_tokens: 100_000 },
      bindings: { contextUsage: () => usage(0.62) },
    });
    h.session.setDerived([{ role: "user", content: [{ type: "text", content: "hi" }], tool_call_id: null }]);

    await h.run("hello");

    const request = llm.requests[0]!;
    const last = request.messages[request.messages.length - 1]!;
    expect(last.role).toBe("system");
    expect(textOf(last)).toContain(COMPRESSION_NUDGE_PREFIX);
    expect(textOf(last)).toContain("62%");

    // The log never saw it: nothing appended a message the harness did not.
    const logged = JSON.stringify(h.session.events());
    expect(logged).not.toContain(COMPRESSION_NUDGE_PREFIX);
    // Nor did the derived view the loop reads.
    expect(JSON.stringify(h.session.deriveMessages())).not.toContain(COMPRESSION_NUDGE_PREFIX);
  });

  it("never enters the system prompt (the frozen, cache-critical string)", async () => {
    const llm = new ScriptLlm(DONE);
    const h = harness({
      llm,
      config: { system_prompt: "SYSTEM" },
      bindings: { contextUsage: () => usage(0.9) },
    });
    h.session.setDerived([{ role: "user", content: [{ type: "text", content: "hi" }], tool_call_id: null }]);

    await h.run("hello");

    expect(llm.requests[0]!.system).toBe("SYSTEM");
    expect(llm.requests[0]!.system).not.toContain(COMPRESSION_NUDGE_PREFIX);
  });

  it("is rebuilt every step, so it can never go stale across a long turn", async () => {
    let reads = 0;
    const llm = new ScriptLlm(DONE);
    const h = harness({
      llm,
      config: { system_prompt: "SYSTEM" },
      bindings: { contextUsage: () => { reads += 1; return usage(0.7); } },
    });
    h.session.setDerived([{ role: "user", content: [{ type: "text", content: "hi" }], tool_call_id: null }]);

    await h.run("hello");

    expect(reads).toBeGreaterThan(0);
    const requests = llm.requests;
    for (const request of requests) {
      expect(request.messages.filter((m) => textOf(m).includes(COMPRESSION_NUDGE_PREFIX))).toHaveLength(1);
    }
  });
});

describe("W1900 · absent or broken injection degrades to the old behaviour", () => {
  it("with NO contextUsage binding the request is byte-identical to pre-Phase-2", async () => {
    const llm = new ScriptLlm(DONE);
    const h = harness({ llm, config: { system_prompt: "SYSTEM" } });
    h.session.setDerived([{ role: "user", content: [{ type: "text", content: "hi" }], tool_call_id: null }]);

    await h.run("hello");

    const request = llm.requests[0]!;
    expect(request.messages).toHaveLength(1);
    expect(textOf(request.messages[0]!)).toBe("hi");
  });

  it("a below-threshold reading adds nothing at all", async () => {
    const llm = new ScriptLlm(DONE);
    const h = harness({ llm, bindings: { contextUsage: () => usage(0.2) } });
    h.session.setDerived([{ role: "user", content: [{ type: "text", content: "hi" }], tool_call_id: null }]);

    await h.run("hello");

    expect(llm.requests[0]!.messages).toHaveLength(1);
  });

  it("a reader that throws costs the nudge, not the turn", async () => {
    const llm = new ScriptLlm(DONE);
    const h = harness({
      llm,
      bindings: {
        contextUsage: () => {
          throw new Error("status plane exploded");
        },
      },
    });
    h.session.setDerived([{ role: "user", content: [{ type: "text", content: "hi" }], tool_call_id: null }]);

    const outcome = await h.run("hello");

    expect(outcome).toBe("completed");
    expect(llm.requests[0]!.messages).toHaveLength(1);
  });

  it("a reader that returns null costs the nudge, not the turn", async () => {
    const llm = new ScriptLlm(DONE);
    const h = harness({ llm, bindings: { contextUsage: () => null } });
    h.session.setDerived([{ role: "user", content: [{ type: "text", content: "hi" }], tool_call_id: null }]);

    expect(await h.run("hello")).toBe("completed");
    expect(llm.requests[0]!.messages).toHaveLength(1);
  });
});
