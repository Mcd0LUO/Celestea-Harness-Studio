// ============================================================================
// api/permission.ts — 权限预设 / 会话权限档位（W9）的 HTTP 封装。
//
//   端点：GET/POST /api/permissions/presets、PUT/DELETE /api/permissions/presets/{id}、
//         GET/PUT /api/sessions/{id}/permission、
//         GET /api/sessions/{id}/permission/confirm-token（B5-01 新增）。
//
//   为什么单独一个文件：B5-01 给换档接上一次性确认后，api.ts 涨到 458 行，
//   越过 450 的默认上限。按仓规的棘轮纪律（tools/check-module-size.mjs
//   + module-size-baseline.json）应当**拆分**而不是登记例外 —— 与 W9103/W9268
//   拆 usage/types 的先例一致。本模块是**纯搬家**（连注释一起搬），端点、
//   路径、请求头、返回类型逐字未改。
//
//   依赖方向：本模块 import 上层的 api.ts 提供的 request/post/put 三件套
//   （与 api/usage.ts 同款），因此 api.ts 末尾 import 本模块 —— 单向。
// ============================================================================
import { postJson, putJson, requestJson } from '../api';
import type { GrantTokenResp } from '../types';
import type {
  PermissionPreset,
  PermissionPresetDeletedResp,
  PermissionPresetResp,
  PermissionPresetsResp,
  SessionPermissionResp,
} from '../types/permission';

const sessionPath = (id: string, tail: string): string => '/api/sessions/' + encodeURIComponent(id) + tail;

/**
 * GET /api/permissions/presets —— 内置三档 + 自定义档 + 运行时封顶 max。
 * max 是**真源**（可能低于所选档）：界面如实展示，不替用户「修正」。
 */
export const permissionPresets = (): Promise<PermissionPresetsResp> =>
  requestJson<PermissionPresetsResp>('/api/permissions/presets');

/** POST /api/permissions/presets {preset}：409 = id 已存在（含内置 id）/ 422 = 字段非法。 */
export const createPermissionPreset = (preset: PermissionPreset): Promise<PermissionPresetResp> =>
  postJson<PermissionPresetResp>('/api/permissions/presets', { preset });

/** PUT /api/permissions/presets/{id} {preset}：内置档 409、不存在 404、非法 422。 */
export const updatePermissionPreset = (id: string, preset: PermissionPreset): Promise<PermissionPresetResp> =>
  putJson<PermissionPresetResp>('/api/permissions/presets/' + encodeURIComponent(id), { preset });

/** DELETE /api/permissions/presets/{id}：200 {deleted} / 内置 409 / 不存在 404。 */
export const deletePermissionPreset = (id: string): Promise<PermissionPresetDeletedResp> =>
  requestJson<PermissionPresetDeletedResp>('/api/permissions/presets/' + encodeURIComponent(id), {
    method: 'DELETE',
  });

/** GET /api/sessions/{id}/permission：该会话选中的档位 + 已过封顶的生效快照。 */
export const sessionPermission = (id: string): Promise<SessionPermissionResp> =>
  requestJson<SessionPermissionResp>(sessionPath(id, '/permission'));

/**
 * GET /api/sessions/{id}/permission/confirm-token?preset=&scope_hash=：
 * 切换档位的一次性确认令牌（TTL 60s，绑定 会话+档位，用后即焚）。
 *
 * B5-01：换档是一次**能力变更**，服务端与 grants 用同一道人工确认门
 * （同源证据 + HttpOnly nonce cookie + 一次性令牌），所以前端必须先取令牌
 * 再 PUT；裸 PUT 一律 403。nonce cookie 由浏览器同源自动带，无需手工搬运。
 *
 * 令牌绑定的是**目标档位**（scope_hash 的口径见 security/scope-hash.ts 的
 * permissionScopeHash），所以为 A 档铸的令牌装不了 B 档。
 */
export const permissionToken = (id: string, preset: string, scopeHash: string): Promise<GrantTokenResp> =>
  requestJson<GrantTokenResp>(
    sessionPath(id, '/permission/confirm-token?preset=' + encodeURIComponent(preset) +
      '&scope_hash=' + encodeURIComponent(scopeHash)),
  );

/**
 * PUT /api/sessions/{id}/permission {preset}，带一次性确认令牌头（人工切换路径专用）。
 * 403 = 缺确认 / 令牌失效；409 = 令牌已用；422 = 未知档位（调用方回滚徽标并说明）。
 */
export const setSessionPermission = (id: string, preset: string, token: string): Promise<SessionPermissionResp> =>
  putJson<SessionPermissionResp>(sessionPath(id, '/permission'), { preset }, {
    'X-Celestea-Grant-Confirm': token,
  });
