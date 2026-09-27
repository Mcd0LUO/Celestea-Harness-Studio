/**
 * W9223 — two tools-layer P1 fixes, each pinned on the surface that was broken.
 *
 * B1 (W9205): `sessionSandboxConfig` dropped the `platform` passthrough, so the
 * win32 branch of `windowsUtf8Env` could only be reached through
 * `sandboxConfigFromEnv` / `buildSandboxConfig` — never through the function
 * production actually calls to build a session's sandbox.
 *
 * D7 (W9205): `run_shell` marked ANY SIGKILL as `cpu_exceeded` as long as the
 * provider reported a `cpu_sec`. The wall clock throws `code=timeout` before
 * reaching that line, so the deaths that DID reach it (OOM killer, external
 * `kill -9`, bwrap `--die-with-parent`) were exactly the ones the CPU limit did
 * not cause. `cpu_sec` is always derived for a foreground call, so the guard
 * was true on essentially every run.
 */
import { tmpdir } from "node:os";

import type { Sandbox, SandboxMeta, SandboxRunResult } from "@celestea/core";
import { describe, expect, it } from "vitest";

// The public entry only: .dependency-cruiser.cjs `entry-only-tools` forbids a
// test reaching into a package's internals (ARCHITECTURE.md §2).
import { buildSandboxConfig, ProcessRegistry, runShellTool, sandboxConfigFromEnv, sessionSandboxConfig } from "@celestea/tools";

const WORKDIR = tmpdir();

/** The exact env a Python child needs, as `windowsUtf8Env` spells it. */
const PYTHON_UTF8 = ["PYTHONUTF8", "1"] as const;

describe("W9223 B1 — sessionSandboxConfig forwards the platform seam", () => {
  it("pins the win32 child env from a session scope (the production path)", () => {
    // Before the fix there was NO argument that could move this: the win32 branch
    // was unreachable on the session path, so the W885 seam stopped at the
    // process boundary. Both exits of the function are asserted, because the bug
    // was a dropped field on a shared construction.
    const scoped = sessionSandboxConfig({ workspace: WORKDIR }, {}, "win32");
    expect(scoped.extraEnv).toEqual([[...PYTHON_UTF8]]);
    const envPosture = sessionSandboxConfig(null, {}, "win32");
    expect(envPosture.extraEnv).toEqual([[...PYTHON_UTF8]]);
  });

  it("keeps POSIX byte-for-byte empty through the session path", () => {
    expect(sessionSandboxConfig({ workspace: WORKDIR }, {}, "linux").extraEnv).toEqual([]);
    expect(sessionSandboxConfig(null, {}, "darwin").extraEnv).toEqual([]);
  });

  it("defaults to the HOST platform, so production is unchanged", () => {
    // The new parameter may only ever be moved by a caller that passes one; with
    // no argument the answer is the host's, exactly as before the fix.
    const host = sessionSandboxConfig({ workspace: WORKDIR }, {});
    const expected = process.platform === "win32" ? [[...PYTHON_UTF8]] : [];
    expect(host.extraEnv).toEqual(expected);
    expect(host.extraEnv).toEqual(buildSandboxConfig({ workdir: WORKDIR, root: WORKDIR }).extraEnv);
    expect(host.extraEnv).toEqual(sandboxConfigFromEnv({}, { workdir: WORKDIR, root: WORKDIR }).extraEnv);
  });
});

/** A sandbox whose single `run` answers a scripted terminal state. */
function stubSandbox(overrides: Partial<SandboxRunResult>): Sandbox {
  const meta: SandboxMeta = {
    provider: "raw",
    net_isolated: false,
    tmp_private: false,
    seccomp: false,
    enforcement: "partial",
    promise_gaps: ["no_os_isolation"],
    cpu_sec: 20,
  };
  const base: SandboxRunResult = {
    stdout: "",
    stderr: "",
    exit_code: 0,
    signal: null,
    stdout_truncated: false,
    stderr_truncated: false,
    sandbox: meta,
  };
  return {
    config: buildSandboxConfig({ workdir: WORKDIR, root: WORKDIR }),
    run: async () => ({ ...base, ...overrides }),
    spawn: async () => {
      throw new Error("W9223: no spawn in this test");
    },
  };
}

/** Run one command through the real tool against the stub. */
async function runWith(sandbox: Sandbox): Promise<Record<string, unknown>> {
  const tool = runShellTool({ sandbox, processes: new ProcessRegistry() });
  return (await tool.execute({ command: "x" })) as Record<string, unknown>;
}

describe("W9223 D7 — run_shell only calls SIGXCPU a CPU kill", () => {
  it("does NOT mark an unattributed SIGKILL as cpu_exceeded (the reported defect)", async () => {
    // The provider reports a CPU cap AND the child died on SIGKILL. Before the
    // fix this was reported as "CPU time limit 3s exceeded", which is a wrong
    // cause: RLIMIT_CPU sends SIGXCPU first, so a bare SIGKILL came from
    // somewhere else (OOM killer / external kill -9 / --die-with-parent).
    const out = await runWith(
      stubSandbox({
        exit_code: null,
        signal: "SIGKILL",
        sandbox: { provider: "raw", net_isolated: false, tmp_private: false, seccomp: false, enforcement: "partial", promise_gaps: ["no_os_isolation"], cpu_sec: 3 },
      }),
    );
    expect(out["signal"]).toBe("SIGKILL");
    expect(out["cpu_exceeded"]).toBeUndefined();
    expect(out["message"]).toBeUndefined();
  });

  it("still marks SIGXCPU, and still names the effective limit", async () => {
    // The control: the signal RLIMIT_CPU actually sends must keep its marker, or
    // the fix would have traded a false positive for a false negative.
    const out = await runWith(
      stubSandbox({
        exit_code: null,
        signal: "SIGXCPU",
        sandbox: { provider: "raw", net_isolated: false, tmp_private: false, seccomp: false, enforcement: "partial", promise_gaps: ["no_os_isolation"], cpu_sec: 3 },
      }),
    );
    expect(out["signal"]).toBe("SIGXCPU");
    expect(out["cpu_exceeded"]).toBe(true);
    expect(String(out["message"])).toContain("CPU time limit 3s exceeded");
  });

  it("leaves a normal exit unmarked", async () => {
    const out = await runWith(stubSandbox({ exit_code: 0, signal: null }));
    expect(out["cpu_exceeded"]).toBeUndefined();
    expect(out["signal"]).toBeUndefined();
  });
});
