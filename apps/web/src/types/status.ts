// ============================================================================
// types/status.ts — statusline / 运行时状态族（GET /api/status + SSE status 载荷），
// 从 types.ts 按域拆出（同 ./sse 的棘轮理由，types.ts 原样再导出）。
// ============================================================================

import type { SessionMode } from './mode';

export interface ContextUsage {
  used: number;
  window: number;
  ratio: number;
}

/** Statusline snapshot (GET /api/status + SSE status 增量字段，共享合同). */
export interface StatusSnapshot {
  model?: string;
  reasoning_effort?: string | null;
  steps?: number;
  tokens_per_sec?: number;
  context_usage?: ContextUsage;
  /** W263: engine token usage (latest LLM stream + cumulative `total`). */
  usage?: UsageSnapshot;
  /** W237/W514: the session this snapshot describes (GET /api/status?session=). */
  session?: string | null;
  /** W514: whether that session currently has a turn running (may be absent). */
  busy?: boolean;
  /**
   * W701（设计 §5.7）：该会话当前生效的放宽项名称列表（不含路径细节）。
   * 仅用于侧栏会话叶子的小盾牌标记；字段缺失 = 旧服务，不显示标记。
   */
  grants_active?: string[];
  /**
   * W788：该会话的工作方式（标准/执行）。随快照**按会话**缓存（statusline 的
   * cache: Map<session, StatusSnapshot>）；缺省 = 老服务不返回该字段，徽标隐藏。
   */
  mode?: SessionMode;
  /**
   * W870（只读附加字段，GET /api/status）：本快照的 `model` 是否来自该会话自己的
   * `session.json.model` 覆盖。选择器据此如实标「本会话已固定模型」—— 这样的会话
   * 本来就不跟全局默认走。缺省 = 老服务不返回该字段，不显示该行。
   */
  model_covered?: boolean;
}

/**
 * W263: one usage block — provider-reported counters of one LLM stream.
 * `cache_hit_ratio` = cache_read / prompt_tokens (0 when prompt_tokens == 0).
 */
export interface UsageCounters {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read: number;
  cache_hit_ratio: number;
  reasoning_tokens: number;
}

/** W263: latest stream + cumulative (`total`) usage counters. */
export interface UsageSnapshot extends UsageCounters {
  total?: UsageCounters;
}

/** status SSE payload: turn lifecycle + optional statusline fields. */
export interface StatusPayload extends StatusSnapshot {
  /** W514: envelope version (2 = carries `session`). */
  v?: number;
  /** W514: `session` is inherited from StatusSnapshot (may be null on legacy). */
  seq?: number;
  phase?: 'start' | 'completed' | 'cancelled' | 'error' | 'lagged';
  turn?: number;
  error?: string;
  hint?: string;
  /**
   * W263: the backend nests the statusline snapshot under `statusline`
   * ({"phase":"progress","statusline":{...}}); flat fields stay supported.
   */
  statusline?: StatusSnapshot;
  /**
   * W805（设计 §7.6）：上游 400 归类为「图像不支持」时的降级状态帧字段。
   * 该帧的 envelope.turn=0（进程级提示），前端不得据此结束当前轮次。
   */
  reason?: string;
  /**
   * W805/W1479: a UNION by `phase` — `error` carries the image-downgrade prose
   * (a string); `progress` carries the injected message (an object). Typed
   * `string`-only before, so the object was unreachable and the live injection
   * lane rendered nothing until a refresh replayed the transcript.
   */
  message?: string | InjectedMessagePayload;
  placeholder?: string;
  http_status?: number;
  /** W1479: where the injected message LANDED. Only `context` = in the history. */
  placement?: 'queued' | 'steering' | 'context';
}

/** W1479: the `progress`-frame shape of `StatusPayload.message`. */
export interface InjectedMessagePayload {
  kind?: string;
  from?: string;
  lane?: string;
  summary?: string;
}
