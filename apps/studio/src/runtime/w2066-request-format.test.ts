/**
 * W2066 — 「声明了本构建不会说的线格式时，一个字节都不发出去」。
 *
 * W2066 之前，providers.json 里的 `request_format` 被存下、被界面显示、
 * 被 API 回显，然后被**零行代码**读过 —— 引擎无条件用 OpenAI 方言。于是声明
 * `anthropic_messages` 的行照样跑通，失败形态是上游一个没有线索的 400。
 *
 * 本文件钉两件事，一件只有实机能证：
 *   1. 对照：声明 chat_completions 的行照常把请求发出去（否则「全部拒绝」也会
 *      让下面那条变绿）；
 *   2. 声明 anthropic_messages / responses 的行在**客户端构造期**就被拒绝，
 *      上游一个请求都收不到。
 *
 * 拒绝为什么落在构造期：createEngineLlm -> createLiveLlm 先向注册表要 adapter，
 * 拿不到就抛 NO_ADAPTER。此时 socket 还不存在，所以「一个字节都没发」是由构造
 * 顺序保证的，不是一个事后检查 —— 这正是 fail-closed 与「先试试再说」的区别。
 *
 * Level: 真实 LLM 传输 + 真 socket（startMockProvider）。
 */

import { afterEach, describe, expect, it } from "vitest";

import { createLiveLlm, defaultAdapterRegistry, userMessage } from "@celestea/llm";

import { DONE_FRAME, startMockProvider, textDelta, usageChunk, type MockProvider } from "./mock-provider.test-util.js";

const MODEL = "shared-model";

const upstreams: MockProvider[] = [];

afterEach(async () => {
  while (upstreams.length > 0) await upstreams.pop()?.close();
});

function answer(text: string): string[] {
  return [textDelta(text), usageChunk(10, 5), DONE_FRAME];
}

/** Exactly the wire facts the host composes for one provider row. */
function profileFor(baseUrl: string, requestFormat: string): {
  model: string;
  base_url: string;
  api_key_env: string;
  request_format: string;
} {
  return { model: MODEL, base_url: baseUrl, api_key_env: "TEST_UPSTREAM_KEY", request_format: requestFormat };
}

describe("W2066 · 未实现的 request_format 在构造期被拒绝，且一个字节都不发", () => {
  it("对照：chat_completions 的行真的把请求发出去了", async () => {
    const up = await startMockProvider([answer("答")]);
    upstreams.push(up);
    const client = createLiveLlm(profileFor(up.v1BaseUrl, "chat_completions"), { TEST_UPSTREAM_KEY: "k" }, defaultAdapterRegistry());

    const chunks: string[] = [];
    const stream = await client.generate({ model: MODEL, messages: [userMessage("问")] });
    for await (const event of stream) {
      if (event.kind === "text") chunks.push(event.text);
      if (event.kind === "done") break;
    }
    expect(up.requests).toHaveLength(1);
    expect(String(up.requests[0]?.body["model"])).toBe(MODEL);
    expect(chunks.at(0)).toBe("答");
  });

  // W2067 moved `responses` OUT of this list: it is implemented now, so a row
  // declaring it is served. What remains is the honest-refusal contract for a
  // protocol this build genuinely does not have — and the refusal is still
  // load-bearing, because `anthropic_messages` is a valid row value that no
  // adapter serves.
  // W2068 implemented `anthropic_messages`, so it left this list too. The refusal
  // contract now has no protocol left to refuse — which is the honest end state
  // (W2066's P15 predicted exactly this: adding a protocol = new file + one line).
  // The refusal is still covered by `adapter.test.ts` with a format nobody ships.
  for (const format of ["anthropic_messages_not_shipped"] as const) {
    it(format + "：构造期就拒绝，上游零请求", async () => {
      const up = await startMockProvider([answer("不该被问到")]);
      upstreams.push(up);

      expect(() => createLiveLlm(profileFor(up.v1BaseUrl, format), { TEST_UPSTREAM_KEY: "k" }, defaultAdapterRegistry())).toThrow(
        new RegExp(format),
      );

      // ★ 回归线：W2066 之前这里是 1 —— 引擎照 OpenAI 方言把 anthropic 的会话
      // 发了出去。注意这个断言在**一个 socket 都没被创建**时就已经成立。
      expect(up.requests).toEqual([]);
    });
  }

  it("W2067: a row declaring responses is now SERVED, and posts to /responses", async () => {
    const up = await startMockProvider([answer("答")]);
    upstreams.push(up);
    const client = createLiveLlm(profileFor(up.v1BaseUrl, "responses"), { TEST_UPSTREAM_KEY: "k" }, defaultAdapterRegistry());

    // The endpoint is the proof: same base_url, a different path, no branch in
    // the factory. (/v1 is NOT doubled — base_url already carries it.)
    const chunks: string[] = [];
    for await (const event of await client.generate({ model: MODEL, messages: [userMessage("问")] })) {
      if (event.kind === "text") chunks.push((event as { text: string }).text);
      if (event.kind === "done") break;
    }
    expect(up.requests).toHaveLength(1);
    expect(up.requests[0]?.url).toBe("/v1/responses");
    expect(String(up.requests[0]?.body["model"])).toBe(MODEL);
  });
});
