// ============================================================================
// utils/modal-bg.ts — 模态态的**背景隔离**（F2-01）
// ----------------------------------------------------------------------------
// 问题：　　#settingsPage 声明 `role="dialog" aria-modal="true"`，但 #app 既没有
//        `inert`、也没有任何焦点环绕。于是读屏被告知「这里只有设置页」，实际背景
//        11 个控件仍完整存在于可访问性树与 Tab 序列里（真机 CDP 实测：Tab×20 有
//        9 次落进背景，背景输入框真能接收输入）——**语义与实现相反**。
//
// 方案：　　原生 `inert`（Chrome 102+ / Safari 15.5+ / FF 112+）。它一次性解决
//        三件事，且不需要我们手写 Tab 环绕：
//          ① Tab 焦点进不去（inert 子树整体移出可聚焦序列）；
//          ② 读屏不读（移出可访问性树）；
//          ③ 鼠标点不动、程序 focus() 也进不去。
//        手写 Tab 环绕只能解决 ①，且必然漏「Shift+Tab 反向」「焦点跑出文档后如何
//        拉回」「背景被脚本 focus() 强抢」——本仓教训见 ui/roving.ts 文件头。
//
// 为什么不放在 utils/overlays.ts：　那条栈只管 **Esc 关闭**（一个 document 监听 +
//        push/pop 层级）。背景隔离是**正交**的第二件事，且只有声明了 aria-modal 的
//        那一类浮层才需要它；混进去会让「栈序 = 视觉层级」这条不变量失真（同该文件
//        对 sidebar 抽屉 / hint 卡的取舍）。
//
// 关键不变量：　成对。open 置 inert、close 必须摘掉。漏摘的后果比不做更糟
//        （整个应用变成一块砖，点哪儿都没反应且没有任何提示）。
//        　故这里用**句柄**而不是裸 set/remove：句柄记录「这次到底改没改」，
//        重复 close 是幂等的（常见场景：Esc 与「关闭」按钮可能都触发）。
// ============================================================================

/** 一次背景隔离的句柄。 */
export interface BackgroundHandle {
  /** 被置为 inert 的那些节点（按文档序）。 */
  readonly nodes: readonly HTMLElement[];
  /** 摘除时用它还原 —— 记下原值，别的模块若已设过 inert 就不该被我们抹掉。 */
  readonly restore: () => void;
}

const FOCUSABLE =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/**
 * 把除 `keep` 之外的兄弟子树设为 inert，并返回摘除句柄。
 *
 * 只动 `keep.parentElement` 的**兄弟**：那些正是「模态之外的世界」。不碰 document.body
 * 本身（body 是所有浮层的共同祖先，把它 inert 掉会把 keep 一起带走）。
 *
 * `before`（可选）：把焦点收进 keep —— 焦点此刻多半还停在触发按钮（背景里），
 * 而那个节点即将变成不可聚焦，浏览器会把焦点甩到 body，用户就「看不见焦点在哪」了。
 *
 * ★ 订正（F2-07-01 复核）：这段注释原先写的是「置 inert **之前**收焦点、顺序不能反」，
 *   但**代码一直是反的** —— 上面那个 for 循环先把兄弟全置 inert，`before` 在循环之后才
 *   跑。两种顺序的终态一样，原因是 keep 自己**不在**被置 inert 的名单里：循环只动兄弟，
 *   所以 `before` 里对 keep 内部节点的 focus() 无论早晚都有效（真机 390x844 CDP 实测：
 *   打开设置页后 activeElement=btnSettingsReload、focusInSettings=true，见
 *   results/audit4/F2/probe-A.json 的 P1_open）。
 *   据此**不改行为**、只订正注释：拿注释去「修」一个已被真机证明正确的顺序，等于用一个
 *   未验证的行为改动换一个看起来自洽的注释。
 *
 * `exclude`（可选，F2-07-01）：**浮层自己的控件**不是背景，必须从隔离名单里排除。
 * 「兄弟子树 = 背景」这条规则在抽屉上会咬人：#layout 的子节点是
 * `[#sidebar, #sidebarResizer, #sidebarScrim, #main]`，而 `#sidebarScrim` 正是抽屉
 * 的关闭遮罩（ui/sidebar.ts 给它挂了 click → setOpen(false)）。inert 的元素**不参与
 * 命中测试**，把它一并隔离就等于让那条监听永远收不到事件 —— 真机 390x844 实测：
 * 点遮罩区域 elementFromPoint 落到 #layout，抽屉纹丝不动（F2-07 修复前）。
 * 摘除侧没有对称问题：restore 只遍历 `nodes`，被排除的节点从未入列，不会被误摘。
 */
export function isolateBackground(
  keep: HTMLElement,
  before?: () => void,
  exclude?: ReadonlySet<Element>,
): BackgroundHandle {
  const parent = keep.parentElement;
  if (!parent) return { nodes: [], restore: () => {} };

  // 兄弟子树 = 背景。逐个标记，只记录「**由我们**改成 inert」的节点。
  const nodes: HTMLElement[] = [];
  for (const sib of Array.from(parent.children)) {
    if (sib === keep) continue;
    // 浮层自己的关闭控件（抽屉的 #sidebarScrim）不是背景：inert 会把它移出命中测试，
    // 点遮罩关抽屉就永远不触发。判在 instanceof 之前，省掉一次无谓的类型判断。
    if (exclude?.has(sib)) continue;
    if (!(sib instanceof HTMLElement)) continue;
    if (sib.hasAttribute('inert')) continue; // 别的层已隔离过，别抢也别覆盖
    sib.setAttribute('inert', '');
    nodes.push(sib);
  }

  if (before) before();

  return {
    nodes,
    restore: () => {
      for (const n of nodes) n.removeAttribute('inert');
      nodes.length = 0;
    },
  };
}

/** keep 内第一个可聚焦节点；都没有则退回 keep 本身（容器上留 tabindex 也能落焦点）。 */
export function firstFocusable(keep: HTMLElement): HTMLElement | null {
  const found = keep.querySelector<HTMLElement>(FOCUSABLE);
  if (found) return found;
  if (!keep.hasAttribute('tabindex')) keep.setAttribute('tabindex', '-1');
  return keep;
}
