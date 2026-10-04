/**
 * W9322 — **引擎层插件换代**（`docs/feature-plugin-hotswap.md` §3.1/§4/§6.2）。
 *
 * 这一条是整件事的硬约束所在：
 *
 *   关掉一个引擎层插件后，**下一 turn 边界**起该插件带来的工具必须从
 *   `GET /api/tools` **与**模型 prompt **同时**消失，而**正在跑的 turn 不受影响**。
 *
 * 「同时」不是修辞：`packages/swarm/src/plugin.ts` 的 [swarmPlugin] 原注释写着 contracts 是
 * `GET /api/tools` 与模型 prompt 的单一真源，「a lazy registration would let the
 * contract and the prompt disagree」。本文件用**同一个回合**的两个观测面同时断言：
 *
 *   · 合约面：`GET /api/tools?session=…`（`RealRuntimeAdapter.sessionTools`）
 *   · prompt 面：`ModelRequest.system` 里 `{{tools}}` 渲染出来的那一行，
 *     以及 `ModelRequest.tools`（模型真正被交付的工具表）
 *
 * 三个观测面都来自**同一个** `registry.schemas()`：prompt 的 `{{tools}}` 由
 * `assembleSystemPromptFor` -> `toolsOf(deps, sessionId)` 渲染，也就是
 * `sessionTools`；`ModelRequest.tools` 是 loop 从同一个 Context 的注册表取的。
 *
 * ## 变异负控制（§6.2 明确要求）
 *
 * 本文件的第 ② 条用例（「正在跑的 turn 不受影响」）依赖 `hold`：模型步被**测试**
 * 卡住，所以 PUT 一定发生在 turn 中途。把 `session-compose.ts` 里
 * `enginePlugins({ disabled: disabledPlugins })` 的过滤删掉之后，第 ① 条会红在
 * 「工具没消失」上——`results/W9322-插件热插拔.md` 记了原始红色输出。
 */

import { afterEach, describe, expect, it } from "vitest";
import type { ModelRequest } from "@celestea/core";
import { getJson, jsonRequest, type StudioHarness } from "../harness.test-util.js";
import { activate, engineOf, makeEngineHarness, runTurnWithFrames, turns } from "./test-util.js";

const harnesses: StudioHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

interface Observed {
  tools: string[];
  system: string;
}

/** 每个被记录下来的模型请求（工具表 + 系统提示）。 */
type Recorder = Observed[];

function open(opts: { hold?: Promise<void> } = {}): { h: StudioHarness; seen: Recorder } {
  const seen: Recorder = [];
  const h = makeEngineHarness({
    sessions: { s1: turns(1) },
    llm: {
      ...(opts.hold === undefined ? {} : { script: [{ text: "答", hold: opts.hold }] }),
      onRequest: (req: ModelRequest) => seen.push({ tools: req.tools.map((t) => t.name), system: req.system ?? "" }),
    },
  });
  harnesses.push(h);
  return { h, seen };
}

async function putDisabled(h: StudioHarness, names: readonly string[]): Promise<{ status: number; body: Record<string, unknown> }> {
  return getJson(h.app, "/api/plugins", jsonRequest("PUT", { disabled: [...names] }));
}

/** 这个会话当前那一代的工具名（合约面）。 */
async function toolsOf(h: StudioHarness, session: string): Promise<string[]> {
  const res = await getJson(h.app, `/api/tools?session=${encodeURIComponent(session)}`);
  return (res.body["tools"] as Array<{ name: string }>).map((t) => t.name);
}

/**
 * The `{{tools}}` line of the assembled system prompt.
 *
 * The prompt is the SECOND face of the tool contract, and it is the one that is
 * easy to get wrong: `store/builtin-sections.ts` renders
 * `Tool access: call tools directly ({{tools}}); …`, so the parenthesised list IS
 * the tool face inside the prompt. The surrounding prose mentions `read_file` /
 * `run_shell` by name as static text and must not be confused with the list.
 */
function toolsLine(system: string): string {
  return system.split("\n").find((l) => l.includes("call tools directly (")) ?? "";
}

const SESSION = "sample-ws/s1";

describe("W9322 engine-layer hot swap · next turn boundary", () => {
  it("① disabling studio.engine.tools removes its tools from GET /api/tools AND the model prompt at the same boundary", async () => {
    const { h, seen } = open();
    await activate(h, SESSION);

    const before = await toolsOf(h, SESSION);
    expect(before).toContain("read_file");
    expect(before).toContain("run_shell");
    expect(before.length).toBeGreaterThan(5);

    await runTurnWithFrames(h, "第一轮");
    expect(seen.at(-1)?.tools).toEqual(before);
    // The prompt advertises the SAME names — the single-source rule. The line is
    // `call tools directly (<names>)`, so every name on the face is in it.
    expect(toolsLine(seen.at(-1)?.system ?? "")).toContain("read_file");
    expect(toolsLine(seen.at(-1)?.system ?? "")).toContain("run_shell");

    const res = await putDisabled(h, ["studio.engine.tools"]);
    expect(res.status).toBe(200);
    expect(res.body["disabled"]).toEqual(["studio.engine.tools"]);

    // The registry seam STAYS (it is a REQUIRED seam at turn time —
    // `resolveSeams()` throws without it), so the plugin name stays too; what
    // disappears is every tool inside it.
    await activate(h, SESSION);
    expect(engineOf(h).pluginNames(SESSION)).toContain("studio.engine.tools");

    // ...and both faces agree: the contract is empty and the prompt no longer
    // names a single tool.
    const after = await toolsOf(h, SESSION);
    expect(after).toEqual([]);

    await runTurnWithFrames(h, "第二轮");
    expect(seen.at(-1)?.tools).toEqual([]);
    // The prompt's `{{tools}}` line is rendered from the SAME registry, so it is
    // now empty. (The rest of the template still MENTIONS read_file/run_shell by
    // name — that prose is static and is not the tool list; the list is the
    // parenthesised value `{{tools}}` expands to.)
    expect(seen.at(-1)?.system ?? "").toContain("Tool access: call tools directly ();");
    expect(toolsLine(seen.at(-1)?.system ?? "")).not.toContain("read_file");
  });

  it("② does NOT touch the turn that is already running", async () => {
    // The model step of the running turn is held by the TEST, so the PUT below
    // provably lands mid-turn (no timer-based guessing).
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { h, seen } = open({ hold });
    await activate(h, SESSION);
    const full = await toolsOf(h, SESSION);

    const running = runTurnWithFrames(h, "跑着的时候被关掉");
    // Wait until the running turn really reached its model step.
    // 有界轮询：等**条件**，不等时间 —— 超时即抛带原因的错，绝不赌时长（W9225）。
    const deadline = Date.now() + 5_000;
    while (seen.length === 0) {
      if (Date.now() > deadline) throw new Error("the running turn never reached its model step");
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(seen).toHaveLength(1);
    expect(h.runtime.isBusy(SESSION)).toBe(true);

    // The switch is written while the turn is in flight.
    const res = await putDisabled(h, ["studio.engine.tools"]);
    expect(res.status).toBe(200);
    // The in-flight turn keeps the generation it started with — nothing was
    // rebuilt under it, and its own request already carried the full face.
    expect(seen[0]?.tools).toEqual(full);
    expect(engineOf(h).pluginNames(SESSION)).toContain("studio.engine.tools");

    release();
    await running;

    // The NEXT turn boundary is where the new generation appears.
    await activate(h, SESSION);
    expect(await toolsOf(h, SESSION)).toEqual([]);
    await runTurnWithFrames(h, "下一轮");
    expect(seen.at(-1)?.tools).toEqual([]);
  });

  it("③ disabling the worker plugin removes exactly the three worker tools", async () => {
    const { h, seen } = open();
    await activate(h, SESSION);
    const before = await toolsOf(h, SESSION);
    for (const name of ["spawn_worker", "send_message", "stop_worker"]) expect(before, name).toContain(name);

    expect((await putDisabled(h, ["celestea.runtime.workers"])).status).toBe(200);
    await activate(h, SESSION);
    expect(engineOf(h).pluginNames(SESSION)).not.toContain("celestea.runtime.workers");

    const after = await toolsOf(h, SESSION);
    for (const name of ["spawn_worker", "send_message", "stop_worker"]) expect(after, name).not.toContain(name);
    // Everything else survived: this is a plugin switch, not a teardown.
    expect(after).toContain("read_file");

    await runTurnWithFrames(h, "再来一轮");
    expect(seen.at(-1)?.tools).toEqual(after);
  });

  it("④ disabling the swarm and watchdog plugins drops exactly their rows", async () => {
    const { h } = open();
    await activate(h, SESSION);
    expect(engineOf(h).pluginNames(SESSION)).toContain("celestea.runtime.swarm");
    expect(engineOf(h).pluginNames(SESSION)).toContain("celestea.runtime.watchdog");
    expect(await toolsOf(h, SESSION)).toContain("agent_swarm");

    expect((await putDisabled(h, ["celestea.runtime.swarm", "celestea.runtime.watchdog"])).status).toBe(200);
    await activate(h, SESSION);
    const names = engineOf(h).pluginNames(SESSION);
    expect(names).not.toContain("celestea.runtime.swarm");
    expect(names).not.toContain("celestea.runtime.watchdog");
    expect(await toolsOf(h, SESSION)).not.toContain("agent_swarm");
    // The watchdog handle is really gone, not merely unlisted.
    expect(engineOf(h).watchdog(SESSION)).toBeNull();
  });

  it("⑤ re-enabling a plugin brings it back at the next boundary (the switch is reversible)", async () => {
    const { h } = open();
    await activate(h, SESSION);
    const full = await toolsOf(h, SESSION);

    expect((await putDisabled(h, ["studio.engine.tools"])).status).toBe(200);
    await activate(h, SESSION);
    expect(await toolsOf(h, SESSION)).toEqual([]);

    expect((await getJson(h.app, "/api/plugins", jsonRequest("PUT", { disabled: [] }))).status).toBe(200);
    await activate(h, SESSION);
    expect(engineOf(h).pluginNames(SESSION)).toContain("studio.engine.tools");
    expect(await toolsOf(h, SESSION)).toEqual(full);
  });
});
