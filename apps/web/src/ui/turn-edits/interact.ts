// ============================================================================
// ui/turn-edits/interact.ts — 卡片的**交互**（W9334；从 card.ts 拆出）
// ----------------------------------------------------------------------------
// 为什么拆：W9334 返工给它加了「数字三档 + 口径附注」之后 card.ts 顶到 456 行
// （前端模块体积门禁 450）—— 按本仓纪律**拆分**，不是去例外表登记一个新上限。
// 拆的是**缝**而不是随手切：本文件只管「点了会怎样」（含可访问性键盘路径），
// card.ts 只管「长什么样」。依赖方向单向：card.ts → interact.ts（本文件不 import card.ts，
// 重画由调用方以 `rerender` 回调注入 ⇒ 不成环）。
// ============================================================================
import { t } from '../../i18n';
import { openFilePreview } from '../workbench/files-open';
import { resolveTarget } from '../enhance/file-link';
import { revealPath } from './model';

/** 复制路径后提示的停留时长（ms）。 */
export const TOAST_MS = 1600;

/** 一张卡的本地状态（归 card.ts 的列注册表持有；本模块只改这几个字段）。 */
export interface CardState {
  rows: import('./model').TurnEditRow[];
  /** 「另有 N 个调用可能改动了文件」的 N（0 = 不出现）。 */
  shellish: number;
  /** 整卡折叠（表头按钮）。 */
  folded: boolean;
  /** 二次展开：越过阈值显示全部。 */
  expanded: boolean;
  toastTimer: number | null;
}

/** 复制文本：clipboard 不可用时走 textarea 回退；两条都失败 ⇒ **如实**报 false。 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return legacyCopy(text);
  }
}

/** 回退复制（老浏览器 / 非安全上下文 / jsdom）。失败如实返回 false，不假装成功。 */
function legacyCopy(text: string): boolean {
  const doc = document;
  const ta = doc.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  doc.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    // execCommand 在部分环境里根本不存在 —— 取不到就是「复制不了」，不是「复制成功」。
    ok = typeof doc.execCommand === 'function' && doc.execCommand('copy') === true;
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

/** 「打开」= 与正文里的文件路径**同一个出口**（resolveTarget + openFilePreview）。 */
function openRow(path: string): void {
  const abs = resolveTarget(path);
  if (abs === null) return; // 工作区根未知：宁可不打开，也不猜一个可能读不出来的绝对路径
  openFilePreview(abs);
}

function toastOf(card: HTMLElement): HTMLElement | null {
  return card.querySelector<HTMLElement>('.te-toast');
}

function toast(state: CardState, card: HTMLElement, text: string, failed = false): void {
  const box = toastOf(card);
  if (box === null) return;
  box.textContent = text;
  // 「复制失败」不得用成功色印出来 —— 失败是失败。
  box.classList.toggle('is-err', failed);
  if (state.toastTimer !== null) window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    state.toastTimer = null;
    if (box.isConnected) box.textContent = '';
  }, TOAST_MS);
}

function closeMenus(card: HTMLElement): void {
  for (const row of Array.from(card.querySelectorAll('.te-row.is-menu-open'))) {
    row.classList.remove('is-menu-open');
    row.querySelector('.te-caret')?.setAttribute('aria-expanded', 'false');
  }
}

function openMenu(row: Element, caret: Element): void {
  row.classList.add('is-menu-open');
  caret.setAttribute('aria-expanded', 'true');
  row.querySelector<HTMLElement>('.te-menu-item')?.focus();
}

function rowPathOf(node: Element | null): string {
  return node?.closest('.te-row')?.getAttribute('data-path') ?? '';
}

async function onCardClick(
  state: CardState,
  card: HTMLElement,
  rerender: () => void,
  ev: Event,
): Promise<void> {
  const target = ev.target as Element | null;
  const btn = target?.closest<HTMLElement>('[data-act]') ?? null;
  if (btn === null) {
    closeMenus(card); // 点空白 = 收起菜单
    return;
  }
  const act = btn.dataset['act'];
  if (act === 'fold') {
    state.folded = !state.folded;
    rerender();
    return;
  }
  if (act === 'expand' || act === 'collapse') {
    state.expanded = act === 'expand';
    rerender();
    return;
  }
  if (act === 'menu') {
    const row = btn.closest('.te-row');
    const open = row?.classList.contains('is-menu-open') === true;
    closeMenus(card);
    if (row !== null && !open) openMenu(row, btn);
    return;
  }
  const path = rowPathOf(btn);
  if (path === '') return;
  closeMenus(card);
  if (act === 'open') {
    openRow(path);
    return;
  }
  if (act === 'reveal') {
    // 菜单里出现它 = 平台支持 **且** 宿主提供了动作（见 model 的 canReveal）；
    // 真到执行时能力没了 ⇒ 如实说「不可用」，绝不当成功。
    if (!revealPath(path)) toast(state, card, t('chat.turnEdits.revealUnavailable'), true);
    return;
  }
  if (act === 'copy') {
    const ok = await copyText(path);
    toast(state, card, ok ? t('chat.turnEdits.copied') : t('chat.turnEdits.copyFailed'), !ok);
  }
}

function onCardKeydown(card: HTMLElement, ev: KeyboardEvent): void {
  if (ev.key !== 'Escape') return;
  const open = card.querySelector('.te-row.is-menu-open');
  if (open === null) return;
  closeMenus(card);
  open.querySelector<HTMLElement>('.te-caret')?.focus();
}

/**
 * 把交互绑到一张**刚画出来的**卡上（每次重画都由 card.ts 重新调用：
 * 卡片 DOM 整体替换，监听器不跨帧复用）。
 */
export function bindCardInteractions(
  state: CardState,
  card: HTMLElement,
  rerender: () => void,
): void {
  card.addEventListener('click', (ev) => void onCardClick(state, card, rerender, ev));
  card.addEventListener('keydown', (ev) => onCardKeydown(card, ev));
}
