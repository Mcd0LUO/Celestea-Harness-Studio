// ============================================================================
// ui/workbench/narrow.ts — W9329：**窄屏诚实降级**（挤压 ⇄ 覆盖的判定与切换）。
// ----------------------------------------------------------------------------
// 用户口径（原型已拍板）：「容不下『会话最小 + 面板最小』时改**覆盖式**并给出提示
// —— 而不是把正文挤到不可读。」
//
// 本模块只管这一件事，独立于面板渲染（panel.ts）。三条边界：
//   ① 判据是**纯函数**（narrowPasses）：输入「可用宽 + 面板宽」两个数，输出
//      「挤得下 / 挤不下」。纯函数才判得动后果（tests/w9329 ⑤ 的真值表）。
//   ② 测量（availableForChat）知道 #layout 的子结构，但**不碰**面板数据。
//   ③ 切换（applyNarrow）只加/去 .overlay 与提示条，不重建面板区 ——
//      重建会把正在读的文件从头重画（真机 700px 视口下实测到过那次抖动）。
//
// 为什么不用 @media：能不能挤下取决于**面板宽**（用户可拖）与**视口宽**（用户可缩）
// 两个运行期量，CSS 媒体查询只知道后者。少一个观察器就会在「拖宽面板把会话挤到
// 200px」时**静默**把正文压扁 —— 那正是要避免的。
// ============================================================================
import { el } from '../../utils/dom';
import { t } from '../../i18n';

/** 会话列的最小可读宽：窄于此值就改覆盖式，而不是把正文挤到不可读。 */
export const CHAT_MIN = 360;
/**
 * 覆盖 ⇄ 挤压的**滞回带**（px）。
 *
 * 没有它两态会在阈值附近来回翻：进覆盖 ⇒ host 退出 flex 流 ⇒ available 变大 ⇒
 * 判据通过 ⇒ 退回挤压 ⇒ available 变小 ⇒ 又进覆盖 …… 每翻一次重建一次面板区。
 * 24px 取「一个按钮加内边距」的量级：小于它时一次 1px 的窗口抖动就能翻回去，
 * 大于它则用户把窗口拉回 24px 才有反应、显得迟钝。
 */
export const HYSTERESIS = 24;

/**
 * 判据：容得下 = 「扣掉面板后，会话列仍 ≥ CHAT_MIN」。
 *
 * ★ 关键：**available 必须是「没有面板时」的宽**（#layout 宽 − 侧栏宽），
 *   不能是「已被挤过」的 #main 宽。量后者会**双重扣减**：#main 已经少了面板那么宽，
 *   再减一次 panelsW 等于扣两遍 —— 真机实测（1440 视口、420 面板）会误判成
 *   「挤不下」而**假降级**；反过来 700 视口下 #main 被挤到 0 时判据反而「通过」，
 *   **假通过**。两头错都是同一个原因。
 */
export function narrowPasses(available: number, panelsW: number): boolean {
  return available >= CHAT_MIN + panelsW;
}

/** 降级控制器要看的几个盒子（由 panel.ts 装配时给）。 */
export interface NarrowTargets {
  /** 面板宿主（加/去 .overlay 的对象）。 */
  host: HTMLElement;
  /** #layout（测「没有面板时的可用宽」的容器）。 */
  layout: HTMLElement;
  /** #main（提示条的挂载点）。 */
  main: HTMLElement;
  /** 当前面板列宽（右面板里最宽的那个）。 */
  columnWidth(): number;
}

export interface NarrowGuard {
  /** 量一次并应用判据（渲染后 / 窗口变化 / 拖宽后调）。 */
  measure(): void;
  /** 当前是否处于覆盖态。 */
  isOverlay(): boolean;
}

/**
 * 建一个降级守卫。
 *
 * 状态（currentNarrow / 提示条节点）关在闭包里 —— 它是**这一块 UI** 的私有状态，
 * 抖不出去给别的模块误读。
 */
export function createNarrowGuard(targets: NarrowTargets): NarrowGuard {
  let overlay = false;
  let note: HTMLElement | null = null;

  /** #main 在**没有面板时**能有多宽（= #layout 宽 − 侧栏等**固定宽**兄弟）。 */
  const availableForChat = (): number => {
    const total = targets.layout.getBoundingClientRect().width;
    // ★ 只扣**固定宽**的兄弟（#sidebar / #sidebarResizer / #sidebarScrim）。
    //   #main 本身**不扣**：它是 `flex:1; min-width:0` 的弹性项，会**自己**让出面板
    //   需要的宽度。真机实测踩过这个坑：把 #main 也算进 used 会得到 used=1440、
    //   avail=0 ⇒ 判据恒失败 ⇒ **宽屏也误降级**成覆盖式（1440 视口、420 面板）。
    let fixed = 0;
    for (const c of Array.from(targets.layout.children) as HTMLElement[]) {
      if (c === targets.host || c === targets.main) continue;
      // 分隔条与面板区自身都不占「会话列可用宽」。
      if (c.classList.contains('wb-splitter') || c.classList.contains('wb-host')) continue;
      fixed += c.getBoundingClientRect().width;
    }
    return total - fixed;
  };

  const apply = (next: boolean): void => {
    if (next === overlay) return;
    overlay = next;
    targets.host.classList.toggle('overlay', next);
    document.body.classList.toggle('wb-overlay-open', next);
    if (next) {
      // 提示条挂在 #main 内（会话列顶部），**如实**说明当前是覆盖式（不默默盖住）。
      if (!note) {
        note = el('div', 'wb-narrow-note');
        note.textContent = t('chat.wb.narrowOverlay');
      }
      if (!note.isConnected) targets.main.appendChild(note);
    } else if (note) {
      note.remove();
    }
  };

  return {
    measure(): void {
      const available = availableForChat();
      const panelsW = targets.columnWidth();
      if (overlay) {
        // 出覆盖用**松**阈值（多给一个滞回带），防两态在阈值附近互相翻转。
        if (available >= CHAT_MIN + panelsW + HYSTERESIS) apply(false);
        return;
      }
      apply(!narrowPasses(available, panelsW));
    },
    isOverlay: (): boolean => overlay,
  };
}
