// ============================================================================
// ui/mcp/index.ts — 设置页「MCP」一格（W-C2 · 只读状态面）。
// ----------------------------------------------------------------------------
//   #settingsMcp
//     .mcp-bar        摘要条：N 个服务器 · M 个工具 · K 个会话实例（**宿主给的数**）
//     .mcp-note.err   配置读不到时的响亮失败（带文件路径，§4.3「不静默」）
//     .mcp-list
//       .mcp-row[data-server][data-state][data-failure]
//         .mcp-row-main
//           .mcp-row-label   server 名 + .mcp-badge（命令 / 传输）
//           .mcp-row-hint    工具数 + 拥有它的那一代会话
//           .mcp-row-reason  失败分类 + 明细原文（等宽弱化，判据是枚举不是文案）
//         .mcp-state[data-state]  连接状态
//     .mcp-sec.mcp-issues  被跳过 / 被拒绝的配置项（issues）
//     .mcp-empty[.err]      无状态 / 取不到状态的如实空态
//
// 铁律：① 离屏构建 + 单次替换（旧内容保持可见到新内容就绪）；② 首屏不写「加载中」
//       占位（取不到就画空态 / 错误态）；③ 竞态守卫（seq）——「重新载入」连点两次
//       时，晚到的旧应答不许覆盖新状态；④ **没有编辑 UI**：状态面只读，配置面是
//       数据文件（docs/feature/mcp-client.md §12 U11，管理面属 P1）。
// ============================================================================
import { need, el } from '../../utils/dom';
import { t, type Key } from '../../i18n';
import { fetchMcpStatus, type McpFailureKind, type McpServerView, type McpStateKind, type McpStatusView } from './status';

const HOST = '#settingsMcp';

/** 状态 → 文案键（**封闭集**；渲染层只认这八种，不看原始字符串）。 */
const STATE_KEYS: Record<McpStateKind, Key> = {
  idle: 'settings.mcp.state.idle',
  connecting: 'settings.mcp.state.connecting',
  ready: 'settings.mcp.state.ready',
  backoff: 'settings.mcp.state.backoff',
  failed: 'settings.mcp.state.failed',
  disposed: 'settings.mcp.state.disposed',
  disabled: 'settings.mcp.state.disabled',
  unknown: 'settings.mcp.state.unknown',
};

/** 失败分类 → 文案键（宿主可据枚举分支；文案只给人读，**不参与分流**）。 */
const FAILURE_KEYS: Record<McpFailureKind, Key> = {
  connect_failed: 'settings.mcp.failure.connect_failed',
  protocol_incompatible: 'settings.mcp.failure.protocol_incompatible',
  unauthorized: 'settings.mcp.failure.unauthorized',
  timeout: 'settings.mcp.failure.timeout',
  server_error: 'settings.mcp.failure.server_error',
  schema_unsupported: 'settings.mcp.failure.schema_unsupported',
  not_ready: 'settings.mcp.failure.not_ready',
  call_failed: 'settings.mcp.failure.call_failed',
  disposed: 'settings.mcp.failure.disposed',
  unknown: 'settings.mcp.failure.unknown',
};

/**
 * 这一行显示的「命令」。
 *
 * 线上契约里**没有** command / url（见 status.ts 文件头），所以今天显示的是传输。
 * 将来宿主补上 command/url 时这里自动改显真值，不补上就一直是传输 —— 任何时候
 * 都不从 transport 反推一个命令出来。
 */
function targetOf(v: McpServerView): string {
  if (v.command !== '') return v.command;
  return t('settings.mcp.transport', { value: v.transport === '' ? '?' : v.transport });
}

/** 一行 server：名字 / 状态 / 工具数 / 命令（脱敏）/ 失败分类。 */
function mcpRow(v: McpServerView): HTMLElement {
  const row = el('div', 'mcp-row');
  row.dataset['server'] = v.server;
  row.dataset['state'] = v.stateKind;
  row.dataset['failure'] = v.failureKindLabel;

  const main = el('div', 'mcp-row-main');
  const label = el('div', 'mcp-row-label', v.server);
  const badge = el('span', 'mcp-badge', targetOf(v));
  badge.dataset['transport'] = v.transport;
  label.appendChild(badge);
  main.appendChild(label);

  const hints = [t('settings.mcp.tools', { n: String(v.toolCount) })];
  if (v.session !== '') hints.push(t('settings.mcp.session', { id: v.session }));
  main.appendChild(el('div', 'mcp-row-hint', hints.join(' · ')));

  if (v.failureKind !== '') {
    const why = t('settings.mcp.failure', { kind: t(FAILURE_KEYS[v.failureKindLabel]) });
    main.appendChild(el('div', 'mcp-row-reason', v.failureDetail === '' ? why : why + ' — ' + v.failureDetail));
  }
  row.appendChild(main);

  const state = el('span', 'mcp-state', t(STATE_KEYS[v.stateKind]));
  state.dataset['state'] = v.stateKind;
  row.appendChild(state);
  return row;
}

/** 配置问题一段：kind 是枚举（判据），message 是原文（含路径，等宽弱化）。 */
function mcpIssues(status: McpStatusView): HTMLElement {
  const sec = el('section', 'mcp-sec mcp-issues');
  sec.appendChild(el('h5', 'mcp-sec-title', t('settings.mcp.issuesTitle')));
  const list = el('div', 'mcp-issue-list');
  for (const issue of status.issues) {
    const line = el('div', 'mcp-issue');
    line.dataset['kind'] = issue.kind;
    line.textContent =
      issue.server === ''
        ? t('settings.mcp.issueLine', { kind: issue.kind, message: issue.message })
        : t('settings.mcp.issueServer', { server: issue.server, kind: issue.kind, message: issue.message });
    list.appendChild(line);
  }
  sec.appendChild(list);
  return sec;
}

/** 空态：路由到数据文件，而不是给一个点不动的按钮（不给编辑 UI）。 */
function mcpEmpty(text: string, hint?: string, err = false): HTMLElement {
  const box = el('div', 'mcp-empty' + (err ? ' err' : ''), text);
  if (hint !== undefined) box.appendChild(el('div', 'mcp-empty-hint', hint));
  return box;
}

/** 离屏画好整格，再**一次**换上去（铁律 1）。 */
function paint(status: McpStatusView | null, failed: boolean): DocumentFragment {
  const off = document.createDocumentFragment();
  if (failed) {
    off.appendChild(mcpEmpty(t('settings.mcp.unavailable'), undefined, true));
    return off;
  }
  if (status === null) {
    off.appendChild(mcpEmpty(t('settings.mcp.empty'), t('settings.mcp.emptyHint')));
    return off;
  }
  const hasContent = status.rows.length > 0 || status.issues.length > 0 || status.error !== '';
  if (!hasContent) {
    off.appendChild(mcpEmpty(t('settings.mcp.empty'), t('settings.mcp.emptyHint')));
    return off;
  }
  // 摘要条用**宿主给的聚合值**，不由前端重算 —— §5.5「数字不撒谎」说的是同一个数。
  const bar = el('div', 'mcp-bar');
  bar.dataset['state'] = status.state;
  bar.textContent = t('settings.mcp.summary', {
    servers: String(status.servers),
    tools: String(status.tools),
    sessions: String(status.sessions),
  });
  off.appendChild(bar);
  if (status.error !== '') off.appendChild(el('div', 'mcp-note err', t('settings.mcp.configError', { message: status.error })));
  if (status.rows.length > 0) {
    const list = el('div', 'mcp-list');
    for (const row of status.rows) list.appendChild(mcpRow(row));
    off.appendChild(list);
  }
  if (status.issues.length > 0) off.appendChild(mcpIssues(status));
  return off;
}

/** 竞态守卫的序号：「重新载入」连点两次时，晚到的旧应答不许覆盖新状态（铁律 3）。 */
let seq = 0;

/** 载入并渲染这一格（ui/config.ts 的 loadPane 调用；「重新载入」会再次调用）。 */
export async function loadMcpSection(): Promise<void> {
  const host = need<HTMLElement>(HOST);
  const mine = ++seq;
  let status: McpStatusView | null = null;
  let failed = false;
  try {
    status = await fetchMcpStatus();
  } catch {
    // 端点缺失 / 网络不可达：画如实空态，不弹错、不重试、不伪造清单（同 ui/plugins）。
    failed = true;
  }
  if (mine !== seq) return; // 已有更新的一次在跑：这一次的结果是旧的，丢掉
  host.replaceChildren(paint(status, failed));
}
