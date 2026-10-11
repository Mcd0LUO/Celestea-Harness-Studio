/**
 * The `Tool` adapter: an adapted MCP tool as something the tool registry can hold.
 *
 * The registry is untouched — an MCP tool is an ordinary `Tool` with an ordinary
 * `spec()`, so it rides the SAME dispatch pipeline as every built-in
 * (schema validation → guard chain → execute → structured result). That is
 * deliberate: docs/feature/mcp-client.md D6 says MCP tools get an extra approval
 * guard, not a second permission system.
 *
 * Errors are VALUES here, not exceptions: the registry captures a throw into
 * `ToolOutput.error`, and a structured outcome keeps the failure KIND (not_ready,
 * timeout, …) visible to the caller instead of flattening it into prose.
 */

import type { Tool, ToolExecOutcome, ToolInput } from "@celestea/core";

import { mcpToolName } from "./naming.js";
import type { McpAdaptedTool } from "./tools.js";
import { MCP_TOOL_PREFIX } from "./types.js";
import type { McpCallOutcome } from "./types.js";

export interface McpToolDeps {
  /** Dispatch by model-visible name; resolves with a structured outcome. */
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallOutcome>;
}

/** A registry-ready tool that also carries its MCP provenance. */
export interface McpTool extends Tool {
  readonly mcp: { readonly server: string; readonly tool: string };
}

export function mcpTool(binding: McpAdaptedTool, deps: McpToolDeps): McpTool {
  const name = binding.spec.name;
  return {
    mcp: binding.spec.mcp,
    spec: () => binding.spec,
    execute: (args: unknown) => deps.callTool(name, args),
    executeWith: async (input: ToolInput): Promise<ToolExecOutcome> => {
      const outcome = await deps.callTool(name, input.args, input.signal);
      return { value: outcome, render: outcome.text };
    },
  };
}

/**
 * The §5.2 rule, as a function the assertion can call: a NON-CONTRACT tool name is
 * only legal when it is an MCP name AND carries MCP provenance.
 *
 * Returning the reason (rather than a bare boolean) is what makes the failure
 * message point at the actual violation instead of "some tool is wrong".
 */
export function explainNonContractTool(
  name: string,
  provenance: { readonly server: string; readonly tool: string } | undefined,
): string | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) {
    return `'${name}' is not an MCP tool name and is not declared in contracts/tools.json`;
  }
  if (provenance === undefined) {
    return `'${name}' claims the mcp__ namespace but carries no MCP provenance`;
  }
  const expected = mcpToolName(provenance.server, provenance.tool);
  if (expected !== name) {
    // A tool presenting one server's name while carrying another's provenance
    // would leave the permission identity ambiguous.
    return `'${name}' does not match its own provenance (server=${provenance.server} tool=${provenance.tool} => '${expected}')`;
  }
  return null;
}
