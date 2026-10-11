/**
 * `mcp.json` loading: read → validate → merge (docs/feature/mcp-client.md §4.2/§4.3).
 *
 * Three rules this module exists to enforce:
 *   1. **Absent file = empty set** (same `open()` semantics as `providers.json`),
 *      **malformed file = hard failure** with the path in the message. We never
 *      write our empty view back over a file we could not read.
 *   2. **Merge is WHOLE-SERVER REPLACEMENT**: a workspace entry replaces the
 *      global entry of the same name outright. Field-level merge would turn
 *      "I turned it off here" into an accident that inherits the global settings.
 *   3. **A failing workspace entry also removes the global entry.** Otherwise a
 *      broken override would silently resurrect what the operator just replaced.
 *
 * Filesystem and environment are injected seams so the merge matrix can be tested
 * without touching a real disk (ARCHITECTURE.md §6.4.5).
 */

import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { McpConfigError } from "./errors.js";
import { findDuplicateKeys } from "./json-keys.js";
import { validateServerEntry } from "./config-validate.js";
import type { McpConfigResult, McpIssue, McpScope, McpServerConfig } from "./types.js";

export interface McpLoadOptions {
  /** `<CELESTEA_HOME>/mcp.json`. `null`/absent = not consulted. */
  readonly globalPath?: string | null;
  /** `<CELESTEA_HOME>/workspaces/<ws>/mcp.json`. `null`/absent = not consulted. */
  readonly workspacePath?: string | null;
  /** The process environment `$VAR` references resolve against. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Read seam: returns `null` for "file not present". */
  readonly readText?: (path: string) => string | null;
  /** Whether a stdio `command` exists (checked, never executed). */
  readonly commandExists?: (command: string) => boolean;
}

function defaultReadText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/**
 * Does the command exist? CHECKED, never executed — P0 never spawns anything at
 * load time, and a stdio server whose command is missing is skipped with a reason
 * rather than failing the whole file.
 */
export function defaultCommandExists(command: string, env: Readonly<Record<string, string | undefined>>): boolean {
  if (command.includes("/") || command.includes("\\")) return existsSync(command);
  const extensions = (env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";").filter((e) => e !== "");
  const names = process.platform === "win32" ? extensions.map((ext) => command + ext) : [command];
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const name of names) {
      if (existsSync(join(dir, name))) return true;
    }
  }
  return false;
}

interface ParsedDocument {
  readonly servers: Record<string, unknown>;
}

function parseDocument(text: string, source: string): ParsedDocument {
  const duplicate = findDuplicateKeys(text).find((d) => d.path.startsWith("servers."));
  if (duplicate !== undefined) {
    throw new McpConfigError(
      "duplicate_server",
      source,
      `declares server '${duplicate.key}' more than once — a same-scope duplicate is a startup error, not 'the later one wins'`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new McpConfigError("invalid_entry", source, `is malformed: ${detail} (the unreadable file is never overwritten)`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new McpConfigError("invalid_entry", source, "must be a JSON object");
  }
  const root = parsed as Record<string, unknown>;
  const unknown = Object.keys(root).filter((k) => k !== "servers");
  if (unknown.length > 0) {
    throw new McpConfigError("invalid_entry", source, `has unknown top-level field(s): ${unknown.sort().join(", ")}`);
  }
  const servers = root["servers"];
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    throw new McpConfigError("invalid_entry", source, "must carry a 'servers' object");
  }
  return { servers: servers as Record<string, unknown> };
}

function loadScope(
  scope: McpScope,
  path: string | null | undefined,
  options: McpLoadOptions,
): { readonly configs: McpServerConfig[]; readonly issues: McpIssue[] } {
  if (path === null || path === undefined) return { configs: [], issues: [] };
  const text = (options.readText ?? defaultReadText)(path);
  if (text === null) return { configs: [], issues: [] };
  const document = parseDocument(text, path);
  const env = options.env ?? process.env;
  const exists = options.commandExists ?? ((command: string) => defaultCommandExists(command, env));
  const configs: McpServerConfig[] = [];
  const issues: McpIssue[] = [];
  for (const [name, raw] of Object.entries(document.servers)) {
    const result = validateServerEntry(name, raw, { scope, source: path, env, commandExists: exists });
    if (result.ok) configs.push(result.config);
    else issues.push(result.issue);
  }
  return { configs, issues };
}

/**
 * Load and merge both scopes.
 *
 * Insertion order is global-then-workspace, which is also the merge order: a later
 * `set` for the same name replaces the entry while KEEPING its original position,
 * so the tool surface order (server name ascending, see tools.ts) stays stable.
 */
export function loadMcpConfig(options: McpLoadOptions = {}): McpConfigResult {
  const global = loadScope("global", options.globalPath, options);
  const workspace = loadScope("workspace", options.workspacePath, options);
  const servers = new Map<string, McpServerConfig>();
  for (const config of global.configs) servers.set(config.name, config);
  for (const config of workspace.configs) servers.set(config.name, config);
  // A broken workspace override must NOT leave the global entry standing.
  for (const issue of workspace.issues) {
    if (issue.server !== undefined) servers.delete(issue.server);
  }
  const sources = [options.globalPath, options.workspacePath].filter((p): p is string => typeof p === "string");
  return { servers, issues: [...global.issues, ...workspace.issues], sources };
}

/**
 * Canonical document text for a set of servers (entries sorted by name, 2-space
 * indent). Entries are written from `config.raw`, i.e. the operator's own text:
 * a resolved credential never reaches the file this way.
 *
 * The engine NEVER writes this file in P0 — it exists so the contract's
 * "read → write → re-read" round-trip is mechanically checkable, and so the
 * settings wave has one serialiser instead of inventing its own.
 */
export function serializeMcpDocument(servers: readonly McpServerConfig[]): string {
  const byName = new Map<string, McpServerConfig>();
  for (const config of servers) byName.set(config.name, config);
  const ordered = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const document = {
    servers: Object.fromEntries(ordered.map((c) => [c.name, { ...c.raw } as Record<string, unknown>])),
  };
  return JSON.stringify(document, null, 2) + "\n";
}