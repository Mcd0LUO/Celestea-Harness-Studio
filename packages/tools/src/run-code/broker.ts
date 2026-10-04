/**
 * The `run_code` parent broker (`crates/tools/src/run_code.rs:562-978`).
 *
 * One `run_code` call = one round trip. The assembled program — TypeScript by
 * default since W774, Python on request — runs in the sandbox; its sub-calls
 * arrive as one-line JSON on stdout and the parent answers on stdin after
 * dispatching each one through the **same** registry pipeline (schema → guards →
 * execute) the model itself would use. Only `main()`'s return value travels back
 * as the tool result.
 *
 * The protocol is language-neutral (it is byte-identical for both SDKs), so the
 * language only decides two things: the script file's extension and the
 * interpreter that runs it.
 *
 * Invariants:
 * - every limit is enforced here, never in the child: the 21st sub-call is
 *   refused before dispatch, the wall clock is enforced while waiting for a
 *   line, the sub-call output ledger is charged per reply;
 * - every infrastructure failure is a structured `run_code: code=… msg="…"`
 *   (invalid_arg | registry | config | spawn | protocol | timeout | cpu_exceeded
 *   | aborted); `cpu_exceeded` is the §3.3 addition that makes a child killed by
 *   its own `RLIMIT_CPU` self-describing instead of a bare `aborted`;
 *   a program exception is that exception's text plus a bounded log tail;
 * - the child is killed on timeout, on cancel and on protocol failure — never
 *   left behind — and its script file is removed on every exit path.
 */

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";

import type { Sandbox, SandboxChild, SandboxSpawned, SessionEvent, ToolExecOutcome, ToolInput, ToolRegistry } from "@celestea/core";

import { errorCode, errorText } from "../errors.js";
import { stringArg } from "../args.js";
import { resolveShellKind, type ShellResolveInput } from "../platform/exec.js";
import { pythonCandidates, runCodeCommand } from "../platform/quote.js";
import { whichSync } from "../sandbox/probe.js";
import { cpuExceededFailure as cpuKillFailure, isCpuSignal } from "./cpu-kill.js";
import { newRunState, type ChildTermination, type RunBudget, type RunState } from "./run-state.js";
import { deriveCpuSecFromWallClock } from "../sandbox/limits.js";
import { bounded, TIMED_OUT, withTimeout } from "../sandbox/async.js";
import { readCapped, REAP_GRACE_MS } from "../sandbox/launch.js";
import { ToolFailure } from "../tool-failure.js";
import {
  EXIT_GRACE_MS,
  MAX_LINE_BYTES,
  RUN_CODE_ERROR_PREFIX,
  SDK_TOOLS,
  resolveTimeoutMs,
  runCodeFailure,
  type RunCodeConfig,
} from "./limits.js";
import { LineReader, appendBounded, jsonByteLength, tail, truncateValue, type BoundedLine } from "./lines.js";
import { classifyProgramFailure } from "./program-failure.js";
import { assembleProgram, DEFAULT_RUN_CODE_LANGUAGE, type RunCodeLanguage } from "./sdk.js";

/** Session-log sink for sub-call rows (legacy `Fn(SessionEvent)` sink). */
export type RunCodeEventSink = (event: SessionEvent) => void;

/** Everything one broker run needs (the tool binds the registry + call id). */
export interface BrokerContext {
  sandbox: Sandbox;
  registry: ToolRegistry;
  events?: RunCodeEventSink;
  config: RunCodeConfig;
  /** The `run_code` call id: sub-call ids are `<parentId>:c<n>`. */
  parentId: string;
  /**
   * The language of the program being run (W2012): the failure classifier keys
   * its stderr markers on it (Node's `SyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]`
   * vs CPython's `SyntaxError`). Defaults to TypeScript, the shipped default.
   */
  language?: RunCodeLanguage;
  /**
   * The user's own source, recorded at assembly time (W2062).
   *
   * Why it lives on the context instead of being read back from disk: the
   * classifier runs in `finally` AFTER `script.cleanup()` may already have
   * removed the file, and the file on disk is the ASSEMBLED program (SDK
   * preamble + user code + runner) — the brace hint must count the USER's
   * braces, not the SDK's. Kept per-run (never module-level) because two
   * `run_code` calls can overlap in one process.
   */
  programSource?: string;
  /**
   * B3-01: the turn's cancellation signal. Absent = the host cannot cancel.
   *
   * The file header has claimed "the child is killed on timeout, on cancel and on
   * protocol failure" since the broker was written, but nothing carried a cancel
   * down to here: the loop stopped *awaiting* the batch and the program went on
   * running. With this signal the child is killed on abort, which makes the
   * header's claim true.
   */
  signal?: AbortSignal;
}

/** One parsed sub-call request from the child. */
interface SubRequest {
  id: number;
  tool: string;
  args: Record<string, unknown>;
}

let scriptSeq = 0;

/**
 * Absolute interpreter path of a TypeScript program (W774): the Node that runs
 * THIS process, which is the same binary the sandbox can see (`--ro-bind / /`
 * mounts the host root read-only) and never depends on the child's PATH.
 * `/usr/bin/node` is preferred because it is the host's system-wide install;
 * `process.execPath` is the honest fallback (nvm/volta hosts).
 *
 * W885: the constant is kept for compatibility, but the interpreter actually
 * used is resolved per run (`resolveInterpreter`), which checks the platform
 * PATH first — `/usr/bin/node` is a POSIX convention that simply does not
 * exist on Windows (W883 B9/B15).
 */
export const TS_PROGRAM_RUNTIME = existsSync("/usr/bin/node") ? "/usr/bin/node" : process.execPath;

/** One full run_code round trip: the program's final value + its render. */
export async function brokerRun(ctx: BrokerContext, args: unknown): Promise<ToolExecOutcome> {
  const source = programSource(args);
  const timeoutMs = resolveTimeoutMs(readArg(args, "timeout_ms"), ctx.config);
  // §3.3: the child's RLIMIT_CPU follows THIS run's effective wall clock. Computed
  // once, here, so the value handed to the sandbox and the value named in a
  // `cpu_exceeded` failure cannot drift apart.
  const cpuSec = deriveCpuSecFromWallClock(timeoutMs, ctx.sandbox.config.maxCpuSec);
  // W880: the program is written to <CELESTEA_HOME>/.../run-code, NOT into the
  // workspace. The sandbox config owns that absolute path; the interpreter is
  // invoked with the absolute path so no cwd-relative lookup is involved.
  ctx.language = source.language;
  ctx.programSource = source.code;
  const script = await placeProgram(ctx.sandbox.config.programDir, source);
  const state = newRunState();
  state.cpuSec = cpuSec;
  try {
    await executeProgram(
      ctx,
      { scriptPath: script.path, language: source.language, budget: { timeoutMs, cpuSec } },
      state,
    );
  } catch (e) {
    throw withLogs(e, ctx, state);
  } finally {
    await script.cleanup();
  }
  return outcomeOf(ctx, state);
}

// ---- argument + program placement --------------------------------------------

/** What one `run_code` call asks to run: the source plus its language. */
interface ProgramSource {
  code: string;
  language: RunCodeLanguage;
}

/** `code` must be a non-empty program; `language` defaults to TypeScript (W774). */
function programSource(args: unknown): ProgramSource {
  const code = stringArg(args, "code");
  if (code.trim() === "") throw runCodeFailure("invalid_arg", "'code' must be a non-empty program");
  const raw = readArg(args, "language");
  if (raw === undefined || raw === null) return { code, language: DEFAULT_RUN_CODE_LANGUAGE };
  if (raw === "typescript" || raw === "python") return { code, language: raw };
  // The spec's enum refuses anything else before dispatch; this is the floor.
  throw runCodeFailure("invalid_arg", `'language' must be 'typescript' or 'python' (got ${JSON.stringify(raw)})`);
}

function readArg(args: unknown, key: string): unknown {
  if (typeof args !== "object" || args === null) return undefined;
  return (args as Record<string, unknown>)[key];
}

/**
 * Write `SDK + user code + runner` into
 * `<programDir>/run_code_<pid>_<n>.{mts,py}` — the extension is the ONLY thing the
 * language changes about placement. `programDir` is the sandbox config's
 * absolute `<CELESTEA_HOME>/workspaces/<ws>/run-code`; the host has full-disk
 * access so it writes directly, and the bwrap provider binds that dir into the
 * namespace so the child can read it.
 */
async function placeProgram(programDir: string, source: ProgramSource): Promise<{ path: string; cleanup: () => Promise<void> }> {
  try {
    await mkdir(programDir, { recursive: true });
  } catch (e) {
    throw runCodeFailure("config", `cannot create '${programDir}': ${errorText(e)}`);
  }
  // W892: `.mts`, NOT `.ts`. The program dir is under <CELESTEA_HOME>/.../run-code,
  // which on Windows sits BELOW %USERPROFILE% (or any ancestor) that may hold a
  // package.json without "type". Node then emits MODULE_TYPELESS_PACKAGE_JSON on
  // stderr ("Reparsing as ES module..."), which lands in the captured stderr and
  // breaks byte-exact assertions (and is real noise for users). `.mts` is
  // unconditionally an ES module, so the warning cannot occur anywhere.
  const suffix = source.language === "python" ? "py" : "mts";
  const name = `run_code_${process.pid}_${scriptSeq++}.${suffix}`;
  const path = join(programDir, name);
  try {
    await writeFile(path, assembleProgram(source.code, source.language), "utf8");
  } catch (e) {
    throw runCodeFailure("spawn", `cannot write program file '${path}': ${errorText(e)}`);
  }
  return { path, cleanup: () => rm(path, { force: true }).catch(() => undefined) };
}

// ---- child lifecycle ---------------------------------------------------------

/**
 * B3-01: kill `child` as soon as the turn is cancelled, and return the
 * unsubscribe that removes the listener again.
 *
 * Why a listener and not a flag: the pump below parks on a pending `reader.next()`,
 * so nothing in this file is in a position to *check* a cancellation flag at the
 * right moment. The signal is the only thing that can fire at the right moment,
 * which is exactly why the loop owns it.
 *
 * Contract details that matter:
 *   * a signal ALREADY aborted never fires `abort` again, so it is checked once
 *     here (same reason as `question-registry.ts`'s already-aborted check);
 *   * the kill is the same tree-kill the timeout path uses, so a cancelled
 *     program leaves no grandchildren behind;
 *   * returning the unsubscribe (instead of trusting `{once:true}`) keeps the
 *     listener count flat across the many runs one long-lived signal carries.
 */
function killChildOnAbort(signal: AbortSignal | undefined, child: SandboxChild): () => void {
  if (signal === undefined) return () => undefined;
  // W9321: `void`, not `await`. This listener IS the abort — `controller.abort()`
  // runs it synchronously, so awaiting the tree-kill here would make "user
  // pressed Stop" block on it (the Windows kill was up to ~15s of execFileSync
  // and stalled the whole event loop). The kill is still issued, in the same
  // tick; only the waiting is detached.
  const onAbort = (): void => {
    void child.kill();
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return () => {
    signal.removeEventListener("abort", onAbort);
  };
}

/**
 * The interpreter of one `run_code` program (W885).
 *
 * TypeScript runs under the Node that runs THIS process — the one binary the
 * sandbox is guaranteed to see through `--ro-bind / /` — with the host's PATH
 * consulted first ONLY when that yields a Node (`node` is `node.exe` on
 * Windows, and `process.execPath` there is routinely `C:\\Program Files\\…`
 * with a space in it). Python keeps the historical `python3` on POSIX and
 * falls back to the names Windows actually ships (`python`, `py`).
 *
 * Anything `whichSync` cannot find becomes the bare name, so a missing
 * interpreter still surfaces as the interpreter's own "not found" instead of a
 * silent wrong one.
 */
export function resolveInterpreter(language: RunCodeLanguage, platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (language === "typescript") {
    const onPath = whichSync("node", env, platform);
    if (onPath !== null) return onPath;
    return process.execPath;
  }
  for (const candidate of pythonCandidates(platform)) {
    const found = whichSync(candidate, env, platform);
    if (found !== null) return found;
  }
  return pythonCandidates(platform)[0] ?? "python3";
}

/**
 * The interpreter command line, quoted for the shell that will run it.
 *
 * On POSIX the bytes are exactly what they always were — `python3 -uB '<path>'`
 * / `<node> '<path>'` — because `kind` is `posix` there and both quoting
 * helpers reproduce the historical single-quote rule verbatim.
 */
function interpreterCommand(language: RunCodeLanguage, scriptPath: string, input: ShellResolveInput = {}): string {
  const kind = resolveShellKind(input).kind;
  return runCodeCommand(kind, language, resolveInterpreter(language), scriptPath);
}

/**
 * §3.3: spawn the program with an `RLIMIT_CPU` derived from THIS run's wall clock.
 *
 * Before this, the call was `sandbox.spawn({ command })` — no `cpuSec` at all —
 * so the child silently ate the provider's base `DEFAULT_LIMITS.cpuSec` (20s)
 * while the broker's own wall clock was 120s. A perfectly ordinary long program
 * was therefore killed by the CPU limit at 20s, far before its deadline, and the
 * failure carried no `cpu_exceeded` marker: the reported cause and the real one
 * disagreed. Passing the derived value makes the child's CPU budget follow the
 * wall clock it is actually allowed to use (§3.1), so "the wall clock fires
 * first" is the normal outcome.
 */
async function spawnProgram(sandbox: Sandbox, scriptPath: string, language: RunCodeLanguage, cpuSec: number): Promise<SandboxChild> {
  let spawned: SandboxSpawned;
  try {
    spawned = await sandbox.spawn({ command: interpreterCommand(language, scriptPath, sandbox.shell), cpuSec });
  } catch (e) {
    throw runCodeFailure("spawn", errorText(e));
  }
  if (spawned.child.stdin === null) throw runCodeFailure("spawn", "no stdin pipe (reply channel)");
  // W892: attach the stdin error handler HERE, at spawn — not only in endStdin().
  // `writeReply` writes to this pipe while the child runs; if the program dies or
  // stops draining, the write fails and Node emits an `error` on the stream. With
  // no listener at that moment the error is UNHANDLED and takes the whole process
  // down ("Uncaught Exception: write EOF"), which on Windows CI killed the runner
  // even though every test had passed. The per-write callback still reports the
  // failure to the caller; this listener only prevents the crash.
  spawned.child.stdin.on("error", () => undefined);
  return spawned.child;
}

/** What one `run_code` program is, plus the budget it runs under. */
interface ProgramRun {
  scriptPath: string;
  language: RunCodeLanguage;
  /** The effective wall clock AND the `RLIMIT_CPU` derived from it (§3.1). */
  budget: RunBudget;
}

/**
 * Spawn, pump the protocol to completion, then settle (and always clean up).
 *
 * The wall clock and the child's `RLIMIT_CPU` travel together in `budget`, so the
 * value handed to the sandbox and the value named in a `cpu_exceeded` failure are
 * provably the same number.
 */
async function executeProgram(ctx: BrokerContext, run: ProgramRun, state: RunState): Promise<void> {
  const { scriptPath, language, budget } = run;
  const { timeoutMs, cpuSec } = budget;
  const child = await spawnProgram(ctx.sandbox, scriptPath, language, cpuSec);
  // B3-01: cancellation kills the child, exactly like the wall clock below does.
  // The returned unsubscribe runs in the existing `finally`, so a normal
  // completion never leaves a listener behind on a long-lived signal.
  const unlinkAbort = killChildOnAbort(ctx.signal, child);
  const stderr = readCapped(child.stderr, ctx.config.maxLogBytes);
  // W833 (R3 B1 / W812 P1-1): the wall clock is enforced HERE, not only while
  // waiting for the next stdout line. A slow sub-call (run_shell itself allows
  // 300s) or a reply write parked on a full pipe lives INSIDE pumpLines, where
  // the reader's own deadline cannot be consulted; this timer kills the child
  // and records code=timeout no matter which await the pump is parked on.
  let timedOut = false;
  let pumpError: unknown = null;
  const pump = pumpLines(ctx, child, timeoutMs, state).catch((error: unknown) => {
    // Park the rejection: after the wall clock has already won, the pump may
    // still fail (its write lands on a destroyed stdin) and must not surface as
    // an unhandled rejection. The outcome is decided below.
    pumpError = error;
  });
  try {
    // W2014: the wall clock is a POLICY, not a throw. Winning the race means
    // "the budget is spent": record it, kill the child, and fall through to the
    // SAME settle/render path a natural exit takes — `settleChild` below still
    // owns the reap, and the `code=timeout` verdict is read back out of `state`.
    await bounded(pump, timeoutMs, {
      mode: "resolve",
      value: () => {
        timedOut = true;
        if (state.infraError === null) state.infraError = timeoutMessage(child, timeoutMs, state);
        // W9321: the deadline policy is a synchronous `() => R`, so the kill is
        // issued here and its completion is NOT waited for. `settleChild` below
        // owns the reap, so nothing depends on this promise.
        void child.kill();
      },
    });
  } finally {
    unlinkAbort();
    endStdin(child.stdin);
  }
  if (pumpError !== null && !timedOut) {
    await child.kill();
    throw pumpError;
  }
  const settled = await settleChild(child, EXIT_GRACE_MS);
  const captured = await stderr;
  state.settle = { ...settled, stderrText: captured.text, stderrTruncated: captured.truncated };
}

/**
 * Wait for a natural exit within `graceMs`; on expiry kill the tree.
 *
 * Also reports WHICH kill this was. A non-null `signal` with `killed === false`
 * is the child dying on its own — and on POSIX that is exactly what a
 * `RLIMIT_CPU` exhaustion looks like: the kernel raises SIGXCPU at the soft
 * limit and, if the process survives, SIGKILL at the hard limit. `RLIMIT_CPU`
 * counts CPU time of ONE process, so this is the only place the fact can be
 * observed (the broker's wall clock is a different timeline entirely).
 */
async function settleChild(child: SandboxChild, graceMs: number): Promise<ChildTermination> {
  const exit = await withTimeout(child.wait(), graceMs);
  if (exit !== TIMED_OUT) {
    return { exitCode: exit.code, killed: false, cpuExceeded: isCpuSignal(exit.signal), signal: exit.signal };
  }
  // W9321: an async settle path — await, so `wait()` below is never consulted
  // before the signal has actually been asked for.
  await child.kill();
  await withTimeout(child.wait(), REAP_GRACE_MS);
  return { exitCode: null, killed: true, cpuExceeded: false, signal: null };
}

/** Close our end of the reply channel so a blocked bridge call sees EOF. */
function endStdin(stdin: Writable | null): void {
  if (stdin === null) return;
  stdin.on("error", () => undefined);
  try {
    stdin.end();
  } catch {
    // already closed: nothing to release
  }
}

// ---- the broker loop ---------------------------------------------------------

/** Read protocol lines until `__final__` / `__error__` / EOF / the deadline. */
async function pumpLines(
  ctx: BrokerContext,
  child: SandboxChild,
  timeoutMs: number,
  state: RunState,
): Promise<void> {
  const reader = new LineReader(child.stdout, MAX_LINE_BYTES);
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const line = await reader.next(deadline - Date.now());
      if (line === TIMED_OUT) {
        state.infraError = timeoutMessage(child, timeoutMs, state);
        await child.kill();
        return;
      }
      if (line === null) return;
      if ((await handleLine(ctx, child, line, state)) === "stop") return;
    }
  } finally {
    reader.stop();
  }
}

/** Classify one stdout line: final / error / request / log. */
async function handleLine(
  ctx: BrokerContext,
  child: SandboxChild,
  line: BoundedLine,
  state: RunState,
): Promise<"stop" | "continue"> {
  const trimmed = line.text.trimEnd();
  // W9112: the protocol is UTF-8 on the wire. A line whose bytes do not decode
  // as UTF-8 is NOT a log line and NOT a protocol frame — it is a child writing
  // in a different encoding (the Windows GBK case that silently corrupted every
  // Chinese character into U+FFFD while `error` stayed null). Fail closed with
  // the raw bytes in the message instead of consuming the replacement text.
  // Checked BEFORE the truncation branch so a malformed line cannot slip into
  // the log as U+FFFD merely because it was also over the line budget.
  if (line.malformed) throw malformedProtocolLine(line);
  if (line.truncated) {
    logLine(state, ctx.config, trimmed, true);
    return "continue";
  }
  const decoded = decodeObject(trimmed);
  if (decoded === null) {
    logLine(state, ctx.config, trimmed);
    return "continue";
  }
  if ("__final__" in decoded) {
    state.hasFinal = true;
    state.finalValue = decoded["__final__"];
    return "stop";
  }
  if ("__error__" in decoded) {
    state.programError = typeof decoded["__error__"] === "string" ? decoded["__error__"] : "unknown program error";
    return "stop";
  }
  const request = requestOf(decoded);
  if (request === null) {
    logLine(state, ctx.config, trimmed);
    return "continue";
  }
  await answerSubCall(ctx, child, request, state);
  return "continue";
}

/**
 * W9112: a stdout line that is not valid UTF-8. The message names the raw bytes
 * so the cause is diagnosable from the failure alone, and points at the fix
 * (the interpreter must run in UTF-8 mode) rather than guessing at the content.
 */
function malformedProtocolLine(line: BoundedLine): ToolFailure {
  const shown = line.malformedHex === "" ? "<empty>" : line.malformedHex;
  return runCodeFailure(
    "protocol",
    "the program wrote a stdout line that is not valid UTF-8 " +
      "(raw bytes: " + shown + "); the run_code protocol is UTF-8 in both " +
      "directions, so a different interpreter encoding (for example the " +
      "Windows ANSI code page) would corrupt every non-ASCII value. " +
      "Set PYTHONUTF8=1 for a Python child.",
  );
}

/** Objects only: a JSON scalar / array on stdout is a log line (parity). */
function decodeObject(text: string): Record<string, unknown> | null {
  if (!text.startsWith("{")) return null;
  try {
    const decoded: unknown = JSON.parse(text);
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return null;
    return decoded as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** A request needs an integer `id`, a string `tool` and an object `args`. */
function requestOf(decoded: Record<string, unknown>): SubRequest | null {
  const { id, tool, args } = decoded;
  if (typeof id !== "number" || !Number.isInteger(id)) return null;
  if (typeof tool !== "string") return null;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  return { id, tool, args: args as Record<string, unknown> };
}

// ---- sub-call dispatch -------------------------------------------------------

async function answerSubCall(
  ctx: BrokerContext,
  child: SandboxChild,
  request: SubRequest,
  state: RunState,
): Promise<void> {
  const reply = await buildReply(ctx, request, state);
  try {
    await writeReply(child.stdin as Writable, encodeReply(reply, request.id), ctx.config.stdinWriteTimeoutMs);
  } catch (e) {
    if (e instanceof ToolFailure && e.kind === "timeout") {
      // W833 (R3 B1): a reply the child never drains is a wall-clock failure,
      // not a protocol error. Record it, kill the child and let the pump stop.
      if (state.infraError === null) state.infraError = e.message;
      await child.kill();
      return;
    }
    throw runCodeFailure("protocol", `cannot write reply to the program (stdin closed): ${errorText(e)}`);
  }
}

/** Whitelist → sub-call budget → dispatch through the shared registry. */
async function buildReply(ctx: BrokerContext, request: SubRequest, state: RunState): Promise<Record<string, unknown>> {
  if (!SDK_TOOLS.includes(request.tool)) {
    return { id: request.id, ok: false, error: `tool '${request.tool}' not exposed in run_code SDK` };
  }
  if (state.dispatched >= ctx.config.maxSubCalls) {
    return {
      id: request.id,
      ok: false,
      error: `${RUN_CODE_ERROR_PREFIX}: sub-call limit exceeded (max ${ctx.config.maxSubCalls})`,
    };
  }
  state.dispatched += 1;
  const subCallId = `${ctx.parentId}:c${request.id}`;
  const input: ToolInput = { call_id: subCallId, name: request.tool, args: request.args };
  ctx.events?.({ type: "tool_call", id: subCallId, name: request.tool, args: request.args, parent_id: ctx.parentId });
  const out = await ctx.registry.dispatch(input);
  ctx.events?.({ type: "tool_result", id: subCallId, value: out.value, error: out.error, parent_id: ctx.parentId });
  if (out.error !== null) return { id: request.id, ok: false, error: out.error };
  return valueReply(ctx.config, request.id, out.value, state);
}

/** Charge the sub-call output ledger; oversized values are cut with a warning. */
function valueReply(config: RunCodeConfig, id: number, value: unknown, state: RunState): Record<string, unknown> {
  const size = jsonByteLength(value);
  const room = Math.max(config.maxSubOutputBytes - state.subOutputBytes, 0);
  if (size !== null && size <= room) {
    state.subOutputBytes += size;
    return { id, ok: true, value };
  }
  const cut = truncateValue(value, room);
  const cutSize = jsonByteLength(cut) ?? 0;
  state.subOutputBytes += cutSize;
  state.subOutputDropped += Math.max((size ?? 0) - cutSize, 0);
  return {
    id,
    ok: true,
    value: cut,
    truncated: true,
    warning: `sub-call output budget (${config.maxSubOutputBytes} bytes) exceeded; value truncated`,
  };
}

function encodeReply(reply: Record<string, unknown>, id: number): string {
  try {
    const encoded = JSON.stringify(reply);
    if (encoded !== undefined) return encoded;
  } catch {
    // fall through: the value cannot cross the wire, tell the program why
  }
  return JSON.stringify({ id, ok: false, error: "reply not serializable" });
}

/** W896: the bound is a parameter so tests can shrink it (default stays 5s). */
async function writeReply(stdin: Writable, line: string, timeoutMs: number): Promise<void> {
  const written = new Promise<void>((resolve, reject) => {
    stdin.write(`${line}\n`, (error) => (error === null || error === undefined ? resolve() : reject(error)));
  });
  if ((await withTimeout(written, timeoutMs)) === TIMED_OUT) {
    throw runCodeFailure(
      "timeout",
      `reply was not written after ${timeoutMs}ms (the program stopped reading stdin)`,
    );
  }
}

// ---- logs, render, outcome ---------------------------------------------------

/**
 * Append one log line to the bounded stdout log. Lines append back to
 * back (no separator): the budget is a byte ledger, not a pretty printer.
 */
function logLine(state: RunState, config: RunCodeConfig, text: string, truncated = false): void {
  const merged = appendBounded(state.logs, text, config.maxLogBytes);
  state.logs = merged.text;
  state.logsTruncated =
    state.logsTruncated || merged.truncated || truncated || Buffer.byteLength(text, "utf8") > config.maxLogBytes;
}

function timeoutMessage(child: SandboxChild, timeoutMs: number, state: RunState): string {
  const pid = child.pid === null ? "?" : String(child.pid);
  const captured = Buffer.byteLength(state.logs, "utf8");
  return runCodeFailure("timeout", `killed pid ${pid} after ${timeoutMs}ms (wall clock; stdout_log_captured_bytes=${captured})`)
    .message;
}

function abortedMessage(state: RunState): string {
  const settled = state.settle;
  const code = settled === null || settled.exitCode === null ? "?" : String(settled.exitCode);
  const killed = settled?.killed === true;
  return runCodeFailure("aborted", `program exited code=${code} (killed=${killed}) without a final line`).message;
}

/**
 * Human rendering: stdout logs + stderr tail + budget warnings (bounded).
 *
 * W833 (R3 B1 / W812 P2-2): the numbers come from the EFFECTIVE config, not the
 * module constants — a caller that injects a smaller budget must see its own
 * value in the render or the model is told a threshold that does not apply.
 */
function composeRender(config: RunCodeConfig, state: RunState): string | null {
  const parts: string[] = [];
  const settled = state.settle;
  if (state.logs !== "") parts.push(state.logs);
  if (state.logsTruncated) parts.push(`[run_code] stdout logs truncated at ${config.maxLogBytes} bytes`);
  if (settled !== null && settled.stderrText !== "") parts.push(`[stderr]\n${settled.stderrText}`);
  if (settled !== null && settled.stderrTruncated) parts.push(`[run_code] stderr truncated at ${config.maxLogBytes} bytes`);
  if (state.subOutputDropped > 0) {
    parts.push(
      `[run_code] warning: sub-call output budget (${config.maxSubOutputBytes} bytes) exceeded — ${state.subOutputDropped} bytes dropped`,
    );
  }
  return parts.length === 0 ? null : parts.join("\n");
}

/**
 * The canonical value, or the structured error
 * (infra > program > CPU > syntax/entry > aborted).
 *
 * W2012: the syntax/entry rung is what turns "the program is not valid" from a
 * `code=aborted` infrastructure verdict into a diagnosable `code=program_syntax`
 * / `code=program_error` one. It sits AFTER the CPU verdict on purpose — a
 * SIGXCPU death with a syntax error in its stderr is a CPU story — and BEFORE
 * `abortedMessage`, which stays the honest answer when stderr explains nothing.
 */
function outcomeOf(ctx: BrokerContext, state: RunState): ToolExecOutcome {
  const render = composeRender(ctx.config, state);
  const settled = state.hasFinal || completedSilently(state);
  const error =
    state.infraError ??
    state.programError ??
    cpuExceededFailure(state) ??
    (settled ? null : (classifiedMessage(ctx, state) ?? abortedMessage(state)));
  if (error !== null) throw new ToolFailure(errorCode(error) ?? RUN_CODE_ERROR_PREFIX, withLogsText(error, render));
  return { value: state.hasFinal ? state.finalValue : null, render };
}

/**
 * Did the program END ITSELF successfully (W2012)?
 *
 * A complete script may legitimately finish with `process.exit(0)` after writing
 * its answer to stdout — the runner's final line is then unreachable. The exit
 * code is the interpreter's own verdict, so `0` (and not killed by the broker)
 * means the program ran to completion; reporting that as
 * `code=aborted … without a final line` was the same class of lie as reporting a
 * syntax error as a timeout. The run's stdout logs are its answer and the value
 * is `null` (there was no `main` to return one).
 *
 * Only the FAILING runs (non-zero exit, or a signal) reach the classifier.
 */
function completedSilently(state: RunState): boolean {
  const settled = state.settle;
  return settled !== null && !settled.killed && settled.exitCode === 0;
}

/**
 * W2012: the program-level verdict for a run that produced no protocol line —
 * `null` when stderr does not name a cause (then the caller says `aborted`).
 *
 * `state.settle` is non-null on this path by construction: `executeProgram`
 * always settles the child before `outcomeOf` is reached, so the captured
 * stderr (and its tail) is available exactly once.
 */
function classifiedMessage(ctx: BrokerContext, state: RunState): string | null {
  const settled = state.settle;
  if (settled === null || settled.stderrText.trim() === "") return null;
  const failure = classifyProgramFailure(
    ctx.language ?? DEFAULT_RUN_CODE_LANGUAGE,
    settled.stderrText,
    ctx.programSource ?? null,
  );
  if (failure === null) return null;
  return runCodeFailure(failure.kind, failure.message).message;
}

/**
 * §3.3: did the CHILD's own `RLIMIT_CPU` kill this run? The verdict itself lives
 * in `cpu-kill.ts`; this only supplies the run's facts. It is consulted LAST, so
 * an infra error, a program exception or a completed run always wins — a CPU kill
 * can never steal the `code=timeout` case that §3.2/§3.3 want to keep.
 */
function cpuExceededFailure(state: RunState): string | null {
  return cpuKillFailure({
    death: state.settle,
    cpuSec: state.cpuSec,
    hasFinal: state.hasFinal || state.programError !== null,
    capturedBytes: Buffer.byteLength(state.logs, "utf8"),
  });
}

/** Attach the bounded render tail to a failure (legacy `FailureCtx`). */
function withLogsText(error: string, render: string | null): string {
  if (render === null || render === "") return error;
  return `${error}\n[run_code] logs:\n${tail(render, 2048)}`;
}

function withLogs(error: unknown, ctx: BrokerContext, state: RunState): Error {
  const text = withLogsText(errorText(error), composeRender(ctx.config, state));
  return error instanceof ToolFailure ? new ToolFailure(error.kind, text) : new ToolFailure(RUN_CODE_ERROR_PREFIX, text);
}
