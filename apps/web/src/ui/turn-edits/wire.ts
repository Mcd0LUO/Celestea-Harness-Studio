// ============================================================================
// ui/turn-edits/wire.ts — 「本轮编辑」卡片的**接线**（W9334）
// ----------------------------------------------------------------------------
// 接线只做四件事，判定全在 ./model.ts（纯函数）：
//   ① 记工具调用（`noteTurnToolCall`）与它的结果（`noteTurnToolResult`）—— 一次轮次
//      的账本，键是 tool_call_id（同一 id 的结果帧能回填到调用帧上）；
//   ② 轮次开始 ⇒ 清账本；
//   ③ 轮次结束 ⇒ **结算**：把账本变成一行行文件，挂一列到会话流尾部，然后让
//      **增强遍**（= 这个显示组件本体）把卡片画出来；
//   ④ 插件开关/配置变化 ⇒ 卡片随之消失或重画。
//
// ★ 为什么用 **busy 变化** 当轮次边界，而不是某个 SSE 帧：轮次结束在运行时是一个
//   已经存在的事实（`setPaneStreaming(ctx,false)`，所有终态 phase / 取消 / lagged
//   复核 / 新一轮顶掉旧轮都走它），而 front-end 侧的终态清单住在 chat.ts 里。
//   挂在事实上 ⇒ 不用 import 编排层（依赖方向：ui/* 不反向依赖 chat.ts），也自动
//   覆盖「异常终止」的每一种路径 —— 少一个漏渲染的分支。
//
// ★ 为什么结算时只调**一次** `runEnhancers`：增强缝的合同是「容器级、幂等、可重复」，
//   但它会对整个会话容器跑一遍链。轮次结束是**收敛点**（不是每个流式节拍），一轮一次
//   的量级与 W9229 收窄作用域要救的「每 12–50ms 扫全量」差两个数量级；卡片按需在
//   本地重画（折叠/展开）也不再走缝。这条取舍已写进报告。
// ============================================================================
import type { ToolPayload, ToolResultPayload } from '../../types';
import { CLIENT_PLUGINS_CHANGED } from '../../plugins/store';
import { isClientPluginOn } from '../../plugins/apply';
import { runEnhancers } from '../enhance';
import { autoscroll } from '../messages/scroll';
import { onBusyChange, paneOf, type SessionPane } from '../viewctx';
import { clearTurnEditsCards, createTurnEditsColumn, refreshTurnEditsCards, turnEditsStateOf } from './card';
import { editsOf, pathArgOf, shouldShowCard, TURN_EDITS_ID, type TurnCallFact } from './model';

/** 一轮的账本：插入顺序 = 调用发生顺序（Map 保证）。 */
interface Ledger {
  calls: Map<string, TurnCallFact>;
}

const ledgers = new WeakMap<SessionPane, Ledger>();

function ledgerOf(ctx: SessionPane): Ledger {
  let led = ledgers.get(ctx);
  if (led === undefined) {
    led = { calls: new Map() };
    ledgers.set(ctx, led);
  }
  return led;
}

/** 工具调用帧：记下身份、目标路径（`write_file` 才有）与「结果未知」。 */
export function noteTurnToolCall(ctx: SessionPane, p: ToolPayload): void {
  const name = String(p.name || 'tool');
  ledgerOf(ctx).calls.set(String(p.id), { name, path: pathArgOf(name, p.args), ok: null });
}

/**
 * 工具结果帧：回填成败。
 *
 * 只有**真的成功**才算改动了文件（失败 / 被拒 / 待批准的调用一个字节都没写）——
 * 这与工具卡的状态文案同一口径（deny / ask 都不是「做完」）。
 * 结果帧先到（重放 / 历史恢复）而没有调用帧 ⇒ 不记：宁可少一行，也不造一行。
 */
export function noteTurnToolResult(ctx: SessionPane, p: ToolResultPayload): void {
  const rec = ledgers.get(ctx)?.calls.get(String(p.id));
  if (rec === undefined) return;
  rec.ok = p.ok !== false && !p.error && p.decision !== 'deny' && p.decision !== 'ask';
}

/** 新一轮开始：清账本（上一轮若无从结算 —— 见 [settleTurnEdits] —— 也一并作废）。 */
export function resetTurnEdits(ctx: SessionPane): void {
  ledgers.delete(ctx);
}

/**
 * 轮次结束：结算这一轮。**结算即消费**（账本立刻清空）—— 否则同一次轮次的第二次
 * busy=false（远端轮询等）会再挂一张重复的卡。
 *
 * 三种情况**不挂卡**（都不是「少画了一个东西」，而是「没有东西可画」）：
 *   · 本轮没有任何工具调用（纯聊天轮）；
 *   · 插件被关掉（关掉就该整体不出现 —— 连空列也不留）；
 *   · 账本已经被结算过。
 */
export function settleTurnEdits(ctx: SessionPane): void {
  const led = ledgers.get(ctx);
  if (led === undefined) return;
  ledgers.delete(ctx);
  if (!shouldShowCard(led.calls.size)) return;
  if (!isClientPluginOn(TURN_EDITS_ID)) return;
  const { rows, hidden } = editsOf([...led.calls.values()]);
  ctx.el.appendChild(createTurnEditsColumn(rows, hidden));
  runEnhancers(ctx.el); // 卡片由显示组件本体（增强遍）画
  autoscroll(ctx); // 非强制：用户翻上去看历史时不被拉回来
}

/** 测试/诊断缝：该容器当前的账本快照（行 + 不可见调用数）。 */
export function turnEditsRowsOf(ctx: SessionPane): { rows: ReturnType<typeof editsOf>['rows']; hidden: number } {
  const led = ledgers.get(ctx);
  return editsOf(led === undefined ? [] : [...led.calls.values()]);
}

/** 已渲染卡片的状态快照（测试/诊断缝）。 */
export { turnEditsStateOf };

/** 插件开关/配置变化：关掉 ⇒ 已渲染的卡片整体不出现；打开或改了阈值 ⇒ 重画。 */
function onPluginsChanged(): void {
  if (isClientPluginOn(TURN_EDITS_ID)) refreshTurnEditsCards();
  else clearTurnEditsCards();
}

let installed = false;

/** 装配（幂等）：订阅运行态与插件变化。由 SSE 接线段在启动时调用一次。 */
export function initTurnEdits(): void {
  if (installed) return;
  installed = true;
  onBusyChange((id, busy) => {
    const ctx = paneOf(id);
    if (ctx === undefined) return;
    if (busy) resetTurnEdits(ctx);
    else settleTurnEdits(ctx);
  });
  window.addEventListener(CLIENT_PLUGINS_CHANGED, onPluginsChanged);
}
