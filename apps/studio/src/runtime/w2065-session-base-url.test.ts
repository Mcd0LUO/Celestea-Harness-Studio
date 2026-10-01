/**
 * W2065 — 「切换到另一个 provider 的模型，模型能切换成功，但 base_url 仍滞后不变」。
 *
 * 这条用例存在的理由：前两处防线（`config-models.test.ts` 的 compose patch 与
 * `provider-target.test.ts` 的 `resolveBaseUrl`）只能证明**写下去的值**，
 * 证明不了「请求真的发去了新端点」。而用户报的正是后者。
 *
 * 所以这里是**实机**：两个真的本地 HTTP 上游（`startMockProvider`，真 LLM
 * 客户端、真 SSE、真 socket），一个声明 `chat_completions`（惯用默认网关），
 * 一个声明 `anthropic_messages`（第三方端点，真实部署就长这样）。断言看
 * **哪一个服务器收到了请求**，而不是复述任何一层的实现。
 *
 * 三层一起被这条用例钉死：
 *   1. handler 把 provider 的 base_url 与 model 一起写进 session.json；
 *   2. composer 的 profileFor 把它应用到该会话的实例 profile；
 *   3. base_url 解析不再被 `request_format === chat_completions` 卡住。
 *
 * Level: 生产 app（`createStudioApp`）+ 真实 LLM 传输，不是 fake adapter。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createStudioApp, type StudioApp } from "../app.js";
import { loadStudioConfig } from "../config.js";
import { jsonRequest } from "../harness.test-util.js";
import { DONE_FRAME, startMockProvider, textDelta, usageChunk, type MockProvider } from "./mock-provider.test-util.js";

const GW_MODEL = "glm-5.3-flash";
const MM_MODEL = "MiniMax-M2";

const roots: string[] = [];
const upstreams: MockProvider[] = [];

afterEach(async () => {
  while (upstreams.length > 0) await upstreams.pop()?.close();
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One answered turn: a text delta, usage, then the terminator. */
function answer(text: string): string[] {
  return [textDelta(text), usageChunk(10, 5), DONE_FRAME];
}

interface Host {
  app: Hono;
  studio: StudioApp;
}

/**
 * The production app over a throwaway data root, with BOTH providers listed and
 * the global default on the gateway. `minimax` is declared `anthropic_messages`
 * on purpose — that is the row the old `request_format` gate silently skipped.
 */
function makeHost(gwUrl: string, mmUrl: string, listed: { gw?: string[]; minimax?: string[] } = {}): Host {
  const root = mkdtempSync(join(tmpdir(), "w2065-"));
  roots.push(root);
  const workspace = join(root, "ws");
  const sessionDir = join(workspace, "s1");
  const staticRoot = join(root, "dist");
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(staticRoot, { recursive: true });
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>w2065</title>\n");
  writeFileSync(join(sessionDir, "cli-main.jsonl"), "");
  const write = (path: string, value: unknown): void => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  write(join(root, "workspaces.json"), { workspaces: [{ path: workspace }], active_session: "ws/s1" });
  write(join(root, "prompts.json"), {});
  write(join(root, "pricing.json"), { version: "2026-09-11", currency: "CNY", unit: "per_mtok", models: {} });
  const row = (id: string, name: string, base: string, fmt: string, models: string[]): Record<string, unknown> => ({
    id,
    name,
    note: "w2065 upstream",
    base_url: base,
    request_format: fmt,
    api_key: null,
    models: models.map((m) => ({ id: m, name: m, reasoning_efforts: [], context_window: 100_000, max_output_tokens: null })),
  });
  write(join(root, "providers.json"), {
    providers: [
      row("gw", "惯用网关", gwUrl, "chat_completions", listed.gw ?? [GW_MODEL]),
      row("minimax", "MiniMax", mmUrl, "anthropic_messages", listed.minimax ?? [MM_MODEL]),
    ],
    default_model: GW_MODEL,
  });
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("CELESTEA_")) env[k] = v;
  env["CELESTEA_API_KEY"] = "test-key";
  env["CELESTEA_TOOL_ROOTS"] = workspace;
  const config = loadStudioConfig({ cwd: root, env, paths: { staticRoot } });
  const studio = createStudioApp({ config, env });
  return { app: studio.app, studio };
}

async function waitIdle(studio: StudioApp, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (studio.services.runtime.isBusy()) {
    if (Date.now() > deadline) throw new Error("turn did not settle");
    await sleep(5);
  }
  await sleep(5);
}

/** Run one turn in the focused session and wait for it to settle. */
async function turn(app: Hono, studio: StudioApp, input: string): Promise<void> {
  const res = await app.request("/api/turn", jsonRequest("POST", { input }));
  expect(res.status).toBe(202);
  await waitIdle(studio);
}

/** The model ids each upstream actually received, in call order. */
const seen = (p: MockProvider): string[] => p.requests.map((r) => String((r.body["model"] as string) ?? ""));

/**
 * Wait until `p` has received at least `n` requests.
 *
 * The turn's OWN request is settled by `waitIdle`, but the background memory
 * extraction is fire-and-forget (scheduled at turn end, never awaited by the
 * turn path), so a count that includes it needs to wait for the call to land
 * rather than for the turn to end.
 */
async function waitSeen(p: MockProvider, n: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (p.requests.length < n) {
    if (Date.now() > deadline) throw new Error(`upstream saw ${p.requests.length} requests, wanted ${n}`);
    await sleep(5);
  }
}

describe("W2065 · 切到另一个 provider 后，请求真的发去了那个端点", () => {
  it("第一轮走网关；切到 MiniMax 之后，下一轮到达 MiniMax 那台上游", async () => {
    const gw = await startMockProvider([answer("网关答")]);
    const mm = await startMockProvider([answer("MiniMax 答")]);
    upstreams.push(gw, mm);
    const { app, studio } = makeHost(gw.v1BaseUrl, mm.v1BaseUrl);

    // Exactly one request: this input is BELOW the extraction pass's prose floor
    // ("先在网关上问一句" = 8 non-space chars < 9, and one whitespace-word < 3),
    // so the turn is the only thing that talks upstream.
    await turn(app, studio, "先在网关上问一句");
    expect([seen(gw), seen(mm)]).toEqual([[GW_MODEL], []]);

    const res = await app.request("/api/sessions/ws%2Fs1/model", jsonRequest("PUT", { model: MM_MODEL, provider_id: "minimax" }));
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ model: MM_MODEL, base_url: mm.v1BaseUrl, covered: true });

    // 这才是回归线：请求落在 MiniMax 那台上，网关一个都没多收。
    //
    // 两次而不是一次：这一轮的输入过了提炼的 prose 下限，所以轮次结束后还有
    // 一次后台记忆提炼调用（Phase 1 默认开）。它用的也是**本会话当前的 profile**,
    // 于是「切换对派生调用同样成立」也被这条断言一起钉住了 —— 提炼客户端若仍
    // 指向旧 host，这里会是 [GW_MODEL, MM_MODEL] 而不是两次 MM_MODEL。
    await turn(app, studio, "现在问 MiniMax");
    await waitSeen(mm, 2);
    expect([seen(gw), seen(mm)]).toEqual([[GW_MODEL], [MM_MODEL, MM_MODEL]]);
  });

  it("同一模型名挂在两个 provider 下时，provider_id 决定发去哪一个", async () => {
    const gw = await startMockProvider([answer("网关答")]);
    const mm = await startMockProvider([answer("MiniMax 答")]);
    upstreams.push(gw, mm);
    // Both rows now list the SAME model id — the W750 collision.
    const { app, studio } = makeHost(gw.v1BaseUrl, mm.v1BaseUrl, { gw: [GW_MODEL, "shared-id"], minimax: ["shared-id"] });
    const res = await app.request("/api/sessions/ws%2Fs1/model", jsonRequest("PUT", { model: "shared-id", provider_id: "minimax" }));
    expect(res.status).toBe(200);
    await turn(app, studio, "撞名的模型发给谁");
    expect([seen(gw), seen(mm)]).toEqual([[], ["shared-id"]]);
  });
});
