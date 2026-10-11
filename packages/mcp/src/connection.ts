/**
 * One server, one connection (docs/feature/mcp-client.md §6.2).
 *
 * The semantics that are easy to get wrong, and where they live:
 *   - **Per-generation**: the caller creates one connection per session
 *     generation and disposes it with that session. Nothing is shared across
 *     sessions, so a permission level or a credential cannot leak sideways.
 *   - **Budget + backoff**: the policy lives in reconnect.ts; this module only
 *     decides WHEN to consult it (a failed connect, and a failed call-time
 *     re-connect).
 *   - **Teardown is bounded and fail-closed**: disposal cancels the retry first,
 *     then closes the transport under a deadline. Overlapping old and new child
 *     processes are worse than a stopped one — so a missed deadline is recorded on
 *     the status row, not thrown at the caller.
 *
 * Written as a class rather than a bag of closures so each rule is its own small
 * method: the first version of this file was one 145-line factory, which is exactly
 * the shape where "who updates the state" stops being answerable.
 */

import { bounded } from "@celestea/core";

import { McpError, classifyError } from "./errors.js";
import { createReconnectSupervisor, type ReconnectSupervisor } from "./reconnect.js";
import { systemScheduler, type Scheduler } from "./scheduler.js";
import { boundedSignal, type McpClient, type McpTransport, type McpTransportFactory } from "./transport.js";
import type {
  McpCallResult,
  McpConnectionState,
  McpFailureKind,
  McpRemoteTool,
  McpServerConfig,
  McpServerStatus,
} from "./types.js";


export interface ConnectionDeps {
  readonly transportFactory: McpTransportFactory;
  readonly scheduler?: Scheduler;
  readonly now?: () => number;
  /** Deadline for the transport close. Beyond it we stop anyway (fail-closed). */
  readonly closeTimeoutMs?: number;
}

const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

export interface ServerConnection {
  readonly server: string;
  /** First connection attempt; `true` when the server is ready. */
  connect(): Promise<boolean>;
  /** One bounded re-connect attempt (used after an observed disconnect). */
  reconnectOnce(): Promise<boolean>;
  /** Re-run discovery. On failure the PREVIOUS generation is kept (A7). */
  refresh(): Promise<boolean>;
  /**
   * The transport is gone: what the SDK's onclose will call once it is wired, and
   * what the session calls when a dispatch finds no live client. Hands the server
   * back to the supervisor WITHOUT touching the tool surface, because a brief
   * disconnect must not blank the model face.
   */
  markLost(): void;
  /** The last successfully discovered tools. */
  tools(): readonly McpRemoteTool[];
  call(tool: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult>;
  status(): McpServerStatus;
  dispose(): Promise<void>;
}

interface Failure {
  readonly kind: McpFailureKind;
  readonly detail: string;
}

class ServerConnectionImpl implements ServerConnection {
  readonly server: string;
  private state: McpConnectionState = "idle";
  private transport: McpTransport | null = null;
  private client: McpClient | null = null;
  private failure: Failure | null = null;
  private lastTools: readonly McpRemoteTool[] = [];
  private inFlight: Promise<boolean> | null = null;
  private readonly supervisor: ReconnectSupervisor;

  constructor(
    private readonly config: McpServerConfig,
    private readonly deps: ConnectionDeps,
  ) {
    this.server = config.name;
    this.supervisor = createReconnectSupervisor(
      config,
      deps.scheduler ?? systemScheduler(),
      deps.now ?? (() => Date.now()),
    );
  }

  /** Open the transport and complete `initialize`; failure is recorded, not thrown. */
  private attempt(): Promise<boolean> {
    this.state = "connecting";
    const opened = this.deps.transportFactory(this.config);
    return opened
      .connect()
      .then((connected) => {
        this.transport = opened;
        this.client = connected;
        this.state = "ready";
        this.failure = null;
        this.supervisor.markReady();
        return true;
      })
      .catch((error: unknown) => {
        this.record(classifyError(error), error);
        void opened.close().catch(() => undefined);
        this.transport = null;
        this.client = null;
        // Not "connecting" any more: something can be true of it now ("failed",
        // or "backoff" once the supervisor picks it up).
        if (this.state !== "disposed") this.state = "failed";
        return false;
      });
  }

  private record(kind: McpFailureKind, error: unknown): void {
    this.failure = { kind, detail: error instanceof Error ? error.message : String(error) };
  }

  /** Hand a failure streak back to the supervisor; `false` = the budget is gone. */
  private scheduleRetry(): boolean {
    const armed = this.supervisor.arm(() => {
      if (this.state === "disposed") return;
      void this.attempt().then((ok) => {
        if (!ok) this.scheduleRetry();
      });
    });
    // "backoff" is the observable form of "a retry exists"; without the budget
    // left the state stays "failed" and the status row says so.
    if (armed) this.state = "backoff";
    return armed;
  }

  connect(): Promise<boolean> {
    if (this.state === "disposed") return Promise.resolve(false);
    if (this.inFlight !== null) return this.inFlight;
    if (this.state === "ready") return Promise.resolve(true);
    this.supervisor.begin();
    this.inFlight = this.attempt()
      .then((ok) => {
        this.inFlight = null;
        if (!ok) this.scheduleRetry();
        return ok;
      })
      .catch(() => {
        this.inFlight = null;
        return false;
      });
    return this.inFlight;
  }

  /**
   * One bounded re-connect attempt, used after an observed disconnect.
   *
   * A failure here hands the server back to the supervisor rather than leaving it
   * dead: a call-time reconnect that fails is still a failure streak.
   */
  reconnectOnce(): Promise<boolean> {
    if (this.state === "disposed") return Promise.resolve(false);
    if (this.state === "ready") return Promise.resolve(true);
    this.supervisor.cancel();
    return this.attempt().then((ok) => {
      if (!ok && this.state !== "disposed") this.scheduleRetry();
      return ok;
    });
  }

  markLost(): void {
    if (this.state === "disposed" || this.state === "failed") return;
    this.transport = null;
    this.client = null;
    this.state = "failed";
    this.failure = { kind: "not_ready", detail: "transport lost" };
    this.scheduleRetry();
  }

  async refresh(): Promise<boolean> {
    if (this.client === null) return false;
    try {
      this.lastTools = await this.client.listTools(boundedSignal(this.config.timeoutMs).signal);
      this.failure = null;
      return true;
    } catch (error) {
      // The previous generation stays: a server that flaps must not blank the face.
      this.record(classifyError(error), error);
      return false;
    }
  }

  async call(tool: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    if (this.client === null) throw new McpError("not_ready", this.config.name, "no live client");
    try {
      return await this.client.callTool(tool, args, boundedSignal(this.config.timeoutMs, signal).signal);
    } catch (error) {
      throw new McpError(classifyError(error), this.config.name, error instanceof Error ? error.message : String(error));
    }
  }

  private async closeTransport(): Promise<void> {
    const open = this.transport;
    this.transport = null;
    this.client = null;
    if (open === null) return;
    // The repo's ONE deadline primitive lives in core (W2014). packages/mcp is L1
    // and may not import packages/tools, so core is the only legal home for it —
    // hence the throw policy is used directly rather than re-wrapped.
    await bounded(open.close(), this.deps.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS, {
      mode: "throw",
      error: () => new McpError("disposed", this.config.name, "close deadline exceeded; stopping is fail-closed"),
    });
  }

  async dispose(): Promise<void> {
    if (this.state === "disposed") return;
    this.state = "disposed";
    this.supervisor.cancel();
    try {
      await this.closeTransport();
    } catch (error) {
      // Fail-closed and honest: the deadline was missed, so say so on the status
      // row instead of throwing at the disposal chain.
      this.record("timeout", error);
    }
  }

  tools(): readonly McpRemoteTool[] {
    return this.lastTools;
  }

  status(): McpServerStatus {
    return {
      server: this.config.name,
      transport: this.config.transport,
      state: this.state,
      toolCount: this.lastTools.length,
      ...(this.failure === null ? {} : { failureKind: this.failure.kind, failureDetail: this.failure.detail }),
    };
  }
}

/** The public seam: one connection per server per generation. */
export function createServerConnection(server: McpServerConfig, deps: ConnectionDeps): ServerConnection {
  return new ServerConnectionImpl(server, deps);
}