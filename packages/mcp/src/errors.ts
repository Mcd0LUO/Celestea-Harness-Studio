/**
 * Errors for `@celestea/mcp`.
 *
 * Two kinds, deliberately separated:
 *   - `McpConfigError` is FATAL: the operator's file could not be read as a
 *     whole (malformed JSON, a same-scope duplicate server). We refuse rather
 *     than continue with a partial view, because silently dropping half a file
 *     turns "I configured three servers" into "two servers, no explanation".
 *   - `McpError` is per-server: one bad entry must not take the others down
 *     (docs/feature/mcp-client.md §6.2 failure isolation).
 *
 * Both carry a machine-readable `kind`; nothing in this package branches on
 * message text (ARCHITECTURE.md §6.2.2 / §6.5.4).
 */

import type { McpFailureKind, McpIssueKind } from "./types.js";

/** Fatal: the configuration FILE is unusable. Startup of this generation fails. */
export class McpConfigError extends Error {
  /** The file we were reading — the message always points at it. */
  readonly source: string;
  readonly kind: McpIssueKind;

  constructor(kind: McpIssueKind, source: string, detail: string) {
    super(`mcp.json '${source}' ${detail}`);
    this.name = "McpConfigError";
    this.kind = kind;
    this.source = source;
  }
}

/** Per-server failure (connect / discovery / call). Isolated by design. */
export class McpError extends Error {
  readonly kind: McpFailureKind;
  readonly server: string;

  constructor(kind: McpFailureKind, server: string, detail: string, options?: { cause?: unknown }) {
    super(`mcp server '${server}': ${detail}`, options);
    this.name = "McpError";
    this.kind = kind;
    this.server = server;
  }
}

/**
 * Best-effort classification of an unknown thrown value, used ONLY to fill a
 * status line (never to decide control flow).
 *
 * Why not `err.message.includes(...)`: ARCHITECTURE.md §6.5.4 forbids deciding
 * behaviour from wording, and both reference implementations were bitten by it.
 * We classify on structurally observable values only (`name` / `code` fields
 * the SDK and Node set) and degrade everything else to `connect_failed`.
 */
export function classifyError(error: unknown): McpFailureKind {
  if (typeof error !== "object" || error === null) return "connect_failed";
  const name = "name" in error ? String((error as { name?: unknown }).name) : "";
  const code = "code" in error ? String((error as { code?: unknown }).code) : "";
  if (name === "TimeoutError" || code === "ETIMEDOUT" || code === "UND_ERR_HEADERS_TIMEOUT") return "timeout";
  if (name === "McpError" || name === "ZodError") return "protocol_incompatible";
  return "connect_failed";
}
