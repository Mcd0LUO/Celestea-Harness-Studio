/**
 * W2014 · summarize.ts 的超时是「抛错」语义，必须继续是。
 *
 * 这一处原来自己实现了一份 `Promise.race`（与 sandbox/async.ts 的同名函数几乎同形，
 * 但**语义不同**：那边超时返回 [TIMED_OUT] 哨兵，这边超时**抛 Error**）。
 * W2014 把 race 收敛进统一原语，本文件钉住收敛后**语义没被压成另一种**：
 *
 *   · 超时必须 REJECT（不是 resolve 哨兵、不是静默返回空摘要）；
 *   · 消息必须带上 `what` 标签，且能区分是「发起请求」超时还是「读流」超时
 *     —— 这正是 DSH `@deepseek-ai/dsh-timeout` 里 capability-owned `code` 的作用：
 *     调用方要能认出**自己的**deadline，而不是被嵌套的上游 deadline 冒充。
 *
 * 之前本函数没有任何直接测试（grep 全仓：只有 session-compose 的生产调用点），
 * 所以「收敛后行为不变」这件事此前无法被证伪。
 */
import { describe, expect, it } from "vitest";
import type { Llm, LlmStream, ModelRequest } from "@celestea/core";

import { llmSummarizer, summaryRequest, withTimeout } from "./summarize.js";

/** A generate() that never resolves — only the deadline can end the call. */
const neverLlm: Llm = {
  generate: (): Promise<LlmStream> => new Promise<LlmStream>(() => undefined),
};

describe("W2014 · summarize 超时语义（抛错，不是哨兵）", () => {
  it("withTimeout 超时 ⇒ REJECT，消息含 what 标签与预算", async () => {
    const failure: Error = await withTimeout(new Promise<string>(() => undefined), 20, "摘要请求").then(
      () => new Error("the deadline must NOT resolve"),
      (e: Error) => e,
    );
    expect(failure, "超时必须抛错，不能 resolve 一个哨兵值").toBeInstanceOf(Error);
    expect(failure.message).toBe("摘要请求 timeout after 20ms");
  });

  it("llmSummarizer：generate 挂住 ⇒ 以「摘要请求失败」抛出，绝不返回空摘要", async () => {
    const summarize = llmSummarizer({ llm: neverLlm, model: "m", timeoutMs: 20 });
    const failure: Error = await summarize("transcript").then(
      () => new Error("a hung generate must NOT produce a summary"),
      (e: Error) => e,
    );
    expect(failure).toBeInstanceOf(Error);
    // 失败模型：坏流/超时/空答案都是 ERROR —— 静默丢历史比不压缩更糟。
    expect(failure.message).toContain("摘要请求失败");
    expect(failure.message).toContain("摘要请求 timeout after 20ms");
  });

  it("两种 what 标签可区分（generate 与 stream-read 不是同一个 deadline）", async () => {
    const messageOf = (what: string): Promise<string> =>
      withTimeout(new Promise<string>(() => undefined), 15, what).then(
        () => "the deadline must NOT resolve",
        (e: Error) => e.message,
      );
    const generate = await messageOf("摘要请求");
    const read = await messageOf("摘要流读取");
    expect(generate).not.toBe(read);
    expect(generate).toContain("摘要请求");
    expect(read).toContain("摘要流读取");
  });

  it("summaryRequest 形状不变（收敛 race 不该动请求体）", () => {
    const req: ModelRequest = summaryRequest("m", "hello");
    expect(req.model).toBe("m");
    expect(req.tools).toEqual([]);
    expect(req.messages).toHaveLength(1);
  });
});
