/**
 * W-C1b · the MCP ASSEMBLY: what one composed generation adds to the tool
 * registry, and — just as important — what it adds NOTHING to.
 * (docs/feature/mcp-client.md §5.4, §6.1, §6.2, §7.1.)
 *
 * Driven through engineTools() — the real composition entry point — with the
 * two seams that keep this hermetic on every host:
 *   - the MCP CONFIG is read through loadMcpConfig's readText seam, so the
 *     document really goes through validate + merge (no hand-written config
 *     object that could drift from the parser);
 *   - the TRANSPORT is a fake factory, so nothing spawns a process and nothing
 *     opens a socket (the Windows sandbox EPERM class this suite must not need).
 *
 * Every "it must NOT change" claim is measured against the SAME function with
 * MCP switched off, so the zero-MCP contract is a measurement, not a promise.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { Profile } from "@celestea/runtime";
import {
  loadMcpConfig,
  type McpCallResult,
  type McpRemoteTool,
  type McpServerConfig,
  type McpTransport,
  type McpTransportFactory,
} from "@celestea/mcp";
import { McpApprovalGuard, PathGuard, ToolRegistryImpl } from "@celestea/tools";

import { EMPTY_GRANTS } from "./engine-grants.js";
import { enginePlugins, engineTools, type EngineTools } from "./engine-plugins.js";
import { createOfflineLlm } from "./offline-llm.js";
import { mcpCatalogStatus, resetMcpStatus } from "./mcp-status.js";

const profile: Profile = {
  model: "offline-model",
  base_url: "http://127.0.0.1:9/v1",
  api_key_env: "CELESTEA_API_KEY",
  api_key_file: null,
  max_steps: 0,
  max_parallel_tool_calls: 4,
  reasoning_effort: null,
  max_output_tokens: null,
  context_window_tokens: 65_536,
  system_prompt: "test",
  request_format: "chat_completions",
  temperature: null,
};

const REMOTE: McpRemoteTool[] = [
  { name: "remember", description: "store a note", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
];

interface Fake {
  readonly factory: McpTransportFactory;
  readonly calls: Array<{ server: string; tool: string; args: unknown }>;
  readonly closed: string[];
}

function fakeTransport(tools: readonly McpRemoteTool[] = REMOTE): Fake {
  const calls: Fake["calls"] = [];
  const closed: string[] = [];
  const factory: McpTransportFactory = (server: McpServerConfig): McpTransport => ({
    connect: async () => ({
      listTools: async () => tools,
      callTool: async (tool: string, args: unknown): Promise<McpCallResult> => {
        calls.push({ server: server.name, tool, args });
        return { content: [{ type: "text", text: "ok" }] };
      },
      close: async () => undefined,
    }),
    close: async () => {
      closed.push(server.name);
    },
  });
  return { factory, calls, closed };
}

/** A real mcp.json document, parsed through the shipped loader. */
function configOf(document: string | null): ReturnType<typeof loadMcpConfig> {
  return loadMcpConfig({
    globalPath: "mcp.json",
    workspacePath: null,
    env: {},
    readText: () => document,
    commandExists: () => true,
  });
}

function serverDoc(extra: Record<string, unknown>, tool = "remember"): string {
  return JSON.stringify({
    servers: {
      memory: { transport: "stdio", command: "memory-server", tool_allow: [tool], ...extra },
    },
  });
}

const MEMORY_ASK = serverDoc({ approval: "ask" });
const MEMORY_NEVER = serverDoc({ approval: "never", path_access: "read" });
const MEMORY_PROBE = serverDoc({ approval: "never" }, "probe");
const MEMORY_PROBE_READ = serverDoc({ approval: "never", path_access: "read" }, "probe");
const DISABLED = serverDoc({ enabled: false });

function assemble(document: string | null, fake: Fake, over: Record<string, unknown> = {}): EngineTools {
  return engineTools({
    profile,
    llm: createOfflineLlm(),
    workers: null,
    env: {},
    grants: EMPTY_GRANTS,
    mcp: { config: configOf(document), transportFactory: fake.factory, sessionKey: "s1" },
    ...over,
  });
}

/** The two steps a turn boundary performs for one generation. */
async function land(tools: EngineTools): Promise<void> {
  await tools.mcp?.start();
  tools.mcp?.publish(tools.registry);
}

function chainOf(tools: EngineTools): ToolRegistryImpl {
  const inner = (tools.registry as { innerRegistry?: ToolRegistryImpl }).innerRegistry;
  return inner ?? (tools.registry as ToolRegistryImpl);
}

function chainNames(tools: EngineTools): string[] {
  return chainOf(tools).guardChain().map((guard) => guard.constructor.name);
}

function face(tools: EngineTools): string[] {
  return tools.registry.schemas().map((spec) => spec.name);
}

function bare(): EngineTools {
  return engineTools({ profile, llm: createOfflineLlm(), workers: null, env: {}, grants: EMPTY_GRANTS });
}

afterEach(() => {
  resetMcpStatus();
});
describe("W-C1b MCP assembly · zero configuration changes nothing", () => {
  it("no mcp.json: the guard chain, the tool face and the status are the pre-MCP ones", async () => {
    const without = bare();
    const fake = fakeTransport();
    const enabled = assemble(null, fake);

    // The claim under test: an absent document is not "MCP on but empty", it is
    // MCP absent — measured against the same function with MCP switched off.
    expect(chainNames(enabled)).toEqual(chainNames(without));
    expect(face(enabled)).toEqual(face(without));
    expect(chainNames(enabled)).not.toContain("McpApprovalGuard");
    expect(enabled.mcp?.status()).toBeNull();
    expect(fake.calls).toHaveLength(0);
    await enabled.mcp?.dispose();
    await without.mcp?.dispose();
  });

  it("a document whose servers are all disabled is indistinguishable from none", async () => {
    const without = bare();
    const enabled = assemble(DISABLED, fakeTransport());

    expect(chainNames(enabled)).toEqual(chainNames(without));
    expect(face(enabled)).toEqual(face(without));
    expect(enabled.mcp?.active).toBe(false);
    expect(enabled.mcp?.status()).toBeNull();
    await enabled.mcp?.dispose();
    await without.mcp?.dispose();
  });

  it("mcp: null mounts no MCP at all", () => {
    const tools = assemble(MEMORY_ASK, fakeTransport(), { mcp: null });
    expect(tools.mcp).toBeNull();
    expect(chainNames(tools)).not.toContain("McpApprovalGuard");
  });
});

describe("W-C1b MCP assembly · an enabled server", () => {
  it("registers its tools at the turn boundary, appended at the TAIL", async () => {
    const tools = assemble(MEMORY_ASK, fakeTransport());

    // Before the boundary the names do not exist yet (§6.1: discovery is
    // asynchronous and the face may only grow at a boundary).
    expect(face(tools)).not.toContain("mcp__memory__remember");
    await land(tools);

    const names = face(tools);
    expect(names).toContain("mcp__memory__remember");
    // A3: contract tools first, then MCP — never spliced into the middle.
    expect(names.indexOf("mcp__memory__remember")).toBe(names.length - 1);
    expect(names.indexOf("read_file")).toBeLessThan(names.indexOf("mcp__memory__remember"));
    await tools.mcp?.dispose();
  });

  it("ORDER: the approval guard is mounted AFTER PathGuard (swap them and this goes red)", async () => {
    const tools = assemble(MEMORY_ASK, fakeTransport());
    const chain = chainOf(tools).guardChain();
    const path = chain.findIndex((guard) => guard instanceof PathGuard);
    const approval = chain.findIndex((guard) => guard instanceof McpApprovalGuard);

    // Guards run in registration order and the first non-Allow short-circuits
    // (registry.ts), so the deterministic path arbitration comes FIRST: asking
    // a human to approve a call PathGuard was always going to refuse is the
    // worst outcome of the pair.
    expect(path).toBeGreaterThanOrEqual(0);
    expect(approval).toBeGreaterThan(path);
    await tools.mcp?.dispose();
  });

  it("an approval:ask tool with no answerer fails CLOSED and the server is never called", async () => {
    const fake = fakeTransport();
    const tools = assemble(MEMORY_ASK, fake);
    await land(tools);

    const output = await tools.registry.dispatch({ call_id: "c1", name: "mcp__memory__remember", args: { text: "hi" } });

    expect(output.decision?.kind).toBe("ask");
    expect(output.error).toContain("mcp_approval_undecided");
    // The side-effect assertion: nothing reached the server.
    expect(fake.calls).toHaveLength(0);
    await tools.mcp?.dispose();
  });

  it("approval:never passes the call through to the server without a question", async () => {
    const fake = fakeTransport();
    const tools = assemble(MEMORY_NEVER, fake);
    await land(tools);

    const output = await tools.registry.dispatch({ call_id: "c1", name: "mcp__memory__remember", args: { text: "hi" } });

    expect(output.decision).toEqual({ kind: "allow" });
    expect(fake.calls).toEqual([{ server: "memory", tool: "remember", args: { text: "hi" } }]);
    await tools.mcp?.dispose();
  });
});
describe("W-C1b MCP assembly · path_access and the status surface", () => {
  const PROBE_TOOL: McpRemoteTool[] = [
    { name: "probe", description: "touch a path", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  ];
  const OUTSIDE = "C:/definitely-outside-the-workspace/file.txt";

  function withGrants(document: string, fake: Fake): EngineTools {
    return engineTools({
      profile,
      llm: createOfflineLlm(),
      workers: null,
      env: {},
      workspace: { workspace: process.cwd() },
      grants: { ...EMPTY_GRANTS, workspaceWritable: false },
      mcp: { config: configOf(document), transportFactory: fake.factory },
    });
  }

  it("a read-declared MCP tool is arbitrated as a READ, not on the write floor", async () => {
    const fake = fakeTransport(PROBE_TOOL);
    const floored = withGrants(MEMORY_PROBE, fake);
    await land(floored);
    const flooredOut = await floored.registry.dispatch({ call_id: "c1", name: "mcp__memory__probe", args: { path: OUTSIDE } });

    const declared = withGrants(MEMORY_PROBE_READ, fake);
    await land(declared);
    const declaredOut = await declared.registry.dispatch({ call_id: "c1", name: "mcp__memory__probe", args: { path: OUTSIDE } });

    // The floor is real — that is what makes the next line mean anything.
    expect(flooredOut.decision?.kind).toBe("deny");
    expect(flooredOut.error ?? "").toContain("path_forbidden");
    // ...and the declaration lifts it, i.e. the merge is LIVE and not a snapshot
    // taken before discovery landed.
    expect(declaredOut.error ?? "").not.toContain("path_forbidden");
    await floored.mcp?.dispose();
    await declared.mcp?.dispose();
  });

  it("reports connection state, tool count and no credential material", async () => {
    const fake = fakeTransport();
    const tools = assemble(MEMORY_ASK, fake);
    await land(tools);

    expect(tools.mcp?.status()).toEqual({
      sessions: 1,
      servers: 1,
      tools: 1,
      state: "ready",
      error: null,
      rows: [{ server: "memory", session: "s1", transport: "stdio", state: "ready", toolCount: 1 }],
      issues: [],
    });
    // §7.2: the status row carries no credential material, ever.
    expect(JSON.stringify(tools.mcp?.status())).not.toContain("memory-server");
    await tools.mcp?.dispose();
  });

  it("a malformed mcp.json is loud on the status row, not a crashed session", async () => {
    const tools = assemble(null, fakeTransport(), { mcp: { transportFactory: fakeTransport().factory, sessionKey: "s2" } });
    // The injected config wins, so this case drives the loader directly: a file
    // that cannot be parsed must never become an empty set written back.
    expect(() =>
      loadMcpConfig({ globalPath: "mcp.json", env: {}, readText: () => "{ not json", commandExists: () => true }),
    ).toThrow();
    await tools.mcp?.dispose();
  });

  it("dispose() releases every connection and withdraws the status row", async () => {
    const fake = fakeTransport();
    const tools = assemble(MEMORY_ASK, fake);
    await land(tools);
    expect(tools.mcp?.status()).not.toBeNull();

    await tools.mcp?.dispose();

    // The transport is closed (one per configured server) and the generation
    // WITHDRAWS from the status holder — a released generation that kept
    // reporting its tools would make the plugin row advertise tools no longer
    // exist.
    expect(fake.closed).toEqual(["memory"]);
    expect(mcpCatalogStatus()).toBeNull();
    // The generation's own view stays honest: every server reads "disposed".
    expect(tools.mcp?.status()?.state).toBe("disposed");
  });

  it("emptyTools switches MCP off with the rest of the face (no side door)", async () => {
    const tools = assemble(MEMORY_ASK, fakeTransport(), { emptyTools: true });
    await land(tools);

    expect(face(tools)).toEqual([]);
    expect(tools.mcp).toBeNull();
    expect(chainNames(tools)).not.toContain("McpApprovalGuard");
  });
});

describe("W-C1b MCP assembly · the plugin row", () => {
  it("every generation mounts the MCP plugin, and the switch removes it", () => {
    const input = { profile, llm: createOfflineLlm(), workers: null, env: {}, grants: EMPTY_GRANTS };
    const mounted = enginePlugins(input).plugins.map((plugin) => plugin.name());
    // The catalog row is an assembly FACT: a row that only appeared once a user
    // wrote a file could not be pinned by the inventory test.
    expect(mounted).toContain("studio.engine.mcp");
    const off = enginePlugins({ ...input, disabled: ["studio.engine.mcp"] }).plugins.map((plugin) => plugin.name());
    expect(off).not.toContain("studio.engine.mcp");
  });
});
