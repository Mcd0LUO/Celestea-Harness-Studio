/**
 * Types and frozen constants for `@celestea/mcp` (MCP client, P0 slice).
 *
 * Every default in `MCP_DEFAULTS` is a MIRROR of the `default` keywords in
 * `contracts/data-files/mcp.schema.json`. The schema is the field source of
 * truth; this file is its runtime form, and `schema-parity.test.ts` fails if the
 * two ever drift (a default that exists only in the TS would silently become
 * "the contract is wrong").
 *
 * Names of the tool surface follow docs/feature/mcp-client.md §5: the
 * model-visible name is `mcp__<server>__<tool>`, the raw descriptor name never
 * leaves the status/log surface.
 */

import type { ToolSpec } from "@celestea/core";

/** Server names are stricter than tool names: they become the tool-name prefix. */
export const MCP_SERVER_NAME_PATTERN = "^[a-z0-9][a-z0-9_-]{0,31}$";

/** The model-visible namespace prefix. Reserved: no contract tool may use it. */
export const MCP_TOOL_PREFIX = "mcp__";
/** Model-visible name budget (OpenAI-compatible tool name limit). */
export const MCP_TOOL_NAME_MAX = 64;
/** sha256 suffix length used when sanitisation changed an identifier. */
export const MCP_HASH_LEN = 12;
/** Per-segment cap before the whole name is truncated to MCP_TOOL_NAME_MAX. */
export const MCP_SEGMENT_MAX = 24;



/** P0 transports. Streamable HTTP is spelled `http` in the config file. */
export const MCP_TRANSPORTS = ["stdio", "http"] as const;
export type McpTransportKind = (typeof MCP_TRANSPORTS)[number];

/** `ask` is the default; `never` is the explicit unattended opt-out. */
export const MCP_APPROVALS = ["ask", "never"] as const;
export type McpApproval = (typeof MCP_APPROVALS)[number];

/** Declares a server's REAL path semantics; MCP tools land on the `write` floor. */
export const MCP_PATH_ACCESS = ["read", "write", "self"] as const;
export type McpPathAccess = (typeof MCP_PATH_ACCESS)[number];

/**
 * Failure taxonomy. Callers branch on `kind`, NEVER on message text
 * (docs/feature/mcp-client.md §6.3: the reference implementations got this wrong
 * by matching on wording, and wording is ours to change).
 */
export const MCP_FAILURE_KINDS = [
  "connect_failed",
  "protocol_incompatible",
  "unauthorized",
  "timeout",
  "server_error",
  "schema_unsupported",
  "not_ready",
  "call_failed",
  "disposed",
] as const;
export type McpFailureKind = (typeof MCP_FAILURE_KINDS)[number];

/** Why a configured server was skipped, or why its tools were refused. */
export const MCP_ISSUE_KINDS = [
  "duplicate_server",
  "invalid_entry",
  "unknown_reference",
  "command_missing",
  "schema_unsupported",
  "duplicate_tools",
] as const;
export type McpIssueKind = (typeof MCP_ISSUE_KINDS)[number];

export interface McpReconnectPolicy {
  readonly enabled: boolean;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  /** Shared budget for one failure streak; see the schema for the reset rule. */
  readonly maxAttempts: number;
}

/** The schema `default`s, mirrored. Never invent a number that lives only here. */
export const MCP_DEFAULTS = {
  transport: "stdio",
  enabled: true,
  approval: "ask",
  pathAccess: "write",
  timeoutMs: 60_000,
  reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
} as const satisfies {
  readonly transport: McpTransportKind;
  readonly enabled: boolean;
  readonly approval: McpApproval;
  readonly pathAccess: McpPathAccess;
  readonly timeoutMs: number;
  readonly reconnect: McpReconnectPolicy;
};

/** One server entry AFTER validation, reference resolution and defaults. */
export interface McpServerConfig {
  readonly name: string;
  readonly transport: McpTransportKind;
  readonly enabled: boolean;
  readonly approval: McpApproval;
  /** Per-tool override of `approval`, keyed by the server's OWN tool name. */
  readonly toolApproval: Readonly<Record<string, McpApproval>>;
  readonly timeoutMs: number;
  readonly toolAllow: readonly string[];
  readonly toolDeny: readonly string[];
  readonly pathAccess: McpPathAccess;
  readonly reconnect: McpReconnectPolicy;
  /** stdio only. */
  readonly command?: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** stdio only. Values are ALREADY resolved from `$VAR` references. */
  readonly env: Readonly<Record<string, string>>;
  /** http only. Operator configuration; never derived from model output. */
  readonly url?: string;
  /** http only. Values are ALREADY resolved; never echoed to a response or log. */
  readonly headers: Readonly<Record<string, string>>;
  readonly scope: McpScope;
  /** The file this entry came from (status surface only, never a secret). */
  readonly source: string;
  /**
   * The document entry VERBATIM, `$VAR` references included.
   *
   * Kept so the contract's "read → write → re-read" round-trip is faithful AND so
   * the serialiser can never be handed a resolved credential: what we write back is
   * what the operator wrote, not what the environment happened to hold.
   */
  readonly raw: Readonly<Record<string, unknown>>;
}

export const MCP_SCOPES = ["global", "workspace"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** A skipped entry or a refused tool. Reported, never swallowed. */
export interface McpIssue {
  readonly kind: McpIssueKind;
  readonly server?: string;
  readonly source: string;
  readonly message: string;
}

export interface McpConfigResult {
  /** Merged, valid, enabled-agnostic server map (insertion order = scope order). */
  readonly servers: ReadonlyMap<string, McpServerConfig>;
  readonly issues: readonly McpIssue[];
  /** The files that were actually read (absent ones are simply not here). */
  readonly sources: readonly string[];
}

/** One tool as the REMOTE server describes it (raw MCP shape, not adapted yet). */
export interface McpRemoteTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

/** One tool content part. `text` is all P0 renders; the rest are diagnosed. */
export interface McpContentPart {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** The canonical MCP result of one `tools/call`, kept as-is (no translation layer). */
export interface McpCallResult {
  readonly content: readonly McpContentPart[];
  readonly isError?: boolean;
  readonly [key: string]: unknown;
}

/**
 * The model-visible spec plus its MCP provenance. The provenance is what makes
 * "non-contract tools must be `mcp__*`" a rule instead of a whitelist
 * (docs/feature/mcp-client.md §5.2).
 */
export interface McpToolSpec extends ToolSpec {
  readonly mcp: { readonly server: string; readonly tool: string };
}

/** Structured call outcome. Errors are FIELDS here, never thrown text. */
export interface McpCallOutcome {
  readonly ok: boolean;
  readonly server: string;
  readonly tool: string;
  readonly text: string;
  readonly content?: readonly McpContentPart[];
  readonly failureKind?: McpFailureKind;
}

export const MCP_CONNECTION_STATES = ["idle", "connecting", "ready", "backoff", "failed", "disposed"] as const;
export type McpConnectionState = (typeof MCP_CONNECTION_STATES)[number];

/**
 * The per-server status surface (a FIELD on the existing plugin row, not a new
 * endpoint). It deliberately carries NO `env` / `headers`: docs §6.3/§7.2.
 */
export interface McpServerStatus {
  readonly server: string;
  readonly transport: McpTransportKind;
  readonly state: McpConnectionState;
  readonly toolCount: number;
  readonly failureKind?: McpFailureKind;
  readonly failureDetail?: string;
}
