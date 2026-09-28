// ============================================================================
// ui/workbench/link-open.ts — W2057：点正文外链 ⇒ 工作台浏览器面板。
// ----------------------------------------------------------------------------
// 用户原话：「打开网页链接应该自动打开我们提供的浏览器而非新建页面。」
//
// 本模块是**事件侧**：一个挂在 document 上的 click 委托，命中「该由面板接的
// 外链」（判定唯一真源 utils/link-target.ts 的 linkOpensInPanel）时
// preventDefault + 打开面板。打开动作在 open-url.ts（本模块只管「什么时候」）。
//
// ★★ 设计决策（三问，报告 §3 有完整论证）：
//
// ① **保留 target=_blank + 拦截**（不是「去掉 target + 拦截」）。
//    理由：键盘用户按 Enter 时浏览器会派发一条**可取消的** click（实测
//    isTrusted=true / cancelable），所以拦截对键盘同样生效 —— 这一点两种方案
//    没差别。差别在**兜底**：本模块若因为任何原因没装上（脚本错误、插件被关、
//    未来有人改了装配顺序），留着 target 的行为是「新标签页」（W2051 的既有
//    契约，可用），去掉 target 的行为是「当前页被导航走、丢掉会话视图」（W2051
//    修掉的那个原始缺陷）。**降级路径必须是安全的那一个**，所以保留。
//
// ② **Ctrl/Cmd/Shift/Alt + 左键、以及中键 ⇒ 不进面板**（交给浏览器新标签页）。
//    理由：这些修饰键的**语义就是「我知道我要什么，别替我决定」** —— Ctrl+Click
//    与中键在全世界所有浏览器里都是「后台新标签页」。实测本仓当前行为：
//    Ctrl+Click 与中键各产生一个 page target（opener=false，即浏览器自己开的
//    后台标签），**当前页不导航**。用户点名要改的是「点链接不要新建页面」这件
//    默认事，不是把用户的显式意图也一起改写。抢掉它们 = 把「我要新标签页」
//    变成「我要面板」，那是**能力缩减**，不是修缺陷。
//
// ③ **只拦左键 + 无修饰键**（e.button === 0 且四个修饰键全 false）。
//    中键在 Chrome 上**不派发 click**（实测 click 事件数 0），所以「中键不进
//    面板」是**浏览器白送的**、不需要我们判断；但本模块仍显式检查 button，
//    因为「靠上游恰好不发事件」不是契约 —— 见守卫 ③ 的注释。
//
// ★ 无障碍：<a href> 原生可 Tab、Enter 触发**默认动作**。本模块
//   · **不碰 keydown**（所以不存在破坏 Enter 的可能，也没有 IME 问题）；
//   · 只在 click 上 preventDefault，而 Enter 触发的正是这条 click
//     （实测 isTrusted=true、defaultPrevented 在捕获期为 false ⇒ 可取消）。
//   ⇒ 键盘路径与鼠标路径走**同一个出口**，口径不可能分叉。
//
// ★ 幂等：装配在 installWorkbench() 里做一次（与其它 workbench 装配同一时机），
//   标记打在 document 上（照 file-link.ts 的 dataset 范例），重复调用不重复挂。
//
// ★ 为什么不复用 ui/enhance/file-link.ts 的那个 body 级委托：
//   那个委托明确**放行**锚点（file-link.ts:129「锚点一律交给浏览器」），
//   它的职责是「文件路径」不是「外链」。两件事的作用域与出口都不同，
//   合在一起会让「路径判定」与「外链判定」互相纠缠（复盘 §1.4：同一判定抄三遍必漏）。
// ============================================================================
import { linkOpensInPanel } from '../../utils/link-target';
import { openUrlInPanel } from './open-url';

/** 装配标记（打在 document 上：全局只挂一次）。 */
const DONE = 'linkOpenDone';

/** 事件目标 → Element（nodeType 判定：跨文档/跨 window 也成立）。 */
function isElement(node: EventTarget | null): node is Element {
  return node !== null && (node as Node).nodeType === 1;
}

/**
 * 该 href 是否该由面板接走。**唯一真源**是 utils/link-target.ts —— 本模块
 * 不复制任何一条 scheme 判定（否则「什么算外链」会有第二个答案）。
 */
export function shouldOpenInPanel(href: string | null): boolean {
  return href !== null && linkOpensInPanel(href);
}

/**
 * 修饰键语义：有**任何**一个修饰键按下 ⇒ 交给浏览器（见文件头 ②）。
 *
 * `metaKey` 一起算进来是 macOS 的 Cmd（macOS 用 Cmd 而不是 Ctrl 开新标签）。
 */
function modified(e: MouseEvent): boolean {
  return e.ctrlKey || e.metaKey || e.shiftKey || e.altKey;
}

/** click 委托：命中 ⇒ 面板；否则**完全不碰**（放行给浏览器/其它委托）。 */
function onClick(ev: MouseEvent): void {
  // 守卫 ①：只认主键。中键在 Chrome 上不派 click（实测），但「上游恰好不发」
  // 不是契约 —— 显式写出来，换浏览器/换版本也不会把中键吞进面板。
  if (ev.button !== 0) return;
  // 守卫 ②：修饰键 ⇒ 用户的显式意图是新标签页（见文件头 ②）。
  if (modified(ev)) return;
  const target = ev.target;
  if (!isElement(target)) return;
  // 守卫 ③：命中最近的可导航锚点。用 closest 而不是「目标自己是 <a>」：
  // 锚点里可能有 <code>/<strong>（markdown 的 [`x`](url)），点在子元素上时
  // 目标不是 <a> 本身。
  const a = target.closest('a[href]');
  if (a === null) return;
  if (!shouldOpenInPanel(a.getAttribute('href'))) return;
  // 唯一一次改写默认行为：拦掉「新标签页」，改开面板。
  ev.preventDefault();
  openUrlInPanel(a.getAttribute('href') ?? '');
}

/** 装配（幂等）。installWorkbench() 调用一次。 */
export function installLinkOpen(): void {
  const doc = document;
  if ((doc as unknown as { [k: string]: unknown })[DONE] === true) return;
  (doc as unknown as { [k: string]: unknown })[DONE] = true;
  // 捕获期（capture: true）：比任何冒泡期的 click 委托都先跑，且 preventDefault
  // 对**后续**监听与浏览器默认动作同样有效 —— 于是面板先于其它副作用打开。
  doc.addEventListener('click', onClick, true);
}