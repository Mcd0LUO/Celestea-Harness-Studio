/**
 * Naming: `mcp__<server>__<tool>`, and the no-collision guarantee
 * (docs/feature/mcp-client.md §5.1).
 *
 * The load-bearing assertion here is the LAST one: sanitisation is lossy, so
 * without the hash suffix two different MCP identifiers would share one
 * model-visible name — and that name is also the permission identity.
 */

import { describe, expect, it } from "vitest";

import { identityHash, isMcpToolName, mcpToolName, sanitizeSegment } from "./naming.js";
import { MCP_TOOL_NAME_MAX } from "./types.js";

describe("mcpToolName", () => {
  it("joins server and tool with the reserved prefix", () => {
    expect(mcpToolName("memory", "remember")).toBe("mcp__memory__remember");
    expect(isMcpToolName("mcp__memory__remember")).toBe(true);
    expect(isMcpToolName("read_file")).toBe(false);
  });

  it("sanitises illegal characters to '_'", () => {
    expect(sanitizeSegment("a.b c")).toBe("a_b_c");
    expect(mcpToolName("mem ory", "re member")).toMatch(/^mcp__mem_ory__re_member_[0-9a-f]{12}$/);
  });

  it("appends a 12-hex hash exactly when the shape changed", () => {
    const degraded = mcpToolName("mem.ory", "remember");
    expect(degraded).not.toBe("mcp__mem_ory__remember");
    expect(degraded.endsWith(identityHash("mem.ory", "remember"))).toBe(true);
    expect(identityHash("mem.ory", "remember")).toMatch(/^[0-9a-f]{12}$/);
  });

  it("never collapses two different identifiers into one model-visible name", () => {
    const names = new Set([
      mcpToolName("a.b", "read"),
      mcpToolName("a b", "read"),
      mcpToolName("a-b", "read"),
      mcpToolName("a.b", "read_write"),
    ]);
    expect(names.size).toBe(4);
  });

  it("keeps the hash at the end when a long name has to be truncated", () => {
    const long = mcpToolName("s".repeat(40), "t".repeat(40));
    expect(long.length).toBeLessThanOrEqual(MCP_TOOL_NAME_MAX);
    expect(long.endsWith(identityHash("s".repeat(40), "t".repeat(40)))).toBe(true);
  });
});
