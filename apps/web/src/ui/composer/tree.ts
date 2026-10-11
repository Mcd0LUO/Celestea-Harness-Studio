// ============================================================================
// ui/composer/tree.ts — 编辑器**树级**的区间手术（composer-surface §8 的插入侧）
// ----------------------------------------------------------------------------
// 为什么单独成文件：lexical.ts 已经贴着模块体积上限（A4a 的门禁按 450 行断），
// 而「把规范文本的 [start,end) 换成一个 chip 节点」是**一整套**偏移量算术
// （累计偏移 / 边界拆分 / 跨节点删除 / 插入后落 caret），挤进 lexical.ts 会顶破棘轮。
//
// ★ 全模块的**偏移量真源**只有一个：`node.getTextContent().length`。
//   chip 覆写了 getTextContent（返回规范形态），所以「规范文本里的下标」与
//   「树里的累计偏移」天然对齐 —— 这正是 §8「投影就是解析函数认的形状」在结构上的兑现。
//   任何地方若改用别的口径（例如 DOM 文本、selectionStart），两套偏移就会分叉。
//
// ★ **chip 不可拆**（E2）：边界若落在 chip 内部，一律不拆 —— 要么整块留在区间内被删，
//   要么整块留在区间外。留下半个 chip 就是 `skill:rev` 那种残肢（§8 的原话）。
// ============================================================================
import {
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import { $createTextNode, type TextNode } from 'lexical';
import { $createChipNode, $isChipNode, chipText, type ChipKind, type ComposerChipNode } from './chip';

/** 段落的一个子节点 + 它在**规范文本**里的区间（闭区间 [start,end]）。 */
interface Span {
  readonly node: LexicalNode;
  readonly start: number;
  readonly end: number;
}

/** 段落的子节点与累计偏移（与 readCanonical 同一口径）。 */
function spansOf(p: ElementNode): Span[] {
  const out: Span[] = [];
  let acc = 0;
  for (const child of p.getChildren()) {
    const len = child.getTextContent().length;
    out.push({ node: child, start: acc, end: acc + len });
    acc += len;
  }
  return out;
}

/**
 * 在段落 offset 处**制造一个边界**（文本节点会被 split）。
 *
 * 边界已经存在 / 落在 chip 内部 / 落在段落外 ⇒ 什么都不做（不制造半截 chip）。
 */
function splitAt(p: ElementNode, offset: number): void {
  if (offset <= 0) return;
  for (const s of spansOf(p)) {
    if (offset === s.start) return;
    if (offset < s.end) {
      if ($isTextNode(s.node)) s.node.splitText(offset - s.start);
      return;
    }
  }
}

/**
 * 段落内做一次区间替换：删掉 [start,end) 覆盖到的节点，插入 `nodes`。
 * 返回「插到哪个节点后面」（null = 插到段落最前）。
 *
 * 空区间（start === end）= 纯插入：插在第一个 end <= start 的节点之后。
 */
function spliceInParagraph(p: ElementNode, start: number, end: number, nodes: LexicalNode[]): LexicalNode | null {
  splitAt(p, start);
  splitAt(p, end);
  const spans = spansOf(p);
  let first = spans.length;
  let last = spans.length;
  if (start === end) {
    first = spans.findIndex((s) => s.end > start);
    if (first < 0) first = spans.length;
    last = first;
  } else {
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i]!;
      if (s.start >= start && s.start < end) {
        if (first === spans.length) first = i;
        last = i + 1;
      }
    }
  }
  const anchor = first > 0 ? spans[first - 1]!.node : null;
  // 只有「纯插入」（没删任何东西）时，参照节点才可能是**即将被删掉**的那个 ——
  // 拿一个已脱离段落的节点 insertBefore 会静默无效（这正是插到偏移 0 反而全红的原因）。
  const before = last === first && first < spans.length ? spans[first]!.node : null;
  for (const s of spans.slice(first, last)) s.node.remove();
  // ★ 插在段首时必须 insertBefore：**append 会把内容放到段尾**（此前插 chip 到偏移 0
  //   的用例就是这么红的：投影变成「原文 + chip」而不是「chip + 原文」）。
  let ref: LexicalNode | null = anchor;
  for (const node of nodes) {
    if (ref !== null) ref.insertAfter(node);
    else if (before !== null) before.insertBefore(node);
    else p.append(node);
    ref = node;
  }
  return ref;
}

/** 定位规范文本区间落在哪个段落；跨段落 ⇒ 返回 null（调用方走纯文本降级）。 */
function paragraphAt(offset: number, end: number): ElementNode | null {
  let base = 0;
  for (const child of $getRoot().getChildren()) {
    if (!$isElementNode(child)) return null;
    const len = child.getTextContent().length;
    if (offset >= base && end <= base + len) return child;
    base += len + 1; // 段落之间的那个换行
  }
  return null;
}

/**
 * 把规范文本的 [start,end) 换成一个 chip 节点（+ 可选的尾随纯文本）。
 *
 * 返回 false = 没插成（名字拼不出规范形态 / 区间跨段落）。调用方**必须**在拿不到 chip
 * 时退回纯文本路径 —— 宁可是普通文本，也不能让用户打的字凭空消失。
 */
export function $insertChip(
  editor: LexicalEditor,
  start: number,
  end: number,
  kind: ChipKind,
  name: string,
  trailing: string,
): boolean {
  // ★ 名字校验放在 update **之外**：$createChipNode 会构造节点，而构造节点要求
  //   「当前有一个 active editor」（Lexical 的硬前置）。放外面既拿不到 active editor，
  //   又能让「拼不出规范形态」这条失败路径**不产生任何更新**。
  if (chipText(kind, name) === null) return false;
  let done = false;
  editor.update(
    () => {
      const chip = $createChipNode(kind, name);
      const p = paragraphAt(start, end);
      if (chip === null || p === null) return;
      const nodes: LexicalNode[] = [chip];
      if (trailing !== '') nodes.push($createTextNode(trailing));
      const last = spliceInParagraph(p, start, end, nodes);
      // caret 落在插入内容之后：尾随文本存在就进它的末尾，否则停在 chip 之后（元素点）。
      const tail = trailing === '' ? null : (last as TextNode | null);
      if (tail !== null && $isTextNode(tail)) tail.select(tail.getTextContentSize(), tail.getTextContentSize());
      else if (last !== null) last.selectNext(0, 0);
      else p.select();
      done = true;
    },
    { discrete: true },
  );
  return done;
}

/** 编辑器里**所有** chip 节点（读事务里用）。 */
export function $chips(): ComposerChipNode[] {
  const out: ComposerChipNode[] = [];
  const walk = (node: LexicalNode): void => {
    if ($isChipNode(node)) {
      out.push(node);
      return;
    }
    if ($isElementNode(node)) for (const child of node.getChildren()) walk(child);
  };
  for (const child of $getRoot().getChildren()) walk(child);
  return out;
}

/**
 * E5（失配降级）：按调用方的清单裁决刷新每个 chip 的「还在不在」。
 *
 * ★ 判定**不在这里**：本函数只把裁决结果写进节点（setStale），长什么样是 chip.ts 的事，
 * 文本投影一字不变 —— 发送仍按纯文本走原解析管线（§8 的兜底语义）。
 * 没有变化时**不产生更新**：否则每次刷新都会把编辑器叫醒一遍（输入路径上的性能与
 * 「onChange 自己叫醒自己」的死循环都从这条来）。
 */
export function $refreshChipStates(
  editor: LexicalEditor,
  resolve: (kind: ChipKind, name: string) => boolean,
): boolean {
  let changed = false;
  editor.update(
    () => {
      for (const chip of $chips()) {
        const stale = !resolve(chip.getKind(), chip.getName());
        if (stale !== chip.isStaleChip()) {
          chip.setStale(stale);
          changed = true;
        }
      }
    },
    { discrete: true },
  );
  return changed;
}

/** 光标前的文本（补全引擎的判定输入）。
 *
 * ★ 必须按**整段**累计，不能只读 anchor 所在的那个文本节点：段落里一旦有 chip，
 *   同一行就是 [文本][chip][文本] 三段，只读当前节点会把 chip 前面的字全丢掉 ——
 *   补全框的 `@` / `/` 判定会因此算错起点（这正是 A4b 引入 chip 后必须一并修的那处）。
 */
export function $readBeforeCaret(): string {
  const fallback = (): string =>
    $getRoot()
      .getChildren()
      .map((child) => child.getTextContent())
      .join('\n');
  const sel = $getSelection();
  if (!$isRangeSelection(sel)) return fallback();
  const anchor = sel.anchor;
  if (anchor.type === 'text') {
    const node = anchor.getNode();
    let acc = node.getTextContent().slice(0, anchor.offset);
    let prev: LexicalNode | null = node.getPreviousSibling();
    while (prev !== null) {
      acc = prev.getTextContent() + acc;
      prev = prev.getPreviousSibling();
    }
    return acc;
  }
  // 元素点（光标停在 chip 之类的节点之间）：先累计**前面所有段落**，再累计本段内
  // 它之前的每个子节点。
  //
  // ★ 为什么必须带上前面的段落：光标停在段尾的空段落里时（「AAA」按 Enter 换行），
  //   元素点是「第 1 段的第 0 个孩子」——只数本段会得 0，而「光标前文本」的真值是
  //   「AAA\n」。补全框的起点、发送时的 textarea 时代语义都依赖它（W2028 的
  //   「光标落在换行之后 ⇒ selectionStart 4」正是这一条；漏掉它会变 0）。
  const parent = anchor.getNode();
  if (!$isElementNode(parent)) return fallback();
  let acc = $textBeforeNode(parent);
  for (let i = 0; i < anchor.offset && i < parent.getChildrenSize(); i++) {
    acc += parent.getChildAtIndex(i)?.getTextContent() ?? '';
  }
  return acc;
}

/** 某个节点之前的**全部**文本（段落之间补一个换行，与 readCanonical 同一口径）。 */
function $textBeforeNode(target: LexicalNode): string {
  const parts: string[] = [];
  let found = false;
  for (const child of $getRoot().getChildren()) {
    if (found) break;
    if (child === target) {
      found = true;
      break;
    }
    parts.push(child.getTextContent());
  }
  // target 不在根的直接子层（理论上不会发生）：退化为「到它所在段落为止的全文前缀」。
  if (!found) {
    const owner = target.getParent();
    for (const child of $getRoot().getChildren()) {
      if (child === owner) break;
      parts.push(child.getTextContent());
    }
  }
  return parts.length === 0 ? '' : parts.join('\n') + '\n';
}

/** 把光标放到**全文偏移** offset 处（跨段落；量不到就落到末尾，绝不抛）。 */
export function $placeCaretAt(editor: LexicalEditor, offset: number): void {
  editor.update(
    () => {
      const root = $getRoot();
      let left = Math.max(0, offset);
      for (const child of root.getChildren()) {
        const len = child.getTextContent().length;
        if (left <= len) {
          $selectInParagraph($isElementNode(child) ? child : null, left);
          return;
        }
        left -= len + 1; // 段落之间的那个换行
      }
      root.selectEnd();
    },
    { discrete: true },
  );
}


/**
 * Backspace 触及 chip = **整体删除**（E2；§8「不允许留下 `skill:rev` 半个残肢」）。
 *
 * ★ 为什么必须自己实现：Lexical 核心包**不注册** `KEY_BACKSPACE_COMMAND` 的默认处理器
 *   （默认实现在 @lexical/rich-text，本仓不依赖它）—— 不显式接住，一次 Backspace 会
 *   **什么也没发生**（比残肢更糟：用户以为编辑器坏了）。
 *
 * 判定只有两种形状（都来自「光标贴着 chip 边界」）：
 *   ① 文本点：光标在文本节点开头，且它的**前一个兄弟**是 chip；
 *   ② 元素点：光标在元素偏移 k，k-1 处的子节点是 chip。
 * 其余一律不处理（return false ⇒ 交回默认路径 = 删一个字符），零行为变化。
 */
export function $backspaceChip(): boolean {
  const sel = $getSelection();
  if (!$isRangeSelection(sel) || !sel.isCollapsed()) return false;
  const anchor = sel.anchor;
  let target: LexicalNode | null = null;
  if (anchor.type === 'text') {
    const node = anchor.getNode();
    if (anchor.offset !== 0) return false; // 光标在文本中间 ⇒ 删的是字符，不是 chip
    const prev = node.getPreviousSibling();
    if (prev !== null && $isChipNode(prev)) target = prev;
  } else {
    const parent = anchor.getNode();
    if (!$isElementNode(parent)) return false;
    const index = anchor.offset - 1;
    if (index < 0) return false;
    const prev = parent.getChildAtIndex(index);
    if (prev !== null && $isChipNode(prev)) target = prev;
  }
  if (target === null) return false;
  // 删除后 caret 落在原位（元素点）；文本点则把光标留在后一个文本节点的开头。
  target.remove();
  return true;
}

/** 段内落点：文本节点按字符偏移；落在节点边界上就取元素点（chip 两侧都停得住）。 */
function $selectInParagraph(p: ElementNode | null, offset: number): void {
  if (p === null) return;
  const spans = spansOf(p);
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]!;
    if (offset < s.start) break;
    if (offset <= s.end) {
      if ($isTextNode(s.node)) {
        const local = offset - s.start;
        s.node.select(local, local);
        return;
      }
      // 非文本节点（chip）：offset 落在它内部 → 停在它之后；等于其起点 → 停在它之前。
      const atStart = offset === s.start;
      const next = atStart ? s.node.selectPrevious(0, 0) : s.node.selectNext(0, 0);
      void next;
      return;
    }
  }
  p.select();
}
