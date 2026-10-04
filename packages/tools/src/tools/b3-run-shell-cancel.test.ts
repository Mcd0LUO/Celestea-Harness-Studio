/**
 * B3-01 — a cancelled FOREGROUND run_shell must not leave its process running.
 *
 * The seam change (`SandboxRunRequest.signal`) is only worth something if a real
 * process really stops, so this runs a REAL command in the REAL userspace sandbox.
 * The command is chosen to be unkillable by anything except a signal: it pins a
 * timer, resumes stdin, and never returns on its own — so a passing test can only
 * mean the abort reached the process group.
 *
 * Two guards around the obvious mistake:
 *   * a BACKGROUND child must still OUTLIVE the cancelled turn (that is what
 *     `background: true` means), and
 *   * the turn's signal must not accumulate listeners across many runs.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Sandbox } from "@celestea/core";

import { ProcessRegistry } from "../process/registry.js";
import { userspaceSandboxWith } from "../sandbox/userspace.js";
import { runShellTool } from "./run-shell.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "b3-runshell-"));
  dirs.push(d);
  return d;
}

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

/** Wait for `file` to appear and hold a pid, or give up and return null. */
async function pidIn(file: string, ms: number): Promise<number | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const text = readFileSync(file, "utf8").trim();
      if (/^\d+$/u.test(text)) return Number(text);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

/**
 * A command that publishes its own pid to `pidFile` and then never returns.
 * `process.stdin.resume()` is load-bearing: it stops EOF on the shell's stdin
 * from ending the process, so "the pipe closed" cannot be mistaken for a kill.
 */
function foreverCommand(pidFile: string): string {
  // The pid path is passed as ARGV (process.argv[1]), not interpolated into the
  // script: the sandbox quotes the whole command line, and a path embedded in
  // the JS would be mangled by the shell's own quoting. Verified against the
  // real sandbox before this shape was adopted.
  const script =
    "const fs=require('fs');process.stdin.resume();" +
    "fs.writeFileSync(process.argv[1],String(process.pid));" +
    "setInterval(()=>{},50);";
  return "node -e " + JSON.stringify(script) + " " + JSON.stringify(pidFile);
}

function realSandbox(d: string): Sandbox {
  return userspaceSandboxWith({
    workdir: d,
    root: d,
    timeoutMs: 120_000,
    maxTimeoutMs: 120_000,
    maxOutputBytes: 65536,
  });
}

function killNow(pid: number | null): void {
  if (pid === null) return;
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 15_000 });
  } catch {
    /* POSIX: the sandbox reaps the group when it goes away */
  }
}

describe("B3-01: cancelling a foreground run_shell kills the process", () => {
  it("the command is DEAD once the cancelled tool settles", async () => {
    const d = dir();
    const pidFile = join(d, "pid.txt");
    const tool = runShellTool({ sandbox: realSandbox(d), processes: new ProcessRegistry() });
    const controller = new AbortController();

    const run = tool.executeWith?.({
      call_id: "c1",
      name: "run_shell",
      args: { command: foreverCommand(pidFile), timeout_ms: 120_000 },
      signal: controller.signal,
    });
    // The call is not awaited: it is parked on the command, which is the point.

    // Attach the outcome handler NOW — not after the wait below. `run` can reject
    // while nothing is listening (measured: `Serialized Error: { kind:
    // 'cpu_exceeded' }` on run 37180588035), and ONE unhandled rejection makes
    // vitest exit 1 even with 187/187 files green, reported as `Errors 1 error`.
    const settledPromise: Promise<{ kind: string }> = Promise.resolve(run).then(
      () => ({ kind: "resolved" }),
      () => ({ kind: "rejected" }),
    );

    const pid = await pidIn(pidFile, 25_000);
    expect(pid, "the command never published its pid").not.toBeNull();
    expect(alive(pid), "the command should be running before we cancel").toBe(true);

    controller.abort(new Error("user pressed stop"));

    // Wait for the FACT first: the process is gone. The abort path's expensive
    // step is `taskkillTree` — a retry loop that used to be SYNCHRONOUS
    // (`execFileSync` + `sleepSync`, child.ts:97-119) and is async since W9321 —
    // so racing a fixed timer against the whole settle is a timing guess a loaded
    // runner loses (run 37133964946 measured red on ubuntu / node 26).
    await until(() => !alive(pid), "the cancelled command process to be gone", 60_000);

    // Only now bound the settle: the expensive part is known complete.
    const settled = await Promise.race([
      settledPromise,
      new Promise<{ kind: string }>((r) => setTimeout(() => r({ kind: "STILL-PARKED" }), 30_000)),
    ]);
    // Without the abort kill the call stays parked until the 120s wall clock.
    expect(settled.kind, "the aborted call must settle, not stay parked").not.toBe("STILL-PARKED");
  }, 150_000);

  it("a BACKGROUND child deliberately OUTLIVES the cancelled turn", async () => {
    const d = dir();
    const pidFile = join(d, "bg-pid.txt");
    const processes = new ProcessRegistry();
    const tool = runShellTool({ sandbox: realSandbox(d), processes });

    const handle = (await tool.executeWith?.({
      call_id: "c1",
      name: "run_shell",
      args: { command: foreverCommand(pidFile), background: true },
      signal: new AbortController().signal,
    }))?.value as { handle?: string; pid?: number } | undefined;

    const pid = handle?.pid ?? (await pidIn(pidFile, 25_000));
    expect(pid).not.toBeNull();

    // Cancelling the turn must NOT reach a background child: it is registered so
    // a LATER turn can poll/kill it. This guards against "fixing" the foreground
    // case by wiring the signal into the spawn path too.
    // (The signal above is a throwaway already-unaborted controller; the point
    // asserted is the LIFETIME, i.e. that nothing killed it when the turn ended.)
    // 要证的是「取消 turn 没有杀掉后台子进程」，即「什么都没发生」，没有可轮询的条件
    // （轮询只能证明「某一刻还活着」，证不了「在这段窗口里一直活着」）。
    // W9225：故此处必须**有界地等一段真实时间**，不是赌时长。
    await new Promise((r) => setTimeout(r, 500));
    expect(alive(pid), "a background child must survive the turn that started it").toBe(true);

    killNow(pid);
    processes.dispose();
  }, 60_000);

  it("leaves no abort listener behind on a signal that outlives the run", async () => {
    const d = dir();
    const tool = runShellTool({ sandbox: realSandbox(d), processes: new ProcessRegistry() });
    const controller = new AbortController();
    // getEventListeners is a Node API absent from the published @types Process.
    const withApi = process as unknown as {
      getEventListeners?(emitter: EventTarget, type: string): unknown[];
    };

    for (let i = 0; i < 3; i += 1) {
      await tool.executeWith?.({
        call_id: "c" + String(i),
        name: "run_shell",
        args: { command: "node -e " + JSON.stringify("console.log(1);") },
        signal: controller.signal,
      });
    }

    if (typeof withApi.getEventListeners !== "function") return;
    expect(withApi.getEventListeners(controller.signal, "abort") ?? []).toHaveLength(0);
  }, 60_000);
});
