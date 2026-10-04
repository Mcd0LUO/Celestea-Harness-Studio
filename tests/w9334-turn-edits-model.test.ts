// @vitest-environment jsdom
/**
 * W9334 验收（甲）：纯模型 —— 阈值 / 双向折叠 / 聚合口径 / 空态 / 平台门控 / 适配器诚实。
 *
 * 每一条都问过「它红的时候，是产品坏了，还是我换了实现？」（铁律 11）：本文件只读
 * 真值表与**后果**（哪些行可见、哪些数字出现），不钉任何实现细节（没有 56px、没有
 * position: fixed、没有某个内部函数名）。
 *
 * 行为规格 = apps/web/prototype/turn-edits.html（联调定稿）。DOM 那一半在
 * tests/w9334-turn-edits-dom.test.ts；像素级排版（rtl 截断、命中区像素）在 jsdom 里
 * **量不了**，属已知边界（见交付报告）。
 */
import { describe, expect, it } from 'vitest';
import { at } from './lib/w795-dom.js';

interface Row { kind: string; path: string; add: number | null; del: number | null }
interface Call { name: string; path: string | null; ok: boolean | null }
interface ModelMod {
  TURN_EDITS_ID: string;
  TURN_EDITS_DEFAULT_THRESHOLD: number;
  kindLetterOf?: unknown;
  KIND_LETTER: Record<string, string>;
  pathArgOf(name: string, args: unknown): string | null;
  editsOf(calls: readonly Call[]): { rows: Row[]; hidden: number };
  totalsOf(rows: readonly Row[]): {
    files: number;
    counts: Record<string, number>;
    add: number | null;
    del: number | null;
  };
  breakdownOf(totals: unknown): { kind: string; n: number }[];
  foldWindow(total: number, threshold: number, expanded: boolean): { shown: number; hidden: number; canCollapse: boolean };
  visibleRows(rows: readonly Row[], w: unknown): Row[];
  splitPath(path: string): { dir: string; file: string };
  revealSupported(platform: string): boolean;
  setRevealCapability(cap: unknown): void;
  canReveal(): boolean;
  revealPath(path: string): boolean;
  setTurnEditsThreshold(n: number): void;
  turnEditsThreshold(): number;
  shouldShowCard(callCount: number): boolean;
}

const load = async (): Promise<ModelMod> => (await import(/* @vite-ignore */ at('ui/turn-edits/model.ts'))) as unknown as ModelMod;

const row = (kind: string, add: number | null, del: number | null): Row => ({ kind, path: kind + '.ts', add, del });

describe('W9334 甲-① 阈值是配置、不是常量（默认 5）', () => {
  it('默认阈值就是 5；配置推来的值真的改变折叠窗口', async () => {
    const M = await load();
    expect(M.TURN_EDITS_DEFAULT_THRESHOLD, '定稿：默认 5').toBe(5);
    expect(M.turnEditsThreshold()).toBe(5);
    M.setTurnEditsThreshold(3);
    expect(M.turnEditsThreshold()).toBe(3);
    expect(M.foldWindow(6, M.turnEditsThreshold(), false), '阈值 3 ⇒ 折 3 个').toEqual({
      shown: 3,
      hidden: 3,
      canCollapse: false,
    });
    M.setTurnEditsThreshold(5);
    expect(M.foldWindow(6, M.turnEditsThreshold(), false).shown, '改回 5 ⇒ 折 1 个').toBe(5);
  });

  it('坏配置不许让卡片消失：非有限值/负数回落默认值；0 = 不折叠（不是「全折」）', async () => {
    const M = await load();
    M.setTurnEditsThreshold(Number.NaN);
    expect(M.turnEditsThreshold()).toBe(5);
    M.setTurnEditsThreshold(-3);
    expect(M.turnEditsThreshold()).toBe(5);
    M.setTurnEditsThreshold(0);
    expect(M.foldWindow(50, 0, false), '0 = 不限（全部展开）').toEqual({ shown: 50, hidden: 0, canCollapse: false });
    M.setTurnEditsThreshold(5);
  });
});

describe('W9334 甲-② 双向折叠：阈值内 ↔ 全部，两个方向都闭合', () => {
  it('超过阈值 ⇒ 折起来；展开 ⇒ 全部且出现「收起」；收起 ⇒ 回到阈值内', async () => {
    const M = await load();
    expect(M.foldWindow(3, 5, false), '没超阈值 ⇒ 折叠与收起都不出现').toEqual({ shown: 3, hidden: 0, canCollapse: false });
    expect(M.foldWindow(12, 5, false)).toEqual({ shown: 5, hidden: 7, canCollapse: false });
    expect(M.foldWindow(12, 5, true), '展开 ⇒ 全部 + 可收起').toEqual({ shown: 12, hidden: 0, canCollapse: true });
    expect(M.foldWindow(12, 5, false), '收起 ⇒ 回到阈值内（**双向**闭合）').toEqual({ shown: 5, hidden: 7, canCollapse: false });
  });

  it('恰好等于阈值时不折（「还有 0 个文件」不是一句话）', async () => {
    const M = await load();
    expect(M.foldWindow(5, 5, false)).toEqual({ shown: 5, hidden: 0, canCollapse: false });
    const rows = [row('write', null, null), row('write', null, null), row('write', null, null), row('write', null, null), row('write', null, null)];
    expect(M.visibleRows(rows, M.foldWindow(5, 5, false))).toHaveLength(5);
    expect(M.visibleRows(rows, M.foldWindow(5, 5, true))).toHaveLength(5);
  });
});

describe('W9334 甲-③ 聚合口径：按全量算（不随折叠变）、删除的文件也算', () => {
  const rows = [row('add', 3, 0), row('edit', 5, 1), row('delete', 0, 46), ...Array.from({ length: 5 }, () => row('write', 2, 1))];

  it('合计覆盖**全部**行（含删除的文件），与可见窗口无关', async () => {
    const M = await load();
    const totals = M.totalsOf(rows);
    expect(totals.files).toBe(8);
    expect(totals.add, '3+5+0+2×5').toBe(18);
    expect(totals.del, '0+1+46+1×5 —— 删除的文件也进聚合').toBe(52);
    expect(totals.counts['delete']).toBe(1);
  });

  it('折叠前/展开后的聚合是同一个数（折叠一次数字就变 ⇒ 无法解释）', async () => {
    const M = await load();
    const folded = M.visibleRows(rows, M.foldWindow(rows.length, 5, false));
    const expanded = M.visibleRows(rows, M.foldWindow(rows.length, 5, true));
    expect(folded).toHaveLength(5);
    expect(expanded).toHaveLength(8);
    expect(M.totalsOf(expanded)).toEqual(M.totalsOf(rows));
    // 「折叠不改数字」在**卡片上**是可观测的后果（折叠前/展开后表头同一个数）——
    // 那一条在 tests/w9334-turn-edits-dom.test.ts 里按真 DOM 断言；这里只钉口径：
    // 聚合的入参是**行清单**，不是「可见的那几行」。
  });

  it('有行给不出数字 ⇒ 整块聚合不出现（null，而不是一个偏小的数）', async () => {
    const M = await load();
    expect(M.totalsOf([row('write', 1, 0), row('write', null, null)]).add, '混着不知道 ⇒ 不聚').toBeNull();
    expect(M.totalsOf([]).add, '没有行 ⇒ 不聚（0 会被读成「没有变化」）').toBeNull();
  });

  it('副标题只列非零构成，顺序固定', async () => {
    const M = await load();
    expect(M.breakdownOf(M.totalsOf([row('edit', 1, 1), row('delete', 0, 2)]))).toEqual([
      { kind: 'edit', n: 1 },
      { kind: 'delete', n: 1 },
    ]);
    expect(M.breakdownOf(M.totalsOf([row('add', 1, 0)]))).toEqual([{ kind: 'add', n: 1 }]);
  });
});

describe('W9334 甲-④ 来源适配（方案 A 的诚实边界）', () => {
  it('只有**成功**的调用才算改动了文件；失败/被拒/结果未到都不记', async () => {
    const M = await load();
    const out = M.editsOf([
      { name: 'write_file', path: 'a.ts', ok: true },
      { name: 'write_file', path: 'b.ts', ok: false },
      { name: 'write_file', path: 'c.ts', ok: null },
    ]);
    expect(out.rows.map((r) => r.path)).toEqual(['a.ts']);
  });

  it('同一轮内**第二次**写同一路径 ✅ 可证明的覆盖（M）；否则只敢说「写入」（W）', async () => {
    const M = await load();
    const out = M.editsOf([
      { name: 'write_file', path: 'a.ts', ok: true },
      { name: 'write_file', path: 'a.ts', ok: true },
      { name: 'write_file', path: 'b.ts', ok: true },
    ]);
    expect(out.rows, '同一文件只出一行').toHaveLength(2);
    expect(out.rows[0]?.kind, '第二次落笔 ⇒ 文件一定已存在').toBe('edit');
    expect(out.rows[1]?.kind, '新增还是覆盖不可知 ⇒ 不假装是 A 或 M').toBe('write');
    expect(M.KIND_LETTER['write']).toBe('W');
    expect(M.KIND_LETTER['edit']).toBe('M');
    expect(M.KIND_LETTER['add']).toBe('A');
    expect(M.KIND_LETTER['delete']).toBe('D');
  });

  it('看不见的调用（run_shell / run_code）如实计数 —— 不许为了让数字好看假装覆盖', async () => {
    const M = await load();
    const out = M.editsOf([
      { name: 'run_shell', path: null, ok: true },
      { name: 'run_code', path: null, ok: false },
      { name: 'write_file', path: 'a.ts', ok: true },
      { name: 'read_file', path: null, ok: true },
    ]);
    expect(out.hidden, '两个可能改了文件的调用（成不成败都算「可能」）').toBe(2);
    expect(out.rows.map((r) => r.path), '看不见的调用**不**变成文件行').toEqual(['a.ts']);
  });

  it('路径取值只认 write_file 的 path 字段（缺字段/非字符串 ⇒ 不记，不猜）', async () => {
    const M = await load();
    expect(M.pathArgOf('write_file', { path: 'a.ts' })).toBe('a.ts');
    expect(M.pathArgOf('write_file', { path: '  ' })).toBeNull();
    expect(M.pathArgOf('write_file', {})).toBeNull();
    expect(M.pathArgOf('read_file', { path: 'a.ts' }), '只有写文件工具才算').toBeNull();
  });

  it('纯聊天轮（一个工具调用都没有）不长卡片；有调用但没写文件 ⇒ 保留卡片（空态）', async () => {
    const M = await load();
    expect(M.shouldShowCard(0)).toBe(false);
    expect(M.shouldShowCard(1)).toBe(true);
  });
});

describe('W9334 甲-⑤ 平台门控：只有 win/macOS 有「在文件管理器中显示」', () => {
  it('Linux 不支持（这一项**不出现**，不是禁用）；win/macOS 支持；未知平台保守为不支持', async () => {
    const M = await load();
    expect(M.revealSupported('linux')).toBe(false);
    expect(M.revealSupported('windows')).toBe(true);
    expect(M.revealSupported('macos')).toBe(true);
    expect(M.revealSupported('other'), '认不出的平台宁可没有这一项').toBe(false);
  });

  it('即使平台支持，没有宿主动作也**不出现**（没有能力就不给按钮，不假装能开）', async () => {
    const M = await load();
    const calls: string[] = [];
    M.setRevealCapability(null);
    expect(M.canReveal(), '没有宿主声明').toBe(false);
    expect(M.revealPath('a.ts'), '执行也要如实返回 false').toBe(false);
    M.setRevealCapability({ platform: 'linux', reveal: (p: string) => calls.push(p) });
    expect(M.canReveal(), 'Linux 上整项不出现').toBe(false);
    M.setRevealCapability({ platform: 'macos', reveal: (p: string) => calls.push(p) });
    expect(M.canReveal()).toBe(true);
    expect(M.revealPath('a.ts')).toBe(true);
    expect(calls).toEqual(['a.ts']);
    M.setRevealCapability(null);
  });
});

describe('W9334 甲-⑥ 路径拆分：目录与文件名分开（淡显目录、保住文件名）', () => {
  it('取最后一个分隔符（/ 与 \\ 都认），文件名永远在 file 里', async () => {
    const M = await load();
    expect(M.splitPath('apps/web/src/ui/icons.ts')).toEqual({ dir: 'apps/web/src/ui/', file: 'icons.ts' });
    expect(M.splitPath('apps\\web\\icons.ts'), 'win32 路径同样成立').toEqual({ dir: 'apps\\web\\', file: 'icons.ts' });
    expect(M.splitPath('icons.ts')).toEqual({ dir: '', file: 'icons.ts' });
    expect(M.splitPath('')).toEqual({ dir: '', file: '' });
  });
});
