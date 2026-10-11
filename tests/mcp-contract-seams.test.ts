/**
 * W-C1b · the seams that are duplicated on purpose, pinned together.
 *
 * 1. `MCP_TOOL_PREFIX` is declared in BOTH `@celestea/mcp` (the naming owner)
 *    and `@celestea/tools` (the approval guard, which may not import an L1 peer
 *    — ARCHITECTURE.md §1.4). Two literals that must never differ, so this is a
 *    mechanical cross-check rather than a comment.
 * 2. §5.2/D4: MCP tools are DYNAMIC — they never enter the frozen tool contract.
 *    The exemption is only real while the two contract numbers still agree, so
 *    `FROZEN_COUNTS.tools` and `contracts/tools.json` are asserted here too.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { MCP_TOOL_PREFIX as MCP_PREFIX, mcpToolName } from "@celestea/mcp";
import { FROZEN_COUNTS } from "@celestea/core";
import { MCP_TOOL_PREFIX as GUARD_PREFIX } from "@celestea/tools";

const CONTRACT_TOOLS = JSON.parse(readFileSync("contracts/tools.json", "utf8")) as { tools: Array<{ name: string }> };

describe("W-C1b the two mcp__ prefixes are one literal", () => {
  it("the guard's prefix is the naming owner's prefix", () => {
    expect(GUARD_PREFIX).toBe(MCP_PREFIX);
  });

  it("and the names it arbitrates are the names the client mints", () => {
    expect(mcpToolName("memory", "remember")).toBe(`${GUARD_PREFIX}memory__remember`);
  });
});

describe("W-C1b MCP tools stay OUT of the frozen contract", () => {
  it("no contract tool occupies the reserved namespace (A2)", () => {
    expect(CONTRACT_TOOLS.tools.filter((tool) => tool.name.startsWith(GUARD_PREFIX))).toEqual([]);
  });

  it("the frozen tool count is unchanged by the MCP client (D4)", () => {
    expect(CONTRACT_TOOLS.tools).toHaveLength(FROZEN_COUNTS.tools);
    // computer-use 把锚点带到 36（13 个 desktop_*）；MCP 的承诺是「一个都不加」，见上一条。
    expect(FROZEN_COUNTS.tools).toBe(36);
  });
});
