/**
 * 调度器的公开入口：runSwarm + 类型重导出。
 *
 * 为什么入口单独成文件：core.ts 与 rate-limit.ts 是内部实现（包外只能从 @celestea/swarm
 * 引用），本文件是它们唯一的对外收口。调用方要"跑一批任务"只需要 runSwarm；
 * 想要更细的读数（快照、配置预校验）也从这里拿。
 */

import { SwarmScheduler } from "./core.js";
import type { SwarmSchedulerConfig, SwarmSchedulerDeps, SwarmTaskResult, SwarmTaskSpec } from "../types.js";

export { SwarmScheduler, validateSchedulerConfig, RATE_LIMIT_SUSPENDED_REASON } from "./core.js";
export { RateLimitGate, retryDelayMs } from "./rate-limit.js";
export type { ReadyAtSource } from "./rate-limit.js";

/**
 * 便捷入口：按 spec 顺序跑完一批任务，返回与输入等长、按 index 落位的结果数组。
 *
 * 契约：
 *   · 返回的 Promise **只会 resolve**——批次级失败以 failed 结果的形式落位，不 reject；
 *     唯一会抛错的情况是非法 config，且那是**构造期同步抛出**（调用本函数时即抛）。
 *   · 非法 config 在这里同步抛，而不是变成一个 rejected Promise：宿主可以在装配期就拿到
 *     这个错误并 fail-fast，不必等到批次开始后再从结果里反推"为什么一个都没跑"。
 */
export function runSwarm(
  specs: readonly SwarmTaskSpec[],
  deps: SwarmSchedulerDeps,
  config?: Partial<SwarmSchedulerConfig>,
): Promise<SwarmTaskResult[]> {
  return new SwarmScheduler(specs, deps, config).run();
}
