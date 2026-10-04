/**
 * agent_swarm 的【真实引擎】端到端验收（§10.3 的自动化替代：起生产 app、
 * 打真实 HTTP、驱动真实 loop 与真实工具，只把上游 LLM 换成脚本化 mock）。
 *
 * 为什么这算真机而单元测试不算：单元测试直接调 swarmTool()，绕过了
 *   /api/turn -> Runtime -> AgentLoop -> 真实 tool dispatch -> statusline 组装
 * 这条链。这里每一环都是生产装配；唯一被替掉的只有 provider 上游（无网络、无凭据）。
 *
 * 覆盖 §10.3 的三项：① 3 成员批 + XML 编号 1-based；② 20 成员压测；
 * ③ 人为 429 触发退避。面板「好不好用」留给 CDP 截图 + 人眼，不在这里断言。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { parseSessionJsonl } from "@celestea/session";
import { createStudioApp, type StudioApp } from "../app.js";
import { loadStudioConfig } from "../config.js";
import { jsonRequest } from "../harness.test-util.js";
import { DONE_FRAME, startMockProvider, textDelta, toolCallDelta } from "./mock-provider.test-util.js";

interface LiveHost {
  app: Hono;
  studio: StudioApp;
  root: string;
  sessionLog: string;
  cleanup(): void;
}

interface CountingUpstream {
  v1BaseUrl: string;
  /** Every request this upstream has served (429s included). */
  hits: number;
  /** Arrival epoch-ms of each request, in order. */
  at: number[];
  /** Per request: was it answered 429? */
  rl: boolean[];
  close(): Promise<void>;
}

/**
 * A local upstream that serves `okFirst` normal answers, then 429s the next
 * `failThen` requests, then serves normal answers again. `hits` counts EVERY
 * request, so a test can assert a RETRY actually happened (the count grew past
 * the scripted failures) rather than only that one call failed.
 *
 * Why it lives here instead of importing the llm package's mock: a cross-package
 * deep import is forbidden by BOTH the eslint import boundary and depcruise's
 * `entry-only-llm` rule, and the studio already owns a scripted provider.
 */
function startCountingUpstream(okFirst: number, failThen: number, script: readonly string[][]): Promise<CountingUpstream> {
  const state = { v1BaseUrl: "", hits: 0, t0: Date.now(), at: [] as number[], rl: [] as boolean[], close: async (): Promise<void> => undefined };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      state.hits += 1;
      state.at.push(Date.now());
      state.rl.push(state.hits > okFirst && state.hits <= okFirst + failThen);
      if (state.hits > okFirst && state.hits <= okFirst + failThen) {
        // retry-after: 0 => 引擎自己那层重试【立即】发生，于是时间轴上只剩调度器的退避。
        // 不带这个头的话引擎会按 backoffMs(500)×2^k 自己等，测的就混了两层等待。
        res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
        res.end(JSON.stringify({ error: "rate limited" }));
        return;
      }
      const frames = script[Math.min(state.hits - 1, script.length - 1)] ?? [];
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of frames) res.write(frame);
      res.end();
    });
  });
  server.listen(0, "127.0.0.1");
  return new Promise((resolve) => {
    server.on("listening", () => {
      const address = server.address() as AddressInfo;
      state.v1BaseUrl = "http://127.0.0.1:" + String(address.port) + "/v1";
      state.close = (): Promise<void> => new Promise((done) => server.close(() => done()));
      resolve(state);
    });
  });
}

const liveHosts: LiveHost[] = [];

afterEach(() => {
  while (liveHosts.length > 0) liveHosts.pop()?.cleanup();
});

/** A CELESTEA_*-free environment plus the caller's overrides. */
function cleanEnv(over: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("CELESTEA_")) env[k] = v;
  return { ...env, ...over };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

interface LiveHostOptions {
  baseUrl: string;
  model: string;
  /** Extra env for THIS host (e.g. pin the engine retry budget). */
  env?: NodeJS.ProcessEnv;
}

/** Build the PRODUCTION app (nothing injected) over a throwaway data root. */
function makeLiveHost(opts: LiveHostOptions): LiveHost {
  const root = mkdtempSync(join(tmpdir(), "swarm-live-"));
  const workspace = join(root, "ws");
  const sessionDir = join(workspace, "s1");
  const staticRoot = join(root, "dist");
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(staticRoot, { recursive: true });
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>swarm</title>\n");
  writeFileSync(join(sessionDir, "cli-main.jsonl"), "");
  writeJson(join(root, "workspaces.json"), { workspaces: [{ path: workspace }], active_session: "ws/s1" });
  writeJson(join(root, "prompts.json"), {});
  // W9331: `celestea.runtime.swarm` is default OFF, so this end-to-end suite — whose
  // entire subject is `agent_swarm` — must turn it ON explicitly. That is exactly
  // what a user does, and writing it as the `enabled` table (rather than as a
  // code-level switch) means this suite exercises the REAL user path: the plugin
  // hot-swap store → `PluginSwitch` → `enginePluginSwitchesOf` → `compose()`.
  writeJson(join(root, "plugins.json"), { version: 2, disabled: [], enabled: ["celestea.runtime.swarm"], updated_at: 0 });
  writeJson(join(root, "providers.json"), {
    providers: [
      {
        id: "mock",
        name: "Mock Gateway",
        note: "mock upstream",
        base_url: opts.baseUrl,
        request_format: "chat_completions",
        api_key: null,
        models: [{ id: opts.model, name: opts.model, reasoning_efforts: ["low"], context_window: 1_000_000, max_output_tokens: null }],
      },
    ],
    default_model: opts.model,
  });
  const env = cleanEnv({
    CELESTEA_API_KEY: "test-key",
    CELESTEA_TOOL_ROOTS: workspace,
    CELESTEA_SANDBOX_NET: "0",
    ...(opts.env ?? {}),
  });
  const config = loadStudioConfig({ cwd: root, env, paths: { staticRoot } });
  const studio = createStudioApp({ config, env });
  const host: LiveHost = {
    app: studio.app,
    studio,
    root,
    sessionLog: join(sessionDir, "cli-main.jsonl"),
    cleanup: (): void => rmSync(root, { recursive: true, force: true }),
  };
  liveHosts.push(host);
  return host;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Each member answers on its own turn (a member turn is a real upstream call). */
function memberAnswers(n: number): string[][] {
  return Array.from({ length: n }, (_, i) => [textDelta("member-" + (i + 1) + " done"), DONE_FRAME]);
}

/** Step 1 emits the agent_swarm call; later steps close the turn out. */
function swarmScript(args: unknown, memberCount: number): string[][] {
  return [
    [textDelta("发批次"), toolCallDelta("call-1", "agent_swarm", args), DONE_FRAME],
    ...memberAnswers(memberCount),
    [textDelta("批次结束"), DONE_FRAME],
  ];
}

/** Every agent_swarm tool_result value (each is { xml }). */
function toolResultXmls(sessionLog: string): string[] {
  const rows = parseSessionJsonl(readFileSync(sessionLog, "utf8")).events;
  const out: string[] = [];
  for (const row of rows) {
    if (row.type !== "tool_result") continue;
    const value = (row as { value?: unknown }).value;
    if (typeof value !== "object" || value === null) continue;
    const xml = (value as { xml?: unknown }).xml;
    if (typeof xml === "string" && xml.includes("<agent_swarm_result>")) out.push(xml);
  }
  return out;
}

/** Run one turn and wait until the swarm result landed in the log. */
async function runSwarmTurn(host: LiveHost, input: string, timeoutMs = 60_000): Promise<void> {
  const res = await host.app.request("/api/turn", jsonRequest("POST", { input }));
  expect(res.status).toBe(202);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (toolResultXmls(host.sessionLog).length >= 1) return;
    await sleep(25);
  }
  // Fail LOUDLY: the raw log tail is the only thing that says whether the turn
  // never started, the model never called the tool, or the tool failed.
  const raw = readFileSync(host.sessionLog, "utf8");
  const tail = raw.split("\n").filter((l) => l !== "").slice(-6).map((l) => l.slice(0, 220));
  throw new Error(
    "swarm turn produced no result within " + String(timeoutMs) + "ms | log tail: " + tail.join(" || "),
  );
}

/**
 * The rendered members' `item` values, in document order.
 *
 * There is NO `index` attribute on `<subagent>` (result-xml.ts renders
 * agent_id / item / state / outcome / stop_reason only) — the 1-based numbering
 * is enforced by the alignment assertion BEFORE rendering, not carried as an
 * attribute. feature §6's sample block showed `index="1"`; that sample is what
 * this asserts against, so it was corrected to the real shape.
 */
function itemsOf(xml: string): string[] {
  return [...xml.matchAll(/<subagent [^>]*item="([^"]*)"/g)].map((m) => m[1] as string);
}
describe("agent_swarm · 真实引擎端到端（§10.3 自动化）", () => {
  it("① 3 成员批：工具真实注册、成员真实派发，XML 编号 1..3 对齐", async () => {
    const items = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const mock = await startMockProvider(swarmScript({ description: "审三个文件", prompt_template: "检查 {{item}} 并说明问题", items }, items.length));
    const host = makeLiveHost({ baseUrl: mock.v1BaseUrl, model: "mock-model" });
    await runSwarmTurn(host, "帮我审这三个文件");

    const xml = toolResultXmls(host.sessionLog)[0] as string;
    
    // 1. 三个成员，按【原始 item 顺序】渲染（不是完成顺序）—— §6 的排序契约。
    expect(itemsOf(xml)).toEqual(items);
    // 3. 成员正文真的回来了（不是空 body）。
    expect(xml).toMatch(/outcome="completed"/);
    expect(xml).toContain("member-1 done");
    // 4. summary 与成员数一致。
    expect(xml).toMatch(/<summary>[^<]*completed: 3[^<]*<\/summary>/);
    // 5. 上游被打了 >=4 次（1 次发调用 + 3 次成员 turn），证明没走离线假件。
    expect(mock.requests.length).toBeGreaterThanOrEqual(4);
    await mock.close();
  }, 90_000);

  it("② 20 成员压测：全部落定、无成员悬挂", async () => {
    const items = Array.from({ length: 20 }, (_, i) => "pkg/mod-" + (i + 1) + "/file.ts");
    const mock = await startMockProvider(swarmScript({ description: "审二十个文件", prompt_template: "检查 {{item}}", items }, items.length));
    const host = makeLiveHost({ baseUrl: mock.v1BaseUrl, model: "mock-model" });
    await runSwarmTurn(host, "审这二十个文件");

    const xml = toolResultXmls(host.sessionLog)[0] as string;
    const rendered = itemsOf(xml);
    expect(rendered).toHaveLength(20);
    // 顺序与 items 逐条对齐：批量规模没让任何成员丢失或错位。
    expect(rendered).toEqual(items);
    // 每个成员都拿到了终态（没有 started 却无结论的悬挂成员）。
    const outcomes = [...xml.matchAll(/outcome="(\w+)"/g)].map((m) => m[1]);
    expect(outcomes).toHaveLength(20);
    for (const outcome of outcomes) expect(["completed", "failed", "aborted"]).toContain(outcome);
    await mock.close();
  }, 120_000);
  it("③ 人为 429：退避真的被触发过（成员先撞限流、再重试成功）", async () => {
    // 关键：429 只打在【成员】的 turn 上，宿主那一轮必须成功 —— 否则模型根本
    // 走不到 agent_swarm，测的就不是 swarm 的退避而是宿主的重试预算。
    // 所以：第 1 次调用（发工具调用）走正常流，之后每次调用才 429。
    // 脚本：第 1 步发 agent_swarm 调用（正常流），之后每次成员调用吃 429，
    // 再之后放行 —— 于是【成员】先撞限流、退避、再成功。
    // 429 的次数必须【超过引擎自己的重试预算】（DEFAULT_RETRY_POLICY.maxRetries = 1）：
    // 每个成员先被引擎原地重试 1 次，两次都 429 之后错误才冒泡到 swarm 调度器，
    // 那才是 §4 的退避分支。只给 3 次是不够的 —— 实测引擎把前两次吃掉了，
    // 调度器压根没看到限流（这条注释就是那次实测换来的）。
    // retry-after: 0 让引擎那一层瞬间重试（测试要快）；我们要量的是调度器自己的等待。
    const rateLimited = await startCountingUpstream(1, 6, [
      [textDelta("发批次"), toolCallDelta("call-1", "agent_swarm", { description: "限流批", prompt_template: "处理 {{item}}", items: ["a", "b"] }), DONE_FRAME],
      ...Array.from({ length: 2 }, (_, i) => [textDelta("member-" + (i + 1)), DONE_FRAME]),
      [textDelta("结束"), DONE_FRAME],
    ]);
    // Pin the ENGINE retry budget to 1: this test measures the SWARM scheduler's
    // own backoff, and the engine's instant (retry-after: 0) retries would otherwise
    // interleave hits and hide the scheduler's >=2s gap. W93xx: the default is now 3.
    const host = makeLiveHost({ baseUrl: rateLimited.v1BaseUrl, model: "mock-model", env: { CELESTEA_LLM_MAX_RETRIES: "1" } });

    // 第 1 步：正常流，回答里带一个 2 成员的 agent_swarm 调用。
    await runSwarmTurn(host, "跑一个会被限流的批次", 60_000);
    const xml = toolResultXmls(host.sessionLog)[0];

    // 限流是【成员级】结局，不是整次调用的异常：批次仍产出 XML，每个成员落在
    // 三个终态之一（§6 逐条如实分列），不抛异常、不谎报 completed。
    expect(xml, "限流场景下批次仍必须产出 XML").toBeDefined();
    const defined = xml as string;
    const outcomes = [...defined.matchAll(/outcome="(\w+)"/g)].map((m) => m[1] as string);
    for (const outcome of outcomes) expect(["completed", "failed", "aborted"]).toContain(outcome);

    // 退避被触发过的机械证据（两条，都要）：
    //① 上游被打了 >=3 次（1 次宿主 + 至少 2 次成员重试）。若没有重试，这个数停在 2。
    expect(rateLimited.hits).toBeGreaterThan(2);
    // ② 且【两次 429 之间真的等了】。这是「退避」与「立即重试」的分界：
    // scheduler 的 retryBaseMs 是 3000ms，抖动下界 0.5x = 1500ms，所以两脚之间
    // 必须 >=1000ms。把 jitter 改成 0（立刻重试）时这条会红 —— 断言因此有牙齿。
    const gaps: number[] = [];
    for (let i = 1; i < rateLimited.at.length; i += 1) {
      const gap = (rateLimited.at[i] as number) - (rateLimited.at[i - 1] as number);
      gaps.push(gap);
    }
    // 退避真的发生了 —— 实测间隔 3022 / 3017 / 3004ms，正是 retryBaseMs=3000 × 抖动上界(1.0)。
    //
    // 这条断言曾经长期是红的，根因值得记下来（它是「单元测试全绿、真机才炸」的样本）：
    // provider 的失败在【中途】发生时不会成为 throw —— loop.ts 把它记成 step 的终态
    // (out.terminal = {error:{kind:"stream",…}}) 然后 break，runTurn 是 resolve 的。
    // 于是 executor 找不到 assistant 消息，抛出的是一条普通 Error，限流判定看不到 429，
    // §4 的退避分支在真实链路上从未触发。修法：executor 改读 turn 的终态状态
    // (terminalErrorOf) 并抛出带 retryable 的 SwarmMemberFailedError。
    //
    // 钉「至少两次 >=2s 的间隔」而不是「最长间隔 >=1s」：
    //   · 阈值 1s 会被【引擎自己那层重试】满足（backoffMs=500×2^k），断言就成了空转；
    //   · 只看最大值也不够 —— 一次偶然的长等待就能满足，所以要求**次数** >= 2，
    //     对应两个成员各自退避过一次（retryBaseMs=3000、抖动上界 1.0 ⇒ 3 次量级的间隔）。
    const longGaps = gaps.filter((g) => g >= 2_000);
    expect(longGaps.length, "429 之后必须真的等退避周期：至少两次 >=2s 的间隔（两个成员各退避一次）").toBeGreaterThanOrEqual(2);

    await rateLimited.close();
  }, 120_000);
});
