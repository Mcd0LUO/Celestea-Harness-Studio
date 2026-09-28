// ============================================================================
// ui/workbench/files-keys.ts — W2040：工作台文件行的**键盘等效路径**。
// ----------------------------------------------------------------------------
// 缺陷（真机实测，CDP，原始数据见报告）：`.wb-row` 是 `<div>` + **只有一个 click
//   监听**，tabIndex === -1 ⇒ `row.focus()` 之后 `document.activeElement` 仍是
//   `<body>` ⇒ 键盘用户**既选不中、也打不开**工作台里的任何文件（WCAG 2.1.1）。
//   W2025 修的是**正文路径**（`.content.rendered` 里的行内 code / 「文件：x」句式），
//   工作台文件行是**同一类缺陷的另一处**，本遍补上。
//
// ★ 模型选择：**roving tabindex** —— 整个列表只占 **1 个** Tab 停靠点，↑↓ 在项间移动。
//   三种候选与取舍（详见报告 §2①）：
//     (a) 每行 tabindex=0：MAX_DIR_ENTRIES = 200 ⇒ 一个目录最多 200 个停靠点，
//         Tab 导航被毁。**否**。
//     (b) aria-activedescendant（容器持焦 + 虚拟活动项）：焦点环只能靠 JS 维护的
//         class 画，**用不上 :focus-visible** ⇒ 本仓「焦点环一律 CSS + 专用 token」
//         的既有纪律（W2006 的 --c-focus-ring）断掉；而且「焦点真的落在行上」
//         不再能由 document.activeElement 直接断言。**否**。
//     (c) roving tabindex：列表 1 个停靠点 + ↑↓ 移动 + 焦点环走 :focus-visible。
//         **选它**。三条理由：
//           ① 它与 W2025 的 applyStops 是**同一条规矩**：一个元素带 tabindex=0、
//              其余 -1，停靠点随用户操作移交。差别只在移交的触发器 —— 正文路径是
//              **行内**元素（没有「项」的概念，只能靠 Tab 本身 / 焦点 / 悬停移交），
//              文件行是**列表项**（所以用方向键，这才是文件管理器 / VS Code 的手感）；
//           ② 焦点环可以完全由 CSS 的 :focus-visible 表达，复用 W2006 的专用 token
//              （对比度已由 tests/w9226-style-a11y-fixes.test.ts 钉在四套配色上）；
//           ③ `document.activeElement === row` 在 jsdom 与真机上都是同一个判据，
//              门禁与真机证据可以用同一句话写（W2025 也是这么验的）。
//
// ★ 与鼠标的关系：keydown 里**不复制**任何打开逻辑，而是调 `row.click()` ——
//   与 apps/web/src/ui/fsbrowser.ts:190 的 `goBtn.click()` 同款。于是
//   「Enter/Space 与 click 等效」不是靠两条并行代码保持同步，而是**只有一条代码**：
//   目录进入 / 文件预览 / 选中态 / 预览面板，全部走原来那个处理器，一个字没动。
// ============================================================================
import { isImeKey } from '../ime';

/**
 * 激活键：与 ui/enhance/file-link.ts 的 ACTIVATE_KEYS 同一口径（原生 button 语义），
 * 也与 image-zoom.ts / csv-table.ts 的既有写法一致。
 */
export const ACTIVATE_KEYS: ReadonlySet<string> = new Set(['Enter', ' ']);

/** 行选择器（渲染侧与键盘侧共用**唯一一份**；files.ts 从这里取）。 */
export const ROW_SEL = '.wb-row';

/** 列表选择器（同上）。 */
export const LIST_SEL = '.wb-list';

/**
 * 方向键 → 目标行下标（**越界钳制、不环绕**；不是导航键 ⇒ null）。
 *
 * 纯函数：本模块唯一的判定真源，单测直接打它（不需要 DOM）。
 * 为什么钳制而不环绕：系统文件管理器与 VS Code 的文件树到顶/到底就停住；
 * 环绕会让「按了 ↑ 却跳到最底」这种位移失去可预期性（Home/End 才是显式的边界跳转）。
 * 为什么 count<=0 返回 null 而不是 0：空列表没有「第 0 行」，返回 0 会让调用方
 * 去 focus 一个 undefined（NaN 化的下标在 JS 里不抛，会静默变成「什么都没发生」）。
 */
export function nextIndex(key: string, from: number, count: number): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  const at = Math.min(Math.max(from, 0), last);
  if (key === 'ArrowDown') return Math.min(at + 1, last);
  if (key === 'ArrowUp') return Math.max(at - 1, 0);
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  return null;
}

/** 列表里的行（文档序 —— 与视觉顺序、与 ↑↓ 的方向**同一个**顺序）。 */
function rowsOf(list: HTMLElement): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>(ROW_SEL));
}

/** 只写 tabindex（不动焦点）：第 to 行进 Tab 序列，其余全部 -1。 */
function setStops(rows: readonly HTMLElement[], to: number): void {
  rows.forEach((r, i) => { r.tabIndex = i === to ? 0 : -1; });
}

/** 重置停靠点（列表重建时）：第一行进序列，其余不进。**不夺焦点**。 */
export function resetStops(list: HTMLElement): void {
  setStops(rowsOf(list), 0);
}

/** 移动停靠点并**真的**把焦点移过去（↑↓ / Home / End）。 */
export function moveStop(rows: readonly HTMLElement[], to: number): void {
  const next = rows[to];
  if (next === undefined) return;
  setStops(rows, to);
  next.focus();
}

/**
 * 绑定列表的键盘通道（每次列表重建都是**新节点** ⇒ 天然幂等，不会重复挂监听）。
 *
 * 监听挂在**列表**上而不是每一行：一个目录最多 200 行，逐行挂就是 200 个监听器；
 * 而且列表是整体重建的，委托让「重建」不需要任何注销动作。
 */
export function bindListKeys(list: HTMLElement): void {
  list.addEventListener('keydown', onListKeydown);
  resetStops(list);
}

/**
 * 列表的 keydown（委托）。
 *
 * 只认**行自己**（或其子节点）冒泡上来的事件：行里目前只有 span，但 closest 让
 * 「以后行里再包一层」不会变成 bug（与 file-link-mark.ts 的 hitOf 同一条理由）。
 */
function onListKeydown(ev: KeyboardEvent): void {
  // W2033/W2036：组合会话里的按键归输入法（共享判据，绝不在这里抄第二份）。
  // 行本身不是文本框，但这条判据是**一次按键是不是给输入法的**，与控件类型无关。
  if (isImeKey(ev)) return;
  const list = ev.currentTarget;
  if (!(list instanceof HTMLElement)) return;
  const rows = rowsOf(list);
  if (rows.length === 0) return;
  const target = ev.target;
  const row = target instanceof Element ? target.closest<HTMLElement>(ROW_SEL) : null;
  if (ACTIVATE_KEYS.has(ev.key)) {
    // 落点不在行上 ⇒ 什么都不做（键盘事件只可能从某一行冒泡上来；不猜、不兜底）。
    if (row === null) return;
    ev.preventDefault(); // Space 必须吞掉，否则面板会滚一屏（与 file-link.ts 同款）
    armFocusAfterNav();  // 目录进入会重建列表 ⇒ 见下方 armFocusAfterNav 的理由
    row.click();         // ★ 与鼠标**同一个**处理器：等效性由构造保证，不靠两条代码同步
    return;
  }
  const to = nextIndex(ev.key, row === null ? 0 : rows.indexOf(row), rows.length);
  if (to === null) return;
  ev.preventDefault();   // 方向键 / Home / End 不得让面板滚动
  moveStop(rows, to);
}

/**
 * 「这次导航是键盘发起的」标记。
 *
 * 为什么需要：Enter 进入目录后整个列表被重建，原来那个带焦点的行从 DOM 上消失
 * ⇒ 焦点掉回 `<body>`，键盘用户要从页面顶端重新 Tab 一圈才能回到新目录 —— 那是
 * 「技术上进得去、实际上没法用」。鼠标用户不受影响（他们本来就重新用鼠标指），
 * 所以**只在键盘激活时**恢复焦点。
 *
 * 消费点**唯一**：files.ts 的 renderFilesPanel 在 replaceChildren 之后。
 * 标记不跨导航存活：即使某次导航没有走到消费点（例如请求失败、面板已切换），
 * 下一次成功渲染也会把它清掉，不会长期残留。
 */
let focusAfterNav = false;

/** 由键盘激活路径置位（鼠标路径**不**置位 ⇒ 鼠标行为零变化）。 */
export function armFocusAfterNav(): void {
  focusAfterNav = true;
}

/** 取走标记（取走即清零 —— 一次性，绝不重复夺焦）。 */
export function consumeFocusAfterNav(): boolean {
  const v = focusAfterNav;
  focusAfterNav = false;
  return v;
}

/** 重建后把停靠点与焦点接回新列表的第一行（只由键盘导航路径调用）。 */
export function focusFirstRow(root: ParentNode): void {
  const list = root.querySelector<HTMLElement>(LIST_SEL);
  if (list === null) return;
  const rows = rowsOf(list);
  if (rows.length === 0) return;
  moveStop(rows, 0);
}
