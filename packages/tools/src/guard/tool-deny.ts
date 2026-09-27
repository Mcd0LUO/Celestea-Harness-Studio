/**
 * W9226 · 「权限基线禁止的工具」守卫（session `toolDeny` / preset `toolDeny`）。
 *
 * ## 为什么需要它（一个真实的 P0）
 *
 * `toolDeny` 原先**只**进 `DisclosurePolicy`（暴露面）：模型在工具列表里看不到它，
 * 直调会被 `ExposedRegistry` 拒。但 `run_code` 的 `RegistryHandle` 绑的是**内层**
 * registry（`plugin.ts` 的 `handle.set(registry)`），而 `exposure.ts` 的文档明写
 * 「run_code sub-calls are NOT folded」—— 这是 execution 模式的**设计**（程序里就该
 * 能调 `tools.read_file(...)`）。
 *
 * 于是：**被禁的工具仍可从程序内调用**。实测（W9226 复现）：
 * ```
 * 直调   run_shell => tool_unavailable_in_mode: 'run_shell' is not directly callable  ← 被拒
 * 子调用 run_shell => {"echo":"run_shell","args":{"command":"echo hi"}}            ← 执行了
 * ```
 * 两个独立审计都报了这条（W9206-02、W9210-F2），都标 **P0**。
 *
 * ## 修法的分界（关键）
 *
 * 「模式折叠」与「权限拒绝」是**两件事**，不能共用一个机制：
 *
 * | | 模式折叠（execution） | 权限拒绝（toolDeny） |
 * |---|---|---|
 * | 语义 | 「这个模式不直调它，但程序里可以用」 | 「**禁用**它」 |
 * | 是否该拦子调用 | **不该**（§5.2 #2 的设计） | **必须拦** |
 * | 机制 | 暴露面（face） | 暴露面 **+ guard** |
 *
 * 所以本守卫**只**装 `toolDeny`，绝不把模式折叠的名字放进来 ——
 * 那会破坏 execution 模式（程序里连 `read_file` 都不能用了）。
 *
 * ## 为什么 guard 是正确机制
 *
 * guard 在 `ToolRegistryImpl.dispatch()` 里、**schema 校验之后、执行之前**跑，
 * 而 `run_code` 的 broker 正是通过同一个 registry 派发子调用 ——
 * `broker.test.ts` 已有一条用例证明「guard 拒绝会作为可捕获的 `ToolCallError` 流回子调用」。
 * 因此 guard 天然覆盖**直调与子调用两条路径**，无需识别 `:c<n>` 这类 id 形状。
 */
import { GUARD_ERROR_PREFIX, contractError } from "../errors.js";
import type { ToolDecision, ToolGuard, ToolInput } from "@celestea/core";

/** 守卫拒绝时使用的稳定 code（错误文案里可机械识别）。 */
export const TOOL_DENIED_CODE = "tool_denied_by_session";

/**
 * 拒绝 [denied] 里的任何工具名。
 *
 * 空列表时**不**应被装上（调用方判断），所以这里不做空列表特判 ——
 * 装了就是一条真实守卫，`check` 恒 allow 的守卫是噪音。
 */
export function toolDenyGuard(denied: readonly string[]): ToolGuard {
  const set = new Set(denied);
  return {
    check(input: ToolInput): Promise<ToolDecision> {
      if (!set.has(input.name)) return Promise.resolve({ kind: "allow" });
      // 文案刻意与暴露面的 `tool_unavailable_in_mode` 区分：
      // 那是「这个模式不直调」，这是「**禁用**」。两者对模型的含义不同，
      // 混用会让模型以为「换个模式/写个程序就能绕」—— 而后者正是本 P0。
      const reason = contractError(
        GUARD_ERROR_PREFIX,
        TOOL_DENIED_CODE,
        `'${input.name}' is disabled for this session by its permission baseline; it is not callable directly or from inside run_code.`,
      );
      return Promise.resolve({ kind: "deny", reason });
    },
  };
}