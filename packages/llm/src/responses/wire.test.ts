/**
 * W2067 — the `responses` request encoding, pinned to what was measured.
 *
 * The reason this file exists rather than a copy of the chat-completions body
 * test: three of these assertions are about fields that FAIL SILENTLY on the
 * measured endpoint, which is the dangerous kind of difference (
 * docs/pitfalls.md P16):
 *
 *   1. The output cap is `max_output_tokens`. Measured: sending that produced
 *      `output_tokens: 5`; sending `max_tokens: 5` instead produced
 *      `output_tokens: 34` and a 200 response — accepted, not rejected,
 *      just not applied. A cap the caller believes in but the wire drops is
 *      worse than a 400, so this asserts the ONE name the body may contain.
 *   2. `reasoning_effort` is NOT forwarded. `reasoning: {effort}` is answered
 *      with HTTP 400 on this endpoint, so forwarding it would be noise; the
 *      adapter reports the gap in `describe()` instead.
 *   3. The endpoint is `{base_url}/responses` with no `/v1` inserted
 *      (base_url already carries it).
 */

import { describe, expect, it } from "vitest";

import { userMessage, type ToolSpec } from "../seam.js";
import { buildResponsesBody, responsesUrl } from "./wire.js";

const TOOL: ToolSpec = {
  name: "get_weather",
  description: "Get current weather for a city",
  parameters: { type: "object", properties: { city: { type: "string" } } },
};

describe("W2067 — responsesUrl", () => {
  it("appends /responses once, and never a second /v1", () => {
    expect(responsesUrl("http://gw.test/v1")).toBe("http://gw.test/v1/responses");
    expect(responsesUrl("http://gw.test/v1/")).toBe("http://gw.test/v1/responses");
    // The chat-completions client would produce /v1/v1/... here.
    expect(responsesUrl("http://gw.test/v1")).not.toContain("/v1/v1");
  });
});

describe("W2067 — buildResponsesBody", () => {
  it("1: the cap travels as max_output_tokens and max_tokens is NEVER emitted", () => {
    const fromRequest = buildResponsesBody({ messages: [], max_tokens: 7 }, { model: "m1" });
    const fromProfile = buildResponsesBody({ messages: [] }, { model: "m1", maxOutputTokens: 9 });
    expect(fromRequest.max_output_tokens).toBe(7);
    expect(fromProfile.max_output_tokens).toBe(9);
    expect(fromRequest).not.toHaveProperty("max_tokens");
    expect(fromProfile).not.toHaveProperty("max_tokens");
  });

  it("1: a 0 or absent cap OMITS the field (same rule as chat-completions)", () => {
    expect(buildResponsesBody({ messages: [] }, { model: "m1", maxOutputTokens: 0 })).not.toHaveProperty("max_output_tokens");
    expect(buildResponsesBody({ messages: [], max_tokens: 0 }, { model: "m1" })).not.toHaveProperty("max_output_tokens");
  });

  it("2: reasoning_effort is accepted and deliberately NOT forwarded", () => {
    const body = buildResponsesBody({ messages: [] }, { model: "m1", reasoningEffort: "high" });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("reasoning");
  });

  it("flattens system + messages into one input array; tool results carry call_id", () => {
    const body = buildResponsesBody(
      {
        system: "identity",
        messages: [
          userMessage("hi"),
          { role: "tool", content: [{ type: "text", content: "sunny" }], tool_call_id: "call_7" },
        ],
      },
      { model: "m1" },
    );
    expect(body.input).toEqual([
      { role: "system", content: "identity" },
      { role: "user", content: "hi" },
      { role: "tool", content: "sunny", call_id: "call_7" },
    ]);
  });

  it("tools are flat (the function wrapper is gone on this protocol)", () => {
    const body = buildResponsesBody({ messages: [], tools: [TOOL] }, { model: "m1" });
    expect(body.tools).toEqual([{ type: "function", name: "get_weather", description: "Get current weather for a city", parameters: TOOL.parameters }]);
  });

  it("an empty tool list omits the field entirely", () => {
    expect(buildResponsesBody({ messages: [], tools: [] }, { model: "m1" })).not.toHaveProperty("tools");
  });
});
