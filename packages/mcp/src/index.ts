/**
 * `@celestea/mcp` — the MCP CLIENT: configuration, connections and tool adaptation
 * for external MCP servers (docs/feature/mcp-client.md).
 *
 * Responsibility: `mcp.json` parsing + two-scope merge + `$VAR` credential
 * references; one connection per server per session generation with the reconnect
 * supervisor; the `mcp__<server>__<tool>` naming and schema-passthrough adapter;
 * the bounded disposal discipline.
 *
 * Dependency direction: mcp → core + the official SDK only (ARCHITECTURE §1 L1).
 * The SDK is confined to sdk-transport.ts behind the McpTransport seam, so the
 * lifecycle and adaptation logic is testable with a fake transport and no process.
 *
 * NOT in this slice (later waves, deliberately): plugin assembly / guard
 * registration, the status-surface wiring, the settings page, `resources` and
 * server `instructions`, pictures, and the hot-reload watcher.
 *
 * Module map:
 *   types.ts           public types + frozen constants (mirror of the schema defaults)
 *   errors.ts          McpError (per server) / McpConfigError (fatal, file-level)
 *   json-keys.ts       raw-text duplicate-key scanner (JSON.parse hides duplicates)
 *   references.ts      $VAR resolution; missing references fail loudly, values never echoed
 *   config-validate.ts one entry → McpServerConfig, or a reported reason
 *   config.ts          read both scopes, merge by whole-server replacement, serialise
 *   naming.ts          mcp__<server>__<tool> with a sha256 suffix when the shape changed
 *   tools.ts           allow/deny filtering, schema normalisation, disclosure order
 *   tool.ts            the adapted tool as a core Tool + the §5.2 non-contract rule
 *   transport.ts       the McpTransport seam + child-environment scrubbing
 *   sdk-transport.ts   the ONLY module that imports @modelcontextprotocol/sdk
 *   connection.ts      one server: connect / discover / call / bounded close
 *                      (the deadline primitive is @celestea/core's `bounded`, not a local copy)
 *   reconnect.ts       the reconnect budget (delay, streak, stability window)
 *   scheduler.ts       the timer seam (tests never wait for real time)
 *   resources.ts       ctx.effect-style disposal scope (reverse order, idempotent)
 *   session.ts         one generation: N servers, failure isolation, dispatch
 *
 * Public API = this file. Everything else is an internal module.
 */

export * from "./types.js";
export { McpConfigError, McpError, classifyError } from "./errors.js";
export { loadMcpConfig, serializeMcpDocument, defaultCommandExists } from "./config.js";
export type { McpLoadOptions } from "./config.js";
export { validateServerEntry } from "./config-validate.js";
export type { ServerValidation, ValidateOptions } from "./config-validate.js";
export { findDuplicateKeys } from "./json-keys.js";
export type { DuplicateKey } from "./json-keys.js";
export { resolveReferences, resolveReferenceMap, hasReference } from "./references.js";
export type { ReferenceResult } from "./references.js";
export { identityHash, isMcpToolName, mcpToolName, sanitizeSegment } from "./naming.js";
export {
  adaptTools,
  isToolVisible,
  normalizeInputSchema,
  renderCallText,
  sortToolsForDisclosure,
} from "./tools.js";
export type { McpAdaptedTool, McpSkippedTool, McpToolAdaptation, SchemaNormalization } from "./tools.js";
export { explainNonContractTool, mcpTool } from "./tool.js";
export type { McpTool, McpToolDeps } from "./tool.js";
export { boundedSignal, childEnvironment, scrubbedParentEnv } from "./transport.js";
export type { BoundedSignal, McpClient, McpTransport, McpTransportFactory } from "./transport.js";
export { sdkTransportFactory } from "./sdk-transport.js";
export { createServerConnection } from "./connection.js";
export type { ConnectionDeps, ServerConnection } from "./connection.js";
export { systemScheduler } from "./scheduler.js";
export type { Scheduler } from "./scheduler.js";
export { backoffDelayMs, createReconnectSupervisor, isSupervisable } from "./reconnect.js";
export type { ReconnectSupervisor } from "./reconnect.js";
export { createDisposableScope } from "./resources.js";
export type { DisposableScope, DisposableScopeOptions, Disposer } from "./resources.js";
export { createMcpSession } from "./session.js";
export type { McpSession, McpSessionOptions } from "./session.js";
