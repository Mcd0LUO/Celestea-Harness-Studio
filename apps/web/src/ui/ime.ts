// ============================================================================
// ui/ime.ts — W2033：这一次按键**是不是给输入法的**（IME 组合判据的唯一真源）
// ----------------------------------------------------------------------------
// 缺陷（真机实测，桌面 1440x900 + Input.imeSetComposition；逐框原始数据见报告）：
//   多个自由文本输入框的 Enter 处理器**没有 IME 守卫** ⇒ 中文/日文用户按 Enter
//   **确认候选词**时，那一次 Enter 同时被当成「提交 / 导航 / 关闭」：
//     · 逐字确认框   → 直接确认（不可逆）
//     · 目录地址栏   → 导航到半截路径
//     · 新建会话标题 → 真发 POST /api/sessions
//     · URL 框       → 导航到半截 URL
//     · 自定义推理档位 → 收框并新增一枚档位片
//   候选词还没上屏，用户的意图只是「选这个字」。
//
// 为什么抽成模块而不是各写一行：本仓复盘 §1.4 的教训是「同一个判定抄三遍必漏一处」，
//   而这一条判定有**两半**（isComposing + keyCode 229）——散在 5 个文件里就是 5 次
//   漏掉第二半的机会。共享的是**判据**，不是动作：守卫命中之后每个框该做什么
//   （return / preventDefault / 让浏览器处理）仍由各框自己决定，见下方 isImeKey 的注释。
//
// 为什么不是「只看 isComposing 就够」（读标准后的结论，不是抄别人的）：
//   MDN KeyboardEvent.isComposing：true = 事件发生在 compositionstart 之后、
//   compositionend 之前。**但** compositionend 可能**先于**那次 keydown 触发 ——
//   MDN 的 keydown 文档原文：compositionend may fire before keydown when typing the
//   last character that closes the IME；此时 isComposing 为 false，而 keyCode 仍是 229。
//   MDN 给出的建议判据就是两个一起查：
//       if (event.isComposing || event.keyCode === 229) return;
//   229 = 「这次按键已被输入法处理」的哨兵值。keyCode 虽已 deprecated，但它在这里是
//   isComposing 的**唯一补集**（覆盖 compositionend 早到的那一次），故两个都查。
//
// ★ 这条判据**只该被「确认」类按键（Enter 等）的处理器查询**：组合会话里它对任何按键
//   都返回 true。本仓 5 个调用点都在自己的 Enter 分支里问它 ⇒ 非 Enter 键行为逐字不变。
// ============================================================================

/** 本判据读的事件字段（KeyboardEvent 的结构子集 ⇒ 纯函数可在 node 里直接断言）。 */
export interface ImeKeyLike {
  isComposing?: boolean | undefined;
  /** deprecated，但见文件头：它是 isComposing 的唯一补集。 */
  keyCode?: number | undefined;
}

/** 「这次按键已被输入法消费」的 keyCode 哨兵（UI Events / MDN 同名常量）。 */
export const IME_PROCESSED_KEYCODE = 229;

/**
 * 这一次按键是不是**输入法组合的一部分**（= 用户在确认候选词 / 翻页 / 取消组合）。
 *
 * 真 ⇒ 调用方**不要**执行自己的动作。
 *
 * 要不要顺带 `preventDefault()`：**不要**。逐框真机实测（5 个框都是 <input>，
 * 浏览器对组合中的 Enter 本就没有任何默认动作）—— 每个框实测到的 defaultPrevented
 * 与「动作有没有发生」的原始数据见交付报告；守卫只需 `return`，把这次按键整个让给
 * 输入法。（对照：主输入框是 <textarea>，那里组合中的 Enter **会**被浏览器插入换行，
 * 所以 W2028 在触摸端显式把它判成 'native' —— 那是另一个框的结论，不是本判据的。）
 */
export function isImeKey(e: ImeKeyLike): boolean {
  return e.isComposing === true || e.keyCode === IME_PROCESSED_KEYCODE;
}
