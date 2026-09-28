// @vitest-environment node
/**
 * W2062 · 真 broker 端到端：用户那段程序必须得到**可操作**的 program_syntax 消息。
 *
 * 这是本修复的**真实链路**验证 —— 不是断言 classifyProgramFailure 被调用过，
 * 而是把用户原文送进真 broker（真 node 子进程、真 userspace 沙箱、真行协议），
 * 再看返回给模型的 message 里有没有「缺几个括号」与「改用裸语句」的退路。
 *
 * 为什么必须走真 broker：braceHint 依赖 `ctx.programSource`，而那个字段是在
 * `brokerRun` 里装配期赋的。单元测试直接调 classifyProgramFailure 会绕过这条
 * 接线 —— 一个「忘了赋值」的实现能通过全部单元断言，却让真实用户看不到提示。
 */
import { afterAll, describe, expect, it } from "vitest";

import type { Tool } from "@celestea/core";
import { startBrokerHarness, type BrokerHarness } from "./broker.test-util.js";

const h: BrokerHarness = await startBrokerHarness();

afterAll(async () => {
  await h.cleanup();
});

/** The program from the production report, verbatim (missing the final `}`). */
const UNBALANCED = [
  "function main() {",
  "  const out = [];",
  '  for (const c of ["echo A", "echo B", "echo C"]) {',
  "    out.push(tools.run_shell({ command: c }).stdout.trim());",
  "  }",
  "  return { looped: out };",
].join("\n");

const BALANCED = UNBALANCED + "\n}";

describe.skipIf(!h.nodeReady)("W2062 · 真 broker：program_syntax 的消息可操作", () => {
  const mount = (): Tool => h.mount(h.echoRegistry());

  it("① 缺一个 } 的程序：真 broker 返回 program_syntax + 缺几个 + 退路", async () => {
    // The broker THROWS a ToolFailure for a rejected program (that is how the
    // model sees it), so the assertion is on the thrown message.
    const message = await h
      .run(mount(), "w2062-a", { code: UNBALANCED })
      .then(() => "")
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(message).toContain("program_syntax");
    expect(message).toContain("1 unclosed");
    expect(message).toContain("DROP that wrapper");
  }, 60_000);

  it("② 配平的程序：同一路径不许出现「缺括号」假警报", async () => {
    // 这段真的会跑起来（echo A/B/C）。它应当成功；无论成败，
    // 消息里都不许出现「缺括号」这种假警报。
    const message = await h
      .run(mount(), "w2062-b", { code: BALANCED })
      .then((o) => JSON.stringify(o))
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(message).not.toContain("unclosed");
  }, 60_000);
});
