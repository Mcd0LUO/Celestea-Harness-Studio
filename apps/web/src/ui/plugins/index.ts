// ============================================================================
// ui/plugins/index.ts — 设置页「插件」一格的装配（W859 · W9108）。
// ----------------------------------------------------------------------------
//   容器结构（离屏构建、单次替换）：
//     #settingsPlugins
//       .plug-bar（W895-L 插件库工具条：搜索 + 计数 + 全部开/关）
//       .plug-sec（客户端插件；W895-L 按**分类**分组）
//         .plug-cat-head（分类名 + 该类计数）
//         .plug-list > .plug-entry[data-id]
//                        .plug-row（开关 = 真注册/真注销，见 src/plugins/）
//                        .plug-panel（W9108 内联配置面板；与行**相邻**，同 providers）
//       .plug-status 就地说明（切换结果 / 失败原因）
//       .plug-sec（**服务端插件**：W9322 起按 `layer` 分两段，optional/idle-only 可开关）
//         .plug-host-box > .plug-cat[data-layer]
//            .plug-cat-head（层名 + 该层行数）
//            .plug-host-list > .plug-host[data-name][data-hot][data-disable]
//                             名字/版本 + 停用原因 + **按 hot 取值**的徽标 +（可关时）开关
//         或 .plug-empty（服务端未提供插件清单 —— 不伪造）
//   铁律：首屏不写「加载中」占位 —— 客户端一段同步画出终态；宿主一段在清单回来前
//   保持空（回来即画，失败画如实空态）。
//   W895-L：搜索/分类是**纯视图**——只过滤已画的 DOM，不重新取表、不重建记录。
//   W9108：展开面板 DOM 每行只建一次；展开/收起只切 class + max-height 过渡，
//          不重建列表（同 ui/providers/panel.ts 的行内面板）。
// ============================================================================
import { userErrorText } from '../../api';
import {
  CLIENT_PLUGIN_CATEGORIES,
  categoryLabelKey,
  clientPluginConfigValues,
  clientPlugins,
  isClientPluginOn,
  setClientPlugin,
  setClientPluginConfig,
  setClientPlugins,
  whenClientPluginsReady,
} from '../../plugins';
import type { ClientPluginDescriptor } from '../../plugins';
import { el, need } from '../../utils/dom';
import { applyValues, buildConfigPanel, type PluginPanelState } from './config-panel';
import {
  HOST_LAYERS,
  fetchHostPlugins,
  rowsOfLayer,
  setHostPlugins,
  type HostPluginRow,
  type LayerKind,
} from './host';
import { t } from '../../i18n';
import { iconNode } from '../icons'; // W9324：几何真源在 ui/icons.ts

const HOST = '#settingsPlugins';

/** 一层的标题 key（`'other'` = 认不出的层，如实另起一段）。 */
const HOST_LAYER_KEY: Record<LayerKind, Parameters<typeof t>[0]> = {
  host: 'settings.plugins.layerHost',
  engine: 'settings.plugins.layerEngine',
  other: 'settings.plugins.layerOther',
};

/** 切换回调签名（渲染层不关心谁去写，只把「哪一行、要什么」交出去）。 */
type HostToggleFn = (p: HostPluginRow, want: boolean) => void;

/**
 * 服务端清单的**客户端镜像**（模块级）。
 *
 * 它是切换时算「我要哪些开着」的唯一依据：不另存一份启用状态，也不从 DOM 反推。
 * 每次 PUT 成功都用**答复里的真值**整表替换它（fail-closed：写失败不动它）。
 */
let currentRows: HostPluginRow[] = [];

function section(title: string, note: string): HTMLElement {
  const sec = el('section', 'plug-sec');
  const head = el('header', 'plug-sec-head');
  head.appendChild(el('h5', 'plug-sec-title', title));
  head.appendChild(el('span', 'plug-sec-note', note));
  sec.appendChild(head);
  return sec;
}

/** 展开控件的内联 chevron（方向由 CSS 按 aria-expanded 定，不靠字形）。 */
function chevron(): SVGSVGElement {
  // W9324：几何真源在 ui/icons.ts。迁移前这里不写 width/height（尺寸由 .plug-expand svg
  // 的 CSS 给 12px）—— 保留该形态（size 0 = 不写尺寸），否则会盖过 CSS、改变现有视觉。
  return iconNode('chevron-expand', { size: 0 });
}

/** 一行客户端插件（开关初值 = 此刻真实挂载状态）+ 内联配置面板。 */
function clientRow(
  d: ClientPluginDescriptor,
  status: (text: string, ok: boolean) => void,
): { entry: HTMLElement; row: HTMLElement; panel: HTMLElement; state: PluginPanelState; content: HTMLElement } {
  const entry = el('div', 'plug-entry');
  entry.dataset['id'] = d.id;

  const row = el('div', 'plug-row');
  row.dataset['id'] = d.id;

  // 展开控件与面板：值取**生效配置**（默认值 + 已保存值），写入走 apply 层。
  const built = buildConfigPanel(d.label, d.config, clientPluginConfigValues(d.id), (key, value) => {
    void (async () => {
      const r = await setClientPluginConfig(d.id, key, value);
      // 失败 ⇒ 把控件拨回**服务端真值**（内存镜像没动），并如实说明。
      applyValues(built.content, clientPluginConfigValues(d.id));
      status(r.text, r.ok);
      // W2010：配置项值变化不再需要重算面板高度 —— 展开态是 max-content，会自己长。
    })();
  });
  const state = built.state;
  row.appendChild(built.toggle);
  built.toggle.appendChild(chevron());

  const main = el('div', 'plug-row-main');
  main.appendChild(el('div', 'plug-row-label', d.label));
  main.appendChild(el('div', 'plug-row-hint', d.hint));
  row.appendChild(main);

  const wrap = el('label', 'plug-switch');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'plug-switch-input';
  input.checked = isClientPluginOn(d.id);
  input.addEventListener('change', () => {
    const want = input.checked;
    // W895-C1：写服务端是异步的；失败时回滚开关与真挂载状态（本函数已回滚）。
    void (async () => {
      const r = await setClientPlugin(d.id, want);
      if (!r.ok) input.checked = !want; // 回滚：真挂载状态确实没变
      status(r.text, r.ok);
    })();
  });
  wrap.appendChild(input);
  wrap.appendChild(el('span', 'plug-switch-track'));
  row.appendChild(wrap);

  entry.appendChild(row);
  entry.appendChild(built.panel);
  return { entry, row, panel: built.panel, state, content: built.content };
}

/**
 * 一行服务端插件（W9322）。
 *
 * 三个字段各读各的真值，互不推导：
 *   · 徽标按 **`hot`** 渲染（`hot:false` 才写「不可热拔插」；`hot:true` 写「可换代」）。
 *     旧实现**硬编码**了「进程内不可热拔插」，而那 6 行引擎插件恰恰是可换代的 ——
 *     面板在说反话。
 *   · 开关按 **`disable`** 决定：`optional` / `idle-only` 给开关；`required`
 *     **不给**开关，并把后端的 `reason` 显示出来（拒绝必须说出来）。
 *   · 认不出的 `disable` → **不画开关**（fail-closed，与后端 policyOf 同一纪律），
 *     并把原始取值标出来，不假装认识。
 */
function hostRow(p: HostPluginRow, toggle: HTMLElement | null): HTMLElement {
  const row = el('div', 'plug-host');
  row.dataset['name'] = p.name;
  row.dataset['layer'] = p.layerKind;
  row.dataset['hot'] = String(p.hot);
  row.dataset['disable'] = p.disableKind;
  const main = el('div', 'plug-row-main');
  const label = el('div', 'plug-row-label', p.name);
  if (p.version !== '') label.appendChild(el('span', 'plug-host-ver', p.version));
  main.appendChild(label);
  if (p.note !== '') main.appendChild(el('div', 'plug-row-hint', p.note));
  // 停用策略按 disableKind 如实呈现；reason 原样透传（后端写了就别丢）。
  if (p.disableKind !== 'optional' || p.reason !== '') {
    main.appendChild(el('div', 'plug-row-hint plug-row-reason', reasonOf(p)));
  }
  row.appendChild(main);
  row.appendChild(el('span', 'plug-badge', hotBadge(p.hot)));
  // required / unknown 都不画开关（toggle 传 null）：拒绝必须说出来，而不是给一个按不动的按钮。
  if (toggle !== null) row.appendChild(toggle);
  return row;
}

/** 徽标文案：**按 hot 取值**，不硬编码。 */
function hotBadge(hot: boolean): string {
  return hot ? t('settings.plugins.hotSwappable') : t('settings.plugins.hostBadge');
}

/** 停用说明：策略短语 + 后端给的 reason（`optional` 只在有 reason 时说 reason）。 */
function reasonOf(p: HostPluginRow): string {
  const policy =
    p.disableKind === 'required'
      ? t('settings.plugins.disableRequired')
      : p.disableKind === 'idle-only'
        ? t('settings.plugins.disableIdleOnly')
        : p.disableKind === 'optional'
          ? t('settings.plugins.disableOptional')
          : t('settings.plugins.disableUnknown', { value: p.disable === '' ? '?' : p.disable });
  return p.reason === '' ? policy : policy + '：' + p.reason;
}

/** 一行的开关（只在 `optional` / `idle-only` 上建；调用方保证 disableKind 已判定）。 */
function hostSwitch(p: HostPluginRow, onToggle: HostToggleFn): HTMLElement {
  const wrap = el('label', 'plug-switch');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'plug-switch-input';
  input.checked = p.enabled;
  input.addEventListener('change', () => onToggle(p, input.checked));
  wrap.appendChild(input);
  wrap.appendChild(el('span', 'plug-switch-track'));
  return wrap;
}

/** 这一行该不该给开关？`required` 与**认不出的**取值都没有（fail-closed）。 */
function switchable(p: HostPluginRow): boolean {
  return p.disableKind === 'optional' || p.disableKind === 'idle-only';
}

/** 一层的行节点（含层名小标题）；空层不画标题（不占位、不写「加载中」）。 */
function hostLayer(layer: LayerKind, rows: HostPluginRow[], onToggle: HostToggleFn): HTMLElement {
  const sec = el('div', 'plug-cat');
  sec.dataset['layer'] = layer;
  const head = el('div', 'plug-cat-head');
  head.appendChild(el('h6', 'plug-cat-title', t(HOST_LAYER_KEY[layer])));
  const n = el('span', 'plug-cat-count', String(rows.length));
  head.appendChild(n);
  const list = el('div', 'plug-host-list');
  for (const r of rows) list.appendChild(hostRow(r, switchable(r) ? hostSwitch(r, onToggle) : null));
  sec.appendChild(head);
  sec.appendChild(list);
  return sec;
}

/** 服务端一段的渲染：按 `layer` 分段（空清单 = 如实空态）。 */
function renderHost(box: HTMLElement, rows: HostPluginRow[], onToggle: HostToggleFn): void {
  const off = document.createElement('div');
  if (rows.length === 0) {
    off.appendChild(el('div', 'plug-empty', t('settings.plugins.hostEmpty')));
  } else {
    // 'other'（认不出的层）永远垫底，不与已知层混排 —— 认不出就如实另起一段。
    for (const layer of HOST_LAYERS) {
      const part = rowsOfLayer(rows, layer);
      if (part.length > 0) off.appendChild(hostLayer(layer, part, onToggle));
    }
  }
  box.replaceChildren(...off.childNodes);
}

// ---- W895-L：插件库视图（分类 + 搜索 + 批量） ---------------------------------

/** 命中搜索词？（大小写无关，匹配 label 与 hint —— 两者都是用户语言。） */
function matches(d: ClientPluginDescriptor, q: string): boolean {
  if (q === '') return true;
  const hay = (d.label + ' ' + d.hint).toLowerCase();
  return hay.includes(q.toLowerCase());
}

/** 已建好的一行（W9108：连同它的面板状态与配置内容节点）。 */
interface RowEntry {
  d: ClientPluginDescriptor;
  row: HTMLElement;
  panel: HTMLElement;
  state: PluginPanelState;
  content: HTMLElement;
  /** 该行当前归属的分类（用于分组计数）。 */
  cat: string;
}

/**
 * 构建插件库：工具条（搜索 + 计数 + 全部开/关）+ 按分类分组的列表。
 *
 * 纯视图：搜索/分组只操作**已建好的**行节点，不重新取服务端表、不重建记录。
 * 每行仍是 .plug-row[data-id] + .plug-switch-input（既有测试与开关语义不变）。
 */
function buildLibrary(setStatus: (t: string, ok: boolean) => void): HTMLElement {
  const all = clientPlugins();
  const box = el('div', 'plug-lib');

  // 搜索（不写「加载中」；空结果画如实空态）
  const bar = el('div', 'plug-bar');
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'plug-search-input';
  search.placeholder = t('settings.plugins.search');
  search.setAttribute('aria-label', t('settings.plugins.search'));
  bar.appendChild(search);

  const count = el('span', 'plug-count');
  const allOn = el('button', 'btn plug-bulk', t('settings.plugins.allOn')) as HTMLButtonElement;
  const allOff = el('button', 'btn plug-bulk', t('settings.plugins.allOff')) as HTMLButtonElement;
  allOn.type = 'button';
  allOff.type = 'button';
  bar.appendChild(count);
  bar.appendChild(allOn);
  bar.appendChild(allOff);
  box.appendChild(bar);

  // 分类分组（顺序由 descriptor 的封闭集决定）
  const groups: Array<{ cat: string; sec: HTMLElement; list: HTMLElement; head: HTMLElement }> = [];
  for (const cat of CLIENT_PLUGIN_CATEGORIES) {
    const sec = el('div', 'plug-cat');
    const head = el('div', 'plug-cat-head');
    head.appendChild(el('h6', 'plug-cat-title', t(categoryLabelKey(cat))));
    const n = el('span', 'plug-cat-count', '');
    head.appendChild(n);
    const list = el('div', 'plug-list');
    sec.appendChild(head);
    sec.appendChild(list);
    box.appendChild(sec);
    groups.push({ cat, sec, list, head: n });
  }

  const rows: RowEntry[] = [];
  const byId = new Map<string, RowEntry>();
  for (const d of all) {
    const g = groups.find((x) => x.cat === d.category) ?? groups[0]!;
    const built = clientRow(d, setStatus);
    const entry: RowEntry = { d, row: built.row, panel: built.panel, state: built.state, content: built.content, cat: g.cat };
    rows.push(entry);
    byId.set(d.id, entry);
    g.list.appendChild(built.entry);
  }

  // 用**独占**的 class：`.plug-empty` 已被宿主一段的「清单不可用」占用 ——
  // 同一个选择器指两个概念会让两边都不可断言（既有测试立刻抓到了）。
  const empty = el('div', 'plug-nomatch', t('settings.plugins.empty'));
  empty.classList.add('hidden');
  box.appendChild(empty);

  /** 把当前过滤/计数/空态一次性应用到已存在的节点（不重建行）。 */
  const apply = (): void => {
    const q = search.value.trim();
    let shown = 0;
    let on = 0;
    for (const entry of rows) {
      const hit = matches(entry.d, q);
      entry.row.classList.toggle('hidden', !hit);
      // 被过滤掉的行不得把它的展开面板留在原地（面板与行是一个整体）。
      entry.panel.classList.toggle('hidden', !hit);
      if (hit) shown += 1;
      if (isClientPluginOn(entry.d.id)) on += 1;
    }
    for (const g of groups) {
      const visible = rows.filter((r) => r.cat === g.cat && !r.row.classList.contains('hidden')).length;
      g.sec.classList.toggle('hidden', visible === 0);
      g.head.textContent = String(visible);
    }
    count.textContent = t('settings.plugins.count', { on: String(on), total: String(all.length) });
    empty.classList.toggle('hidden', shown !== 0);
  };

  search.addEventListener('input', apply);
  const bulk = (on: boolean) => {
    // 对**当前可见**的行批量（搜索过滤后只影响看到的那批，符合用户预期）。
    const ids = rows.filter((r) => !r.row.classList.contains('hidden')).map((r) => r.d.id);
    void (async () => {
      const r = await setClientPlugins(ids, on);
      // 无论成败都以**真实挂载状态**重画开关初值（失败时状态没变）。
      for (const entry of rows) {
        const input = entry.row.querySelector('.plug-switch-input') as HTMLInputElement | null;
        if (input) input.checked = isClientPluginOn(entry.d.id);
        // 配置值不受开关影响，但服务端整表替换后重新对齐一次更安全（幂等）。
        applyValues(entry.content, clientPluginConfigValues(entry.d.id));
      }
      apply();
      setStatus(r.text, r.ok);
    })();
  };
  allOn.addEventListener('click', () => bulk(true));
  allOff.addEventListener('click', () => bulk(false));

  apply();
  return box;
}

/** 载入并渲染这一格（config.ts 的 loadPane 调用；「重新载入」会再次调用）。 */
export async function loadPluginsSection(): Promise<void> {
  const host = need<HTMLElement>(HOST);
  // W895-C1：开关初值来自服务端启用表。先等「取表 + 对齐」落定再画一次终态 ——
  // 既不写「加载中」占位，也不会把服务端已关闭的组件显示成开。
  await whenClientPluginsReady();
  const status = el('div', 'plug-status');
  const setStatus = (t: string, ok: boolean): void => {
    status.className = 'plug-status' + (t === '' ? '' : ok ? ' ok' : ' err');
    status.textContent = t;
  };

  const clientSec = section(t('settings.plugins.clientTitle'), t('settings.plugins.clientNote'));
  clientSec.appendChild(buildLibrary(setStatus));
  clientSec.appendChild(status);

  const hostBox = el('div', 'plug-host-box');
  const hostSec = section(t('settings.plugins.hostTitle'), t('settings.plugins.hostNote'));
  hostSec.appendChild(hostBox);
  // 服务端那一格的开关：写 PUT /api/plugins（启用表），失败回滚到服务端真值。
  const onHostToggle: HostToggleFn = (p, want) => {
    void (async () => {
      const enabled = currentRows.filter((r) => (r.name === p.name ? want : r.enabled)).map((r) => r.name);
      const r = await setHostPlugins(enabled);
      if (!r.ok) {
        // 回滚：以**服务端真值**为准（内存镜像没动）。
        for (const row of hostBox.querySelectorAll<HTMLElement>('.plug-host')) {
          const src = currentRows.find((x) => x.name === row.dataset['name']);
          const input = row.querySelector<HTMLInputElement>('.plug-switch-input');
          if (src !== undefined && input !== null) input.checked = src.enabled;
        }
        setStatus(userErrorText(new Error(r.text), t('settings.plugins.hostSwitchFailed')), false);
        return;
      }
      // 成功：PUT 的答复就是换代后的真值，整表按它对齐（不靠本地推断）。
      currentRows = r.rows;
      renderHost(hostBox, currentRows, onHostToggle);
      setStatus(t('settings.plugins.hostSwitchOk', { label: p.name, state: want ? t('plugins.on') : t('plugins.off') }), true);
    })();
  };

  const off = document.createElement('div');
  off.append(clientSec, hostSec);
  host.replaceChildren(...off.childNodes);

  try {
    currentRows = await fetchHostPlugins();
    renderHost(hostBox, currentRows, onHostToggle);
  } catch (err) {
    // 端点缺失/不可达：只画一行如实空态，不弹错、不重试、不伪造清单
    currentRows = [];
    renderHost(hostBox, [], onHostToggle);
    console.warn('[plugins] ' + userErrorText(err, t('settings.plugins.hostUnavailable')));
  }
}
