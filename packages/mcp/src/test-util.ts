/**
 * Test doubles for the `McpTransport` seam.
 *
 * The whole point of the seam (transport.ts): connection lifecycle, backoff,
 * adaptation and dispatch can be tested with NO process and NO socket. Anything
 * that needs the real SDK lives in sdk-transport.ts and is exercised against a
 * live server, not by these tests.
 *
 * Excluded from the published build (tsconfig.build.json) — production code must
 * never be able to import a fake.
 */

import type { Scheduler } from "./scheduler.js";
import type { McpCallResult, McpRemoteTool, McpServerConfig } from "./types.js";
import type { McpClient, McpTransport, McpTransportFactory } from "./transport.js";

export interface FakeServerScript {
  readonly tools?: readonly McpRemoteTool[];
  /** Reject this many connect attempts before succeeding (0 = always succeed). */
  readonly failConnectTimes?: number;
  readonly connectError?: Error;
  readonly listError?: Error;
  /** Make `tools/call` throw (a dead pipe, a server that hung up). */
  readonly callError?: Error;
  readonly callResult?: (tool: string, args: unknown) => McpCallResult;
  /** Make `close()` hang forever (exercises the bounded-close deadline). */
  readonly hangOnClose?: boolean;
}

/** The public record of one created transport. */
export interface FakeTransportHandle {
  readonly server: string;
  closed: boolean;
}

export interface FakeTransportLog {
  readonly handles: FakeTransportHandle[];
  readonly connects: string[];
  readonly closes: string[];
  readonly listCalls: string[];
  readonly callCalls: Array<{ server: string; tool: string; args: unknown }>;
}

export interface FakeTransportFactory {
  readonly factory: McpTransportFactory;
  readonly log: FakeTransportLog;
  /** The Nth transport created for a server (1-based), or undefined. */
  handleOf(server: string, nth?: number): FakeTransportHandle | undefined;
  /** Make the server's NEXT connect attempt fail ("it worked, then it broke"). */
  setFailNext(server: string): void;
}

class FakeClient implements McpClient {
  constructor(private readonly owner: FakeTransport, private readonly server: McpServerConfig) {}

  async listTools(): Promise<readonly McpRemoteTool[]> {
    this.owner.log.listCalls.push(this.server.name);
    if (this.owner.script.listError !== undefined) throw this.owner.script.listError;
    return this.owner.script.tools ?? [];
  }

  async callTool(tool: string, args: unknown): Promise<McpCallResult> {
    this.owner.log.callCalls.push({ server: this.server.name, tool, args });
    if (this.owner.script.callError !== undefined) throw this.owner.script.callError;
    if (this.owner.script.callResult !== undefined) return this.owner.script.callResult(tool, args);
    return { content: [{ type: "text", text: `${this.server.name}.${tool} ok` }] };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeTransport implements McpTransport {
  readonly handle: FakeTransportHandle;

  constructor(
    readonly server: McpServerConfig,
    readonly script: FakeServerScript,
    readonly log: FakeTransportLog,
    private readonly remainingFailures: { count: number },
  ) {
    this.handle = { server: server.name, closed: false };
  }

  connect(): Promise<McpClient> {
    this.log.connects.push(this.server.name);
    if (this.remainingFailures.count > 0) {
      this.remainingFailures.count--;
      return Promise.reject(this.script.connectError ?? new Error("connect refused"));
    }
    return Promise.resolve(new FakeClient(this, this.server));
  }

  close(): Promise<void> {
    this.log.closes.push(this.server.name);
    this.handle.closed = true;
    if (this.script.hangOnClose === true) return new Promise<void>(() => undefined);
    return Promise.resolve();
  }
}

function factoryFor(scriptOf: (server: McpServerConfig) => FakeServerScript): FakeTransportFactory {
  const log: FakeTransportLog = { handles: [], connects: [], closes: [], listCalls: [], callCalls: [] };
  const budgets = new Map<string, { count: number }>();
  const armNext = new Set<string>();
  const factory: McpTransportFactory = (server: McpServerConfig): McpTransport => {
    const script = scriptOf(server);
    let budget = budgets.get(server.name);
    if (budget === undefined) {
      budget = { count: script.failConnectTimes ?? 0 };
      budgets.set(server.name, budget);
    }
    if (armNext.has(server.name)) {
      armNext.delete(server.name);
      budget.count++;
    }
    const transport = new FakeTransport(server, script, log, budget);
    log.handles.push(transport.handle);
    return transport;
  };
  return {
    factory,
    log,
    handleOf: (server, nth = 1) => log.handles.filter((h) => h.server === server)[nth - 1],
    setFailNext: (server: string) => {
      armNext.add(server);
    },
  };
}

/** A transport factory whose every server follows the same script. */
export function fakeTransportFactory(script: FakeServerScript = {}): FakeTransportFactory {
  return factoryFor(() => script);
}

/** Per-server scripts (each server behaves differently inside one session). */
export function scriptedTransportFactory(scripts: Readonly<Record<string, FakeServerScript>>): FakeTransportFactory {
  return factoryFor((server) => scripts[server.name] ?? {});
}

/** A scheduler that runs nothing until the test says so, and records every delay. */
export interface ManualScheduler {
  readonly scheduler: Scheduler;
  readonly delays: number[];
  /** Fire the oldest still-pending timer. */
  runNext(): void;
  pending(): number;
}

export function manualScheduler(): ManualScheduler {
  const delays: number[] = [];
  const queue: Array<{ fn: () => void; cancelled: boolean }> = [];
  return {
    scheduler: {
      schedule(fn, delayMs) {
        delays.push(delayMs);
        const entry = { fn, cancelled: false };
        queue.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
    },
    delays,
    runNext(): void {
      const entry = queue.find((e) => !e.cancelled);
      if (entry === undefined) return;
      entry.cancelled = true;
      entry.fn();
    },
    pending: () => queue.filter((e) => !e.cancelled).length,
  };
}
