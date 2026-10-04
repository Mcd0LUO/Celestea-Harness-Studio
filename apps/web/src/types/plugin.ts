// ============================================================================
// types/plugin.ts — 服务端插件清单的**宽容**线格式（W859 外壳 + W9327 两层字段）。
// ----------------------------------------------------------------------------
// W9322 之后端点已发布，`GET /api/plugins` 返回**两层**（`host` 8 行 + `engine`
// 6 行）共 14 行，每行带 `layer` / `hot` / `enabled` / `disable` / `reason`；
// `PUT /api/plugins` 替换启用表（body 与 GET 同形，`disabled` / `enabled` 二选一）。
// 旧的「由后续任务补 / 本轮只有只读半边」注释到此为止：端点已经存在，前端按真字段读。
//
// 为什么仍然是 `unknown` 优先：**契约会扩枚举**。`layer` / `disable` 的取值域是
// 服务端的知识（`apps/studio/src/plugin-catalog.ts`），前端不假设它已经封口 ——
// 渲染层逐项容错：认不出的层归「其它」段，认不出的停用策略**不假装认识**
// （fail-closed：不画开关，也不画「不能关」的断言，只如实标出取值本身）。
//
// 本文件只有类型，构建期擦除，不进产物。
// ============================================================================

/** 一层。`"host"` = 启动层注入 token；`"engine"` = 每会话由引擎装配的功能插件。 */
export type PluginLayer = 'host' | 'engine';

/** 一行的停用策略（`hot` 与 `disable` 是两件事：`hot` = 能不能换代，`disable` = 能不能关）。 */
export type PluginDisable = 'optional' | 'idle-only' | 'required';

/** `GET /api/plugins` 的 `plugins[]` 一行（契约见 contracts/endpoints.json 的 get_plugins）。 */
export interface PluginRespRow {
  name?: unknown;
  /** 服务端契约固定给，但类型上仍按 unknown 校验（见文件头）。 */
  layer?: unknown;
  hot?: unknown;
  enabled?: unknown;
  disable?: unknown;
  /** `disable !== "optional"` 时必须给出；原样展示，不翻译、不改写。 */
  reason?: unknown;
  /** 老端点可能带的补充字段（W859 的半边）：保留宽容读取。 */
  version?: unknown;
  description?: unknown;
}

/** GET /api/plugins 的响应（`plugins` 故意留 unknown，渲染层逐项容错）。 */
export interface PluginsResp {
  ok?: boolean;
  /** 两层插件清单（结构按逐项容错读取，见文件头）。 */
  plugins?: unknown;
  /** 停用表（`plugins[].enabled` 的补集投影；两个都给是后端的有意兼容）。 */
  disabled?: unknown;
  /** 启用表读取时的告警（后端 loadWarnings）。 */
  warnings?: unknown;
}

/** PUT /api/plugins 的请求体（两个字段都可选，缺省 = 保留原值）。 */
export interface PluginsPutReq {
  /** 替换整张停用表。 */
  disabled?: string[];
  /** 替换整张启用表（`disabled` 的补集）。 */
  enabled?: string[];
}

/** PUT /api/plugins 的响应（与 GET 同形：PUT 成功后返回的就是新的真值）。 */
export type PluginsPutResp = PluginsResp;
