/**
 * B1-01 回归（runtime 接线层）：ensureSwarmWiring 必须把宿主给的**取消源**原样接给工具，
 * 且「轮次之间 = null」不得变成异常。
 *
 * 修复前：session-compose.ts 的 swarmWiring() 返回 {} 且 compose 也不注入，
 * 于是工具的 deps 里没有任何取消通道——一个不配合 abort 的成员会让 tool.execute 永久挂住
 * （audit3-r2/B1/probe-cancel.ts K1，退出码 7）。
 */
import { Context, defaultAgentConfig, type ToolOutput } from "@celestea/core";
import { describe, expect, it } from "vitest";
import { fakeLlm, recordingRegistryPlugin } from "./fakes.test-util.js";
import { ensureSwarmWiring } from "./swarm-wiring.js";

/** 一个只在 signal abort 时才结束的成员循环：取消是它唯一的出路。 */
const STUCK_UNTIL_ABORT = (bindings: { signal: AbortSignal }) => ({
  runTurn: () => new Promise((_resolve, reject) => {
    const s = bindings.signal;
    if (s.aborted) { reject(s.reason); return; }
    s.addEventListener('abort', () => reject(s.reason), { once: true });
  }),
});

const ARGS = { description: 't', prompt_template: 'x {{item}}', items: ['a', 'b'] };

const settledWithin = async (p: Promise<unknown>, ms: number): Promise<boolean> => {
  let done = false;
  void p.then(() => { done = true; }, () => { done = true; });
  await new Promise((r) => setTimeout(r, ms));
  return done;
};

const mountSwarm = (over: Record<string, unknown>) => {
  const registry = recordingRegistryPlugin();
  const ctx = Context.root();
  ctx.provide('celestea.core.ToolRegistry', registry.registry);
  const base = { agentConfig: defaultAgentConfig(), deps: { llm: fakeLlm(), config: defaultAgentConfig() } };
  const host = ensureSwarmWiring(ctx, Object.assign(base, over) as Parameters<typeof ensureSwarmWiring>[1]);
  return { registry, host };
};

describe('B1-01 · ensureSwarmWiring 的取消接线', () => {
  it('signal 指向的 controller 被 abort 时，真实注册表上的 agent_swarm 批次落定', async () => {
    const controller = new AbortController();
    const { registry, host } = mountSwarm({ loopFactory: STUCK_UNTIL_ABORT, signal: () => controller.signal });
    expect(host).not.toBeNull();
    const running = registry.registry.dispatch({ call_id: 'c1', name: 'agent_swarm', args: ARGS });
    await new Promise((r) => setTimeout(r, 40));
    controller.abort(new Error('user pressed stop'));
    expect(await settledWithin(running, 1000)).toBe(true);
    const out = (await running) as ToolOutput;
    // 工具返回 { xml }：批次确实以 aborted 收尾，而不是靠 timeout 兜的 failed。
    expect(String((out.value as { xml: string }).xml)).toContain('aborted');
  });

  it('signal 返回 null（轮次之间）时批次仍能收尾，不因缺取消通道而崩', async () => {
    const { registry } = mountSwarm({
      loopFactory: STUCK_UNTIL_ABORT,
      signal: () => null,
      deps: { llm: fakeLlm(), config: defaultAgentConfig(), schedulerConfig: { initialLaunchLimit: 2, initialLaunchIntervalMs: 1, timeoutMs: 150 } },
    });
    const running = registry.registry.dispatch({ call_id: 'c2', name: 'agent_swarm', args: ARGS });
    expect(await settledWithin(running, 2000)).toBe(true);
  });

  it('完全不传 signal（老宿主）时行为不变：照常挂载，不崩', () => {
    const { registry, host } = mountSwarm({ loopFactory: () => ({ runTurn: async () => undefined }) });
    expect(host).not.toBeNull();
    expect(registry.registry.order).toContain('agent_swarm');
  });
});
