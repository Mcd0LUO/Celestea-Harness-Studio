// ============================================================================
// types/sse.ts — SSE 事件族（GET /api/events）的线格式，从 types.ts 按域拆出。
//
//   为什么单独一个文件：types.ts 撞上了前端模块体积棘轮
//   （tools/module-size-baseline.json 登记行数，只许降不许升），按
//   ./tool-events、./mode、./question 的先例按**职责**整族拆出；types.ts
//   原样再导出，调用方零改动。
//
//   `SseEventName` 例外：它必须逐字留在 `../types.ts` 本体（门禁
//   tools/check-sse-events.mjs 用 `/export type SseEventName =([\s\S]*?);/`
//   直接从 `src/types.ts` 抓成员字面量，不解析 TS），故没有搬进来。
// ============================================================================

// W1467：ToolPayload / ToolResultPayload 在 ./tool-events（它反过来 import 本文件的
// SseMeta —— 类型层循环引用，编译期擦除，与拆出前 types.ts ↔ types/tool-events 同款）。
import type { ToolPayload } from './tool-events';

/** SSE envelope: every event carries { turn, seq, payload }. */
export interface SseEnvelope {
  /** W514: envelope version (2 = carries `session`; absent/1 = legacy single-session). */
  v?: number;
  /** W514: target session id — the frontend routes every frame by this field. */
  session?: string;
  turn?: number;
  seq?: number;
  payload?: Record<string, unknown>;
}

/**
 * W514: fields the envelope contributes to every payload (the SSE client merges
 * them flat). All optional — a legacy backend omits them and the frontend falls
 * back to the single-session behaviour.
 */
export interface SseMeta {
  v?: number;
  session?: string;
  turn?: number;
  seq?: number;
}

export type ConnState = 'connecting' | 'online' | 'down';

export interface TextPayload extends SseMeta {
  delta: string;
}

export interface ThinkingPayload extends SseMeta {
  delta: string;
}

export interface DonePayload extends SseMeta {
  text?: string;
  tool_calls?: ToolPayload[];
}

/** compact 类事件（W259：/compact 压缩完成；payload 带会话 id）。 */
export interface CompactPayload {
  session?: string;
  kept_turns?: number;
  note?: string;
  rebound?: boolean;
}
