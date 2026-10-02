import { describe, expect, it } from "vitest";
import { loadTools } from "@celestea/core";

/**
 * W-swarm · `agent_swarm` 的**契约形状**门禁（第二道防线）。
 *
 * 为什么契约「已经唯一真源」还要断言它：`swarmToolSpec()`（packages/swarm/src/tool.ts）
 * 是 `loadTools().tools.find(...)` **直读契约**，所以那份设计消灭的是
 * 【实现与契约漂移】——但它保证不了【契约本身对】。契约写错时，GET /api/tools 会
 * 一致地输出同一个错，而且**没有任何第二份手写 schema 会顶撞它**。
 * 一道「实现不漂移」的防线不能替代一道「契约正确」的防线，这是第二道。
 *
 * 钉的是**结构**不是措辞：description 的具体文风是可改的，钉死会让每次润色都要改测试；
 * 真正不可改的是 required 的集合与顺序、items 的 2..128 边界、封闭性、model 的可选性。
 *
 * 独立成文件的原因：它曾与 tools.json 的其余断言同处 tests/contracts.test.ts，
 * 连带把该文件顶过 max-lines 的有效行上限（eslint 跳空行与注释，所以上限按有效行算）。
 * 一条门禁不该逼着别的文件超线，故拆出。
 */
describe("contracts/tools.json · agent_swarm", () => {
  const t = loadTools();

  it("freezes the agent_swarm parameter shape (required set, item bounds, closed object, model optionality)", () => {
    const swarm = t.tools.find((tool) => tool.name === "agent_swarm");
    expect(swarm, "contracts/tools.json must declare agent_swarm").toBeDefined();
    const parameters = swarm?.parameters as {
      properties?: Record<string, { minItems?: number; maxItems?: number }>;
      required?: string[];
      additionalProperties?: boolean;
    };
    // `toEqual`, NOT `toContain`: required is a set AND an order the model reads.
    // feature §3.1: description/items/prompt_template 必填，model 明确「否」。
    expect(parameters.required).toEqual(["description", "items", "prompt_template"]);
    // 封闭对象：未声明参数必须是 schema 错误，不是静默忽略。
    expect(parameters.additionalProperties).toBe(false);
    // 2..128 与 packages/swarm 的实现常量同源（SWARM_MIN_ITEMS / SWARM_MAX_SUBAGENTS，
    // packages/swarm/src/types.ts:110-112）：契约写窄了模型会被拒，写宽了实现会炸，
    // 两个方向都是错 —— 所以这里钉死成实现常量的值，而不是各自写一份。
    const items = parameters.properties?.["items"];
    expect(items?.minItems).toBe(2);
    expect(items?.maxItems).toBe(128);
    // 可选性也是契约的一部分：model 缺省继承会话模型，带错名是结构化错误而非静默降级。
    expect(parameters.required).not.toContain("model");
  });
});
