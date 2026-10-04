// @vitest-environment jsdom
/**
 * W9334 验收（甲）：纯模型 —— 可知性分级 / 阈值 / 双向折叠 / 聚合口径 / 空态 /
 * 平台门控 / 适配器诚实。
 *
 * 每一条都问过「它红的时候，是产品坏了，还是我换了实现？」（铁律 11）：本文件只读
 * 真值表与**后果**（哪些行可见、哪些数字出现、出现的是哪一档），不钉实现细节。
 *
 * 行为规格 = apps/web/prototype/turn-edits.html（联调定稿）。DOM 那一半在
 * tests/w9334-turn-edits-dom.test.ts；像素级排版（rtl 截断、命中区像素）在 jsdom 里
 * **量不了**，由真机探针（scripts/a11y/w9334-turn-edits-probe.mjs）取证。
 */
import { describe, expect, it } from 'vitest';
import { at } from './lib/w795-dom.js';

interface Row { kind: string; path: string; add: number | null; del: number | null; written: number | null }
interface Call { name: string; args: unknown; ok: boolean | null }
interface Totals {
  files: number;
  counts: Record<string, number>;
  add: number | null;
  del: number | null;
  exactRows: number;
  written: number | null;
  writtenRows: number;
  unknownRows: number;
}
interface ModelMod {
  TURN_EDITS_DEFAULT_THRESHOLD: number;
  KIND_LETTER: Record<string, string>;
  linesOf(text: string): number;
  pathArgOf(name: string, args: unknown): string | null;
  numbersOf(name: string, args: unknown): { add: number | null; del: number | null; written: number | null };
  editsOf(calls: readonly Call[]): { rows: Row[]; hidden: number };
  totalsOf(rows: readonly Row[]): Totals;
  breakdownOf(totals: Totals): { kind: string; n: number }[];
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

const load = async (): Promise<ModelMod> =>
  (await import(/* @vite-ignore */ at('ui/turn-edits/model.ts'))) as unknown as ModelMod;

const row = (kind: string, add: number | null, del: number | null, written: number | null = null): Row => ({
  kind,
  path: kind + '.ts',
  add,
  del,
  written,
});
/** 只知新内容的一行（`write_file` 型的真实形态）。 */
const wrow = (n: number, kind = 'edit'): Row => ({ kind, path: kind + n + '.ts', add: null, del: null, written: n });

describe('W9334 甲-① 阈值是配置、不是常量（默认 5）', () => {
  it('默认阈值就是 5；配置推来的值真的改变折叠窗口', async () => {
    const M = await load();
    expect(M.TURN_EDITS_DEFAULT_THRESHOLD, '定稿：默认 5').toBe(5);
    expect(M.turnEditsThreshold()).toBe(5);
    M.setTurnEditsThreshold(3);
    expect(M.turnEditsThreshold()).toBe(3);
    expect(M.foldWindow(6, M.turnEditsThreshold(), false), '阈值 3 ⇒ 折 3 个').toEqual({ shown: 3, hidden: 3, canCollapse: false });
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
    const rows = [wrow(1), wrow(2), wrow(3), wrow(4), wrow(5)];
    expect(M.visibleRows(rows, M.foldWindow(5, 5, false))).toHaveLength(5);
    expect(M.visibleRows(rows, M.foldWindow(5, 5, true))).toHaveLength(5);
  });
});

describe('W9334 甲-③ 行数：知道的算出来，不知道的不硬凑', () => {
  it('linesOf：末行没有换行也算一行；空串 0 行；只有换行算 1 行', async () => {
    const M = await load();
    expect(M.linesOf('')).toBe(0);
    expect(M.linesOf('a')).toBe(1);
    expect(M.linesOf('a\nb')).toBe(2);
    expect(M.linesOf('a\nb\n')).toBe(2);
    expect(M.linesOf('\n')).toBe(1);
  });

  it('write_file 的 content ⇒ **写入 N 行**（旧内容不可知 ⇒ 不给 −）', async () => {
    const M = await load();
    expect(M.numbersOf('write_file', { path: 'a.ts', content: 'x\ny\nz\n' })).toEqual({ add: null, del: null, written: 3 });
    const out = M.editsOf([{ name: 'write_file', args: { path: 'a.ts', content: 'x\ny\n' }, ok: true }]);
    expect(out.rows[0]).toEqual({ kind: 'edit', path: 'a.ts', add: null, del: null, written: 2 });
  });

  it('替换型参数（old_string / new_string）⇒ **精确区间**（这次替换的区间，不是整文件）', async () => {
    const M = await load();
    const two = M.numbersOf('edit_file', { path: 'a.ts', old_string: 'one\ntwo\n', new_string: 'one\ntwo\nthree\n' });
    expect(two, '+3 −2：替换区间的行数').toEqual({ add: 3, del: 2, written: null });
    const multi = M.numbersOf('edit_file', {
      path: 'a.ts',
      edits: [
        { old_string: 'a\n', new_string: 'a\nb\n' },
        { old_string: 'c\n', new_string: 'c\n' },
      ],
    });
    expect(multi, '多段替换的区间合计').toEqual({ add: 3, del: 2, written: null });
  });

  it('形状不认识 ⇒ 三样都不知道（不猜）；删除型工具也拿不出内容行数', async () => {
    const M = await load();
    expect(M.numbersOf('write_file', { path: 'a.ts', content: 42 })).toEqual({ add: null, del: null, written: null });
    expect(M.numbersOf('delete_file', { path: 'a.ts' })).toEqual({ add: null, del: null, written: null });
    const out = M.editsOf([{ name: 'write_file', args: { path: 'a.ts' }, ok: true }]);
    expect(out.rows, '行还在（它确实改了），但数字一个都不给').toEqual([
      { kind: 'edit', path: 'a.ts', add: null, del: null, written: null },
    ]);
  });
});

describe('W9334 甲-④ 来源适配（方案 A 的诚实边界 + 定稿的 M/A/D）', () => {
  it('只有**成功**的调用才算改动了文件；失败/被拒/结果未到都不记', async () => {
    const M = await load();
    const out = M.editsOf([
      { name: 'write_file', args: { path: 'a.ts', content: 'x\n' }, ok: true },
      { name: 'write_file', args: { path: 'b.ts', content: 'x\n' }, ok: false },
      { name: 'write_file', args: { path: 'c.ts', content: 'x\n' }, ok: null },
    ]);
    expect(out.rows.map((r) => r.path)).toEqual(['a.ts']);
  });

  it('字母回到定稿的 M / A / D：write_file 记 M（创建或覆盖不可分）、create/delete 工具记 A/D', async () => {
    const M = await load();
    expect(M.KIND_LETTER).toEqual({ edit: 'M', add: 'A', delete: 'D' });
    const out = M.editsOf([
      { name: 'write_file', args: { path: 'a.ts', content: 'x\n' }, ok: true },
      { name: 'create_file', args: { path: 'b.ts', content: 'x\ny\n' }, ok: true },
      { name: 'delete_file', args: { path: 'c.ts' }, ok: true },
    ]);
    expect(out.rows.map((r) => r.kind + ':' + r.path)).toEqual(['edit:a.ts', 'add:b.ts', 'delete:c.ts']);
    expect(out.rows[1]?.written, 'A 行也能给「写入 N 行」（定稿的 A 行只有 +、没有 −）').toBe(2);
  });

  it('同一轮内**第二次**写同一路径 ⇒ 可证明的覆盖（M），行数按两次累加', async () => {
    const M = await load();
    const out = M.editsOf([
      { name: 'write_file', args: { path: 'a.ts', content: 'x\n' }, ok: true },
      { name: 'write_file', args: { path: 'a.ts', content: 'x\ny\nz\n' }, ok: true },
    ]);
    expect(out.rows, '同一文件只出一行').toHaveLength(1);
    expect(out.rows[0]?.kind).toBe('edit');
    expect(out.rows[0]?.written, '1 + 3').toBe(4);
  });

  it('看不见的调用（run_shell / run_code）如实计数 —— 不许为了让数字好看假装覆盖', async () => {
    const M = await load();
    const out = M.editsOf([
      { name: 'run_shell', args: { command: 'x' }, ok: true },
      { name: 'run_code', args: { code: 'x' }, ok: false },
      { name: 'write_file', args: { path: 'a.ts', content: 'x\n' }, ok: true },
      { name: 'read_file', args: { path: 'a.ts' }, ok: true },
    ]);
    expect(out.hidden, '两个可能改了文件的调用（成不成败都算「可能」）').toBe(2);
    expect(out.rows.map((r) => r.path), '看不见的调用**不**变成文件行').toEqual(['a.ts']);
  });

  it('路径取值只认写文件类工具的 path 字段（缺字段/非字符串/只读工具 ⇒ 不记）', async () => {
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

describe('W9334 甲-⑤ 聚合口径：按全量算、已知多少聚多少、删除的文件也算', () => {
  const rows = [
    row('add', 3, 0),
    row('edit', 5, 1),
    row('delete', 0, 46),
    wrow(10),
    wrow(20),
    row('edit', null, null),
  ];

  it('精确区间只合计**能算出**的那几行；「写入 N 行」单独合计；一无所知的单独计数', async () => {
    const M = await load();
    const t = M.totalsOf(rows);
    expect(t.files).toBe(6);
    expect(t.add, '3+5+0（删除的那一行也进合计）').toBe(8);
    expect(t.del, '0+1+46').toBe(47);
    expect(t.exactRows).toBe(3);
    expect(t.written, '10+20').toBe(30);
    expect(t.writtenRows).toBe(2);
    expect(t.unknownRows, '有一行三样都不知道 ⇒ 页脚要如实说').toBe(1);
    expect(t.counts['delete']).toBe(1);
  });

  it('一行精确的都没有 ⇒ 精确合计为 null（不显示 +0 −0）；只知内容的同理', async () => {
    const M = await load();
    expect(M.totalsOf([wrow(5)]).add).toBeNull();
    expect(M.totalsOf([wrow(5)]).written).toBe(5);
    expect(M.totalsOf([row('edit', 1, 1)]).written).toBeNull();
    expect(M.totalsOf([]).add, '没有行 ⇒ 不聚（0 会被读成「没有变化」）').toBeNull();
  });

  it('折叠前/展开后是同一个聚合（聚合入参是行清单，不是可见的那几行）', async () => {
    const M = await load();
    const folded = M.visibleRows(rows, M.foldWindow(rows.length, 5, false));
    const expanded = M.visibleRows(rows, M.foldWindow(rows.length, 5, true));
    expect(folded).toHaveLength(5);
    expect(expanded).toHaveLength(6);
    expect(M.totalsOf(expanded)).toEqual(M.totalsOf(rows));
    expect(M.totalsOf(folded).files, '可见窗口只有 5 行，聚合口径是**全量**').not.toBe(M.totalsOf(rows).files);
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

describe('W9334 甲-⑥ 平台门控：只有 win/macOS 有「在文件管理器中显示」', () => {
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

describe('W9334 甲-⑦ 路径拆分：目录与文件名分开（淡显目录、保住文件名）', () => {
  it('取最后一个分隔符（/ 与 \\ 都认），文件名永远在 file 里', async () => {
    const M = await load();
    expect(M.splitPath('apps/web/src/ui/icons.ts')).toEqual({ dir: 'apps/web/src/ui/', file: 'icons.ts' });
    expect(M.splitPath('apps\\web\\icons.ts'), 'win32 路径同样成立').toEqual({ dir: 'apps\\web\\', file: 'icons.ts' });
    expect(M.splitPath('icons.ts')).toEqual({ dir: '', file: 'icons.ts' });
    expect(M.splitPath('')).toEqual({ dir: '', file: '' });
  });
});
