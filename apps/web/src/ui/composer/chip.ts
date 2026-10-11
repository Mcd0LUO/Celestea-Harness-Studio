// ============================================================================
// ui/composer/chip.ts — 命中 token 的 **chip 节点**（composer-surface §8 / §9.1 E1/E2）
// ----------------------------------------------------------------------------
// chip 是 Lexical 的 decorator node：一个**不可编辑的原子**（E1），Backspace 触及它的
// 边界即整体删除（E2），不允许留下 `skill:rev` 半个残肢 —— 残肢就是「亮了却没注入」
// 的富文本版（§8 的原话）。
//
// ★ 文本投影 = **规范形态**（§8）：chip 覆写 getTextContent()，输出
//   `/skill:<name>` / `/mcp:<server>` / `/<command>` / `@<path>`。
//   于是 getCanonicalText()（适配缝的唯一投影真源）天然拿到规范文本，发送与草稿都走它，
//   host 侧 §7 的解析函数**一行不改**。「两端同源」从「共用一个解析函数」升级为
//   「chip 的投影就是解析函数认的形状」。
//
// ★ 形态由 gesture 包产出（`canonicalSlash`），前端**不另写一份正则**（§1.4）：
//   规范形态的形状只有一份定义（packages/gesture），chip 只是把它渲染出来。
//
// ★ **失配降级（E5）**：chip 引用的名字在清单里消失（技能被删 / server 下线）时，
//   它**不再长得像 chip**（class 去掉 chip 外观、标 data-chip-stale），但**文本投影
//   一字不变** —— 发送时仍按纯文本走原解析管线，由 host 兜底。这正是 §8「chip 化不了
//   不存在的东西」的落地：chip 只承诺「这是真的」，不承诺「它还在」。
//
// ★ 为什么 kind 判定在**调用方**：本文件不知道技能清单、命令注册表与 server 清单
//   （那是 ui/commands 那一层的知识）。它只负责「给定 kind + name，长什么样、投影成
//   什么」。判定输入由调用方给（canonicalSlash 就在这里调用）。
// ============================================================================
import {
  DecoratorNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type SerializedPartial,
} from 'lexical';
import { canonicalSlash, type SlashGestureKind } from '@celestea/gesture';

/**
 * chip 的四种形态（composer-surface §8：`/` 的三种 kind + `@文件`）。
 *
 * `command` / `skill` / `mcp` 与 gesture 包的 kind **同名同义** —— 不是巧合：
 * 它们就是同一种分类，前端不该有第二套命名。`mention` 是第四种（@ 文件，E2 一次做完）。
 */
export type ChipKind = SlashGestureKind | 'mention';

/** chip 的类型名（**冻结** node 注册表纪律②：新增它 = 契约变更，旧草稿按 E3 降级纯文本）。 */
export const CHIP_NODE_TYPE = 'composer-chip';

/** chip 的线格式（草稿序列化里存的就是它；字段名不许随手改）。 */
export interface SerializedComposerChip extends SerializedLexicalNode {
  kind: ChipKind;
  /** 名字（命令名 / 技能名 / server 名 / @ 之后的路径原文）。 */
  name: string;
  /** 规范形态投影（失配降级时**不变** —— 见文件头 E5 那条）。 */
  text: string;
  /** 失配降级：引用的名字已不在清单里（视觉不再是 chip，发送仍按纯文本）。 */
  stale: boolean;
}

/**
 * Lexical 传给 importJSON 的载荷形状（partial + 任意键）。
 *
 * 为什么不直接用 SerializedComposerChip：框架的静态签名是**宽松**的（反序列化时
 * 字段可能缺），我们在这里逐字段做类型守卫 —— 读不出来的形状按「重新投影」处理
 * （见 importJSON 的注释），而不是把 undefined 写进节点里当名字。
 */
type ChipJSON = SerializedPartial<SerializedComposerChip> & Record<string, unknown>;

/**
 * chip 的**规范形态投影**（chip 的唯一文本真源）。
 *
 * 三种 `/` kind 走 gesture 包的 `canonicalSlash`（§7 的唯一实现）；名字不合该 kind 的
 * 字符集时返回 `null` —— 宁可不插 chip，也不插一个 host 认不出来的半截形状。
 * `mention` 的形态就是 `@` + 路径原文（§2 的用户裁决：@提及只传路径）。
 */
export function chipText(kind: ChipKind, name: string): string | null {
  if (kind === 'mention') return name === '' ? null : '@' + name;
  return canonicalSlash(kind, name);
}

/** DOM 上的 class 前缀（styles/composer.css 是样式的唯一真源）。 */
const CHIP_CLASS = 'composer-chip';

export class ComposerChipNode extends DecoratorNode<HTMLElement> {
  __kind: ChipKind;
  __name: string;
  __text: string;
  __stale: boolean;

  static override getType(): string {
    return CHIP_NODE_TYPE;
  }

  static override clone(node: ComposerChipNode): ComposerChipNode {
    return new ComposerChipNode(node.__key, node.__kind, node.__name, node.__text, node.__stale);
  }

  /**
   * 草稿反序列化。
   *
   * ★ text 缺失/空时**重新投影一次**（投影规则只有一份 = chipText），不读信落盘的形状：
   *   将来投影规则若变（例如 server 名加了前缀），老载荷里的 text 会自动跟上，
   *   而不会变成「两份投影各说各话」——那正是 §8 要消灭的分叉。
   * 名字拼不出规范形态 ⇒ 抛错，由 draft.ts 的纪律③接住降级纯文本（宁可丢 chip，不丢字）。
   */
  static override importJSON(serializedNode: ChipJSON): ComposerChipNode {
    const kind = typeof serializedNode.kind === 'string' ? serializedNode.kind : 'command';
    const name = typeof serializedNode.name === 'string' ? serializedNode.name : '';
    const text = typeof serializedNode.text === 'string' && serializedNode.text !== ''
      ? serializedNode.text
      : chipText(kind, name);
    // 消息用英文：它是**开发者可见的内部不变量**，不是任何用户会看到的文案
    // （中文一旦进字符串字面体，check-ui-copy 的护栏 A 会要求它走 i18n —— 那会把一条
    //   内部断言挂到文案字典上；本仓的既有做法是内部消息走英文，见 ui/inputbar 等处）。
    if (text === null) throw new Error('composer-chip: imported name has no canonical form');
    return new ComposerChipNode(undefined, kind, name, text, serializedNode.stale === true);
  }

  constructor(
    key?: NodeKey,
    kind: ChipKind = 'command',
    name: string = '',
    text: string = '',
    stale: boolean = false,
  ) {
    super(key);
    this.__kind = kind;
    this.__name = name;
    this.__text = text;
    this.__stale = stale;
  }

  override createDOM(_config: EditorConfig): HTMLElement {
    // ★ E1（不可编辑原子）：chip 自身不是文本区，contenteditable=false 让浏览器
    //   不把它当可编辑内容；caret 只能停在它的**两侧**（Lexical 的选区模型也这么算）。
    const span = document.createElement('span');
    span.className = this.__className();
    span.setAttribute('data-chip-kind', this.__kind);
    span.setAttribute('data-chip-name', this.__name);
    span.textContent = this.__text;
    span.setAttribute('contenteditable', 'false');
    return span;
  }

  override updateDOM(previousNode: this, dom: HTMLElement): boolean {
    if (previousNode.__stale !== this.__stale || previousNode.__kind !== this.__kind) {
      // 失配降级只改**外观**（class），文本投影一字不变（文件头 E5）。
      dom.className = this.__className();
      dom.setAttribute('data-chip-kind', this.__kind);
    }
    if (previousNode.__text !== this.__text) dom.textContent = this.__text;
    return false;
  }

  /** ★ 文本投影 = 规范形态（§8）。这是全仓唯一的 chip→文本投影实现。 */
  override getTextContent(): string {
    return this.__text;
  }

  /**
   * ★ chip 是**原子**（E1/E2）：Lexical 的选区模型把 decorator 节点当作「不可拆分的
   *   元素」—— 光标只能停在它的两侧，range 选区要么整个包含它要么不碰它。
   *   本仓据此实现 Backspace 整体删除（./tree.ts 的 $backspaceChip），因此**不覆写**
   *   任何「允许拆」的开关：DecoratorNode 默认就是那种形状，显式打开反而会造出残肢。
   */

  /** 内联：chip 排在段落里的文字之间（与 @提及 / 命令 token 同排）。 */
  override isInline(): boolean {
    return true;
  }

  /** ★ E2（Backspace 原子删除）：Lexical 的选区模型按「不可拆分的元素」对待 chip。 */
  override isKeyboardSelectable(): boolean {
    return true;
  }

  override exportJSON(): SerializedComposerChip {
    return {
      ...super.exportJSON(),
      type: CHIP_NODE_TYPE,
      version: 1,
      kind: this.__kind,
      name: this.__name,
      text: this.__text,
      stale: this.__stale,
    };
  }

  /** 改失配状态（E5）：调用方用清单裁决，节点只负责改外观标记。 */
  setStale(stale: boolean): this {
    const writable = this.getWritable();
    writable.__stale = stale;
    return writable;
  }

  /** 当前是否失配（测试与诊断读它；判定本身在调用方，见文件头）。 */
  isStaleChip(): boolean {
    return this.__stale;
  }

  getKind(): ChipKind {
    return this.__kind;
  }

  getName(): string {
    return this.__name;
  }

  get canonicalText(): string {
    return this.__text;
  }

  /**
   * class 名：**基类 `composer-chip` 恒在**，失配时再加 `-stale`。
   *
   * ★ 为什么失配不摘掉基类：摘掉的话，「输入框里有没有 chip」这个判定就要靠两个
   *   不同的 class 名去猜（`composer-chip-command` 与 `composer-chip-stale`），任何
   *   一处选择器/断言都会随之分叉。基类恒在 ⇒ 「它是不是 chip」只有一个判据，
   *   「它现在长什么样」交给 `-stale`（styles/composer.css 是样式的唯一真源）。
   */
  private __className(): string {
    const base = `${CHIP_CLASS} ${CHIP_CLASS}-${this.__kind}`;
    return this.__stale ? `${base} ${CHIP_CLASS}-stale` : base;
  }
}

/** 建一个 chip 节点（名字拼不出规范形态 ⇒ 返回 null，调用方不得插半截形状）。 */
export function $createChipNode(kind: ChipKind, name: string): ComposerChipNode | null {
  const text = chipText(kind, name);
  if (text === null) return null;
  return new ComposerChipNode(undefined, kind, name, text, false);
}

/** 结构守卫（node 里可断言；测试用它避免 instanceof 在跨 realm 时失效）。 */
export function $isChipNode(node: LexicalNode | null | undefined): node is ComposerChipNode {
  return node instanceof ComposerChipNode || (node !== null && node !== undefined && node.getType() === CHIP_NODE_TYPE);
}

