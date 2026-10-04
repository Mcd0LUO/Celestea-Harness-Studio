// ============================================================================
// ui/workbench/panel.ts — G4/W9329：面板系统的**骨架与装配**（离屏构建 + 单次替换）。
// ----------------------------------------------------------------------------
// ★ W9329 重做（覆盖式 ⇒ **挤压式**）：本文件此前把宿主建在 #main 里、用
//   `position:absolute; inset:0`（workbench.css 旧第 43 行）⇒ 面板浮在对话区**之上**，
//   而同一个文件的头注释写着「普通 flex 子项…对话区被压缩而不是覆盖」——**注释说挤压、
//   代码是覆盖**。本轮照 prototype/right-panel.html 的已拍板行为把骨架整个重做：
//
//   现在：#layout = [ #sidebar | #main | .wb-splitter | .wb-host ]
//   ① **撑开 ≠ 覆盖**：.wb-host 是 #layout 的 flex 子项（不是 #main 的绝对定位孩子），
//      面板宽度**从会话列里扣**；两者在 flex 轴上首尾相接 ⇒ 矩形零重叠。
//      为什么宿主挂 #layout 而不是 #main：#main 是 flex column，而 w871 断言
//      .chat-shell 的父节点必须是 #main、w1462/w867 断言 #statusbar/#messages 必须是
//      #main 的**直接子项**。挂 #layout 后 #main 的子结构**一字未动**（三条门禁原样成立），
//      挤压照样成立（挤压发生在 #layout 这一层）。
//   ② **窄屏诚实降级**：容不下「会话最小 + 面板最小」时切 .overlay（覆盖式）并给提示，
//      而不是把正文挤到不可读（判据是**量出来的**，见 narrowPasses）。
//   ③ **面板状态是会话级**：开合 / 宽度 / 当前文件挂在 session-state.ts（按会话 id），
//      切会话即切面板。
//
// 铁律：任何面板增删/停靠变化都**只重建面板区**（#messages / .chat-shell 的节点身份不变）；
//      分隔条拖拽用 rAF 节流；每个面板独立 seq（见 state.nextSeq）。
// ============================================================================
import { el } from '../../utils/dom';
import {
  closePanel, focusedPanel, focusPanel, isCurrentSeq, listPanels, nextSeq, onPanelsChange,
  setPanelDock, panelOf, type DockSide, type PanelState,
} from './state';
import { renderFilesPanel } from './files';
import { disposeTerminalPanel, renderTerminalPanel } from './terminal';
import { renderBrowserPanel } from './browser';
import { syncCurrentSession } from './session-sync'; // W9329：改动写回当前会话
import { createNarrowGuard, type NarrowGuard } from './narrow'; // W9329：窄屏诚实降级
import { t } from '../../i18n';

let host: HTMLElement | null = null;
let dockArea: HTMLElement | null = null;
let splitter: HTMLElement | null = null;
/** W9329：窄屏诚实降级的守卫（判据/测量/切换在 ./narrow.ts）。 */
let narrowGuard: NarrowGuard | null = null;
let installed = false;
/** W1528：上一帧的终端面板（id → 面板对象；见 reapClosedTerminals）。 */
let lastTerminals = new Map<string, PanelState>();
let dragState: { id: string; startX: number; startY: number; startSize: number; dock: DockSide } | null = null;

// ---- W9329：分隔条的最小 / 最大（照 prototype：300–860） ----
/** 面板最小宽（prototype .panel 的 min-width）。 */
const SPLIT_MIN = 300;
/** 面板最大宽（拖拽上限；prototype 拖拽 clamp 到 860）。 */
const SPLIT_MAX = 860;

// 窄屏诚实降级（判据 + 测量 + 切换）在 ./narrow.ts —— 它是一块独立的 UI 决策，
// 抽出去既让本文件专注「面板怎么画」，也让「什么时候该降级」这条**后果**能作为
// 纯函数被直接判（tests/w9329-workbench-squeeze.test.ts ⑤ 的真值表）。
export { CHAT_MIN, narrowPasses } from './narrow';

/** 面板头部（标题 + 停靠切换 + 关闭）。 */
function head(panel: PanelState): HTMLElement {
  const h = el('div', 'wb-head');
  h.appendChild(el('span', 'wb-title', panel.title));
  // ★ W9329：停靠**按钮**的类名是 .wb-btn.wb-dock-btn，**不再**复用 .wb-dock ——
  // 旧实现给按钮挂 `wb-btn wb-dock`，而 .wb-dock 当时是 `position:absolute; inset:0`
  // 的停靠浮层 ⇒ 按钮被拉伸铺满整个面板，里面的 ⇩ 居中渲染成「浮在正中间的箭头」
  // （用户报障）。旧 CSS 里 .wb-dock 这条规则已删除，类名撞车自然消失。
  const dockBtn = el('button', 'wb-btn wb-dock-btn', panel.dock === 'right' ? '⇩' : '⇨') as HTMLButtonElement;
  dockBtn.type = 'button';
  dockBtn.title = panel.dock === 'right' ? t('chat.wb.dockBottom') : t('chat.wb.dockRight');
  dockBtn.setAttribute('aria-label', dockBtn.title);
  dockBtn.addEventListener('click', () => setPanelDock(panel.id, panel.dock === 'right' ? 'bottom' : 'right'));
  h.appendChild(dockBtn);
  const close = el('button', 'wb-btn wb-close', '×') as HTMLButtonElement;
  close.type = 'button';
  close.title = t('chat.wb.close');
  close.setAttribute('aria-label', t('chat.wb.close'));
  // ★ W9329：关面板后由 installWorkbench 的 onPanelsChange 统一写回会话
  //   （单一订阅点，任何关闭路径都自动覆盖 —— 见 installWorkbench 的注释）。
  close.addEventListener('click', () => closePanel(panel.id));
  h.appendChild(close);
  // 拖动标题栏 → 按落点切换停靠边（right ↔ bottom）；rAF 节流，不逐 mousemove 写样式。
  h.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('.wb-btn')) return; // 点在按钮上不拖
    startDockDrag(panel, e);
  });
  return h;
}

let dockDrag: { id: string; startDock: DockSide } | null = null;
let dockDragQueued = false;
let hintEl: HTMLElement | null = null;

function startDockDrag(panel: PanelState, e: MouseEvent): void {
  dockDrag = { id: panel.id, startDock: panel.dock };
  window.addEventListener('mousemove', onDockMove);
  window.addEventListener('mouseup', onDockEnd);
  e.preventDefault();
}

function onDockMove(e: MouseEvent): void {
  if (!dockDrag || dockDragQueued) return;
  dockDragQueued = true;
  const y = e.clientY;
  requestAnimationFrame(() => {
    dockDragQueued = false;
    if (!dockDrag || !dockArea) return;
    const r = dockArea.getBoundingClientRect();
    // 落点在下 1/3 ⇒ bottom；否则 right（用户原话：可拆到底部 / 右侧）。
    const target: DockSide = y > r.top + r.height * 0.66 ? 'bottom' : 'right';
    if (!hintEl) {
      hintEl = el('div', 'wb-drop-hint');
      dockArea.appendChild(hintEl);
    }
    hintEl.className = 'wb-drop-hint ' + target;
    hintEl.textContent = target === 'bottom' ? t('chat.wb.dockBottom') : t('chat.wb.dockRight');
  });
}

function onDockEnd(e: MouseEvent): void {
  const drag = dockDrag;
  dockDrag = null;
  window.removeEventListener('mousemove', onDockMove);
  window.removeEventListener('mouseup', onDockEnd);
  if (hintEl) {
    hintEl.remove();
    hintEl = null;
  }
  if (!drag || !dockArea) return;
  const r = dockArea.getBoundingClientRect();
  const target: DockSide = e.clientY > r.top + r.height * 0.66 ? 'bottom' : 'right';
  setPanelDock(drag.id, target);
}

/** #layout 里的**主分隔条**（会话列 ↔ 面板列之间，拖它改整条面板列的宽）。 */
function buildSplitter(): HTMLElement {
  const bar = el('div', 'wb-splitter');
  bar.setAttribute('role', 'separator');
  bar.setAttribute('aria-orientation', 'vertical');
  bar.tabIndex = 0;
  bar.title = t('chat.wb.resize');
  bar.setAttribute('aria-label', t('chat.wb.resize'));
  bar.addEventListener('mousedown', (e) => {
    if (!host) return;
    dragState = { id: '@column', startX: e.clientX, startY: e.clientY, startSize: host.getBoundingClientRect().width, dock: 'right' };
    window.addEventListener('mousemove', onSplitMove);
    window.addEventListener('mouseup', onDragEnd);
    e.preventDefault();
  });
  // 键盘可达（WCAG 2.1.1）：←/→ 每次 16px，Home/End 跳到最小/最大。
  bar.addEventListener('keydown', (e) => {
    if (!host) return;
    const cur = host.getBoundingClientRect().width;
    const k = (e as KeyboardEvent).key;
    let next: number | null = null;
    if (k === 'ArrowLeft') next = cur + 16;
    else if (k === 'ArrowRight') next = cur - 16;
    else if (k === 'Home') next = SPLIT_MAX;
    else if (k === 'End') next = SPLIT_MIN;
    if (next === null) return;
    e.preventDefault();
    setColumnWidth(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, next)));
  });
  return bar;
}

/** 写整条面板列的宽（改自定义属性，随后重测窄屏判据）。 */
function setColumnWidth(px: number): void {
  if (!host) return;
  const clamped = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Math.round(px)));
  // ★ 只写 --wb-col-w，**不写内联 width**：挤压态由 `.wb-host{flex-basis:var(--wb-col-w)}`
  //   读它、覆盖态由 `.wb-host.overlay{width:min(var(--wb-col-w),92vw)}` 读它。
  //   写内联 width 会在覆盖态压过样式表（内联优先）⇒ 宽度冻在旧值（真机实测过）。
  host.style.setProperty('--wb-col-w', clamped + 'px');
  narrowGuard?.measure();
}

let splitQueued = false;
function onSplitMove(e: MouseEvent): void {
  if (!dragState) return;
  if (splitQueued) return;
  splitQueued = true;
  const startX = dragState.startX;
  const startSize = dragState.startSize;
  requestAnimationFrame(() => {
    splitQueued = false;
    if (!dragState) return;
    // 往左拖变大（起始 X − 当前 X）。
    const next = startSize + (startX - e.clientX);
    setColumnWidth(next);
    // ★ W9329：把新宽写进**右面板的 size**（readLive 读的就是它），再写回本会话 ——
    //   切回这个会话时宽度还在（原型：「每个会话各自记住…宽度」）。
    //   直接改 p.size 而不是 setPanelSize()：后者每次都 emit() 触发**整个面板区重建**，
    //   拖拽时每帧重建一次会把手里的分隔条节点换掉（拖拽当场断掉）。
    for (const p of listPanels()) {
      if (p.dock === 'right') p.size = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Math.round(next)));
    }
    syncCurrentSession();
  });
}

function onDragEnd(): void {
  dragState = null;
  window.removeEventListener('mousemove', onSplitMove);
  window.removeEventListener('mouseup', onDragEnd);
}

/** 一个面板框（内容按 kind 分派）。 */
function panelBox(panel: PanelState): HTMLElement {
  const box = el('div', 'wb-panel' + (focusedPanel() === panel.id ? ' focused' : ''));
  box.dataset['panelId'] = panel.id;
  box.appendChild(head(panel));
  const body = el('div', 'wb-body');
  if (panel.kind === 'files') {
    // ★ W9329：文件管理器需要一块**自己的表头条**放「路径 / 换行 / ← 树」——
    //   它是面板头下方的一条（.wb-subhead），不与面板头（dock/关闭）抢同一行，
    //   也不会在文件树态下留一条空条（files.ts 在树态不碰它）。
    const sub = el('div', 'wb-subhead');
    box.appendChild(sub);
    void renderFilesPanel(body, panel, nextSeq(panel.id), isCurrentSeq, sub);
  }
  // W1528：终端持有真 pty（进程）。重建时**不杀**（切 dock / 点面板聚焦都会
  // 重建，杀一次终端就断一次）；xterm 的 DOM 被摘下来过，renderTerminalPanel
  // 会把它重新 open 回新宿主。真正的关闭在 renderWorkbench 的集合差里。
  else if (panel.kind === 'terminal') renderTerminalPanel(body, panel);
  else if (panel.kind === 'browser') renderBrowserPanel(body, panel, isCurrentSeq);
  box.appendChild(body);
  box.addEventListener('mousedown', () => focusPanel(panel.id));
  return box;
}

/**
 * W1528：上一帧存在、这一帧已消失的**终端**面板 —— 它们持有的真 pty 必须在这里
 * 被杀掉。
 *
 * 为什么用集合差而不是在 closePanel 里回调：state.ts 是**纯数据层**（它自己的
 * 头注释写着「零 DOM」），让状态层认识 xterm 会把两层的边界弄反。集合差让
 * 「面板没了 ⇒ 进程没了」成为渲染层的一条不变量，且**任何**移除路径（关闭按钮、
 * resetPanels、未来的批量关闭）都自动覆盖 —— 不必逐个调用点记得去杀。
 *
 * 刻意保存**面板对象本身**（而不是 id）：closePanel 会把它从列表里摘掉，之后
 * panelOf(id) 再也查不到，而 pty 句柄挂在它自己的 `data` 上。用 id 重建一个
 * 空壳会读到 `session: null` ⇒ **静默漏进程**（本实现的第一版正是这么错的）。
 */
function reapClosedTerminals(before: ReadonlyMap<string, PanelState>, after: ReadonlySet<string>): void {
  for (const [id, panel] of before) {
    if (after.has(id)) continue;
    void disposeTerminalPanel(panel);
  }
}

/** 重建整个面板区（离屏构建 + 单次 replaceChildren；只动本容器）。 */
export function renderWorkbench(): void {
  if (!host || !dockArea) return; // host/dockArea 同建同销；TS 不跨函数推断，显式守卫
  const all = listPanels();
  const live = new Map<string, PanelState>();
  for (const p of all) if (p.kind === 'terminal') live.set(p.id, p);
  reapClosedTerminals(lastTerminals, new Set(live.keys()));
  lastTerminals = live;
  const bottoms = all.filter((p) => p.dock === 'bottom');
  const rights = all.filter((p) => p.dock === 'right');
  const off = document.createElement('div');
  if (bottoms.length > 0) {
    const bottomZone = el('div', 'wb-zone bottom');
    bottomZone.style.height = bottoms.reduce((m, p) => Math.max(m, p.size), 0) + 'px';
    for (const p of bottoms) {
      const box = panelBox(p);
      box.style.flex = '1 1 0'; // 底部一行内多个面板等分宽度
      bottomZone.appendChild(box);
    }
    off.appendChild(bottomZone);
  }
  if (rights.length > 0) {
    const rightZone = el('div', 'wb-zone right');
    for (const p of rights) {
      const box = panelBox(p);
      // ★ W9329：右面板**占满整条列**（flex:1），列宽由 .wb-host 决定。
      // 逐面板写死 p.size 会让「多开第二个面板 ⇒ 每个都变窄」变成「每个保持原宽、
      // 整条列被顶出视口」—— 那是溢出，不是挤压。真机的「代码列宽 == 面板宽 − 56」
      // 这条等式也只有在「面板盒 = 列宽」时才量得准。
      box.style.flex = '1 1 0';
      rightZone.appendChild(box);
    }
    off.appendChild(rightZone);
  }
  dockArea.replaceChildren(...Array.from(off.childNodes));
  dockArea.classList.toggle('hidden', all.length === 0);
  // BUG FIX（用户实测报「面板打不开」）：installWorkbench 建 host 时带了 'hidden' 防闪烁，
  // 但这里**只切了 dock 的 hidden**，host 永远 display:none ⇒ 面板建出来了却完全不可见。
  // 宿主可见性必须跟着面板数量走（空 ⇒ 隐藏；有 ⇒ 显示）。
  host.classList.toggle('hidden', all.length === 0);
  if (rights.length > 0) {
    // ★ W9329：列宽 = 右面板里**最宽**的那个（多开时取最大，单开时就是它自己）。
    // 只写 --wb-col-w，两种形态各自读（见 setColumnWidth 的注释）。
    const w = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, rights.reduce((m, p) => Math.max(m, p.size), 0)));
    host.style.setProperty('--wb-col-w', w + 'px');
    if (splitter && !splitter.isConnected && host.isConnected) host.parentElement?.insertBefore(splitter, host);
  } else if (splitter?.isConnected) {
    // 面板全关了：收起分隔条，并退出覆盖态（没有面板就无所谓覆盖）。
    splitter.remove();
    host.classList.remove('overlay');
    document.body.classList.remove('wb-overlay-open');
  }
  // 布局完成后量一次窄屏判据（覆盖式 ⇄ 挤压式）。
  narrowGuard?.measure();
}

/**
 * 装配（幂等）：把 .wb-splitter + .wb-host 插进 **#layout**（#main 之后）。
 *
 * ★ W9329：宿主挂在 #layout 而不是 #main —— 见头注②。#main 的子结构一字未动，
 *   w871（.chat-shell 父节点是 #main）/ w1462 / w867（#statusbar、#messages 是
 *   #main 直接子项）三条门禁原样成立。
 */
export function installWorkbench(): void {
  if (installed) return;
  installed = true;
  const layoutEl = document.getElementById('layout');
  const main = document.getElementById('main');
  if (!layoutEl || !main) return;
  splitter = buildSplitter();
  host = el('div', 'wb-host hidden');
  dockArea = el('div', 'wb-dock-area hidden');
  host.appendChild(dockArea);
  // 顺序：#sidebar | #main | .wb-splitter | .wb-host —— flex 行里首尾相接 ⇒ 零重叠。
  layoutEl.insertBefore(splitter, main.nextSibling);
  layoutEl.insertBefore(host, splitter.nextSibling);
  // W9329：窄屏诚实降级的守卫（判据/测量/切换在 ./narrow.ts）。
  narrowGuard = createNarrowGuard({
    host,
    layout: layoutEl,
    main,
    columnWidth: () => host?.getBoundingClientRect().width ?? 0,
  });
  // ★ W9329：面板集合的**任何**变化都写回当前会话（开 / 关 / 多开 / 换 dock）。
  //   放在这里而不是逐个调用点：openPanel / closePanel / setPanelDock 都有各自的
  //   入口（菜单、面板头按钮、会话切换、外部 API），**漏一个**就会让「切会话回来
  //   面板不见了」这种 bug 复现。单一订阅点 ⇒ 任何路径都自动覆盖。
  onPanelsChange(() => {
    renderWorkbench();
    syncCurrentSession();
  });
  // 视口变化同样要重量：用户拖窗口 / 折叠侧栏都会改 #main 的可用宽。
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => narrowGuard?.measure());
    ro.observe(main);
    ro.observe(host);
  }
  window.addEventListener('resize', () => narrowGuard?.measure());
  renderWorkbench();
}

/**
 * ★ W9329：按面板 id **只重画**该面板的正文（换文件 / 切会话恢复时用）。
 *
 * 为什么需要它：面板**节点**必须跨会话保留（重建会连带误杀终端 pty，见
 * session-sync 头注），所以「换内容」只能走「改 data + 重画这一个面板」。
 * 只动 .wb-panel 内部 ⇒ #messages / .chat-shell 的节点身份不变（铁律 5）。
 */
export function refreshFilesPanel(id: string): void {
  const panel = panelOf(id);
  if (!panel || panel.kind !== 'files') return;
  const box = document.querySelector<HTMLElement>('.wb-panel[data-panel-id="' + id + '"]');
  if (!box) return;
  const body = box.querySelector<HTMLElement>(':scope > .wb-body');
  const sub = box.querySelector<HTMLElement>(':scope > .wb-subhead');
  if (!body) return;
  void renderFilesPanel(body, panel, nextSeq(id), isCurrentSeq, sub ?? undefined);
}

/** 关闭所有面板（测试/清理用）。 */
export function workbenchPanelCount(): number {
  return listPanels().length;
}

export type { DockSide };
