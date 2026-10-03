// ============================================================================
// F4-05 · theme.ts 在**无 DOM 环境**下不得抛。
//
// 本文件**刻意不开** jsdom —— 它跑在 vitest 的默认 node 环境里，`document` 根本不存在。
// 理由：vitest.config.ts 没有全局 `environment` 配置（要 DOM 靠每个文件顶部的
// 「@vitest-environment + 环境名」docblock 头），所以「未加该头、又 import 了
// theme.ts」是这个仓库里随时可能发生的事。
//
// ★ 实测踩过的坑（这里刻意不提那个 docblock 标记的字面量）：我第一版注释里
//   **把它原文写了出来**，vitest 的 docblock 解析器照样命中 → 本文件被静默加上
//   jsdom → 「document 不存在」的前置断言失败、initTheme 还能读到前一个用例写进
//   localStorage 的 'dark'。**注释里写出该标记字面量 = 打开它。**
//
// 修复前实测：
//   ReferenceError: document is not defined   ← currentTheme() / applyTheme()
//
// 读侧回落 'mono'（与 README 记录的默认一致）；写侧在无 DOM 时不假装成功，
// 但 localStorage 仍尽力写（node/worker 下可能可用）。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { at } from './lib/w795-dom.js';

interface ThemeMod {
  currentTheme(): string;
  applyTheme(id: string): void;
  initTheme(defaultId?: string): string;
  themes(): ReadonlyArray<{ id: string }>;
}

// `at()` 返回**运行时算出来的 file:// URL 字符串**（不是字面量）—— 根 typecheck 的
// program 看不见 apps/web（它不在 tsconfig 的 include 里），所以这一行不会把
// apps/web/src/theme.ts 拖进 NodeNext 工程。与仓内其它前端测试同一写法（w9203 等）。
const load = async (): Promise<ThemeMod> =>
  (await import(/* @vite-ignore */ at('theme.ts'))) as ThemeMod;

describe('F4-05 · theme.ts 无 DOM 环境', () => {
  it('前置条件：本文件确实没有 document（否则本文件是自证）', () => {
    // 走 globalThis 间接读：根 typecheck 的 lib 不含 dom（tsconfig.base 的 lib 是
    // ES2023，apps/web 由自己的 tsconfig 管），直接写 `document` 会报 TS2584。
    // 运行时语义完全一样 —— 这里要断言的正是「这个全局上**没有** document」。
    const g = globalThis as Record<string, unknown>;
    expect(typeof g['document'], '没开 jsdom ⇒ document 不存在').toBe('undefined');
    expect(typeof g['window']).toBe('undefined');
  });

  it('currentTheme() 回落默认主题，不抛', async () => {
    const m = await load();
    expect(() => m.currentTheme()).not.toThrow();
    expect(m.currentTheme()).toBe('mono');
  });

  it('applyTheme() 无 DOM 时不抛', async () => {
    const m = await load();
    expect(() => m.applyTheme('dark')).not.toThrow();
  });

  it('initTheme() 无 DOM 时不抛；无 localStorage ⇒ 用传入的默认 id', async () => {
    const m = await load();
    let got = '';
    expect(() => { got = m.initTheme('mono'); }).not.toThrow();
    // 本环境没有 localStorage（前置用例已断言），所以只能读到默认值。
    expect(got, '读不到持久化值时用调用方给的默认 id').toBe('mono');
  });

  it('themes() 是纯函数，无 DOM 也能取到全部主题', async () => {
    const m = await load();
    expect(() => m.themes()).not.toThrow();
    expect(m.themes().map((x) => x.id)).toEqual(['mono', 'dark', 'claude']);
  });
});