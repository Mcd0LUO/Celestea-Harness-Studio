// ============================================================================
// ui/inputbar/grow.ts — 输入框自增长的**能力开关**（W2016）
// ----------------------------------------------------------------------------
// 输入框的高度原先只有一条路：每次 input 事件里 JS 量高 ——
//   `input.style.height = 'auto'` → 读 `input.scrollHeight` → 写
//   `Math.min(scrollHeight, MAX_HEIGHT) + 'px'`。
// 那次「写 → 读」是**读写交替的强制同步布局**（与 ui/messages/frame-budget.ts
// 头注点名的同一类代价）。W2008 实测：`field-sizing: content` 能让 textarea 自己
// 长高，所以这条路可以只在**支持的引擎**上关掉。
//
// ★ 为什么这里必须探测，而不是直接把 JS 删掉 —— 与 interpolate-size 相反：
//   · interpolate-size 给的是**增强**（要不要补间）：不支持的引擎整条声明被忽略，
//     `max-height: max-content` 本身就是安全降级 ⇒ **绝不能加 @supports 守卫**
//     （FF 155 / WebKit 26.6 下加守卫会让 max-height 停在 0、内容永久不可见，
//     W2008/W2010 真机实测）。
//   · field-sizing 给的是**能力**（textarea 自增长）：不支持的引擎**静默忽略**，
//     textarea 保持 CSS 里的高度、内容被裁 ⇒ **必须保留 JS 回落**。
//   一句话：增强 ⇒ 别守卫（CSS 自己就是回落）；能力 ⇒ 要守卫（否则没有回落可用）。
//   本仓对这条规则的明文记录在 styles/provider-edit.css 顶部（W2010 写的），先读它。
//   样式侧的同一条守卫在 styles/field-sizing.css（本文件与它必须成对存在：
//   只有 CSS 没有本文件 ⇒ 不支持的引擎不再自增长；只有本文件没有 CSS ⇒ 支持的
//   引擎把量高省了却没人给高度）。
//
// 探针写成**可注入的纯函数**：jsdom 的 `CSS.supports` 对任何特性都返回 true
// （实测 field-sizing / interpolate-size 都是 true），所以「在 jsdom 里断言探测
// 结果」是空转的；把**判定**与**DOM 副作用**分开，才能用注入的 supports 把两条
// 分支都钉死。真机数字见 results/W2016-field-sizing.md。
// ============================================================================

/** 自增长上限（px）。与 styles/field-sizing.css 的 max-height 是**同一个值**（真机实测口径）。 */
export const MAX_HEIGHT = 240;

/** 自增长回调（调用点唯一需要绑定的东西）。 */
export type GrowFn = () => void;

export interface GrowHost {
  /** 自增长上限（px）—— 调用点各自传入，避免这里硬编码第二份。 */
  maxHeight: number;
  /** 能力探针；默认 supportsFieldSizing（真源是浏览器的 CSS.supports）。 */
  supports?: () => boolean;
}

/**
 * 能力探针：`CSS.supports('field-sizing', 'content')`。
 * 任何异常（老引擎没有 CSS.supports、API 被裁）一律判「不支持」——失败方向必须是
 * **绑定 JS 回落**（多一次量高），绝不能是「以为支持、其实没有」：那会让输入框不再
 * 自增长、内容被裁，是丢字级事故。
 */
export function supportsFieldSizing(): boolean {
  try {
    return typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
      && CSS.supports('field-sizing', 'content');
  } catch {
    return false;
  }
}

/**
 * 造一个「必要时量高」的回调：
 *   · 支持 `field-sizing: content` ⇒ 返回 **no-op**：高度完全由 CSS 给（
 *     styles/field-sizing.css），输入事件上不再有任何样式读写；
 *   · 不支持 ⇒ 返回**原来的量高实现**（逐字保留）—— FF 155 / WebKit 26.6 走的还是它。
 * 调用点因此不需要知道探测结果，也就不会有「探测了、但某条路径忘了跟着走」的分叉
 * （本仓 #input 有 4 个高度写点，分叉一次就是一处静默回归）。
 */
export function createAutoGrow(input: HTMLTextAreaElement, o: GrowHost): GrowFn {
  const supports = o.supports ?? supportsFieldSizing;
  if (supports()) return () => {};
  return () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, o.maxHeight) + 'px';
  };
}
