// @vitest-environment node
/**
 * D1 · `/mcp:<server>` 的 host 侧注入车道（docs/feature/mcp-client.md §5.6）。
 *
 * 这条链路能坏的方式和技能那条一模一样，且大多是静音的：**host 认了手势却什么都不
 * 注入**，或者**没认却当普通文本放过去**。所以断言全部落在**后果**上——
 *
 *   主场景（铁律 3）：
 *     ① 人点名一个**已连接**的 server ⇒ 注入它的工具清单（名字 + 一行描述），
 *        用户那行文字仍然是用户自己说的话；
 *     ② 人点名一个**不存在 / 没连上 / 没有那个工具**的 ⇒ **响亮失败**，
 *        且工具面一个字都没动。
 *   顺带钉住文档写明的边界：注入不收窄工具面、空清单也有答案、非 mcp 手势不碰。
 *
 * 清单是**注入**进去的 fixture（与生产同一形状：`McpManifestServer`），
 * 因为这条车道的职责只有「按清单裁决 + 注入」，读盘与连接在 engine-mcp 那一侧。
 */
import { describe, expect, it } from "vitest";

import { MCP_CATALOG_TAG, MCP_INVOKE_TAG, MCP_INVOCATION_ORIGIN, mcpInvocation } from "./mcp-wiring.js";
import type { McpManifestServer, McpManifestTool } from "./engine-mcp.js";
import type { AfterInputPlan } from "@celestea/agent-loop";

function tool(name: string, over: Partial<McpManifestTool> = {}): McpManifestTool {
  return { name, tool: name.split("__").slice(2).join("__"), description: "", schema: { type: "object", properties: {} }, ...over };
}

const READY = (): McpManifestServer => ({
  server: "memory",
  state: "ready",
  tools: [
    tool("mcp__memory__create_entities", { description: "在知识图谱里创建实体。\n第二行不该另起一行" }),
    tool("mcp__memory__search_nodes", { description: "按查询搜索节点" }),
  ],
});

/** 一条 source 对一行输入的回答（始终有 source，所以直接解包）。 */
function run(line: string, servers: readonly McpManifestServer[]): AfterInputPlan {
  return mcpInvocation(() => servers)(line);
}

const textOf = (plan: AfterInputPlan): string => plan.rows.map((r) => r.text).join("\n");
const origins = (plan: AfterInputPlan): string[] => plan.rows.map((r) => r.origin);

describe("mcpInvocation · 命中：注入工具清单（不收窄工具面）", () => {
  it("① 已连接的 server ⇒ 注入名字 + 一行描述，且 token 从用户那行剥掉", () => {
    const plan = run("/mcp:memory 记住这条", [READY()]);
    const text = textOf(plan);
    expect(plan.input, "手势 token 已消费，其余是用户原文").toBe("记住这条");
    expect(plan.rows).toHaveLength(1);
    expect(origins(plan)).toEqual([MCP_INVOCATION_ORIGIN]);
    expect(text).toContain("<" + MCP_CATALOG_TAG + " server=\"memory\"");
    expect(text).toContain("mcp__memory__create_entities");
    expect(text).toContain("mcp__memory__search_nodes");
    expect(text).toContain("在知识图谱里创建实体。 第二行不该另起一行");
    expect(text.split("\n").some((line) => line.startsWith("- `mcp__memory__create_entities` — 在知识图谱里创建实体。第二行")),
      "描述必须压成一行（清单是一行一工具）").toBe(false);
  });

  it("注入块明说工具面**没有**被收窄（否则模型会以为自己的工具清单变小了）", () => {
    const text = textOf(run("/mcp:memory", [READY()]));
    expect(text).toContain("工具面没有被收窄");
    expect(text).toContain("其它 MCP server 的工具也照样可用");
  });

  it("只点名 server ⇒ 整行只有工具清单（rest 为空 ⇒ 不写用户行）", () => {
    const plan = run("/mcp:memory", [READY()]);
    expect(plan.input).toBe("");
    expect(textOf(plan)).not.toContain(MCP_TOOL_SCHEMA_HEADING());
  });

  it("第二层点名工具 ⇒ 附上参数摘要（名字 / 类型 / 必填 / 描述）", () => {
    const servers: McpManifestServer[] = [
      {
        server: "memory",
        state: "ready",
        tools: [
          tool("mcp__memory__create_entities", {
            description: "创建实体",
            schema: {
              type: "object",
              required: ["name"],
              properties: { name: { type: "string", description: "实体名" }, notes: { type: "array" } },
            },
          }),
        ],
      },
    ];
    const text = textOf(run("/mcp:memory/create_entities 建一个", servers));
    expect(text).toContain('tool="mcp__memory__create_entities"');
    expect(text).toContain("- `name` (string，必填) — 实体名");
    expect(text).toContain("- `notes` (array，可选)");
    expect(text).toContain("完整 schema 见该工具自己的定义");
  });

  it("第二层点名的工具不存在 ⇒ 不注入半个摘要，走响亮失败", () => {
    const plan = run("/mcp:memory/nope", [READY()]);
    expect(origins(plan)).toEqual([MCP_INVOCATION_ORIGIN]);
    expect(textOf(plan)).toContain("<" + MCP_INVOKE_TAG);
    expect(textOf(plan)).toContain("没有名为「nope」的工具");
    expect(textOf(plan)).not.toContain(MCP_CATALOG_TAG);
  });
});

describe("mcpInvocation · 未命中：响亮失败（工具面一个字都不动）", () => {
  it("② 清单里没有这个 server ⇒ 失败行带原因，用户原文仍归用户", () => {
    const plan = run("/mcp:ghost 干活", [READY()]);
    const text = textOf(plan);
    expect(plan.input).toBe("干活");
    expect(text).toContain('status="failed"');
    expect(text).toContain("这个 host 没有配置名为「ghost」的 MCP server");
    expect(text).toContain("本轮没有注入任何 MCP 工具清单");
    expect(text).toContain("工具面未受影响");
  });

  it("配置了但没连上（connecting / idle / failed）⇒ 失败行如实报出状态词", () => {
    for (const state of ["connecting", "idle", "backoff", "failed", "disposed"]) {
      const text = textOf(run("/mcp:memory", [{ ...READY(), state }]));
      expect(text, state).toContain("<" + MCP_INVOKE_TAG);
      expect(text, state).toContain("当前连接状态是 " + state);
      expect(text, state).not.toContain(MCP_CATALOG_TAG);
    }
  });

  it("清单为空（这个 host 根本没配 MCP）⇒ 仍然响亮，绝不静默放行", () => {
    const plan = run("/mcp:memory", []);
    expect(origins(plan)).toEqual([MCP_INVOCATION_ORIGIN]);
    expect(textOf(plan)).toContain("<" + MCP_INVOKE_TAG);
    expect(plan.input).toBe("");
  });

  it("清单来源坏掉（读出来不是数组）⇒ 走失败，而不是抛穿这一轮", () => {
    const plan = mcpInvocation(() => undefined as unknown as readonly McpManifestServer[])("/mcp:memory");
    expect(textOf(plan)).toContain("<" + MCP_INVOKE_TAG);
  });

  it("server 连上了但这次没暴露出工具 ⇒ 注入块说「没有工具」，不是「没有这个 server」", () => {
    const text = textOf(run("/mcp:memory", [{ server: "memory", state: "ready", tools: [] }]));
    expect(text).toContain("<" + MCP_CATALOG_TAG);
    expect(text).toContain("这个 server 这次没有暴露出任何工具");
  });
});

describe("mcpInvocation · 不是 MCP 手势就完全不碰", () => {
  it("裸 /<name>（技能或命令）与普通文字 ⇒ 一行都不注入、input 也不改写", () => {
    for (const line of ["/review 看看", "/run echo hi", "帮我看看这个", "3/4", ""]) {
      const plan = run(line, [READY()]);
      expect(plan, line).toEqual({ rows: [] });
      expect(plan.input, line).toBeUndefined();
    }
  });

  it("本轮没有输入（null）⇒ passthrough", () => {
    expect(mcpInvocation(() => [READY()])(null)).toEqual({ rows: [] });
  });

  it("技能手势交给技能那条车道（MCP 不吞它）", () => {
    const plan = run("/skill:review 干活", [READY()]);
    expect(plan).toEqual({ rows: [] });
  });

  it("行首空白仍算行首（调用方先 trimStart，token 照样被认出来）", () => {
    const plan = run("  /mcp:memory 干活", [READY()]);
    expect(plan.input).toBe("干活");
    expect(textOf(plan)).toContain("<" + MCP_CATALOG_TAG);
  });
});

describe("mcp-wiring 的标签与 origin 互不串味", () => {
  it("注入块用 mcp_catalog、失败块用 mcp_invoke，且 origin 是 mcp-invocation", () => {
    expect(MCP_CATALOG_TAG).not.toBe(MCP_INVOKE_TAG);
    expect(MCP_INVOCATION_ORIGIN).not.toBe("skill");
    expect(MCP_INVOCATION_ORIGIN).not.toBe("user");
    expect(textOf(run("/mcp:memory", [READY()]))).not.toContain(MCP_INVOKE_TAG);
    expect(textOf(run("/mcp:ghost", [READY()]))).not.toContain(MCP_CATALOG_TAG);
  });

  it("delivered 回调存在且可安全调用（循环在 append 之后才跑它）", () => {
    const plan = run("/mcp:memory", [READY()]);
    expect(() => plan.rows[0]!.delivered()).not.toThrow();
  });
});

/** 与实现同源的标题文本（避免用例里抄一份字面量后与实现各改各的）。 */
function MCP_TOOL_SCHEMA_HEADING(): string {
  return "的参数（摘要，完整 schema 见该工具自己的定义）：";
}
