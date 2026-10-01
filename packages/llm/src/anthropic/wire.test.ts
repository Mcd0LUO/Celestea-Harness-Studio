/**
 * W2068 — the Messages request encoding, pinned to what was measured.
 *
 * Three of these assertions are about fields that differ from the other two
 * protocols in a way that silently produces a wrong request, not a 400:
 *
 *   1. The system prompt is a TOP-LEVEL field. Putting it in `messages` as a
 *      system-role entry is a different request on this protocol.
 *   2. Tools are flat with `input_schema`, not wrapped in `function.parameters`.
 *   3. `max_tokens` is REQUIRED (400 without it), so the body always carries one.
 *
 */

import { describe, expect, it } from "vitest";

import { userMessage, type ToolSpec } from "../seam.js";
import { anthropicUrl, buildAnthropicBody, DEFAULT_MAX_TOKENS } from "./wire.js";

const TOOL: ToolSpec = {
  name: "get_weather",
  description: "Get current weather for a city",
  parameters: { type: "object", properties: { city: { type: "string" } } },
};

describe("W2068 — anthropicUrl", () => {
  it("appends /messages once, and never a second /v1", () => {
    expect(anthropicUrl("http://gw.test/v1")).toBe("http://gw.test/v1/messages");
    expect(anthropicUrl("http://gw.test/v1/")).toBe("http://gw.test/v1/messages");
    expect(anthropicUrl("http://gw.test/v1")).not.toContain("/v1/v1");
  });
});

describe("W2068 — buildAnthropicBody", () => {
  it("1: the system prompt is TOP-LEVEL, never a message", () => {
    const body = buildAnthropicBody({ system: "identity", messages: [userMessage("hi")] }, { model: "m1" });
    expect(body.system).toBe("identity");
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    // The type is the proof: `system` is not a role on this protocol at all, so a
    // body that carried it could not be built without a cast.
    expect(body.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("3: max_tokens is ALWAYS present (the endpoint 400s without it)", () => {
    expect(buildAnthropicBody({ messages: [] }, { model: "m1" }).max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(buildAnthropicBody({ messages: [], max_tokens: 12 }, { model: "m1" }).max_tokens).toBe(12);
    expect(buildAnthropicBody({ messages: [] }, { model: "m1", maxOutputTokens: 30 }).max_tokens).toBe(30);
    // A 0 cap is a request for no cap, which this protocol cannot express; the
    // default is the honest fallback rather than a 400 on every turn.
    expect(buildAnthropicBody({ messages: [], max_tokens: 0 }, { model: "m1" }).max_tokens).toBe(DEFAULT_MAX_TOKENS);
  });

  it("2: tools are flat with input_schema (no function wrapper)", () => {
    const body = buildAnthropicBody({ messages: [], tools: [TOOL] }, { model: "m1" });
    expect(body.tools).toEqual([{ name: "get_weather", description: "Get current weather for a city", input_schema: TOOL.parameters }]);
  });

  it("a tool RESULT is a tool_result block on the user side, not a role", () => {
    const body = buildAnthropicBody(
      { messages: [{ role: "tool", content: [{ type: "text", content: "sunny" }], tool_call_id: "call_7" }] },
      { model: "m1" },
    );
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_7", content: "sunny" }] }]);
  });

  it("an assistant tool_call becomes a tool_use block", () => {
    const body = buildAnthropicBody(
      { messages: [{ role: "assistant", content: [{ type: "tool_call", content: { id: "call_1", name: "f", args: { a: 1 } } }], tool_call_id: null }] },
      { model: "m1" },
    );
    expect(body.messages[0]?.content).toEqual([{ type: "tool_use", id: "call_1", name: "f", input: { a: 1 } }]);
  });

  it("an image block is REFUSED, not sent in a guessed shape", () => {
    expect(() =>
      buildAnthropicBody(
        {
          messages: [
            {
              role: "user",
              content: [{ type: "image", content: { attachment_id: "a1", media_type: "image/png", width: 8, height: 8 } }],
              tool_call_id: null,
            },
          ],
        },
        { model: "m1" },
      ),
    ).toThrow(/image/);
  });

  it("reasoningEffort is accepted and NOT forwarded (no such field here)", () => {
    const body = buildAnthropicBody({ messages: [] }, { model: "m1", reasoningEffort: "high" });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("thinking");
  });
});
