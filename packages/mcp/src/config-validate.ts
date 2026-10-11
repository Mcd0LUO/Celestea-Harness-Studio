/**
 * Per-entry validation for `mcp.json` (the `schema` half of config.ts).
 *
 * Every rule here mirrors `contracts/data-files/mcp.schema.json`: defaults,
 * enums, the `additionalProperties: false` stance, and the two transport
 * cross-field rules (`command/args/env` are stdio-only, `url/headers` are
 * http-only — crossed fields are a CONFIG ERROR, never "ignore the extra").
 *
 * A failed entry is SKIPPED with a reason, not fatal: one unusable server must not
 * cost the operator the other eleven (docs/feature/mcp-client.md §4.3, A10).
 */

import type {
  McpApproval,
  McpIssue,
  McpPathAccess,
  McpReconnectPolicy,
  McpScope,
  McpServerConfig,
  McpTransportKind,
} from "./types.js";
import { MCP_APPROVALS, MCP_DEFAULTS, MCP_PATH_ACCESS, MCP_SERVER_NAME_PATTERN, MCP_TRANSPORTS } from "./types.js";
import { resolveReferenceMap } from "./references.js";

const STDIO_ONLY = ["command", "args", "cwd", "env"] as const;
const HTTP_ONLY = ["url", "headers"] as const;
const RECONNECT_KEYS = ["enabled", "initial_delay_ms", "max_delay_ms", "max_attempts"] as const;

const ALLOWED_KEYS = [
  "transport",
  ...STDIO_ONLY,
  ...HTTP_ONLY,
  "enabled",
  "approval",
  "tool_approval",
  "timeout_ms",
  "tool_allow",
  "tool_deny",
  "path_access",
  "reconnect",
] as const;

export type ServerValidation =
  | { readonly ok: true; readonly config: McpServerConfig }
  | { readonly ok: false; readonly issue: McpIssue };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A tiny typed reader over one raw entry.
 *
 * It COLLECTS problems instead of throwing on the first one, so a single status
 * line can tell the operator everything that is wrong with their entry instead of
 * sending them through a fix-restart loop one mistake at a time.
 */
class EntryReader {
  readonly problems: string[] = [];

  constructor(readonly raw: Record<string, unknown>) {}

  rejectUnknown(allowed: readonly string[]): void {
    for (const key of Object.keys(this.raw)) {
      if (!allowed.includes(key)) this.problems.push(`unknown field '${key}'`);
    }
  }

  string(key: string): string | undefined {
    const value = this.raw[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim() === "") {
      this.problems.push(`'${key}' must be a non-empty string`);
      return undefined;
    }
    return value;
  }

  stringArray(key: string): string[] {
    const value = this.raw[key];
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      this.problems.push(`'${key}' must be an array of strings`);
      return [];
    }
    return value as string[];
  }

  bool(key: string, dflt: boolean): boolean {
    const value = this.raw[key];
    if (value === undefined) return dflt;
    if (typeof value !== "boolean") {
      this.problems.push(`'${key}' must be a boolean`);
      return dflt;
    }
    return value;
  }

  positiveInt(key: string, dflt: number): number {
    const value = this.raw[key];
    if (value === undefined) return dflt;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      this.problems.push(`'${key}' must be a positive integer`);
      return dflt;
    }
    return value;
  }

  enum<T extends string>(key: string, allowed: readonly T[], dflt: T): T {
    const value = this.raw[key];
    if (value === undefined) return dflt;
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
      this.problems.push(`'${key}' must be one of ${allowed.join(" | ")}`);
      return dflt;
    }
    return value as T;
  }

  /** Merge the `reconnect` sub-object over the defaults, field by field. */
  reconnect(policy: McpReconnectPolicy): McpReconnectPolicy {
    const value = this.raw["reconnect"];
    if (value === undefined) return policy;
    if (!isRecord(value)) {
      this.problems.push("'reconnect' must be an object");
      return policy;
    }
    const inner = new EntryReader(value);
    const merged: McpReconnectPolicy = {
      enabled: inner.bool("enabled", policy.enabled),
      initialDelayMs: inner.positiveInt("initial_delay_ms", policy.initialDelayMs),
      maxDelayMs: inner.positiveInt("max_delay_ms", policy.maxDelayMs),
      maxAttempts: inner.positiveInt("max_attempts", policy.maxAttempts),
    };
    inner.rejectUnknown(RECONNECT_KEYS);
    this.problems.push(...inner.problems.map((p) => `reconnect.${p}`));
    return merged;
  }
}

/** Resolve one `env`/`headers` map; unresolved references are reported by NAME. */
function referenceMap(
  reader: EntryReader,
  field: string,
  raw: Record<string, string>,
  env: Readonly<Record<string, string | undefined>>,
): { readonly value: Record<string, string>; readonly missing: string[] } {
  const resolved = resolveReferenceMap(raw, env);
  if (resolved.ok) return { value: { ...resolved.value }, missing: [] };
  if (resolved.invalid) reader.problems.push(`'${field}' uses an unsupported reference form (only $VAR is accepted)`);
  return { value: {}, missing: [...resolved.missing] };
}

interface TransportFields {
  readonly command?: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: Record<string, string>;
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly missing: readonly string[];
}

/**
 * Read the fields that belong to ONE transport and refuse the other transport's
 * fields. Crossed fields are a configuration error (schema `allOf`), not noise.
 */
function resolveTransport(
  reader: EntryReader,
  transport: McpTransportKind,
  env: Readonly<Record<string, string | undefined>>,
): TransportFields {
  const forbidden = transport === "stdio" ? HTTP_ONLY : STDIO_ONLY;
  for (const key of forbidden) {
    if (reader.raw[key] !== undefined) reader.problems.push(`'${key}' is not valid on a ${transport} server`);
  }
  if (transport === "stdio") {
    const rawEnv = reader.raw["env"];
    let envOut: Record<string, string> = {};
    const missing: string[] = [];
    if (rawEnv !== undefined) {
      if (isRecord(rawEnv)) {
        const resolved = referenceMap(reader, "env", rawEnv as Record<string, string>, env);
        envOut = resolved.value;
        missing.push(...resolved.missing);
      } else {
        reader.problems.push("'env' must be an object of string values");
      }
    }
    return {
      command: reader.string("command"),
      args: reader.stringArray("args"),
      cwd: reader.string("cwd"),
      env: envOut,
      missing,
    };
  }
  const rawHeaders = reader.raw["headers"];
  let headers: Record<string, string> = {};
  const missing: string[] = [];
  if (rawHeaders !== undefined) {
    if (isRecord(rawHeaders)) {
      const resolved = referenceMap(reader, "headers", rawHeaders as Record<string, string>, env);
      headers = resolved.value;
      missing.push(...resolved.missing);
    } else {
      reader.problems.push("'headers' must be an object of string values");
    }
  }
  return { url: reader.string("url"), args: [], env: {}, headers, missing };
}

function readToolApproval(reader: EntryReader): Record<string, McpApproval> {
  const raw = reader.raw["tool_approval"];
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    reader.problems.push("'tool_approval' must be an object");
    return {};
  }
  const out: Record<string, McpApproval> = {};
  for (const [tool, level] of Object.entries(raw)) {
    if (!(MCP_APPROVALS as readonly string[]).includes(String(level))) {
      reader.problems.push(`'tool_approval.${tool}' must be one of ${MCP_APPROVALS.join(" | ")}`);
      continue;
    }
    out[tool] = level as McpApproval;
  }
  return out;
}

export interface ValidateOptions {
  readonly scope: McpScope;
  readonly source: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly commandExists: (command: string) => boolean;
}

/** Validate one raw entry into a resolved {@link McpServerConfig}. */
export function validateServerEntry(name: string, raw: unknown, options: ValidateOptions): ServerValidation {
  const fail = (message: string, kind: McpIssue["kind"] = "invalid_entry"): ServerValidation => ({
    ok: false,
    issue: { kind, server: name, source: options.source, message },
  });
  if (!new RegExp(MCP_SERVER_NAME_PATTERN).test(name)) {
    return fail(`server name must match ${MCP_SERVER_NAME_PATTERN}`);
  }
  if (!isRecord(raw)) return fail("entry must be an object");

  const reader = new EntryReader(raw);
  reader.rejectUnknown(ALLOWED_KEYS);
  const transport = reader.enum<McpTransportKind>("transport", MCP_TRANSPORTS, MCP_DEFAULTS.transport);
  const fields = resolveTransport(reader, transport, options.env);
  const enabled = reader.bool("enabled", MCP_DEFAULTS.enabled);
  const approval = reader.enum<McpApproval>("approval", MCP_APPROVALS, MCP_DEFAULTS.approval);
  const toolApproval = readToolApproval(reader);
  const timeoutMs = reader.positiveInt("timeout_ms", MCP_DEFAULTS.timeoutMs);
  const toolAllow = reader.stringArray("tool_allow");
  const toolDeny = reader.stringArray("tool_deny");
  const pathAccess = reader.enum<McpPathAccess>("path_access", MCP_PATH_ACCESS, MCP_DEFAULTS.pathAccess);
  const reconnect = reader.reconnect(MCP_DEFAULTS.reconnect);

  if (reader.problems.length > 0) return fail(reader.problems.join("; "));
  if (fields.missing.length > 0) {
    const names = [...new Set(fields.missing)].sort().join(", ");
    return fail(`$VAR not set in the environment: ${names}`, "unknown_reference");
  }
  if (transport === "stdio") {
    if (fields.command === undefined) return fail("'command' is required for a stdio server");
    if (!options.commandExists(fields.command)) {
      return fail(`command '${fields.command}' was not found on PATH`, "command_missing");
    }
  }
  if (transport === "http" && fields.url === undefined) return fail("'url' is required for an http server");

  return {
    ok: true,
    config: {
      name,
      transport,
      enabled,
      approval,
      toolApproval,
      timeoutMs,
      toolAllow,
      toolDeny,
      pathAccess,
      reconnect,
      command: fields.command,
      args: fields.args,
      cwd: fields.cwd,
      env: fields.env,
      url: fields.url,
      headers: fields.headers ?? {},
      scope: options.scope,
      source: options.source,
      raw,
    },
  };
}
