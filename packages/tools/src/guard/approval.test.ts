/**
 * W-C1b · the MCP approval guard's decision table
 * (docs/feature/mcp-client.md §7.1, acceptance A13/A14/A15).
 *
 * The guard is exercised through a REAL `ToolRegistryImpl` — never by calling
 * `check()` directly — because the semantics under test include the registry's
 * own behaviour: an `ask` decision is TERMINAL, so "the tool never ran" is a
 * property of the dispatch, not of the guard.
 *
 * No subprocess, no socket: the answer channel is a fake `UserQuestionService`
 * (the seam the whole design reuses) and the remote side is not involved at all
 * here — this file is about the guard, the tool is a local double.
 */

import { describe, expect, it } from "vitest";
import type { AskUserQuestionOutcome, AskUserQuestionRequest, Tool, ToolInput, UserQuestionService } from "@celestea/core";
import { UserQuestionError } from "@celestea/core";

import { createToolRegistry } from "../registry.js";
import {
  APPROVAL_LABEL_ALWAYS,
  APPROVAL_LABEL_ALLOW_ONCE,
  APPROVAL_LABEL_DENY,
  APPROVAL_UNDECIDED_CODE,
  APPROVAL_DENIED_CODE,
  McpApprovalGuard,
  MCP_TOOL_PREFIX,
  type McpApprovalRule,
} from "./approval.js";

const MCP = `${MCP_TOOL_PREFIX}memory__remember`;

/** A question service that records what it was asked and answers on cue. */
function channel(reply: (request: AskUserQuestionRequest) => Promise<AskUserQuestionOutcome>): UserQuestionService & { asked: AskUserQuestionRequest[] } {
  const asked: AskUserQuestionRequest[] = [];
  return {
    asked,
    ask(request: AskUserQuestionRequest): Promise<AskUserQuestionOutcome> {
      asked.push(request);
      return reply(request);
    },
  };
}

function answer(selected: string[], timedOut = false): AskUserQuestionOutcome {
  return { answers: [{ id: "mcp-approval", selected }], timed_out: timedOut };
}

function call(name: string): ToolInput {
  return { call_id: "c1", name, args: {}, signal: undefined };
}

/** A local double for "the remote tool ran". */
function counter(): Tool & { runs: number } {
  const tool = {
    runs: 0,
    spec: () => ({ name: MCP, description: "fake", parameters: { type: "object", properties: {} } }),
    execute: async () => {
      tool.runs++;
      return { ok: true };
    },
  };
  return tool;
}

describe("McpApprovalGuard", () => {
  it("allows a NON-MCP tool without touching the answer channel", async () => {
    const questions = channel(async () => answer([APPROVAL_LABEL_ALLOW_ONCE]));
    const guard = new McpApprovalGuard({ questions, rules: new Map() });
    const decision = await guard.check(call("read_file"));

    expect(decision).toEqual({ kind: "allow" });
    // The channel is the scarce resource; a guard that can only ever allow must
    // not be allowed to spend a question on a built-in tool.
    expect(questions.asked).toHaveLength(0);
  });

  it("asks the human for an approval:ask tool, and runs it once allowed", async () => {
    const questions = channel(async () => answer([APPROVAL_LABEL_ALLOW_ONCE]));
    const guard = new McpApprovalGuard({ questions, rules: new Map([[MCP, { approval: "ask", server: "memory", tool: "remember" }]]) });
    const tool = counter();
    const registry = createToolRegistry([tool]);
    registry.addGuard(guard);

    const output = await registry.dispatch(call(MCP));

    expect(output.decision).toEqual({ kind: "allow" });
    expect(tool.runs).toBe(1);
    expect(questions.asked).toHaveLength(1);
    // The card names the SERVER, not just the model-visible name (§7.1).
    expect(questions.asked[0]?.questions[0]?.header).toBe("mcp:memory");
    expect(questions.asked[0]?.questions[0]?.options?.map((o) => o.label)).toEqual([
      APPROVAL_LABEL_DENY,
      APPROVAL_LABEL_ALLOW_ONCE,
      APPROVAL_LABEL_ALWAYS,
    ]);
  });

  it("never: passes the call through WITHOUT asking (the explicit unattended exit)", async () => {
    const questions = channel(async () => answer([APPROVAL_LABEL_DENY]));
    const guard = new McpApprovalGuard({ questions, rules: new Map([[MCP, { approval: "never" }]]) });
    const tool = counter();
    const registry = createToolRegistry([tool]);
    registry.addGuard(guard);

    const output = await registry.dispatch(call(MCP));

    expect(output.decision).toEqual({ kind: "allow" });
    expect(tool.runs).toBe(1);
    expect(questions.asked).toHaveLength(0);
  });

  it("A15: deny refuses the call; 'allow once' does not carry over to the next call", async () => {
    const answers = [APPROVAL_LABEL_DENY, APPROVAL_LABEL_ALLOW_ONCE];
    const questions = channel(async () => answer([answers.shift() ?? APPROVAL_LABEL_DENY]));
    const guard = new McpApprovalGuard({ questions, rules: new Map<string, McpApprovalRule>([[MCP, { approval: "ask" }]]) });
    const tool = counter();
    const registry = createToolRegistry([tool]);
    registry.addGuard(guard);

    const denied = await registry.dispatch(call(MCP));
    expect(denied.decision?.kind).toBe("deny");
    expect(denied.error).toContain(APPROVAL_DENIED_CODE);
    expect(tool.runs).toBe(0);

    const once = await registry.dispatch(call(MCP));
    expect(once.decision).toEqual({ kind: "allow" });
    expect(tool.runs).toBe(1);

    // ...and the SECOND call has to ask again: one nod is one call.
    const again = await registry.dispatch(call(MCP));
    expect(again.decision?.kind).toBe("deny");
    expect(tool.runs).toBe(1);
    expect(questions.asked).toHaveLength(3);
  });

  it("'allow for this session' is remembered for THIS guard instance only", async () => {
    const questions = channel(async () => answer([APPROVAL_LABEL_ALWAYS]));
    const rules = new Map<string, McpApprovalRule>([[MCP, { approval: "ask" }]]);
    const guard = new McpApprovalGuard({ questions, rules });
    const tool = counter();
    const registry = createToolRegistry([tool]);
    registry.addGuard(guard);

    await registry.dispatch(call(MCP));
    await registry.dispatch(call(MCP));

    expect(tool.runs).toBe(2);
    expect(questions.asked).toHaveLength(1);

    // A RE-ASSEMBLED generation is a new guard: the standing permission does
    // not survive it (D7 — the generation is the unit). The proof is that the
    // channel is asked a SECOND time — a rule that survived would be silent.
    const next = new McpApprovalGuard({ questions, rules });
    await next.check(call(MCP));
    expect(questions.asked).toHaveLength(2);
  });

  it("A13: with no answerer mounted the call fails CLOSED, never silently through", async () => {
    const guard = new McpApprovalGuard({ questions: null, rules: new Map<string, McpApprovalRule>([[MCP, { approval: "ask" }]]) });
    const tool = counter();
    const registry = createToolRegistry([tool]);
    registry.addGuard(guard);

    const output = await registry.dispatch(call(MCP));

    expect(output.decision?.kind).toBe("ask");
    expect(output.error).toContain(APPROVAL_UNDECIDED_CODE);
    expect(tool.runs).toBe(0);
  });

  it("A13: a refused channel (DELEGATED_CALLER / NO_PROVIDER) is fail-closed too", async () => {
    const questions = channel(async () => {
      throw new UserQuestionError("sub-agents have no human", "DELEGATED_CALLER");
    });
    const guard = new McpApprovalGuard({ questions, rules: new Map<string, McpApprovalRule>([[MCP, { approval: "ask" }]]) });
    const tool = counter();
    const registry = createToolRegistry([tool]);
    registry.addGuard(guard);

    const output = await registry.dispatch(call(MCP));

    expect(output.decision?.kind).toBe("ask");
    // The code is carried for the operator, but the DECISION does not depend on
    // it: every refusal is the same refusal.
    expect(output.error).toContain("DELEGATED_CALLER");
    expect(tool.runs).toBe(0);
  });

  it("A14: a timed-out approval is UNDECIDED (ask), not a denial, and nothing ran", async () => {
    const questions = channel(async () => answer([], true));
    const guard = new McpApprovalGuard({ questions, rules: new Map<string, McpApprovalRule>([[MCP, { approval: "ask" }]]) });
    const tool = counter();
    const registry = createToolRegistry([tool]);
    registry.addGuard(guard);

    const output = await registry.dispatch(call(MCP));

    // "denied" would claim a person said no; nobody did.
    expect(output.decision?.kind).toBe("ask");
    expect(output.error).not.toContain(APPROVAL_DENIED_CODE);
    expect(tool.runs).toBe(0);
  });

  it("an undeclared mcp__ name defaults to ask, not to never", async () => {
    const questions = channel(async () => answer([APPROVAL_LABEL_ALLOW_ONCE]));
    const guard = new McpApprovalGuard({ questions, rules: new Map() });
    // The observable difference between "asked" and "never" is exactly one
    // thing: whether the channel was consulted at all.
    await guard.check(call(`${MCP_TOOL_PREFIX}ghost__tool`));
    expect(questions.asked).toHaveLength(1);
  });
});
