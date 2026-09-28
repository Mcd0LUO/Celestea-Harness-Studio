// ============================================================================
// ui/inputbar/newline.ts — W2028：Enter 在**这台设备上**该干什么（唯一判定点）
// ----------------------------------------------------------------------------
// 缺陷：inputbar 的 keydown 曾把**所有**不带 shiftKey 的 Enter preventDefault 掉改走
// 发送，而软键盘 Enter 的 shiftKey 恒为 false（触摸设备没有 Shift 键）⇒ 触摸端用户
// **根本插不进换行**（真机复现见报告 §复核）。
//
// 修法（照微信 / iMessage）：触摸端 Enter = 换行，发送只走 #btnSend（它恒在输入栏的
// 可见位置，见 layout.css 的 #btnSend 槽位）；桌面端**逐字不变**（Enter 发送 /
// Shift+Enter 换行 / Ctrl-Cmd+Enter 切车道）。
//
// 为什么单独成模块：① inputbar.ts 已 437 行（门禁 450，见 apps/web/tools/check-module-size.mjs）；
// ② 判定是纯函数、插入是 DOM 操作，两者都能直接单测（tests/w2028-touch-newline-dom.test.ts）。
//
// ★ 与 ui/viewport.ts 的分工：那里回答「这台设备有没有物理 Shift 键」（isTouchInput），
//   这里回答「那么 Enter 该干什么」。判据取 isTouchInput 而**不是** isMobileViewport ——
//   窄桌面窗口有 Shift 键、平板横屏没有（W2023 已论证）。
// ============================================================================
import { interceptKey as interceptCommandKey } from '../commands';
import { isTouchInput, onInputCapabilityChange } from '../viewport';

/** 提交车道（与 ui/inputbar.ts 的 SubmitMode 同形；刻意不 import，避免模块环）。 */
export type EnterLane = 'steer' | 'queue';

/** 一次 Enter 键该干什么。 */
export type EnterAction =
  | 'native' // 不动：让浏览器默认行为插入换行（桌面 Shift+Enter）
  | 'newline' // 自己插入换行（触摸端：软键盘多半不发带换行的 char 事件，默认行为不可靠）
  | 'send-current' // 发送到当前车道
  | 'send-other'; // 发送到另一条车道（Ctrl/Cmd+Enter）

/** enterAction 读的字段（KeyboardEvent 的结构子集，便于纯函数单测）。 */
export interface EnterKeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  /** IME 组合中（见 enterAction 的第一条分支）。 */
  isComposing?: boolean;
}

/**
 * Enter 的**唯一**决策点（纯函数）。
 *
 * 桌面（touch=false）与改动前逐字相同：Shift ⇒ native；否则发送，带 Ctrl/Cmd ⇒ 另一车道。
 * 触摸（touch=true）：裸 Enter ⇒ newline；Shift+Enter 仍 native（外接键盘的既有习惯）；
 * Ctrl/Cmd+Enter ⇒ 另一车道 —— 没有 Shift 的键盘按得出 Ctrl，这条不变量保证**任何设备
 * 都至少有一条键盘发送路径**（触摸端 #btnSend 一旦被浮层遮住，键盘仍能发）。
 * IME 组合中的 Enter（触摸端）⇒ native，交回浏览器（见下方守卫）。
 * 非 Enter 键一律 native（本函数只管 Enter）。
 */
export function enterAction(e: EnterKeyLike, touch: boolean): EnterAction {
  if (e.key !== 'Enter') return 'native';
  // 触摸端 + IME 组合中：这次按键是给输入法的（确认候选词）。真机实测（Chromium +
  // Input.imeSetComposition）浏览器自己就会插入一个换行（keydown 未被 preventDefault）
  // ⇒ 我们再插一个，用户每确认一次候选词就多一个空行。中文/日文输入法在手机上极常用，
  // 故触摸端把这次按键整个让给浏览器。
  //
  // ★ 这条守卫**只对触摸端**生效：桌面必须逐字不变 —— 改动前桌面组合中的 Enter 同样走
  //   发送，那是既有的、与本轮无关的行为（要改是另一个工单，且要先有真机 IME 证据）。
  if (touch && e.isComposing === true) return 'native';
  if (e.shiftKey) return 'native';
  const other = e.ctrlKey || e.metaKey;
  if (!touch) return other ? 'send-other' : 'send-current';
  return other ? 'send-other' : 'newline';
}

/**
 * `enterkeyhint` 的值 —— 软键盘的回车键上**显示什么**。
 *
 * 必须与 enterAction 同源，否则比不设更坏：键上写着「发送」而行为是换行。
 * 两个取值都是 W3C HTML 的标准枚举：`enter`（回车/换行）、`send`（发送）。
 */
export function enterKeyHint(): 'enter' | 'send' {
  return isTouchInput() ? 'enter' : 'send';
}

/** 把 hint 写到 DOM 上（能力位翻转后要重写一次）。 */
export function syncEnterKeyHint(input: HTMLTextAreaElement): void {
  input.enterKeyHint = enterKeyHint();
}

/** 在 textarea 的选区处插入 `text`，光标落在插入内容之后（'end'）。 */
export function insertAtCaret(input: HTMLTextAreaElement, text: string): void {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  if (typeof input.setRangeText === 'function') {
    // 优先 setRangeText：在光标处替换选区、光标落到插入内容之后，且**不触碰滚动位置**
    // （实测：整段重设 value 会把 textarea 的 scrollTop 归零 ⇒ 长草稿跳到顶部）。
    input.setRangeText(text, start, end, 'end');
    return;
  }
  // 老引擎回落：手工拼接 + 手工复位光标（与 'end' 同语义）。
  const v = input.value;
  input.value = v.slice(0, start) + text + v.slice(end);
  const at = start + text.length;
  try {
    input.setSelectionRange(at, at);
  } catch {
    /* 不可选中：值已插入 */
  }
}

/** 装配 Enter 行为时要问的宿主（车道与重绘仍归 ui/inputbar.ts 所有）。 */
export interface EnterHost {
  send(text: string, lane: EnterLane): void;
  /** 当前车道。 */
  lane(): EnterLane;
  /** 另一条车道（Ctrl/Cmd+Enter 用）。 */
  other(): EnterLane;
  /** 程序化改完输入框内容后的重绘（自增高 + 假光标）。 */
  afterEdit(): void;
}

/**
 * 把 Enter 行为绑到输入框上（装配点；判定与插入都在本模块）。
 *
 * 顺带负责软键盘回车键上的字（enterkeyhint）：装配时写一次，能力位翻转时再写一次 ——
 * 它与行为同源，绝不能分家（键上写着「发送」而按下去是换行，比不设更坏）。
 */
export function bindEnterKey(input: HTMLTextAreaElement, host: EnterHost): void {
  syncEnterKeyHint(input);
  onInputCapabilityChange(() => syncEnterKeyHint(input));
  input.addEventListener('keydown', (e) => {
    if (interceptCommandKey(e)) return; // A3：命令补全框先消费 ↑↓/Enter/Tab/Esc
    const act = enterAction(e, isTouchInput());
    if (act === 'native') return; // 不 preventDefault：浏览器默认 = 插入换行
    e.preventDefault();
    if (act === 'newline') {
      insertAtCaret(input, '\n');
      host.afterEdit();
      return;
    }
    host.send(input.value, act === 'send-other' ? host.other() : host.lane());
  });
}
