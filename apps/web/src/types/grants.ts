// ============================================================================
// types/grants.ts — 会话权限（W701 提权通道）的线格式族，从 types.ts 按域拆出。
//
//   契约：docs/archive/decisions/feature-session-grants.md §6。
//   与 types/permission.ts 的区别：那里是「权限档位预设」，这里是「单会话逐条放宽」。
// ============================================================================

/** 能力位（设计 §2.2；M2 起加上 computer-use 的 `desktop`）。 */
export type GrantCap =
  | 'network'
  | 'read_roots'
  | 'write_roots'
  | 'net_hosts'
  | 'tool_extra'
  | 'unsandboxed'
  | 'desktop';

/** M2 · 一份应用清单（`desktop` 能力位的 scope，`kind:'apps'` 的两侧之一）。 */
export interface GrantAppList {
  exes?: string[];
  titles?: string[];
}

/** M2 · 应用级 scope：`allow` 为空 = 不限制；deny 永远赢。 */
export interface GrantAppScope {
  allow?: GrantAppList;
  deny?: GrantAppList;
}

/** 能力范围：布尔类为空对象；目录/站点/工具类为列表。 */
export interface GrantScope {
  roots?: string[];
  hosts?: string[];
  tools?: string[];
  /** M2: `desktop` 能力位的应用清单。 */
  apps?: GrantAppScope;
  [key: string]: unknown;
}

/** 一条授权记录（GET /grants 的 grants[]）。 */
export interface GrantEntry {
  id?: string;
  cap?: GrantCap | string;
  scope?: GrantScope;
  granted_at?: number;
  granted_by?: string;
  expires_at?: number | null;
  uses_left?: number | null;
  note?: string;
  /** 服务端判定：该条已过期（读取时判定，设计 §2.3）。 */
  expired?: boolean;
}

/** 生效结果快照（服务端返回；UI 只原样展示，绝不改写措辞）。 */
export interface EffectiveGrants {
  network?: boolean;
  read_roots?: string[];
  write_roots?: string[];
  net_hosts?: string[];
  tool_extra?: string[];
  unsandboxed?: boolean;
  /** M2: computer-use 写工具的能力位。 */
  desktop?: boolean;
  /** M2: 应用级 scope（服务端恒返回，空对象 = 不限制）。 */
  apps?: GrantAppScope;
  [key: string]: unknown;
}

export interface GrantsResp {
  ok?: boolean;
  session?: string;
  grants?: GrantEntry[];
  effective?: EffectiveGrants;
  /** 每种能力的有效期上限（秒）；缺失 = 不限制（前端只用文档默认值 1800）。 */
  max_ttl_sec?: Record<string, number>;
  /** 降低隔离运行是否在本部署中开放（设计 §2.2 注 3 / §8.1）。 */
  unsandboxed_available?: boolean;
  /**
   * W757：本次放宽的站点清单在当前部署下是否真的生效。
   * false = 会话确实带着站点清单，但本部署未启用站点策略，这份清单不会改变可访问范围。
   * 是否生效是部署事实，不随前端变化；旧服务不返回该字段（undefined）时按「不显示」处理。
   */
  net_hosts_effective?: boolean;
  /** 服务返回的提示条目（条目被忽略 / 文件读不出 / 放宽不生效等）；可能缺失或为空。 */
  warnings?: string[];
  error?: string;
}

export interface GrantTokenResp {
  ok?: boolean;
  token?: string;
  expires_at?: number;
  error?: string;
}

/** 授予请求体（POST /grants）。 */
export interface GrantReq {
  cap: GrantCap;
  scope?: GrantScope;
  ttl_sec?: number;
  uses_left?: number | null;
  note?: string;
}

export interface GrantResp {
  ok?: boolean;
  grant?: GrantEntry;
  effective?: EffectiveGrants;
  error?: string;
}

/** 撤销请求体（DELETE /grants）；两者都省略 = 全部撤销。 */
export interface RevokeReq {
  cap?: GrantCap;
  grant_id?: string;
}

export interface GrantRevokeResp {
  ok?: boolean;
  revoked?: string[];
  effective?: EffectiveGrants;
  error?: string;
}
