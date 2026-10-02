/**
 * End-to-end evidence for the three things §10.2 names, under the REAL assembly.
 *
 * Lane A's validate/result-xml tests cover the moved logic in isolation. These cover
 * what only the integration can show — that the tool really returns the envelope,
 * really refuses a second concurrent call, and really renders a 1-based XML block,
 * with the real scheduler, the real renderer and the real executor behind them.
 *
 * Every batch here runs through `swarmTool()` with production deps; only the member
 * loop and the Llm are fakes (a real provider is not available in unit tests, and a
 * 128-member live batch is a real-machine test, not this file's job).
 */

import {
  SESSION_LOG_SERVICE,
  defaultAgentConfig,
  type AgentLoop,
  type Context,
  type Llm,
  type SessionLog,
  type ToolRegistry,
} from "@celestea/core";
import { describe, expect, it } from "vitest";
import type { SwarmLoopBindings } from "./executor.js";
import { SwarmRegistry } from "./roster.js";
import { SWARM_TOOL_NAME, swarmTool, type SwarmToolDeps } from "./tool.js";

const NO_TOOLS: ToolRegistry = {
  register: () => undefined,
  addGuard: () => undefined,
  get: () => undefined,
  schemas: () => [],
  dispatch: (i) => Promise.resolve({ call_id: i.call_id, value: null, render: null, error: null, decision: null }),
};

const NO_LLM: Llm = { generate: () => Promise.reject(new Error('unused')) };

interface Harness {
  tool: ReturnType<typeof swarmTool>;
  started: string[];
}

/**
 * Build a tool whose member loop answers immediately and records every prompt it
 * ran — `started` is how the tests prove that NO member launched on a refusal.
 */
function harness(overrides: Partial<SwarmToolDeps> = {}, answer: (prompt: string) => string = (x) => 'done: ' + x): Harness {
  const started: string[] = [];
  const loopFactory = (bindings: SwarmLoopBindings): AgentLoop => ({
    async runTurn(ctx: Context, input: string | null): Promise<void> {
      const prompt = input ?? '';
      started.push(prompt);
      if (bindings.signal.aborted) throw new Error('aborted');
      ctx.require<SessionLog>(SESSION_LOG_SERVICE).append({ type: 'assistant_message', text: answer(prompt) });
    },
  });
  return { tool: swarmTool({ llm: NO_LLM, tools: NO_TOOLS, config: defaultAgentConfig(), loopFactory, ...overrides }), started };
}

const GOOD = { description: 'batch', prompt_template: 'handle {{item}}', items: ['a', 'b'] };

describe("端到端 ①：校验失败信封，且没有任何成员被启动", () => {
  it("items 少于 2 → {ok:false, step:'validate', error}", async () => {
    const h = harness();
    const out = (await h.tool.execute({ ...GOOD, items: ['only-one'] })) as { ok: boolean; step: string; error: string };
    expect(out.ok).toBe(false);
    expect(out.step).toBe('validate');
    expect(typeof out.error).toBe('string');
    expect(out.error.length).toBeGreaterThan(0);
    // 关键：校验必须发生在任何成员启动之前。
    expect(h.started).toEqual([]);
  });

  it("模板缺 {{item}} → 同样是 validate 信封，零成员启动", async () => {
    const h = harness();
    const out = (await h.tool.execute({ ...GOOD, prompt_template: 'no placeholder' })) as { ok: boolean; step: string };
    expect(out.ok).toBe(false);
    expect(out.step).toBe('validate');
    expect(h.started).toEqual([]);
  });

  it("校验失败是【结果】不是异常：不 throw", async () => {
    const h = harness();
    await expect(h.tool.execute({ items: [] })).resolves.toBeTruthy();
  });

  it("入参压根不是对象也走信封，不抛 TypeError", async () => {
    const h = harness();
    const out = (await h.tool.execute('nonsense')) as { ok: boolean; step: string };
    expect(out.ok).toBe(false);
    expect(out.step).toBe('validate');
    expect(h.started).toEqual([]);
  });
});
describe("端到端 ②：排他拒绝（同一批里的第二个 agent_swarm）", () => {
  it("并发两个调用：第二个被拒，且【第一个照常跑完】", async () => {
    const h = harness();
    const first = h.tool.execute(GOOD) as Promise<unknown>;
    // 立刻并发发起第二个：它必然落在第一个的 in-flight 窗口内。
    const second = (await h.tool.execute(GOOD)) as { ok: boolean; step: string; error: string };
    expect(second.ok).toBe(false);
    expect(second.step).toBe('exclusive');
    expect(second.error).toContain(SWARM_TOOL_NAME);
    const firstOut = (await first) as { xml?: string; ok?: boolean };
    expect(firstOut.xml).toBeTypeOf('string');
    // 被拒的那个批次一个成员都不该启动（总启动数 = 第一个批次的 2 个成员）。
    expect(h.started).toHaveLength(2);
  });

  it("窗口会关闭：拒绝不会把后续调用永久卡死", async () => {
    const h = harness();
    const first = h.tool.execute(GOOD) as Promise<unknown>;
    await h.tool.execute(GOOD);
    await first;
    // 若 finally 没把计数减回来，这一个会被判成非排他。
    const after = (await h.tool.execute(GOOD)) as { ok?: boolean; step?: string; xml?: string };
    expect(after.step).toBeUndefined();
    expect(after.xml).toBeTypeOf('string');
  });

  it("排他拒绝优先于参数校验（模型一轮只改一件事）", async () => {
    const h = harness();
    const first = h.tool.execute(GOOD) as Promise<unknown>;
    const second = (await h.tool.execute({ items: ['x'] })) as { ok: boolean; step: string };
    expect(second.ok).toBe(false);
    expect(second.step).toBe('exclusive');
    await first;
  });
});

describe("端到端 ③：正常批次出 XML（编号 1-based、按原始编号排序、全部转义）", () => {
  it("2 个成员 → 一个 XML 块，成员按 items 顺序、编号从 1 开始", async () => {
    const h = harness();
    const out = (await h.tool.execute(GOOD)) as { xml: string };
    expect(out.xml).toContain('<agent_swarm_result>');
    expect(out.xml).toContain('<summary>');
    expect(out.xml.match(/<subagent /g)).toHaveLength(2);
    // 上游 D2 的 1-based 口径：本渲染器【不】输出 index 属性，编号一致性由
    // findIndexAlignmentMismatch 在渲染前断言（1 起始、连续、与位置一一对应）。
    // 所以这里能观察到的证据是【顺序】——渲染顺序 = items 顺序，而非完成顺序。
    expect(out.xml.indexOf('item="a"')).toBeGreaterThan(-1);
    expect(out.xml.indexOf('item="a"')).toBeLessThan(out.xml.indexOf('item="b"'));
  });

  it("成员正文里的 XML 尖括号被转义（上游 D1：否则 </subagent> 吞掉整卡）", async () => {
    const h = harness({}, () => 'saw <b>bold</b> and </subagent> literal');
    const out = (await h.tool.execute(GOOD)) as { xml: string };
    // 上游 D1 的真正风险是【未转义的 '<' 让成员正文提前闭合标签、吞掉整卡】。
    // 渲染器刻意做【最小转义】：文本节点只转 '&' 与 '<'（result-xml.ts 的取舍注释：
    // '>' 在文本节点不构成解析歧义，全转会毁掉 'a > b' 这类结果文本的可读性）。
    expect(out.xml).toContain('&lt;b>bold&lt;/b>');
    // 未转义的 '<' 绝不能出现——那正是吞卡的成因。
    expect(out.xml).not.toContain('saw <b>');
    expect(out.xml).not.toContain('and </subagent> literal');
    // 结构完好：恰好 2 个开标签 + 2 个真闭标签（正文里的字面量已是文本，不是标签）。
    expect(out.xml.split('<subagent ').length - 1).toBe(2);
    expect(out.xml.split('</subagent>').length - 1).toBe(2);
  });

  it("成员失败仍出 XML：失败被写进结果而不是变成异常", async () => {
    const h = harness({
      loopFactory: () => ({
        async runTurn(): Promise<void> {
          throw new Error('member exploded');
        },
      }),
    });
    const out = (await h.tool.execute(GOOD)) as { xml: string };
    expect(out.xml).toContain('outcome="failed"');
    expect(out.xml).toContain('member exploded');
  });

  it("批次取消 → 成员落 aborted，仍出 XML", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({ signal: controller.signal });
    const out = (await h.tool.execute(GOOD)) as { xml: string };
    expect(out.xml).toContain('<agent_swarm_result>');
    expect(h.started).toEqual([]);
  });
});

describe("端到端：模型解析不到 → 结构化 model 错误，且零成员启动", () => {
  it("注册表里没有这个名字时，报 model 信封而不是静默回退", async () => {
    const h = harness({ model: 'no-such-model', llmRegistry: { resolve: () => undefined } as never });
    const out = (await h.tool.execute(GOOD)) as { ok: boolean; step: string; error: string };
    expect(out.ok).toBe(false);
    expect(out.step).toBe('model');
    expect(out.error).toContain('no-such-model');
    expect(h.started).toEqual([]);
  });
});
describe("端到端 ④：契约字段真的流到面板数据源（roster）", () => {
  it('契约的 description -> 面板 label 不断链', async () => {
    // Lane C 查出的零覆盖洞：roster.test.ts 的 beginBatch 全部直接传字面量、
    // 绕过 tool.ts，所以「契约 description 到达面板」这条数据流一度没有任何断言。
    // 机械重构若悄悄丢掉 label 参数，不会有任何红灯提醒。
    const registry = new SwarmRegistry();
    const out = (await harness({ registry, sessionId: 'e2e-1' }).tool.execute({
      description: 'panel title',
      prompt_template: 'handle {{item}}',
      items: ['a', 'b'],
    })) as { xml: string };
    expect(out.xml).toContain('<agent_swarm_result>');
    expect(registry.snapshot('e2e-1')?.description).toBe('panel title');
  });

  it('model 解析成功时，解析出的模型名成为批次 routeLabel', async () => {
    const registry = new SwarmRegistry();
    // routeLabel 来自【契约入参的 model】，不是 deps.model：模型是模型给的批次级
    // 路由，面板要显示的正是模型当时指定的名字。
    const tool = harness({
      registry,
      sessionId: 'e2e-2',
      llmRegistry: { resolve: () => NO_LLM } as never,
    }).tool;
    await tool.execute({ description: 'b', prompt_template: 'handle {{item}}', items: ['a', 'b'], model: 'named-model' });
    expect(registry.snapshot('e2e-2')?.routeLabel).toBe('named-model');
  });

  it('没给 model 时 routeLabel 缺省（UI 留空不猜）', async () => {
    const registry = new SwarmRegistry();
    await harness({ registry, sessionId: 'e2e-3' }).tool.execute({
      description: 'b',
      prompt_template: 'handle {{item}}',
      items: ['a', 'b'],
    });
    expect(registry.snapshot('e2e-3')?.routeLabel).toBeUndefined();
  });
});

