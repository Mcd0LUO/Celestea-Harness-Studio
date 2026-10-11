/**
 * `mcp.json` merge matrix and failure semantics (docs/feature/mcp-client.md §4.2/§4.3).
 *
 * Filesystem and environment are injected, so the whole matrix runs in memory: the
 * interesting behaviour is the MERGE and the failure modes, not the disk.
 */

import { describe, expect, it } from "vitest";

import { loadMcpConfig, serializeMcpDocument } from "./config.js";
import { McpConfigError } from "./errors.js";

const GLOBAL = "home/mcp.json";
const WORKSPACE = "home/workspaces/ws/mcp.json";

interface LoadOptions {
  readonly files?: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly commandExists?: (command: string) => boolean;
  readonly globalPath?: string | null;
  readonly workspacePath?: string | null;
}

function load(options: LoadOptions = {}) {
  const files = options.files ?? {};
  return loadMcpConfig({
    globalPath: options.globalPath === undefined ? GLOBAL : options.globalPath,
    workspacePath: options.workspacePath === undefined ? WORKSPACE : options.workspacePath,
    env: options.env ?? {},
    readText: (path) => files[path] ?? null,
    commandExists: options.commandExists ?? (() => true),
  });
}

const stdio = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ servers: { memory: { transport: "stdio", command: "npx", ...extra } } });

describe("loadMcpConfig · merge matrix", () => {
  it("applies the schema defaults to a minimal entry", () => {
    const result = load({ files: { [GLOBAL]: stdio() } });
    const server = result.servers.get("memory");
    expect(server?.transport).toBe("stdio");
    expect(server?.enabled).toBe(true);
    expect(server?.approval).toBe("ask");
    expect(server?.timeoutMs).toBe(60_000);
    expect(server?.pathAccess).toBe("write");
    expect(server?.reconnect).toEqual({ enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 });
    expect(result.issues).toEqual([]);
  });

  it("keeps the global entry when the workspace does not mention it", () => {
    const result = load({
      files: {
        [GLOBAL]: stdio(),
        [WORKSPACE]: JSON.stringify({ servers: { extra: { transport: "stdio", command: "node" } } }),
      },
    });
    expect([...result.servers.keys()]).toEqual(["memory", "extra"]);
    expect(result.servers.get("memory")?.scope).toBe("global");
    expect(result.servers.get("extra")?.scope).toBe("workspace");
  });

  it("REPLACES the global entry whole on a same-name workspace entry (no field merge)", () => {
    const result = load({
      files: {
        [GLOBAL]: stdio({ approval: "never", timeout_ms: 5_000, args: ["-y"] }),
        // The workspace entry says nothing about approval/timeout/args: none of
        // the global values may survive, or "I turned it off here" is a fiction.
        [WORKSPACE]: JSON.stringify({ servers: { memory: { transport: "stdio", command: "node" } } }),
      },
    });
    const server = result.servers.get("memory");
    expect(server?.scope).toBe("workspace");
    expect(server?.approval).toBe("ask");
    expect(server?.timeoutMs).toBe(60_000);
    expect(server?.args).toEqual([]);
  });

  it("a disabled workspace entry really disables the server", () => {
    const result = load({
      files: { [GLOBAL]: stdio(), [WORKSPACE]: stdio({ enabled: false }) },
    });
    expect(result.servers.get("memory")?.enabled).toBe(false);
  });

  it("drops the global entry when the workspace override itself is invalid", () => {
    const result = load({
      files: {
        // `other` is untouched by the workspace and must survive; `memory` is
        // replaced by a REFUSED override and must NOT fall back to the global one.
        [GLOBAL]: JSON.stringify({
          servers: { memory: { transport: "stdio", command: "npx" }, other: { transport: "stdio", command: "npx" } },
        }),
        // Crossed fields: url on a stdio server.
        [WORKSPACE]: JSON.stringify({ servers: { memory: { transport: "stdio", command: "npx", url: "http://x" } } }),
      },
    });
    expect(result.servers.has("memory")).toBe(false);
    expect([...result.servers.keys()]).toEqual(["other"]);
    expect(result.issues.map((i) => i.kind)).toEqual(["invalid_entry"]);
  });

  it("treats an absent file as an empty set", () => {
    const result = load({ files: {} });
    expect(result.servers.size).toBe(0);
    expect(result.issues).toEqual([]);
  });

  it("skips only the offending entry when one server is unusable", () => {
    const result = load({
      files: {
        [GLOBAL]: JSON.stringify({
          servers: {
            good: { transport: "stdio", command: "node" },
            bad: { transport: "http", command: "node" },
          },
        }),
      },
    });
    expect([...result.servers.keys()]).toEqual(["good"]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.server).toBe("bad");
  });

  it("reports a command that is not on PATH without failing the file", () => {
    const result = load({ files: { [GLOBAL]: stdio() }, commandExists: () => false });
    expect(result.servers.size).toBe(0);
    expect(result.issues[0]?.kind).toBe("command_missing");
  });
});

describe("loadMcpConfig · hard failures (never silently degraded)", () => {
  it("throws on malformed JSON, naming the file", () => {
    expect(() => load({ files: { [GLOBAL]: "{ not json" } })).toThrow(McpConfigError);
    try {
      load({ files: { [GLOBAL]: "{ not json" } });
    } catch (error) {
      expect((error as McpConfigError).kind).toBe("invalid_entry");
      expect((error as Error).message).toContain(GLOBAL);
    }
  });

  it("throws on a same-scope duplicate server name instead of 'last one wins'", () => {
    const text = '{"servers":{"memory":{"transport":"stdio","command":"a"},"memory":{"transport":"stdio","command":"b"}}}';
    try {
      load({ files: { [GLOBAL]: text } });
      throw new Error("expected a duplicate-server failure");
    } catch (error) {
      expect(error).toBeInstanceOf(McpConfigError);
      expect((error as McpConfigError).kind).toBe("duplicate_server");
    }
  });

  it("throws when the root shape is wrong", () => {
    expect(() => load({ files: { [GLOBAL]: '{"servers":[]}' } })).toThrow(McpConfigError);
    expect(() => load({ files: { [GLOBAL]: '{"servers":{}},"extra":1}' } })).toThrow(McpConfigError);
  });
});

describe("loadMcpConfig · credential references", () => {
  const remote = JSON.stringify({
    servers: { remote: { transport: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer $EXAMPLE_TOKEN" } } },
  });

  it("resolves $VAR references from the process environment", () => {
    const result = load({ files: { [GLOBAL]: remote }, env: { EXAMPLE_TOKEN: "tok-123" } });
    expect(result.servers.get("remote")?.headers).toEqual({ Authorization: "Bearer tok-123" });
  });

  it("fails LOUDLY on a missing reference and never connects with an empty value", () => {
    const result = load({ files: { [GLOBAL]: remote }, env: {} });
    expect(result.servers.size).toBe(0);
    expect(result.issues[0]?.kind).toBe("unknown_reference");
    expect(result.issues[0]?.message).toContain("EXAMPLE_TOKEN");
  });

  it("never echoes a resolved value into an issue or a serialized document", () => {
    const result = load({ files: { [GLOBAL]: remote }, env: { EXAMPLE_TOKEN: "tok-123" } });
    const server = result.servers.get("remote");
    expect(server).toBeDefined();
    const document = serializeMcpDocument([...(server === undefined ? [] : [server])]);
    // The file keeps the reference; the secret only ever lives in memory.
    expect(document).toContain("Bearer $EXAMPLE_TOKEN");
    expect(document).not.toContain("tok-123");
  });
});
