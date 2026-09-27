// ============================================================================
// ui/providers/panel.ts — 列表行的「就地内联编辑面板」（W256 第 26 轮）
//   （W748 从 ui/providers.ts 拆出；纯搬运，DOM/类名/文案/事件未改）。
//   面板 DOM 每个提供商行只构建一次，展开/收起只切 class + max-height 过渡
//   （铁律 4），禁止删除重建；层级栈句柄在列表整体刷新前统一释放。
//   W2010：高度**全部由 CSS 给**（settings.css 的 .prov-inline 基态 max-height:0、
//   展开态 max-height:max-content）—— 本文件不再有 style.maxHeight / scrollHeight /
//   offsetHeight 任何一个写点，也不再需要 onLayout 回调。
// ============================================================================
import { api } from '../../api';
import type { ProviderInfo } from '../../types';
import { el } from '../../utils/dom';
import { popOverlay, pushOverlay, type OverlayHandle } from '../../utils/overlays';
import { confirmDialog } from '../confirm';
import { buildProviderForm } from './form';
import { modelCount, refreshRow, renderStateCell, setMsg } from './rows';
import { fmtErr, getProviders, openPanels } from './state';
import type { ProviderListHost } from './types';
import { t } from '../../i18n';

// ---- 行内联编辑面板（任务 2） ------------------------------------------------------

interface PanelState {
  tr: HTMLTableRowElement;
  panelTr: HTMLTableRowElement;
  inner: HTMLElement;
  open: boolean;
  overlay: OverlayHandle | null;
}

/** 当前列表里存活的面板状态（列表整体刷新时用于释放其层级栈句柄）。 */
const livePanels = new Set<PanelState>();

/** 列表重建前调用：摘掉旧面板的层级栈句柄，避免 Esc 需要多按几次。 */
export function releasePanels(): void {
  for (const st of livePanels) {
    if (st.overlay) {
      popOverlay(st.overlay);
      st.overlay = null;
    }
  }
  livePanels.clear();
}

function expandPanel(state: PanelState): void {
  if (state.open) return;
  state.open = true;
  const id = state.tr.dataset.id ?? '';
  if (id) openPanels.add(id);
  state.tr.classList.add('expanded');
  state.tr.setAttribute('aria-expanded', 'true');
  state.panelTr.classList.add('open');
  // W2010：只切 class（铁律 4），不再量内容高度、不再写 style.maxHeight ——
  // 展开终值是 settings.css 的 .prov-panel-row.open .prov-inline { max-height: max-content }。
  state.overlay = pushOverlay(() => collapsePanel(state));
}

function collapsePanel(state: PanelState): void {
  if (!state.open) return;
  state.open = false;
  const id = state.tr.dataset.id ?? '';
  if (id) openPanels.delete(id);
  if (state.overlay) {
    popOverlay(state.overlay);
    state.overlay = null;
  }
  // W2010：这里原先的「先固定当前高度 + void offsetHeight 强制回流，再归零」hack
  // **不再需要**，已删。它存在的前提是展开态被 JS 写成 max-height:'none'（关键字），
  // 关键字无法参与过渡、必须先量成 px；现在展开态是 CSS 的 max-content，收起时
  // 0 ↔ max-content 两端都由 CSS 声明，浏览器自己就能从当前高度补间。
  // 收起动画仍生效：真机几何序列见报告（chrome151 采到连续中间 clientHeight）。
  state.panelTr.classList.remove('open');
  state.tr.classList.remove('expanded');
  state.tr.setAttribute('aria-expanded', 'false');
}

function togglePanel(state: PanelState): void {
  if (state.open) collapsePanel(state);
  else expandPanel(state);
}

/** 构建一行提供商（数据行 + 正下方内联面板行）；面板 DOM 只构建一次。 */
export function renderProviderRow(
  host: ProviderListHost,
  p: ProviderInfo,
): { tr: HTMLTableRowElement; panelTr: HTMLTableRowElement } {
  const tr = el('tr', 'prov-row') as HTMLTableRowElement;
  tr.dataset.id = p.id;
  tr.title = t('settings.providers.expandHint');
  tr.setAttribute('aria-expanded', 'false');
  if (p.is_default) tr.classList.add('is-default');

  const tdName = el('td', 'prov-td-name');
  tdName.appendChild(el('span', 'prov-name', p.name || p.id));
  tr.appendChild(tdName);
  tr.appendChild(el('td', 'prov-td-note', p.note ?? '—'));
  tr.appendChild(el('td', 'prov-td-fmt', p.request_format ?? '—'));
  tr.appendChild(el('td', 'prov-td-models', String(modelCount(p))));
  const tdState = el('td', 'prov-td-state');
  renderStateCell(tdState, p);
  tr.appendChild(tdState);

  const tdOps = el('td', 'prov-td-ops');
  const del = el('button', 'btn-mini danger', t('settings.action.delete')) as HTMLButtonElement;
  del.type = 'button';
  del.addEventListener('click', (e) => {
    e.stopPropagation(); // 删除不触发展开/收起
    const id = tr.dataset.id ?? '';
    const cur = getProviders().find((x) => x.id === id);
    void confirmDialog({
      title: t('settings.providers.deleteTitle'),
      message: t('settings.providers.confirmDelete', { name: cur?.name || id }),
      okLabel: t('settings.action.delete'),
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      void api
        .deleteProvider(id)
        .then(() => void host.loadProviders())
        .catch((err: unknown) => setMsg(t('settings.providers.deleteFailed', { reason: fmtErr(err) })));
    });
  });
  tdOps.appendChild(del);
  tr.appendChild(tdOps);

  // ---- 内联面板行（该行正下方） ----
  const panelTr = el('tr', 'prov-panel-row') as HTMLTableRowElement;
  const td = el('td', 'prov-panel-td') as HTMLTableCellElement;
  td.colSpan = 6;
  const inner = el('div', 'prov-inline');
  td.appendChild(inner);
  panelTr.appendChild(td);

  const state: PanelState = { tr, panelTr, inner, open: false, overlay: null };
  livePanels.add(state);
  const refs = buildProviderForm(p, {
    onSaved: (payload) => {
      collapsePanel(state);
      void refreshRow(host, tr, payload.id);
    },
    onCancel: () => collapsePanel(state),
  });
  inner.appendChild(refs.root);

  // 点击行本体（非交互控件）→ 原地展开/收起
  tr.addEventListener('click', (e) => {
    const t = e.target;
    if (t instanceof Element && t.closest('button, a, input, select, textarea, label')) return;
    togglePanel(state);
  });

  // 刷新后恢复展开态（无动画：直接落到位）
  if (openPanels.has(p.id)) {
    state.open = true;
    tr.classList.add('expanded');
    tr.setAttribute('aria-expanded', 'true');
    panelTr.classList.add('open');
    state.overlay = pushOverlay(() => collapsePanel(state));
  }

  return { tr, panelTr };
}
