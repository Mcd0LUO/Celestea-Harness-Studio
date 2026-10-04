// ============================================================================
// ui/messages/jump.ts — W9336：「回到底部」浮标（会话流右下角的圆形按钮）
// ----------------------------------------------------------------------------
// 规格逐条落成**可判定的后果**：
//   ① 向上滚离底部超过 [JUMP_SHOW_PX] ⇒ 出现；滚回「贴底带」（[AT_BOTTOM_PX]）内 ⇒ 消失。
//      两个阈值不是同一个数：出现要「明显离开底部」，消失要「真的回到贴底」——
//      单阈值会在临界点上闪，且与 scroll.ts 的贴底口径对不上。
//   ② 点击 = 平滑滚到底；`prefers-reduced-motion: reduce` 下**直接跳**（不跑任何逐帧动画）。
//   ③ 浮标上的数字 = **它出现之后**新增的消息数；为 0 时不显示数字（只留箭头）。
//   ④ 键盘可达：它就是一个原生 `<button>` ⇒ Tab 能聚焦、Enter / Space 由浏览器翻成 click；
//      焦点环见 styles/jump.css 的 `:focus-visible`。
//   ⑤ 中英双语走既有 i18n（`chat.jump.label` / `chat.jump.new`，zh/en 各两条）。
//   ⑥ **不改既有滚动语义**：贴底跟随仍由 ui/messages/scroll.ts 的闩锁负责；本模块只在
//      「用户明确点了回到底部」时才写滚动位 —— 用户主动上滚依旧不会被拽回（W12）。
//
// 为什么自己写逐帧动画、不用 `scrollTo({ behavior: 'smooth' })`：
//   原生平滑滚动的落点在**调用那一刻**就定死了（当时的 scrollHeight）。而本仓的主场景
//   恰恰是「模型还在流式输出」—— 动画跑完时底部往往又长高了上百像素，于是落点仍不贴底、
//   闩锁不上锁，用户得再点一次。本实现每帧都以**当前**底部为目标
//   （gap = scrollHeight − clientHeight − scrollTop），内容继续长高也追得上；最后一帧
//   交给 [autoscroll] 的 force 分支收口（贴底 + 上锁，与既有路径同一处写入口）。
//   代价如实记账：缓动曲线是本仓自己的（easeOutCubic / [JUMP_SMOOTH_MS]），不是平台曲线。
//
// 为什么状态按**容器**存（WeakMap<SessionPane, …>）而不是模块单例：
//   多会话（W514）下每个 .sess-pane 各有自己的滚动位。切走再切回时，浮标必须记得
//   「这个容器上滚过、基线是多少」，否则切回来数字会从 0 重新数（用户看到的「新消息」
//   会凭空少掉）。DOM 只有一份（挂在 #messages 里，与 .chatcol-resizer 同一手法），
//   它只是**当前激活容器**的镜子。
//
// 数字的口径：消息 = 容器**直接子节点**里的 `.mcol`（本仓「一条消息 = 一列」，与
//   ui/messages/dom-cap.ts 的裁剪口径同源；嵌套在 run_code 子调用树里的 .mcol 不算）。
//   刻意用「当前总数 − 出现时的基线」而不是数 MutationObserver 的 addedNodes：思考段会
//   **就地重排**（insertBefore 搬动同一个节点），那在观察器里是「一删一加」，会把一条
//   老内容数成新消息。观察器在这里只当「内容变了，重算一次」的触发器用（见 [queueSync]）。
//
// 为什么文案在**画出时**取 t()、不订阅 onLocaleChange：本仓的语言切换是**整页重载**
//   （i18n/settings.ts 的方案 A，理由写在那里），重载后一切从 localStorage 重新渲染 ⇒
//   订阅只会是第二份真源。
//
// ★ 为什么隐藏用全局 `.hidden` 而不是自己写 `display:none`：base.css 的那条带
//   `!important`，本模块不需要第二个真源；它同时把按钮**摘出 Tab 序**——看不见的控件
//   不该被键盘 Tab 到（WCAG 2.4.3 的应有之义）。
// ============================================================================
import { t } from '../../i18n';
import { iconSvg } from '../icons';
import { activePane, onPaneChange, type SessionPane } from '../viewctx';
import { prefersReducedMotion } from '../viewport';
import { AT_BOTTOM_PX, autoscroll } from './scroll';

/**
 * 出现阈值（px）：离开底部超过这么多，才算「用户上滚去看历史了」。
 * 取 8 × AT_BOTTOM_PX（25 → 200）：与「贴底带」明确分离。轻轻碰一下滚轮（几十像素）
 * 不该弹出浮标 —— 那种幅度下用户仍在读最新一条。
 */
export const JUMP_SHOW_PX = 200;

/** 平滑滚动时长（ms）：够短（不让人等）又够长（眼睛跟得上）。 */
export const JUMP_SMOOTH_MS = 260;

/** 每个容器一份的浮标状态。 */
interface JumpState {
  /** 是否已「武装」（= 浮标当前可见，基线已取）。 */
  armed: boolean;
  /** 武装那一刻的消息数（显示的数字 = 当前总数 − 它）。 */
  base: number;
}

const states = new WeakMap<SessionPane, JumpState>();

/**
 * 动画代次：点第二次（或切走再点）时，旧回调看到代次变了就自行退出 ——
 * 两个动画同时写 scrollTop 会互相抵消成「卡在中间」。
 */
let runSeq = 0;

let btn: HTMLButtonElement | null = null;
let badge: HTMLElement | null = null;
/** 当前绑了滚动监听的容器（= 最后一次激活的那个）。 */
let bound: SessionPane | null = null;
let observer: MutationObserver | null = null;
/** 本帧是否已排过一次判定（内容变化的合并窗口，见 [queueSync]）。 */
let syncQueued = false;
let subscribed = false;
/** 上一次真正画上去的态（每次滚动都会同步一次；没变就不碰 DOM）。 */
let painted = { show: false, count: -1 };

function stateOf(pane: SessionPane): JumpState {
  let st = states.get(pane);
  if (st === undefined) {
    st = { armed: false, base: 0 };
    states.set(pane, st);
  }
  return st;
}

/** 距底像素（0 = 已贴底；内容不足一屏时也是 0）。 */
export function distanceFromBottom(el: HTMLElement): number {
  return Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);
}

/** 容器里的消息数 = 直接子节点中的 `.mcol`（见文件头「数字的口径」）。 */
export function messageCount(pane: SessionPane): number {
  const kids = pane.el.children;
  let n = 0;
  for (let i = 0; i < kids.length; i += 1) {
    if (kids[i]?.classList.contains('mcol') === true) n += 1;
  }
  return n;
}

/** easeOutCubic：起步快、收尾慢（滚动「滑过去」而不是匀速平移）。 */
function easeOutCubic(p: number): number {
  const q = 1 - p;
  return 1 - q * q * q;
}

/**
 * 判定 + 画面（**唯一写入口**）。判定只发生在明确的边界上：容器滚动、容器内容变化、
 * 切换容器、点击之后 —— 与 scroll.ts 的闩锁同一纪律（不逐帧重判几何）。
 */
function sync(): void {
  const pane = activePane();
  if (pane === null || btn === null) return;
  const st = stateOf(pane);
  const gap = distanceFromBottom(pane.el);
  if (st.armed) {
    if (gap <= AT_BOTTOM_PX) {
      st.armed = false; // 回到贴底带 ⇒ 收起，下次出现从新的基线重新数
      st.base = 0;
    } else {
      paint(true, Math.max(0, messageCount(pane) - st.base));
      return;
    }
  }
  if (!st.armed && gap > JUMP_SHOW_PX) {
    st.armed = true;
    st.base = messageCount(pane); // 基线：此刻已有的消息都不算「新增」
    paint(true, 0);
    return;
  }
  paint(false, 0);
}

/** 把态画上去（内容没变就直接返回 —— 滚动事件很密，别让每个事件都写 DOM）。 */
function paint(show: boolean, count: number): void {
  if (btn === null || badge === null) return;
  if (painted.show === show && painted.count === count) return;
  painted = { show, count };
  btn.classList.toggle('hidden', !show);
  badge.textContent = count > 0 ? String(count) : '';
  badge.classList.toggle('hidden', count === 0);
  // 可访问名带上条数（读屏用户不该只听到「回到底部」而漏掉有新消息这件事）；
  // 可见的数字本身是装饰（aria-hidden），避免读屏把同一个数念两遍。
  btn.setAttribute('aria-label', count > 0 ? t('chat.jump.new', { n: count }) : t('chat.jump.label'));
  btn.title = t('chat.jump.label');
}

function onScroll(): void {
  if (bound === null || bound !== activePane() || bound.el.hidden) return;
  sync(); // 滚动事件本身已由浏览器压到「一帧至多一次」⇒ 同步判定，浮标不迟一帧
}

/**
 * 内容变化 ⇒ **帧内合并**一次判定（W9204 的 queueSync 同一手法）。
 *
 * 为什么必须合并：观察器看的是 `subtree`（见 [bind]），流式一轮里每个渲染节拍都会
 * 产生成百条记录；逐条同步会变成「每帧 O(节拍数) 次强制布局」。合并之后最坏是
 * **一帧一次**几何读 —— 而那一帧的布局本来就要做（DOM 刚被改脏），不是净增。
 * 态没变时 [paint] 直接返回，稳态下这条路径是只读的。
 */
function queueSync(): void {
  if (syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(() => {
    syncQueued = false;
    sync();
  });
}

/**
 * 滚动监听随激活容器切换（scroll 不冒泡，只能绑在滚动元素上；沿用 rail.ts 的手法）。
 *
 * `subtree: true` 而不是只看直接子节点：离开底部的形态**不止**「多了一条消息」——
 * 展开一个 details、图片加载完、代码块高亮后行号撑高，都会让内容长高而 scrollTop 不动
 * （没有任何滚动事件可听）。少了子树这一层，那几种情况下浮标就不会出现。
 * 记账仍只数直接子节点里的 .mcol（见 [messageCount]），观察器只当触发器用。
 */
function bind(pane: SessionPane | null): void {
  if (bound !== pane) {
    if (bound !== null) bound.el.removeEventListener('scroll', onScroll);
    bound = pane;
    if (bound !== null) bound.el.addEventListener('scroll', onScroll, { passive: true });
  }
  if (typeof MutationObserver !== 'function') return; // 老引擎：数字只在滚动时刷新（降级即可）
  if (observer === null) observer = new MutationObserver(queueSync);
  observer.disconnect();
  if (pane !== null) observer.observe(pane.el, { childList: true, subtree: true });
}

function onPaneChanged(pane: SessionPane): void {
  bind(pane);
  sync();
}

/** 直接跳到底（reduced-motion 路径）：既有写入口一次到位，闩锁随之上锁。 */
function jumpNow(pane: SessionPane): void {
  autoscroll(pane, true);
  sync();
}

/**
 * 平滑滚到底：每帧以**当前**底部为目标重算落点（见文件头），最后一帧交给
 * [autoscroll] 收口。三条提前退出：代次被取代、容器切走/隐藏、用户中途自己往上滚。
 */
function glide(pane: SessionPane): void {
  const el = pane.el;
  const seq = (runSeq += 1);
  const t0 = performance.now();
  const from = el.scrollTop;
  let wrote = from;
  const frame = (): void => {
    if (seq !== runSeq) return; // 被更新的一次点击取代
    if (pane !== activePane() || el.hidden) return; // 切走了：滚动位留给那个容器自己
    // 用户中途往上滚了：把滚轮交还给他（与 W12「不把人拽回去」同一条纪律）。
    if (el.scrollTop < wrote - 8) return;
    const span = Math.max(1, el.scrollHeight - el.clientHeight - from);
    const p = Math.min(1, (performance.now() - t0) / JUMP_SMOOTH_MS);
    const top = Math.max(from, from + span * easeOutCubic(p));
    el.scrollTop = top;
    wrote = el.scrollTop; // 读回浏览器钳制后的真值
    if (p >= 1 || distanceFromBottom(el) <= 1) {
      autoscroll(pane, true); // 贴底 + 上闩锁：之后的新消息继续跟随（W12 语义不变）
      sync(); // 浮标随之收起
      return;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/**
 * 回到底部（浮标点击的唯一后果）。隐藏容器不写布局 —— 与 [autoscroll] 的隐藏分支同口径。
 */
export function toBottom(pane: SessionPane): void {
  if (pane.el.hidden) return;
  if (prefersReducedMotion()) jumpNow(pane);
  else glide(pane);
}

function onClick(): void {
  const pane = activePane();
  if (pane === null) return;
  toBottom(pane);
}

/**
 * 装配（幂等；main.ts 在 #messages 就位后调用一次）。
 * 宿主缺失不抛（与 initRail / initChatCol 同口径）：静态骨架缺一块不该让整页白屏。
 */
export function initJumpBottom(): void {
  const host = document.getElementById('messages');
  if (host === null) return;
  if (btn === null) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'jump-bottom hidden';
    // 图标几何真源在 ui/icons.ts（W9324）；朝下由 CSS 旋转，不另存一份 paths。
    b.innerHTML = iconSvg('chevron-fold', { className: 'jump-bottom-ico', size: 16 });
    const c = document.createElement('span');
    c.className = 'jump-bottom-count hidden';
    c.setAttribute('aria-hidden', 'true');
    b.appendChild(c);
    // Enter / Space 不需要自己接：原生 button 会把两者都翻成 click（要求 ④）。
    b.addEventListener('click', onClick);
    btn = b;
    badge = c;
  }
  if (btn.parentElement !== host) host.appendChild(btn);
  painted = { show: false, count: -1 }; // 强制重画一次（重装后不继承上一次的态）
  if (!subscribed) {
    subscribed = true;
    onPaneChange(onPaneChanged);
  }
  bind(activePane());
  sync();
}
