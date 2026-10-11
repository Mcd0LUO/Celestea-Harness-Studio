// @vitest-environment jsdom
/**
 * composer-surface §1.5 · 补全框的**分组能力**（四条验收断言 + §1.3 的硬约束）。
 *
 * 只装**引擎**（ui/commands/popup.ts），不装调用方：这里问的是「items 带 group 时弹层长什么样、
 * ↑↓ 怎么走」，与技能/MCP 清单还没上线无关。@ 文件模式的**真实**路径另有一条
 * （tests/h-mention-files.test.ts 走真 installCommands + 真 /api/fs/list 打桩，断言不出现组头）——
 * 引擎级这一条只保证「不传 group 就没有组头」。
 *
 * ★ 全部断言都锚在**后果**上，不钉 DOM 位置：组头是渲染装饰、不进 items（§1.3），
 *   所以「高亮项」永远是 items 的下标，↑↓ 只能逐项移动。断言若改成数 DOM 下标，
 *   就会把这条设计换成另一种实现时一起判红（铁律 11）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { all, at, doc, Ev, type ElLike } from './lib/w795-dom.js';

interface ItemLike {
  label: string;
  desc: string;
  value: string;
  meta?: string;
  isDir?: boolean;
  group?: string;
}

interface PopupMod {
  initCompletion(el: unknown, pick: (i: ItemLike) => void): void;
  setProvider(p: (prefix: string) => ItemLike[]): void;
  showCompletion(prefix: string): Promise<void>;
  completionVisible(): boolean;
  activeItemLabel(): string;
  completionKey(e: Record<string, unknown>): boolean;
}

/** 命令组：两条，组内相邻（同组 ⇒ 只出一个组头）。 */
const CMD: ItemLike[] = [
  { label: '/run', desc: '执行', value: '/run', group: '命令' },
  { label: '/goal', desc: '目标', value: '/goal', group: '命令' },
];
/** 技能组：两条，排在命令组之后。 */
const SKILL: ItemLike[] = [
  { label: '/skill:review', desc: '评审', value: '/skill:review', group: '技能' },
  { label: '/skill:ship', desc: '发布', value: '/skill:ship', group: '技能' },
];
const MIXED = [...CMD, ...SKILL];
/** @ 文件模式的形状（ui/commands/files.ts 产出的就是它：不带 group）。 */
const FILES: ItemLike[] = [
  { label: 'src/', desc: '目录', value: 'src/', isDir: true },
  { label: 'README.md', desc: '2.0 KB', value: 'README.md' },
];

let popup: PopupMod;
let picked: string[];

beforeEach(async () => {
  vi.resetModules();
  picked = [];
  doc.body.replaceChildren();
  const input = doc.createElement('textarea');
  input.id = 'input';
  doc.body.appendChild(input);
  popup = (await import(/* @vite-ignore */ at('ui/commands/popup.ts'))) as unknown as PopupMod;
  popup.initCompletion(input, (i) => picked.push(i.value));
});

/** 用一组候选把弹层刷出来（引擎真实路径：setProvider + showCompletion）。 */
async function show(items: ItemLike[]): Promise<void> {
  popup.setProvider(() => items);
  await popup.showCompletion('');
}

/** 弹层里「组头 + 行」的混合序列：组头记成 #组名，行记成主文本。 */
function outline(): string[] {
  return all('#cmdPopup > *').map((n) =>
    n.className === 'cmd-group' ? '#' + (n.textContent ?? '') : (n.querySelector('.cmd-name')?.textContent ?? '?'),
  );
}

const heads = (): ElLike[] => all('#cmdPopup .cmd-group');
const rowCount = (): number => all('#cmdPopup .cmd-row').length;
const activeRowLabel = (): string => doc.querySelector('#cmdPopup .cmd-row.active .cmd-name')?.textContent ?? '';

/** 直接调引擎的键盘入口（引擎自己不注册监听器 ⇒ 这就是它的真实调用面）。 */
function press(k: string): boolean {
  return popup.completionKey({ key: k, shiftKey: false, preventDefault() { /* noop */ } });
}

describe('composer-surface §1 · 补全框分组（组头是渲染装饰，不进 items）', () => {
  it('① 命令组在前、技能组在后：组头紧贴它那一组的首行', async () => {
    await show(MIXED);
    expect(outline(), '组头按 items 顺序插在各自组首行之前').toEqual([
      '#命令', '/run', '/goal', '#技能', '/skill:review', '/skill:ship',
    ]);
    // 组内相邻项不重复出组头（否则每个文件一行就是一个「组」）
    expect(heads().length, '两个组 ⇒ 恰好两个组头').toBe(2);
    expect(rowCount(), '行数 = items 数（组头不是行）').toBe(MIXED.length);
  });

  it('② 只有一个分组有内容时，另一组的组头不出现', async () => {
    await show(CMD);
    expect(outline()).toEqual(['#命令', '/run', '/goal']);
    expect(doc.querySelector('#cmdPopup')?.textContent ?? '', '技能组的组头不得出现').not.toContain('技能');
    await show(SKILL);
    expect(outline()).toEqual(['#技能', '/skill:review', '/skill:ship']);
    expect(doc.querySelector('#cmdPopup')?.textContent ?? '', '命令组的组头不得出现').not.toContain('命令');
  });

  it('③ 不传 group（@ 文件模式）⇒ 不出现任何组头', async () => {
    await show(FILES);
    expect(heads().length, '@ 文件模式不得出现组头').toBe(0);
    expect(outline(), '行照旧渲染').toEqual(['src/', 'README.md']);
    // 空串组名是「没分组」的另一种写法，同样不出组头（否则画出一个空盒）
    await show(FILES.map((f) => ({ ...f, group: '' })));
    expect(heads().length, '空组名不得画出空组头').toBe(0);
    expect(outline()).toEqual(['src/', 'README.md']);
  });

  it('④ ↑/↓ 在混排列表里逐项移动、不跳组', async () => {
    await show(MIXED);
    const seen = [popup.activeItemLabel()];
    for (let i = 0; i < 4; i += 1) {
      press('ArrowDown');
      seen.push(popup.activeItemLabel());
    }
    expect(seen, '↓ 逐项前进并环绕：每一步都落在 items 上，从不落在组头').toEqual([
      '/run', '/goal', '/skill:review', '/skill:ship', '/run',
    ]);
    press('ArrowUp');
    expect(popup.activeItemLabel()).toBe('/skill:ship');
    // 跨过组边界时，高亮行仍与 items 下标一一对应（.cmd-row.active 查询不受组头影响）
    expect(activeRowLabel(), '高亮行 = 当前 items 项').toBe(popup.activeItemLabel());
    expect(rowCount(), '行数仍是 items 数').toBe(MIXED.length);
    press('Enter');
    expect(picked, 'Enter 选中的就是当前 items 项').toEqual(['/skill:ship']);
  });

  it('⑤ 组头不是可选项：不带 .cmd-row / role=option，点击它不选中任何项', async () => {
    await show(MIXED);
    const hs = heads();
    expect(hs.length).toBe(2);
    for (const h of hs) {
      expect(h.className, '组头不得带 .cmd-row').not.toContain('cmd-row');
      expect(h.getAttribute('role'), '组头不得被辅助技术当成候选').toBe('presentation');
    }
    // 第 3 行 = 技能组首行（组头不占行 ⇒ 它的下标仍是 items 下标 2）
    all('#cmdPopup .cmd-row')[2]?.dispatchEvent(new Ev('mousedown', { bubbles: true }));
    expect(picked, '点真行照旧选中').toEqual(['/skill:review']);
    hs[0]?.dispatchEvent(new Ev('mousedown', { bubbles: true }));
    expect(picked, '组头上没有选中行为').toEqual(['/skill:review']);
  });
});
