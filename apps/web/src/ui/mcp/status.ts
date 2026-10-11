// ============================================================================
// ui/mcp/status.ts — 设置页「MCP」一格的**状态面**取数与宽容解析（W-C2）。
// ----------------------------------------------------------------------------
// 数据源只有一个：`GET /api/plugins` 里 `studio.engine.mcp` 那一行的 `mcp` 字段
// （apps/studio/src/runtime/mcp-status.ts 的 McpCatalogStatus，docs §6.3）。
// **没有第二个端点**：端点数冻结在 72，纯增量字段不算新端点。
//
// ## 为什么仍然宽容解析（照 ui/plugins/host.ts 的同一条纪律）
//
// `state` / `failureKind` / issue 的 `kind` 都是**枚举**，取值域是服务端的知识。
// 前端不假设它已封口：认不出的取值一律归 `unknown` 并把原文留在 `state`/`kind`
// 里如实标出，**绝不**猜一个乐观值 —— 与后端 `severityOf` 的「认不出的状态按失败
// 算」同向。名字缺失的行整项忽略，不按猜测的字段名伪造行。
//
// ## 这一格**刻意没有**的两样东西
//
//   · `env` / `headers`：契约层就不可能出现在这一行（§7.2），所以这里没有任何
//     「脱敏后再显示」的加工 —— 需要加工才说明数据本来就在手上，那才是事故。
//   · `command` / `url`：**线上契约里没有这两个字段**（contracts/endpoints.json 的
//     get_plugins 行类型只列了 server/session/transport/state/toolCount/failure*）。
//     所以「命令」这一位如实显示**传输**（stdio / http），并对将来可能出现的
//     command/url 做宽容读取：出现就显示，不出现就不编。
// ============================================================================
import { api } from '../../api';

/** 连接状态 —— 封闭集；`unknown` 是「认不出」的落点，不是第七种状态。 */
export type McpStateKind =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'backoff'
  | 'failed'
  | 'disposed'
  | 'disabled'
  | 'unknown';

/**
 * `disabled` 当前**不会被宿主发出**（§4.1：关掉的 server 根本不连，也就没有状态
 * 可报；一份全关的文档让整块变成 `null`，于是落到「还没有已启用的服务器」空态）。
 * 把它留在封闭集里有两个理由：① 前端不替服务端封口（与 host.ts 的 `disable`
 * 同一纪律）；② 宿主哪天开始报告它，这一格不必再改。
 */
const STATE_KINDS: ReadonlySet<string> = new Set([
  'idle',
  'connecting',
  'ready',
  'backoff',
  'failed',
  'disposed',
  'disabled',
]);

/** 失败分类（宿主侧的 9 值枚举）；`unknown` 同上，是认不出的落点。 */
export type McpFailureKind =
  | 'connect_failed'
  | 'protocol_incompatible'
  | 'unauthorized'
  | 'timeout'
  | 'server_error'
  | 'schema_unsupported'
  | 'not_ready'
  | 'call_failed'
  | 'disposed'
  | 'unknown';

const FAILURE_KINDS: ReadonlySet<string> = new Set([
  'connect_failed',
  'protocol_incompatible',
  'unauthorized',
  'timeout',
  'server_error',
  'schema_unsupported',
  'not_ready',
  'call_failed',
  'disposed',
]);

/** 本前端认得的状态；认不出就是 `unknown`（不猜、不放宽）。 */
export function stateKindOf(state: string): McpStateKind {
  return (STATE_KINDS.has(state) ? state : 'unknown') as McpStateKind;
}

/** 本前端认得的失败分类；认不出就是 `unknown`。 */
export function failureKindOf(kind: string): McpFailureKind {
  return (FAILURE_KINDS.has(kind) ? kind : 'unknown') as McpFailureKind;
}

/** 一个 server 的一行（**不含** env / headers / 凭据 —— §7.2）。 */
export interface McpServerView {
  readonly server: string;
  /** `''` = 无（detached 代没有可寻址的会话 id）。 */
  readonly session: string;
  /** 协议名（stdio / http），原样不译。 */
  readonly transport: string;
  /** 原始状态取值（认不出时保留原文，供 UI 如实标注）。 */
  readonly state: string;
  readonly stateKind: McpStateKind;
  readonly toolCount: number;
  /** `''` = 没报失败。 */
  readonly failureKind: string;
  readonly failureKindLabel: McpFailureKind;
  /** 失败明细原文（可能含文件路径），等宽弱化展示。 */
  readonly failureDetail: string;
  /**
   * 命令 / 端点：**线上契约没有这两个字段**（见文件头）。宽容读取：宿主将来
   * 补上就显示，没补上就是空串 —— 绝不从 `transport` 猜一个出来。
   */
  readonly command: string;
}

/** 一条被跳过 / 被拒绝的配置项（坏配置不静默，§4.3）。 */
export interface McpIssueView {
  readonly kind: string;
  readonly server: string;
  readonly message: string;
}

/** 整块状态面。计数用**宿主给的聚合值**，不由前端重算（§5.5「数字不撒谎」）。 */
export interface McpStatusView {
  readonly sessions: number;
  readonly servers: number;
  readonly tools: number;
  /** 最坏的那一个状态（后端算好的，本前端不重排）。 */
  readonly state: string;
  /** `''` = 没有。配置读不到时的响亮失败原文（带文件路径）。 */
  readonly error: string;
  readonly rows: readonly McpServerView[];
  readonly issues: readonly McpIssueView[];
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 响应可能直接是数组，也可能是 { plugins: [...] }；两者都不是 → 空（不猜）。 */
function listOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload === null || typeof payload !== 'object') return [];
  const inner = (payload as { plugins?: unknown }).plugins;
  return Array.isArray(inner) ? inner : [];
}

function rowsOf(payload: unknown): McpServerView[] {
  const out: McpServerView[] = [];
  const list = Array.isArray(payload) ? payload : [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const server = text(o['server']);
    if (server === '') continue;
    const state = text(o['state']);
    const failureKind = text(o['failureKind']);
    out.push({
      server,
      session: text(o['session']),
      transport: text(o['transport']),
      state,
      stateKind: stateKindOf(state),
      toolCount: count(o['toolCount']),
      failureKind,
      failureKindLabel: failureKindOf(failureKind),
      failureDetail: text(o['failureDetail']),
      // 宽容读取：契约里没有这两个键，键不存在就是空串（不猜、不编）。
      command: text(o['command']) || text(o['url']),
    });
  }
  return out;
}

function issuesOf(payload: unknown): McpIssueView[] {
  const out: McpIssueView[] = [];
  const list = Array.isArray(payload) ? payload : [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    out.push({ kind: text(o['kind']), server: text(o['server']), message: text(o['message']) });
  }
  return out;
}

/**
 * 从 `GET /api/plugins` 的应答里取出 MCP 状态面。
 *
 * `null` = **没有状态可说**：清单里没有 `mcp` 字段（没配 mcp.json、全关、或服务
 * 早于 MCP）。这是一个真实且常见的状态，不是错误，所以调用方据此画空态而不是报错。
 */
export function mcpStatusOf(payload: unknown): McpStatusView | null {
  for (const item of listOf(payload)) {
    if (item === null || typeof item !== 'object') continue;
    const mcp = (item as Record<string, unknown>)['mcp'];
    if (mcp === null || typeof mcp !== 'object') continue;
    const o = mcp as Record<string, unknown>;
    return {
      sessions: count(o['sessions']),
      servers: count(o['servers']),
      tools: count(o['tools']),
      state: text(o['state']),
      error: text(o['error']),
      rows: rowsOf(o['rows']),
      issues: issuesOf(o['issues']),
    };
  }
  return null;
}

/** 拉一次状态面。端点缺失 / 网络不可达 → 抛（调用方画如实空态，不伪造清单）。 */
export async function fetchMcpStatus(): Promise<McpStatusView | null> {
  return mcpStatusOf(await api.plugins());
}
