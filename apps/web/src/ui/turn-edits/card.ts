// ============================================================================
// ui/turn-edits/card.ts — 「本轮编辑」卡片的 DOM 层（W9334）
// ----------------------------------------------------------------------------
// 行为规格：apps/web/prototype/turn-edits.html（联调定稿的 11 条）。本模块只管
// **长什么样 + 点了会怎样**；数据与折叠口径在 ./model.ts（纯函数，可断言）。
//
// 三条纪律：
//   · 颜色只用 token（`--c-*` / `--mono` / `--card-radius` / `--shadow-panel` /
//     `--tap-hit`）—— 组件层零硬编码颜色（见 grants.css 的头注）；
//   · 装饰性图标一律来自 ui/icons.ts（含 chevron —— 方向靠 CSS transform，**不用**
//     Unicode 字形 `▾▸▴`：那些来自系统字体，字重与基线和描边图标对不上）；
//   · 它是**显示组件**：本体是一个增强遍（`display.turnEdits`），关掉插件 ⇒ 它不在
//     增强链上 ⇒ 卡片整体不出现（列本身也是「空列不占位」，见 CSS 的 `:empty`）。
//
// 为什么走**增强遍**这条缝：与 W895-C2 的四项可选组件同构（登记表 descriptor +
// 启用表 + config + 真注销），不需要第二套装配机制。代价是渲染入口是
// `runEnhancers(容器)`，所以接线层只在**轮次结束**调一次（不是每个流式节拍 —— 见
// ./wire.ts 的 settle）。卡片自身的交互（折叠/展开/菜单）在本地重画，不再走缝。
// ============================================================================
import { el } from '../../utils/dom';
import { t } from '../../i18n';
import { iconSvg } from '../icons';
import { openFilePreview } from '../workbench/files-open';
import { resolveTarget } from '../enhance/file-link';
import type { Enhancer } from '../enhance/registry';
import {
  breakdownOf,
  canReveal,
  foldWindow,
  KIND_ARIA_KEY,
  KIND_LABEL_KEY,
  KIND_LETTER,
  revealPath,
  splitPath,
  TURN_EDITS_ID,
  turnEditsThreshold,
  totalsOf,
  visibleRows,
  type TurnEditRow,
} from './model';

/** 折叠 chevron：几何真源在 ui/icons.ts（W9324），方向只由 CSS transform 决定。 */
const CHEVRON = (dir: 'down' | 'right' | 'up'): string => iconSvg('chevron-fold', { className: 'te-chev is-' + dir });

/** 主图标 = 文档轮廓（空态用**同一个轮廓**、只降色，见定稿第 7 条）。 */
const DOC_ICON = iconSvg('file', { size: 16 });

/** 复制路径后提示的停留时长（ms）。 */
const TOAST_MS = 1600;

/** 一张卡的本地状态（按**列节点**记账：同一列被反复增强时状态不丢）。 */
interface CardState {
  rows: TurnEditRow[];
  /** 「另有 N 个调用可能改动了文件」的 N（0 = 不出现）。 */
  shellish: number;
  /** 整卡折叠（表头按钮）。 */
  folded: boolean;
  /** 二次展开：越过阈值显示全部。 */
  expanded: boolean;
  toastTimer: number | null;
}

const cards = new WeakMap<Element, CardState>();

/** 建一个卡片列（**不渲染**：渲染由增强遍做，见文件头）。 */
export function createTurnEditsColumn(rows: TurnEditRow[], shellish: number): HTMLElement {
  const col = el('div', 'mcol turn-edits-col');
  col.dataset['turnEdits'] = '1';
  cards.set(col, { rows, shellish, folded: false, expanded: false, toastTimer: null });
  return col;
}

/** 该列此刻的账本（测试/诊断用只读快照）。 */
export function turnEditsStateOf(col: Element): CardState | null {
  return cards.get(col) ?? null;
}

// ---- 动作 ------------------------------------------------------------------

/** 复制文本：clipboard 不可用时走 textarea 回退；两条都失败 ⇒ **如实**报 false。 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return legacyCopy(text);
  }
}

/** 回退复制（老浏览器 / 非安全上下文 / jsdom）。失败如实返回 false，不假装成功。 */
function legacyCopy(text: string): boolean {
  const doc = document;
  const ta = doc.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  doc.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    // execCommand 在部分环境里根本不存在 —— 取不到就是「复制不了」，不是「复制成功」。
    ok = typeof doc.execCommand === 'function' && doc.execCommand('copy') === true;
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

/** 「打开」= 与正文里的文件路径**同一个出口**（resolveTarget + openFilePreview）。 */
function openRow(path: string): void {
  const abs = resolveTarget(path);
  if (abs === null) return; // 工作区根未知：宁可不打开，也不猜一个可能读不出来的绝对路径
  openFilePreview(abs);
}

// ---- 渲染 ------------------------------------------------------------------

function diffCell(row: TurnEditRow): HTMLElement | null {
  // 两个数都不知道 ⇒ **不画这个格子**（`+0 −0` 会被读成「没有变化」，那是假话）。
  if (row.add === null && row.del === null) return null;
  const box = el('span', 'te-diff');
  if (row.add !== null && row.add > 0) box.appendChild(el('b', 'te-add', '+' + row.add));
  if (row.del !== null && row.del > 0) box.appendChild(el('b', 'te-del', '−' + row.del));
  return box;
}

function pathCell(path: string): HTMLElement {
  const box = el('span', 'te-path');
  box.title = path;
  // 目录与文件名各自成节点：淡显的只是目录；省略号（rtl 截断）吃掉的也只会是目录。
  const bdi = el('bdi');
  const { dir, file } = splitPath(path);
  if (dir !== '') bdi.appendChild(el('span', 'te-dir', dir));
  bdi.appendChild(el('span', 'te-file', file));
  box.appendChild(bdi);
  return box;
}

function menuButton(act: string, label: string): HTMLElement {
  const b = el('button', 'te-menu-item', label) as HTMLButtonElement;
  b.type = 'button';
  b.setAttribute('role', 'menuitem');
  b.dataset['act'] = act;
  return b;
}

function buildRow(row: TurnEditRow): HTMLElement {
  const li = el('li', 'te-row');
  li.dataset['k'] = row.kind;
  li.dataset['path'] = row.path;
  const kind = el('span', 'te-kind', KIND_LETTER[row.kind]);
  kind.dataset['k'] = row.kind;
  // 字母是给眼睛的缩略；读屏念「W」没有意义 —— 用一句话给它一个可访问名。
  kind.setAttribute('title', t(KIND_ARIA_KEY[row.kind]));
  kind.setAttribute('aria-label', t(KIND_ARIA_KEY[row.kind]));
  li.appendChild(kind);
  li.appendChild(pathCell(row.path));
  const diff = diffCell(row);
  if (diff !== null) li.appendChild(diff);
  // 行动作：主按钮「打开」+ 下拉箭头（箭头**保留**；默认动作 = 打开）。
  const acts = el('span', 'te-acts');
  const open = el('button', 'te-open', t('chat.turnEdits.open')) as HTMLButtonElement;
  open.type = 'button';
  open.dataset['act'] = 'open';
  const caret = el('button', 'te-caret') as HTMLButtonElement;
  caret.type = 'button';
  caret.dataset['act'] = 'menu';
  caret.setAttribute('aria-haspopup', 'menu');
  caret.setAttribute('aria-expanded', 'false');
  caret.setAttribute('aria-label', t('chat.turnEdits.moreActions'));
  caret.innerHTML = CHEVRON('down'); // 常量几何，无注入面
  const menu = el('div', 'te-menu');
  menu.setAttribute('role', 'menu');
  menu.appendChild(menuButton('open', t('chat.turnEdits.open')));
  // 平台门控：不是 win/macOS（或宿主没提供这个动作）⇒ **整项不出现**（不是禁用）。
  if (canReveal()) menu.appendChild(menuButton('reveal', t('chat.turnEdits.reveal')));
  menu.appendChild(menuButton('copy', t('chat.turnEdits.copyPath')));
  acts.appendChild(open);
  acts.appendChild(caret);
  acts.appendChild(menu);
  li.appendChild(acts);
  return li;
}

function buildHead(state: CardState, totals: ReturnType<typeof totalsOf>, empty: boolean): HTMLElement {
  const head = el('div', 'te-head');
  const icon = el('span', 'te-icon' + (empty ? ' is-empty' : ''));
  icon.innerHTML = DOC_ICON; // 常量几何（空态是**同一个轮廓**，只降色）
  head.appendChild(icon);
  const text = el('div', 'te-text');
  // 标题给总数、副标题给构成；空态换成「本轮无文件改动」+「没有文件被新增、修改或删除」。
  text.appendChild(
    el(
      'div',
      'te-title' + (empty ? ' is-empty' : ''),
      empty ? t('chat.turnEdits.empty') : t('chat.turnEdits.title', { n: totals.files }),
    ),
  );
  text.appendChild(
    el(
      'div',
      'te-sub',
      empty
        ? t('chat.turnEdits.emptySub')
        : breakdownOf(totals)
            .map((p) => t(KIND_LABEL_KEY[p.kind], { n: p.n }))
            .join(' · '),
    ),
  );
  head.appendChild(text);
  if (empty) return head; // 空态：**去掉折叠按钮与聚合**（定稿第 7 条）
  head.appendChild(el('div', 'te-spacer'));
  // 聚合：按**全量**算（不随折叠变化）；有行给不出数字时整块不出现。
  if (totals.add !== null && totals.del !== null) {
    const sum = el('div', 'te-sum');
    sum.appendChild(el('b', 'te-add', '+' + totals.add));
    sum.appendChild(el('b', 'te-del', '−' + totals.del));
    head.appendChild(sum);
  }
  const fold = el('button', 'te-fold') as HTMLButtonElement;
  fold.type = 'button';
  fold.dataset['act'] = 'fold';
  fold.setAttribute('aria-expanded', state.folded ? 'false' : 'true');
  fold.setAttribute('aria-label', t('chat.turnEdits.fold'));
  fold.innerHTML = CHEVRON(state.folded ? 'right' : 'down');
  head.appendChild(fold);
  return head;
}

function buildFoot(state: CardState, w: ReturnType<typeof foldWindow>): HTMLElement {
  const foot = el('div', 'te-foot');
  if (w.hidden > 0) {
    const more = el('button', 'te-more') as HTMLButtonElement;
    more.type = 'button';
    more.dataset['act'] = 'expand';
    more.appendChild(el('span', null, t('chat.turnEdits.more', { n: w.hidden })));
    more.insertAdjacentHTML('beforeend', CHEVRON('down')); // 常量几何
    foot.appendChild(more);
  } else if (w.canCollapse) {
    const less = el('button', 'te-more') as HTMLButtonElement;
    less.type = 'button';
    less.dataset['act'] = 'collapse';
    less.appendChild(el('span', null, t('chat.turnEdits.collapse')));
    less.insertAdjacentHTML('beforeend', CHEVRON('up'));
    foot.appendChild(less);
  }
  if (state.shellish > 0) {
    foot.appendChild(el('span', 'te-note', t('chat.turnEdits.otherCalls', { n: state.shellish })));
  }
  const toast = el('span', 'te-toast');
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  foot.appendChild(toast);
  return foot;
}

/**
 * 渲染（或重渲染）一列里的卡片。**幂等**：同一列反复调用只是把内容按当前状态重画
 * （折叠/展开状态存在 [cards] 里，不随重画丢失）。
 */
export function renderTurnEditsColumn(col: HTMLElement): void {
  const state = cards.get(col);
  if (!state) return;
  const totals = totalsOf(state.rows);
  const empty = totals.files === 0;
  const w = foldWindow(totals.files, turnEditsThreshold(), state.expanded);
  const card = el('div', 'te');
  card.dataset['folded'] = state.folded ? 'true' : 'false';
  card.dataset['empty'] = empty ? 'true' : 'false';
  card.appendChild(buildHead(state, totals, empty));
  if (!empty) {
    const list = el('ul', 'te-list');
    for (const row of visibleRows(state.rows, w)) list.appendChild(buildRow(row));
    card.appendChild(list);
  }
  const foot = buildFoot(state, empty ? { shown: 0, hidden: 0, canCollapse: false } : w);
  // 空态且没有附注时不必挂页脚（页脚只承载「还有 N 个」/「收起」/附注/提示）。
  if (!empty || state.shellish > 0 || foot.childElementCount > 1) card.appendChild(foot);
  card.addEventListener('click', (ev) => onCardClick(col, state, card, ev));
  card.addEventListener('keydown', (ev) => onCardKeydown(card, ev));
  col.replaceChildren(card);
}

// ---- 交互 ------------------------------------------------------------------

function toastOf(card: HTMLElement): HTMLElement | null {
  return card.querySelector<HTMLElement>('.te-toast');
}

function toast(state: CardState, card: HTMLElement, text: string, failed = false): void {
  const box = toastOf(card);
  if (box === null) return;
  box.textContent = text;
  // 「复制失败」不得用成功色印出来 —— 失败是失败。
  box.classList.toggle('is-err', failed);
  if (state.toastTimer !== null) window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    state.toastTimer = null;
    if (box.isConnected) box.textContent = '';
  }, TOAST_MS);
}

function closeMenus(card: HTMLElement): void {
  for (const row of Array.from(card.querySelectorAll('.te-row.is-menu-open'))) {
    row.classList.remove('is-menu-open');
    row.querySelector('.te-caret')?.setAttribute('aria-expanded', 'false');
  }
}

function openMenu(row: Element, caret: Element): void {
  row.classList.add('is-menu-open');
  caret.setAttribute('aria-expanded', 'true');
  row.querySelector<HTMLElement>('.te-menu-item')?.focus();
}

function rowPathOf(node: Element | null): string {
  return node?.closest('.te-row')?.getAttribute('data-path') ?? '';
}

async function onCardClick(col: HTMLElement, state: CardState, card: HTMLElement, ev: Event): Promise<void> {
  const target = ev.target as Element | null;
  const btn = target?.closest<HTMLElement>('[data-act]') ?? null;
  if (btn === null) {
    closeMenus(card); // 点空白 = 收起菜单
    return;
  }
  const act = btn.dataset['act'];
  if (act === 'fold') {
    state.folded = !state.folded;
    renderTurnEditsColumn(col);
    return;
  }
  if (act === 'expand' || act === 'collapse') {
    state.expanded = act === 'expand';
    renderTurnEditsColumn(col);
    return;
  }
  if (act === 'menu') {
    const row = btn.closest('.te-row');
    const open = row?.classList.contains('is-menu-open') === true;
    closeMenus(card);
    if (row !== null && !open) openMenu(row, btn);
    return;
  }
  const path = rowPathOf(btn);
  if (path === '') return;
  closeMenus(card);
  if (act === 'open') {
    openRow(path);
    return;
  }
  if (act === 'reveal') {
    // 菜单里出现它 = 平台支持 **且** 宿主提供了动作（见 model 的 canReveal）；
    // 真到执行时能力没了 ⇒ 如实说「不可用」，绝不当成功。
    if (!revealPath(path)) toast(state, card, t('chat.turnEdits.revealUnavailable'), true);
    return;
  }
  if (act === 'copy') {
    const ok = await copyText(path);
    toast(state, card, ok ? t('chat.turnEdits.copied') : t('chat.turnEdits.copyFailed'), !ok);
  }
}

function onCardKeydown(card: HTMLElement, ev: KeyboardEvent): void {
  if (ev.key !== 'Escape') return;
  const open = card.querySelector('.te-row.is-menu-open');
  if (open === null) return;
  closeMenus(card);
  open.querySelector<HTMLElement>('.te-caret')?.focus();
}

// ---- 增强遍 -----------------------------------------------------------------

/**
 * 增强遍本体。`enhance(container)` 只认容器里的**卡片列**（`[data-turn-edits]`），
 * 不碰消息正文的任何节点 —— 所以它在增强链的哪个位置都安全（order 取 130：排在
 * 内置两遍与 W895-C2 的四项之后，纯粹是声明式记账）。
 */
export function turnEditsEnhancer(): Enhancer {
  return {
    id: TURN_EDITS_ID,
    order: 130,
    enhance(container: Element): void {
      for (const node of Array.from(container.querySelectorAll('[data-turn-edits]'))) {
        renderTurnEditsColumn(node as HTMLElement);
      }
    },
  };
}

// ---- 插件开关（关掉 ⇒ 已有的卡片整体不出现） ---------------------------------

/**
 * 已渲染的卡片列（**document 级查询**，不在这里持有强引用：卡片随会话容器一起
 * 被 DOM 上限/容器淘汰回收，本模块不该把它们钉在内存里）。
 */
function renderedColumns(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-turn-edits]'));
}

/** 插件被关掉：卡片整体不出现（列留空 ⇒ CSS 的 `:empty` 让它不占位）。 */
export function clearTurnEditsCards(): void {
  for (const col of renderedColumns()) col.replaceChildren();
}

/** 插件（重新）打开 或 阈值变了：按同一条渲染路径重画。 */
export function refreshTurnEditsCards(): void {
  for (const col of renderedColumns()) renderTurnEditsColumn(col);
}

/** 测试/诊断缝：宿主声明能力（真实宿主由桌面壳或后续端点调用）。 */
export { setRevealCapability } from './model';
