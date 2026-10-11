/**
 * W-C1b · the MCP assembly for one session generation
 * (docs/feature/mcp-client.md §3, §5, §6.1, §7.1).
 *
 * ## Why this is a separate module from `engine-plugins.ts`
 *
 * `engineTools()` is SYNCHRONOUS — it builds the registry, the exposure face
 * and the disclosure universe in one pass — while an MCP connection is not: the
 * tool NAMES do not exist until `initialize` + `tools/list` have answered
 * (§6.1: "connect asynchronously, never block the first turn"). The two facts
 * meet here, in a small object the composition owns:
 *
 *   1. the session is created and started without blocking `compose()`;
 *   2. when discovery has landed, `publish()` registers the adapted tools into
 *      the registry the assembly already built — at a TURN BOUNDARY, because
 *      `DisclosurePolicy`'s third invariant is "only a turn boundary changes
 *      the set" (§5.4). The face then appends them at the TAIL
 *      (`ExposedRegistry.stableProjection`), which is the append-only shape
 *      the cache depends on;
 *   3. the approval rules and the `path_access` declarations are filled into
 *      the SAME two maps the guard and the path guard already hold, so they take
 *      effect on the very first call without a second registration;
 *   4. `dispose()` releases every connection, and the composition hangs it off
 *      the generation's shutdown hooks (D7: one generation, one lifetime).
 *
 * ## What "no MCP configured" means here
 *
 * An absent `mcp.json`, an empty `servers` map and an all-`enabled: false`
 * document all produce ZERO tools, ZERO guards and a `null` status — the
 * assembly registers nothing, so the generation is byte-identical to a host that
 * has never heard of MCP. `engine-mcp.test.ts` asserts that against the same
 * chain it uses for the enabled case.
 */

import { join } from "node:path";

import { celesteaHome, workspaceHome } from "@celestea/core";
import {
  createMcpSession,
  loadMcpConfig,
  mcpTool,
  sdkTransportFactory,
  type McpAdaptedTool,
  type McpConfigResult,
  type McpSession,
  type McpTransportFactory,
  type Scheduler,
} from "@celestea/mcp";
import { McpApprovalGuard, type McpApprovalRule, type PathAccess } from "@celestea/tools";
import type { Tool, ToolRegistry, UserQuestionService } from "@celestea/core";

import { issueRows, publishMcpStatus, type McpCatalogStatus, type McpServerRow } from "./mcp-status.js";

/** `mcp.json` file name in both scopes (§4.2). */
const MCP_FILE = "mcp.json";

/** The assembled MCP layer of ONE generation (`null` = no MCP at all). */
export interface McpEngine {
  /**
   * At least one ENABLED server is configured — the mounting predicate for
   * everything this generation adds (the approval guard, the status row, the
   * tail-appended tools). `false` is the ZERO-MCP regression: an absent file, an
   * empty `servers` map and an all-`enabled: false` document all land here, and
   * the assembly then adds nothing at all.
   */
  readonly active: boolean;
  /** Model-visible name -> approval declaration; filled when discovery lands. */
  readonly rules: Map<string, McpApprovalRule>;
  /** Model-visible name -> declared path semantics; filled with the rules. */
  readonly pathAccess: Map<string, PathAccess>;
  /** Begin connecting (idempotent, never rejects). Called at mount. */
  start(): Promise<void>;
  /** Register the discovered tools + refresh the status. Turn-boundary only. */
  publish(registry: ToolRegistry): void;
  status(): McpCatalogStatus | null;
  /**
   * The LIVE per-server tool surface of THIS generation — the manifest the
   * `/mcp:<server>` host lane arbitrates against (mcp-client.md §5.6).
   *
   * It is a PROJECTION of the same `session.bindings()` the registry was fed,
   * never a second read: a second `loadMcpConfig` here would answer "what is
   * configured" from a different moment than the tool face, and the two drifting
   * is exactly the shape the skill lane refuses.
   */
  manifest(): readonly McpManifestServer[];
  /** Release every connection. Idempotent; never throws. */
  dispose(): Promise<void>;
}

export interface McpEngineInput {
  /** Pre-loaded configuration (a host may inject it; tests do). */
  readonly config?: McpConfigResult;
  /** `<CELESTEA_HOME>/mcp.json`; `null` = not consulted. */
  readonly globalPath?: string | null;
  /** `<CELESTEA_HOME>/workspaces/<ws>/mcp.json`; `null` = not consulted. */
  readonly workspacePath?: string | null;
  /** The session's workspace path — the second scope is derived from it. */
  readonly workspace?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  /** Transport seam (tests inject a fake; production is the official SDK). */
  readonly transportFactory?: McpTransportFactory;
  readonly scheduler?: Scheduler;
  readonly now?: () => number;
  /** Status key: the session id, or `null` for the detached generation. */
  readonly sessionKey?: string | null;
}

const EMPTY_CONFIG: McpConfigResult = { servers: new Map(), issues: [], sources: [] };

/**
 * One adapted MCP tool as the `/mcp:` lane sees it: the model-visible name (the
 * only name the model ever sees) plus the server's OWN name, because that is what
 * a human types after the second slash (`/mcp:memory/create_entities`).
 */
export interface McpManifestTool {
  /** Model-visible name (`mcp__<server>__<tool>`). */
  readonly name: string;
  /** The server's own tool name — what `/mcp:<server>/<tool>` carries. */
  readonly tool: string;
  readonly description: string;
  /** The adapted `inputSchema` as-is (schema passthrough, §5.3). */
  readonly schema: unknown;
}

/** One server's row of this generation's manifest, with its live connection state. */
export interface McpManifestServer {
  readonly server: string;
  /** `McpConnectionState` verbatim (`idle` / `connecting` / `ready` / …). */
  readonly state: string;
  /** Discovered tools of THIS generation — empty until discovery lands. */
  readonly tools: readonly McpManifestTool[];
}

export function assembleMcp(input: McpEngineInput): McpEngine {
  const loaded = loadConfigOf(input);
  const session = createMcpSession({
    config: loaded.config,
    // The SDK entry point is a FACTORY OF factories: the parent environment is
    // bound once here, so the scrubbed child environment (§7.4) is decided by
    // this composition rather than by whichever call happens to connect first.
    transportFactory: input.transportFactory ?? sdkTransportFactory(input.env ?? process.env),
    ...(input.scheduler === undefined ? {} : { scheduler: input.scheduler }),
    ...(input.now === undefined ? {} : { now: input.now }),
    onTeardownError: (error) => process.stderr.write(`[celestea-mcp] teardown failed: ${String(error)}\n`),
  });
  const rules = new Map<string, McpApprovalRule>();
  const pathAccess = new Map<string, PathAccess>();
  const key = input.sessionKey ?? "detached";
  const activeCount = enabledCount(loaded.config);
  let published = false;

  /**
   * The declaration maps, filled from the ADAPTED bindings.
   *
   * McpAdaptedTool already carries the per-tool approval and pathAccess (the
   * per-tool override applied over the server declaration, §4.1), so this copies
   * a RESOLVED decision rather than re-deriving one — two derivations of the
   * same rule is how the two drift.
   */
  function fill(bindings: readonly McpAdaptedTool[]): void {
    for (const binding of bindings) {
      rules.set(binding.spec.name, { approval: binding.approval, server: binding.server, tool: binding.tool });
      pathAccess.set(binding.spec.name, binding.pathAccess);
    }
  }

  function status(): McpCatalogStatus | null {
    // A generation with nothing ENABLED reports nothing at all — not even a
    // row of "idle". §4.1: a document whose servers are all off is the same
    // thing as no document, and the plugin row must stay byte-identical to the
    // pre-MCP one in that case (§6.3's "purely additive field" only holds while
    // there is something to say).
    if (activeCount === 0) return null;
    const statuses = session.statuses();
    if (statuses.length === 0) return null;
    const rows: McpServerRow[] = statuses.map((row) => ({
      server: row.server,
      session: input.sessionKey ?? null,
      transport: row.transport,
      state: row.state,
      toolCount: row.toolCount,
      ...(row.failureKind === undefined ? {} : { failureKind: row.failureKind }),
      ...(row.failureDetail === undefined ? {} : { failureDetail: row.failureDetail }),
    }));
    const tools = rows.reduce((sum, row) => sum + row.toolCount, 0);
    return {
      sessions: 1,
      servers: rows.length,
      tools,
      state: aggregateState(rows),
      error: loaded.error,
      rows,
      issues: issueRows([...session.issues(), ...loaded.config.issues]),
    };
  }

  function publishStatus(): void {
    publishMcpStatus(key, status());
  }

  // Lazy + idempotent: the GENERATION boundary is where a connection is born
  // (§6.1) — that is the plugin's mount, not the assembly's constructor — and a
  // second call must never double-connect.
  let ready: Promise<void> | null = null;
  function start(): Promise<void> {
    ready ??= session
      .start()
      .catch(() => undefined)
      .then(() => {
        publishStatus();
      });
    return ready;
  }

  function manifest(): McpManifestServer[] {
    const byServer = new Map<string, McpManifestTool[]>();
    for (const binding of session.bindings()) {
      const list = byServer.get(binding.server) ?? [];
      list.push({
        name: binding.spec.name,
        tool: binding.tool,
        description: binding.spec.description,
        schema: binding.spec.parameters,
      });
      byServer.set(binding.server, list);
    }
    // Statuses are the authority for "is it connected"; a server with tools but
    // no status row cannot happen (both come from the same session), and one
    // WITHOUT tools must still appear — an empty list is what makes the host say
    // "this server exposes nothing" instead of "there is no such server".
    return session.statuses().map((row) => ({
      server: row.server,
      state: row.state,
      tools: byServer.get(row.server) ?? [],
    }));
  }

  return {
    active: activeCount > 0,
    rules,
    pathAccess,
    start,
    publish(registry: ToolRegistry): void {
      // Defensive: publish runs at a turn boundary (after mount), but a caller
      // that publishes first must still get a started generation.
      void start();
      const bindings = session.bindings();
      // Nothing discovered (yet, or because every server failed) = nothing to
      // register. Retrying next boundary is one Map read, and a server that
      // comes up late therefore still lands (§5.4's "keep the face truthful").
      if (bindings.length === 0) return;
      fill(bindings);
      if (published) return;
      published = true;
      for (const tool of mcpTools(bindings, session)) registry.register(tool);
      publishStatus();
    },
    status,
    manifest,
    async dispose(): Promise<void> {
      publishMcpStatus(key, null);
      await session.dispose();
    },
  };
}

/**
 * Build the approval guard for a generation.
 *
 * Called ONCE, after `assembleTools()` has mounted the production guards, which
 * is what places it AFTER `PathGuard` in the chain (registry.ts: guards run in
 * registration order). A generation with no discovered MCP tool gets `null`: a
 * guard that can only ever allow is chain noise, and NOT mounting it is what
 * keeps a zero-MCP guard chain byte-identical.
 */
export function mcpApprovalGuardOf(engine: McpEngine | null, questions: UserQuestionService | null): McpApprovalGuard | null {
  if (engine === null || !engine.active) return null;
  return new McpApprovalGuard({ questions, rules: engine.rules });
}

/** The registry-ready tools of one discovery (bound to this generation). */
function mcpTools(bindings: readonly McpAdaptedTool[], session: McpSession): Tool[] {
  return bindings.map((binding) => mcpTool(binding, { callTool: (name, args, signal) => session.callTool(name, args, signal) }));
}

/** How many configured servers this generation will actually connect. */
function enabledCount(config: McpConfigResult): number {
  let count = 0;
  for (const server of config.servers.values()) if (server.enabled) count++;
  return count;
}

/** The worst state on the row: a row must never read better than reality. */
function aggregateState(rows: readonly McpServerRow[]): string {
  const order = ["ready", "idle", "connecting", "backoff", "failed", "disposed"];
  return rows.reduce((worst, row) => (order.indexOf(row.state) > order.indexOf(worst) ? row.state : worst), "ready");
}

/**
 * The two scopes of §4.2, and the one loud failure that is NOT a crash.
 *
 * A malformed document is a hard failure in the CONFIG layer — `loadMcpConfig`
 * throws with the file path. This assembly catches it because its other duty is
 * to hand a working registry to a live turn: crashing every session over one
 * operator typo would be a worse product than saying so. The reason therefore
 * travels to the status row, where it is the first thing the panel can show
 * (§4.3 "never silent").
 */
function loadConfigOf(input: McpEngineInput): { config: McpConfigResult; error: string | null } {
  if (input.config !== undefined) return { config: input.config, error: null };
  try {
    const env = input.env ?? process.env;
    const workspacePath =
      input.workspacePath !== undefined
        ? input.workspacePath
        : input.workspace === null || input.workspace === undefined
          ? null
          : join(workspaceHome(input.workspace, { env }), MCP_FILE);
    return {
      config: loadMcpConfig({
        globalPath: input.globalPath ?? join(celesteaHome({ env }), MCP_FILE),
        workspacePath,
        env,
      }),
      error: null,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { config: EMPTY_CONFIG, error: `mcp.json is unreadable: ${detail}` };
  }
}
