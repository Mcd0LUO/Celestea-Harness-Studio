// ============================================================================
// ui/viewport.ts — 视口 / 输入设备判定的**唯一真源**（W2023）
// ----------------------------------------------------------------------------
// 为什么单独成模块：`MOBILE_QUERY` / `isMobileViewport` 原先私有在 ui/sidebar.ts
// （W765 抽屉用）。W2023 的输入提示也要按「这台设备有没有物理 Shift 键」换文案 ——
// 若再抄一份判定，正是本仓复盘 §1.4「同一个判定抄三遍必漏一处」要防的事（断点数值
// 还要与 styles/responsive.css 的 mobile 档手工保持一致）。
//
// 两个判定分工**不同，不要混用**：
//   · isMobileViewport() —— **布局**档位（≤640px）：抽屉/汉堡这类「窄屏」行为。
//   · isTouchInput()     —— **输入设备**能力：有没有物理 Shift 键。决定快捷键文案。
//   二者不等价，W2023 真机实测（Chromium，本仓 scripts/perf/lib/chrome.mjs）：
//     · 390x844 + 触摸仿真   → coarse=true,  touchPoints=5 → 两者都真
//     · 1440x900 桌面无触摸  → coarse=false, touchPoints=0 → 两者都假
//     · **500x800 窄桌面**   → coarse=false, touchPoints=0 → 宽度真、能力假 ← 关键
//   窄桌面窗口是移动布局却有 Shift 键；宽触摸设备（平板横屏 1024px）是桌面布局却
//   没有 Shift 键。W2023 的缺陷是「没有 Shift 键」，故按**能力**判，不按宽度判 ——
//   按宽度判会在窄桌面误报、且在平板上**漏报**（缺陷原样残留）。
//
// 为什么取 `(pointer: coarse)` 而不是 `(hover: none)`：
//   同一组真机实测里，桌面 1440x900 无触摸时 `(hover: none)` 仍为 **true**
//   （headless 没有鼠标指针），`(pointer: coarse)` 才是 false。用 hover 会把桌面
//   误判成触摸设备、把桌面文案一起改掉（本轮明令不许发生的事）。
//   `any-pointer: coarse` 也不取：它在「触摸屏 + 鼠标」的二合一上为 true，而那类
//   设备的用户**有** Shift 键 —— 按它判会误伤。故取最窄的「主指针为粗粒度」。
// ============================================================================

import { t, type Key } from '../i18n';

/** 移动端断点（与 styles/responsive.css 的 mobile 档一致）。 */
export const MOBILE_QUERY = '(max-width: 640px)';

/** 主指针是否为粗粒度（手指 / 触控笔；鼠标为 fine）。 */
const COARSE_POINTER_QUERY = '(pointer: coarse)';

/** 当前是否处于移动布局档（≤640px）。matchMedia 缺失时回落 innerWidth。 */
export function isMobileViewport(): boolean {
  try {
    return window.matchMedia(MOBILE_QUERY).matches;
  } catch {
    return window.innerWidth <= 640;
  }
}

/**
 * 当前设备是否**没有物理 Shift 键**（触摸输入）。
 *
 * 两个条件都要满足：
 *   ① `(pointer: coarse)` —— 主指针是手指（桌面无鼠标的 headless 也是 false，
 *      这是与 `hover: none` 的关键区别，见文件头）；
 *   ② `navigator.maxTouchPoints > 0` —— 真的有触摸屏（二合一设备的保险）。
 *
 * 为什么不用 UA 嗅探：UA 可伪造，且「触摸笔记本」与普通笔记本的 UA 无法区分 ——
 * 能力位（media query + maxTouchPoints）才是浏览器给出的真实答案。
 */
export function isTouchInput(): boolean {
  try {
    if (!window.matchMedia(COARSE_POINTER_QUERY).matches) return false;
    return typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  } catch {
    return false; // 取不到能力位 ⇒ 按桌面（保守：桌面文案是超集，不会教错键）
  }
}

/** 动效偏好（系统「减少动态效果」开关）。 */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * 用户是否要求**减少动态效果**（W9336）。
 *
 * 为什么住在 viewport.ts 而不是调用点自己 matchMedia：本模块是「媒体查询判定的唯一
 * 真源」（文件头），而这条判定天然会有第二个消费者（任何要动起来的控件）。CSS 侧的
 * 对应物是 tokens.css 的全局 `@media (prefers-reduced-motion: reduce)` 块 —— 它只能
 * 关掉**声明式**动画（transition / animation），关不掉 JS 驱动的逐帧滚动，所以需要这
 * 个口子让调用方自己换一条路径（当前唯一消费者：ui/messages/jump.ts 的「回到底部」）。
 *
 * 取不到能力位（老引擎没有 matchMedia）时返回 false = 允许动效：与「媒体查询缺省不
 * 匹配」同向。这里**刻意不**保守地返回 true —— 那会让所有老引擎上的滚动都硬跳，
 * 而 reduce 的语义是「按用户要求」而不是「按我们的猜测」。
 */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * 按设备能力在「桌面文案 / 触摸文案」之间取词 —— **本仓唯一的分流点**。
 *
 * 为什么做成一个函数而不是让每个调用点自己写三元：本仓复盘 §1.4「同一个判定抄三遍
 * 必漏一处」。placeholder（inputbar）与空态引导（viewctx / messages/scroll）都要这
 * 条分流，抄三份必然有一天只改其中两份。这里一处决定，调用方只报「桌面 key + 触摸 key」。
 */
export function deviceCopy(desktopKey: Key, touchKey: Key): string {
  return t(isTouchInput() ? touchKey : desktopKey);
}

/**
 * 订阅「输入能力变化」（主指针粗细变化）。
 *
 * 为什么需要：占位符与空态文案若只在装配时算一次，能力位翻转后就永远是旧文案。
 * 真实触发场景：DevTools 设备仿真开关、二合一设备插拔鼠标（pointer 由 coarse 变
 * fine）。**不监听宽度** —— 文案只由能力决定（见文件头），窄窗变宽不改变「有没有
 * Shift 键」这个事实，重算也只会得到同一个值。
 *
 * 回调异常一律吞掉：文案是装饰，不许影响输入栏本身（与 sidebar 抽屉监听同纪律）。
 */
export function onInputCapabilityChange(cb: () => void): void {
  try {
    window.matchMedia(COARSE_POINTER_QUERY).addEventListener('change', () => {
      try {
        cb();
      } catch {
        /* 文案重画失败不影响输入 */
      }
    });
  } catch {
    /* 旧浏览器没有 addEventListener 版 MediaQueryList：文案保持装配时的值 */
  }
}
