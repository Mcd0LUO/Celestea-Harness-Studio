/**
 * The data-file round trip the contract demands
 * (contracts/data-files/index.json: "read -> write -> re-read", both sides
 * agreeing byte-for-byte on the written form).
 *
 * This is a CROSS-PACKAGE test, so it lives in tests/ (ARCHITECTURE.md §6.4.1):
 * it reads the frozen schema, writes a real mcp.json through the package's
 * serialiser, re-reads it, and compares bytes.
 *
 * The credential rule gets its own case: the written file must carry the $VAR
 * REFERENCE, never the resolved value. That is what keeps mcp.json a 0644 file
 * with no secret in it — and it is the one place a careless serialiser would leak.
 */

import { describe, expect, it } from "vitest";

import { loadMcpConfig, serializeMcpDocument } from "@celestea/mcp";
import type { McpServerConfig } from "@celestea/mcp";

const GLOBAL = "home/mcp.json";
const WORKSPACE = "home/workspaces/ws/mcp.json";

const DOCUMENT = {
  servers: {
    memory: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
      env: { MEMORY_DIR: "~/.celestea/memory" },
      timeout_ms: 20_000,
    },
    remote: {
      transport: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer $EXAMPLE_TOKEN" },
      approval: "never",
      enabled: false,
    },
  },
};

const ENV = { EXAMPLE_TOKEN: "tok-123" };

function loadFrom(text: string): ReadonlyMap<string, McpServerConfig> {
  return loadMcpConfig({
    globalPath: GLOBAL,
    workspacePath: null,
    env: ENV,
    readText: (path) => (path === GLOBAL ? text : null),
    commandExists: () => true,
  }).servers;
}

describe("mcp.json round trip", () => {
  it("read -> write -> re-read reproduces the file byte-for-byte", () => {
    const first = loadFrom(JSON.stringify(DOCUMENT, null, 2));
    const written = serializeMcpDocument([...first.values()]);
    const second = loadFrom(written);
    const rewritten = serializeMcpDocument([...second.values()]);
    expect(rewritten).toBe(written);
  });

  it("keeps the $VAR reference in the file and never the resolved credential", () => {
    const servers = loadFrom(JSON.stringify(DOCUMENT, null, 2));
    const written = serializeMcpDocument([...servers.values()]);
    expect(written).toContain("Bearer $EXAMPLE_TOKEN");
    expect(written).not.toContain("tok-123");
    // ...while the in-memory view is what actually carries the credential.
    expect(servers.get("remote")?.headers).toEqual({ Authorization: "Bearer tok-123" });
  });

  it("re-reads the same semantics, not merely the same bytes", () => {
    const first = loadFrom(JSON.stringify(DOCUMENT, null, 2));
    const second = loadFrom(serializeMcpDocument([...first.values()]));
    for (const [name, before] of first) {
      const after = second.get(name);
      expect(after, name).toBeDefined();
      expect(after?.enabled).toBe(before?.enabled);
      expect(after?.approval).toBe(before?.approval);
      expect(after?.timeoutMs).toBe(before?.timeoutMs);
      expect(after?.transport).toBe(before?.transport);
    }
  });

  it("sorts servers by name so the written form is stable across runs", () => {
    const text = JSON.stringify({ servers: { zeta: { command: "z" }, alpha: { command: "a" } } });
    const written = serializeMcpDocument([...loadFrom(text).values()]);
    expect(written.indexOf("alpha")).toBeLessThan(written.indexOf("zeta"));
  });

  it("keeps a workspace overlay out of the global document", () => {
    const merged = loadMcpConfig({
      globalPath: GLOBAL,
      workspacePath: WORKSPACE,
      env: ENV,
      readText: (path) =>
        path === GLOBAL ? JSON.stringify(DOCUMENT) : JSON.stringify({ servers: { memory: { command: "local", enabled: false } } }),
      commandExists: () => true,
    });
    const written = serializeMcpDocument([...merged.servers.values()]);
    expect(written).toContain('"enabled": false');
    expect(written).not.toContain("npx");
  });
});
