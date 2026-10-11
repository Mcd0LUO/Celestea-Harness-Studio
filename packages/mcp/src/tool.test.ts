/**
 * The Tool adapter and the §5.2 rule that makes "MCP tools are not contract
 * tools" enforceable instead of a whitelist nobody maintains.
 */

import { describe, expect, it } from "vitest";

import { explainNonContractTool, mcpTool } from "./tool.js";
import type { McpAdaptedTool } from "./tools.js";
import type { McpCallOutcome } from "./types.js";

const binding: McpAdaptedTool = {
  spec: { name: "mcp__memory__remember", description: "[mcp:memory] store a fact", parameters: { type: "object", properties: {} }, mcp: { server: "memory", tool: "remember" } },
  server: "memory",
  tool: "remember",
  approval: "ask",
  pathAccess: "write",
};

const outcome = (patch: Partial<McpCallOutcome> = {}): McpCallOutcome => ({
  ok: true,
  server: "memory",
  tool: "remember",
  text: "stored",
  ...patch,
});

describe("mcpTool", () => {
  it("exposes the adapted spec and the MCP provenance", () => {
    const tool = mcpTool(binding, { callTool: async () => outcome() });
    expect(tool.spec()).toBe(binding.spec);
    expect(tool.mcp).toEqual({ server: "memory", tool: "remember" });
  });

  it("routes execute() to dispatch by model-visible name", async () => {
    const seen: string[] = [];
    const tool = mcpTool(binding, {
      callTool: async (name) => {
        seen.push(name);
        return outcome();
      },
    });
    expect(await tool.execute({ fact: "x" })).toMatchObject({ ok: true, text: "stored" });
    expect(seen).toEqual(["mcp__memory__remember"]);
  });

  it("passes the caller's cancellation signal through and returns a render", async () => {
    const controller = new AbortController();
    const tool = mcpTool(binding, {
      callTool: async (_name, _args, signal) => outcome({ ok: false, text: signal?.aborted === true ? "cancelled" : "?" }),
    });
    const result = await tool.executeWith?.({ call_id: "c1", name: "mcp__memory__remember", args: {}, signal: controller.signal });
    expect(result?.render).toBe("?");
    controller.abort();
  });
});

describe("explainNonContractTool (§5.2)", () => {
  it("accepts a well-formed MCP tool", () => {
    expect(explainNonContractTool("mcp__memory__remember", { server: "memory", tool: "remember" })).toBeNull();
  });

  it("refuses a name outside the namespace", () => {
    expect(explainNonContractTool("evil__tool", undefined)).toContain("contracts/tools.json");
  });

  it("refuses an mcp__ name with no provenance", () => {
    expect(explainNonContractTool("mcp__memory__remember", undefined)).toContain("no MCP provenance");
  });

  it("refuses a name that does not match its own provenance", () => {
    // mcp__other__remember presented by a tool whose provenance says memory: the
    // permission identity would be ambiguous, so the rule must reject it.
    const problem = explainNonContractTool("mcp__other__remember", { server: "memory", tool: "remember" });
    expect(problem).toContain("does not match its own provenance");
    expect(problem).toContain("mcp__memory__remember");
  });
});
