import { describe, expect, it } from "vitest";
import { hasLoneSurrogate } from "./test-util.js";

import { SWARM_PROMPT_PLACEHOLDER, type SwarmRequestInput } from "./types.js";
import { DUPLICATE_SNIPPET_MAX_CHARS, validateSwarmInput } from "./validate.js";

function input(overrides: Partial<SwarmRequestInput>): SwarmRequestInput {
  return { promptTemplate: `work on ${SWARM_PROMPT_PLACEHOLDER}`, items: ["a", "b"], ...overrides };
}

describe("回显截断不劈开代理对（评审第 1 条）", () => {
  it("DUPLICATE_PROMPTS 的片段在 emoji 处截断时不残留孤立代理", () => {
    // 前 119 个码元是 ASCII，第 120/121 个码元是一个 emoji 的代理对 → 旧实现截在两者之间
    const item = `${"a".repeat(DUPLICATE_SNIPPET_MAX_CHARS - 1)}🚀tail`;
    const r = validateSwarmInput(input({ items: [item, item] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const snippet = String(r.error.details?.itemSnippet);
      expect(hasLoneSurrogate(snippet)).toBe(false);
      expect(snippet).toBe(`${"a".repeat(DUPLICATE_SNIPPET_MAX_CHARS - 1)}…`);
    }
  });
});
