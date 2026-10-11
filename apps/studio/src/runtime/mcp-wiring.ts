/**
 * D1 · `/mcp:<server>` direct invocation: the host side of
 * `docs/feature/mcp-client.md` §5.6, sitting BESIDE `skill-wiring.ts` (not inside
 * `engine-mcp.ts`, which owns the connection and is not a message producer).
 *
 * Until now an MCP server had exactly ONE arrival path: its tools sit on the tool
 * face and the MODEL decides to call one. This module is the human's way, and it
 * has the same three rules as its sibling — each with a failure that only shows up
 * in production:
 *
 *   1. **The gesture is parsed by ONE function** — `parseSlashGesture` from
 *      `@celestea/gesture`, the same leaf the composer uses. If the host grew its
 *      own looser matcher the transcript would show an MCP listing for a line the
 *      host never recognised (or the reverse): the 「界面看得见、会话调不到」 shape
 *      `docs/feature/skill-command.md` §1.4 exists to prevent.
 *   2. **The manifest is the SAME manifest** — the projection of the very
 *      `session.bindings()` that fed the registry (see `engine-mcp.ts`), never a
 *      second `loadMcpConfig` and never a second connection.
 *   3. **A miss is LOUD** — the human explicitly named a server; injecting nothing
 *      and answering as if all were well is the one unacceptable answer, and it is
 *      also the only thing that lets a stale frontend cache be noticed.
 *
 * **Inject, never narrow** (§5.6 / §3). Narrowing the face to one server would
 * break `DisclosurePolicy`'s three invariants (only grow / tail-append / turn
 * boundary) and pay a cache reheat; the message lane is append-only instead. The
 * injected block therefore SAYS so — a listing that reads like a filter would be
 * the model believing its tool face shrank, which is the exact "提示词在撒谎"
 * failure §5.4 refuses.
 */

import type { AfterInputPlan, AfterInputRow, AfterInputSource } from "@celestea/agent-loop";
import { parseSlashGesture, type SlashGesture } from "@celestea/gesture";

import type { McpManifestServer, McpManifestTool } from "./engine-mcp.js";

/**
 * The injected block's origin. NOT `skill`, NOT a shared MCP catalog value: the
 * resident turn-context dedup keys on origin, so a shared value would let this
 * one-shot listing knock a resident row out (the trap named in
 * `docs/feature/skill-command.md` §2.1).
 */
export const MCP_INVOCATION_ORIGIN = "mcp-invocation" as const;

/**
 * The tag the model reads. It means ONE thing: an MCP server's tool listing
 * follows. A failed invocation uses [MCP_INVOKE_TAG] instead, so "there is a
 * listing here" and "the human asked and we could not deliver" can never be
 * confused — not by the model, and not by a log reader either.
 */
export const MCP_CATALOG_TAG = "mcp_catalog" as const;

/** The visible failure row's tag (see [MCP_CATALOG_TAG] for why it is not the same one). */
export const MCP_INVOKE_TAG = "mcp_invoke" as const;

/**
/** No gesture token → this plan is "write the input exactly as it arrived". */
const PASSTHROUGH: AfterInputPlan = { rows: [] };

/** A row whose `delivered` has nothing to do — nothing is pending to consume. */
function row(text: string): AfterInputRow {
  return { text, origin: MCP_INVOCATION_ORIGIN, delivered: () => undefined };
}

/**
 * The MCP half of this session's after-input lane.
 *
 * `read` is a CALLBACK, not a value: the manifest belongs to a connection that
 * connects asynchronously (§6.1) and is published at a turn boundary (§5.4), so
 * the lane must read it at turn time. That also keeps the lane free of MCP
 * configuration — a host with no MCP at all still answers, loudly, instead of
 * silently passing the line through as plain text.
 */
export function mcpInvocation(read: () => readonly McpManifestServer[]): AfterInputSource {
  return (userInput: string | null): AfterInputPlan => {
    if (userInput === null) return PASSTHROUGH;
    // The gesture must open the line: `3/4` and `a/b` are fractions and paths,
    // not server calls (the same reason the composer's `isCommand` is
    // `startsWith("/")`).
    const gesture = parseSlashGesture(userInput.trimStart());
    if (gesture === null || gesture.kind !== "mcp") return PASSTHROUGH;
    return invoke(read(), gesture);
  };
}

/**
 * The arbitration + injection for one gesture.
 *
 * `gesture.rest` is the user row in BOTH branches, miss included: the token has
 * been answered (by a listing or by a visible failure), but the human's actual
 * words still belong to the human — swallowing them would make a mistyped server
 * name cost the model the whole task.
 */
function invoke(manifest: readonly McpManifestServer[], gesture: SlashGesture): AfterInputPlan {
  const servers = readServers(manifest);
  const found = servers.find((server) => server.server === gesture.name);
  if (found === undefined) return failure(gesture, "这个 host 没有配置名为「" + gesture.name + "」的 MCP server");
  // Configured is not the same as CONNECTED: a server still on `idle` (disabled)
  // or mid-reconnect has no tool list to inject, and pretending otherwise would be
  // the "prompt lies" failure again (§5.6 降级: no row, or a row that says why —
  // never "the click did nothing").
  if (found.state !== "ready") return failure(gesture, "server「" + found.server + "」当前连接状态是 " + found.state + "，还没有可注入的工具清单");
  const tools = found.tools;
  const picked = gesture.tool === undefined ? undefined : tools.find((tool) => tool.tool === gesture.tool);
  if (gesture.tool !== undefined && picked === undefined) {
    return failure(gesture, "server「" + found.server + "」没有名为「" + gesture.tool + "」的工具");
  }
  return {
    input: gesture.rest,
    rows: [row(renderCatalog(found, picked))],
  };
}

/** The manifest as a list, defensively copied into a stable array. */
function readServers(manifest: readonly McpManifestServer[]): readonly McpManifestServer[] {
  return Array.isArray(manifest) ? manifest : [];
}

/** The `<mcp_catalog>` block: the tool listing plus, when named, the schema summary. */
export function renderCatalog(server: McpManifestServer, picked: McpManifestTool | undefined): string {
  const lines = [
    `<${MCP_CATALOG_TAG} server="${server.server}" tools="${server.tools.length}"${picked === undefined ? "" : ` tool="${picked.name}"`}>`,
    "# MCP server: " + server.server,
    "",
  ];
  lines.push(...toolLines(server.tools));
  lines.push(
    "",
    "工具面没有被收窄：以上工具本来就在你的工具清单里，其它 MCP server 的工具也照样可用。",
    "这一行是**注入**（mcp-client.md §5.6「注入，不是收窄」），不是筛选，也不是授权。",
  );
  if (picked !== undefined) lines.push("", ...schemaLines(picked));
  lines.push(`</${MCP_CATALOG_TAG}>`);
  return lines.join("\n");
}

/** One line per tool: model-visible name + its description flattened to one line. */
function toolLines(tools: readonly McpManifestTool[]): string[] {
  if (tools.length === 0) return ["（这个 server 这次没有暴露出任何工具。）"];
  return tools.map((tool) => {
    const description = oneLine(tool.description);
    return `- \`${tool.name}\` ${description === "" ? "（无描述）" : "— " + description}`;
  });
}

/**
 * The schema SUMMARY of one named tool: parameter name, type, required-ness and
 * description — not the raw document.
 *
 * A raw dump would be both unreadable (an MCP `inputSchema` can nest arbitrarily)
 * and redundant: the tool's own spec on the face IS the schema, and this block's
 * job is to let the human's named tool be read at a glance. A summary that says so
 * is honest about being a summary.
 */
function schemaLines(tool: McpManifestTool): string[] {
  const header = `${tool.name} 的参数（摘要，完整 schema 见该工具自己的定义）：`;
  const schema = tool.schema;
  if (!isRecord(schema)) return [header, "（该工具没有可读的 object schema。）"];
  const properties = isRecord(schema.properties) ? schema.properties : null;
  if (properties === null) return [header, "（该工具没有声明 properties。）"];
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter(isText) : []);
  const rows = Object.entries(properties).map(([key, value]) => {
    const type = isRecord(value) && isText(value.type) ? value.type : "any";
    const description = isRecord(value) && isText(value.description) ? oneLine(value.description) : "";
    const flag = required.has(key) ? "必填" : "可选";
    return `- \`${key}\` (${type}，${flag})${description === "" ? "" : " — " + description}`;
  });
  return [header, ...(rows.length === 0 ? ["（该工具不接受参数。）"] : rows)];
}

/** The visible failure row for a gesture that named no usable server or tool. */
function failure(gesture: SlashGesture, why: string): AfterInputPlan {
  const name = gesture.tool === undefined ? gesture.name : gesture.name + "/" + gesture.tool;
  return {
    input: gesture.rest,
    rows: [
      row(
        [
          `<${MCP_INVOKE_TAG} server="${gesture.name}" tool="${gesture.tool ?? ""}" status="failed">`,
          "MCP 调用「" + name + "」失败：" + why + "。",
          "本轮没有注入任何 MCP 工具清单；工具面未受影响。请确认 mcp.json 里该 server 已启用并已连接，或改用普通文字描述任务。",
          `</${MCP_INVOKE_TAG}>`,
        ].join("\n"),
      ),
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

/** Whitespace collapsed to single spaces so a description really is ONE line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
