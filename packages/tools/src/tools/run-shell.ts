/**
 * `run_shell` — **orchestration only** (`crates/tools/src/builtin.rs`).
 *
 * This tool never spawns anything itself: it validates arguments, delegates
 * execution to the injected `Sandbox` seam, and — for `background: true` —
 * hands the detached child to the session process registry so
 * `process_control` can drive it across turns. Consequences:
 * - swapping in the P2c OS-isolated sandbox changes no line here;
 * - a timeout/kill/workdir failure arrives as a structured `SandboxError`
 *   (`run_shell-sandbox: code=…`), never as prose;
 * - the effective isolation mode is reported back inside `sandbox`.
 */

import type { Sandbox, Tool, ToolExecOutcome, ToolInput, ToolSpec } from "@celestea/core";

import { boolArg, optionalIntArg, optionalStringArg, stringArg } from "../args.js";
import { descParam } from "../desc.js";
import type { ProcessRegistry } from "../process/registry.js";

export interface RunShellToolOptions {
  /** The execution boundary (userspace-lite in P2b, OS-isolated in P2c). */
  sandbox: Sandbox;
  /** Session-scoped registry that owns background children. */
  processes: ProcessRegistry;
}

export function runShellSpec(): ToolSpec {
  return {
    name: "run_shell",
    description:
      "Run a shell command inside the sandbox (v2 OS isolation when available: namespaces + read-only root + resource limits, else the v1 userspace path; fixed workdir, sanitized env, bounded timeout and output) and return stdout, stderr, exit code, and a `sandbox` object {provider: bwrap|raw|userspace, net_isolated, tmp_private, seccomp, enforcement, promise_gaps} reporting the effective isolation — READ promise_gaps before trusting any resource claim: a host with no rlimit mechanism lists the token rlimits there, and on such a host cpu_sec is NOT enforced (the result says so with cpu_cap_enforced:false) (W249: network isolated and /tmp a private tmpfs by default; CELESTEA_SANDBOX_NET=1 / CELESTEA_SANDBOX_SHARE_TMP=1 restore the shared host net/tmp; CELESTEA_SANDBOX_SECCOMP=1 enables the seccomp whitelist). With background:true the command is spawned detached (no call-level timeout; resource limits still apply) and returns {background, handle, pid} immediately — control it with the process_control tool (poll / stdin / kill); background processes live in the session process registry and survive across turns. Default timeout is 30s; raise it with timeout_ms up to the cap configured by CELESTEA_SHELL_MAX_TIMEOUT_MS (default 300000ms). The CPU limit (RLIMIT_CPU) FOLLOWS this call's wall clock unless cpu_sec is given: a foreground call gets its effective timeout rounded up plus 5s of grace, while background:true — which has no call-level wall clock — gets the cap itself (CELESTEA_SHELL_MAX_CPU_SEC, default 600). Optional cpu_sec overrides RLIMIT_CPU for THIS process; values above that cap are CLAMPED to it, and a CPU-cap kill is reported as cpu_exceeded.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to execute." },
        workdir: {
          type: "string",
          description:
            "Optional working directory. Must already exist inside the sandbox root; relative paths resolve against the sandbox workdir.",
        },
        timeout_ms: {
          type: "integer",
          minimum: 1,
          description:
            "Optional per-call timeout in milliseconds. Default 30000; can be raised up to the cap from CELESTEA_SHELL_MAX_TIMEOUT_MS (default 300000). When cpu_sec is not given this is also what the CPU limit follows. Ignored when background:true.",
        },
        cpu_sec: {
          type: "integer",
          minimum: 1,
          description:
            "Optional per-call CPU time limit in seconds for THIS process. It is applied as RLIMIT_CPU **only when the host actually has a rlimit mechanism** (Linux with prlimit, or a shell with usable ulimit builtins); on a host without one the value is still reported back as sandbox.cpu_sec but NOT enforced, and the result carries sandbox.promise_gaps including \"rlimits\" — so read that field rather than assuming the cap bit. Without cpu_sec the limit follows the call: a foreground call gets its effective timeout_ms rounded up plus 5s of grace, while background:true (no call-level wall clock) gets CELESTEA_SHELL_MAX_CPU_SEC (default 600). Values above that cap are clamped to it. When the cap really is in force and the kernel sends SIGXCPU, the result reports cpu_exceeded:true naming the limit.",
        },
        background: {
          type: "boolean",
          description:
            "Optional, default false. When true, spawn the command detached (no call-level timeout, so the CPU limit defaults to the CELESTEA_SHELL_MAX_CPU_SEC cap unless cpu_sec is given) and return {background:true, handle, pid} immediately; control the process with process_control (poll / stdin / kill). A process that exits stays pollable from a bounded tombstone (most recent 32, or 10 minutes), so poll after exit still returns exit_code/signal and the tails.",
        },
        notify: {
          type: "boolean",
          description:
            "Optional, default true. When background:true, whether a NATURAL exit may be offered to a host completion sink. No sink is wired in this deployment, so read the terminal state with process_control(action=poll); the flag is kept for hosts that install one.",
        },
        desc: descParam(),
      },
      required: ["command"],
      additionalProperties: false,
    },
  };
}

/**
 * B3-01: this tool used to be a plain `fnTool`, which can only see `args` — and
 * a FOREGROUND run needs the caller's cancellation signal, or the command
 * outlives the cancelled turn that started it.
 *
 * `executeWith` is the seam's way to receive the whole `ToolInput`. `execute`
 * stays as the no-signal face so a direct caller (and every test that calls
 * `execute`) keeps working with unchanged behaviour: no signal, no cancellation,
 * only the wall clock.
 */
export function runShellTool(options: RunShellToolOptions): Tool {
  const spec = runShellSpec();
  const run = runShellImpl(options);
  return {
    spec: () => spec,
    execute: (args: unknown): Promise<unknown> => run(args, undefined),
    // `render: null` is the seam's "use the default" value: the registry applies
    // `humanRender` itself (`registry.ts:90`), which is exactly what the old
    // `fnTool` face got for free. Passing it here would import humanRender and
    // risk a cycle for no behavioural gain.
    executeWith: (input: ToolInput): Promise<ToolExecOutcome> =>
      run(input.args, input.signal).then((value) => ({ value, render: null })),
  };
}

/**
 * B5-04: the ONE place that decides "a CPU cap was asked for and this host
 * cannot enforce it", exported so the decision is unit-testable on any host —
 * a predicate copy inside a test proves nothing about the shipped call.
 *
 * `promise_gaps` includes `"rlimits"` exactly when the provider had no rlimit
 * mechanism (W891), which is why the gaps array — not a capability bit — is the
 * input: it is the provider's own measurement, already on [SandboxMeta].
 */
export function cpuCapUnenforceable(cpuSec: number | undefined, promiseGaps: readonly string[]): boolean {
  return cpuSec !== undefined && promiseGaps.includes("rlimits");
}

/**
 * The one implementation both seam faces delegate to. `signal` is undefined on
 * the `execute` face and the turn's own signal on the `executeWith` face.
 */
function runShellImpl(
  options: RunShellToolOptions,
): (args: unknown, signal: AbortSignal | undefined) => Promise<Record<string, unknown>> {
  return async (args, signal) => {
    const command = stringArg(args, "command");
    const workdir = optionalStringArg(args, "workdir");
    const cpuSec = optionalIntArg(args, "cpu_sec");
    const cpu = cpuSec === undefined ? {} : { cpuSec };
    if (boolArg(args, "background", false)) {
      // B3-01: a BACKGROUND child deliberately does NOT take the signal. It is
      // registered so a later turn can poll/kill it, and its whole purpose is to
      // outlive this turn; cancelling this turn must not reach it.
      const spawned = await options.sandbox.spawn({ command, workdir, ...cpu });
      const handle = options.processes.insert(spawned.child, boolArg(args, "notify", true), {
        cpuSec: spawned.sandbox.cpu_sec ?? cpuSec ?? null,
      });
      return { background: true, handle: handle.handle, pid: handle.pid, sandbox: spawned.sandbox };
    }
    const run = await options.sandbox.run({
      command,
      workdir,
      timeoutMs: optionalIntArg(args, "timeout_ms"),
      ...cpu,
      // Absent when the caller wired no signal, which is the pre-B3-01 shape.
      ...(signal === undefined ? {} : { signal }),
    });
    // W6/W9223: an RLIMIT_CPU kill must not read as a bare death - mark it when
    // the kernel reports the ONE signal only RLIMIT_CPU can send.
    //
    // W9223 (W9205-D7): SIGKILL was ALSO accepted here, and that made every
    // unattributed SIGKILL a "CPU time limit exceeded". The wall clock does not
    // reach this line (captureRun throws SandboxError("timeout") first), so the
    // deaths that DID reach it were exactly the ones the CPU limit did NOT cause:
    // the OOM killer, an external kill -9, bwrap --die-with-parent reaping the
    // tree. run.sandbox.cpu_sec !== undefined was no help - resolveCallCpuSec
    // always derives a number for a foreground call, so that guard was true on
    // essentially every run.
    //
    // SIGXCPU is sent by RLIMIT_CPU and nothing else, so it attributes the death
    // on its own. This matches run-code/cpu-kill.ts (isCpuKill), where the broker
    // additionally excludes the children IT killed; run_shell has no such flag,
    // so the signal alone is the honest test. A hard-limit SIGKILL is still
    // covered: the soft limit (SIGXCPU) is delivered first.
    const cpuExceeded = run.exit_code === null && run.signal === "SIGXCPU";
    // B5-04: a CPU cap the host CANNOT enforce must not read as if it did.
    // `promise_gaps` already carries the truth (`rlimits`), and it reaches the
    // model inside `sandbox`; what was missing is the SENTENCE. Without it a
    // model that asked for cpu_sec=1 on a Windows host reads `sandbox.cpu_sec: 1`
    // and concludes the cap is in force — measured: the busy loop ran to the
    // 6s WALL clock with the 1s CPU cap never firing. The warning is emitted only
    // when the caller actually ASKED for a cap (so a call that never mentioned
    // cpu_sec is not nagged) and only when the host says the gap is real.
    const shouldWarn = cpuCapUnenforceable(cpuSec, run.sandbox.promise_gaps ?? []) && !cpuExceeded;
    return {
      stdout: run.stdout,
      stderr: run.stderr,
      exit_code: run.exit_code,
      ...(run.signal === null || run.signal === undefined ? {} : { signal: run.signal }),
      // The cap is named when the provider reported one (it always does on a
      // real SIGXCPU); "unknown" keeps the sentence honest if an embedding did not.
      ...(cpuExceeded ? { cpu_exceeded: true, message: `CPU time limit ${run.sandbox.cpu_sec ?? "unknown"}s exceeded` } : {}),
      // Never a `cpu_exceeded` claim: nothing was exceeded, the cap simply was
      // not applied. A distinct key so a caller can tell "killed by the cap" from
      // "the cap did not exist".
      ...(shouldWarn
        ? {
            cpu_cap_enforced: false,
            message:
              `cpu_sec=${cpuSec} was NOT enforced: this host has no rlimit mechanism ` +
              `(sandbox.promise_gaps includes "rlimits"), so the wall clock remains the only bound.`,
          }
        : {}),
      stdout_truncated: run.stdout_truncated,
      stderr_truncated: run.stderr_truncated,
      sandbox: run.sandbox,
    };
  };
}
