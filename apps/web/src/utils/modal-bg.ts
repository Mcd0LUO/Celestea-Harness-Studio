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
 * `before`（可选）：置 inert **之前**先把焦点收进 keep —— 焦点此刻多半还停在触发按钮
 * （背景里），而那个节点即将变成不可聚焦。浏览器此时可能把焦点甩到 body，用户就
 * 「看不见焦点在哪」了。先进 keep 再置 inert，顺序不能反。
 */
export function isolateBackground(keep: HTMLElement, before?: () => void): BackgroundHandle {
  const parent = keep.parentElement;
  if (!parent) return { nodes: [], restore: () => {} };

  // 兄弟子树 = 背景。逐个标记，只记录「**由我们**改成 inert」的节点。
  const nodes: HTMLElement[] = [];
  for (const sib of Array.from(parent.children)) {
    if (sib === keep) continue;
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
