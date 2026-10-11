// ============================================================================
// ui/composer/adapter.ts — 输入栏的**适配缝**（composer-surface §9.2）
// ----------------------------------------------------------------------------
// 为什么要有这一层（E4：Lexical **直接替换** textarea，不留双实现）：
//   替换本身是「一种实现换成另一种实现」，但消费方（ui/inputbar / ui/send /
//   ui/viewctx / ui/commands）有 4 处、20+ 个读写点。若它们继续直接碰 DOM 元素，
//   换实现就是换 20 次 —— 而这 20 次里有 textarea 专属语义（value / selectionStart /
//   selectionEnd / placeholder 属性 / enterkeyhint / dispatchEvent('input')），
//   逐个改正是最容易漏一处的地方（本仓铁律 10 的事故形态：并发写不报错，只丢改动）。
//   所以：**所有读写收敛到本接口**，DOM 只出现在唯一实现里。
//
// 这条缝存在的**两个理由**（不是"以后要接别的编辑器"那种空理由）：
//   1. **可测**：草稿编解码、IME 中 Enter 不发送、粘贴附件分道，全部可以在 node 里
//      对着接口断言，不必起真浏览器；
//   2. **可回退**：未来若 Lexical 出问题，回退点是这一个模块而不是 4 个消费方。
//
// ★ 为什么 **getCanonicalText()** 而不是 getValue()：发送与草稿落盘都必须走**规范文本**
//   （A4b 的 chip 投影文本）。命名把它钉在这里，前端不得另写一份投影。
// ============================================================================

/** 一次内容变化的载荷：规范文本 + 光标前文本（补全引擎 refresh 直接用它）。 */
export interface ComposerChange {
  /** 全量规范文本（发送用）。 */
  readonly text: string;
  /** 光标前那一段（'/' 命令与 '@文件' 补全的判定输入）。 */
  readonly before: string;
}

/** 草稿恢复的结果：state = 按序列化状态恢复成功；text = 降级为纯文本；empty = 无草稿。 */
export type DraftRestore = 'state' | 'text' | 'empty';

/** 输入栏适配接口（唯一真源；**唯一**允许直接碰编辑器 DOM 的地方是它的实现）。 */
export interface ComposerAdapter {
  /** 编辑器根元素：补全框锚点、focus/blur 事件源、placeholder 的 DOM 真源。 */
  readonly root: HTMLElement;

  /** 规范文本（chip 投影后）。发送与草稿回退都走它。 */
  getCanonicalText(): string;
  /** 光标前的文本（补全引擎的 refresh / mentionToken 从这里读）。 */
  getTextBeforeCaret(): string;

  /** 置文本（整体替换，光标落到末尾）。 */
  setText(text: string): void;
  /** 按偏移替换 [start, end)，光标落到插入内容之后（@文件补全的逐级进入用它）。 */
  replaceRange(start: number, end: number, text: string): void;
  /** 清空（发送成功后 / 命令消费后）。 */
  clear(): void;
  focus(): void;

  /** 草稿：取出编码后的持久化载荷（带 v 版本与冻结 node 注册表指纹，见 ./draft.ts）。 */
  getDraftPayload(): string;
  /** 恢复草稿载荷；读失败 / 版本不匹配 / node 未知 ⇒ 降级纯文本（返回 'text'）。 */
  restoreDraft(payload: string): DraftRestore;

  /** 占位符（设备能力分流的文案；见 ui/viewport.ts 的 deviceCopy）。 */
  setPlaceholder(text: string): void;
  /** 只读态（W866 之后三种模式都可输入，此处保留是为了「降级」时有一条诚实出口）。 */
  setReadOnly(readOnly: boolean): void;

  /** 内容变化订阅（草稿实时保存 / 补全刷新都走它，不再自己监听 input 事件）。 */
  onChange(cb: (change: ComposerChange) => void): void;

  /**
   * 键盘**总**拦截口（补全框先消费，返回 true 表示这次按键不归编辑器）。
   *
   * 为什么是接口的一部分而不是 Lexical 内部的事：补全框与 Enter 发送在**同一次按键**
   * 上竞争（§9.2 的 Enter 车道 + A3 的 popup 消费），谁先谁后必须是编排层的一个显式
   * 决定，而不是「谁的 DOM 监听器先注册」。实现必须保证拦截发生在 Enter 判定**之前**。
   */
  setKeyInterceptor(fn: ((e: KeyboardEvent) => boolean) | null): void;

  /** 卸载（幂等）：解除监听器与 DOM 绑定。 */
  destroy(): void;
}
