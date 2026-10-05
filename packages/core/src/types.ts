/**
 * Core shared types for the Celestea TS rewrite.
 *
 * These mirror the frozen contracts 1:1:
 *  - SessionEvent / TurnOutcome : retired-engine/crates/core/src/session_log.rs
 *  - SSE envelope + LoopEvent   : celestea_studio/src/main.rs:640-732
 *  - Studio message projection  : celestea_studio/src/api.rs:94-135
 *
 * Field names are contract, not style: do not rename anything here.
 */

import type { ImageRef } from "./message.js";

// ---------------------------------------------------------------------------
// Session log (engine v1 JSONL)
// ---------------------------------------------------------------------------

/** The 5 real terminal states of a turn (never collapse these). */
export type TurnOutcome =
  | "completed"
  | "cancelled"
  | { error: { kind: "generate" | "stream"; message: string } }
  | "step_limit"
  | "interrupted";

export const TURN_OUTCOMES: readonly string[] = [
  "completed",
  "cancelled",
  "error",
  "step_limit",
  "interrupted",
] as const;

export interface TurnStartEvent {
  type: "turn_start";
  id: string;
}
export interface TurnEndEvent {
  type: "turn_end";
  id: string;
  /** Legacy rows omit it and deserialize as "completed". */
  outcome?: TurnOutcome;
}
export interface UserMessageEvent {
  type: "user_message";
  text: string;
  /**
   * W804: content-addressed image references attached to this message. Omitted
   * entirely when there are none (serde style), so every pre-W804 row is
   * byte-identical; the bytes live in the session's attachments/ directory and
   * NEVER in the log.
   */
  attachments?: ImageRef[];
  /**
   * W888: WHERE this user-role row came from. Absent = 'user' (a real typed
   * input), so every pre-W888 log row is byte-identical and reads as a user
   * bubble. A non-'user' origin lets the transcript render an injected block
   * (skill catalog / memory / receipt / steering / compaction) as an INBOX row,
   * visually distinct from something the human actually said.
   *
   * Omitted when it is 'user' (serde style): the common case keeps the old bytes.
   */
  origin?: SessionEventOrigin;
}

/**
 * W888: the closed set of `user_message` origins.
 *
 * W9347: `goal` joined the set. The persistent session goal (POST
 * /api/sessions/{id}/goal) became MODEL-visible: its resident line and its
 * one-shot change notice are both appended as `origin: "goal"` user rows, so
 * the transcript can label them as system injections instead of showing them
 * as something the human typed.
 */
export type SessionEventOrigin = "user" | "skill" | "memory" | "receipt" | "steering" | "compact" | "goal";

export const SESSION_EVENT_ORIGINS: readonly string[] = ["user", "skill", "memory", "receipt", "steering", "compact", "goal"];
export interface AssistantMessageEvent {
  type: "assistant_message";
  text: string;
}
export interface ThinkingDeltaEvent {
  type: "thinking_delta";
  text: string;
}
export interface ToolCallEvent {
  type: "tool_call";
  id: string;
  name: string;
  args: unknown;
  /** W255 run_code sub-call: present only for nested rows. */
  parent_id?: string;
}
/**
 * W855 (B6): how the MODEL-VISIBLE face of a tool result is derived from the
 * log's ORIGINAL `value` at read time. The session log stores the original; the
 * projection (`projection.ts`) applies this descriptor. Keeping it on the row is
 * what makes a replay reproduce the live model context byte for byte (the
 * retention decision is a per-step budget outcome, not a pure function of the
 * value).
 */
export type ToolResultSurface =
  | {
      /** Retention replaced an oversized result with a bounded head/tail window. */
      kind: "omitted";
      omitted_bytes: number;
      total_bytes: number;
      locator: string;
      retrieval_hint: string;
      head_bytes: number;
      tail_bytes: number;
    }
  | {
      /** The tool itself truncated the result and authored a retrieval note. */
      kind: "truncation";
      note: string;
    };

export interface ToolResultEvent {
  type: "tool_result";
  id: string;
  value: unknown;
  error: string | null;
  /** W255 run_code sub-call: present only for nested rows. */
  parent_id?: string;
  /** W855 (B6): the model-face descriptor; absent = project `value` as-is. */
  surface?: ToolResultSurface;
}

/**
 * W783 §7: the model ASKED the user something. A host-side audit row (the engine
 * never writes one) recording the request while the turn is parked, so a client
 * that reconnects can rebuild the card and a replay can see what was asked.
 */
export interface UserQuestionEvent {
  type: "user_question";
  /** Request id (`q-<n>`), echoed by the matching `user_answer` row. */
  id: string;
  /** The question batch as the model asked it. */
  questions: unknown[];
  /**
   * Absolute deadline in ms, judged at READ time (§6.1) — so a replay still
   * knows whether the question had expired, with no timer involved.
   */
  expires_at?: number;
  /** The resolved maximum wait in ms. */
  timeout_ms?: number;
}

/**
 * W783 §7: the question was answered (or expired). `answers` holds the same
 * items the tool returned, with `selected` as option LABELS.
 */
export interface UserAnswerEvent {
  type: "user_answer";
  /** The request id this row answers. */
  id: string;
  answers: unknown[];
  /** `true` = the deadline expired and no answer exists (§6.3). */
  timed_out?: boolean;
}

/**
 * W2018 (B1): a compaction BEGAN — a PURE MARKER row; the tag is the payload.
 *
 * It is written as the FIRST row of the NEW log, inside the same atomic rename
 * that installs the compacted history (rewriteAtomic), so it can never be
 * observed half-written: either the whole compacted log (marker included) is on
 * disk, or the pre-compaction log is, untouched. Its partner
 * [CompactionEndEvent] is appended only AFTER the rename succeeded, so a log
 * whose compaction_start has no following compaction_end is the durable
 * signature of a compaction interrupted between the rewrite and its completion
 * — a state that used to be indistinguishable from an ordinary short session
 * (docs/pitfalls.md P12).
 */
export interface CompactionStartEvent {
  type: "compaction_start";
}

/**
 * W2018 (B1): the compaction FINISHED — appended after the atomic rewrite
 * succeeded. See [CompactionStartEvent] for the pairing contract.
 */
export interface CompactionEndEvent {
  type: "compaction_end";
}

export type SessionEvent =
  | TurnStartEvent
  | TurnEndEvent
  | UserMessageEvent
  | AssistantMessageEvent
  | ThinkingDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | UserQuestionEvent
  | UserAnswerEvent
  | CompactionStartEvent
  | CompactionEndEvent;

export const SESSION_EVENT_TYPES = [
  "turn_start",
  "turn_end",
  "user_message",
  "assistant_message",
  "thinking_delta",
  "tool_call",
  "tool_result",
  "user_question",
  "user_answer",
  // W2018 (B1): the two field-free compaction markers (9 -> 11). Additive, like
  // the W783 question rows: a reader that does not know them stops at that row
  // (torn tail) instead of inventing content.
  "compaction_start",
  "compaction_end",
] as const;

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Studio message projection (GET /api/sessions/{id}/messages)
// ---------------------------------------------------------------------------

export interface UserMessageOut {
  role: "user";
  content: string;
  /**
   * W804: the attachments of this user message (references only). Omitted when
   * there are none, so every existing golden message stays byte-identical.
   */
  attachments?: ImageRef[];
}

/**
 * W888: an injected user-role row projected for the transcript — NOT something
 * the human typed. `kind` is the origin ('skill' | 'memory' | 'receipt' |
 * 'steering' | 'compact'); `source` is the human-readable label the UI shows.
 * There is no `content` field here because the wire shape reuses `content` at
 * the projection site (kept in [StudioMessage] as the shared discriminator).
 */
export interface InboxMessageOut {
  role: "inbox";
  kind: SessionEventOrigin;
  content: string;
  /** Human-readable origin label (e.g. '技能目录', '记忆 · 每轮注入', '回执 · W1'). */
  source: string;
  attachments?: ImageRef[];
}
export interface AssistantMessageOut {
  role: "assistant";
  content: string;
}
export interface ThinkingMessageOut {
  role: "thinking";
  content: string;
}
export interface ToolCallMessageOut {
  role: "tool";
  kind: "call";
  tool_call_id: string;
  tool_name: string;
  tool_args: unknown;
  tool_parent_id?: string;
}
export interface ToolResultMessageOut {
  role: "tool";
  kind: "result";
  tool_call_id: string;
  /** W855 (B6): the bounded/annotated model face when the row carries a `surface`. */
  tool_value: unknown;
  tool_error: string | null;
  tool_parent_id?: string;
  tool_surface?: ToolResultSurface;
}

/**
 * W783 §7: a question the model asked, as the transcript surface shows it.
 * `content` carries the raw batch the tool received.
 */
export interface QuestionAskedMessageOut {
  role: "question";
  kind: "question";
  /** Request id (`q-<n>`), matching the `user_answer` row. */
  question_id: string;
  content: unknown;
  /** Absolute deadline in ms (absent on a legacy/hand-written row). */
  question_expires_at?: number;
}

/**
 * W783 §7: the answer to a question (or the fact that it expired). `content`
 * carries the answer items, whose `selected` entries are option LABELS.
 */
export interface QuestionAnsweredMessageOut {
  role: "question";
  kind: "answer";
  question_id: string;
  content: unknown;
  /** `true` = the deadline expired; nothing was chosen on the model's behalf. */
  question_timed_out?: boolean;
}

export type StudioMessage =
  | UserMessageOut
  | InboxMessageOut
  | AssistantMessageOut
  | ThinkingMessageOut
  | ToolCallMessageOut
  | ToolResultMessageOut
  | QuestionAskedMessageOut
  | QuestionAnsweredMessageOut;

// ---------------------------------------------------------------------------
// SSE (GET /api/events)
// ---------------------------------------------------------------------------

export const SSE_EVENT_NAMES = [
  "text",
  "thinking",
  "tool",
  "tool_result",
  "turn_end",
  "done",
  "status",
  "compact",
  // the model asked the user something and the turn is PARKED on it.
  "question",
  // raw bytes from a workbench terminal's pty. This is the ONE event that
  // is neither a turn event nor a host status frame: it is produced by the
  // terminal handler and its payload is opaque terminal output.
  "terminal",
] as const;

export type SseEventName = (typeof SSE_EVENT_NAMES)[number];

/**
 * `data:` field of every SSE frame.
 *
 * W513 extension (pure addition): `v` is the envelope version (2 = per-session
 * envelope; a missing `v` is a legacy 0 envelope) and `session` names the
 * session the frame belongs to (`null` = process-level frame, e.g. `lagged`).
 * `turn` is the SESSION-local turn number, `seq` stays process-global monotonic
 * and `payload` is unchanged.
 */
export interface SseEnvelope<P = unknown> {
  v: number;
  session: string | null;
  turn: number;
  seq: number;
  payload: P;
}

export const STATUS_PHASES = [
  "start",
  "progress",
  "completed",
  "cancelled",
  "error",
  "step_limit",
  "interrupted",
  "lagged",
] as const;

export type StatusPhase = (typeof STATUS_PHASES)[number];

/**
 * agent_swarm：成员相位的**四组展示口径**（§7.2 折叠分组用）。
 *
 * 为什么只有四组而不是把 packages/swarm 的七态原样搬过来：这里是**呈现层**的
 * 归并口径，调度器内部七态（queued / starting / running / retrying / done /
 * failed / cancelled）保持数据侧的忠实，由组装方在投影时折叠成这四组。
 * 也就是说「调度器的状态机」与「界面看到的分组」是两个层次，不要互相顶替。
 */
export const SWARM_MEMBER_PHASES = [
  "running",
  "failed",
  "done",
  "cancelled",
] as const;

export type SwarmMemberPhase = (typeof SWARM_MEMBER_PHASES)[number];

/** 一个 swarm 成员的展示视图（组装方投影出来的只读快照）。 */
export interface SwarmMemberView {
  /** 1-based 编号口径的成员标识（与 agent_swarm 全链 1..N 的编号一致）。 */
  id: string;
  /** 面向用户的任务短描述（已由组装方做长度裁剪，界面不再二次截断）。 */
  label: string;
  phase: SwarmMemberPhase;
  /** 成员失败时的原因摘要（phase === "failed" 时有意义，其余为空串）。 */
  error?: string;
}

/** 一个批次（同一次 agent_swarm 调用）的展示视图。 */
export interface SwarmBatchView {
  /** 批次标识：多批次时界面用它做切换的稳定键。 */
  id: string;
  /** 批次级模型标签（该批次的模型路由结果，缺省即未指定）。 */
  model: string;
  members: SwarmMemberView[];
  /** 已完成成员数（只数成功落定的 done）。 */
  done: number;
  /** 批次总成员数。 */
  total: number;
}

/**
 * Statusline.swarm 的形状（§7.1：纯内存态，**不落盘**、**不加 SSE 事件名**）。
 *
 * 设计与收口接线约定（请照此实现，不要另立一份真源）：
 *   · 本字段是 **Statusline 上的可选附加字段**，不是新事件 / 新端点。组装
 *     statusline 响应时从 SwarmRegistry 服务**投影**一份只读快照挂上来。
 *   · 未挂载 swarm 插件 / 没有活动批次时**整个字段缺省**（不是空对象、
 *     不是空数组）—— 前端据此零渲染：徽标保持隐藏且不报错。
 *   · 「同一次调用 >= 2 成员才聚合成 swarm 卡片」这条阈值由**前端**
 *     apps/web/src/statusline/swarm.ts 的纯函数持有；组装方**不得**预先过滤
 *     单成员批次。理由：数据形状保持忠实、呈现规则归呈现层 —— 过滤只发生
 *     一次，所以这是一份真源而不是两份。
 */
export interface SwarmRosterView {
  /** 是否有**进行中**的成员（false = 全部落定，徽标可整体隐藏）。 */
  active: boolean;
  batches: SwarmBatchView[];
}

export interface Statusline {
  model: string;
  reasoning_effort: string | null;
  steps: number;
  /**
   * W218/W754/W763 throughput estimate, in CHARACTERS per second (the frozen
   * field name is historical; the UI shows it as an approximate ~1:1 token rate).
   * The mean over "active" intervals only — no-flow breaks (> `GAP_MS` = 1s
   * between deltas: long tool calls, stalls, the idle tail of a finished turn)
   * never enter the denominator. It is the responsive 5s window rate while that
   * window still carries output, and the whole TURN's active-interval mean once
   * the window empties, so it stays a stable positive number after a stall or
   * after the turn ends. 0 means exactly one thing: this turn has produced no
   * text/thinking delta yet (TTFT). Reset by the next turn.
   */
  tokens_per_sec: number;
  context_usage: {
    used: number;
    window: number;
    ratio: number;
    /** W755: `used` is the visible-surface ESTIMATE, not a real provider sample. */
    estimated: boolean;
    /**
     * W755 source vocabulary:
     *   - `usage_prompt_tokens` the REAL prompt of a provider usage frame;
     *   - `assembled_estimate`  the token estimate of the loop's own next request
     *                           (system + trimmed history + tool schemas);
     *   - `none`                nothing measurable -> the UI shows "unknown";
     *   - `session_event_chars` RETIRED in v2.5.0 (the session log's CHARACTER
     *                           count was divided by a TOKEN window). Kept in the
     *                           union so a consumer can still recognise a payload
     *                           from an older build; never emitted any more.
     */
    method: "usage_prompt_tokens" | "session_event_chars" | "assembled_estimate" | "none";
    /**
     * W755 (Fix B): true when `used` carries the model-visible growth measured
     * after the prompt sample — i.e. it answers for the NEXT request rather than
     * the last one (DSH `projectedTokens`). Distinct from `estimated`.
     */
    projected: boolean;
    /**
     * W755 (Fix C): where `window` came from. `ratio` is a real measurement only
     * for `profile`; `fallback` (no declared capacity -> the 1,000,000 display
     * default applies) and `unknown` both report `window: 0, ratio: 0`.
     */
    window_source: "profile" | "fallback" | "unknown";
  };
  usage: UsageBlock & { total: UsageBlock };
  /**
   * agent_swarm 的批次名册快照（§7.1，**可选**附加字段）。
   *
   *   · 缺省 = 未挂载 swarm 插件 / 没有活动批次。老服务与旧前端读到缺省必须
   *     照常渲染其余状态栏字段，不报错、不显示 swarm 徽标。
   *   · 纯内存态：不落盘、不进 contracts/data-files/，因此**不新增 SSE 事件名** ——
   *     它随既有 status 帧的快照一起更新。
   *   · 形状见 [SwarmRosterView]（含 >= 2 成员才聚合那条阈值的归属说明）。
   */
  swarm?: SwarmRosterView;
}

export interface UsageBlock {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read: number;
  cache_hit_ratio: number;
  reasoning_tokens: number;
}

/** Engine loop events, mapped 1:1 onto SSE names by loop_event_to_json. */
export type LoopEvent =
  | { kind: "text"; delta: string }
  | { kind: "thinking"; delta: string }
  | { kind: "tool_call"; id: string; name: string; args: unknown }
  | {
      kind: "tool_result";
      callId: string;
      ok: boolean;
      value: unknown;
      render: unknown;
      error: string | null;
      decision: "allow" | "deny" | "ask" | null;
    }
  | { kind: "turn_end"; outcome: TurnOutcome }
  | { kind: "done"; text: string; tool_calls: Array<{ id: string; name: string; args: unknown }> };

// ---------------------------------------------------------------------------
// HTTP error envelope
// ---------------------------------------------------------------------------

export interface ErrorEnvelope {
  ok: false;
  error: string;
}

export interface OkEnvelope {
  ok: true;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ToolDecision = { kind: "allow" } | { kind: "deny"; reason: string } | { kind: "ask"; reason: string };

// ---------------------------------------------------------------------------
// Providers / workspaces / sessions (public views)
// ---------------------------------------------------------------------------

export interface ProviderModelPublic {
  id: string;
  name: string;
  reasoning_efforts: string[];
  context_window: number | null;
  max_output_tokens: number | null;
}

/** NOTE: `api_key` is intentionally absent from this type. */
export interface ProviderPublicView {
  id: string;
  name: string;
  note: string;
  base_url: string;
  request_format: "chat_completions" | "responses" | "anthropic_messages";
  models: ProviderModelPublic[];
  is_default: boolean;
  has_key: boolean;
}

export interface ProvidersView {
  providers: ProviderPublicView[];
  default_model: string | null;
}

export interface WorkspaceView {
  name: string;
  path: string;
  sessions: number;
}

export interface WorkspacesView {
  workspaces: WorkspaceView[];
  active_session: string | null;
}

export interface SessionSummary {
  id: string;
  workspace: string;
  title: string;
  model: string | null;
  size: number;
  modified: number;
  active: boolean;
  kind?: "worker";
}

export interface SessionsView {
  sessions: SessionSummary[];
  active_session: string | null;
}

// ---------------------------------------------------------------------------
// Workers (registry.tsv)
// ---------------------------------------------------------------------------

export const WORKER_STATUSES = ["RUNNING", "DONE", "FAILED", "STOPPED"] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export interface WorkerEntry {
  wid: string;
  started_at: string;
  status: WorkerStatus;
  extra: string;
}
