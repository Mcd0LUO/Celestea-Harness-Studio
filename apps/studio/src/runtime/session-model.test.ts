/**
 * W870 — the statusline's model picker switches the FOCUSED SESSION's model.
 *
 * The bug (user report: 「点击切换模型后，若干秒模型又回到了切换前的状态」):
 * `apps/web/src/statusline.ts` polls `GET /api/status?session=<focus>` every 2s and
 * merges the answer unconditionally. That answer's `model` comes from the SESSION
 * INSTANCE's profile — global base profile + the session's own `session.json.model`
 * override (`session-compose.ts` `profileFor`) — while the W750 picker wrote ONLY the
 * global default (`POST /api/config`). For a session that declares an override the
 * optimistic badge was therefore bounced back to the override by the very next poll.
 *
 * The fix is the product semantic this file pins: the picker on a session's statusline
 * switches THAT session's model (`PUT /api/sessions/{id}/model`), and
 * `POST /api/config` keeps meaning 「the global default」.
 *
 * Level: the REAL adapter (`RealRuntimeAdapter` through `createStudioEngine`), over the
 * HTTP contract — the divergence lived exactly between the handler's write and the
 * adapter's `statusline(session)` reading. Never a re-derivation of `profileFor`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getJson, jsonRequest, type StudioHarness } from "../harness.test-util.js";
import { activate, makeEngineHarness, waitIdle } from "./test-util.js";
import type { OfflineStep } from "./offline-llm.js";

/** The session-level override the reporter's two sessions actually carry (live 3777). */
const OVERRIDE = "glm-5.3-flash";
/** The model the user picks in the statusline. */
const PICKED = "deepseek-v9-pro";
/** The harness engine's BASE (global) model — `OFFLINE_PROFILE.model`. */
const BASE = "offline-model";

const FOCUSED = "sample-ws/focused";
const NEIGHBOUR = "sample-ws/neighbour";

const harnesses: StudioHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** One process, three sessions: two with an override, one without. */
function engine(requested: string[] = [], script: OfflineStep[] = [], files?: Record<string, unknown>): StudioHarness {
  const h = makeEngineHarness({
    sessions: { focused: [], neighbour: [], plain: [] },
    meta: {
      focused: { title: "甲会话", model: OVERRIDE, mode: "standard" },
      neighbour: { title: "乙会话", model: OVERRIDE },
    },
    llm: { script, onRequest: (req) => requested.push(req.model) },
    ...(files === undefined ? {} : { files }),
  });
  harnesses.push(h);
  return h;
}

const modelPath = (id: string): string => "/api/sessions/" + encodeURIComponent(id) + "/model";

/** `GET /api/status?session=` — the value the statusline badge renders. */
async function statusModel(h: StudioHarness, id: string): Promise<string> {
  const res = await getJson(h.app, "/api/status?session=" + encodeURIComponent(id));
  expect(res.status).toBe(200);
  return String(res.body["model"]);
}

/** The session's `session.json` exactly as it is on disk. */
function metaOf(h: StudioHarness, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(h.workspace, name, "session.json"), "utf8")) as Record<string, unknown>;
}

const switchModel = async (h: StudioHarness, id: string, model: string): Promise<Response> =>
  h.app.request(modelPath(id), jsonRequest("PUT", { model }));

describe("W870 · session-scoped model switch (the bounce-back bug)", () => {
  it("THE BUG: switching a session's model must survive the next status poll", async () => {
    const h = engine();
    await activate(h, FOCUSED);
    expect(await statusModel(h, FOCUSED), "the session starts on its own override").toBe(OVERRIDE);

    const res = await switchModel(h, FOCUSED, PICKED);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["session"]).toBe(FOCUSED);
    expect(body["model"]).toBe(PICKED);

    // The write is the session's OWN meta (title/mode kept), never the global default.
    expect(metaOf(h, "focused")).toEqual({ title: "甲会话", model: PICKED, mode: "standard" });
    expect((await getJson(h.app, "/api/config")).body["model"], "the global default is untouched").toBe(BASE);

    // …and the next 2s poll reads the NEW value — this is the assertion that was red.
    expect(await statusModel(h, FOCUSED)).toBe(PICKED);
    // A second read (the 「若干秒后」 poll) still answers the new model.
    expect(await statusModel(h, FOCUSED)).toBe(PICKED);
  });

  it("the next turn of THAT session really runs on the switched model", async () => {
    const requested: string[] = [];
    const h = engine(requested, [{ text: "答" }]);
    await activate(h, FOCUSED);
    expect((await switchModel(h, FOCUSED, PICKED)).status).toBe(200);

    const turn = await h.app.request("/api/turn", jsonRequest("POST", { input: "用哪个模型", session: FOCUSED }));
    expect(turn.status).toBe(202);
    await waitIdle(h);
    expect(requested).toEqual([PICKED]);
  });

  it("model:\"\" clears the override and the session falls back to the global default", async () => {
    const requested: string[] = [];
    const h = engine(requested, [{ text: "答" }]);
    await activate(h, FOCUSED);

    const res = await switchModel(h, FOCUSED, "");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["model"]).toBe(BASE);
    expect(body["covered"]).toBe(false);
    // The KEY is gone; every other key survives (K8: absent = no override).
    expect(metaOf(h, "focused")).toEqual({ title: "甲会话", mode: "standard" });
    expect(await statusModel(h, FOCUSED)).toBe(BASE);

    await h.app.request("/api/turn", jsonRequest("POST", { input: "回落了吗", session: FOCUSED }));
    await waitIdle(h);
    expect(requested).toEqual([BASE]);
  });

  it("is session-scoped: the neighbour keeps its own override and model", async () => {
    const h = engine();
    await activate(h, FOCUSED);
    await activate(h, NEIGHBOUR);
    await activate(h, "sample-ws/plain");

    expect((await switchModel(h, FOCUSED, PICKED)).status).toBe(200);
    expect(await statusModel(h, NEIGHBOUR)).toBe(OVERRIDE);
    expect(metaOf(h, "neighbour")["model"]).toBe(OVERRIDE);
    // A no-override session reads the global default before and after.
    expect(await statusModel(h, "sample-ws/plain")).toBe(BASE);
  });
});

describe("W870 · session model endpoint: guards", () => {
  it("409 while that session's turn is running (the W791 mode/compact semantics)", async () => {
    const h = engine([], [{ text: "x".repeat(4000) }]);
    await activate(h, FOCUSED);
    const slow = await h.app.request("/api/turn", jsonRequest("POST", { input: "慢", session: FOCUSED }));
    expect(slow.status).toBe(202);
    try {
      const res = await switchModel(h, FOCUSED, PICKED);
      expect(res.status).toBe(409);
      expect(String(((await res.json()) as Record<string, unknown>)["error"])).toContain("turn 进行中");
      // Nothing was written: a refused switch must not half-apply.
      expect(metaOf(h, "focused")["model"]).toBe(OVERRIDE);
    } finally {
      h.runtime.cancel(FOCUSED);
      await waitIdle(h);
    }
  });

  it("422 for a non-string, 400 for an illegal name, 404 for an unknown session", async () => {
    const h = engine();
    await activate(h, FOCUSED);
    const notString = await h.app.request(modelPath(FOCUSED), jsonRequest("PUT", { model: 7 }));
    expect(notString.status).toBe(422);
    const illegal = await switchModel(h, FOCUSED, "bad model!");
    expect(illegal.status).toBe(400);
    expect(String(((await illegal.json()) as Record<string, unknown>)["error"])).toContain("invalid model name");
    const missing = await switchModel(h, "sample-ws/ghost", PICKED);
    expect(missing.status).toBe(404);
    // Every refusal left the file exactly as it was.
    expect(metaOf(h, "focused")).toEqual({ title: "甲会话", model: OVERRIDE, mode: "standard" });
  });
});

// ============================================================================
// W2065 · 会话级切换必须把「端点」和「模型」一起钉住
//
// 用户报案：从惯用默认提供商的模型切到另一个 provider（如 MiniMax）的模型，
// 模型能切换成功，但 base_url 仍滞后不变。三层原因，本块逐层钉：
//   1. handler 写 session.json 时只有 model，端点无处可落；
//   2. composer 的 profileFor 不读端点，会话实例继承全局 base_url；
//   3. 两处 base_url 解析曾被 `request_format === "chat_completions"` 卡住。
// 「请求真的发去了新端点」由 w2065-session-base-url.test.ts 的双上游实机用例证明。
// ============================================================================

const GW_URL = "http://127.0.0.1:3001/v1";
const MM_URL = "https://api.minimaxi.com/v1";
const MM_MODEL = "MiniMax-M2";

/** 网关 + MiniMax；`fmt` 故意取非 chat_completions —— 真实第三方端点就是这样配的。 */
function withProviders(requested: string[] = [], fmt = "anthropic_messages"): StudioHarness {
  const provider = (id: string, name: string, base: string, requestFormat: string, models: string[]): Record<string, unknown> => ({
    id,
    name,
    note: "",
    base_url: base,
    request_format: requestFormat,
    api_key: `sk-${id}`,
    models: models.map((m) => ({ id: m, name: m, reasoning_efforts: [], context_window: null, max_output_tokens: null })),
  });
  return engine(requested, [{ text: "答" }], {
    "providers.json": {
      providers: [
        provider("gw", "网关", GW_URL, "chat_completions", [OVERRIDE]),
        provider("minimax", "MiniMax", MM_URL, fmt, [MM_MODEL]),
      ],
      default_model: OVERRIDE,
    },
  });
}

const switchTo = async (h: StudioHarness, id: string, model: string, providerId?: string): Promise<Response> =>
  h.app.request(modelPath(id), jsonRequest("PUT", providerId === undefined ? { model } : { model, provider_id: providerId }));

describe("W2065 · 会话级切换把 base_url 与 model 一起钉住", () => {
  it("切到另一个 provider：model 与 base_url 一起落库、一起回声", async () => {
    const h = withProviders();
    await activate(h, FOCUSED);

    const res = await switchTo(h, FOCUSED, MM_MODEL, "minimax");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const effective = body["effective"] as Record<string, unknown>;
    // 只报 model 无法回答「发去哪儿」—— 端点与模型成对回声。
    expect([body["model"], body["base_url"]]).toEqual([MM_MODEL, MM_URL]);
    expect([effective["model"], effective["base_url"], effective["base_url_source"]]).toEqual([MM_MODEL, MM_URL, "session"]);

    // 落盘：同一个文件、同一次写，两个键一起在。
    expect(metaOf(h, "focused")).toEqual({ title: "甲会话", model: MM_MODEL, base_url: MM_URL, mode: "standard" });
  });

  it("清除覆盖时 base_url 与 model 一起消失（不留孤儿端点）", async () => {
    const h = withProviders();
    await activate(h, FOCUSED);
    expect((await switchTo(h, FOCUSED, MM_MODEL, "minimax")).status).toBe(200);

    const res = await switchTo(h, FOCUSED, "");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // 回落到**全局默认**（harness 的 OFFLINE_PROFILE.model），不是切之前的那个 override。
    expect([body["model"], body["covered"]]).toEqual([BASE, false]);
    // K8：两个键都不在文件里；留下 base_url 会把下一个不相干的模型钉在这个 provider 上。
    expect(metaOf(h, "focused")).toEqual({ title: "甲会话", mode: "standard" });
  });

  it("不传 provider_id 时沿用「第一个列出该 id 的 provider」（W750 旧口径不变）", async () => {
    const h = withProviders();
    await activate(h, FOCUSED);

    const viaId = await switchTo(h, FOCUSED, MM_MODEL, "minimax");
    expect(viaId.status).toBe(200);
    expect(metaOf(h, "focused")["base_url"]).toBe(MM_URL);

    const legacy = await switchTo(h, FOCUSED, OVERRIDE);
    expect(legacy.status).toBe(200);
    expect(metaOf(h, "focused")["base_url"]).toBe(GW_URL);
  });

  it("被拒的 provider_id 绝不落半成品（先解析后写）", async () => {
    const h = withProviders();
    await activate(h, FOCUSED);

    const badProvider = await switchTo(h, FOCUSED, MM_MODEL, "ghost");
    expect(badProvider.status).toBe(404);
    expect((await badProvider.json()) as Record<string, unknown>).toEqual({ ok: false, error: "unknown provider 'ghost'" });
    const badModel = await switchTo(h, FOCUSED, MM_MODEL, "gw");
    expect(badModel.status).toBe(400);
    expect((await badModel.json()) as Record<string, unknown>).toEqual({
      ok: false,
      error: "provider 'gw' does not list model 'MiniMax-M2'",
    });
    // 两次拒绝都没碰文件：仍是切之前的覆盖，且**没有**多出 base_url。
    expect(metaOf(h, "focused")).toEqual({ title: "甲会话", model: OVERRIDE, mode: "standard" });
  });

  it("没有 provider 行可归属时只写 model，不写空端点", async () => {
    const h = engine();
    await activate(h, FOCUSED);
    expect((await switchTo(h, FOCUSED, PICKED)).status).toBe(200);
    // 无 providers.json ⇒ 无人拥有该模型 ⇒ 跟随全局端点（K8：不写这个键）。
    expect(metaOf(h, "focused")).toEqual({ title: "甲会话", model: PICKED, mode: "standard" });
  });
});
