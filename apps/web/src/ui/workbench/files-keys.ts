// ============================================================================
// ui/workbench/files-keys.ts — W2040：工作台文件行的**键盘等效路径**。
// ----------------------------------------------------------------------------
// 缺陷（真机实测，CDP，原始数据见 W2040 报告）：`.wb-row` 是 `<div>` + **只有一个
//   click 监听**，tabIndex === -1 ⇒ `row.focus()` 之后 `document.activeElement` 仍是
//   `<body>` ⇒ 键盘用户**既选不中、也打不开**工作台里的任何文件（WCAG 2.1.1）。
//   W2025 修的是**正文路径**（`.content.rendered` 里的行内 code / 「文件：x」句式），
//   工作台文件行是**同一类缺陷的另一处**，W2040 补上。
//
// ★ W2053：内核**已提取**到 ui/roving.ts（同一条 roving tabindex 通道要铺到会话树 /
//   目录弹层等另外 4 处列表 ⇒ 4 份拷贝就是 4 次漏掉 IME 守卫、漏掉 preventDefault、
//   或算错停靠点的机会）。本文件现在只是**这一处的绑定参数**：选择器常量 + 消费点。
//   内核符号**原样再导出**，于是既有调用点（files.ts）与既有门禁
//   （files-keys.test.ts）的 import 路径与语义**逐字未变** —— 这次提取对它们是透明的。
//   模型取舍的完整论证（为什么 roving、为什么否决「每行 tabindex=0」与
//   aria-activedescendant）在 ui/roving.ts 的文件头与 W2040/W2053 两份报告里。
//
// ★ 与鼠标的关系：keydown 里**不复制**任何打开逻辑，而是调 `row.click()` ——
//   于是「Enter/Space 与 click 等效」不是靠两条并行代码保持同步，而是**只有一条代码**：
//   目录进入 / 文件预览 / 选中态 / 预览面板，全部走原来那个处理器，一个字没动。
// ============================================================================
import { bindRoving, focusFirstRow as focusFirstRowOf, markRowButton } from '../roving';

// 内核符号再导出：既有 import 路径（files.ts / files-keys.test.ts）不变。
export { ACTIVATE_KEYS, consumeFocusAfterNav, moveStop, nextIndex, resetStops } from '../roving';

/** 行选择器（渲染侧与键盘侧共用**唯一一份**；files.ts 从这里取）。 */
export const ROW_SEL = '.wb-row';

/** 列表选择器（同上）。 */
export const LIST_SEL = '.wb-list';

/**
 * 把一行标成工作台文件行的可聚焦按钮（roving 标记 + tabindex + role + 名字）。
 * 转调内核的 markRowButton —— 5 处列表行共用同一个实现。
 */
export { markRowButton };

/**
 * 绑定列表的键盘通道（roving tabindex：整个列表只占 1 个 Tab 停靠点）。
 *
 * refocus: 目录进入会重建列表 ⇒ 键盘路径要把焦点接回新列表（见 files.ts 的消费点）。
 */
export function bindListKeys(list: HTMLElement): void {
  bindRoving(list, { refocus: true });
}

/** 重建后把停靠点与焦点接回新列表的第一行（只由键盘导航路径调用）。 */
export function focusFirstRow(root: ParentNode): void {
  focusFirstRowOf(root);
}
