// ============================================================================
// ui/turn-edits/card.ts — 「本轮编辑」卡片的 **DOM 结构 + 渲染**（W9334）
// ----------------------------------------------------------------------------
// 行为规格：apps/web/prototype/turn-edits.html（联调定稿的 11 条）。分工：
//   · ./model.ts —— 数据与口径（纯函数，可断言）；
//   · ./interact.ts —— **点了会怎样**（菜单 / 折叠 / 复制 / 打开，含键盘路径）；
//   · 本模块 —— **长什么样**（表头 / 文件行 / 页脚 + 增强遍入口）。
// （W9334 返工：数字三档与口径附注把本文件顶到 456 行 ⇒ 按本仓纪律**拆分**，
//   不是去模块体积例外表登记一个新上限。）
//
// 三条纪律：
//   · 颜色只用 token（`--c-*` / `--mono` / `--card-radius` / `--shadow-panel` /
//     `--tap-hit`）—— 组件层零硬编码颜色（见 grants.css 的头注）；字母的颜色就是语义
//     （M 中性 / A 绿 / D 红），色值由主题决定（与原型逐字同色的是 claude 主题）；
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
import type { Enhancer } from '../enhance/registry';
import { bindCardInteractions, type CardState } from './interact';
import {
  breakdownOf,
  canReveal,
  foldWindow,
  KIND_ARIA_KEY,
  KIND_LABEL_KEY,
  KIND_LETTER,
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

// ---- 渲染 ------------------------------------------------------------------

/**
 * 行右侧的数字格 —— **按可知多少分三档**（见 model.ts 的文件头）：
 *   ① 精确区间 ⇒ `+add −del`（mono；加绿减红 —— 与定稿同色）；
 *   ② 只知新内容 ⇒ 「写入 N 行」（次级文字色：它**不是** diffstat，不给 +/− 号）；
 *   ③ 三样都不知道 ⇒ 不画这个格子（`+0 −0` 会被读成「没有变化」，那是假话）。
 */
function numCell(row: TurnEditRow): HTMLElement | null {
  if (row.add !== null && row.del !== null) {
    const box = el('span', 'te-diff');
    if (row.add > 0) box.appendChild(el('b', 'te-add', '+' + row.add));
    if (row.del > 0) box.appendChild(el('b', 'te-del', '−' + row.del));
    return box;
  }
  if (row.written !== null) {
    return el('span', 'te-diff is-written', t('chat.turnEdits.written', { n: row.written }));
  }
  return null;
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
  // 字母是给眼睛的缩略（M 中性 / A 绿 / D 红，颜色就是语义）；
  // 读屏念「M」没有意义 —— 用一句话给它一个可访问名，并把 M 的口径写在 title 上。
  kind.setAttribute('title', t(KIND_ARIA_KEY[row.kind]));
  kind.setAttribute('aria-label', t(KIND_ARIA_KEY[row.kind]));
  li.appendChild(kind);
  li.appendChild(pathCell(row.path));
  const diff = numCell(row);
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

/**
 * 口径说明（写在聚合的 title / aria-label 上，**可见的同款在页脚**）：说清每个数字
 * 统计的是哪几行、以及什么没被算进来。不知道的不冒充知道，也不把知道的藏起来。
 */
function scopeText(totals: ReturnType<typeof totalsOf>): string {
  const parts: string[] = [];
  if (totals.add !== null && totals.del !== null) {
    parts.push(t('chat.turnEdits.scope.diff', { a: totals.exactRows, b: totals.files }));
  }
  if (totals.written !== null) parts.push(t('chat.turnEdits.scope.written'));
  return parts.join(' ');
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
  // 聚合：按**全量**算（不随折叠变化）。**已知多少就聚多少**：
  //   · 精确区间合计 ⇒ `+X −Y`（只统计能算出区间的那几行）；
  //   · 只知新内容的那些行 ⇒ 「写入 N 行」；
  // 两块各自都带口径（title / aria-label + 页脚的可见附注），不混成一个假数字。
  const stats = el('div', 'te-sum');
  if (totals.add !== null && totals.del !== null) {
    stats.appendChild(el('b', 'te-add', '+' + totals.add));
    stats.appendChild(el('b', 'te-del', '−' + totals.del));
  }
  if (totals.written !== null) {
    stats.appendChild(el('span', 'te-written', t('chat.turnEdits.written', { n: totals.written })));
  }
  if (stats.childElementCount > 0) {
    stats.title = scopeText(totals);
    stats.setAttribute('aria-label', scopeText(totals));
    head.appendChild(stats);
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

function buildFoot(state: CardState, w: ReturnType<typeof foldWindow>, totals: ReturnType<typeof totalsOf>): HTMLElement {
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
  // 数字口径：**能看见**地说清每个数字统计的是哪几行、什么没被算进来。
  if (totals.add !== null && totals.del !== null) {
    foot.appendChild(el('span', 'te-note', t('chat.turnEdits.scope.diff', { a: totals.exactRows, b: totals.files })));
  }
  if (totals.written !== null) {
    foot.appendChild(el('span', 'te-note', t('chat.turnEdits.scope.written')));
  }
  if (totals.unknownRows > 0) {
    foot.appendChild(el('span', 'te-note', t('chat.turnEdits.scope.unknown', { n: totals.unknownRows })));
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
  const foot = buildFoot(state, empty ? { shown: 0, hidden: 0, canCollapse: false } : w, totals);
  // 空态且没有附注时不必挂页脚（页脚只承载「还有 N 个」/「收起」/口径附注/提示）。
  if (!empty || foot.childElementCount > 1) card.appendChild(foot);
  // 交互归 ./interact.ts；重画回调注入 ⇒ 那边不 import 本模块（不成环）。
  bindCardInteractions(state, card, () => renderTurnEditsColumn(col));
  col.replaceChildren(card);
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
