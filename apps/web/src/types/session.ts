// ============================================================================
// types/session.ts — 会话 / 工作区 / 轮次 的 REST 线格式族，从 types.ts 按域拆出
// （同 ./sse 的棘轮理由，types.ts 原样再导出，调用方零改动）。
//
//   会话历史（GET /api/sessions/{id}/messages）见 ./history，文件列举见 ./fs-list。
// ============================================================================

import type { OkResp } from './batch';
import type { SessionMode } from './mode';

export interface SessionInfo {
  id?: string;
  title?: string;
  /** W514: 'session' | 'worker' (absent on legacy backends). */
  kind?: 'session' | 'worker' | string;
  /** W514: a turn is running on this session (absent on legacy backends). */
  busy?: boolean;
  /** W513/W866: worker rows carry their registry wid / status / state. */
  wid?: string;
  status?: string;
  state?: string;
  /**
   * W1470b：该 worker 行属于**上一代**（重启前的进程留下的持久化行，当前没有活实例拥有它）。
   * 当前代的行不带这个键 —— 与 `archived` 同一约定（只有为真时才出现）。
   */
  inherited?: boolean;
  workspace?: string | null;
  events?: number;
  live?: boolean;
  model?: string;
  file?: string;
  size?: number;
  modified?: number;
  archived?: boolean;
  /** W237：是否为当前活跃会话 */
  active?: boolean;
  /**
   * W515：谱系父会话 id（对齐 DSH 的 parentSessionId）。
   * 兼容三种写法：parent / parentSessionId / parent_session；缺失 → 现状平坦展示。
   */
  parent?: string | null;
  parentSessionId?: string | null;
  parent_session?: string | null;
  /**
   * W701：该会话当前生效的放宽项名称列表（可选字段；服务给出时优先用它，
   * 省掉逐会话查询）。缺失 = 走按需查询 / 不显示标记。
   */
  grants_active?: string[];
}

export interface SessionsResp {
  ok?: boolean;
  sessions?: SessionInfo[];
  error?: string;
}

// ---- 工作区 / 会话管理（W236） ------------------------------------------------

export interface WorkspaceInfo {
  name: string;
  path?: string;
  sessions?: number;
}

export interface WorkspacesResp {
  ok?: boolean;
  workspaces?: WorkspaceInfo[];
  active_session?: string | null;
  error?: string;
}

/** POST /api/sessions/{id}/activate 响应。 */
export interface ActivateResp {
  ok?: boolean;
  active_session?: string;
  error?: string;
}

/** POST /api/sessions/{id}/compact 响应（W259：三态——压缩/无需压缩/错误）。 */
export interface CompactResp {
  ok?: boolean;
  /** true=已压缩；false=历史不足，无需压缩（note 给出说明）。 */
  compacted?: boolean;
  kept_turns?: number;
  note?: string;
  error?: string;
}

export interface FsBrowseResp { // GET /api/fs/browse?path=（只列目录）
  path?: string;
  parent?: string | null;
  dirs?: string[];
  roots?: string[];
  error?: string;
}

export interface SessionCreateReq {
  workspace?: string | null;
  title: string;
  /** W243：可选模型（空=跟随默认）。 */
  model?: string;
  /** W245：绑定提示词（空=跟随默认）。 */
  prompt?: string;
  /**
   * W788：工作方式（设计 §2.2；缺省 standard）。前端只在**非默认**（execution）
   * 时携带该键，让默认路径与今天逐字节一致（K8：无 mode 键 = standard）。
   */
  mode?: SessionMode;
}

/** POST /api/sessions 响应（W243 起携带新会话 id）。 */
export interface SessionCreateResp extends OkResp {
  id?: string;
}

export interface TurnResp {
  ok?: boolean;
  turn?: number;
  /**
   * W514: true = the input was injected into the running turn (no new turn),
   * false/absent = a new turn was started with `turn` as its id.
   */
  injected?: boolean;
  /**
   * W515/W847: the backend echo of where the input LANDED — the authoritative
   * terminal state. "steering" = 已插话 (drained at the running turn's next step
   * boundary), "queued" = 已排队 (drained at the next turn start), "context" =
   * this input IS the new turn. The UI renders from this, NOT from `injected`:
   * before W847 a busy + mode=queue response still carried injected:true, and
   * rendering from `injected` overwrote the queued note with "已插话".
   */
  placement?: 'queued' | 'steering' | 'context';
  /** W515: true = 已按「排队（下一回合投递）」接收（mode='queue'）。 */
  queued?: boolean;
  /** W515: 后端回声的投递车道（'next-step' | 'next-turn'）。 */
  inbox_target?: string;
  /** W514: session the turn (or the injection) belongs to. */
  session?: string;
  /**
   * W866: a turn addressed at an engine-memory worker (`session: 'worker:<sid>'`)
   * is DELIVERED to that worker's inbox instead of starting a filesystem-session
   * turn. `worker` echoes the inner session id and `status`/`state` carry the
   * worker's own registry row (a settled worker still accepts the message, it
   * just will not run another turn).
   */
  worker?: string;
  status?: string;
  state?: string;
  error?: string;
}
