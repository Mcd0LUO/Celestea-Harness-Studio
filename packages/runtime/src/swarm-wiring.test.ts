/**
 * Swarm wiring: the two facts the composition root must get right.
 *
 * Acceptance criteria for this block:
 *   1. compose really REGISTERS the tool into the ToolRegistry — not merely
 *      provides a service. A wiring that only provides would leave the model with
 *      a contract entry it can never call, and nothing would fail until a user
 *      tried to use the tool.
 *   2. swarm: false mounts NOTHING and does not throw (§5.3 — the host may turn it
 *      off, and an off switch that throws is not an off switch).
 *
 * Plus the member-face rule: a member must not see the orchestration tools, and the
 * refusal text must not be the execution-mode guidance (there is no execution mode
 * inside a swarm member).
 */

import {
  Context,
  defaultAgentConfig,
  type Llm,
  type Tool,
  type ToolOutput,
  type ToolRegistry,
} from "@celestea/core";
import { describe, expect, it } from "vitest";
import { SWARM_TOOL_NAME } from "@celestea/swarm";
import { MEMBER_FOLDED_GUIDANCE, ensureSwarmWiring, memberToolFace } from "./swarm-wiring.js";

/** A registry that records registrations and can dispatch by name. */
function recordingRegistry(): { registry: ToolRegistry; names: string[] } {
  const tools = new Map<string, Tool>();
  const names: string[] = [];
  const registry: ToolRegistry = {
    register: (tool) => {
      tools.set(tool.spec().name, tool);
      names.push(tool.spec().name);
    },
    addGuard: () => undefined,
    get: (name) => tools.get(name),
    schemas: () => [...tools.values()].map((t) => t.spec()),
    dispatch: (input) => {
      const tool = tools.get(input.name);
      if (tool === undefined) return Promise.resolve(folded(input.call_id, 'no tool ' + input.name));
      return tool.execute(input.args).then((value) => ({
        call_id: input.call_id,
        value,
        render: null,
        error: null,
        decision: null,
      } satisfies ToolOutput));
    },
  };
  return { registry, names };
}

function folded(callId: string, error: string): ToolOutput {
  return { call_id: callId, value: null, render: null, error, decision: { kind: 'deny', reason: error } };
}

const NO_LLM: Llm = { generate: () => Promise.reject(new Error('unused')) };

const stubTool = (name: string): Tool => ({
  spec: () => ({ name, description: '', parameters: {} }),
  execute: () => Promise.resolve(null),
});

const loopFactoryStub = () => () => ({ async runTurn() { return undefined; } });

function mount(overrides: Record<string, unknown> = {}) {
  const ctx = Context.root();
  const { registry, names } = recordingRegistry();
  ctx.provide('celestea.core.ToolRegistry', registry);
  ctx.provide('celestea.core.Llm', NO_LLM);
  const host = ensureSwarmWiring(ctx, {
    agentConfig: defaultAgentConfig(),
    loopFactory: loopFactoryStub(),
    ...overrides,
  } as Parameters<typeof ensureSwarmWiring>[1]);
  return { ctx, registry, names, host };
}
describe("swarm 装配", () => {
  it("真的把 agent_swarm 注册进了 ToolRegistry（不是只 provide 服务）", () => {
    const { registry, names, host } = mount();
    expect(names).toContain(SWARM_TOOL_NAME);
    expect(registry.get(SWARM_TOOL_NAME)).toBeDefined();
    expect(registry.schemas().map((s) => s.name)).toContain(SWARM_TOOL_NAME);
    expect(host).not.toBeNull();
  });

  it("swarm: false 什么都不挂，且不抛错", () => {
    const ctx = Context.root();
    const { registry, names } = recordingRegistry();
    ctx.provide('celestea.core.ToolRegistry', registry);
    const host = ensureSwarmWiring(ctx, false);
    expect(host).toBeNull();
    expect(names).toEqual([]);
    expect(registry.get(SWARM_TOOL_NAME)).toBeUndefined();
  });

  it("enabled: false 与未配置同样不挂", () => {
    const off = mount({ enabled: false });
    expect(off.host).toBeNull();
    expect(off.names).toEqual([]);
    expect(ensureSwarmWiring(Context.root(), undefined)).toBeNull();
  });

  it("没有 loopFactory 就不挂：成员轮次构造不出来，注册一个必然全败的工具更糟", () => {
    const ctx = Context.root();
    const { registry, names } = recordingRegistry();
    ctx.provide('celestea.core.ToolRegistry', registry);
    const host = ensureSwarmWiring(ctx, { agentConfig: defaultAgentConfig() } as Parameters<typeof ensureSwarmWiring>[1]);
    expect(host).toBeNull();
    expect(names).toEqual([]);
  });

  it("没有 ToolRegistry 时不挂（工具无处可注册）", () => {
    const ctx = Context.root();
    const host = ensureSwarmWiring(ctx, {
      agentConfig: defaultAgentConfig(),
      loopFactory: loopFactoryStub(),
    } as Parameters<typeof ensureSwarmWiring>[1]);
    expect(host).toBeNull();
  });
});

describe("成员工具面：剔除编排类工具（§5.2 防嵌套）", () => {
  it("成员看不到 agent_swarm / spawn_worker，别的工具照常可见", () => {
    const { registry } = recordingRegistry();
    registry.register(stubTool(SWARM_TOOL_NAME));
    registry.register(stubTool('spawn_worker'));
    registry.register(stubTool('read_file'));
    const visible = memberToolFace(registry).schemas().map((s) => s.name);
    expect(visible).toEqual(['read_file']);
    expect(visible).not.toContain(SWARM_TOOL_NAME);
    expect(visible).not.toContain('spawn_worker');
  });

  it("不误伤常驻 worker 工具：send_message / stop_worker / worker_status 保留", () => {
    const { registry } = recordingRegistry();
    for (const name of ['send_message', 'stop_worker', 'worker_status']) registry.register(stubTool(name));
    const visible = memberToolFace(registry).schemas().map((s) => s.name);
    expect(visible).toEqual(['send_message', 'stop_worker', 'worker_status']);
  });

  it("成员调编排工具拿到的是成员该读的拒绝文案，不是 execution 模式那套", async () => {
    const { registry } = recordingRegistry();
    registry.register({ spec: () => ({ name: SWARM_TOOL_NAME, description: '', parameters: {} }), execute: () => Promise.resolve('SHOULD NOT RUN') });
    const out = await memberToolFace(registry).dispatch({ call_id: 'c1', name: SWARM_TOOL_NAME, args: {} });
    expect(out.decision?.kind).toBe('deny');
    expect(out.error).toContain(MEMBER_FOLDED_GUIDANCE.slice(0, 30));
    // 关键否定：成员没有 execution 模式，绝不能被引导去写 run_code 程序。
    expect(out.error).not.toContain('run_code');
    expect(out.error).not.toContain('execution mode');
    // 被折叠的工具绝不能真的执行。
    expect(out.value).toBeNull();
  });
});

