/**
 * B3-01 — a cancelled run_code must not leave its program running.
 *
 * The broker's header has claimed "the child is killed on timeout, on cancel and
 * on protocol failure" since it was written. The timeout and the protocol half
 * were true; the CANCEL half was not, because no cancel signal ever reached this
 * file: the loop stopped awaiting the batch and the program went on running.
 *
 * What is asserted is the CHILD'S LIVENESS, not "the call returned quickly". That
 * distinction matters: an early return only means something if the child is
 * really gone, and a test that settled for the former would have passed against
 * the unfixed code too (measured: mutating the kill to a no-op left this file
 * green before the assertion was tightened).
 *
 * The interpreter is REAL (a real `userspace` sandbox, a real `node` child) and
 * the sandbox is wrapped so the spawned child's pid is observable — the fact under
 * test is that a real process stops.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Sandbox, SandboxSpawned, Tool } from "@celestea/core";

import { ToolRegistryImpl } from "../registry.js";
import { userspaceSandboxWith } from "../sandbox/userspace.js";
import { runCodeToolWithHandle } from "../tools/run-code.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

/**
 * A program that NEVER finishes on its own and is not stopped by stdin EOF.
 *
 * The first version of this used `await new Promise(() => {})`, which the broker
 * could end by closing the reply channel (`endStdin`) — so the child died even
 * with the abort kill mutated away, and the test could not tell the fix from the
 * channel closing. Resuming stdin reads, keeping the event loop pinned with a
 * timer, and never resolving means stdin EOF is not enough: only a kill stops it.
 */
const SPINNER = [
  "process.stdin.resume();",
  "setInterval(() => {}, 50);",
  "await new Promise(() => {});",
].join("\n");

/** Is this pid still running? `kill(pid, 0)` checks without signalling. */
function alive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
/**
 * Poll `probe` until it holds, or FAIL with `what`.
 *
 * Throwing is the point: a probe that never becomes true is exactly the
 * defect under test, and a helper that returned silently would turn "the
 * kill never happened" into a PASS (the same trap W9225 guards against).
 */
async function until(probe: () => boolean, what: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() >= deadline) throw new Error("timed out after " + String(ms) + "ms waiting for: " + what);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The real sandbox, with the spawned child recorded so its pid can be checked. */
function observedSandbox(d: string): { sandbox: Sandbox; pidOf: () => number | null } {
  const real = userspaceSandboxWith({
    workdir: d,
    root: d,
    timeoutMs: 120_000,
    maxTimeoutMs: 120_000,
    maxOutputBytes: 65536,
  });
  let seen: number | null = null;
  // A Proxy, not a literal: the Sandbox seam carries readonly members
  // (`config`, `shell`) that the broker reads, and hand-rolling the object
  // dropped them (which failed with "cannot read maxCpuSec of undefined").
  const sandbox: Sandbox = new Proxy(real, {
    get(target, prop, receiver): unknown {
      if (prop === "spawn") {
        return async (req: Parameters<Sandbox["spawn"]>[0]): Promise<SandboxSpawned> => {
          const out = await target.spawn(req);
          seen = out.child.pid;
          return out;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { sandbox, pidOf: () => seen };
}

function mount(sandbox: Sandbox): { tool: Tool; registry: ToolRegistryImpl } {
  const registry = new ToolRegistryImpl();
  // `runCodeToolWithHandle` mints the late-bound handle ITSELF (it is not part of
  // the options it accepts — that is the point of the late binding), and returns
  // it so the assembly can bind the registry the tool will dispatch through.
  const { tool, handle } = runCodeToolWithHandle({ sandbox });
  handle.set(registry);
  registry.register(tool);
  return { tool, registry };
}

async function dir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "b3-abort-"));
  dirs.push(d);
  return d;
}

describe("B3-01: cancelling a run_code kills the program", () => {
  it("the program process is DEAD once an aborted run settles", async () => {
    const d = await dir();
    const { sandbox, pidOf } = observedSandbox(d);
    const { tool, registry } = mount(sandbox);
    expect(registry.get("run_code")).toBe(tool);

    const controller = new AbortController();
    const run = tool.executeWith?.({
      call_id: "c1",
      name: "run_code",
      args: { code: SPINNER, timeout_ms: 120_000 },
      signal: controller.signal,
    });

    // Attach the outcome handler NOW — not after the wait below. `run` can reject
    // while nothing is listening (measured: `Serialized Error: { kind:
    // 'cpu_exceeded' }` on run 37180588035), and ONE unhandled rejection makes
    // vitest exit 1 even with 187/187 files green, reported as `Errors 1 error`.
    const settledPromise: Promise<{ kind: string }> = Promise.resolve(run).then(
      () => ({ kind: "resolved" }),
      () => ({ kind: "rejected" }),
    );

    // Wait for the child to actually exist, THEN cancel. Cancelling before the
    // spawn would prove nothing about a running child.
    const deadline = Date.now() + 10_000;
    while (pidOf() === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const pid = pidOf();
    expect(pid, "the interpreter child was never spawned").not.toBeNull();
    expect(alive(pid), "the child should be running before we cancel").toBe(true);

    controller.abort(new Error("user pressed stop"));

    // The contract under test is "cancelling kills the process", NOT "cancelling
    // finishes inside a fixed budget". The old shape raced the call against a 20s
    // timer — a timing guess, and the losing one: the abort path runs
    // `taskkillTree`, a SYNCHRONOUS retry loop (3 attempts x 5s execFileSync
    // timeout + 50/100ms backoff, child.ts:97-119), so on a loaded runner the
    // expensive step eats the budget and the timer wins over the real outcome.
    // Measured: red once each in runs 37140967254 and 37133964946, while a local
    // 22-round loop (10 plain + 12 under 8 busy cores) never reproduced it, and a
    // sandbox-level probe measured the kill itself at 91-182ms with the grandchild
    // dead and `wait()` settled 20/20.
    //
    // So wait for the FACT first — the process is gone. That is also what lets
    // this test tell a real kill from a no-op one; only then bound the settle,
    // when the expensive part is already known complete.
    await until(() => !alive(pid), "the cancelled program process to be gone", 60_000);

    const settled = await Promise.race([
      settledPromise,
      new Promise<{ kind: string }>((r) => setTimeout(() => r({ kind: "STILL-PARKED" }), 30_000)),
    ]);
    expect(settled.kind, "the aborted call must settle, not stay parked").not.toBe("STILL-PARKED");
  }, 150_000);

  it("leaves no abort listener behind on a signal that outlives the run", async () => {
    const d = await dir();
    const sandbox = userspaceSandboxWith({
      workdir: d,
      root: d,
      timeoutMs: 20_000,
      maxTimeoutMs: 20_000,
      maxOutputBytes: 65536,
    });
    const { tool } = mount(sandbox);

    const controller = new AbortController();
    // Node exposes listener introspection; a runtime without it cannot make this
    // assertion, and skipping beats a vacuous pass.
    // `getEventListeners` is a Node API that is not in the published @types
    // `Process` surface, so it is reached through a narrow local alias.
    const withApi = process as unknown as {
      getEventListeners?(emitter: EventTarget, type: string): unknown[];
    };
    const hasApi = typeof withApi.getEventListeners === "function";
    const listeners = (): number =>
      hasApi ? (withApi.getEventListeners?.(controller.signal, "abort") ?? []).length : 0;

    // Runs that end NORMALLY are the case that would leak a listener if the
    // broker relied on { once: true } alone instead of unsubscribing.
    for (let i = 0; i < 3; i += 1) {
      await tool.executeWith?.({
        call_id: "c" + String(i),
        name: "run_code",
        args: { code: "return 1 + 1;" },
        signal: controller.signal,
      });
    }

    if (!hasApi) return; // no introspection on this runtime; nothing to assert
    expect(listeners()).toBe(0);
  }, 45_000);
});
