// @vitest-environment jsdom
// ============================================================================
// W2053 验收（行为面）：5 处「<div>/<tr> + 只有 click」的键盘可达。
//
// 与 W2040 的分工：那个文件守工作台文件行（.wb-row，roving 的第一份实现）；
//   本文件守**共享内核**（ui/roving.ts）与另外 4 处接线：
//     · 会话树叶子 .sess-leaf（render.ts）—— 用户每天用的核心交互
//     · worker 行 .ws-worker-row / worker 分组头 .ws-worker-parent（workers.ts）
//     · 目录浏览弹层的目录行 .ws-fs-dir（fsbrowser.ts）
//     · 提供商表行 tr.prov-row（providers/panel.ts）—— ★ 唯一**不走 roving** 的一处
//
// 守七件事，每件对应一条**变异负控制**（见报告 §5）：
//   ① 行**能**被键盘聚焦（roving 行 tabindex=-1 可编程聚焦；表格行 tabindex=0 进序列）；
//   ② **Enter / Space 与 click 等效**（走 row.click()，同一处理器）；
//   ③ **Tab 停靠点数量**符合逐处选定的模型（roving ⇒ 容器整体 1 个）；
//   ④ **鼠标行为一字不变**（click 处理器没动；鼠标路径不夺焦、不移停靠点）；
//   ⑤ **边界**：↑↓ 钳制不环绕、Home/End 到两端、非导航键不吞；
//   ⑥ **IME 守卫**：组合中的 Enter 不触发激活（共享判据 isImeKey）；
//   ⑦ **可达性与展开接管**（W2053 新增）：折叠 <details> 里的行不占停靠点；
//      展开后停靠点交给组内第一行（否则整组永远进不去）。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ACTIVATE_KEYS,
  ROVING_ROW,
  bindRoving,
  isReachable,
  markRowButton,
  nextIndex,
  resetStops,
  rowsOf,
} from './roving';

/** 造一帧行（与渲染侧同一形状：标记属性由 markRowButton 写）。 */
function makeList(count: number, tag = 'div'): { list: HTMLElement; rows: HTMLElement[] } {
  const list = document.createElement('div');
  const rows: HTMLElement[] = [];
  for (let i = 0; i < count; i += 1) {
    const row = document.createElement(tag);
    row.textContent = 'row' + String(i);
    markRowButton(row);
    list.appendChild(row);
    rows.push(row);
  }
  document.body.appendChild(list);
  return { list, rows };
}

const keyOn = (el: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(ev);
  return ev;
};
const clickOn = (el: Element): void => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};
const stops = (root: ParentNode = document.body): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(ROVING_ROW + '[tabindex="0"]'));

beforeEach(() => { document.body.replaceChildren(); });
afterEach(() => { document.body.replaceChildren(); });

describe('W2053 内核 ①③ 可聚焦性与 Tab 停靠点数量', () => {
  it('① 每一行都能被键盘聚焦（标记 + tabindex + role）', () => {
    const { list, rows } = makeList(5);
    bindRoving(list);
    for (const r of rows) {
      expect(r.hasAttribute('data-roving'), '行必须带 roving 标记（键盘通道认行的唯一依据）').toBe(true);
      expect(r.getAttribute('role')).toBe('button');
      r.focus();
      expect(document.activeElement, '真机同款判据：focus() 之后 activeElement 必须就是它').toBe(r);
    }
  });

  it('①b 给了 label 就写 aria-label；不给则靠内容取名（两条路都有名字）', () => {
    const explicit = document.createElement('div');
    markRowButton(explicit, '主会话');
    expect(explicit.getAttribute('aria-label'), '4.1.2：显式名字').toBe('主会话');
    // 不给 label：不写 aria-label，名字由内容提供（工作台文件行就是这条）
    const implicit = document.createElement('div');
    implicit.textContent = 'README.md';
    markRowButton(implicit);
    expect(implicit.hasAttribute('aria-label'), '不给 label 就不该写一个空 aria-label').toBe(false);
    expect(implicit.textContent, '内容即名字').toBe('README.md');
  });

  it('③ 容器整体只有 1 个 Tab 停靠点，与行数无关（40 行）', () => {
    const { list, rows } = makeList(40);
    bindRoving(list);
    expect(rows.length).toBe(40);
    expect(stops(list).length, 'roving：40 行也只占 1 个停靠点').toBe(1);
    expect(rows[0]?.getAttribute('tabindex'), '停靠点落在第一行').toBe('0');
    expect(list.querySelectorAll('[tabindex="-1"]').length).toBe(39);
  });

  it('③b 方向键移动的是**停靠点本身**（停靠点始终唯一，且跟着焦点走）', () => {
    const { list, rows } = makeList(4);
    bindRoving(list);
    (rows[0] as HTMLElement).focus();
    for (const i of [1, 2, 3]) {
      keyOn(rows[i - 1] as HTMLElement, 'ArrowDown');
      expect(stops(list).length, '任何时刻都只有 1 个停靠点').toBe(1);
      expect(document.activeElement).toBe(rows[i]);
      expect((rows[i] as HTMLElement).getAttribute('tabindex')).toBe('0');
      expect((rows[i - 1] as HTMLElement).getAttribute('tabindex')).toBe('-1');
    }
  });

  it('③c 空列表：没有停靠点、也没有异常', () => {
    const { list } = makeList(0);
    bindRoving(list);
    expect(stops(list).length).toBe(0);
    expect(() => keyOn(list, 'ArrowDown')).not.toThrow();
  });
});

describe('W2053 内核 ② Enter / Space 与 click 等效', () => {
  it('②a Enter 触发 click（**同一个**处理器：等效性由构造保证）', () => {
    const { list, rows } = makeList(3);
    bindRoving(list);
    let clicked = 0;
    (rows[1] as HTMLElement).addEventListener('click', () => { clicked += 1; });
    const ev = keyOn(rows[1] as HTMLElement, 'Enter');
    expect(clicked).toBe(1);
    expect(ev.defaultPrevented, '真的接管了这次按键').toBe(true);
  });

  it('②b Space 同样激活，且必须吞掉（否则面板滚一屏）', () => {
    const { list, rows } = makeList(3);
    bindRoving(list);
    let clicked = 0;
    (rows[2] as HTMLElement).addEventListener('click', () => { clicked += 1; });
    const ev = keyOn(rows[2] as HTMLElement, ' ');
    expect(clicked).toBe(1);
    expect(ev.defaultPrevented).toBe(true);
    expect(ACTIVATE_KEYS.has(' ')).toBe(true);
  });

  it('②c 非激活键不触发任何动作（字母 / Backspace / Tab 都不许激活）', () => {
    const { list, rows } = makeList(3);
    bindRoving(list);
    let clicked = 0;
    (rows[0] as HTMLElement).addEventListener('click', () => { clicked += 1; });
    for (const k of ['a', 'Backspace', 'Tab', 'PageDown']) keyOn(rows[0] as HTMLElement, k);
    expect(clicked).toBe(0);
  });

  it('②d 事件落点不在行上时什么都不做（不猜、不兜底到第一行）', () => {
    const { list } = makeList(3);
    bindRoving(list);
    let clicked = 0;
    list.addEventListener('click', () => { clicked += 1; });
    const ev = keyOn(list, 'Enter');
    expect(clicked).toBe(0);
    expect(ev.defaultPrevented, '没有目标行 ⇒ 连 preventDefault 都不该做').toBe(false);
  });

  it('②e 行内控件自己持键：在 ⋯ / 勾选框上按 Enter **不**触发行的激活', () => {
    const list = document.createElement('div');
    const row = document.createElement('div');
    markRowButton(row);
    const kebab = document.createElement('button');
    row.appendChild(kebab);
    list.appendChild(row);
    document.body.appendChild(list);
    bindRoving(list);
    let rowClicks = 0;
    row.addEventListener('click', () => { rowClicks += 1; });
    keyOn(kebab, 'Enter');
    expect(rowClicks, '一次按键只能有一个动作：⋯ 上的 Enter 归 ⋯').toBe(0);
    // 行本体上仍然照常
    keyOn(row, 'Enter');
    expect(rowClicks).toBe(1);
  });
});

describe('W2053 内核 ⑤ 边界、Home/End 与 preventDefault', () => {
  it('⑤a ↑ 在首行、↓ 在末行都**钳制**（不环绕 —— 位移必须可预期）', () => {
    const { list, rows } = makeList(3);
    bindRoving(list);
    (rows[0] as HTMLElement).focus();
    keyOn(rows[0] as HTMLElement, 'ArrowUp');
    expect(document.activeElement, '首行按 ↑ 停在首行').toBe(rows[0]);
    (rows[2] as HTMLElement).focus();
    keyOn(rows[2] as HTMLElement, 'ArrowDown');
    expect(document.activeElement, '末行按 ↓ 停在末行').toBe(rows[2]);
  });

  it('⑤b Home / End 到两端，且都 preventDefault', () => {
    const { list, rows } = makeList(5);
    bindRoving(list);
    (rows[2] as HTMLElement).focus();
    expect(keyOn(rows[2] as HTMLElement, 'End').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(rows[4]);
    expect(keyOn(rows[4] as HTMLElement, 'Home').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(rows[0]);
  });

  it('⑤c nextIndex 是唯一判定真源（纯函数，直接打它）', () => {
    expect(nextIndex('ArrowDown', 0, 5)).toBe(1);
    expect(nextIndex('ArrowDown', 4, 5)).toBe(4);
    expect(nextIndex('ArrowUp', 0, 5)).toBe(0);
    expect(nextIndex('ArrowUp', 4, 5)).toBe(3);
    expect(nextIndex('Home', 3, 5)).toBe(0);
    expect(nextIndex('End', 1, 5)).toBe(4);
    for (const k of ['Enter', ' ', 'Tab', 'a', 'Escape']) expect(nextIndex(k, 1, 5)).toBeNull();
    expect(nextIndex('ArrowDown', 0, 0)).toBeNull();
    expect(nextIndex('Home', 0, 0)).toBeNull();
    expect(nextIndex('ArrowDown', -7, 3)).toBe(1); // 起点先钳到 [0, last]
    expect(nextIndex('ArrowUp', 99, 3)).toBe(1);
  });
});

describe('W2053 内核 ⑥ IME 守卫（共享判据）', () => {
  it('⑥ 组合会话中的 Enter / Space 不触发激活（isComposing）', () => {
    const { list, rows } = makeList(2);
    bindRoving(list);
    let clicked = 0;
    (rows[0] as HTMLElement).addEventListener('click', () => { clicked += 1; });
    keyOn(rows[0] as HTMLElement, 'Enter', { isComposing: true });
    keyOn(rows[0] as HTMLElement, ' ', { isComposing: true });
    expect(clicked, '组合中的按键归输入法').toBe(0);
  });

  it('⑥b keyCode 229（compositionend 早于 keydown 的那一次）同样被守卫', () => {
    const { list, rows } = makeList(2);
    bindRoving(list);
    let clicked = 0;
    (rows[0] as HTMLElement).addEventListener('click', () => { clicked += 1; });
    keyOn(rows[0] as HTMLElement, 'Enter', { keyCode: 229 });
    expect(clicked).toBe(0);
  });

  it('⑥c 方向键在组合中同样不动焦点（守卫在方向键分支之前）', () => {
    const { list, rows } = makeList(3);
    bindRoving(list);
    (rows[0] as HTMLElement).focus();
    keyOn(rows[0] as HTMLElement, 'ArrowDown', { isComposing: true });
    expect(document.activeElement, '组合中按 ↓ 属于输入法候选词翻页').toBe(rows[0]);
  });
});

describe('W2053 内核 ⑦ 可达性与展开接管（会话树的折叠分组）', () => {
  /** 造一棵「可折叠分组 + 组内行」的树（与 .ws-details/.ws-body 同构）。 */
  function makeTree(): { tree: HTMLElement; det: HTMLDetailsElement; rows: HTMLElement[] } {
    const tree = document.createElement('div');
    const det = document.createElement('details');
    det.open = true;
    const sum = document.createElement('summary');
    sum.textContent = 'ws';
    det.appendChild(sum);
    const rows: HTMLElement[] = [];
    for (let i = 0; i < 3; i += 1) {
      const row = document.createElement('div');
      markRowButton(row);
      det.appendChild(row);
      rows.push(row);
    }
    tree.appendChild(det);
    document.body.appendChild(tree);
    return { tree, det, rows };
  }

  it('⑦a 折叠组里的行**够不着**（DOM 结构判据，与真机一致）', () => {
    const { det, rows } = makeTree();
    expect(isReachable(rows[0] as HTMLElement)).toBe(true);
    det.open = false;
    expect(isReachable(rows[0] as HTMLElement), '折叠 <details> 里的行不可聚焦').toBe(false);
  });

  it('⑦b 停靠点只落在**够得着的**第一行（首组折叠 ⇒ 跳过它，不是留下死停靠点）', () => {
    const tree = document.createElement('div');
    const mk = (open: boolean): { det: HTMLDetailsElement; row: HTMLElement } => {
      const det = document.createElement('details');
      det.open = open;
      const row = document.createElement('div');
      markRowButton(row);
      det.appendChild(row);
      tree.appendChild(det);
      return { det, row };
    };
    const a = mk(false); // 折叠
    const b = mk(true);
    document.body.appendChild(tree);
    bindRoving(tree);
    expect(a.row.getAttribute('tabindex'), '折叠组里的行**不**占停靠点').toBe('-1');
    expect(b.row.getAttribute('tabindex'), '停靠点交给第一个够得着的行').toBe('0');
    expect(stops(tree).length).toBe(1);
  });

  it('⑦c 全部折叠 ⇒ 本容器一个停靠点都不占（用户走各分组的 summary）', () => {
    const tree = document.createElement('div');
    for (let i = 0; i < 2; i += 1) {
      const det = document.createElement('details');
      det.open = false;
      const row = document.createElement('div');
      markRowButton(row);
      det.appendChild(row);
      tree.appendChild(det);
    }
    document.body.appendChild(tree);
    bindRoving(tree);
    expect(stops(tree).length).toBe(0);
  });

  it('⑦d 展开即接管：toggle 之后停靠点交给组内第一行（否则整组永远进不去）', () => {
    const { tree, det, rows } = makeTree();
    det.open = false;
    bindRoving(tree);
    expect(stops(tree).length, '折叠时无停靠点').toBe(0);
    det.open = true;
    det.dispatchEvent(new Event('toggle'));
    expect(stops(tree).length, '展开后必须有停靠点').toBe(1);
    expect((rows[0] as HTMLElement).getAttribute('tabindex')).toBe('0');
  });

  it('⑦e 容器自身是 <details>（worker 组就是这样）：折叠再展开也要接管', () => {
    const det = document.createElement('details');
    det.open = true;
    const row = document.createElement('div');
    markRowButton(row);
    det.appendChild(row);
    document.body.appendChild(det);
    bindRoving(det); // ★ 容器 === 那个 details
    expect(row.getAttribute('tabindex')).toBe('0');
    det.open = false;
    det.dispatchEvent(new Event('toggle'));
    expect(stops(det).length).toBe(0);
    det.open = true;
    det.dispatchEvent(new Event('toggle'));
    expect(row.getAttribute('tabindex'), '漏掉「容器自身」会让整组再也拿不到停靠点').toBe('0');
  });
});

describe('W2053 内核 ④ 鼠标行为一字不变', () => {
  it('④a click 仍然触发原来那个处理器（内核不替换它）', () => {
    const { list, rows } = makeList(3);
    bindRoving(list);
    let clicked = 0;
    (rows[1] as HTMLElement).addEventListener('click', () => { clicked += 1; });
    clickOn(rows[1] as HTMLElement);
    expect(clicked).toBe(1);
  });

  it('④b 鼠标点击**不**移动 Tab 停靠点（Tab 永远从第一行进列表）', () => {
    const { list, rows } = makeList(3);
    bindRoving(list);
    clickOn(rows[2] as HTMLElement);
    expect(stops(list).length).toBe(1);
    expect(stops(list)[0]).toBe(rows[0]);
  });

  it('④c 鼠标路径**不**置位焦点接回标记（只有键盘路径置位）', async () => {
    const roving = await import('./roving');
    expect(roving.consumeFocusAfterNav(), '先清干净').toBe(false);
    const { list, rows } = makeList(2);
    bindRoving(list, { refocus: true });
    clickOn(rows[0] as HTMLElement);
    expect(roving.consumeFocusAfterNav(), '鼠标激活不得置位（否则下次渲染会夺焦）').toBe(false);
    keyOn(rows[0] as HTMLElement, 'Enter');
    expect(roving.consumeFocusAfterNav(), '键盘激活必须置位').toBe(true);
    expect(roving.consumeFocusAfterNav(), '取走即清零，绝不重复夺焦').toBe(false);
  });

  it('④d refocus 缺省 = 不置位（会话树/worker 组不重建，不该夺焦）', async () => {
    const roving = await import('./roving');
    roving.consumeFocusAfterNav();
    const { list, rows } = makeList(2);
    bindRoving(list); // 不传 refocus
    keyOn(rows[0] as HTMLElement, 'Enter');
    expect(roving.consumeFocusAfterNav()).toBe(false);
  });
});

describe('W2053 内核 表格行通道（bindRowActivate，非 roving）', () => {
  it('行自己占停靠点（tabindex=0），Enter/Space 走 click', async () => {
    const { bindRowActivate } = await import('./roving');
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    const td = document.createElement('td');
    tr.appendChild(td);
    document.body.appendChild(tr);
    bindRowActivate(tr);
    let clicked = 0;
    tr.addEventListener('click', () => { clicked += 1; });
    expect(keyOn(tr, 'Enter').defaultPrevented).toBe(true);
    expect(keyOn(tr, ' ').defaultPrevented).toBe(true);
    expect(clicked).toBe(2);
    keyOn(tr, 'a');
    expect(clicked, '非激活键不触发').toBe(2);
  });

  it('行内控件（删除按钮）上的 Enter 只归它自己，不展开整行', async () => {
    const { bindRowActivate } = await import('./roving');
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    const del = document.createElement('button');
    tr.appendChild(del);
    document.body.appendChild(tr);
    bindRowActivate(tr);
    let rowClicks = 0;
    tr.addEventListener('click', () => { rowClicks += 1; });
    keyOn(del, 'Enter');
    expect(rowClicks).toBe(0);
    keyOn(tr, 'Enter');
    expect(rowClicks).toBe(1);
  });

  it('组合中的 Enter 不展开（IME 守卫）', async () => {
    const { bindRowActivate } = await import('./roving');
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    document.body.appendChild(tr);
    bindRowActivate(tr);
    let clicked = 0;
    tr.addEventListener('click', () => { clicked += 1; });
    keyOn(tr, 'Enter', { isComposing: true });
    expect(clicked).toBe(0);
  });
});

describe('W2053 resetStops 纯行为', () => {
  it('resetStops 只写 tabindex、**不**夺焦点', () => {
    const { list, rows } = makeList(3);
    (rows[2] as HTMLElement).focus();
    resetStops(list);
    expect(document.activeElement, 'resetStops 不得夺焦（它是渲染路径调的）').toBe(rows[2]);
    expect((rows[0] as HTMLElement).getAttribute('tabindex')).toBe('0');
    expect(rowsOf(list).length).toBe(3);
  });
});
