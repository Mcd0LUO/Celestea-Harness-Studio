/**
 * Model-visible tool naming: `mcp__<server>__<tool>` (docs/feature/mcp-client.md §5.1).
 *
 * Two reference implementations sanitise illegal characters and then STOP. We do
 * not: sanitisation is lossy ("a.b" and "a b" both become "a_b"), so a name whose
 * shape changed gets a 12-hex sha256 of `<server>\0<tool>` appended. Two different
 * MCP identifiers can therefore never collapse into one model-visible name —
 * which matters because the name IS the permission identity (`toolDeny`) and the
 * approval identity.
 *
 * The namespace comes from LOCAL configuration, never from a remote
 * `serverInfo.name`: that is untrusted, not unique across deployments, and can
 * change on the server's own upgrade — a tool identity and its permission rules
 * must not silently follow it.
 */

import { createHash } from "node:crypto";

import { MCP_TOOL_PREFIX, MCP_TOOL_NAME_MAX, MCP_HASH_LEN, MCP_SEGMENT_MAX } from "./types.js";

/** Illegal characters collapse to `_`; the rest is preserved verbatim. */
export function sanitizeSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** `sha256("<server>\0<tool>")`, first 12 hex chars. */
export function identityHash(server: string, tool: string): string {
  return createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, MCP_HASH_LEN);
}

interface NameParts {
  readonly name: string;
  /** True when sanitisation or truncation changed the identifier. */
  readonly degraded: boolean;
}

/**
 * Build the model-visible name.
 *
 * Truncation keeps the hash suffix AT THE END on purpose: a truncated prefix plus
 * the identity hash still separates two long identifiers, while a hash that got
 * cut off would not separate anything.
 */
function buildName(server: string, tool: string): NameParts {
  const serverPart = sanitizeSegment(server).slice(0, MCP_SEGMENT_MAX);
  const toolPart = sanitizeSegment(tool).slice(0, MCP_SEGMENT_MAX);
  const degraded = serverPart !== server || toolPart !== tool;
  const suffix = degraded ? `_${identityHash(server, tool)}` : "";
  const head = `${MCP_TOOL_PREFIX}${serverPart}__${toolPart}`;
  if (head.length + suffix.length <= MCP_TOOL_NAME_MAX) return { name: head + suffix, degraded };
  const room = MCP_TOOL_NAME_MAX - suffix.length;
  return { name: head.slice(0, Math.max(room, 0)) + suffix, degraded: true };
}

/** The model-visible name for one (server, raw tool) pair. */
export function mcpToolName(server: string, tool: string): string {
  return buildName(server, tool).name;
}

/** `true` for a name this package produced (used by the §5.2 rules). */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}