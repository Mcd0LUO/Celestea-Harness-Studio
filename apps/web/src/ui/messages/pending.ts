// ============================================================================
// ui/messages/pending.ts — W9333：会话内「等待反馈」占位（发送之后、首个 token 之前）
// ----------------------------------------------------------------------------
// 缺陷：发送之后、首个 token 之前，会话流里**什么都没有** —— 助手那一格是空的，
// 用户看不到任何东西（底部状态栏的耗时计时不在会话流里）。
//
// 行为规格来自 apps/web/prototype/thinking.html（联调定稿）。四条要点：
//   ① **就地占位**：占位块占据**助手那一格**（同一列 .mcol、同缩进、同宽度上限），
//      首个 token 到达时**原地接管**成流式正文 —— 复用同一个列节点，不插入再删除、不跳版；
//   ② **阶段如实**：不笼统说「思考中」。只有**真的收到 reasoning 增量**才说「思考中」
//      （对非推理模型说「思考中」是假话）；请求在飞说「发送中」；已接受无 token 说「等待响应」；
//   ③ **计时从按下发送起**，标签写明是「用时」—— 它不是进度条，不假装知道还剩多久；
//   ④ **无障碍**：阶段标签 role=status + aria-live=polite（只播报**阶段变化**）；
//      **秒数 aria-hidden** —— 否则读屏每秒念一次数字。
//
// 为什么状态机是**纯函数**（[reducePhase]）：阶段推进是本组件的核心后果，而
// 「jsdom 里判不了排版」的那部分（脉冲节律、就地替换的几何）按铁律 11 移到真机探针
// （scripts/a11y/w9333-pending-probe.mjs）。纯函数真值表 + 文案是否**真实已本地化**
// 是 jsdom 侧可判的那一半。
//
// 图标 = **脉冲星芒**（定稿）：三颗小星芒依次脉冲（三点脉冲的节律 × 星芒的形态）。
// 几何沿用原型（16 网格、4 角星、fill=currentColor）—— 与 ui/icons.ts 的 grant-shield
// 同属「16 网格 · 实心 · currentColor」那一类。**刻意不登记进 ICONS**：那张表的
// IconSpec 是「一个 viewBox + 一组共享描边的 paths」，表达不了「每颗星一个
// <g transform> 定位 + 每颗星各自的 CSS 动画类」；为它改 spec 会动 W9324 的冻结表
// 与它的测试，收益只是记账好看。取舍已写进报告。
// ============================================================================
import { el } from '../../utils/dom';
import type { Key } from '../../i18n';
import { t } from '../../i18n';
import type { SessionPane } from '../viewctx';
import { autoscroll, hideEmptyHint } from './scroll';

/** 占位的阶段（**如实**：每一档都对应一个可观测的运行时事实）。 */
export type PendPhase = 'delivering' | 'queued' | 'interjected' | 'awaiting' | 'thinking';

/**
 * 阶段推进事件。
 *   · `send`      —— 按下发送（本轮请求即将在飞）
 *   · `accepted`  —— 请求已被接受（HTTP 答复到达 / status:start 帧）
 *   · `reasoning` —— **真的**收到了非空 reasoning 增量
 * 首个 token 不走这里：它是 [takePendingCol]（把占位**就地**交给助手文本段）。
 */
export type PendEvent = 'send' | 'accepted' | 'reasoning';

/**
 * 阶段 → 文案 key（**唯一真源**）。「已排队 / 已插话」两条沿用既有 key ——
 * 同一件事在同一个界面上只有一个说法。
 */
export const PEND_PHASE_KEY: Record<PendPhase, Key> = {
  delivering: 'chat.send.delivering',
  queued: 'chat.send.queuedWaiting',
  interjected: 'chat.send.interjectedWaiting',
  awaiting: 'chat.pend.awaiting',
  thinking: 'chat.pend.thinking',
};

/** 当前阶段该显示哪句话（语言切换后跟着变）。 */
export function pendLabel(phase: PendPhase): string {
  return t(PEND_PHASE_KEY[phase]);
}

/**
 * 阶段推进真值表（纯函数）。
 *
 * ★ 本组件**最重要的一条不变量**：`'thinking'` 只能由 `reasoning` 到达 ——
 *   `send` / `accepted` 无论当前是什么阶段都不可能给出 `'thinking'`。
 *   变异负控制（把 accepted 改成无条件 thinking）会让这条断言变红。
 * ★ `cur === null` ⇒ **不凭空造占位**：`accepted` 只在已有占位时升级它。
 *   别人的轮次（排队消息到点开跑、另一个客户端发的）不该在我们这里长出占位。
 */
export function reducePhase(cur: PendPhase | null, ev: PendEvent): PendPhase | null {
  if (ev === 'send') return 'delivering';
  if (cur === null) return null;
  if (ev === 'reasoning') return 'thinking';
  // accepted：只把「还没被接受」的档位升到「等待响应」；已在等待/思考的一律不动
  // （思考中收到迟到的 accepted 帧不得退回「等待响应」—— 那是**倒退**）。
  return cur === 'delivering' ? 'awaiting' : cur;
}

/**
 * 脉冲星芒（三颗小星芒依次脉冲）。定位用 `<g transform>`，动效用 path 上的 CSS
 * `transform` —— path 的 transform-origin 默认就是 g 平移后的 (0,0) = 那颗星的中心，
 * 不需要 transform-box。每颗星各有自己的类（s1/s2/s3）以承载各自的 animation-delay。
 * 源码是常量字面量、无任何用户输入参与拼接，innerHTML 在这里没有注入面。
 */
export const PEND_ICON_SVG =
  '<svg class="pend-ico" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">' +
  '<g transform="translate(3 8)"><path class="pend-star s1" d="M0 -2.6 .73 -.73 2.6 0 .73 .73 0 2.6 -.73 .73 -2.6 0 -.73 -.73Z" fill="currentColor"></path></g>' +
  '<g transform="translate(8 8)"><path class="pend-star s2" d="M0 -2.6 .73 -.73 2.6 0 .73 .73 0 2.6 -.73 .73 -2.6 0 -.73 -.73Z" fill="currentColor"></path></g>' +
  '<g transform="translate(13 8)"><path class="pend-star s3" d="M0 -2.6 .73 -.73 2.6 0 .73 .73 0 2.6 -.73 .73 -2.6 0 -.73 -.73Z" fill="currentColor"></path></g>' +
  '</svg>';

/** 秒数刷新节拍（1s；标签本身只在阶段变化时改）。 */
export const PEND_TICK_MS = 1000;

/** 一个活着的占位（每个会话至多一个）。 */
interface PendView {
  phase: PendPhase;
  /** 计时起点 = **按下发送**的时刻（不是被接受的时刻）。 */
  t0: number;
  col: HTMLElement; // .mcol（助手那一格；接管时整个节点交给文本段）
  msg: HTMLElement; // .msg.assistant.pend
  label: HTMLElement; // 阶段标签（role=status + aria-live）
  secs: HTMLElement; // 秒数（aria-hidden）
  timer: number | null;
}

/** 活着的占位（容器为键；容器被淘汰/清空后随之 GC）。 */
const live = new WeakMap<SessionPane, PendView>();

/** 当前阶段显示的「用时 N 秒」文案（`Date.now()` 差，不用累计计数 —— 掉帧不漂移）。 */
function elapsedText(t0: number): string {
  return t('chat.pend.elapsed', { seconds: Math.max(0, Math.floor((Date.now() - t0) / 1000)) });
}

function stopTimer(v: PendView): void {
  if (v.timer !== null) {
    window.clearInterval(v.timer);
    v.timer = null;
  }
}

/**
 * 建一个占位块。DOM 形状（与助手列同构，故接管时零跳版）：
 *   .mcol > .msg.assistant.pend > [.pend-ico-box(svg)] [.pend-lab(role=status)] [.pend-secs(aria-hidden)]
 * 容器**不是** live region：阶段标签自己才是 —— 秒数在容器里，容器若也是 live region，
 * 秒数就会被播报（这正是要避免的那件事）。
 */
function buildPending(phase: PendPhase, t0: number): PendView {
  const col = el('div', 'mcol');
  const msg = el('div', 'msg assistant pend');
  const box = el('span', 'pend-ico-box');
  box.innerHTML = PEND_ICON_SVG; // 常量字面量，无注入面
  const label = el('span', 'pend-lab');
  label.setAttribute('role', 'status');
  label.setAttribute('aria-live', 'polite');
  const secs = el('span', 'pend-secs');
  secs.setAttribute('aria-hidden', 'true');
  msg.appendChild(box);
  msg.appendChild(label);
  msg.appendChild(secs);
  col.appendChild(msg);
  return { phase, t0, col, msg, label, secs, timer: null };
}

function paintLabel(v: PendView): void {
  v.label.textContent = pendLabel(v.phase);
  // 诊断/探针用：阶段同时写进 data-phase（断言仍读**文案**，不读这个属性）。
  v.msg.dataset.phase = v.phase;
}

function paintSecs(v: PendView): void {
  v.secs.textContent = elapsedText(v.t0);
}

function startTimer(v: PendView): void {
  stopTimer(v);
  v.timer = window.setInterval(() => paintSecs(v), PEND_TICK_MS);
}

/**
 * 显示占位（按下发送时调用）。`t0` 必须传**按下发送**的时刻 —— 调用方与它自己的
 * 计时器共用同一个数，界面上两个「用时」才不会各说各话。
 * 幂等：同一容器重复调用只留一个占位（旧的先收掉，含它的定时器）。
 */
export function showPending(ctx: SessionPane, phase: PendPhase = 'delivering', t0 = Date.now()): void {
  clearPending(ctx);
  hideEmptyHint(ctx);
  const v = buildPending(phase, t0);
  live.set(ctx, v);
  paintLabel(v);
  paintSecs(v);
  ctx.el.appendChild(v.col);
  startTimer(v);
  autoscroll(ctx, true);
}

/** 该容器当前的占位列（没有则 null）—— 思考段的重排锚点要用它。 */
export function pendingColOf(ctx: SessionPane): HTMLElement | null {
  return live.get(ctx)?.col ?? null;
}

/**
 * 推进阶段（`accepted` / `reasoning` 到达时调用）。没有占位 ⇒ 什么都不做
 * （见 [reducePhase]：不凭空造占位）。阶段**没变**时一个字符都不改 ——
 * role=status 只播报阶段变化，重复写同一句话会让读屏反复念。
 */
export function advancePending(ctx: SessionPane, ev: PendEvent): void {
  const v = live.get(ctx);
  if (!v) return;
  const next = reducePhase(v.phase, ev);
  if (next === null || next === v.phase) return; // null 不可能（v.phase 非空），仅为类型收窄
  v.phase = next;
  paintLabel(v);
}

/** 收掉占位（轮次结束/失败/清空会话时调用）：停表 + 摘节点。 */
export function clearPending(ctx: SessionPane): void {
  const v = live.get(ctx);
  if (!v) return;
  stopTimer(v);
  live.delete(ctx);
  v.col.remove();
}

/**
 * **首个 token 到达**：把占位**就地**交给助手文本段 —— 返回可复用的列节点。
 *
 * 两条路径（都保「事件顺序优先于原位」）：
 *   · 占位仍是容器最后一个元素 ⇒ **复用它的列节点**（同一节点、同一位置 ⇒ 不跳版、
 *     不插入再删除；调用方只需清空它的内容再挂正文）；
 *   · 期间有更早发生的事件（思考段 / 工具卡 / 信息块）排到了它后面 ⇒ 原位已不是
 *     正文该在的地方，摘掉占位并返回 null（调用方新建列、追加到末尾）——
 *     正文落在那些事件**之后**，与「一轮 = 按事件真实时间顺序渲染」一致。
 */
export function takePendingCol(ctx: SessionPane): HTMLElement | null {
  const v = live.get(ctx);
  if (!v) return null;
  stopTimer(v);
  live.delete(ctx);
  const col = v.col;
  if (col.parentElement !== ctx.el || col.nextElementSibling !== null) {
    col.remove();
    return null;
  }
  return col;
}

/** 测试/诊断：该容器是否还有活着的占位。 */
export function hasPending(ctx: SessionPane): boolean {
  return live.has(ctx);
}
