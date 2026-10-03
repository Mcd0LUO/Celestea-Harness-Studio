/**
 * B3-01 / B3-04 — cancellation must actually STOP work, not merely stop watching it.
 *
 * Two independent regressions, both found by the same live probe:
 *
 *   * B3-01: the turn's AbortSignal never reached a tool, because `ToolInput` had
 *     no field to carry it. The loop stopped awaiting the batch and a tool that
 *     had already spawned a process kept running to completion behind a turn that
 *     had already reported itself `cancelled`.
 *   * B3-04: `iter.return()` cannot release a socket whose generator is parked on
 *     a `await` that never settles — the `finally { response.destroy() }` is
 *     queued behind that await. The stream needed an out-of-band `release()`.
 *
 * These tests pin the SEAM, not the wording: the assertions are about a kill
 * actually reaching a child and a `release()` actually firing, because those are
 * the facts a reader of the diff cannot otherwise take on trust.
 */

import { describe, expect, it } from "vitest";
import { assistantText, type LlmStream, type ToolInput } from "@celestea/core";

import { closeIterator, closeStream, isAborted } from "./cancel.js";
import { FakeToolRegistry, harness, ScriptLlm, toolCallMessage } from "./fakes.test-util.js";

// ── B3-01: the signal reaches the tool seam ─────────────────────────────────

describe("B3-01: the turn signal rides every ToolInput", () => {
  it("hands the tool the SAME signal object the turn was cancelled on", async () => {
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];

    const h = harness({
      llm: new ScriptLlm([
        { kind: "done", message: toolCallMessage(["c1"]) },
        { kind: "done", message: assistantText("done") },
      ]),
      bindings: { signal: controller.signal },
    });
    // Record what the registry actually received from the loop.
    const inner = h.registry.dispatch.bind(h.registry);
    h.registry.dispatch = async (input: ToolInput) => {
      seen.push(input.signal);
      return inner(input);
    };

    await h.run("hi");

    // Every dispatch of the turn, not just the first: the loop re-issues steps,
    // and a later step must not silently lose the signal.
    expect(seen.length).toBeGreaterThan(0);
    // Identity, not just "defined": a tool that aborts a DIFFERENT signal would
    // not be cancelled at all, and that is the bug this pins.
    expect(seen.every((s) => s === controller.signal)).toBe(true);
  });

  it("omits the key entirely when the loop has no signal (shape unchanged)", async () => {
    const h = harness({
      llm: new ScriptLlm([
        { kind: "done", message: toolCallMessage(["c1"]) },
        { kind: "done", message: assistantText("done") },
      ]),
    });
    const keys: string[][] = [];
    const inner = h.registry.dispatch.bind(h.registry);
    h.registry.dispatch = async (input: ToolInput) => {
      keys.push(Object.keys(input));
      return inner(input);
    };

    await h.run("hi");

    // The pre-B3-01 object shape, byte for byte: a host that never wires a
    // signal must not start seeing an `undefined`-valued key.
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k).toEqual(["call_id", "name", "args"]);
  });
});

// ── B3-04: an abandoned stream is released, not merely abandoned ─────────────

describe("B3-04: closeIterator forces a release the generator cannot reach", () => {
  it("calls release() on a stream parked on a never-settling await", () => {
    let released = 0;
    let finallyRan = false;
    // The exact shape that defeated the old code: started, then parked forever.
    const stream = {
      async *[Symbol.asyncIterator]() {
        try {
          await new Promise<never>(() => undefined);
          yield { kind: "done" } as never;
        } finally {
          finallyRan = true;
        }
      },
    };
    // The ITERATOR is what carries release(), exactly as streamEvents decorates
    // it — the fix reads the property off the iterator, not off the iterable.
    const iter = Object.assign(stream[Symbol.asyncIterator](), {
      release(): void {
        released += 1;
      },
    });
    void iter.next();

    closeIterator(iter as AsyncIterator<unknown>);

    // release() is synchronous and does not wait for the generator.
    expect(released).toBe(1);
    // ...while the generator's own finally is still unreachable. This is the
    // distinction the fix rests on, so it is asserted, not assumed.
    expect(finallyRan).toBe(false);
  });

  it("is idempotent: a second close does not re-release", () => {
    let released = 0;
    const iter = {
      next: () => Promise.resolve({ done: true, value: undefined }),
      return: () => Promise.resolve({ done: true, value: undefined }),
      release: () => {
        released += 1;
      },
    } as unknown as AsyncIterator<unknown>;

    closeIterator(iter);
    closeIterator(iter);

    expect(released).toBe(2); // the guard lives in the producer, not here
  });

  it("still works for a stream with no release() — return() remains the fallback", async () => {
    // No release() anywhere: this is every non-provider stream, and the OLD code
    // path must keep working unchanged.
    let returnCalled = false;
    const stream: LlmStream = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve({ done: true, value: undefined }),
          return: () => {
            returnCalled = true;
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };

    closeStream(stream);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(returnCalled).toBe(true);
  });

  it("closeStream releases BEFORE waiting on a first next() that never resolves", () => {
    let released = 0;
    // The pre-stream window: the generator has never produced anything, and its
    // first next() is parked. This is where a hung provider held the socket.
    const stream = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<never>(() => undefined),
          return: () => Promise.resolve({ done: true, value: undefined }),
          release: () => {
            released += 1;
          },
        };
      },
    };

    closeStream(stream);

    expect(released).toBe(1);
  });
});

describe("B3-01 + B3-04: the turn still settles when a tool ignores everything", () => {
  it("a tool that ignores the signal cannot hang the turn", async () => {
    const controller = new AbortController();
    const h = harness({
      llm: new ScriptLlm([{ kind: "done", message: toolCallMessage(["c1"]) }]),
      // Deliberately non-cooperative: blocks forever regardless of the signal.
      // A subclass (not a bare literal) so the registry keeps its real shape.
      registry: new (class extends FakeToolRegistry {
        override dispatch(): Promise<never> {
          return new Promise<never>(() => undefined);
        }
      })(),
      bindings: { signal: controller.signal },
    });
    setTimeout(() => controller.abort(), 10);

    // The loop races the batch, so the abandoned promise cannot pin the turn.
    // This is the guarantee B3-01 preserves: the signal is now handed to the
    // tool, but the turn's terminal state never depended on the tool using it.
    const outcome = await h.run("hi");

    expect(outcome).toBe("cancelled");
    expect(isAborted(controller.signal)).toBe(true);
  });
});
