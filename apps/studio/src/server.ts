/**
 * `startStudioServer` (H): the ONE reusable server bootstrap.
 *
 * `apps/studio/src/main.ts` (source checkout) and the `celestea` CLI
 * (`packages/cli`) both call this, so the startup log lines and the W742
 * graceful-teardown order exist in exactly one place. `main.ts` stays a thin
 * wrapper that pins the historical source defaults; the CLI passes its own
 * flags.
 *
 * Teardown order is the W742 contract (do not reorder):
 *   signal -> stop accepting traffic (bounded grace) -> kill pty process groups
 *   -> flush grants audit -> engine down (workers settled, logs closed) -> let
 *   the loop drain.
 *
 * B4-01 P0 added the pty step. It is here and not inside engine teardown
 * because a pty is NOT the engine's resource: it is a detached process group
 * that survives the engine and the parent process unless something signals it.
 */

import { serve } from "@hono/node-server";
import { createStudioApp, type StudioAppOptions } from "./app.js";
import { loadStudioConfig } from "./config.js";
import { assertBindIsSafe } from "./auth/api-token.js";
import { engineLlmView } from "./runtime/llm-assembly.js";
import type { RealRuntimeAdapter } from "./runtime/real-runtime-adapter.js";
import { autowakeEnabled, ENV_AUTOWAKE } from "@celestea/runtime";
import { bounded, TIMED_OUT } from "@celestea/tools";
// B4-01 P0: the pty table is built by the terminal routes, which live behind
// handlers/index.ts. The shutdown path has to reach it from out here, so the
// table publishes itself under a per-app key this file can name from the very
// app object it is tearing down (see terminal-pty.ts).
import { terminalOwnerKey } from "./handlers/terminal.js";
import { releaseTerminalTable, stopAllTerminalReapers } from "./handlers/terminal-pty.js";

/** Env knob: drain window before leftover sockets are cut. */
export const ENV_DRAIN_MS = "CELESTEA_SHUTDOWN_DRAIN_MS";
/** Env knob: ceiling for the whole teardown. */
export const ENV_TEARDOWN_MS = "CELESTEA_SHUTDOWN_TIMEOUT_MS";

export interface StudioServerOptions extends StudioAppOptions {
  port: number;
  hostname: string;
  /** Emit the startup banner (default true; tests may silence it). */
  log?: boolean;
  /**
   * W9206-35: install the process-level last-resort handlers (default true).
   * Tests turn it off so a deliberate throw is still observable as a failure
   * instead of being logged and absorbed by the server under test.
   */
  crashNet?: boolean;
  /** Called once the listener is up, with the ACTUAL bound port. */
  onListening?: (info: { port: number; hostname: string; endpointCount: number }) => void;
}

export interface StudioServerHandle {
  port: number;
  hostname: string;
  endpointCount: number;
  /** Resolves once the socket is bound (the ACTUAL address is then known). */
  listening: Promise<{ port: number; hostname: string }>;
  /** Graceful stop (idempotent); resolves once the loop may drain. */
  stop(signal: string): Promise<void>;
}

interface ServeHandle {
  close(cb?: () => void): void;
  closeAllConnections?(): void;
}

/**
 * W9206-35: the LAST-RESORT net, installed once per server.
 *
 * Node's default for an unhandled stream `error` (or a rejected promise with
 * no handler) is to tear the process down, which would take every session,
 * turn and pty with it. The specific cause found in this audit is fixed where
 * it happens (the terminal's stdin listener), but a server whose whole value
 * is long-lived state must not die from one stray emitter: log it loudly and
 * keep serving. This does NOT swallow anything — the line names the error, and
 * an unrecoverable state still surfaces on the next request.
 */
function installCrashNet(log: (line: string) => void): void {
  process.on("uncaughtException", (error) => {
    log("[celestea] uncaught exception (kept serving): " + describeError(error));
  });
  process.on("unhandledRejection", (reason) => {
    log("[celestea] unhandled rejection (kept serving): " + describeError(reason));
  });
}

/** One error as a single line for the crash net (never a nested stack dump). */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

/** The one startup banner (kept out of `startStudioServer` for the size rule). */
function logListeningBanner(info: {
  hostname: string;
  port: number;
  endpointCount: number;
  view: ReturnType<typeof engineLlmView>;
  apiKeyEnv: string;
  env: NodeJS.ProcessEnv;
}): void {
  console.log(`[celestea-studio-ts] listening on http://${info.hostname}:${info.port} (${info.endpointCount} contract endpoints)`);
  const v = info.view;
  console.log(
    `[celestea-studio-ts] llm: mode=${v.mode} model=${v.model} base_url=${v.baseUrl} ` +
      `key=${v.hasApiKey ? "set" : "missing"} context_window=${v.contextWindow ?? "n/a"} ` +
      `timeouts(c/r/i)=${v.timeouts.connectMs ?? "off"}/${v.timeouts.responseMs ?? "off"}/${v.timeouts.idleMs ?? "off"}ms`,
  );
  console.log(`[celestea-studio-ts] reasoning_effort=${v.reasoningEffort ?? "off"} max_output_tokens=${v.maxOutputTokens ?? "off"}`);
  console.log(`[celestea-studio-ts] api_key_env=${info.apiKeyEnv} (key read from the environment only)`);
  console.log(
    autowakeEnabled(info.env)
      ? `[celestea-studio-ts] autowake: enabled (a worker receipt wakes its host session; ${ENV_AUTOWAKE}=0 disables)`
      : `[celestea-studio-ts] autowake: disabled by ${ENV_AUTOWAKE}`,
  );
}

/**
 * How ONE teardown step ended. Three states, not two: a step that was abandoned
 * at its deadline and a step that THREW are different facts, and collapsing them
 * would make the log lie in a new way (reporting a failure as a timeout).
 */
type StepOutcome = "settled" | "timed-out" | "failed";

/**
 * The ONE line a teardown step gets: the historical success text verbatim, or
 * the honest non-success. `ok` is passed in so the normal path stays
 * byte-identical to the W742 contract (see the W2029 report §2④).
 */
function stepLine(name: string, outcome: StepOutcome, ms: number, ok: string): string {
  if (outcome === "settled") return ok;
  if (outcome === "timed-out") return `${name} TIMED OUT after ${ms}ms — it may not have finished (reported, never silent)`;
  return `${name} FAILED — see the "teardown step failed" line above`;
}

/** Boot the studio HTTP server; returns a handle whose `stop` is the teardown. */
export function startStudioServer(options: StudioServerOptions): StudioServerHandle {
  const env = options.env ?? process.env;
  // H: resolve the config HERE so the listening callback can write the ACTUAL
  // address back into it. `services.config` is the same object, so
  // `GET /api/health.bind` can never disagree with the socket the process is on
  // (the "never lie to the operator" rule); `--port 0` reports the real port.
  const config = options.config ?? loadStudioConfig({ cwd: options.cwd, env });
  // H-security: a non-loopback listener with no token is a remote-shell hole
  // (POST /api/exec). Refuse BEFORE composing or binding; never degrade silently.
  assertBindIsSafe(options.hostname, config.authToken);
  const { app, routes, services } = createStudioApp({ ...options, config });
  const profile = services.runtime.profile();
  const view = engineLlmView(profile, env);
  const loud = options.log ?? true;
  const drainMs = Number.parseInt(env[ENV_DRAIN_MS] ?? "2000", 10);
  const teardownMs = Number.parseInt(env[ENV_TEARDOWN_MS] ?? "5000", 10);

  let boundPort = options.port;
  let announceListening: (info: { port: number; hostname: string }) => void = () => {};
  const listening = new Promise<{ port: number; hostname: string }>((resolve) => {
    announceListening = resolve;
  });
  const server = serve({ fetch: app.fetch, port: options.port, hostname: options.hostname }, (info) => {
    boundPort = info.port;
    config.bind = `${options.hostname}:${info.port}`;
    announceListening({ port: info.port, hostname: options.hostname });
    if (loud) {
      logListeningBanner({ hostname: options.hostname, port: info.port, endpointCount: routes.length, view, apiKeyEnv: profile.api_key_env, env });
    }
    options.onListening?.({ port: info.port, hostname: options.hostname, endpointCount: routes.length });
  }) as unknown as ServeHandle;

  const engine = services.runtime as Partial<RealRuntimeAdapter>;
  let stopping = false;
  const log = (line: string): void => {
    if (loud) console.log(`[celestea-studio-ts] ${line}`);
  };
  // W9206-35: installed once the logger exists (the net reports through it).
  if (options.crashNet !== false) installCrashNet(log);

  /**
   * Run ONE teardown step under a deadline and report HOW it ended.
   *
   * W2014 semantics are preserved VERBATIM: the deadline still RESOLVES, it does
   * not reject — a step that ran out of budget is not an error here, and only
   * `work` itself rejecting reaches the catch. That is load-bearing, not
   * cosmetic: `stopTraffic` shares this helper, and a throw on timeout would
   * abort the whole exit path mid-teardown.
   *
   * W2029 defect A: the outcome used to be DISCARDED, so the caller printed the
   * success line whether the step finished or was abandoned at the deadline —
   * an operator reading the log could not tell "the audit reached disk" from
   * "we gave up waiting for it". The returned outcome is that missing
   * distinction; it changes no control flow, only what the caller can say.
   */
  async function within(work: Promise<void> | void, ms: number): Promise<StepOutcome> {
    try {
      const raced = await bounded(Promise.resolve(work), ms, { mode: "resolve", value: () => TIMED_OUT });
      return raced === TIMED_OUT ? "timed-out" : "settled";
    } catch (e) {
      log(`teardown step failed: ${e instanceof Error ? e.message : String(e)}`);
      return "failed";
    }
  }

  async function stopTraffic(): Promise<void> {
    await within(
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
      drainMs,
    );
    server.closeAllConnections?.();
  }

  async function stop(signal: string): Promise<void> {
    if (stopping) {
      // W2029 defect B: this used to say "exiting now (in-flight work is
      // dropped)" while doing neither — the first drain kept running and the
      // process stayed up for up to drainMs + teardownMs. The log lied to the
      // operator. It now describes what this call actually does: nothing but
      // report. Forcing a real exit here is NOT safe in this process — the
      // in-flight work is the engine teardown, i.e. the session logs being
      // closed and flushed (see the W742 order above); killing it would trade a
      // slow shutdown for a torn one. Escalation stays systemd's job
      // (TimeoutStopUSec + KillSignal); this line tells the operator it is now
      // the only thing left that can end the process.
      log(`${signal} again — already draining (in-flight teardown continues; this call does not exit early)`);
      return;
    }
    stopping = true;
    log(`${signal} received — draining (grace ${drainMs}ms)`);
    await stopTraffic();
    log("traffic stopped (listener closed, leftover sockets cut)");
    // B4-01 P0: kill every pty BEFORE the engine goes down, so a terminal still
    // streaming cannot outlive the process. A pty leads its own detached process
    // group, so nothing else would take it: without this step a browser that
    // vanished left `python3` / `npm run dev` running until the machine rebooted.
    // It is its own teardown step (not folded into engine teardown) because it
    // is a different resource with a different bound, and because a timeout here
    // must be reported rather than silently skip the kill.
    // Stop the idle sweeps FIRST and unconditionally: a setInterval that outlives
    // the app it was sweeping is a timer nobody can reach again (and the
    // watchdog-mount gate fails on exactly that). It costs nothing when no pty
    // was ever opened, so it is not conditional on the kill count below.
    stopAllTerminalReapers();
    // B4-01 P0: kill every pty BEFORE the engine goes down, so a terminal still
    // streaming cannot outlive the process. A pty leads its own detached process
    // group, so nothing else would take it.
    //
    // W2029 honesty: the line is printed ONLY when something was actually
    // signalled. A server that never hosted a pty has nothing to report, and a
    // "ptys terminated: 0" line would be noise pretending to be a fact -- the
    // shutdown log is a byte-exact baseline that other gates assert against.
    let ptyKilled = 0;
    const ptyStep = await within(
      releaseTerminalTable(terminalOwnerKey(app)).then((n) => { ptyKilled = n; }),
      teardownMs,
    );
    if (ptyKilled > 0) {
      log(
        stepLine(
          "pty teardown",
          ptyStep,
          teardownMs,
          `ptys terminated: ${String(ptyKilled)} process group(s) signalled`,
        ),
      );
    } else if (ptyStep !== "settled") {
      // A non-settled step with nothing killed is still worth reporting: the
      // deadline passed, which is exactly what §2④ forbids staying silent about.
      log(stepLine("pty teardown", ptyStep, teardownMs, "no pty was signalled"));
    }
    const audit = await within(services.grants.audit.flush(), drainMs);
    log(stepLine("audit flush", audit, drainMs, "audit flushed"));
    const engineStep = await within(engine.shutdown?.(), teardownMs);
    log(stepLine("engine teardown", engineStep, teardownMs, "engine stopped (workers settled, session logs closed) — loop may drain"));
  }

  return {
    get port() {
      return boundPort;
    },
    hostname: options.hostname,
    endpointCount: routes.length,
    listening,
    stop,
  };
}
