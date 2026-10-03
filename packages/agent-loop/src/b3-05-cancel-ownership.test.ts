/**
 * B3-05 — "a cancelled turn leaves a process the user cannot reach".
 *
 * B3-05 was filed as the CONSEQUENCE of B3-01: the tool kept running behind a
 * turn that had already reported itself `cancelled`, and because a foreground
 * `run_shell` is not registered in the ProcessRegistry, `process_control` could
 * not reach it either — an orphan with no handle anywhere.
 *
 * B3-01's fix (the signal now reaches the tool) already removes the orphan. What
 * is left for the loop to guarantee is the part that made it INVISIBLE: after a
 * cancellation, nothing waits for the abandoned batch, so the turn log records
 * `cancelled; execution may have completed` and never learns what the tool
 * actually did. That is honest, and it is the correct contract — but it is only
 * honest if the work really did stop, and nothing in the loop could tell.
 *
 * These tests pin BOTH halves of that:
 *   1. the tool receives the signal and can therefore stop (the loop's
 *      contribution — proven by the signal's identity, not by any tool's behaviour);
 *   2. a tool that ignores the signal produces NO unhandled rejection and NO
 *      extra log row, so a cancelled turn cannot be corrupted by work it
 *      abandoned.
 *
 * A note on what is deliberately NOT here: the process itself. Pinning "the
 * child is dead" needs a real sandbox and a real interpreter, and that already
 * lives in `packages/tools/**` (`b3-abort-kills-child.test.ts`,
 * `b3-run-shell-cancel.test.ts`). agent-loop has no path to the ProcessRegistry
 * and must not grow one — see the B3-05 note in loop.ts.
 */

import { describe, expect, it } from "vitest";
import type { ToolInput, ToolOutput } from "@celestea/core";

import { FakeToolRegistry, harness, ScriptLlm, toolCallMessage } from "./fakes.test-util.js";
import { CANCELLED_EXECUTION_UNCERTAIN } from "./cancel.js";

/** A tool that observes the signal and settles shortly after the abort. */
function cooperativeTool(onAbort: () => void, registry: FakeToolRegistry): void {
  registry.dispatch = async (input: ToolInput): Promise<ToolOutput> => {
    registry.order.push(input.call_id);
    const signal = input.signal;
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        onAbort();
        setTimeout(resolve, 20);
      };
      if (signal === undefined) resolve();
      else if (signal.aborted) finish();
      else signal.addEventListener("abort", finish, { once: true });
    });
    return { call_id: input.call_id, value: { ok: true }, render: null, error: null, decision: { kind: "allow" } };
  };
}

describe("B3-05: a cancelled turn leaves the tool able to stop", () => {
  it("the in-flight tool is told, so it is not left running unreachably", async () => {
    const controller = new AbortController();
    let sawAbort = false;
    const registry = new FakeToolRegistry();
    cooperativeTool(() => {
      sawAbort = true;
    }, registry);

    const h = harness({
      llm: new ScriptLlm([{ kind: "done", message: toolCallMessage(["c1"]) }]),
      registry,
      bindings: { signal: controller.signal },
    });
    setTimeout(() => controller.abort(new Error("stop")), 10);

    const outcome = await h.run("hi");

    expect(outcome).toBe("cancelled");
    // The whole of B3-05: the tool that was already running was TOLD. Without
    // the signal on ToolInput this is false, and the tool is the only thing that
    // can stop the work it started.
    expect(sawAbort).toBe(true);
  });

  it("the cancelled row stays honest while the tool is still finishing", async () => {
    const controller = new AbortController();
    const registry = new FakeToolRegistry();
    // Settles AFTER the loop has already moved on, which is the race the log has
    // to describe without lying.
    cooperativeTool(() => undefined, registry);

    const h = harness({
      llm: new ScriptLlm([{ kind: "done", message: toolCallMessage(["c1"]) }]),
      registry,
      bindings: { signal: controller.signal },
    });
    setTimeout(() => controller.abort(new Error("stop")), 10);

    await h.run("hi");
    await new Promise((resolve) => setTimeout(resolve, 40));

    // Exactly ONE tool_result row: the loop does not append a second one when the
    // abandoned work finally lands. A late result must not rewrite history.
    const rows = h.session.events().filter((e) => e.type === "tool_result");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.error).toBe(CANCELLED_EXECUTION_UNCERTAIN);
  });

  it("a tool that ignores the signal cannot corrupt the cancelled log", async () => {
    const controller = new AbortController();
    const registry = new FakeToolRegistry();
    // Rejects long after the abort. `dispatchCall` is TOTAL — it converts every
    // tool error into a ToolOutput — so the batch cannot reject and the loop can
    // never see this. That totality is the real reason an abandoned batch is
    // harmless, and an earlier version of this test wrongly asserted "no
    // unhandled rejection" against a rejection that is structurally impossible.
    // What IS worth pinning is the consequence: the tool's own failure never
    // reaches the log, and never produces a second row.
    registry.dispatch = (input: ToolInput): Promise<ToolOutput> =>
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("child stdin EPIPE after kill")), 60);
      });

    const h = harness({
      llm: new ScriptLlm([{ kind: "done", message: toolCallMessage(["c1"]) }]),
      registry,
      bindings: { signal: controller.signal },
    });
    setTimeout(() => controller.abort(new Error("stop")), 10);

    expect(await h.run("hi")).toBe("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 140));

    const rows = h.session.events().filter((e) => e.type === "tool_result");
    // Still exactly the one honest cancelled row: the late failure neither adds a
    // row nor rewrites the one already written.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.error).toBe(CANCELLED_EXECUTION_UNCERTAIN);
    // And the turn terminated normally — a tool that blows up after the fact
    // cannot turn a cancelled turn into an error turn.
    const ends = h.session.events().filter((e) => e.type === "turn_end");
    expect(ends.at(-1)?.outcome).toBe("cancelled");
  });
});
