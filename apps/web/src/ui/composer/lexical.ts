// ============================================================================
// ui/composer/lexical.ts — ComposerAdapter 的 **Lexical 实现**（composer-surface §9）
// ----------------------------------------------------------------------------
// E1 选 Lexical、§9.2 把 textarea 的耦合点全部改道到这里：
//   · 取/置文本、替换区间、草稿编解码、焦点、placeholder、enterkeyhint
//   · Enter 车道（ui/inputbar/newline.ts 的 enterAction **语义逐字保留**）
//   · 粘贴：强制纯文本 + 含文件时转附件车道
//   · 补全框的键盘拦截（setKeyInterceptor，见 adapter.ts 的接口注释）
//
// 自增高（W2016 的 field-sizing 路径已随 textarea 一起退役，见 §9.3）：
//   field-sizing: content 不支持 div，editor root 改用 max-height + overflow-y
//   （styles/composer.css 是唯一真源）。既有的「输入时写 style.height」的强制同步布局
//   随之消失，输入路径上不再有任何样式读写。
//
// ★ IME（W2032/W2033）：Enter 的判定仍然是 ui/ime.ts 的 isImeKey（唯一真源），
//   本文件不重写判定、只搬挂载点。组合中的 Enter 在桌面必须**吞掉**（swallow）——
//   组合会话里发出去的是半截拼音，这是本仓有真机证据的老伤疤。
// ============================================================================
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_LOW,
  KEY_DOWN_COMMAND,
  PASTE_COMMAND,
  type PasteCommandType,
  createEditor,
  type LexicalEditor,
} from 'lexical';
// ★ W9394：DOM→模型的**输入层**必须由 @lexical/rich-text 提供，core 没有。
//   见下方 registerRichText 调用点的长注释（为什么不是手搓 beforeinput）。
import { registerRichText } from '@lexical/rich-text';
import { enterAction } from '../inputbar/newline';
import { isImeKey } from '../ime'; // W2036：组合中的按键不属于编辑器（W2033 的回归面）
import { decodeDraft, encodeDraft } from './draft';
import {
  $backspaceChip,
  $insertChip,
  $placeCaretAt,
  $readBeforeCaret,
  $refreshChipStates,
} from './tree';
import { CHIP_NODE_TYPE, ComposerChipNode, type ChipKind } from './chip';
import type { ChipInsert, ComposerAdapter, ComposerChange, DraftRestore } from './adapter';

/**
 * **冻结的 node 注册表**（纪律②）：草稿载荷里带它的指纹，改它 = 契约变更。
 *
 * A4b 要加 chip（decorator node）时必须把新类型加进来**并**接受「旧草稿一律降级纯文本」
 * 这个后果（或显式升 DRAFT_VERSION）。这就是把「新增 node 类型」变成契约变更的机制。
 */
export const COMPOSER_NODES: readonly string[] = Object.freeze([
  'root',
  'paragraph',
  'text',
  'linebreak',
  // ★ A4b：chip 进了这张表 ⇒ **指纹变了** ⇒ A4b 之前的草稿一律按纪律③降级纯文本。
  //   这不是意外，是纪律②在起作用：新增 node 类型 = 契约变更（见 chip.ts 的 E3 说明）。
  //   旧草稿不会静默消失 —— 载荷里那份规范文本明文副本仍然把它原样读回来。
  CHIP_NODE_TYPE,
]);

/** 装配时宿主要回答的问题（装配层仍然持有所有业务语义，编辑器只负责文本与键）。 */
export interface LexicalComposerOptions {
  /** 挂载点（index.html 的 .input-box 里的 #input 容器）。 */
  readonly mount: HTMLElement;
  /** Enter 车道：桌面 Enter = 发送；Ctrl/Cmd+Enter = 另一条车道。 */
  readonly send: (text: string, lane: 'steer' | 'queue') => void;
  readonly lane: () => 'steer' | 'queue';
  readonly otherLane: () => 'steer' | 'queue';
  /** 设备能力位：false = 桌面（Enter 发送），true = 触摸（Enter 换行）。 */
  readonly isTouch: () => boolean;
  /** 剪贴板里取到附件文件时转附件车道（acceptFiles 逻辑不变，只换挂载点）。 */
  readonly onFiles?: (files: File[]) => void;
}

/** 从剪贴板事件里取附件文件（图片/文本由宿主的 acceptFiles 判定，这里只负责**取**）。 */
function clipboardFiles(e: ClipboardEvent): File[] {
  const cd = e.clipboardData;
  if (!cd) return [];
  const out: File[] = [];
  const items = cd.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it && it.kind === 'file') {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  if (out.length === 0 && cd.files) {
    for (let i = 0; i < cd.files.length; i++) {
      const f = cd.files[i];
      if (f) out.push(f);
    }
  }
  return out;
}

/** 规范文本的可读结构子集（根节点 = 一串段落；Lexical 的 getChildren 返回**数组**）。 */
interface TextContainer {
  getChildren(): Array<{ getTextContent(): string }>;
}

/** 把根节点内容读成规范文本（段落之间一个换行；A4b 的 chip 在这里投影规范形态）。 */
function readCanonical(root: TextContainer): string {
  return root
    .getChildren()
    .map((child) => child.getTextContent())
    .join('\n');
}

/** 用纯文本重建整棵树（setText / replaceRange / 草稿降级共用这一条路径）。 */
function writePlainText(editor: LexicalEditor, text: string): void {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const lines = text.split('\n');
      for (const line of lines) {
        const p = $createParagraphNode();
        if (line !== '') p.append($createTextNode(line));
        root.append(p);
      }
    },
    { discrete: true },
  );
}

// 光标前的文本与落点都搬到了 ./tree.ts（A4b）：段落里出现 chip 之后，「光标前文本」
// 必须按整段累计，只读 anchor 所在的那个文本节点会把 chip 前面的字整段丢掉。

/**
 * 挂载一个 Lexical 输入栏（**直接替换** textarea，E4 不留双实现）。
 *
 * 返回的适配器是唯一的读写入口；消费方不得再直接操作 root 元素的内容。
 */
export function createLexicalComposer(o: LexicalComposerOptions): ComposerAdapter {
  const editor: LexicalEditor = createEditor({
    namespace: 'celestea-composer',
    // ★ chip 必须在这里**注册**：草稿的反序列化（parseEditorState）按 node 类型名
    //   找实现；没注册的类会在恢复时报错，然后被纪律③接住降级纯文本（那是对的兜底，
    //   但意味着每份带 chip 的草稿都恢复不成 —— 所以它是注册，不是可选）。
    nodes: [ComposerChipNode],
    onError: () => {
      // 编辑器异常**不许**打断输入栏本身（与 W1525「假光标是装饰」的纪律同源）：
      // 吞掉并继续，用户的字还在 DOM 里。
      //
      // 为什么这里不 console.warn：本仓 console 诊断点的**计数**由
      // ARCHITECTURE.md §6.5.5 写下并由 tests/doc-conventions.test.ts ⑩ 钉死；新增一处
      // 诊断语句就要同步改那个数字（跨文档契约变更）。输入编辑器这一处不值得为它动一份
      // 架构契约 —— 真要查，Lexical 自己会把失败的 update 挂到 editor 上。
    },
  });

  // ==========================================================================
  // ★ W9394：接上 **DOM→模型的输入层**（这就是「一个字都敲不进去」的根因）。
  // --------------------------------------------------------------------------
  // 症状：contenteditable 能聚焦，但敲键盘 / Input.insertText / execCommand insertText
  //   全部留不下字，DOM 立刻被 reconciler 按空模型抹平，且 console 无任何报错。
  //
  // 根因：core 的 beforeinput 处理（registerDefaultCommandHandlers → $handleBeforeInput）
  //   在算出「这次按键该插字」之后，event.preventDefault() 掉浏览器默认动作，然后
  //   **dispatch CONTROLLED_TEXT_INSERTION_COMMAND / DELETE_*_COMMAND / INSERT_PARAGRAPH_COMMAND**
  //   这些命令 —— 但这些命令的**处理器**不在 core 里，而在 @lexical/rich-text。
  //   本仓此前只 createEditor + setRootElement，一个处理器都没注册 ⇒ 每次按键都是
  //   「默认动作被吃掉 + 命令无人接」，字既没进 DOM 也没进模型。core 不含 DOM 输入层，
  //   registerRichText 是那个唯一必需的子包（见 docs/DEPENDENCY-POLICY.md §7.2）。
  //
  // 为什么**不手搓** beforeinput / input 监听器：
  //   · 打字（insertText / insertReplacementText / 输入法上屏）、退格（deleteContentBackward /
  //     deleteWordBackward / deleteByComposition）、换行（insertParagraph / insertLineBreak）、
  //     粘贴 / 剪切 / 拖放，全部要在这里各写一条分支，还要处理 selection 的 DOM 归一化；
  //   · **中文 IME 是硬伤**：compositionstart/end 与 beforeinput 的 insertCompositionText
  //     交错顺序在不同引擎里不一致（WebKit 会把 compositionend 提前交给脚本，本仓
  //     ui/ime.ts 的 isImeKey 就是为这条 bug 立的），手搓输入层极易把「组合中的半截拼音」
  //     当成已提交文本插进模型，或在 compositionend 时重复插入一次。
  //   · registerRichText 把上述全部收敛成一份经上游真机验证的实现，且它注册的命令
  //     与我们已注册的 KEY_DOWN_COMMAND（CRITICAL）/ PASTE_COMMAND（LOW）**优先级不冲突**：
  //     命令按优先级从高到低派发（4→0），我们的 Enter 车道与纯文本粘贴都在它（EDITOR=0）
  //     之前消费；退格 chip 的原子删除同样在 KEY_DOWN 这一层先跑。
  //
  // 注意：registerRichText 不注册任何 node，也不碰 COMPOSER_NODES（草稿指纹契约不变）。
  // ==========================================================================
  const unregisterRichText = registerRichText(editor);

  const root = o.mount;
  const changeCbs: ((c: ComposerChange) => void)[] = [];
  let interceptor: ((e: KeyboardEvent) => boolean) | null = null;
  let destroyed = false;

  // ---- 文本读取（Lexical 的读取必须发生在 editorState 的读事务里） -----------------
  function read<T>(fn: () => T): T {
    return editor.getEditorState().read(fn);
  }

  function getCanonicalText(): string {
    return read(() => readCanonical($getRoot() as unknown as TextContainer));
  }

  function getTextBeforeCaret(): string {
    return read(() => $readBeforeCaret());
  }

  // ---- 草稿（E3 三纪律的执行点：编解码在 ./draft.ts，这里只做「照状态恢复」） -------
  function getDraftPayload(): string {
    const text = getCanonicalText();
    const state = JSON.stringify(editor.getEditorState().toJSON());
    return encodeDraft(text, state, COMPOSER_NODES);
  }

  function restoreDraft(payload: string): DraftRestore {
    const decoded = decodeDraft(payload, COMPOSER_NODES);
    if (decoded.kind === 'empty') {
      writePlainText(editor, '');
      return 'empty';
    }
    if (decoded.kind === 'text') {
      writePlainText(editor, decoded.text);
      return 'text';
    }
    try {
      editor.setEditorState(editor.parseEditorState(decoded.state));
      return 'state';
    } catch {
      // 纪律③：状态读不出来 ⇒ 降级纯文本（**宁可丢 chip，不丢字**）。
      writePlainText(editor, decoded.text);
      return 'text';
    }
  }

  // ---- 键盘：补全框先消费，再走 Enter 车道（ui/inputbar/newline.ts 的唯一判定） -----
  editor.registerCommand(
    KEY_DOWN_COMMAND,
    (event: KeyboardEvent) => {
      if (interceptor && interceptor(event)) return true; // 补全框先消费这次按键
      // ★ Backspace 的 chip 原子删除走**这一条**路（E2），不走 KEY_BACKSPACE_COMMAND：
      //   KEY_BACKSPACE_COMMAND 由 core 的 KEY_DOWN（EDITOR=0）派发，而这里在 CRITICAL=4
      //   —— 命令按优先级从高到低派发，所以这条**先于**它跑，能在字符被删掉之前把 chip
      //   整块吃掉；吃到就 preventDefault + return true，core 的 KEY_DOWN 不再执行，
      //   rich-text 的 KEY_BACKSPACE_COMMAND 也就不会被派发（否则 chip 后面的字先没了）。
      //   W9394 之前这里挂 KEY_DOWN 是因为没有任何输入层；现在输入层有了，顺序理由仍然成立。
      //   位置在补全框之后、Enter 判定之前：补全框开着时按键归它，其余按键归这里。
      if (event.key === 'Backspace' && !isImeKey(event)) {
        let ate = false;
        editor.update(
          () => {
            ate = $backspaceChip();
          },
          { discrete: true },
        );
        if (ate) {
          event.preventDefault();
          return true;
        }
      }
      // ★ W9399：非 Enter 键**完全不碰**。enterAction 对非 Enter 一律回 'native'，
      //   若在这里统一 return true，方向键 / 空格 / 字符键都会被我们从 Lexical 的
      //   快捷键链上截断（KEY_DOWN_COMMAND 返回 true = 「这次按键我处理了」，
      //   core 的 $handleKeyDown 不再执行，方向键、空格、Ctrl+C 全哑）。
      if (event.key !== 'Enter') return false;
      const act = enterAction(event, o.isTouch());
      if (act === 'native') {
        // ★ W9399：Shift+Enter 与「触摸端 IME 组合中的 Enter」是**交回浏览器**的车道。
        //   真源：ui/ime.ts 的 isImeKey + ui/inputbar/newline.ts 的 enterAction。
        //
        //   为什么必须在这里就截住：@lexical/rich-text 的 registerRichText 在
        //   KEY_ENTER_COMMAND（EDITOR=0）上注册了处理器，它 preventDefault + 自己在模型里
        //   插换行/段落。而 core 只在 **KEY_DOWN_COMMAND 的处理器**（$handleKeyDown）里
        //   派发 KEY_ENTER_COMMAND；我们在 CRITICAL=4 先跑，return true 把这次按键消费掉
        //   ⇒ $handleKeyDown 不执行 ⇒ rich-text 的处理器永远看不到这次 Enter。
        //
        //   为什么**不** preventDefault：这正是本仓契约（W2028/W2032 真机结论）。
        //   浏览器默认动作照旧发生，Chrome 对 contenteditable 的 Shift+Enter 会发
        //   beforeinput(insertLineBreak)，Lexical 的输入层接住它并在模型里插换行
        //   —— 换行仍然进得来，但 keydown 的 defaultPrevented 保持 false（契约可测）。
        //   触摸端组合中的 Enter 同理：归 IME / 浏览器，我们不抢。
        return true;
      }
      // ★ Lexical 的 onKeyDown **不看** KEY_DOWN_COMMAND 的返回值（它只是 dispatch，
      //   不会替我们 preventDefault），所以「吃掉默认动作」必须在这里显式写。
      if (act === 'swallow') {
        event.preventDefault(); // W2032 桌面 IME：吃掉默认动作，不发送、不换行
        return true;
      }
      event.preventDefault();
      if (act === 'newline') {
        // 触摸端 Enter = 换行。显式建一个空段落并把光标放进去，语义与 textarea 的
        // insertAtCaret 插换行一致（编辑器默认动作在这里已被吃掉，不重复插）。
        editor.update(
          () => {
            const sel = $getSelection();
            if ($isRangeSelection(sel)) sel.insertParagraph();
          },
          { discrete: true },
        );
        return true;
      }
      const text = getCanonicalText();
      o.send(text, act === 'send-other' ? o.otherLane() : o.lane());
      return true;
    },
    COMMAND_PRIORITY_CRITICAL,
  );

  // ---- 粘贴：强制纯文本 + 文件转附件车道（§9.2） ---------------------------------
  editor.registerCommand(
    PASTE_COMMAND,
    (event: PasteCommandType) => {
      // PASTE_COMMAND 的载荷是联合类型（ClipboardEvent | InputEvent | KeyboardEvent）；
      //   只认真的有剪贴板的那一支，其余一律不碰（不猜、不强转）。
      if (!('clipboardData' in event) || !event.clipboardData) return false;
      event.preventDefault();
      const files = clipboardFiles(event);
      if (files.length > 0) o.onFiles?.(files);
      const text = event.clipboardData.getData('text/plain');
      if (text !== '') {
        editor.update(
          () => {
            const sel = $getSelection();
            if ($isRangeSelection(sel)) sel.insertText(text);
          },
          { discrete: true },
        );
      }
      return true;
    },
    COMMAND_PRIORITY_LOW,
  );

  editor.setRootElement(root);
  // 装配时把首帧占位符接过来（index.html 的 data-i18n-placeholder 在 JS 之前填的）。
  const initialPlaceholder = root.getAttribute('placeholder') ?? '';
  if (initialPlaceholder !== '') root.dataset.composerPlaceholder = initialPlaceholder;
  // 首帧的空态标记：装配时编辑器里还没有任何内容。
  root.dataset.empty = getCanonicalText() === '' ? 'true' : 'false';

  const unregisterUpdate = editor.registerUpdateListener(() => {
    const change: ComposerChange = { text: getCanonicalText(), before: getTextBeforeCaret() };
    // 占位符的真源是 data-empty（不是 :empty）—— 见 styles/composer.css 的文件头：
    //   Lexical 根节点恒挂着一个空段落，:empty 永远不匹配。
    root.dataset.empty = change.text === '' ? 'true' : 'false';
    // 一个订阅方抛错不许带走其余订阅方（草稿保存与补全刷新是两条独立的车道）。
    for (const cb of changeCbs) {
      try {
        cb(change);
      } catch {
        /* 同上：不新增诊断点 */
      }
    }
  });

  // placeholder 的 DOM 真源（§9.3：原生 placeholder 属性体系退役 ⇒ CSS :empty::before
  // 读 data-composer-placeholder）。同时定义一个同名的 property：placeholder 是既有
  // 测试与文案门禁读的那个名字，让它们读到**同一个字符串**而不是 undefined。
  let placeholderText = initialPlaceholder;
  Object.defineProperty(root, 'placeholder', {
    configurable: true,
    get: () => placeholderText,
    set: (next: string) => {
      placeholderText = next;
      root.dataset.composerPlaceholder = next;
      root.setAttribute('placeholder', next);
    },
  });

  const adapter: ComposerAdapter = {
    root,
    getCanonicalText,
    getTextBeforeCaret,
    setText: (text: string) => {
      writePlainText(editor, text);
      $placeCaretAt(editor, text.length);
    },
    // ⚠ 这条是**纯文本**路径：整体重写会把已插入的 chip 拍平成文本。
    //   补全框选中命令/技能、@文件 mention、/mcp: 三条插入路径走下面的 insertChip，
    //   只有 fallback（名字拼不出规范形态 / 区间跨段落）才退回到这里。
    replaceRange: (start: number, end: number, text: string) => {
      const full = getCanonicalText();
      const lo = Math.max(0, Math.min(start, end));
      const hi = Math.min(full.length, Math.max(start, end));
      const next = full.slice(0, lo) + text + full.slice(hi);
      writePlainText(editor, next);
      $placeCaretAt(editor, lo + text.length);
    },
    insertChip: (request: ChipInsert) =>
      $insertChip(editor, request.start, request.end, request.kind, request.name, request.trailing),
    refreshChips: (resolve: (kind: ChipKind, name: string) => boolean) =>
      $refreshChipStates(editor, resolve),
    clear: () => writePlainText(editor, ''),
    focus: () => root.focus(),
    getDraftPayload,
    restoreDraft,
    setPlaceholder: (text: string) => {
      (root as unknown as { placeholder: string }).placeholder = text;
    },
    setReadOnly: (readOnly: boolean) => {
      root.setAttribute('contenteditable', readOnly ? 'false' : 'true');
      root.setAttribute('aria-readonly', readOnly ? 'true' : 'false');
    },
    onChange: (cb: (c: ComposerChange) => void) => {
      changeCbs.push(cb);
    },
    setKeyInterceptor: (fn) => {
      interceptor = fn;
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      unregisterUpdate();
      unregisterRichText(); // W9394：输入层的命令处理器也要随编辑器一起摘掉
      editor.setRootElement(null);
      changeCbs.length = 0;
      interceptor = null;
    },
  };
  return adapter;
}
