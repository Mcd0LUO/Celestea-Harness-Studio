// ============================================================================
// Celestea Studio — shared type contracts
//
// 这是**唯一公开面**：全仓所有 `from './types.js'` / `'../types.js'` 的既有路径
// 一行都不用改。实体定义按职责拆到 ./types/*.ts，本文件只做再导出。
//
//   ./sse        SSE envelope / meta / 各 payload
//   ./status     statusline 快照 + 用量计数 + status 载荷
//   ./session    会话 / 工作区 / 轮次 的 REST 线格式
//   ./provider   模型提供商族
//   ./prompt     提示词系统族
//   ./grants     会话权限放宽族
//   其余已拆出的族：attachment / batch / config / context / exec / fs-list /
//   fs-read / goal / health / history / mode / permission / plugin / question /
//   session-model / terminal / tool-events / usage。
//
// 拆分的理由：撞上了前端模块体积棘轮（tools/module-size-baseline.json 登记行数，
// 只许降不许升）。拆分后本文件回到默认 450 行上限内，故**已从例外表删除该条登记**。
//
// `SseEventName` 是**唯一没有搬走**的实体：门禁 tools/check-sse-events.mjs 不用
// TS 解析器，而是对本文件**逐字正则**抓这一条 type 联合的成员字面量（也不跟
// `./types/sse` 跨文件找），所以它必须逐字留在 `src/types.ts` 本体。改它必须
// 同步 contracts/sse-events.json 与 packages/core。
//
//   ⚠ 同理：这段说明**绝不能**在本文件里写出该 type 声明的逐字外形 —— 门禁的正则
//   匹配到的是「第一个出现的那个形状」，注释里写一遍就会让门禁抓空。
//
// 视图层合同（AssistantView / ToolOpView）见 ui/view.ts（与 API 合同分离）。
// ============================================================================

// ---- SSE / 状态 -------------------------------------------------------------

/**
 * SSE event names. W1479: the SAME closed set as the server's `SSE_EVENT_NAMES`
 * (contracts/sse-events.json), enforced by `tools/check-sse-events.mjs`.
 *
 * It used to carry `context` and `inbox`, which the server can NEVER emit — its
 * bus asserts the contract list on every emit — so those two listeners were dead
 * code and live injection never appeared (it only showed up after a refresh, via
 * the transcript restore path). `turn_end` is deliberately absent: the UI learns
 * a turn's end from the `status` phase and from `done`. The checker records that
 * exemption explicitly instead of letting the two sets drift apart again.
 */
export type SseEventName =
  | 'status'
  | 'text'
  | 'thinking'
  | 'tool'
  | 'tool_result'
  | 'done'
  | 'compact'
  /** W784：模型向用户提问（挂起等待作答；答案不经 POST /api/turn 回传）。 */
  | 'question'
  /** W1528：工作台终端的 pty 字节（契约第 10 名；载荷见 types/terminal.ts）。 */
  | 'terminal';

export type {
  CompactPayload,
  ConnState,
  DonePayload,
  SseEnvelope,
  SseMeta,
  TextPayload,
  ThinkingPayload,
} from './types/sse';

export type {
  ContextUsage,
  InjectedMessagePayload,
  StatusPayload,
  StatusSnapshot,
  UsageCounters,
  UsageSnapshot,
} from './types/status';

// ---- 会话 / 工作区 / 轮次 ---------------------------------------------------

export type {
  ActivateResp,
  CompactResp,
  FsBrowseResp,
  SessionCreateReq,
  SessionCreateResp,
  SessionInfo,
  SessionsResp,
  TurnResp,
  WorkspaceInfo,
  WorkspacesResp,
} from './types/session';

// ---- 模型提供商（W236） ------------------------------------------------------

export type {
  ProviderFetchResp,
  ProviderInfo,
  ProviderModelSpec,
  ProviderTestResp,
  ProvidersResp,
} from './types/provider';

// ---- 提示词系统（W245） ------------------------------------------------------

export type {
  PromptInfo,
  PromptsResp,
  PromptSection,
  PromptUpsertReq,
} from './types/prompt';

// ---- 会话权限（W701 提权通道；契约见 docs/archive/decisions/feature-session-grants.md §6） ---

export type {
  EffectiveGrants,
  // M2-B2a：应用清单族（desktop 的 scope）—— grants UI 的录入与展示都要用，
  // 视图层只从 './types' 取类型（与其它 grants 类型同一条路径）。
  GrantAppList,
  GrantAppScope,
  GrantCap,
  GrantEntry,
  GrantReq,
  GrantResp,
  GrantRevokeResp,
  GrantsResp,
  GrantScope,
  GrantTokenResp,
  RevokeReq,
} from './types/grants';

// ---- 工具类事件（W1467） -----------------------------------------------------

export type { ToolPayload, ToolResultPayload } from './types/tool-events';

// ---- 文件列举（H：@提及） ----------------------------------------------------

export type { FsListEntry, FsListResp } from './types/fs-list';

// ---- W784：模型向用户提问（契约见 docs/archive/decisions/feature-ask-user.md §3） ----

export type {
  PendingQuestionInfo,
  QuestionAnswerItem,
  QuestionAnswerResp,
  QuestionIntent,
  QuestionItem,
  QuestionOption,
  QuestionPayload,
  QuestionsResp,
} from './types/question';

// ---- W726 上下文快照 --------------------------------------------------------

export type {
  ContextCounts,
  ContextMessage,
  ContextToolInfo,
  ContextUsageInfo,
  SessionContextResp,
} from './types/context';

// ---- 只读自省端点 -----------------------------------------------------------

export type { HealthCapabilities, HealthInfo, ToolInfo, ToolsResp } from './types/health';

// ---- 附件（W805 多模态） -----------------------------------------------------

export type { AttachmentRef, ImageMediaType, TurnAttachmentInput } from './types/attachment';

// ---- 会话历史（GET /api/sessions/{id}/messages） ----------------------------

export type { HistoryMsg, HistoryRole, MessagesResp } from './types/history';

// ---- 工作方式（W788） --------------------------------------------------------

export type { SessionMode, SessionModeResp } from './types/mode';

// ---- 会话级模型切换（PUT /api/sessions/{id}/model） -------------------------

export type { SessionModelResp } from './types/session-model';

// ---- 通用回执 / 批量请求体与响应（W792） -------------------------------------

export type { BatchFailedItem, BatchIdsReq, BatchNamesReq, BatchOpResp, CancelResp, ClearResp, OkResp } from './types/batch';

// ---- W870 配置族 ------------------------------------------------------------

export type { ConfigAvailable, ConfigInfo, ConfigPatch, ConfigSaveResp, ModelInfo } from './types/config';
