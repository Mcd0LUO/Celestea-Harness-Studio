// ============================================================================
// ui/commands/popup.ts — A3/H：**补全框引擎**（单一 popup；命令与 @文件共用）。
// ----------------------------------------------------------------------------
// H（@提及工作区文件）：同一个引擎、同一套 ↑↓/Enter/Esc/点击，**不另写第二个补全框**。
// 引擎只认「提供者 + 行」：
//   · 命令模式：提供者 = 注册表的同步前缀过滤（'/' 开头）
//   · 文件模式：提供者 = ui/commands/files.ts 的异步目录列举（'@' 开头），带 seq 竞态守卫
// 铁律：离屏构建 + 单次 replaceChildren；不重建输入栏/背景；Esc 走 overlays 层级栈。
// ============================================================================
import { el } from '../../utils/dom';
import { isImeKey, type ImeKeyLike } from '../ime'; // W2036：IME 组合判据（唯一真源，W2033 建立）
import { popOverlay, pushOverlay, type OverlayHandle } from '../../utils/overlays';

/** 一行补全项（命令 / 文件统一形状）。 */
export interface PopupItem {
  /** 主文本：命令 = '/run'；文件 = 'src/ui/send.ts'。 */
  label: string;
  /** 一行说明（命令 desc / 文件大小或「目录」）。 */
  desc: string;
  /** 右侧提示（命令参数提示）。 */
  meta?: string;
  /** 目录项：视觉区分（文件/目录不同样式）。 */
  isDir?: boolean;
  /** 选中时交给调用方的值。 */
  value: string;
}

/** 提供者：给前缀、返回候选（可异步；异步时必须自行带竞态语义）。 */
export type PopupProvider = (prefix: string) => PopupItem[] | Promise<PopupItem[]>;

let box: HTMLElement | null = null;
let input: HTMLTextAreaElement | null = null;
let overlay: OverlayHandle | null = null;
let items: PopupItem[] = [];
let active = 0;
let provider: PopupProvider | null = null;
/** 竞态守卫：每次请求 ++seq，晚到的旧结果丢弃（文件列举是异步的）。 */
let seq = 0;
let onPick: ((item: PopupItem) => void) | null = null;

function renderList(): void {
  if (!box) return;
  const off = document.createElement('div');
  items.forEach((item, i) => {
    const row = el('div', 'cmd-row' + (i === active ? ' active' : '') + (item.isDir ? ' dir' : ''));
    row.appendChild(el('span', 'cmd-name', item.label));
    row.appendChild(el('span', 'cmd-desc', item.desc));
    if (item.meta !== undefined && item.meta !== '') row.appendChild(el('span', 'cmd-args', item.meta));
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', i === active ? 'true' : 'false');
    row.addEventListener('mousedown', (e) => {
      e.preventDefault(); // 不夺焦点（否则输入框失焦、下次输入断掉）
      choose(i);
    });
    off.appendChild(row);
  });
  box.replaceChildren(...Array.from(off.childNodes));
  const cur = box.querySelector('.cmd-row.active');
  if (cur && typeof (cur as HTMLElement).scrollIntoView === 'function') {
    (cur as HTMLElement).scrollIntoView({ block: 'nearest' });
  }
}

function choose(i: number): void {
  const item = items[i];
  if (item && onPick) onPick(item);
}

/** 当前是否可见。 */
export function completionVisible(): boolean {
  return box !== null && !box.classList.contains('hidden');
}

/** 当前高亮项的主文本（测试/诊断）。 */
export function activeItemLabel(): string {
  return items[active]?.label ?? '';
}

/** 设置提供者（命令模式 / 文件模式；null = 关闭补全）。 */
export function setProvider(p: PopupProvider | null): void {
  provider = p;
}

/**
 * 按前缀刷新补全框（异步提供者安全：seq 竞态守卫，晚到结果丢弃）。
 * 空候选 = 隐藏（不显示空框）。
 */
export async function showCompletion(prefix: string): Promise<void> {
  if (!box || !provider) return;
  const my = ++seq;
  let next: PopupItem[] = [];
  try {
    next = await provider(prefix);
  } catch {
    next = [];
  }
  if (my !== seq) return; // 竞态：晚到的旧结果不覆盖
  items = next;
  if (items.length === 0) {
    hideCompletion();
    return;
  }
  if (active >= items.length) active = 0;
  box.classList.remove('hidden');
  positionBox();
  renderList();
  if (overlay === null) overlay = pushOverlay(hideCompletion);
}

/** 隐藏补全框（Esc / 失焦 / 发送后 / 无候选）。 */
export function hideCompletion(): void {
  seq += 1; // 使在飞的列举失效
  if (!box) return;
  box.classList.add('hidden');
  items = [];
  active = 0;
  if (overlay !== null) {
    popOverlay(overlay);
    overlay = null;
  }
}

/**
 * 补全框读的按键事件（KeyboardEvent 的结构子集 ⇒ 纯函数可在 node 里直接断言）。
 * W2036：把 IME 判据的两半（isComposing / keyCode）也登记进来 —— 它们必须是**本函数**
 * 读得到的东西，否则守卫只能写在调用方，而调用方有两个（两处漏判的机会，见下）。
 */
export interface CompletionKeyLike extends ImeKeyLike {
  key: string;
  shiftKey?: boolean;
  preventDefault(): void;
}

/**
 * ↑↓/Enter/Tab/Esc 的键盘处理；返回 true = 已消费（调用方不要走发送）。
 *
 * ★ W2036：IME 组合中的按键**一律**不是给补全框的 —— 见函数第一行的守卫。
 * 守卫放在**本函数**（引擎的键盘入口）而不是某一个调用方：本函数有两个独立的调用方
 * （ui/commands/index.ts 里 installCommands 自注册的 keydown 监听、以及 interceptKey），
 * 且 installCommands 在 main.ts 里**晚于** initInputBar 装配 ⇒ 它的监听器排在
 * newline.ts 的 bindEnterKey **之后**，两条路都会走到这里。改在调用方只会修一半。
 */
export function completionKey(e: CompletionKeyLike): boolean {
  // ★ W2036：组合会话里 isComposing 对**所有**按键都为 true（IME 正在处理这次按键），
  // 所以这一行拦的不是「Enter」而是「整段组合会话」—— Enter(确认候选词) / ↑↓(翻候选页) /
  // Esc(取消组合) / Tab 全都归输入法，补全框一个都不该抢。
  // 判据用共享的 isImeKey：isComposing 的窗口是 (compositionstart, compositionend) 开区间，
  // 而引擎可能先把 compositionend 交给脚本（WebKit bug 165004）⇒ 那一刻读到 false，
  // keyCode 229 正是它的补集。★ 别在这里退回「只看 isComposing」。
  // 位置在 completionVisible() **之前**：组合中的按键连「补全框可不可见」都不该问 ——
  // 它根本不是给这个 UI 的（也顺带保证本函数对组合按键**零副作用**）。
  if (isImeKey(e)) return false;
  if (!completionVisible()) return false;
  if (e.key === 'Escape') {
    e.preventDefault();
    hideCompletion();
    return true;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    active = (active + 1) % items.length;
    renderList();
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    active = (active - 1 + items.length) % items.length;
    renderList();
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    choose(active);
    return true;
  }
  return false;
}

/** 落位：贴输入框上沿偏左（视口坐标 + fixed）。 */
function positionBox(): void {
  if (!box || !input) return;
  const r = input.getBoundingClientRect();
  box.style.left = Math.max(8, r.left) + 'px';
  box.style.bottom = Math.max(8, window.innerHeight - r.top + 6) + 'px';
}

/** 建出补全框（幂等；index.ts 装配一次）。 */
export function initCompletion(inputEl: HTMLTextAreaElement, pick: (item: PopupItem) => void): void {
  if (box) return;
  input = inputEl;
  onPick = pick;
  box = el('div', 'cmd-popup hidden');
  box.id = 'cmdPopup';
  box.setAttribute('role', 'listbox');
  document.body.appendChild(box);
}
