/**
 * B1-01 回归：宿主必须真有一条**取消通道**通到每一批 swarm，且是「每批现问」而不是
 * 装配期就钉死的某一个信号。
 *
 * 修复前（audit3-r2/B1/probe-cancel.ts K1，退出码 7）：
 * `session-compose.ts` 的 `swarmWiring()` 返回 `{}` → `deps.signal === undefined` →
 * 一个只在 abort 时才结束的成员让 `tool.execute()` **1200ms 仍未 settle**。
 */
import {
  defaultAgentConfig,
  type AgentLoop,
  type Context,
  type Llm,
  type ToolRegistry,
} from "@celestea/core";
import { describe, expect, it } from "vitest";
import type { SwarmLoopBindings } from "./executor.js";
import { swarmTool, type SwarmToolDeps } from "./tool.js";

const NO_TOOLS: ToolRegistry = {
  register: () => undefined,
  addGuard: () => undefined,
  get: () => undefined,
  schemas: () => [],
  dispatch: (i) => Promise.resolve({ call_id: i.call_id, value: null, render: null, error: null, decision: null }),
};

const NO_LLM: Llm = { generate: () => Promise.reject(new Error("unused")) };

/**
 * 一个**只在 signal abort 时才结束**的成员循环：取消是它唯一的出路。
 *
 * 这正是 P0 的现场形态——一个「不配合 abort」的成员。它与 B1-02 的用例互为对照：
 * 那个由 `timeoutMs` 闸门救，这个由批次 signal 救。两条通道缺一，整批就挂死。
 */
const stuckUntilAborted = (bindings: SwarmLoopBindings): AgentLoop => ({
  runTurn: () =>
    new Promise<never>((_resolve, reject) => {
      if (bindings.signal.aborted) { reject(bindings.signal.reason); return; }
      bindings.signal.addEventListener("abort", () => reject(bindings.signal.reason), { once: true });
    }),
});

const ARGS = { description: "probe", prompt_template: "handle {{item}}", items: ["a", "b", "c"] };

/** 有界等待：挂死的 Promise 会让 await 永远不返回，所以先用一个独立的钟来判断。 */
const settledWithin = async (p: Promise<unknown>, ms: number): Promise<boolean> => {
  let done = false;
  void p.then(() => { done = true; }, () => { done = true; });
  await new Promise((r) => setTimeout(r, ms));
  return done;
};

describe("B1-01 · 批次取消必须有一条真实通道", () => {
  it("signalProvider 解析出的信号 abort ⇒ tool.execute 落定", async () => {
    const controller = new AbortController();
    const tool = swarmTool({
      llm: NO_LLM,
      tools: NO_TOOLS,
      config: defaultAgentConfig(),
      loopFactory: stuckUntilAborted,
      signalProvider: () => controller.signal,
      schedulerConfig: { initialLaunchLimit: 3, initialLaunchIntervalMs: 1 },
    } satisfies Partial<SwarmToolDeps> as SwarmToolDeps);

    const running = tool.execute(ARGS);
    setTimeout(() => controller.abort(new Error("user pressed stop")), 50);

    expect(await settledWithin(running, 1000)).toBe(true);
    const out = (await running) as { xml: string };
    expect(out.xml).toContain("aborted");
  });

  it("每批现问：换一轮的信号，新的一批仍可被取消（装配期钉死单个信号会在这里红）", async () => {
    const first = new AbortController();
    const second = new AbortController();
    // 两批各自看到**自己那一轮**的信号——这正是「每批现问」与「装配期钉死」的唯一区别。
    const seen: AbortSignal[] = [];
    let turn = 0;
    const tool = swarmTool({
      llm: NO_LLM,
      tools: NO_TOOLS,
      config: defaultAgentConfig(),
      loopFactory: stuckUntilAborted,
      signalProvider: () => {
        const s = turn === 0 ? first.signal : second.signal;
        seen.push(s);
        return s;
      },
      schedulerConfig: { initialLaunchLimit: 3, initialLaunchIntervalMs: 1 },
    } satisfies Partial<SwarmToolDeps> as SwarmToolDeps);

    turn = 0;
    const batch1 = tool.execute(ARGS);
    setTimeout(() => first.abort(new Error("stop turn 1")), 50);
    expect(await settledWithin(batch1, 1000)).toBe(true);

    turn = 1;
    const batch2 = tool.execute(ARGS);
    setTimeout(() => second.abort(new Error("stop turn 2")), 50);
    expect(await settledWithin(batch2, 1000)).toBe(true);

    expect(seen).toEqual([first.signal, second.signal]);
  });

  it("无任何取消来源时行为不变：只剩 timeoutMs 一条路，不会假装能取消", async () => {
    const tool = swarmTool({
      llm: NO_LLM,
      tools: NO_TOOLS,
      config: defaultAgentConfig(),
      loopFactory: stuckUntilAborted,
      schedulerConfig: { initialLaunchLimit: 3, initialLaunchIntervalMs: 1, timeoutMs: 120 },
    } satisfies Partial<SwarmToolDeps> as SwarmToolDeps);

    // 无 signal 时唯一出路是成员自己的 timeoutMs：B1-02 的闸门在此生效。
    expect(await settledWithin(tool.execute(ARGS), 1000)).toBe(true);
  });
});

void (undefined as unknown as Context);
