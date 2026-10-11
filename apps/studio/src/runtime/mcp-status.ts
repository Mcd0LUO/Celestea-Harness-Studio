/**
 * W-C1b · the MCP status holder behind the `GET /api/plugins` row
 * (docs/feature/mcp-client.md §6.3).
 *
 * ## Why the state lives here and not in the catalog
 *
 * `pluginCatalog()` is a PURE projection of "what this host mounts" — that is
 * what makes the inventory test in `plugins-inventory.test.ts` an anti-drift
 * assertion rather than a snapshot. Connection state is the opposite: it is
 * LIVE, per session generation, and it changes while the catalog does not.
 *
 * So the two meet at exactly one place: the catalog row takes an optional
 * status VIEW as an argument, and this module owns the live value. One
 * construction, two readers — the same invariant the catalog already keeps with
 * its host names.
 *
 * ## What is deliberately absent
 *
 * `env` and `headers` never reach a status row (§7.2). The rows carry the
 * server name, the transport, the connection state, the tool count and the
 * FAILURE KIND — an enum, never a branch on message text (§6.3).
 */

import type { McpIssue } from "@celestea/mcp";

/** One server's live row, tagged with the session generation that owns it. */
export interface McpServerRow {
  readonly server: string;
  /** `null` = the detached generation (no addressable session id). */
  readonly session: string | null;
  readonly transport: string;
  readonly state: string;
  readonly toolCount: number;
  readonly failureKind?: string;
  readonly failureDetail?: string;
}

/** The aggregate the plugin row carries. One row is a NAMES list + two totals. */
export interface McpCatalogStatus {
  /** Generations currently reporting MCP (a plugin row is process-level). */
  readonly sessions: number;
  readonly servers: number;
  readonly tools: number;
  /** The WORST state across every reported server (never an optimistic one). */
  readonly state: string;
  /** A config that could not be read, with the file path (§4.3 loud failure). */
  readonly error: string | null;
  readonly rows: readonly McpServerRow[];
  /** Skipped / refused configuration entries (never swallowed, §4.3). */
  readonly issues: readonly { readonly kind: string; readonly server?: string; readonly message: string }[];
}

/** Connection states ordered by how alarming they are; the row takes the worst. */
const STATE_SEVERITY: Readonly<Record<string, number>> = {
  ready: 0,
  idle: 1,
  connecting: 2,
  backoff: 3,
  failed: 4,
  disposed: 5,
};

const entries = new Map<string, McpCatalogStatus>();

/**
 * Publish (or, with `null`, withdraw) one generation's live status.
 *
 * `null` is the WITHDRAWAL, not "nothing to say": a released generation must
 * stop being counted, otherwise the row would keep reporting tools that no
 * longer exist (§5.4's "a face that lies" argument, applied to the status).
 */
export function publishMcpStatus(sessionKey: string, status: McpCatalogStatus | null): void {
  if (status === null) entries.delete(sessionKey);
  else entries.set(sessionKey, status);
}

/** The process-wide aggregate, or `null` when nothing reports (zero MCP). */
export function mcpCatalogStatus(): McpCatalogStatus | null {
  if (entries.size === 0) return null;
  const rows: McpServerRow[] = [];
  const issues: { kind: string; server?: string; message: string }[] = [];
  let tools = 0;
  let worst = "ready";
  let error: string | null = null;
  for (const status of entries.values()) {
    rows.push(...status.rows);
    issues.push(...status.issues);
    tools += status.tools;
    if (severityOf(status.state) > severityOf(worst)) worst = status.state;
    error ??= status.error;
  }
  rows.sort(byServerThenSession);
  return { sessions: entries.size, servers: rows.length, tools, state: worst, error, rows, issues };
}

/** Unknown states rank as "failed": a status nobody recognises is never optimistic. */
function severityOf(state: string): number {
  return STATE_SEVERITY[state] ?? 99;
}

/** Server name, then the owning session (null sorts first, deterministically). */
function byServerThenSession(a: McpServerRow, b: McpServerRow): number {
  if (a.server !== b.server) return a.server < b.server ? -1 : 1;
  const left = a.session ?? "";
  const right = b.session ?? "";
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Drop every generation's status (test isolation; never called in production). */
export function resetMcpStatus(): void {
  entries.clear();
}

/** Project `@celestea/mcp`'s issues into the row's wire shape (no secrets). */
export function issueRows(issues: readonly McpIssue[]): { kind: string; server?: string; message: string }[] {
  return issues.map((issue) => ({
    kind: issue.kind,
    ...(issue.server === undefined ? {} : { server: issue.server }),
    message: issue.message,
  }));
}
