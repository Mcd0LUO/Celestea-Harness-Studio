// @vitest-environment jsdom
/**
 * W9394 · 输入栏的 **DOM→模型输入层**（「一个字都敲不进去」的回归面）。
 * ----------------------------------------------------------------------------
 * 缺陷：`#input` 是 Lexical 的 contenteditable，能聚焦，但敲键盘 / Input.insertText /
 *   execCommand('insertText') 全都留不下字，DOM 立刻被 reconciler 按空模型抹平，console 无报错。
 *
 * 根因：core 的 beforeinput 处理会 `preventDefault()` 掉浏览器默认动作，然后把「该插什么」
 *   派发成命令（CONTROLLED_TEXT_INSERTION_COMMAND / DELETE_CHARACTER_COMMAND /
 *   INSERT_PARAGRAPH_COMMAND …）—— 这些命令的**处理器**在 @lexical/rich-text，不在 core。
 *   只 createEditor + setRootElement 的编辑器于是「默认动作被吃掉 + 命令无人接」。
 *
 * 本文件钉的就是「命令有人接」：不模拟 jsdom 造不出的 beforeinput（jsdom 的 InputEvent 没有
 *   getTargetRanges ⇒ CAN_USE_BEFORE_INPUT=false，真机路径在 scripts/a11y 的探针里验），
 *   而是直接派发 core 在真实按键上会派发的那几条命令，断言**模型文本真的变了**。
 *
 * ★ 变异负控制：注释掉 lexical.ts 里的 `registerRichText(editor)` ⇒ 本文件必红
 *   （命令表里找不到处理器，dispatch 返回 false，模型文本原地不动）。
 *
 * 为什么经 `__lexicalEditor` / `_commands` 读内部：适配缝（adapter.ts）**刻意不暴露**编辑器
 *   实例（消费方只许走文本读写），而本用例要验的恰好是编辑器内部的命令注册。这两个名字是
 *   Lexical 在 setRootElement 时写在 root 元素上的公开事实（core 的 getEditorPropertyFromDOMNode
 *   读的就是它），不是本仓自造的钩子。
 * ========================================================================== */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { doc, resetHarness } from './lib/w795-dom.js';
import { type EditorRoot, loadComposer, mountOn } from './lib/composer-dom.js';

interface LexicalCommandLike {
  readonly type?: string;
}
interface EditorLike {
  update(fn: () => void, opts?: { discrete?: boolean }): void;
  dispatchCommand(command: unknown, payload?: unknown): boolean;
  _commands: Map<LexicalCommandLike, unknown>;
}

function newRoot(): EditorRoot {
  const el = doc.createElement('div');
  el.id = 'input';
  doc.body.appendChild(el);
  return el as unknown as EditorRoot;
}

function editorOf(root: EditorRoot): EditorLike {
  const editor = (root as unknown as { __lexicalEditor?: EditorLike }).__lexicalEditor;
  if (!editor) throw new Error('编辑器没挂到 root 上：__lexicalEditor 缺失');
  return editor;
}

function commandOf(editor: EditorLike, type: string): LexicalCommandLike | null {
  for (const command of editor._commands.keys()) {
    if (command.type === type) return command;
  }
  return null;
}

/** 在 update 事务里派发一条命令（与 core 在真实事件回调里的做法同形）。 */
function dispatch(editor: EditorLike, type: string, payload?: unknown): boolean {
  let handled = false;
  editor.update(
    () => {
      const command = commandOf(editor, type);
      handled = command !== null && editor.dispatchCommand(command, payload);
    },
    { discrete: true },
  );
  return handled;
}

beforeEach(() => {
  resetHarness();
  vi.resetModules();
});
afterEach(() => {
  doc.body.replaceChildren();
});

describe('W9394 · 输入层已接线：core 派发的命令必须有人接住', () => {
  it('打字：CONTROLLED_TEXT_INSERTION_COMMAND 插字，模型文本与光标前文本真的出现', async () => {
    const root = newRoot();
    const h = await mountOn(root);
    const editor = editorOf(root);
    const mod = await loadComposer();
    h.type('');
    expect(
      commandOf(editor, 'CONTROLLED_TEXT_INSERTION_COMMAND'),
      '输入层未接线：CONTROLLED_TEXT_INSERTION_COMMAND 没有处理器（registerRichText 没跑？）',
    ).not.toBeNull();
    expect(dispatch(editor, 'CONTROLLED_TEXT_INSERTION_COMMAND', 'hello')).toBe(true);
    expect(h.text(), '★ 敲进去的字必须落在模型里（不是空）').toBe('hello');
    // 后果的第二半：补全引擎读的是「光标前文本」，它必须跟着模型一起长出来。
    expect(mod.textBeforeCaret(), '光标前文本必须就是刚敲进去的那段').toBe('hello');
  });

  // 退格 / 输入法 / 粘贴在 jsdom 里量不到后果（jsdom 的 deleteCharacter 不落状态、
  // InputEvent 没有 getTargetRanges ⇒ core 的 beforeinput 层在 jsdom 里不启用），
  // 这三条由 scripts/a11y/w9394-lexical-input-probe.mjs 的**真机**用例守（Chrome + 真键盘事件）。

  it('换行：INSERT_PARAGRAPH_COMMAND 插一个段落（Shift+Enter 的 native 车道靠它）', async () => {
    const root = newRoot();
    const h = await mountOn(root);
    const editor = editorOf(root);
    h.type('ab');
    expect(commandOf(editor, 'INSERT_PARAGRAPH_COMMAND'), '换行没有处理器').not.toBeNull();
    expect(dispatch(editor, 'INSERT_PARAGRAPH_COMMAND')).toBe(true);
    expect(h.text()).toBe('ab\n');
  });

  it('对照：命令名对不上时不该假装成功（防「恒真」断言）', async () => {
    const root = newRoot();
    const h = await mountOn(root);
    const editor = editorOf(root);
    h.type('ab');
    expect(commandOf(editor, 'NO_SUCH_COMMAND_W9394')).toBeNull();
    expect(h.text()).toBe('ab');
  });

  // ★ W9399：补全框的**键盘**选中（Enter）与鼠标选中走的是两条不同的上下文。
  //   键盘那条：KEY_DOWN_COMMAND 的监听器被 Lexical 用 updateEditorSync 包在一次
  //   update 事务里跑 ⇒ 适配缝里再调 editor.update() 会被**排队**，回调要等外层事务
  //   收尾才执行。旧实现据此在回调里置的 done 恒为 false ⇒ applyGesture 误判
  //   「chip 插不进去」而退回纯文本（投影一样、但 chip 没了）。本用例把「事务内插入」
  //   钉成一个同步返回 true 的契约。
  it('键盘车道里插 chip：命令处理器（update 事务内）调用 insertChip 必须真插进去', async () => {
    const root = newRoot();
    const h = await mountOn(root);
    const editor = editorOf(root);
    const mod = (await loadComposer()) as unknown as {
      canonicalText(): string;
      insertComposerChip(r: { kind: string; name: string; start: number; end: number; trailing: string }): boolean;
    };
    h.type('/goal');
    const keydown = commandOf(editor, 'KEYDOWN_COMMAND');
    expect(keydown, 'KEYDOWN_COMMAND 必须已注册（core 的 $handleKeyDown）').not.toBeNull();
    let inserted: boolean | null = null;
    (editor as unknown as {
      registerCommand(c: unknown, fn: (e: { key?: string }) => boolean, p: number): () => void;
    }).registerCommand(
      keydown,
      (e) => {
        if (e.key !== 'F2') return false; // 非 Enter 键：交给本用例自己的车道
        inserted = mod.insertComposerChip({
          kind: 'command',
          name: 'goal',
          start: 0,
          end: mod.canonicalText().length,
          trailing: ' ',
        });
        return true;
      },
      4,
    );
    h.press({ key: 'F2' });
    expect(inserted, '★ 事务内插入必须同步返回 true（旧实现恒 false ⇒ 退回纯文本）').toBe(true);
    expect(h.text(), '投影 = 规范形态').toBe('/goal ');
    const chips = (root as unknown as { querySelectorAll(s: string): ArrayLike<unknown> })
      .querySelectorAll('.composer-chip');
    expect(chips.length, '★ 输入框里必须真的有一个 chip 节点，不是纯文本').toBe(1);
  });
});