// ============================================================================
// statusline/permission/tier.ts — W1517：合并面板的 **§1 会话档位** 段落。
//
//   为什么单独一个文件：W1517 把「档位」与「精细授权」合并进同一个面板
//   （ui/grants/panel/body.ts），面板主体已经接近体积棘轮的上限；档位段落自带
//   列表渲染 + 点选（乐观 + 失败回滚），独立成模块后两个面板段落互不牵连。
//
//   语义逐条沿用 W858 的旧档位弹层（未改一字）：
//     · 列出内置 + 自定义档，当前档打「当前」标记且不可再点；
//     · 点选**当帧**改徽标与「当前」标记（乐观，W795 口径），PUT 失败回滚到原档并
//       就地说明原因（段落状态行 + 状态栏轻提示），面板留着让用户重选；
//     · 无活动会话 ⇒ 档位行全部禁用 + 一行说明（不是隐藏整块 —— 入口现在也承载
//       精细授权，藏掉整块会让用户以为「权限没了」）；
//     · 档位清单没回来时正文留空，**不做占位文案**（W795 去占位口径）。
//
//   宿主（PermissionHost）由装配层注入：ui/grants.ts 把 statusline 侧的档位控制器
//   适配进来（同一个 focusedSession / 同一份档位缓存），面板与徽标因此永不失同步。
//   与后端的关系：PUT /api/sessions/{id}/permission，422 透传服务端原因，其余固定措辞。
//   一次性提权语义（TTL / 可撤销 / 审计）不在这里，见 ui/grants/**（设计 §4 I4）。
// ============================================================================
import { ApiError, api, userErrorText } from '../../api';
import { permissionScopeHash } from '../../security/scope-hash';
import { t } from '../../i18n';
import { el } from '../../utils/dom';
import { maxNote, riskNote } from '../../ui/permissions/copy';
import { allPresets, findPreset, snapshot } from '../../ui/permissions/store';
import type { PermissionPreset, SessionPermissionResp } from '../../types/permission';
import type { PermissionHost } from '../permission';

/** 段落级状态行（失败就地说明，留在屏幕上供重选）。 */
let status: { text: string; cls: string } | null = null;

/** 面板打开时清一次（上一次的失败回执不该跟着新面板出现）。 */
export function resetTierStatus(): void {
  status = null;
}

/**
 * 渲染 §1 会话档位（离屏构建，调用方负责单次替换）。
 * `repaint` = 面板主体的重画函数（乐观切换与失败回滚都要当帧重画这一块）。
 */
export function tierSection(h: PermissionHost, repaint: () => void): HTMLElement {
  const box = el('div', 'perm-tier');
  box.appendChild(el('div', 'sl-popup-sep', t('grants.body.tierLabel')));
  for (const p of allPresets()) box.appendChild(presetRow(p, h, repaint));
  const risk = riskNote(findPreset(h.currentPreset));
  if (risk !== '') box.appendChild(el('div', 'sl-popup-note perm-risk', risk));
  const max = snapshot()?.max ?? '';
  if (max !== '') box.appendChild(el('div', 'sl-popup-note', maxNote(max)));
  if (h.sessionId === '') box.appendChild(el('div', 'sl-popup-note', t('statusline.perm.noSession')));
  if (status !== null) box.appendChild(el('div', 'sl-popup-status ' + status.cls, status.text));
  return box;
}

function presetRow(p: PermissionPreset, h: PermissionHost, repaint: () => void): HTMLElement {
  const current = p.id === h.currentPreset;
  const b = el('button', 'sl-opt' + (current ? ' current' : '')) as HTMLButtonElement;
  b.type = 'button';
  b.dataset.preset = p.id;
  b.appendChild(el('span', 'sl-opt-name', p.label || p.id));
  b.appendChild(el('span', 'sl-opt-val', p.id));
  if (current) b.appendChild(el('span', 'sl-opt-tag', t('statusline.currentTag')));
  b.disabled = current || h.sessionId === '';
  b.addEventListener('click', () => {
    if (!current && h.sessionId !== '') void pickPreset(p, h, repaint);
  });
  return b;
}

interface PickOutcome {
  ok: boolean;
  text: string;
}

/**
 * 取一次性确认令牌 → PUT 换档（B5-01）。
 *
 * 换档是一次**能力变更**：服务端与 grants 用同一道人工确认门（同源证据 +
 * HttpOnly nonce cookie + 一次性令牌 + TTL），裸 PUT 一律 403。nonce cookie 由
 * 浏览器同源自动带，前端只负责「先取令牌、再带令牌 PUT」这两步。
 *
 * 令牌绑定的是**目标档位**（permissionScopeHash 的口径），所以为 A 档铸的令牌
 * 装不了 B 档 —— 服务端会拿请求里的档位重算摘要再比对。
 *
 * 重试口径沿用 grants 的 submitGrant：403/409 视为令牌失效或已用，重新取一枚
 * 再试**一次**（用户的点选动作本身已经完成，不必因此让用户重来）；其余错误
 * 直接上抛，由调用方回滚徽标。
 */
async function submitPreset(session: string, preset: string): Promise<SessionPermissionResp> {
  const scopeHash = await permissionScopeHash(preset);
  for (let attempt = 0; attempt < 2; attempt++) {
    const tok = await api.permissionToken(session, preset, scopeHash);
    if (!tok.token) throw new ApiError(userErrorText(tok.error, t('statusline.retryLater')));
    try {
      return await api.setSessionPermission(session, preset, tok.token);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 409) && attempt === 0) continue;
      throw err;
    }
  }
  throw new ApiError(t('statusline.retryLater'));
}

/**
 * PUT /api/sessions/{id}/permission：只有 422 透传服务端原因，其余走固定措辞。
 *
 * B5-01 补的一条：403/409 是**确认门**的答复，不是「档位被拒」——换一句话说明，
 * 否则用户会以为是自己点错了档位，而真实原因是令牌没取到 / 已失效。
 */
async function requestPreset(session: string, preset: string): Promise<PickOutcome> {
  try {
    const r = await submitPreset(session, preset);
    if (r.ok === false) return { ok: false, text: t('statusline.withRestoredTier', { text: t('statusline.perm.rejected') }) };
    if (typeof r.preset === 'string' && r.preset !== preset) {
      return { ok: false, text: t('statusline.withRestoredTier', { text: t('statusline.perm.notAccepted') }) };
    }
    return { ok: true, text: '' };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 404 || err.status === 405) {
        return { ok: false, text: t('statusline.withRestoredTier', { text: t('statusline.perm.unsupported') }) };
      }
      if (err.status === 422) {
        return { ok: false, text: t('statusline.withRestoredTier', { text: t('statusline.switchFailed', { reason: err.technical || t('statusline.perm.unknownTier') }) }) };
      }
      if (err.status === 403 || err.status === 409) {
        return { ok: false, text: t('statusline.withRestoredTier', { text: t('statusline.switchFailed', { reason: t('statusline.perm.confirmFailed') }) }) };
      }
      return { ok: false, text: t('statusline.withRestoredTier', { text: t('statusline.switchFailed', { reason: err.message }) }) };
    }
    return { ok: false, text: t('statusline.withRestoredTier', { text: t('statusline.switchFailed', { reason: userErrorText(err, t('statusline.retryLater')) }) }) };
  }
}
/**
 * 点选一档：当帧换徽标 + 重画面板（乐观）；失败回滚并就地说明原因。
 *
 * 为什么成功也重画（而不是收起面板）：面板现在同时承载精细授权 —— 切一档就收起，
 * 用户要再授予还得重新点开。这里只把「当前」标记更新到新档。
 */
async function pickPreset(p: PermissionPreset, h: PermissionHost, repaint: () => void): Promise<void> {
  const prevId = h.currentPreset;
  const prevLabel = findPreset(prevId)?.label ?? prevId;
  h.applyPermission(p.id, p.label || p.id);
  status = null;
  h.setNote(t('statusline.perm.switched'), 6000);
  repaint();

  const out = await requestPreset(h.sessionId, p.id);
  if (out.ok) return;
  h.applyPermission(prevId, prevLabel);
  status = { text: out.text, cls: 'err' };
  h.setNote(out.text, 6000);
  repaint();
}
