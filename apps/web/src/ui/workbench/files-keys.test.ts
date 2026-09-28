// @vitest-environment jsdom
// ============================================================================
// W2040 验收（行为）：工作台文件行的**键盘等效路径**。
//
// 守五件事，每件对应一条**变异负控制**（见报告 §5）：
//   ① 行**能**被键盘聚焦（roving tabindex：列表整体 1 个停靠点，行可编程聚焦）；
//   ② **Enter / Space 与 click 等效** —— 目录进入 / 文件预览 / 选中态；
//   ③ 列表的 **Tab 停靠点数量** = 1，与目录条目数**无关**（MAX_DIR_ENTRIES = 200）；
//   ④ **鼠标行为一字不变**：click 的处理器没动，且键鼠两条路的可观测量逐项相同；
//   ⑤ **边界与焦点归属**：↑↓ 钳制不环绕、Home/End 到两端、键盘进目录后焦点接回列表。
//
// ★ 与 tests/w2040-wbrow-keyboard.test.ts 的分工：那个文件守**样式面**
//   （焦点环的 token / 对比度 / 不得被 outline:none 重置）；本文件只守行为。
// ★ 与 apps/web/src/ui/enhance/file-link-keys.test.ts（W2025）的分工：那个文件守
//   **正文路径**（行内元素 ⇒ 一个容器一个停靠点）；本文件守**列表项**（roving）。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  opened: [] as string[],
  calls: [] as string[],
  tree: {} as Record<string, { name: string; type: string }[]>,
}));

vi.mock('./files-open', () => ({
  openFilePreview: (abs: string) => { h.opened.push(abs); },
}));
vi.mock('../commands/files', () => ({ workspacePath: () => '/ws' }));
vi.mock('../../api', () => ({
  api: {
    fsList: async (path: string) => {
      h.calls.push(path);
      const entries = h.tree[path] ?? [];
      return { path, parent: null, entries, roots: [], truncated: false };
    },
  },
}));

import { renderFilesPanel } from './files';
import { nextIndex, ROW_SEL } from './files-keys';
import type { PanelState } from './state';

/** 造一个面板状态（renderFilesPanel 只读 id / data）。 */
function panel(): PanelState {
  return { id: 'wb1', kind: 'files', title: 'F', dock: 'right', size: 420, seq: 0, data: { path: '/ws', selected: null } };
}

let body: HTMLElement;
let seq = 0;

/** 渲染一帧（isCurrent 恒真：竞态不是本文件的被测对象，g4-workbench 守它）。 */
async function render(p: PanelState): Promise<void> {
  seq += 1;
  await renderFilesPanel(body, p, seq, () => true);
}

const rows = (): HTMLElement[] => Array.from(body.querySelectorAll<HTMLElement>(ROW_SEL));
const names = (): string[] => rows().map((r) => r.querySelector('.wb-name')?.textContent ?? '');
const stops = (): HTMLElement[] => Array.from(body.querySelectorAll<HTMLElement>(ROW_SEL + '[tabindex="0"]'));

/** 在元素上派发一次可取消的 keydown（真机上由浏览器产生；jsdom 里手工构造）。 */
function keyOn(el: Element, key: string): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
}
function clickOn(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/** 等一轮导航：目录进入是 async 的（renderFilesPanel 在处理器里被 void 调用）。 */
const flushNav = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const ENTRIES = [
  { name: 'docs', type: 'dir' }, { name: 'src', type: 'dir' },
  { name: 'a.ts', type: 'file' }, { name: 'b.ts', type: 'file' }, { name: 'c.ts', type: 'file' },
];

beforeEach(() => {
  h.opened.length = 0;
  h.calls.length = 0;
  h.tree = {
    '/ws': ENTRIES,
    '/ws/docs': [{ name: 'guide.md', type: 'file' }],
    '/ws/src': [{ name: 'index.ts', type: 'file' }],
  };
  document.body.replaceChildren();
  body = document.createElement('div');
  body.className = 'wb-body';
  document.body.appendChild(body);
  seq = 0;
});

afterEach(() => { document.body.replaceChildren(); });

describe('W2040 ①③ 可聚焦性与 Tab 停靠点数量', () => {
  it('① 每一行都能被键盘聚焦（tabindex + role=button + 可读名字）', async () => {
    await render(panel());
    expect(rows().length).toBe(5);
    for (const r of rows()) {
      expect(r.hasAttribute('tabindex'), '行必须带 tabindex（否则 focus() 是死操作）').toBe(true);
      expect(r.getAttribute('role')).toBe('button');
      expect((r.title ?? '').length, '4.1.2：自定义控件必须有可编程判定的名字').toBeGreaterThan(0);
      r.focus();
      expect(document.activeElement, '真机同款判据：focus() 之后 activeElement 必须就是它').toBe(r);
    }
  });

  it('③ 列表整体只有 1 个 Tab 停靠点，与条目数无关（12 条目录）', async () => {
    h.tree['/ws'] = Array.from({ length: 12 }, (_, i) => ({ name: 'f' + String(i) + '.ts', type: 'file' }));
    await render(panel());
    expect(rows().length).toBe(12);
    expect(stops().length, 'roving tabindex：12 行也只占 1 个停靠点').toBe(1);
    expect(rows()[0]?.getAttribute('tabindex'), '停靠点落在第一行').toBe('0');
    expect(body.querySelectorAll('[tabindex="-1"]').length).toBe(11);
  });

  it('③b 方向键移动的是**停靠点本身**（停靠点始终唯一，且跟着焦点走）', async () => {
    await render(panel());
    const r = rows();
    (r[0] as HTMLElement).focus();
    for (const i of [1, 2, 3]) {
      keyOn(r[i - 1] as HTMLElement, 'ArrowDown');
      expect(stops().length, '任何时刻都只有 1 个停靠点').toBe(1);
      expect(document.activeElement).toBe(r[i]);
      expect((r[i] as HTMLElement).getAttribute('tabindex')).toBe('0');
      expect((r[i - 1] as HTMLElement).getAttribute('tabindex')).toBe('-1');
    }
  });

  it('③c 空目录 / 只有提示文案时，没有停靠点、也没有异常', async () => {
    h.tree['/ws'] = [];
    await render(panel());
    expect(rows().length).toBe(0);
    expect(stops().length).toBe(0);
    expect(body.querySelector('.wb-notice')?.textContent ?? '').not.toBe('');
  });
});

describe('W2040 ② Enter / Space 与 click 等效', () => {
  it('②a 目录行：Enter 进入目录，且**与 click 走同一条路**（请求序列逐项相同）', async () => {
    // 鼠标：新面板（data.path 从工作区根起）→ 点第二行（src）
    await render(panel());
    clickOn(rows()[1] as HTMLElement);
    await flushNav();
    const byClick = h.calls.slice();
    const namesByClick = names();
    expect(byClick, '鼠标路径：进入 /ws/src').toEqual(['/ws', '/ws/src']);
    expect(namesByClick, '鼠标真的进了新目录').toEqual(['index.ts']);
    // 键盘：同样一个新面板 → Enter 第二行
    h.calls.length = 0;
    await render(panel());
    const ev = keyOn(rows()[1] as HTMLElement, 'Enter');
    await flushNav();
    expect(ev.defaultPrevented, '真的接管了这次按键（否则浏览器还会做默认动作）').toBe(true);
    expect(h.calls, '键盘路径必须产生**同一个**请求序列').toEqual(byClick);
    expect(names(), '两边都真的进了新目录').toEqual(namesByClick);
  });

  it('②b 文件行：Space 打开预览，与 click 打开**同一个绝对路径**', async () => {
    await render(panel());
    const byClick = (() => { clickOn(rows()[2] as HTMLElement); return h.opened.slice(); })();
    expect(byClick).toEqual(['/ws/a.ts']);
    h.opened.length = 0;
    await render(panel());
    const ev = keyOn(rows()[2] as HTMLElement, ' ');
    expect(h.opened, 'Space 必须与 click 打开同一个文件').toEqual(byClick);
    expect(ev.defaultPrevented, 'Space 必须吞掉，否则面板会滚一屏').toBe(true);
    expect(rows()[2]?.classList.contains('sel'), '选中态也走同一个处理器').toBe(true);
  });

  it('②c Enter 在文件行上同样等效（两个激活键都要能用）', async () => {
    await render(panel());
    clickOn(rows()[3] as HTMLElement);
    const byClick = h.opened.slice();
    h.opened.length = 0;
    await render(panel());
    keyOn(rows()[3] as HTMLElement, 'Enter');
    expect(h.opened).toEqual(byClick);
  });

  it('②d 非激活键不触发任何动作（Backspace / 字母 / Tab 都不许打开文件）', async () => {
    await render(panel());
    for (const k of ['Backspace', 'a', 'Tab', 'Escape', 'PageDown']) keyOn(rows()[2] as HTMLElement, k);
    expect(h.opened).toEqual([]);
    expect(h.calls).toEqual(['/ws']); // 只有首帧那一次列举
  });

  it('②e 事件落点不在行上时什么都不做（不猜、不兜底到第一行）', async () => {
    await render(panel());
    const list = body.querySelector('.wb-list') as HTMLElement;
    const ev = keyOn(list, 'Enter');
    expect(h.opened).toEqual([]);
    expect(ev.defaultPrevented, '没有目标行 ⇒ 连 preventDefault 都不该做').toBe(false);
  });
});

describe('W2040 ④ 鼠标行为一字不变', () => {
  it('④a click 仍然选中文件并打开预览（既有处理器没被替换）', async () => {
    await render(panel());
    clickOn(rows()[2] as HTMLElement);
    expect(h.opened).toEqual(['/ws/a.ts']);
    expect(rows()[2]?.classList.contains('sel')).toBe(true);
    expect(rows().filter((r) => r.classList.contains('sel')).length, '同面板内互斥').toBe(1);
  });

  it('④b 鼠标点击**不**移动 Tab 停靠点（Tab 永远从第一行进列表，行为可预期）', async () => {
    await render(panel());
    clickOn(rows()[4] as HTMLElement);
    expect(stops().length).toBe(1);
    expect(stops()[0]).toBe(rows()[0]);
  });

  it('④c 键盘激活**不**改变 click 的可观测量（同一行两条路：选中集合 + 打开目标一致）', async () => {
    // 鼠标：全新面板 → 点第三行（a.ts）
    await render(panel());
    clickOn(rows()[2] as HTMLElement);
    const selAfterClick = rows().filter((r) => r.classList.contains('sel')).map((r) => r.querySelector('.wb-name')?.textContent ?? '');
    const openedByClick = h.opened.slice();
    expect(selAfterClick).toEqual(['a.ts']);
    expect(openedByClick).toEqual(['/ws/a.ts']);
    // 键盘：同样全新面板 → Enter 第三行
    h.opened.length = 0;
    await render(panel());
    keyOn(rows()[2] as HTMLElement, 'Enter');
    const selAfterKey = rows().filter((r) => r.classList.contains('sel')).map((r) => r.querySelector('.wb-name')?.textContent ?? '');
    expect(selAfterKey, '选中集合逐项相同').toEqual(selAfterClick);
    expect(h.opened, '打开目标逐项相同').toEqual(openedByClick);
  });
});

describe('W2040 ⑤ 边界、Home/End 与焦点归属', () => {
  it('⑤a ↑ 在首行、↓ 在末行都**钳制**（不环绕 —— 位移必须可预期）', async () => {
    await render(panel());
    const r = rows();
    (r[0] as HTMLElement).focus();
    keyOn(r[0] as HTMLElement, 'ArrowUp');
    expect(document.activeElement, '首行按 ↑ 停在首行').toBe(r[0]);
    (r[4] as HTMLElement).focus();
    keyOn(r[4] as HTMLElement, 'ArrowDown');
    expect(document.activeElement, '末行按 ↓ 停在末行').toBe(r[4]);
  });

  it('⑤b Home / End 到两端', async () => {
    await render(panel());
    const r = rows();
    (r[2] as HTMLElement).focus();
    keyOn(r[2] as HTMLElement, 'End');
    expect(document.activeElement).toBe(r[4]);
    keyOn(r[4] as HTMLElement, 'Home');
    expect(document.activeElement).toBe(r[0]);
  });

  it('⑤c 方向键必须 preventDefault（否则面板会滚一屏）', async () => {
    await render(panel());
    const ev = keyOn(rows()[0] as HTMLElement, 'ArrowDown');
    expect(ev.defaultPrevented).toBe(true);
    const ev2 = keyOn(rows()[1] as HTMLElement, 'Home');
    expect(ev2.defaultPrevented).toBe(true);
  });

  it('⑤d 键盘进入目录后焦点接回**新列表**（不是掉回 body，也不是被鼠标路径夺走）', async () => {
    await render(panel());
    keyOn(rows()[1] as HTMLElement, 'Enter');
    await flushNav();
    expect(names()).toEqual(['index.ts']);
    expect(document.activeElement, '焦点必须落在新列表的第一行').toBe(rows()[0]);
    // 鼠标路径**不**夺焦：点目录进入后 activeElement 不被本模块改动
    (document.activeElement as HTMLElement | null)?.blur();
    h.calls.length = 0;
    await render(panel());
    clickOn(rows()[0] as HTMLElement);
    await flushNav();
    expect(names()).toEqual(['guide.md']);
    expect(document.activeElement, '鼠标导航不得被本模块夺焦').toBe(document.body);
  });
});

describe('W2040 ⑤e nextIndex 是唯一判定真源（纯函数，直接打它）', () => {
  it('键 → 下标：↑↓ 钳制、Home/End 到端、非导航键 null', () => {
    expect(nextIndex('ArrowDown', 0, 5)).toBe(1);
    expect(nextIndex('ArrowDown', 4, 5)).toBe(4);
    expect(nextIndex('ArrowUp', 0, 5)).toBe(0);
    expect(nextIndex('ArrowUp', 4, 5)).toBe(3);
    expect(nextIndex('Home', 3, 5)).toBe(0);
    expect(nextIndex('End', 1, 5)).toBe(4);
    for (const k of ['Enter', ' ', 'Tab', 'a', 'Escape']) expect(nextIndex(k, 1, 5)).toBeNull();
  });

  it('空列表 / 越界起点都不抛、不返回 NaN 化的下标', () => {
    expect(nextIndex('ArrowDown', 0, 0)).toBeNull();
    expect(nextIndex('Home', 0, 0)).toBeNull();
    expect(nextIndex('ArrowDown', -7, 3)).toBe(1); // 起点先钳到 [0, last]
    expect(nextIndex('ArrowUp', 99, 3)).toBe(1);
  });
});
