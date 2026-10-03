// ============================================================================
// ui/messages/scroll.ts — 滚动与空态提示（W759 从 ui/messages.ts 拆出）
//   autoscroll()      粘性自动滚动（按会话容器）
//   hideEmptyHint()   隐藏空地提示
//   renderEmptyHint() 重建空地提示（容器级）
//   纯搬家：行为 / 文案 / DOM 结构逐字不变。
//
// W1467：跟随判定改为**粘滞闩锁**（见 [autoscroll]）—— 修「页面不跟随模型输出」。
// ============================================================================
import { el } from '../../utils/dom';
import type { SessionPane } from '../viewctx';
import { deviceCopy } from '../viewport'; // W2023：设备能力分流（唯一真源）

/** W12：距底阈值（NN/G：只在真正接近底部时跟随，避免把读者拉回）。 */
export const AT_BOTTOM_PX = 25;

/**
 * W1467：我们**最后一次**写进容器的 scrollTop。用来把「我们自己贴底」与
 * 「用户主动往上滚」分开：内容长高不会改 scrollTop，用户往上滚才会把它改小。
 * 因此 scrollTop >= written - 阈值 ⇒ 这一帧不是用户在往上滚。
 */
const writtenTop = new WeakMap<SessionPane, number>();
/** 已装过滚动监听的容器（懒装一次；随容器一起被 GC）。 */
const watched = new WeakSet<SessionPane>();

/** 现在是否贴底（经典 W12 判据；只在明确的边界上求值）。 */
function nearBottom(ctx: SessionPane): boolean {
  return ctx.el.scrollTop + ctx.el.clientHeight >= ctx.el.scrollHeight - AT_BOTTOM_PX;
}

/**
 * W1467：滚动事件 → 重新判定闩锁。三条分支（顺序即优先级）：
 *   ① 真的贴底 → 上锁（用户滚回底部，恢复跟随）；
 *   ② 没贴底，但 scrollTop 仍在我们写入的位置附近 → **不动闩锁**。这是修 bug
 *      的关键：贴底写入之后内容又长高，这一帧几何上「不贴底」但用户根本没滚；
 *      此时若重新判定就会永久解锁（真机实测 gap 停在 88/102px 直到轮次结束）。
 *   ③ 其余（scrollTop 明显小于我们写入的位置）→ 用户往上滚了，解锁。
 */
function onPaneScroll(ctx: SessionPane): void {
  if (ctx.el.hidden) return;
  if (nearBottom(ctx)) {
    ctx.stickBottom = true;
    writtenTop.set(ctx, ctx.el.scrollTop);
    return;
  }
  const at = writtenTop.get(ctx);
  if (at !== undefined && ctx.el.scrollTop >= at - AT_BOTTOM_PX) return;
  ctx.stickBottom = false;
}

/** 懒装滚动监听（被动，不阻断滚动；每个容器一次）。 */
function watch(ctx: SessionPane): void {
  if (watched.has(ctx)) return;
  watched.add(ctx);
  ctx.el.addEventListener('scroll', () => onPaneScroll(ctx), { passive: true });
}

/**
 * 粘性自动滚动：仅在用户接近底部时跟随；force 用于完成/新消息时。
 * W514：只作用于该会话自己的容器；后台（隐藏）容器不写布局——只记录
 * 「期望贴底」，切回时由 viewctx 恢复滚动位。
 *
 * W1467（修 bug）：**判定与执行分离**。
 *   · 判定（上锁/解锁）只发生在明确的边界：force=true、或用户在容器里滚动
 *     （[onPaneScroll]）；
 *   · 执行（写 scrollTop）发生在每个流式增量：闩锁为真就直接贴底，
 *     **不再逐帧重新判定几何**。
 *
 * 旧实现每一帧都算 scrollTop + clientHeight >= scrollHeight - 25。流式过程中一次
 * 渲染（一整块 markdown / 一张工具卡 / 一段思考）就能把 scrollHeight 顶高远超
 * 25px，于是那一帧判定为假 → 从此再也不跟随（真机 CDP 实测：第一次 +mcol 让
 * scrollHeight 7932→8020，gap 停在 88px，其后 242/495 帧都不贴底，直到轮次结束）。
 * 闩锁把「用户想不想跟随」与「这一帧长高了多少」解耦。
 *
 * 用户往上滚仍会立刻解锁（[onPaneScroll] ③），W12 的意图保持不变。
 */
export function autoscroll(ctx: SessionPane, force = false): void {
  if (ctx.el.hidden) {
    if (force) ctx.stickBottom = true;
    return;
  }
  watch(ctx);
  if (force) ctx.stickBottom = true;
  else if (!ctx.stickBottom) return;
  ctx.el.scrollTop = ctx.el.scrollHeight;
  writtenTop.set(ctx, ctx.el.scrollTop); // 读回浏览器钳制后的真实值
}

/** 已排「本帧贴底」的容器（每帧至多写一次；随容器一起被 GC）。 */
const pendingFrame = new WeakSet<SessionPane>();

/**
 * W9300/F3-1：**帧内合并**的贴底（流式每节拍调用）。
 *
 * 为什么需要它（真机 Chrome 154 + CDP 实测，见 results/audit3-r2/F3/）：
 *   `autoscroll()` 每节拍写一次 `scrollTop = scrollHeight`。**任何**形式的滚动写
 *   都要求浏览器先算好几何（读 scrollHeight 6.8ms / 只写 scrollTop 6.9ms /
 *   读后写 7.2ms，600 列时同一量级）—— 所以 "不读 scrollHeight" **并不能**省下布局，
 *   真正的杠杆是**少写几次**。实测一次 200 帧突发：600 列下 `scrollHeight` 被读 136 次、
 *   `scrollTop` 被写 81 次 ⇒ 217 次强制布局，其中绝大多数发生在**同一帧内**。
 *
 * 合并成「一帧一次」把每帧的布局次数从 O(本帧节拍数) 降到 1，长会话下这是数量级差异
 * （第 2 节的 frames 数与 600 列布局耗时同阶增长）。
 *
 * 语义与 [autoscroll] 完全一致，只是**推迟到本帧末**：闩锁判定仍同步（stickBottom
 * 由 autoscroll 的前两步决定），只有最后那次布局写入是异步的。因此：
 *   · 不 force 时：闩锁为假 → 什么都不排（与改动前一致）；
 *   · 本帧已排过 → 重复调用是幂等的（不再排第二次）；
 *   · 用户在本帧内往上滚 → 回调里闩锁已为假，直接跳过（不会把读者拽回，W12）。
 *
 * 用 rAF 而不是 setTimeout：合并窗口就是**一帧**（与 W1524 的渲染节拍同相），且
 * rAF 回调在浏览器完成布局之后才跑 —— 那一次布局正是我们本来要付的，只是
 * 从「本帧第 1..N 次」压缩成「第 1 次」。
 */
export function autoscrollSoon(ctx: SessionPane): void {
  if (ctx.el.hidden) return; // 隐藏容器不写布局（与 autoscroll 的隐藏分支一致）
  if (!ctx.stickBottom) return; // 闩锁为假：本节拍没有跟随意图
  if (pendingFrame.has(ctx)) return; // 本帧已排过一次
  pendingFrame.add(ctx);
  requestAnimationFrame(() => {
    pendingFrame.delete(ctx);
    // 闩锁可能在本帧内被用户滚动清掉（onPaneScroll ③）—— 此时不得贴底。
    autoscroll(ctx);
  });
}

export function hideEmptyHint(ctx: SessionPane): void {
  ctx.hint.classList.add('hidden');
}

/** Rebuild the empty state exactly as it shipped in index.html（容器级）。 */
export function renderEmptyHint(ctx: SessionPane): void {
  ctx.el.replaceChildren();
  const hint = el('div', 'empty-hint empty-hint-fresh');
  hint.appendChild(el('div', 'empty-mark', '◇'));
  hint.appendChild(el('div', 'empty-title', 'Celestea Studio'));
  hint.appendChild(
    // W2023：与 viewctx.buildEmptyHint 同一分流点（触摸设备没有 Shift 键）。
    el('div', 'empty-sub', deviceCopy('chat.empty.hint', 'chat.empty.hintTouch')),
  );
  ctx.el.appendChild(hint);
  ctx.hint = hint;
}
