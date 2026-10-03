/**
 * B5-04 · a CPU cap the host cannot enforce must not read as if it did.
 *
 * The baseline's `run_shell` description promised `cpu_sec` sets `RLIMIT_CPU`
 * unconditionally, and reported `sandbox.cpu_sec` as if the cap were in force.
 * On a host with no rlimit mechanism (Windows: neither prlimit nor a shell with
 * usable ulimit) the value was carried through and nothing enforced it — measured
 * on this machine: a busy loop with `cpu_sec: 1` ran until the 6s WALL clock
 * fired, and the result still said `cpu_sec: 1`.
 *
 * `sandbox.promise_gaps` already carried the truth (`["no_os_isolation",
 * "rlimits"]`) and DID reach the model inside `sandbox` — that part of the
 * baseline was honest. What was missing is the SENTENCE, because a model reads
 * the scalar `cpu_sec` far more readily than a gaps array. So the fix is
 * capability-driven wording plus an explicit `cpu_cap_enforced: false`.
 *
 * Pinned here:
 *   1. a requested cap on a host WITHOUT rlimits says so (`cpu_cap_enforced: false`);
 *   2. a requested cap on a host WITH rlimits does not cry wolf;
 *   3. a call that never mentioned `cpu_sec` is not nagged;
 *   4. `cpu_cap_enforced` is NEVER confused with `cpu_exceeded` — the first means
 *      "the cap did not exist", the second "the cap fired";
 *   5. the spec text no longer promises an unconditional RLIMIT_CPU.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runShellSpec, runShellTool, cpuCapUnenforceable } from "./run-shell.js";
import { UserspaceSandbox } from "../sandbox/userspace.js";
import { sandboxConfigFromEnv } from "../sandbox/config.js";
import { ProcessRegistry } from "../process/registry.js";
import type { HostProbe } from "../sandbox/probe.js";

/** A userspace sandbox over a given host probe (so the rlimit branch is chosen). */
function sandboxWith(probe: Partial<HostProbe>): UserspaceSandbox {
  const root = mkdtempSync(join(tmpdir(), "b5-04-"));
  const ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  const config = sandboxConfigFromEnv({ CELESTEA_RUN_SHELL_WORKDIR: ws, CELESTEA_RUN_SHELL_ROOT: ws });
  const base = {
    prlimitPath: null as string | null,
    shellUlimitWorks: false,
    bwrapPath: null as string | null,
    bwrapUsable: false,
    uidThreads: null as number | null,
  };
  return new UserspaceSandbox(config, { env: {}, probe: { ...base, ...probe } as HostProbe });
}

const call = (sb: UserspaceSandbox, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
  runShellTool({ sandbox: sb, processes: new ProcessRegistry() }).execute(args) as Promise<Record<string, unknown>>;

/**
 * The enforcement report a sandbox publishes, read through the provider's own
 * `describe()`. This is the DECISION the tool result is derived from, so
 * asserting here is what makes "never cry wolf" observable on a host that
 * cannot spawn the POSIX shell (where the tool call itself may never return).
 */
function describe_(sb: UserspaceSandbox): { promise_gaps: readonly string[] } {
  const any_ = sb as unknown as { describe?: (o?: unknown) => { promise_gaps?: readonly string[] } };
  expect(typeof any_.describe, "the provider must publish a describe()").toBe("function");
  const d = any_.describe!() as { promise_gaps?: readonly string[] };
  return { promise_gaps: d.promise_gaps ?? [] };
}

// The REAL predicate, imported from the module under test (not a copy): a
// re-implementation in the test would keep passing when the shipped call breaks.
const wouldWarn = cpuCapUnenforceable;

describe("B5-04 · the tool says whether a CPU cap can be enforced", () => {
  it("a host WITHOUT rlimit mechanism reports cpu_cap_enforced:false when a cap was asked for", async () => {
    const out = await call(sandboxWith({}), { command: "echo ok", cpu_sec: 3 });
    expect(out["cpu_cap_enforced"]).toBe(false);
    expect(String(out["message"])).toContain("NOT enforced");
    expect(String(out["message"])).toContain("wall clock remains the only bound");
    // Never a cpu_exceeded claim: nothing was exceeded.
    expect(out["cpu_exceeded"]).toBeUndefined();
  });

  it("the warn predicate is FALSE on a host that HAS rlimits (kills an 'always warn' mutant)", () => {
    // Direct, spawn-free, and therefore observable on EVERY host — the live
    // case below can be a no-op where /bin/sh does not exist.
    expect(wouldWarn(3, ["no_os_isolation"]), "rlimits present => no warning").toBe(false);
    expect(wouldWarn(3, []), "no gaps at all => no warning").toBe(false);
    expect(wouldWarn(undefined, ["rlimits"]), "no cpu_sec asked => no warning").toBe(false);
    expect(wouldWarn(3, ["rlimits"]), "the only combination that warns").toBe(true);
  });

  it("a host WITH rlimits does not cry wolf", async () => {
    // The discriminator: the sandbox's OWN enforcement report must not name the
    // rlimits gap. Asserting it on the enforcement REPORT (not on a tool result
    // that may never be produced on a host which cannot spawn /bin/sh) is what
    // makes this case kill a "always warn" mutant — on a host that CAN run the
    // command the tool result is checked too, so both surfaces are covered.
    const sb = sandboxWith({ shellUlimitWorks: true });
    const report = describe_(sb);
    expect(report.promise_gaps, "an rlimit-capable host must not report the rlimits gap").not.toContain("rlimits");
    try {
      const out = await call(sb, { command: "echo ok", cpu_sec: 3 });
      expect(out["cpu_cap_enforced"], "never claim the cap is unenforced here").toBeUndefined();
      expect(out["cpu_exceeded"]).toBeUndefined();
    } catch {
      /* the host cannot spawn the POSIX shell; the report assertion above is the load-bearing one */
    }
  });

  it("a call that never asked for cpu_sec is not nagged", async () => {
    const out = await call(sandboxWith({}), { command: "echo ok" });
    expect(out["cpu_cap_enforced"]).toBeUndefined();
    expect(out["message"]).toBeUndefined();
  });

  it("the gaps that carry the truth still reach the model inside sandbox", async () => {
    const out = await call(sandboxWith({}), { command: "echo ok", cpu_sec: 3 });
    const sandbox = out["sandbox"] as { promise_gaps?: readonly string[]; cpu_sec?: number };
    expect(sandbox.promise_gaps).toContain("rlimits");
    expect(sandbox.cpu_sec).toBe(3);
  });

  it("the spec text no longer promises an unconditional RLIMIT_CPU", () => {
    const spec = runShellSpec();
    // `parameters.properties` is `unknown` in the ToolSpec contract, so the
    // narrow is explicit here rather than an `as` that could lie.
    const properties = spec.parameters.properties as Record<string, { description?: unknown }>;
    const text = typeof properties["cpu_sec"]?.description === "string" ? properties["cpu_sec"].description : "";
    // The honest qualifier must be present ...
    expect(text).toContain("only when the host actually has a rlimit mechanism");
    expect(text).toContain("promise_gaps");
    // ... and the tool-level description must not still claim it flatly.
    expect(spec.description).toContain("promise_gaps");
  });
});
