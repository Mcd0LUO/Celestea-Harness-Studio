// ============================================================================
// ui/commands/mcp.ts — **MCP server 清单**的前端缓存（composer-surface §7 的第三种 kind）
// ----------------------------------------------------------------------------
// 数据源只有一个：`GET /api/plugins` 响应里那行的 `mcp` 字段（mcp-client.md §6.3；
// studio 侧的真源是 apps/studio/src/runtime/mcp-status.ts 的 McpCatalogStatus，
// 挂在 `studio.engine.mcp` 那一行上）。前端**不读盘、不看配置**：配没配、连没连上，
// 服务端已经如实报出来了，界面照报显示。
//
// ★ 同步缓存纪律（照 skills.ts 逐字同一条）：判定侧只暴露**同步**读取，
//   缓存 miss 按「未命中」处理，拉取失败**不写缓存**（下一次打开补全会再拉，
//   而不是把「拉不到」记成「没有 server」）。
//   ⇒ 与技能清单的差别只在数据源与作用域：MCP 是**进程级**的（插件行是进程级的，
//     见 mcp-status.ts 的文件头），所以不按会话分键。
//
// ★ server 名必须过 `MCP_SERVER_NAME_PATTERN`（gesture 包的唯一定义处）：
//   合不字符集就拼不出 `/mcp:<server>`，chip 与补全项都无从谈起。
// ============================================================================
import { MCP_SERVER_NAME_PATTERN, canonicalSlash, parseSlashGesture } from '@celestea/gesture';

import { api } from '../../api';
import type { PopupItem } from './popup';
import { t } from '../../i18n';

/** 一行 server 的必要信息（其余字段是诊断用，chip 不需要）。 */
export interface McpServer {
  readonly server: string;
  readonly transport: string;
  readonly state: string;
  readonly toolCount: number;
}

let cache: McpServer[] | null = null;
/** 竞态守卫（FRONTEND-RULES 铁律 3）：晚到的旧结果一律丢弃。 */
let seq = 0;
/** 在飞标记：连着敲 /m… 也不会每键一发。 */
let inflight = false;

/** 清单**已到**吗（补全首次打开时的补拉判据）。 */
export function mcpCached(): boolean {
  return cache !== null;
}

/** 缓存里的 server 名（同步读；空 = 缓存未到或这个 host 根本没配 MCP）。 */
export function mcpServerNames(): readonly string[] {
  return (cache ?? []).map((s) => s.server);
}

/** 缓存里的 server 行（诊断/测试用）。 */
export function cachedMcpServers(): readonly McpServer[] {
  return cache ?? [];
}

/**
 * 失效 + 重拉（设置页改了 mcp.json / 会话切换时走这条）。
 *
 * 返回这次拉取的 promise：调用方要在它落地**之后**重判 chip（E5）——
 * 「清单到了才恢复成 chip」这条链挂在 then 上，不挂在调用点上。
 */
export function reloadMcpServers(): Promise<void> {
  cache = null;
  seq += 1;
  inflight = false;
  return refreshMcpServers();
}

/**
 * 拉一次清单并填缓存。
 *
 * ★ 失败/异常**不写缓存**：cache 留在 null，下一次补全打开会再拉。
 *   「拉不到」与「没有 server」是两件事，缓存只有一个槽位，不能混。
 */
export async function refreshMcpServers(): Promise<void> {
  if (inflight) return;
  inflight = true;
  const my = ++seq;
  try {
    const resp = await api.plugins();
    if (my !== seq) return;
    cache = readServers(resp.plugins);
  } catch {
    if (my === seq) cache = null;
  } finally {
    if (my === seq) inflight = false;
  }
}

/**
 * 从 `GET /api/plugins` 的 plugins[] 里读出 MCP 那一行的 server 清单。
 *
 * 逐项容错（与 types/plugin.ts 的文件头同一条纪律：契约会扩，不假设它已封口）：
 * 只有 `mcp.rows[]` 里 server 合字符集、transport/state 是字符串的行算数。
 */
function readServers(plugins: unknown): McpServer[] {
  if (!Array.isArray(plugins)) return [];
  const out: McpServer[] = [];
  for (const row of plugins) {
    const mcp = (row as { mcp?: unknown } | null)?.mcp;
    if (typeof mcp !== 'object' || mcp === null) continue;
    const rows = (mcp as { rows?: unknown }).rows;
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      const server = (r as { server?: unknown } | null)?.server;
      if (typeof server !== 'string' || !MCP_SERVER_NAME_PATTERN.test(server)) continue;
      const transport = (r as { transport?: unknown }).transport;
      const state = (r as { state?: unknown }).state;
      const toolCount = (r as { toolCount?: unknown }).toolCount;
      out.push({
        server,
        transport: typeof transport === 'string' ? transport : '',
        state: typeof state === 'string' ? state : '',
        toolCount: typeof toolCount === 'number' ? toolCount : 0,
      });
    }
  }
  return out;
}

/**
 * `/mcp:` 候选（MCP 组）。按名字前缀过滤，**显示与写回都用规范形态** `/mcp:<server>`
 * （与技能组同一条纪律：用户一眼看出自己落在哪个命名空间）。
 *
 * desc 用 server 的连接状态如实标注（连不上的 server 也列出来 —— 用户要能看见它坏了，
 * 而不是「看不见就当没有」）。文案走 i18n；状态词本身是服务端给的原样值。
 */
export function mcpItems(prefix: string): PopupItem[] {
  const p = barePrefix(prefix).toLowerCase();
  const out: PopupItem[] = [];
  for (const s of cachedMcpServers()) {
    if (!s.server.toLowerCase().startsWith(p)) continue;
    const canonical = canonicalSlash('mcp', s.server);
    if (canonical === null) continue;
    out.push({
      label: canonical,
      desc: mcpDesc(s),
      meta: s.toolCount > 0 ? String(s.toolCount) : '',
      value: canonical,
      group: t('chat.mcp.group'),
    });
  }
  return out;
}

/**
 * 补全前缀里的命名空间前缀（`mcp:mem` ⇒ `mem`）。
 *
 * ★ 与 skills.ts 的 barePrefix 同一条理由：规范形态 `/mcp:<server>` 是选中即写回的
 *   那一份，用户下一次打开补全时前缀就带着 `mcp:`；不剥掉它，server 一条都匹配不上。
 *   不会混淆：server 名过 MCP_SERVER_NAME_PATTERN（无冒号）。
 */
/**
 * 这一行是不是「点名某个 MCP server」的手势（放行判定用）。
 *
 * ★ 与技能那条**故意不同**：技能读同步缓存裁决（'/{技能名}' 是既有的裸形态，清单不命中
 *   就不该放行），而 MCP 走 D9 的**字符串契约**——`/mcp:<server>` 是 MCP 的唯一形态，
 *   且「同一个字符串指什么」**不随装了什么变化**（§5.6）。所以这里是纯语法判定：
 *   清单里有没有这个 server、连没连上，一律交给 host 裁决并**响亮**回答。
 *   前端按清单拦一次，只会把「缓存还没到」变成一次假否决。
 *
 * ★ 裸 `/name` 永不代表 MCP：parseSlashGesture 把裸 token 判成 command，所以
 *   `/memory` 在这里必为 false（哪怕清单里正好有个 memory server）。
 */
export function isMcpGesture(line: string): boolean {
  const gesture = parseSlashGesture(line.trim());
  return gesture !== null && gesture.kind === 'mcp';
}

function barePrefix(prefix: string): string {
  return prefix.startsWith('mcp:') ? prefix.slice('mcp:'.length) : prefix;
}

/** 一行说明：就绪写「{n} 个工具」，其余写状态词本身（不翻译、不粉饰）。 */
function mcpDesc(s: McpServer): string {
  if (s.state === 'ready' || s.state === '') return t('chat.mcp.ready', { n: s.toolCount });
  return t('chat.mcp.state', { state: s.state });
}
