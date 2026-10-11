/**
 * The `McpTransport` seam: everything the connection manager needs from a
 * protocol client, and nothing else (docs/feature/mcp-client.md D2 — the official
 * SDK sits BEHIND this seam, in sdk-transport.ts).
 *
 * Why a seam at all: connection lifecycle, backoff and tool adaptation are the
 * parts with real semantics, and they must be testable without spawning a process
 * or opening a socket (ARCHITECTURE.md §6.4.5). The SDK is only "which bytes go
 * over the wire".
 */

import type { McpCallResult, McpRemoteTool, McpServerConfig } from "./types.js";

/** A connected MCP client, as the rest of this package sees it. */
export interface McpClient {
  /** `tools/list` (paginated by the caller). Rejects on protocol failure. */
  listTools(signal?: AbortSignal): Promise<readonly McpRemoteTool[]>;
  /** `tools/call`. The caller owns cancellation and the per-call timeout. */
  callTool(tool: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult>;
  /** Idempotent teardown of the client half (not of the process/stream). */
  close(): Promise<void>;
}

/** One connection attempt's worth of protocol plumbing. */
export interface McpTransport {
  /** Open the transport and complete `initialize`. Rejects on failure. */
  connect(): Promise<McpClient>;
  /**
   * Tear down the transport: close the stream, then reap the child process.
   * MUST be idempotent and bounded — two overlapping processes are worse than a
   * stopped one (docs/feature/mcp-client.md §6.2).
   */
  close(): Promise<void>;
}

export type McpTransportFactory = (server: McpServerConfig) => McpTransport;

/**
 * Environment variables that must NOT reach a third-party stdio server.
 *
 * Both rules come from the same threat: a server this repository spawns would
 * otherwise inherit every credential on the machine. `KEY|PASSWORD|SECRET|TOKEN`
 * is the SHAPE test, the two prefixes are the PROJECT test.
 */
const CREDENTIAL_ENV = /(KEY|PASSWORD|SECRET|TOKEN)/i;
const RESERVED_ENV_PREFIXES = ["CELESTEA_", "DSH_"] as const;

/** The parent environment, scrubbed. Exported so the rule is testable on its own. */
export function scrubbedParentEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (CREDENTIAL_ENV.test(key)) continue;
    if (RESERVED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    out[key] = value;
  }
  return out;
}

/**
 * The child environment: SCRUBBED parent first, explicit config second.
 *
 * Order matters and is not negotiable: the explicit values are the operator's
 * decision and must win; everything else is the leak surface.
 */
export function childEnvironment(
  parent: Readonly<Record<string, string | undefined>>,
  configured: Readonly<Record<string, string>>,
): Record<string, string> {
  return { ...scrubbedParentEnv(parent), ...configured };
}

/** A signal that aborts on timeout OR on the caller's cancellation. */
export interface BoundedSignal {
  readonly signal: AbortSignal;
}

/**
 * Combine the caller's signal with the per-call budget.
 *
 * Cancellation is not optional plumbing: docs/feature/mcp-client.md §6.2 requires
 * the tool input's `signal` to reach the MCP request so a cancelled turn does not
 * leave a half-finished side effect behind on the server.
 */
export function boundedSignal(timeoutMs: number, parent?: AbortSignal): BoundedSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return { signal: parent === undefined ? timeout : AbortSignal.any([parent, timeout]) };
}
