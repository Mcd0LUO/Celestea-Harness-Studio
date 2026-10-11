/**
 * Tool adaptation: a remote MCP tool list → model-visible `ToolSpec`s
 * (docs/feature/mcp-client.md §5).
 *
 * Decisions that live here, and why:
 *   - **`parameters` IS the remote `inputSchema`.** No translation layer: a
 *     translator is a drift source, and the wire schema is already what our own
 *     validator would have to reproduce.
 *   - **Normalisation is minimal but not optional**: a missing `properties` is
 *     filled with `{}` so the surface is always an OBJECT schema. That is a
 *     shape fix, NOT a licence to register an unsupported schema.
 *   - **Unsupported keywords refuse the tool** (external `$ref`, the composition
 *     keywords). Registering a schema we cannot validate would let the model send
 *     arguments this registry silently mis-handles; the refusal is reported, never
 *     dropped in silence.
 *   - **allow then deny**, and BOTH match the raw descriptor name and the
 *     model-visible name, so a denylist cannot quietly stop applying after a
 *     server renames a tool.
 */

import type {
  McpApproval,
  McpCallResult,
  McpContentPart,
  McpIssueKind,
  McpPathAccess,
  McpRemoteTool,
  McpServerConfig,
  McpToolSpec,
} from "./types.js";
import { MCP_DEFAULTS } from "./types.js";
import { mcpToolName } from "./naming.js";

/** JSON Schema keywords this registry cannot honour. Refuse rather than guess. */
const UNSUPPORTED_KEYWORDS = [
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "dependentSchemas",
  "$dynamicRef",
  "$recursiveRef",
] as const;

export interface McpSkippedTool {
  readonly tool: string;
  readonly kind: McpIssueKind;
  readonly message: string;
}

export interface McpAdaptedTool {
  readonly spec: McpToolSpec;
  readonly server: string;
  /** The server's OWN tool name (never shown to the model). */
  readonly tool: string;
  readonly approval: McpApproval;
  readonly pathAccess: McpPathAccess;
}

export interface McpToolAdaptation {
  readonly tools: readonly McpAdaptedTool[];
  readonly skipped: readonly McpSkippedTool[];
  /** Set when the WHOLE list was refused (duplicate raw names). */
  readonly rejected?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Depth-first search for a keyword we refuse, or a `$ref` that leaves the document. */
function findUnsupported(value: unknown, depth = 0): string | null {
  if (depth > 32 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findUnsupported(item, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string" && !child.startsWith("#")) {
      return `external $ref '${child}'`;
    }
    if ((UNSUPPORTED_KEYWORDS as readonly string[]).includes(key)) return `keyword '${key}'`;
    const hit = findUnsupported(child, depth + 1);
    if (hit !== null) return hit;
  }
  return null;
}

export type SchemaNormalization =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

/**
 * Normalise the remote `inputSchema` to an object schema, or refuse it.
 *
 * The object shape is mandatory: a non-object parameter schema would put something
 * into the model face this repository cannot validate.
 */
export function normalizeInputSchema(schema: unknown): SchemaNormalization {
  if (schema === undefined || schema === null) return { ok: true, value: { type: "object", properties: {} } };
  if (!isRecord(schema)) return { ok: false, reason: "inputSchema is not a JSON Schema object" };
  const type = schema["type"];
  if (type !== undefined && type !== "object") return { ok: false, reason: `inputSchema.type is '${String(type)}', not 'object'` };
  const unsupported = findUnsupported(schema);
  if (unsupported !== null) return { ok: false, reason: unsupported };
  const properties = schema["properties"];
  if (properties !== undefined && !isRecord(properties)) {
    return { ok: false, reason: "inputSchema.properties is not an object" };
  }
  return { ok: true, value: { ...schema, type: "object", properties: properties ?? {} } };
}

/** Does the raw name OR the model-visible name appear in the list? */
function matches(entry: string, raw: string, visible: string): boolean {
  return entry === raw || entry === visible;
}

/**
 * Narrowing order: `tool_allow` first (when present it is the ceiling), then
 * `tool_deny` — deny always wins, because a denylist is how an operator takes a
 * tool back without editing the allowlist.
 */
export function isToolVisible(server: McpServerConfig, raw: string, visible: string): boolean {
  if (server.toolAllow.length > 0 && !server.toolAllow.some((e) => matches(e, raw, visible))) return false;
  return !server.toolDeny.some((e) => matches(e, raw, visible));
}

function describe(server: string, tool: McpRemoteTool): string {
  // The server name in the prefix is what makes provenance legible in a transcript.
  return `[mcp:${server}] ${tool.description ?? ""}`.trim();
}

function approvalFor(server: McpServerConfig, raw: string): McpApproval {
  return server.toolApproval[raw] ?? server.approval;
}

/** Adapt one server's tool list. A duplicate raw name rejects the WHOLE list. */
export function adaptTools(server: McpServerConfig, remote: readonly McpRemoteTool[]): McpToolAdaptation {
  const seen = new Set<string>();
  for (const tool of remote) {
    if (seen.has(tool.name)) {
      return {
        tools: [],
        skipped: remote.map((t) => ({
          tool: t.name,
          kind: "duplicate_tools" as const,
          message: `server '${server.name}' lists tool '${t.name}' more than once; the whole list is refused (the previous generation stays)`,
        })),
        rejected: `duplicate tool name '${tool.name}'`,
      };
    }
    seen.add(tool.name);
  }
  const tools: McpAdaptedTool[] = [];
  const skipped: McpSkippedTool[] = [];
  for (const tool of remote) {
    const visible = mcpToolName(server.name, tool.name);
    if (!isToolVisible(server, tool.name, visible)) continue;
    const schema = normalizeInputSchema(tool.inputSchema);
    if (!schema.ok) {
      skipped.push({ tool: tool.name, kind: "schema_unsupported", message: schema.reason });
      continue;
    }
    const spec: McpToolSpec = {
      name: visible,
      description: describe(server.name, tool),
      parameters: schema.value,
      mcp: { server: server.name, tool: tool.name },
    };
    tools.push({
      spec,
      server: server.name,
      tool: tool.name,
      approval: approvalFor(server, tool.name),
      pathAccess: server.pathAccess,
    });
  }
  return { tools, skipped };
}

/** The tools a server offers, sorted for a STABLE disclosure order (name asc). */
export function sortToolsForDisclosure(tools: readonly McpAdaptedTool[]): McpAdaptedTool[] {
  return [...tools].sort((a, b) => {
    const byServer = a.server < b.server ? -1 : a.server > b.server ? 1 : 0;
    if (byServer !== 0) return byServer;
    return a.spec.name < b.spec.name ? -1 : a.spec.name > b.spec.name ? 1 : 0;
  });
}

/**
 * Render a canonical MCP result as text for the model face.
 *
 * Unsupported rich content is DIAGNOSED, never dropped: both reference
 * implementations said so, and silently discarding a part would make the model
 * believe the call produced nothing.
 */
export function renderCallText(result: McpCallResult): string {
  const parts: string[] = [];
  for (const part of result.content) {
    if (part.type === "text") parts.push(String(part["text"] ?? ""));
    else parts.push(`[unsupported content type: ${part.type}]`);
  }
  const text = parts.filter((p) => p !== "").join("\n");
  return text === "" ? `[no text content; ${result.content.length} content part(s)]` : text;
}

export function contentParts(result: McpCallResult): readonly McpContentPart[] {
  return result.content;
}

/** The default path-access declaration for a server with no explicit `path_access`. */
export const DEFAULT_PATH_ACCESS: McpPathAccess = MCP_DEFAULTS.pathAccess;