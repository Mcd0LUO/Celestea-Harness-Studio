/**
 * One SESSION GENERATION of MCP (docs/feature/mcp-client.md §6.1/§6.2, decision D7).
 *
 * The generation is the unit: `createMcpSession()` builds it, `dispose()` tears the
 * whole thing down, and a re-assembly builds a NEW one from (possibly new)
 * configuration. Nothing survives the generation — that is what keeps a
 * permission level or a credential from leaking into the next session, and it is
 * also why the config is read only at generation time instead of on a watcher.
 *
 * Failure isolation is structural: every server gets its own connection object and
 * its own supervisor, so one that cannot connect costs nothing but its own tools.
 */

import { createServerConnection, type ConnectionDeps } from "./connection.js";
import type { Scheduler } from "./scheduler.js";
import { adaptTools, renderCallText, sortToolsForDisclosure, type McpAdaptedTool } from "./tools.js";
import type { McpTransportFactory } from "./transport.js";
import { createDisposableScope } from "./resources.js";
import type { McpCallOutcome, McpConfigResult, McpIssue, McpServerConfig, McpServerStatus } from "./types.js";

export interface McpSessionOptions {
  readonly config: McpConfigResult;
  readonly transportFactory: McpTransportFactory;
  readonly scheduler?: Scheduler;
  readonly now?: () => number;
  readonly closeTimeoutMs?: number;
  /** Where teardown failures go (status surface / diagnostics; never thrown). */
  readonly onTeardownError?: (error: unknown) => void;
}

export interface McpSession {
  /**
   * Connect every ENABLED server. Never rejects: a server that fails to connect
   * leaves its own status row in `failed` and the others proceed.
   */
  start(): Promise<void>;
  /** The model-visible tool surface, in the stable disclosure order. */
  bindings(): readonly McpAdaptedTool[];
  /** Dispatch by model-visible name. Errors are returned, never thrown. */
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallOutcome>;
  statuses(): readonly McpServerStatus[];
  issues(): readonly McpIssue[];
  /** Re-discover one server's tools (failure keeps the previous generation). */
  refresh(server: string): Promise<boolean>;
  /** Release every connection. Idempotent; never throws. */
  dispose(): Promise<void>;
}

interface Entry {
  readonly config: McpServerConfig;
  readonly connection: ReturnType<typeof createServerConnection>;
  tools: readonly McpAdaptedTool[];
}

function refusal(server: string, tool: string, kind: McpCallOutcome["failureKind"], message: string): McpCallOutcome {
  return { ok: false, server, tool, text: message, failureKind: kind };
}

export function createMcpSession(options: McpSessionOptions): McpSession {
  const scope = createDisposableScope({ onError: options.onTeardownError });
  const deps: ConnectionDeps = {
    transportFactory: options.transportFactory,
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
  };

  const entries = new Map<string, Entry>();
  // A disabled server still gets a status row (state "idle"): silently omitting it
  // would look like the configuration was lost.
  for (const config of options.config.servers.values()) {
    const connection = createServerConnection(config, deps);
    entries.set(config.name, { config, connection, tools: [] });
    scope.add(() => connection.dispose());
  }

  async function discover(entry: Entry): Promise<void> {
    const adapted = adaptTools(entry.config, entry.connection.tools());
    entry.tools = sortToolsForDisclosure(adapted.tools);
  }

  async function startOne(entry: Entry): Promise<void> {
    if (!entry.config.enabled) return;
    if (!(await entry.connection.connect())) return;
    await entry.connection.refresh();
    await discover(entry);
  }

  function findBinding(name: string): { entry: Entry; tool: McpAdaptedTool } | undefined {
    for (const entry of entries.values()) {
      const tool = entry.tools.find((t) => t.spec.name === name);
      if (tool !== undefined) return { entry, tool };
    }
    return undefined;
  }

  async function callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallOutcome> {
    const found = findBinding(name);
    if (found === undefined) {
      return refusal("", name, "call_failed", `unknown MCP tool '${name}'`);
    }
    const { entry, tool } = found;
    if (entry.connection.status().state !== "ready") {
      // A disconnect that can heal itself should not be the model's problem.
      await entry.connection.reconnectOnce();
    }
    if (entry.connection.status().state !== "ready") {
      return refusal(entry.config.name, tool.tool, "not_ready", `mcp_not_ready: server=${entry.config.name}`);
    }
    try {
      const result = await entry.connection.call(tool.tool, args, signal);
      return {
        ok: result.isError !== true,
        server: entry.config.name,
        tool: tool.tool,
        text: renderCallText(result),
        content: result.content,
      };
    } catch (error) {
      const kind = (error as { kind?: McpCallOutcome["failureKind"] }).kind ?? "call_failed";
      // A call that cannot reach the server means the connection is gone: record
      // that, so the NEXT dispatch re-connects once instead of failing forever
      // (docs/feature/mcp-client.md §6.2).
      if (kind === "not_ready" || kind === "connect_failed") entry.connection.markLost();
      return refusal(entry.config.name, tool.tool, kind, error instanceof Error ? error.message : String(error));
    }
  }

  return {
    async start(): Promise<void> {
      const starts = [...entries.values()].map((entry) => startOne(entry));
      await Promise.allSettled(starts);
    },
    bindings(): readonly McpAdaptedTool[] {
      const all: McpAdaptedTool[] = [];
      for (const entry of entries.values()) all.push(...entry.tools);
      return sortToolsForDisclosure(all);
    },
    callTool,
    statuses(): readonly McpServerStatus[] {
      return [...entries.values()]
        .map((entry) => entry.connection.status())
        .sort((a, b) => (a.server < b.server ? -1 : a.server > b.server ? 1 : 0));
    },
    issues(): readonly McpIssue[] {
      return options.config.issues;
    },
    async refresh(server: string): Promise<boolean> {
      const entry = entries.get(server);
      if (entry === undefined) return false;
      const ok = await entry.connection.refresh();
      if (ok) await discover(entry);
      return ok;
    },
    dispose(): Promise<void> {
      return scope.dispose();
    },
  };
}
