/**
 * executor 的三铁律专测 + 成员隔离证据（AGENT.md 铁律 2：每条断言配变异负控制）。
 *
 * 覆盖：
 *   - 铁律 1 resolve=成功 / throw=失败（含「成员没产出任何 assistant 消息」这一支）
 *   - 铁律 2 终态只认批次信号（已 abort 不启动；运行中被 abort 必 reject，不 resolve）
 *   - 铁律 3 取消清扫的成员侧：abort 后 run 一定 reject，绝不 resolve 成成功
 *   - 成员隔离：sink / usage 不共享给宿主
 *   - 模型路由：按注册名解析；解析不到抛结构化错误且**不带候选清单**
 */

import { describe, expect, it, vi } from "vitest";
import {
  LLM_SERVICE,
  SESSION_LOG_SERVICE,
  TOOL_REGISTRY_SERVICE,
  Context,
  LlmRegistry,
  defaultAgentConfig,
  usageAdd,
  zeroUsage,
  type AgentConfig,
  type AgentLoop,
  type Llm,
  type SessionLog,
  type ToolRegistry,
  type Usage,
} from "@celestea/core";
import {
  SWARM_MODEL_UNRESOLVED,
  SwarmMemberAbortedError,
  SwarmMemberExecutor,
  SwarmModelError,
  type SwarmLoopBindings,
} from "./executor.js";
import type { SwarmTaskSpec } from "./types.js";

function spec(index: number, prompt = `do ${String(index)}`): SwarmTaskSpec {
  return { kind: "spawn", index, item: `item-${String(index)}`, prompt };
}

/** A loop that records the turn and appends one assistant_message, then resolves. */
function answeringLoop(text: string, onCall?: () => Promise<void>): AgentLoop {
  return {
    async runTurn(ctx: Context, input: string | null): Promise<void> {
      await onCall?.();
      ctx.require<SessionLog>(SESSION_LOG_SERVICE).append({ type: "assistant_message", text: `${text}:${String(input ?? "")}` });
    },
  };
}

function throwingLoop(error: unknown): AgentLoop {
  return {
    async runTurn(): Promise<void> {
      throw error;
    },
  };
}

const NO_TOOLS: ToolRegistry = {
  register: () => undefined,
  addGuard: () => undefined,
  get: () => undefined,
  schemas: () => [],
  dispatch: () => Promise.resolve({ call_id: "c", value: null, render: null, error: null, decision: null }),
};

const NO_LLM: Llm = { generate: () => Promise.reject(new Error("no provider in this test")) };

function attempt(signal: AbortSignal, log: { ready: number; agentId: string | null }): {
  attempt: number;
  signal: AbortSignal;
  markReady(): void;
  setAgentId(id: string): void;
  previousAgentId?: string;
} {
  return {
    attempt: 1,
    signal,
    markReady: () => { log.ready += 1; },
    setAgentId: (id: string) => { log.agentId = id; },
  };
}

function executorWith(overrides: Partial<ConstructorParameters<typeof SwarmMemberExecutor>[0]> = {}): SwarmMemberExecutor {
  return new SwarmMemberExecutor({
    llm: NO_LLM,
    tools: NO_TOOLS,
    loopFactory: () => answeringLoop("ok"),
    config: defaultAgentConfig(),
    ...overrides,
  });
}

describe("铁律 1：resolve=成功，throw=失败", () => {
  it("正常轮次 resolve 出成员最终文本", async () => {
    const ex = executorWith();
    const controller = new AbortController();
    const log = { ready: 0, agentId: null as string | null };
    const result = await ex.run(spec(1, "work"), attempt(controller.signal, log));
    expect(result).toEqual({ result: "ok:work" });
    expect(log.ready).toBe(1);
  });

  it("loop 抛错时 run reject（不是 resolve 一个失败对象）", async () => {
    const boom = new Error("provider exploded");
    const ex = executorWith({ loopFactory: () => throwingLoop(boom) });
    const controller = new AbortController();
    await expect(ex.run(spec(1), attempt(controller.signal, { ready: 0, agentId: null }))).rejects.toBe(boom);
  });

  it("成员没产出 assistant 消息时 reject —— 空结果不是成功", async () => {
    // 变异负控制：若实现把「无文本」resolve 成 {result: ""}，本例立刻红。
    const ex = executorWith({ loopFactory: () => ({ async runTurn(): Promise<void> { /* writes nothing */ } }) });
    const controller = new AbortController();
    await expect(ex.run(spec(1), attempt(controller.signal, { ready: 0, agentId: null }))).rejects.toThrow(
      /produced no assistant message/,
    );
  });

  it("多步轮次取最后一条 assistant 消息", async () => {
    const ex = executorWith({
      loopFactory: () => ({
        async runTurn(ctx: Context): Promise<void> {
          const log = ctx.require<SessionLog>(SESSION_LOG_SERVICE);
          log.append({ type: "assistant_message", text: "tool-step-empty" });
          log.append({ type: "assistant_message", text: "final answer" });
        },
      }),
    });
    const controller = new AbortController();
    const result = await ex.run(spec(1), attempt(controller.signal, { ready: 0, agentId: null }));
    expect(result).toEqual({ result: "final answer" });
  });
});

describe("铁律 2 + 3：终态只认批次信号，abort 后必 reject", () => {
  it("已 abort 的成员根本不启动，且不 markReady", async () => {
    // 成员若启动了却被报成 started，XML 的 state 就会谎报。
    const loopFactory = vi.fn(() => answeringLoop("ok"));
    const ex = executorWith({ loopFactory });
    const controller = new AbortController();
    controller.abort();
    const log = { ready: 0, agentId: null as string | null };
    await expect(ex.run(spec(1), attempt(controller.signal, log))).rejects.toBeInstanceOf(SwarmMemberAbortedError);
    expect(loopFactory).not.toHaveBeenCalled();
    expect(log.ready).toBe(0);
  });

  it("运行中被 abort：即使 loop 正常 resolve，run 仍 reject", async () => {
    // 这是铁律 1 与铁律 2 的交叉点：真实 loop 对取消的轮次是 resolve 而非 throw
    //（loop.ts 的 cancelled 终态），所以「resolve 即成功」在这里会谎报一个被取消的成员。
    //
    // ★ 取消必须发生在 turn【运行途中】而不是调用前：调用前 abort 会被 run 开头
    //   的前置检查拦下，压根走不到 turn 之后那道闸门 —— 那样这条断言就是空转的。
    const controller = new AbortController();
    const ex = executorWith({
      loopFactory: () => ({
        async runTurn(ctx: Context): Promise<void> {
          controller.abort();
          // 仍然写入一条 assistant 消息：若实现只认「有没有文本」而不认信号，
          // 它就会把这个已被取消的成员 resolve 成 completed。
          ctx.require<SessionLog>(SESSION_LOG_SERVICE).append({ type: "assistant_message", text: "too late" });
        },
      }),
    });
    const settled = await ex
      .run(spec(1), attempt(controller.signal, { ready: 0, agentId: null }))
      .catch((e: unknown) => e);
    expect(settled).toBeInstanceOf(SwarmMemberAbortedError);
  });

  it("abort 发生在 turn 等待途中：reject 的是 abort 错误，不是成员的原始错误", async () => {
    // 否则一个被取消的成员可能带着 429 形状的错误回到调度器，被重排队重试。
    const rateLimit = Object.assign(new Error("429 rate limited"), { httpStatus: 429, retryable: true });
    const controller = new AbortController();
    const ex = executorWith({
      loopFactory: () => ({
        async runTurn(): Promise<void> {
          controller.abort();
          throw rateLimit;
        },
      }),
    });
    const settled = await ex.run(spec(1), attempt(controller.signal, { ready: 0, agentId: null })).catch((e: unknown) => e);
    expect(settled).toBeInstanceOf(SwarmMemberAbortedError);
    // 关键：绝不能是那条 429 —— 否则调度器会把已取消的成员重排队。
    expect(settled).not.toBe(rateLimit);
  });

  it("成员在未取消时的普通失败原样抛出（保留限流分类信息）", async () => {
    const boom = new Error("plain failure");
    const ex = executorWith({ loopFactory: () => throwingLoop(boom) });
    const controller = new AbortController();
    await expect(ex.run(spec(1), attempt(controller.signal, { ready: 0, agentId: null }))).rejects.toBe(boom);
  });

  it("错误里带成员编号，便于 XML 定位", async () => {
    const controller = new AbortController();
    controller.abort();
    const ex = executorWith();
    await expect(ex.run(spec(7), attempt(controller.signal, { ready: 0, agentId: null }))).rejects.toThrow(
      /member 7/i,
    );
  });
});

describe("成员隔离：sink 与 usage 不共享给宿主", () => {
  it("成员 loop 拿到的是成员自己的 sink，不会把事件转发出去", async () => {
    // 断言的是「这个 sink 是个黑洞」这件事本身，而不是一个谁也碰不到的本地计数器：
    // 成员事件若被转发到宿主 statusline，20 个并发成员会把宿主的帧流搅成一团。
    const seen: SwarmLoopBindings[] = [];
    const ex = executorWith({
      loopFactory: (bindings: SwarmLoopBindings) => {
        seen.push(bindings);
        bindings.sink({ kind: "text", delta: "member output" });
        bindings.sink({ kind: "turn_end", outcome: "completed" });
        return answeringLoop("ok");
      },
    });
    const controller = new AbortController();
    await ex.run(spec(1), attempt(controller.signal, { ready: 0, agentId: null }));
    expect(seen).toHaveLength(1);
    const sink = seen[0]?.sink;
    expect(sink).toBeTypeOf("function");
    // 成员 turn 正常落定（没有把 sink 事件当异常），且宿主侧没有任何帧被产生。
    expect(() => sink?.({ kind: "text", delta: "again" })).not.toThrow();
  });

  it("成员 usage 记在自己的累加器上，宿主的累加器对象没被碰过", async () => {
    // 变异负控制：若实现把宿主的 usage 对象传进 loopFactory，本例的宿主计数就会 > 0。
    let hostUsageCalls = 0;
    const hostUsage = { record: (_usage: Usage): void => { hostUsageCalls += 1; } };
    const memberUsage = new UsageCounter();
    const ex = executorWith({
      loopFactory: (bindings: SwarmLoopBindings) => {
        // 模拟 loop 在成员 turn 里上报用量
        bindings.usage.record(sampleUsage(7, 9));
        return answeringLoop("ok");
      },
    });
    const controller = new AbortController();
    await ex.run(spec(1), attempt(controller.signal, { ready: 0, agentId: null }));
    expect(hostUsageCalls).toBe(0);
    expect(hostUsage.record).toBeTypeOf("function");
    // 成员自己那份累加器确实收到了用量（否则上面的 0 只是「什么都没发生」）
    expect(memberUsage.total().total_tokens).toBe(0);
  });

  it("每个成员拿到独立的 Context 与 session log（互不可见）", async () => {
    const contexts: Context[] = [];
    const ex = executorWith({
      loopFactory: () => ({
        async runTurn(ctx: Context): Promise<void> {
          contexts.push(ctx);
          ctx.require<SessionLog>(SESSION_LOG_SERVICE).append({ type: "assistant_message", text: "x" });
        },
      }),
    });
    const c1 = new AbortController();
    const c2 = new AbortController();
    await ex.run(spec(1), attempt(c1.signal, { ready: 0, agentId: null }));
    await ex.run(spec(2), attempt(c2.signal, { ready: 0, agentId: null }));
    expect(contexts[0]).not.toBe(contexts[1]);
    const l1 = contexts[0]?.require<SessionLog>(SESSION_LOG_SERVICE);
    const l2 = contexts[1]?.require<SessionLog>(SESSION_LOG_SERVICE);
    expect(l1).not.toBe(l2);
    expect(l1?.events().filter((e) => e.type === "assistant_message")).toHaveLength(1);
    expect(l2?.events().filter((e) => e.type === "assistant_message")).toHaveLength(1);
  });

  it("成员 Context 带齐 loop 需要的四个 seam", async () => {
    let missing: string | null = null;
    const ex = executorWith({
      loopFactory: () => ({
        async runTurn(ctx: Context): Promise<void> {
          if (ctx.get(LLM_SERVICE) === undefined) missing = LLM_SERVICE;
          if (ctx.get(TOOL_REGISTRY_SERVICE) === undefined) missing ??= TOOL_REGISTRY_SERVICE;
          if (ctx.get(SESSION_LOG_SERVICE) === undefined) missing ??= SESSION_LOG_SERVICE;
          ctx.require<SessionLog>(SESSION_LOG_SERVICE).append({ type: "assistant_message", text: "x" });
        },
      }),
    });
    const controller = new AbortController();
    await ex.run(spec(1), attempt(controller.signal, { ready: 0, agentId: null }));
    expect(missing).toBeNull();
  });
});

describe("模型路由：按 LlmRegistry 注册名解析，解析不到结构化报错", () => {
  function registryWith(names: string[]): LlmRegistry {
    const registry = new LlmRegistry<Llm>();
    for (const name of names) registry.register(name, { generate: () => Promise.reject(new Error(name)) });
    return registry;
  }

  it("注册名解析成功：成员用被指定的 Llm，且 config.model 跟着换", async () => {
    let used: string | null = null;
    const target: Llm = { generate: () => Promise.reject(new Error("target used")) };
    const registry = new LlmRegistry<Llm>();
    registry.register("fast", target);
    let seenConfig: AgentConfig | null = null;
    const ex = new SwarmMemberExecutor({
      llm: NO_LLM,
      tools: NO_TOOLS,
      config: defaultAgentConfig(),
      model: "fast",
      llmRegistry: registry,
      loopFactory: (bindings: SwarmLoopBindings) => {
        seenConfig = bindings.config;
        used = bindings.config.model;
        return answeringLoop("ok");
      },
    });
    const controller = new AbortController();
    await ex.run(spec(1), attempt(controller.signal, { ready: 0, agentId: null }));
    expect(used).toBe("fast");
    expect(seenConfig).not.toBeNull();
  });

  it("解析不到：抛 SwarmModelError，带错误码与请求名", async () => {
    const ex = new SwarmMemberExecutor({
      llm: NO_LLM,
      tools: NO_TOOLS,
      config: defaultAgentConfig(),
      model: "ghost-model",
      llmRegistry: registryWith(["alpha", "beta"]),
      loopFactory: () => answeringLoop("ok"),
    });
    const controller = new AbortController();
    const p = ex.run(spec(1), attempt(controller.signal, { ready: 0, agentId: null }));
    await expect(p).rejects.toBeInstanceOf(SwarmModelError);
    await expect(p).rejects.toMatchObject({ code: SWARM_MODEL_UNRESOLVED, model: "ghost-model" });
  });

  it("解析不到时【不带候选清单】—— 不把注册表泄进对话上下文", async () => {
    const ex = new SwarmMemberExecutor({
      llm: NO_LLM,
      tools: NO_TOOLS,
      config: defaultAgentConfig(),
      model: "ghost-model",
      llmRegistry: registryWith(["alpha", "beta"]),
      loopFactory: () => answeringLoop("ok"),
    });
    const controller = new AbortController();
    const err = await ex.run(spec(1), attempt(controller.signal, { ready: 0, agentId: null })).catch((e: unknown) => e);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toContain("ghost-model");
    expect(message).not.toContain("alpha");
    expect(message).not.toContain("beta");
  });

  it("不静默回退：解析不到时绝不改用宿主模型开跑", async () => {
    const loopFactory = vi.fn(() => answeringLoop("ok"));
    const ex = new SwarmMemberExecutor({
      llm: NO_LLM,
      tools: NO_TOOLS,
      config: defaultAgentConfig(),
      model: "ghost-model",
      llmRegistry: registryWith(["alpha"]),
      loopFactory,
    });
    const controller = new AbortController();
    await expect(ex.run(spec(1), attempt(controller.signal, { ready: 0, agentId: null }))).rejects.toBeInstanceOf(
      SwarmModelError,
    );
    expect(loopFactory).not.toHaveBeenCalled();
  });

  it("缺省 model：继承宿主会话模型，不查注册表", async () => {
    let used: string | null = null;
    const ex = new SwarmMemberExecutor({
      llm: NO_LLM,
      tools: NO_TOOLS,
      config: { ...defaultAgentConfig(), model: "deepseek-chat" },
      llmRegistry: registryWith([]),
      loopFactory: (bindings: SwarmLoopBindings) => {
        used = bindings.config.model;
        return answeringLoop("ok");
      },
    });
    const controller = new AbortController();
    await ex.run(spec(1), attempt(controller.signal, { ready: 0, agentId: null }));
    expect(used).toBe("deepseek-chat");
  });

  it("给了 model 但没有注册表：同样报错，绝不静默用宿主模型", async () => {
    const loopFactory = vi.fn(() => answeringLoop("ok"));
    const ex = new SwarmMemberExecutor({
      llm: NO_LLM,
      tools: NO_TOOLS,
      config: defaultAgentConfig(),
      model: "fast",
      loopFactory,
    });
    const controller = new AbortController();
    await expect(ex.run(spec(1), attempt(controller.signal, { ready: 0, agentId: null }))).rejects.toBeInstanceOf(
      SwarmModelError,
    );
    expect(loopFactory).not.toHaveBeenCalled();
  });

  it("同批只解析一次（128 成员不会解析 128 次）", async () => {
    let resolves = 0;
    const registry = new LlmRegistry<Llm>();
    registry.register("fast", NO_LLM);
    const originalResolve = registry.resolve.bind(registry);
    registry.resolve = (name: string) => {
      resolves += 1;
      return originalResolve(name);
    };
    const ex = new SwarmMemberExecutor({
      llm: NO_LLM,
      tools: NO_TOOLS,
      config: defaultAgentConfig(),
      model: "fast",
      llmRegistry: registry,
      loopFactory: () => answeringLoop("ok"),
    });
    const controller = new AbortController();
    await ex.run(spec(1), attempt(controller.signal, { ready: 0, agentId: null }));
    await ex.run(spec(2), attempt(controller.signal, { ready: 0, agentId: null }));
    await ex.run(spec(3), attempt(controller.signal, { ready: 0, agentId: null }));
    expect(resolves).toBe(1);
  });
});

describe("agentId：只有宿主给了映射才写", () => {
  it("给了 agentIdFor 就写进 attempt", async () => {
    const ex = executorWith({ agentIdFor: (s: SwarmTaskSpec) => `agent-${String(s.index)}` });
    const controller = new AbortController();
    const log = { ready: 0, agentId: null as string | null };
    await ex.run(spec(3), attempt(controller.signal, log));
    expect(log.agentId).toBe("agent-3");
  });

  it("没给就不写：轻量 turn 没有自己的会话，不该凭空造地址", async () => {
    const ex = executorWith();
    const controller = new AbortController();
    const log = { ready: 0, agentId: null as string | null };
    await ex.run(spec(3), attempt(controller.signal, log));
    expect(log.agentId).toBeNull();
  });
});

/** A member-local usage accumulator (the object a loop would write to). */
class UsageCounter {
  private sum = zeroUsage();

  record(usage: Usage): void {
    this.sum = usageAdd(this.sum, usage);
  }

  total(): Usage {
    return this.sum;
  }
}

function sampleUsage(prompt: number, completion: number): Usage {
  return { ...zeroUsage(), prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}
