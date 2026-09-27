/**
 * W2017 — the token-cap truncation is OBSERVABLE on the production path.
 *
 * The unit gates live in \`packages/llm/src/finish-reason.test.ts\` (parse ->
 * terminal event). This file closes the last gap: the REAL assembly
 * (\`createEngineLlm\` -> \`createLiveLlm\` -> the OpenAI-compatible client -> the
 * provider->core bridge) against a local mock upstream, so what is asserted is
 * the path a deployed process actually runs, not a hand-built seam.
 *
 * The mock sends the two \`finish_reason\` values the repo has observed live
 * (docs/feature-multimodal-attachments/01-evidence.md:104 and :128).
 */

import { afterEach, describe, expect, it } from "vitest";
import { collectStream, userMessage } from "@celestea/llm";
import type { ModelRequest } from "@celestea/core";
import type { Profile } from "@celestea/runtime";
import { createEngineLlm } from "./llm-assembly.js";
import { DONE_FRAME, sseChunk, startMockProvider, textDelta, type MockProvider } from "./mock-provider.test-util.js";

let upstream: MockProvider | null = null;

afterEach(async () => {
  if (upstream !== null) await upstream.close();
  upstream = null;
});

/** The provider's LAST delta frame: the reason, with an empty delta. */
function finishFrame(reason: string): string {
  return sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
}

function profileFor(model: string, baseUrl: string): Profile {
  return {
    model,
    base_url: baseUrl,
    api_key_env: "CELESTEA_API_KEY",
    reasoning_effort: null,
    max_output_tokens: 200,
    context_window_tokens: 1_000_000,
  } as unknown as Profile;
}

/** Run one turn through the production assembly; returns the audit lines. */
async function runTurn(answers: readonly (readonly string[])[]): Promise<{ lines: string[]; kinds: string[] }> {
  upstream = await startMockProvider(answers);
  const lines: string[] = [];
  const llm = createEngineLlm(
    profileFor("mock-v4-pro", upstream.v1BaseUrl),
    { CELESTEA_API_KEY: "test-key" } as NodeJS.ProcessEnv,
    "live",
    (model) => lines.push(model),
  );
  const request: ModelRequest = {
    model: "mock-v4-pro",
    system: null,
    messages: [userMessage("hi")],
    tools: [],
    max_tokens: null,
    temperature: null,
  };
  const events = await collectStream(await llm.generate(request));
  return { lines, kinds: events.map((e) => e.kind) };
}

describe("W2017 · a max_tokens truncation reaches the host", () => {
  it("reports the truncation once when the provider stops on the token cap", async () => {
    const { lines, kinds } = await runTurn([[textDelta("The answer is "), finishFrame("length"), DONE_FRAME]]);
    expect(kinds).toEqual(["text", "done"]);
    expect(lines).toEqual(["mock-v4-pro"]);
  });

  it("reports NOTHING for an ordinary stop", async () => {
    const { lines, kinds } = await runTurn([[textDelta("done"), finishFrame("stop"), DONE_FRAME]]);
    expect(kinds).toEqual(["text", "done"]);
    expect(lines).toEqual([]);
  });

  it("reports NOTHING when the provider sends no finish_reason at all", async () => {
    const { lines, kinds } = await runTurn([[textDelta("done"), DONE_FRAME]]);
    expect(kinds).toEqual(["text", "done"]);
    expect(lines).toEqual([]);
  });

  it("does not repeat the report when the reason arrives on several frames", async () => {
    const { lines } = await runTurn([[textDelta("x"), finishFrame("length"), finishFrame("length"), DONE_FRAME]]);
    expect(lines).toEqual(["mock-v4-pro"]);
  });
});
