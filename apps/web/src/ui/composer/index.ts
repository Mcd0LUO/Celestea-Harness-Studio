// ============================================================================
// ui/composer/index.ts — 输入栏适配缝的**装配与门面**
// ----------------------------------------------------------------------------
// 消费方（ui/inputbar / ui/send / ui/viewctx / ui/commands）一律从这里读写输入栏，
// 不得再直接操作 #input 的内容（textarea 已退役，现在是 Lexical 的 editor root）。
//
// 为什么要一层门面而不是直接 import ./lexical：装配期与消费期是**两件事**——
//   · 装配期只有 ui/inputbar.ts 一处（它持车道、设备能力位、附件车道）；
//   · 消费期有 4 个模块，它们不该各自判断「编辑器装好了没有」，更不该在未装配时抛。
//   门面把「未装配」这件事收敛成**一次**判定（下面每个 no-op 分支都是它）。
// ============================================================================
import type { ChipInsert, ComposerAdapter, ComposerChange, DraftRestore } from './adapter';
import { createLexicalComposer, type LexicalComposerOptions } from './lexical';
import { readStoredDraft, writeStoredDraft } from './draft';
import type { ChipKind } from './chip';

export type { ComposerAdapter, ComposerChange, DraftRestore } from './adapter';
export { COMPOSER_NODES } from './lexical';
export { DRAFT_VERSION, decodeDraft, encodeDraft, nodeFingerprint } from './draft';
export { CHIP_NODE_TYPE, chipText, type ChipKind } from './chip';
export type { ChipInsert } from './adapter';

let adapter: ComposerAdapter | null = null;

/** 装配（幂等：已装配则原样返回，绝不建第二个编辑器）。 */
export function mountComposer(o: LexicalComposerOptions): ComposerAdapter {
  if (adapter) return adapter;
  adapter = createLexicalComposer(o);
  return adapter;
}

/** 已装配的适配器（未装配 = null）。 */
export function composer(): ComposerAdapter | null {
  return adapter;
}

// ---- 消费侧的薄封装：未装配一律 no-op / 空串，**绝不抛** --------------------------
//   输入栏在 main.ts 里比 viewctx / send 晚装配一点点；让每个消费方自己判「装没装」
//   就是把同一个判定抄四遍（本仓复盘 §1.4 的教训）。

/** 规范文本（发送与草稿回退的真源）。 */
export function canonicalText(): string {
  return adapter ? adapter.getCanonicalText() : '';
}

/** 光标前的文本（补全引擎 refresh 的判定输入）。 */
export function textBeforeCaret(): string {
  return adapter ? adapter.getTextBeforeCaret() : '';
}

export function setComposerText(text: string): void {
  adapter?.setText(text);
}

export function replaceComposerRange(start: number, end: number, text: string): void {
  adapter?.replaceRange(start, end, text);
}

/**
 * 把 [start,end) 插成 **chip**（§8）。返回 false = 没插成 / 未装配，
 * 调用方**必须**退回 `replaceComposerRange` 的纯文本路径。
 */
export function insertComposerChip(request: ChipInsert): boolean {
  return adapter ? adapter.insertChip(request) : false;
}

/** E5：按清单重判每个 chip 的失配状态（显示降级，投影不变）。 */
export function refreshComposerChips(resolve: (kind: ChipKind, name: string) => boolean): boolean {
  return adapter ? adapter.refreshChips(resolve) : false;
}

export function clearComposer(): void {
  adapter?.clear();
}

export function focusComposer(): void {
  adapter?.focus();
}

export function setComposerPlaceholder(text: string): void {
  adapter?.setPlaceholder(text);
}

export function setComposerReadOnly(readOnly: boolean): void {
  adapter?.setReadOnly(readOnly);
}

export function onComposerChange(cb: (c: ComposerChange) => void): void {
  adapter?.onChange(cb);
}

export function setComposerKeyInterceptor(fn: ((e: KeyboardEvent) => boolean) | null): void {
  adapter?.setKeyInterceptor(fn);
}

/** 编辑器根元素（补全框落位锚点；未装配 = null）。 */
export function composerRoot(): HTMLElement | null {
  return adapter ? adapter.root : null;
}

// ---- 草稿：会话切换（内存）与页面刷新（localStorage）两条恢复路径 ------------------

/** 取当前草稿载荷（编码后的字符串；无内容 = 空串 = 「没有草稿」）。 */
export function draftPayload(): string {
  if (!adapter) return '';
  const payload = adapter.getDraftPayload();
  try {
    const parsed = JSON.parse(payload) as { text?: unknown };
    return typeof parsed.text === 'string' && parsed.text !== '' ? payload : '';
  } catch {
    return '';
  }
}

/** 把当前草稿落到本地（刷新后恢复用）。空载荷 ⇒ 删键。 */
export function persistDraft(sessionId: string): void {
  writeStoredDraft(sessionId, draftPayload());
}

/** 恢复本地草稿（页面刷新后）。返回 state / text（降级）/ empty。 */
export function restorePersistedDraft(sessionId: string): DraftRestore {
  const raw = readStoredDraft(sessionId);
  if (raw === null || raw === '') return 'empty';
  return adapter ? adapter.restoreDraft(raw) : 'empty';
}

/**
 * 恢复一份**内存**草稿载荷（会话切换：viewctx 把旧 pane 的载荷传进来）。
 *
 * 空载荷也要**转发**给适配器（它会把编辑器清空）：返回 empty 只表示「本来就没有草稿」，
 * 不等于「编辑器里现在有字可以留着」—— 少这一次转发，切回一个空草稿会话就会把上一个
 * 会话的字显示成它的草稿。
 */
export function restoreDraftPayload(payload: string): DraftRestore {
  if (!adapter) return 'empty';
  return adapter.restoreDraft(payload);
}

/** 卸载（测试用：把单例复位，让下一个用例能重新装配）。 */
export function resetComposer(): void {
  adapter?.destroy();
  adapter = null;
}
