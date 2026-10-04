// ============================================================================
// ui/plugins/host.ts — 服务端插件清单的取数、**宽容解析**与启用表写入（W859 + W9322）。
// ----------------------------------------------------------------------------
// GET/PUT /api/plugins 都已发布（W9322）：GET 返回**两层**共 14 行，每行带
// `layer` / `hot` / `enabled` / `disable`(`optional`|`idle-only`|`required`) /
// `reason`；PUT 替换启用表（专用 SerialQueue + 独立存储层）。
//
// ## 为什么仍然宽容解析（而不是照契约直断言）
//
// `layer` 与 `disable` 是**枚举**，取值域是服务端的知识。前端不假设它已经封口：
//   · 认不出的 `layer`  → `kind: 'other'`（进「其它」段，**不**假装是 host/engine）；
//   · 认不出的 `disable` → `kind: 'unknown'`（**不画开关、也不画「不能关」**，
//     只把取值原样标出来）—— 这与后端 `policyOf` 的 fail-closed 同一条纪律：
//     策略不明 = 不许关，而不是猜一个。
// 认不出名字的项整项忽略，绝不按猜测的字段名伪造行。
//
// ## hot 与 disable 是两件事
//
// `hot` 回答「这一行是不是按代重新装配的」（可换代）；`disable` 回答「能不能被关掉」。
// 两者不可互相推导：`studio/workspaces` 的 `hot` 是 `true`，但 `disable` 是
// `required`（`studio/sessions` 在 mount 里 require 它，抽掉整个 host 起不来）。
// 所以徽标按 `hot` 渲染，开关按 `disable` 渲染，两者各读各的。
// ============================================================================
import { api, putJson, userErrorText } from '../../api';
import type { PluginDisable, PluginLayer } from '../../types/plugin';

export type { PluginDisable, PluginLayer };

/** 一行的「能不能关」——本文件的唯一策略真源（渲染层只认这四种，不看原始字符串）。 */
export type DisableKind = PluginDisable | 'unknown';

/** 一层 ——`'other'` 是**降级出来的**：契约扩枚举而本前端还认不出时的如实去处。 */
export type LayerKind = PluginLayer | 'other';

/** 一行服务端插件。`reason` 原样透传（后端写了原因就别丢，也不改写）。 */
export interface HostPluginRow {
  name: string;
  version: string;
  note: string;
  /** 协议里的层取值（未知时保留原文，供 UI 如实标注「其它层」）。 */
  layer: string;
  /** 本前端认得的层；认不出 = `'other'`。 */
  layerKind: LayerKind;
  /** 是否按代重新装配（**只影响徽标文案**，不代表能关）。 */
  hot: boolean;
  /** 当前启用状态（缺字段时按 `enabled` 缺省为 true —— 与后端「新插件默认开」一致）。 */
  enabled: boolean;
  /** 协议里的停用策略取值（未知时保留原文）。 */
  disable: string;
  /** 本前端认得的策略；认不出 = `'unknown'`（fail-closed：不画开关）。 */
  disableKind: DisableKind;
  /** 后端给的原因（`optional` 行为空串）。原样展示。 */
  reason: string;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 认得的停用策略；**封闭集** —— 不在集合内就是 `unknown`（不猜、不放宽）。 */
const DISABLE_KINDS: ReadonlySet<string> = new Set(['optional', 'idle-only', 'required']);
/** 认得的层（封闭集，同上）。 */
const LAYER_KINDS: ReadonlySet<string> = new Set(['host', 'engine']);

/** 响应可能直接是数组，也可能是 { plugins: [...] }；两者都不是 → 空（不猜）。 */
function listOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload === null || typeof payload !== 'object') return [];
  const inner = (payload as { plugins?: unknown }).plugins;
  return Array.isArray(inner) ? inner : [];
}

/** 纯函数：宽容解析服务端清单（认不出名字的项忽略；枚举认不出就降级，不假装认识）。 */
export function hostPluginRows(payload: unknown): HostPluginRow[] {
  const rows: HostPluginRow[] = [];
  for (const item of listOf(payload)) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const name = text(o['name']) || text(o['id']);
    if (name === '') continue;
    const layer = text(o['layer']);
    const disable = text(o['disable']);
    rows.push({
      name,
      version: text(o['version']),
      note: text(o['description']),
      layer,
      layerKind: (LAYER_KINDS.has(layer) ? layer : 'other') as LayerKind,
      hot: o['hot'] === true,
      enabled: o['enabled'] !== false,
      disable,
      disableKind: (DISABLE_KINDS.has(disable) ? disable : 'unknown') as DisableKind,
      reason: text(o['reason']),
    });
  }
  return rows;
}

/** 拉取服务端清单；端点缺失/网络失败时抛 ApiError（调用方按空态降级，不重试、不伪造）。 */
export async function fetchHostPlugins(): Promise<HostPluginRow[]> {
  return hostPluginRows(await api.plugins());
}

/** 一次切换的结果。`rows` 是**服务端在 PUT 答复里给的真值**（成功时）/ 空数组（失败）。 */
export interface HostSwitchResult {
  ok: boolean;
  text: string;
  rows: HostPluginRow[];
}

/**
 * 写启用表（PUT /api/plugins）：`enabled` = 我要这些开着，其余（清单里关掉的）全关。
 *
 * 走 `enabled`（而不是 `disabled`）有两个理由：① 语义正面（"我要这些开着"）；
 * ② 后端对两个字段**同时**给时会拒绝自相矛盾的请求，只发一个没有这个坑。
 *
 * 成功时**不复用自己的推断**：PUT 的响应与 GET 同形，返回的就是换代后的真值，
 * 调用方按它对齐开关（幂等，也不必猜服务端到底存了什么）。
 * 失败时 `rows` 为空数组 —— 调用方据此回滚开关（状态确实没变）。
 */
export async function setHostPlugins(enabled: string[]): Promise<HostSwitchResult> {
  try {
    return { ok: true, text: '', rows: hostPluginRows(await putJson('/api/plugins', { enabled })) };
  } catch (err) {
    return { ok: false, text: userErrorText(err), rows: [] };
  }
}

/** 按 `layer` 分段（顺序 = 展示顺序；'other' 永远垫底，不与已知层混排）。 */
export const HOST_LAYERS: readonly LayerKind[] = ['host', 'engine', 'other'];

/** 取某层的行（保持服务端给出的顺序 —— mount 顺序是语义，见 plugin-catalog.ts）。 */
export function rowsOfLayer(rows: readonly HostPluginRow[], layer: LayerKind): HostPluginRow[] {
  return rows.filter((r) => r.layerKind === layer);
}
