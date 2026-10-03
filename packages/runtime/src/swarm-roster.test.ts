/**
 * Roster wiring: the two facts that make the panel real (feature §7).
 *
 * Before this, `SwarmRegistry` was an ORPHAN — only its own test referenced it — so
 * `Statusline.swarm?` was always absent and the whole front-end deliverable was dark.
 *
 *   1. **After a batch, the roster agrees with the XML.** The XML is the sole
 *      authority on member state (§6); the roster is process visibility. If the two
 *      disagree, the panel contradicts the answer the model is reading.
 *   2. **A failed or cancelled batch still ends.** `beginBatch`/`endBatch` are
 *      try-finally paired: a batch left at `running` shows a spinner forever, and
 *      running batches are never evicted from the registry.
 */

import { Context, defaultAgentConfig, SESSION_LOG_SERVICE, type AgentLoop, type Context as Ctx, type Llm, type SessionLog, type ToolRegistry } from "@celestea/core";
import { describe, expect, it } from "vitest";
import { SwarmRegistry, SWARM_REGISTRY_SERVICE } from "@celestea/swarm";
import { swarmTool, type SwarmLoopBindings, type SwarmToolDeps } from "@celestea/swarm";
import { ensureSwarmWiring } from "./swarm-wiring.js";

const NO_TOOLS: ToolRegistry = {
  register: () => undefined,
  addGuard: () => undefined,
  get: () => undefined,
  schemas: () => [],
  dispatch: (i) => Promise.resolve({ call_id: i.call_id, value: null, render: null, error: null, decision: null }),
};

const NO_LLM: Llm = { generate: () => Promise.reject(new Error('unused')) };

function harness(registry: SwarmRegistry, extra: Partial<SwarmToolDeps> = {}) {
  const loopFactory = (b: SwarmLoopBindings): AgentLoop => ({
    async runTurn(ctx: Ctx, input: string | null): Promise<void> {
      if (b.signal.aborted) throw new Error('aborted');
      ctx.require<SessionLog>(SESSION_LOG_SERVICE).append({ type: 'assistant_message', text: 'ok: ' + (input ?? '') });
    },
  });
  return swarmTool({ llm: NO_LLM, tools: NO_TOOLS, config: defaultAgentConfig(), loopFactory, registry, ...extra });
}

const GOOD = { description: 'my batch', prompt_template: 'handle {{item}}', items: ['a', 'b'] };

describe("roster 接线 ①：跑完批次后 roster 与 XML 终态一致", () => {
  it("成功批次：面板读到的成员相位与 XML 的 outcome 一一对应", async () => {
    const registry = new SwarmRegistry();
    const out = (await harness(registry, { sessionId: 's-1' }).execute(GOOD)) as { xml: string };
    const snap = registry.snapshot('s-1');
    expect(snap).toBeDefined();
    // 批次已收尾：没有 running 悬案。
    expect(snap?.status).toBe('completed');
    expect(snap?.done).toBe(2);
    expect(snap?.total).toBe(2);
    expect(snap?.completedCount).toBe(2);
    // 编号 1-based 且升序（与 XML 同源）。
    expect(snap?.members.map((m) => m.index)).toEqual([1, 2]);
    expect(snap?.members.every((m) => m.phase === 'completed')).toBe(true);
    // 两端一致性：XML 每个成员都报 completed，面板也必须是 completed。
    const xmlCompleted = out.xml.match(/outcome="completed"/g) ?? [];
    expect(xmlCompleted).toHaveLength(2);
    expect(snap?.completedCount).toBe(xmlCompleted.length);
    // 批次描述取模型自己的话（面板标题），不是 re-derivation。
    expect(snap?.description).toBe('my batch');
  });

  it('契约字段 description -> 面板 label、model -> routeLabel 全程不断链', async () => {
    // Lane C 标记的洞：roster.test.ts 的 beginBatch 全传字面量、绕过 tool.ts，
    // 所以「契约 description 到达面板」这条数据流一度零覆盖。机械重构若悄悄丢掉
    // label / routeLabel 参数，**没有任何现有测试会红**。这条钉住整条链路。
    const registry = new SwarmRegistry();
    const withModel = swarmTool({
      llm: NO_LLM,
      tools: NO_TOOLS,
      config: defaultAgentConfig(),
      registry,
      sessionId: 's-1b',
      loopFactory: (): AgentLoop => ({
        async runTurn(ctx: Ctx): Promise<void> {
          ctx.require<SessionLog>(SESSION_LOG_SERVICE).append({ type: 'assistant_message', text: 'ok' });
        },
      }),
      llmRegistry: { resolve: () => NO_LLM } as never,
    });
    await withModel.execute({ ...GOOD, description: 'panel title', model: 'named-model' });
    const snap = registry.snapshot('s-1b');
    // ① 契约的 description 到达面板标题。
    expect(snap?.description).toBe('panel title');
    // ② 契约的 model 到达批次路由标签。
    expect(snap?.routeLabel).toBe('named-model');
  });

  it("成员失败：XML 报 failed，面板也报 failed（两端不得矛盾）", async () => {
    const registry = new SwarmRegistry();
    const tool = harness(registry, {
      loopFactory: () => ({ async runTurn(): Promise<void> { throw new Error('member boom'); } }),
      sessionId: 's-2',
    });
    const out = (await tool.execute(GOOD)) as { xml: string };
    const snap = registry.snapshot('s-2');
    expect(out.xml).toContain('outcome="failed"');
    expect(snap?.status).toBe('failed');
    expect(snap?.failedCount).toBe(2);
    expect(snap?.done).toBe(2);
  });

  it("批次被取消：成员落 aborted（终态只认批次信号）", async () => {
    const registry = new SwarmRegistry();
    const controller = new AbortController();
    controller.abort();
    const out = (await harness(registry, { signal: controller.signal, sessionId: 's-3' }).execute(GOOD)) as { xml: string };
    const snap = registry.snapshot('s-3');
    expect(out.xml).toContain('outcome="aborted"');
    expect(snap?.status).toBe('aborted');
    expect(snap?.abortedCount).toBe(2);
  });
});

describe("roster 接线 ②：抛错/被取消时 roster 仍然 endBatch（不留 running 悬案）", () => {
  it("批次抛异常：工具 reject，但批次已被收尾", async () => {
    const registry = new SwarmRegistry();
    // 触发点换成**批次开始之后**才抛的路径：非法 schedulerConfig 现在在
    // 「任何成员启动之前」就被结构化拒绝（W9290 B1-05），roster 根本还没开批次，
    // 所以断言不到「抛错后仍要收尾」。这里用 deps 的 onProgress 抛错——它同样发生在
    // runWithRoster 的 try 之内，finally 仍必须把批次收掉。
    const tool = harness(registry, {
      sessionId: 's-4',
      onProgress: () => { throw new Error('rejected promise'); },
    });
    await expect(tool.execute(GOOD)).rejects.toBeTruthy();
    const batch = registry.getLatestBatch('s-4');
    expect(batch).toBeDefined();
    expect(batch?.endedAt).not.toBeUndefined();
    // 批次「没跑成」如实报 failed，而不是伪装成 aborted（roster.ts 的兜底语义）。
    expect(batch?.status).toBe('failed');
  });

  it("批次异常路径后 visibleBatches 不会永远留着一个 running 批次", async () => {
    const registry = new SwarmRegistry();
    const tool = harness(registry, { sessionId: 's-5', onProgress: () => { throw new Error('rejected promise'); } });
    await expect(tool.execute(GOOD)).rejects.toBeTruthy();
    for (const b of registry.visibleBatches('s-5')) {
      expect(b.endedAt).not.toBeUndefined();
    }
  });
});

describe("roster 接线 ③：Context token 与 session-scoped 句柄", () => {
  it("wiring 把 registry provide 进 Context，宿主可从 token 取到同一个实例", () => {
    const ctx = Context.root();
    ctx.provide('celestea.core.ToolRegistry', NO_TOOLS);
    const host = ensureSwarmWiring(ctx, {
      agentConfig: defaultAgentConfig(),
      loopFactory: () => ({ async runTurn() { return undefined; } }),
      sessionId: 's-6',
    } as Parameters<typeof ensureSwarmWiring>[1]);
    expect(host).not.toBeNull();
    const fromToken = ctx.get<SwarmRegistry>(SWARM_REGISTRY_SERVICE);
    expect(fromToken).toBeDefined();
    // 句柄与 token 指向同一实例：宿主从任一侧读都是同一份名册。
    expect(fromToken).toBe(host?.registry);
  });

  it("每个 wiring 一个独立 registry（session-scoped，不是进程级单例）", () => {
    const a = Context.root();
    a.provide('celestea.core.ToolRegistry', NO_TOOLS);
    const b = Context.root();
    b.provide('celestea.core.ToolRegistry', NO_TOOLS);
    const wiring = {
      agentConfig: defaultAgentConfig(),
      loopFactory: () => ({ async runTurn() { return undefined; } }),
    } as Parameters<typeof ensureSwarmWiring>[1];
    const hostA = ensureSwarmWiring(a, wiring);
    const hostB = ensureSwarmWiring(b, wiring);
    // 两个会话各读各的：A 的面板绝不会显示 B 的批次。
    expect(hostA?.registry).not.toBe(hostB?.registry);
  });

  it("宿主传入的 registry 优先（宿主可持有它做清理）", () => {
    const ctx = Context.root();
    ctx.provide('celestea.core.ToolRegistry', NO_TOOLS);
    const mine = new SwarmRegistry();
    const host = ensureSwarmWiring(ctx, {
      agentConfig: defaultAgentConfig(),
      loopFactory: () => ({ async runTurn() { return undefined; } }),
      registry: mine,
    } as Parameters<typeof ensureSwarmWiring>[1]);
    expect(host?.registry).toBe(mine);
    expect(ctx.get<SwarmRegistry>(SWARM_REGISTRY_SERVICE)).toBe(mine);
  });
});
