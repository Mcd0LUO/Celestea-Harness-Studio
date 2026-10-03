/**
 * B4-05 P2 -- the completion sink is GONE; poll is the only way to learn an exit.
 *
 * The defect: setCompletionSink was a host extension point with ZERO
 * production callers, so a run_shell(background: true) process that ended on
 * its own told nobody. The header comment described a mailbox push that no
 * host implemented -- code and documentation quietly disagreed, and that
 * disagreement is what made this a finding.
 *
 * The fix was to DELETE the API rather than wire it: no host here owns a
 * session mailbox, and leaving an unwired hook only re-documented the gap.
 *
 * ## What this file is FOR now
 *
 * A deletion leaves no trace, and a deleted API creeps back the moment someone
 * needs a notification. So the durable contract is pinned instead: the registry
 * notifies NOBODY on a natural exit, and the tombstone + poll is the one way
 * the fact is available. If a future change re-adds a push, THIS is where it
 * has to show up and be a deliberate decision.
 */

import { describe, expect, it, vi } from "vitest";
import type { SandboxChild, SandboxExit } from "@celestea/core";
import { ProcessRegistry } from "./registry.js";

/** A child whose exit the test drives by hand (no real process, no timing). */
function fakeChild(): { child: SandboxChild; exit: (e: SandboxExit) => void } {
  let resolveWait: ((e: SandboxExit) => void) | null = null;
  const wait = new Promise<SandboxExit>((resolve) => {
    resolveWait = resolve;
  });
  return {
    child: {
      pid: 4242,
      stdin: null,
      stdout: null,
      stderr: null,
      wait: () => wait,
      terminate: vi.fn(),
      kill: vi.fn(),
    } as unknown as SandboxChild,
    exit: (e: SandboxExit) => resolveWait?.(e),
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("B4-05 P2 · a natural exit notifies nobody; poll is the durable read", () => {
  it("the completion-sink API is GONE from the registry surface", () => {
    const reg = new ProcessRegistry();
    // The deletion itself, asserted. A re-added sink is not a mistake -- but it
    // must be a deliberate act that shows up here, not a quiet addition.
    const surface = reg as unknown as Record<string, unknown>;
    expect(surface["setCompletionSink"]).toBeUndefined();
    expect(surface["completionSinkWired"]).toBeUndefined();
  });

  it("a natural exit is recorded and readable ONLY by polling", async () => {
    const reg = new ProcessRegistry();
    const { child, exit } = fakeChild();
    reg.insert(child, /* notify */ true);

    expect(() => exit({ code: 0, signal: null })).not.toThrow();
    await tick();

    // The tombstone survives the exit, which is exactly why poll still answers.
    const polled = reg.poll("proc-0");
    expect(polled["ok"]).toBe(true);
    expect(polled["running"]).toBe(false);
    expect(polled["exit_code"]).toBe(0);
  });

  it("a kill is still silent and still lands in the tombstone", async () => {
    const reg = new ProcessRegistry();
    const { child, exit } = fakeChild();
    reg.insert(child, /* notify */ true);

    await reg.kill("proc-0");
    exit({ code: null, signal: "SIGKILL" });
    await tick();

    // kill already answered the caller; the tombstone is the durable record.
    const polled = reg.poll("proc-0");
    expect(polled["ok"]).toBe(true);
    expect(polled["running"]).toBe(false);
  });

  it("an unknown handle is still refused (removing the sink loosened nothing)", () => {
    const reg = new ProcessRegistry();
    const polled = reg.poll("proc-nope");
    expect(polled["ok"]).toBe(false);
    expect(String(polled["error"])).toContain("unknown handle");
  });
});