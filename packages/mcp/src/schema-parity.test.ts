/**
 * Schema ↔ implementation parity.
 *
 * The schema is the field source of truth (contracts/data-files/mcp.schema.json);
 * this package's constants are its runtime form. Two copies of a default WILL
 * drift unless something compares them, so this file compares them — including the
 * registered data-file entry, which is what makes `mcp.json` a 14th frozen file
 * rather than a schema nobody loads.
 */

import { loadDataFileSchema, loadDataFilesIndex } from "@celestea/core";
import { describe, expect, it } from "vitest";

import { validateServerEntry } from "./config-validate.js";
import {
  MCP_APPROVALS,
  MCP_DEFAULTS,
  MCP_PATH_ACCESS,
  MCP_SERVER_NAME_PATTERN,
  MCP_TRANSPORTS,
} from "./types.js";

interface SchemaDoc {
  $defs: {
    server: {
      properties: Record<string, Record<string, unknown>>;
      allOf: unknown[];
    };
    servers?: { propertyNames?: { pattern?: string } };
  };
  schema: { properties: { servers: { propertyNames?: { pattern?: string } } } };
}

const doc = loadDataFileSchema("mcp.schema.json") as unknown as SchemaDoc;
const entry = (field: string): Record<string, unknown> => doc.$defs.server.properties[field] ?? {};

describe("mcp.schema.json ↔ packages/mcp", () => {
  it("is registered as a frozen data file at 0644 and NOT secret", () => {
    const files = loadDataFilesIndex().files;
    const mcp = files.find((f) => f.file === "<CELESTEA_HOME>/mcp.json");
    expect(mcp?.schema).toBe("mcp.schema.json");
    expect(mcp?.mode).toBe("0644");
    // D3: env/headers carry $VAR references only, so providers.json stays the only
    // secret-bearing data file and that assertion needs no change.
    expect(mcp?.secret).toBeUndefined();
    expect(files.filter((f) => f.secret === true).map((f) => f.file)).toEqual(["providers.json"]);
  });

  it("freezes the server-name pattern in the schema and in the code", () => {
    expect(doc.schema.properties.servers.propertyNames?.pattern).toBe(MCP_SERVER_NAME_PATTERN);
  });

  it("mirrors every default", () => {
    expect(entry("transport")["default"]).toBe(MCP_DEFAULTS.transport);
    expect(entry("enabled")["default"]).toBe(MCP_DEFAULTS.enabled);
    expect(entry("approval")["default"]).toBe(MCP_DEFAULTS.approval);
    expect(entry("timeout_ms")["default"]).toBe(MCP_DEFAULTS.timeoutMs);
    expect(entry("path_access")["default"]).toBe(MCP_DEFAULTS.pathAccess);
    const reconnect = entry("reconnect")["default"] as Record<string, number | boolean>;
    expect(reconnect).toEqual({
      enabled: MCP_DEFAULTS.reconnect.enabled,
      initial_delay_ms: MCP_DEFAULTS.reconnect.initialDelayMs,
      max_delay_ms: MCP_DEFAULTS.reconnect.maxDelayMs,
      max_attempts: MCP_DEFAULTS.reconnect.maxAttempts,
    });
  });

  it("mirrors every enum", () => {
    expect(entry("transport")["enum"]).toEqual([...MCP_TRANSPORTS]);
    expect(entry("approval")["enum"]).toEqual([...MCP_APPROVALS]);
    expect(entry("path_access")["enum"]).toEqual([...MCP_PATH_ACCESS]);
  });

  it("enforces the two transport cross-field rules the schema declares", () => {
    expect(doc.$defs.server.allOf).toHaveLength(2);
    const options = { scope: "global", source: "mcp.json", env: {}, commandExists: () => true } as const;
    const crossed = validateServerEntry("memory", { transport: "http", url: "https://x", command: "npx" }, options);
    expect(crossed.ok).toBe(false);
    const backwards = validateServerEntry("memory", { transport: "stdio", command: "npx", url: "https://x" }, options);
    expect(backwards.ok).toBe(false);
  });

  it("keeps unknown fields out (the schema says additionalProperties: false)", () => {
    const result = validateServerEntry(
      "memory",
      { transport: "stdio", command: "npx", surprise: true },
      { scope: "global", source: "mcp.json", env: {}, commandExists: () => true },
    );
    expect(result.ok).toBe(false);
  });
});
