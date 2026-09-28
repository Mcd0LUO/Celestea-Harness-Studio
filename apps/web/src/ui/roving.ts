// ============================================================================
// ui/roving.ts — 列表行的键盘通道（**唯一一份** roving tabindex 内核）
// ----------------------------------------------------------------------------
// 来源：W2040 为工作台文件行 `.wb-row` 写的第一份实现（ui/workbench/files-keys.ts）。
//   那一遍把缺陷、三种候选模型的取舍、以及「为什么是 roving tabindex 而不是
//   aria-activedescendant」全部论证过了（见 W2040 报告 §2①）。W2053 要把同一条通道
//   铺到另外 4 处列表，于是把它**提出来**共用 —— 本仓复盘 §1.4 的教训是「同一个判定
//   抄三遍必漏一处」：4 份拷贝就是 4 次漏掉 IME 守卫、漏掉 preventDefault（Space
//   滚一屏）、或算错停靠点的机会。
//
// ★ 本模块只管**列表项**这一种形状（一个容器 N 个同类行，容器整体占 1 个 Tab 停靠点）。
//   表格行（.prov-row）**不是**这种形状：它必须保住 role=row + 单元格语义（真机 AX
//   实测：给 <tr> 加 role=button 会把 6 个 role=cell 全部降级成 generic），且行数由
//   人手配置、天然有界。它走 bindRowActivate（自己占一个停靠点）。逐处模型的论证见
//   W2053 报告 §2①。
//
// ★ 两条不变量（与 W2040 逐字一致）：
//   ① 焦点环由 CSS 的 :focus-visible 表达，复用 W2006 的专用 token --c-focus-ring
//      ⇒ 本模块**不写任何样式**，也不维护「活动项」class；
//   ② 激活一律调 row.click() —— 与鼠标**同一个**处理器。等效性由构造保证，
//      不靠两份代码保持同步。
//
// ★ W2053 新增的两条（W2040 的单一平坦列表用不到，会话树用得到）：
//   ③ **可达性**：折叠的 <details> 里的行**无法聚焦**（真机实测：focus() 之后
//      activeElement 仍不是它，Tab 也跳过）。若把停靠点留在这样的行上，整个列表就
//      **一个可 Tab 到的停靠点都没有** —— 键盘用户彻底进不来。所以停靠点只落在
//      「当前可达」的第一行上。
//   ④ **展开即接管**：上一条若不配监听会造出陷阱 —— 用户 Tab 到分组头、按 Enter
//      展开，组内的行却全是 tabindex=-1 ⇒ Tab 直接跳过整组，Shift+Tab 又回到分组头，
//      永远进不去。所以监听 <details> 的 toggle（原生事件，不冒泡 ⇒ 逐个子节点挂），
//      展开/收起后重算停靠点。
// ============================================================================
import { isImeKey } from './ime';

/**
 * 激活键：与 ui/enhance/file-link.ts 的 ACTIVATE_KEYS 同一口径（原生 button 语义），
 * 也与 image-zoom.ts / csv-table.ts / W2040 的既有写法一致。
 */
export const ACTIVATE_KEYS: ReadonlySet<string> = new Set(['Enter', ' ']);

/**
 * 参与 roving 的行的标记属性（由 markRowButton 写、由内核按它取行）。
 *
 * 为什么用**标记属性**而不是类名选择器：会话树的 worker 容器里同时住着
 * `.ws-worker-row`（可点）与 `.ws-worker-parent`（**两种**：可点的父会话头、
 * 以及**不可点**的「未关联」分组标签）。按类名取行会把那个纯标签也算成一个停靠点，
 * 用户 Tab 上去按 Enter 什么都不会发生 —— 一个假的交互项。标记属性让「谁是行」由
 * 渲染侧**显式**声明，5 处调用点共用同一个选择器常量，不存在两份选择器漂移的机会。
 */
export const ROVING_ROW = '[' + 'data-roving' + ']';

/** 标记属性的名字（渲染侧与测试共用**唯一一份**字面量）。 */
export const ROVING_ATTR = 'data-roving';

/**
 * 行内的交互控件：这些节点**自己持键**，从它们冒泡上来的按键不归行。
 *
 * 为什么必须有这条：会话行里嵌着 ⋯（打开菜单）与批量模式的勾选框；提供商行里嵌着
 * 「删除」。若不加区分，在 ⋯ 上按 Enter 会**同时**开菜单和开会话 —— 一次按键两个动作。
 * 选择器串与 ui/providers/panel.ts 点击处理器里那一串**同一份口径**（同一件事只写一遍）。
 */
const CONTROL_SEL = 'button, a, input, select, textarea, label';

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

/**
 * 这一行现在**够得着**吗（能不能被聚焦）？
 *
 * 判据是 **DOM 结构**而不是布局：折叠的 <details> 会让其内容不可聚焦（浏览器行为），
 * 而「某个祖先 details 没有 open」是纯结构事实 —— jsdom 与 Blink 得到同一个答案，
 * 于是门禁与真机证据可以是同一句话。
 * ★ 为什么不用 offsetParent / getBoundingClientRect：真机实测，折叠组里的行
 *   `offsetParent !== null`、高度仍是 31px（.ws-body 用 max-height:0 + overflow:hidden
 *   折叠，不是 display:none）—— 布局探针在这里**会给出错误的「可达」**。
 */
export function isReachable(row: HTMLElement): boolean {
  return row.closest('details:not([open])') === null;
}

/** 容器里的行（文档序 —— 与视觉顺序、与 ↑↓ 的方向**同一个**顺序）。 */
export function rowsOf(list: ParentNode): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>(ROVING_ROW));
}

/**
 * 把一行标成「可被键盘聚焦的按钮」：tabindex + role + 可读名字 + roving 标记。
 *
 * 属性写在**节点**上（行每次新建 ⇒ 天然幂等）。role=button 是 WAI-ARIA 对
 * 「用 div 做按钮」的要求（4.1.2 Name, Role, Value），与 W2040 的 .wb-row 同一口径。
 *
 * ★ 为什么显式给 aria-label 而不是靠内容取名：会话行里还有 worker 计数徽标与 ⋯ 字形，
 *   内容取名会得到「main W2 ⋯」这种带噪声的名字（真机 AX 树实测）。标签与可见标题
 *   取自**同一个变量**，不存在两份文案漂移。
 */
export function markRowButton(row: HTMLElement, label?: string): void {
  row.setAttribute(ROVING_ATTR, '');
  row.tabIndex = -1;
  row.setAttribute('role', 'button');
  // label 缺省 = 用**内容**取名（工作台文件行就是这样：行里只有图标 + 文件名 + 大小
  // + 时间，内容取名恰好是用户想听的那串）。给了 label 就覆盖它，用于行里混着
  // 徽标 / ⋯ 字形这类噪声的场合（会话行）—— 真机 AX 实测内容取名会得到
  // 「main W2 ⋯」，把菜单按钮的字形读进了行名里。
  if (label !== undefined) row.setAttribute('aria-label', label);
}

/** 只写 tabindex（不动焦点）：第 to 行进 Tab 序列，其余全部 -1。 */
function setStops(rows: readonly HTMLElement[], to: number): void {
  rows.forEach((r, i) => { r.tabIndex = i === to ? 0 : -1; });
}

/**
 * 重置停靠点（列表重建 / 折叠态变化时）：**第一个够得着的行**进序列，其余不进。
 *
 * 一个都不够得着（整棵树都折叠着）⇒ 全部 -1，本容器不占停靠点。这是**正确**的：
 * 此时用户该走的是各分组的 <summary>（原生可 Tab），展开后 toggle 会重算停靠点。
 */
export function resetStops(list: ParentNode): void {
  const rows = rowsOf(list);
  setStops(rows, rows.findIndex(isReachable)); // -1 ⇒ 没有任何行进序列
}

/** 移动停靠点并**真的**把焦点移过去（↑↓ / Home / End）。 */
export function moveStop(rows: readonly HTMLElement[], to: number): void {
  const next = rows[to];
  if (next === undefined) return;
  setStops(rows, to);
  next.focus();
}

export interface RovingOptions {
  /**
   * 键盘激活会**重建本列表**（例如目录浏览弹层进入子目录）⇒ 重建后把焦点接回第一行。
   *
   * 为什么必须逐列表显式声明而不是一律置位：标记是模块级的一次性量，置了却没人消费
   * 就会残留，让**下一次无关的渲染**夺走鼠标用户的焦点。所以只有确实会重建的列表才置 true。
   * 会话树**不置**：真机实测点会话行后 `leafSameNode === true`（openSessionRow 只切
   * active 高亮，不重建树），置了反而会在下一次 loadTreeInto 时误夺焦。
   */
  refocus?: boolean;
}

/**
 * 绑定列表的键盘通道（列表每次重建都是**新节点** ⇒ 天然幂等，不会重复挂监听）。
 *
 * 监听挂在**列表**上而不是每一行：一个工作区可能有几十个会话行，逐行挂就是几十个
 * 监听器；而且列表是整体重建的，委托让「重建」不需要任何注销动作。
 */
export function bindRoving(list: HTMLElement, opts: RovingOptions = {}): void {
  const refocus = opts.refocus === true;
  list.addEventListener('keydown', (ev) => { onRovingKeydown(ev, list, refocus); });
  // 折叠态变化 ⇒ 重算停靠点（理由见文件头 ③④）。toggle 不冒泡，逐个挂；
  // 容器是新建节点 ⇒ 与 keydown 一样天然幂等，不需要注销。
  // ★ 容器**自身**也可能是 <details>（worker 组就是这样：list === .ws-worker-details）——
  //   querySelectorAll 不含自身，漏掉它就会让「折叠再展开」之后整组没有停靠点。
  const togglers = list instanceof HTMLDetailsElement ? [list, ...list.querySelectorAll('details')] : list.querySelectorAll('details');
  for (const det of togglers) {
    det.addEventListener('toggle', () => { resetStops(list); });
  }
  resetStops(list);
}

/**
 * 这次按键的落点是不是**归这一行本体**的（见 CONTROL_SEL 的理由）。
 *
 * ★ 两种通道共用这一条判据，但**不能**共用「怎么找到行」：
 *   roving 的行带 data-roving 标记，表格行**不带**（它不需要那个标记 —— 它自己就是
 *   唯一的那一行）。早先 bindRowActivate 直接复用 rowOf(ev)（内部按标记找行），
 *   于是表格行的按键永远找不到行、Enter 静默失效 —— 单测 ② 抓到的正是这一条。
 */
function onRowItself(ev: KeyboardEvent, row: HTMLElement): boolean {
  const target = ev.target;
  if (!(target instanceof Element)) return false;
  if (!row.contains(target)) return false;
  return target === row || target.closest(CONTROL_SEL) === null;
}

/** 事件落点所在的行（落点不在任何行上、或落在行内控件上 ⇒ null）。 */
function rowOf(ev: KeyboardEvent): HTMLElement | null {
  const target = ev.target;
  if (!(target instanceof Element)) return null;
  const row = target.closest<HTMLElement>(ROVING_ROW);
  if (row === null) return null;
  return onRowItself(ev, row) ? row : null;
}

/** 列表的 keydown（委托）。 */
function onRovingKeydown(ev: KeyboardEvent, list: HTMLElement, refocus: boolean): void {
  // W2033/W2036：组合会话里的按键归输入法（共享判据，绝不在这里抄第二份）。
  // 行本身不是文本框，但这条判据是**一次按键是不是给输入法的**，与控件类型无关。
  if (isImeKey(ev)) return;
  const rows = rowsOf(list);
  if (rows.length === 0) return;
  const row = rowOf(ev);
  if (ACTIVATE_KEYS.has(ev.key)) {
    // 落点不在行上 ⇒ 什么都不做（键盘事件只可能从某一行冒泡上来；不猜、不兜底）。
    if (row === null) return;
    ev.preventDefault(); // Space 必须吞掉，否则面板会滚一屏（与 file-link.ts 同款）
    if (refocus) armFocusAfterNav();
    row.click();         // ★ 与鼠标**同一个**处理器：等效性由构造保证，不靠两条代码同步
    return;
  }
  if (row === null) return;
  const to = nextIndex(ev.key, rows.indexOf(row), rows.length);
  if (to === null) return;
  ev.preventDefault();   // 方向键 / Home / End 不得让面板滚动
  moveStop(rows, to);
}

/**
 * 「单个可聚焦行」的键盘通道（**不是** roving）：行自己占一个 Tab 停靠点。
 *
 * 给谁用：行数有界、且必须保住自身语义的行 —— 目前只有提供商表行（role=row +
 * aria-expanded，单元格内容必须留在 AX 树里）。见 W2053 报告 §2① 的逐处模型论证。
 *
 * 为什么仍然走 click()：与 roving 同一条理由 —— 等效性由构造保证。
 * 为什么忽略来自行内控件的按键：提供商行里有「删除」按钮，在它上面按 Enter
 * 必须只弹确认框，不能顺带把内联面板也展开。
 */
export function bindRowActivate(row: HTMLElement): void {
  row.addEventListener('keydown', (ev) => {
    if (isImeKey(ev)) return;
    if (!ACTIVATE_KEYS.has(ev.key)) return;
    if (!onRowItself(ev, row)) return;
    ev.preventDefault();
    row.click();
  });
}

/**
 * 「这次导航是键盘发起的」标记。
 *
 * 为什么需要：Enter 进入子目录后整个列表被重建，原来那个带焦点的行从 DOM 上消失
 * ⇒ 焦点掉回 `<body>`，键盘用户要从页面顶端重新 Tab 一圈才能回到新目录 —— 那是
 * 「技术上进得去、实际上没法用」。鼠标用户不受影响（他们本来就重新用鼠标指），
 * 所以**只在键盘激活时**恢复焦点。
 *
 * 消费点由各调用方在 replaceChildren 之后取走（例如 fsbrowser 的 loadDirs）。
 * 标记不跨导航存活：即使某次导航没有走到消费点（请求失败、面板已切换），
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

/** 重建后把停靠点与焦点接回**第一个够得着的行**（只由键盘导航路径调用）。 */
export function focusFirstRow(root: ParentNode): void {
  const rows = rowsOf(root);
  const at = rows.findIndex(isReachable);
  if (at < 0) return;
  moveStop(rows, at);
}
