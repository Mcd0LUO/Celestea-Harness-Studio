/**
 * Tool adaptation: filtering order, schema normalisation and the stable
 * disclosure order (docs/feature/mcp-client.md §5.1/§5.3/§5.4).
 */

import { describe, expect, it } from "vitest";

import { adaptTools, isToolVisible, normalizeInputSchema, renderCallText, sortToolsForDisclosure } from "./tools.js";
import type { McpRemoteTool, McpServerConfig } from "./types.js";

function server(extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: "memory",
    transport: "stdio",
    enabled: true,
    approval: "ask",
    toolApproval: {},
    timeoutMs: 60_000,
    toolAllow: [],
    toolDeny: [],
    pathAccess: "write",
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
    command: "npx",
    args: [],
    env: {},
    headers: {},
    scope: "global",
    source: "mcp.json",
    raw: {},
    ...extra,
  };
}

const remember: McpRemoteTool = { name: "remember", description: "store a fact", inputSchema: { type: "object", properties: { fact: { type: "string" } } } };
const recall: McpRemoteTool = { name: "recall", description: "read facts", inputSchema: { type: "object", properties: {} } };

describe("adaptTools · naming and provenance", () => {
  it("names tools mcp__<server>__<tool> and prefixes the description with the source", () => {
    const adapted = adaptTools(server(), [remember]);
    expect(adapted.tools[0]?.spec.name).toBe("mcp__memory__remember");
    expect(adapted.tools[0]?.spec.description).toBe("[mcp:memory] store a fact");
    expect(adapted.tools[0]?.spec.mcp).toEqual({ server: "memory", tool: "remember" });
  });

  it("passes the remote inputSchema through instead of translating it", () => {
    const schema = { type: "object", properties: { fact: { type: "string", description: "the fact" } }, required: ["fact"] };
    const adapted = adaptTools(server(), [{ name: "remember", inputSchema: schema }]);
    expect(adapted.tools[0]?.spec.parameters).toEqual({ ...schema, properties: schema.properties });
  });

  it("defaults the approval to 'ask' and honours a per-tool override", () => {
    const adapted = adaptTools(server({ toolApproval: { recall: "never" } }), [remember, recall]);
    // Sorted by model-visible name (the disclosure order), not by arrival.
    expect(adapted.tools.map((t) => [t.tool, t.approval])).toEqual([
      ["remember", "ask"],
      ["recall", "never"],
    ]);
  });
});

describe("adaptTools · filtering", () => {
  it("keeps everything when neither list is set", () => {
    expect(adaptTools(server(), [remember, recall]).tools).toHaveLength(2);
  });

  it("narrows with tool_allow first, then lets tool_deny win", () => {
    const configured = server({ toolAllow: ["remember", "recall"], toolDeny: ["recall"] });
    const adapted = adaptTools(configured, [remember, recall]);
    expect(adapted.tools.map((t) => t.tool)).toEqual(["remember"]);
    // Deny also matches the model-visible name, so a denylist cannot go stale.
    expect(isToolVisible(configured, "remember", "mcp__memory__remember")).toBe(true);
    expect(isToolVisible(server({ toolDeny: ["mcp__memory__recall"] }), "recall", "mcp__memory__recall")).toBe(false);
  });

  it("an allow list is a ceiling: anything unlisted is invisible", () => {
    const adapted = adaptTools(server({ toolAllow: ["remember"] }), [remember, recall]);
    expect(adapted.tools.map((t) => t.tool)).toEqual(["remember"]);
  });
});

describe("adaptTools · refusal instead of silent registration", () => {
  it("refuses the WHOLE list when the server repeats a raw tool name", () => {
    const adapted = adaptTools(server(), [remember, recall, { name: "remember" }]);
    expect(adapted.tools).toEqual([]);
    expect(adapted.rejected).toContain("remember");
    expect(adapted.skipped.every((s) => s.kind === "duplicate_tools")).toBe(true);
  });

  it("refuses a tool whose inputSchema is not an object schema, and says why", () => {
    const adapted = adaptTools(server(), [{ name: "bad", inputSchema: { type: "string" } }]);
    expect(adapted.tools).toEqual([]);
    expect(adapted.skipped[0]?.kind).toBe("schema_unsupported");
    expect(adapted.skipped[0]?.message).toContain("not 'object'");
  });

  it("refuses a tool carrying an external $ref", () => {
    const adapted = adaptTools(server(), [
      { name: "ref", inputSchema: { type: "object", properties: { a: { $ref: "https://example.com/s.json" } } } },
    ]);
    expect(adapted.tools).toEqual([]);
    expect(adapted.skipped[0]?.message).toContain("external $ref");
  });

  it("refuses composition keywords we cannot validate", () => {
    const adapted = adaptTools(server(), [
      { name: "composed", inputSchema: { type: "object", allOf: [{ type: "object" }] } },
    ]);
    expect(adapted.skipped[0]?.message).toContain("allOf");
  });
});

describe("normalizeInputSchema", () => {
  it("fills a missing inputSchema and a missing properties object", () => {
    expect(normalizeInputSchema(undefined)).toEqual({ ok: true, value: { type: "object", properties: {} } });
    expect(normalizeInputSchema({ type: "object" })).toEqual({ ok: true, value: { type: "object", properties: {} } });
  });

  it("keeps a local $ref (it resolves inside the same document)", () => {
    const schema = { $defs: { s: { type: "string" } }, type: "object", properties: { a: { $ref: "#/$defs/s" } } };
    expect(normalizeInputSchema(schema).ok).toBe(true);
  });
});

describe("disclosure order and result rendering", () => {
  it("sorts by server, then by model-visible name", () => {
    const alpha = adaptTools(server({ name: "alpha" }), [remember]).tools;
    const zeta = adaptTools(server({ name: "zeta" }), [{ name: "b" }, { name: "a" }]).tools;
    expect(sortToolsForDisclosure([...zeta, ...alpha]).map((t) => t.spec.name)).toEqual([
      "mcp__alpha__remember",
      "mcp__zeta__a",
      "mcp__zeta__b",
    ]);
  });

  it("diagnoses unsupported content instead of dropping it", () => {
    const text = renderCallText({
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "…" },
      ],
    });
    expect(text).toContain("hello");
    expect(text).toContain("[unsupported content type: image]");
  });

  it("says so when a call produced no text content", () => {
    expect(renderCallText({ content: [] })).toContain("no text content");
  });
});
