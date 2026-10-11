// i18n/locales/zh/mcp.ts — W-C2：设置页「MCP」一格（只读状态面）的文案。
//
// 单开一个域文件（而不是追加进 settings.ts / chat.ts）的理由与 plugins.ts 同款：
// settings.ts 归提供商任务、chat.ts 归聊天任务，本格的文案独立成域，避免并发写冲突。
//
// 协议名（stdio / http）、server 名与失败分类枚举**不译**：它们是判据而不是散文，
// 界面按枚举取值显示（docs/feature/mcp-client.md §6.3「不得用错误文本做分流」的
// 前端一侧同一条纪律）。
export const mcp = {
  'settings.mcp.tab': 'MCP',
  'settings.mcp.paneTitle': 'MCP 服务器',
  'settings.mcp.paneNote': '只读状态面：连接情况与工具数。配置在 mcp.json 里，这一格不提供编辑。',
  'settings.mcp.summary': '{servers} 个服务器 · {tools} 个工具 · {sessions} 个会话实例',
  // 空态：路由到数据文件，而不是给一个假入口（管理面是 P1 的事，docs §12 U11）。
  'settings.mcp.empty': '还没有已启用的 MCP 服务器。',
  'settings.mcp.emptyHint': '在数据目录放一份 mcp.json：全局 <CELESTEA_HOME>/mcp.json，工作区 <CELESTEA_HOME>/workspaces/<ws>/mcp.json。改动在下一次会话换代后生效。',
  'settings.mcp.unavailable': '这一格取不到状态：服务没有返回 MCP 状态。',
  'settings.mcp.configError': '配置读不到：{message}',
  'settings.mcp.tools': '{n} 个工具',
  'settings.mcp.session': '会话实例 {id}',
  'settings.mcp.transport': '传输 {value}',
  'settings.mcp.failure': '失败分类：{kind}',
  'settings.mcp.issuesTitle': '配置问题',
  'settings.mcp.issueLine': '{kind} · {message}',
  'settings.mcp.issueServer': '{server}：{kind} · {message}',
  // 连接状态（封闭集；‘认不出’走 state.unknown，绝不按乐观方向猜）。
  'settings.mcp.state.idle': '未连接',
  'settings.mcp.state.connecting': '连接中',
  'settings.mcp.state.ready': '就绪',
  'settings.mcp.state.backoff': '退避重试中',
  'settings.mcp.state.failed': '失败',
  'settings.mcp.state.disposed': '已释放',
  'settings.mcp.state.disabled': '已停用',
  'settings.mcp.state.unknown': '状态未知',
  // 失败分类（枚举，宿主可据它分支；文案只给人读，不参与分流）。
  'settings.mcp.failure.connect_failed': '连不上',
  'settings.mcp.failure.protocol_incompatible': '协议不兼容',
  'settings.mcp.failure.unauthorized': '鉴权被拒',
  'settings.mcp.failure.timeout': '超时',
  'settings.mcp.failure.server_error': '服务内部错误',
  'settings.mcp.failure.schema_unsupported': '参数 schema 不受支持',
  'settings.mcp.failure.not_ready': '尚未就绪',
  'settings.mcp.failure.call_failed': '调用失败',
  'settings.mcp.failure.disposed': '连接已释放',
  'settings.mcp.failure.unknown': '未知分类',
} as const;
