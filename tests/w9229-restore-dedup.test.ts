// @vitest-environment jsdom
/**
 * W9229 · P2批次1（前端）—— 衔接去重的**状态边界**（F-19）与复位入口（F-21）。
 *
 * 覆盖审计 results/W9201-消息渲染管线.md §P2：
 *   F-19 `feedAssistantDelta` 的 guardBuf 无上限，且 finalAssistantDedup 后 tail 被清空
 *        使去重只能生效一次（同一次连接里第二次重连补发 ⇒ 重复气泡）；
 *   F-21 resetRestore 等「复位」入口是零调用者的死代码，注释声称的能力与实际路径不符。
 *
 * ★ 复核判定（如实记账）：F-19 的前半「guardBuf 无上限」经代码复核**不成立** ——
 *   `tc.startsWith(guardBuf)` 对「比 tc 更长」的缓冲必然为假，所以缓冲恒有
 *   `length ≤ 尾部长度 + 单帧 delta`，同一调用里就发散并吐出。本文件把它作为**不变式**
 *   钉住（防未来改动破坏它），真正被修的是后半（整条被吞后锚点被清）与「发散后不释放
 *   缓冲」这一处（守卫被反复进出时留着 196K 量级的字符串引用）。
 *
 * 走**真实模块**（ui/restore-dedup.ts + ui/restore.ts 的再导出面），只构造 SessionPane
 * 里本模块真正读写的字段（dedup），不复刻去重逻辑。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { at, doc } from './lib/w795-dom.js';

interface Dedup {
  tail: { role: string; content: string } | null;
  guardActive: boolean;
  guardBuf: string;
  guardAll: boolean;
}
interface Pane { dedup: Dedup }
interface DedupMod {
  resetRestore(ctx: Pane): void;
  feedAssistantDelta(ctx: Pane, delta: string): string | null;
  finalAssistantDedup(ctx: Pane, text?: string): boolean;
  guardBufLimit(tail: string): number;
}

const pane = (tail: { role: string; content: string } | null = null): Pane => ({
  dedup: { tail, guardActive: false, guardBuf: '', guardAll: false },
});

interface RestoreBackstop {
  recoverIfEmptied(ctx: unknown, colsBefore: number): boolean;
}
/** 真实模块 ui/restore.ts 的再导出面（F-20 的兜底入口就住在那里）。 */
async function loadRestore(): Promise<{ restoreMod: RestoreBackstop }> {
  const m = (await import(/* @vite-ignore */ at('ui/restore.ts'))) as unknown as RestoreBackstop;
  return { restoreMod: m };
}

let D: DedupMod;
beforeEach(async () => {
  D = (await import(/* @vite-ignore */ at('ui/restore-dedup.ts'))) as unknown as DedupMod;
});
afterEach(() => { doc.body.replaceChildren(); });

describe('W9229 · F-19 guardBuf 的界与锚点', () => {
  it('重放远超尾部长度的内容：缓冲不得超过「尾部长度 + 单帧 delta」，且内容不丢', () => {
    const tail = { role: 'assistant', content: 'ABC' };
    const ctx = pane(tail);
    // 第一帧与尾部前缀匹配 → 吞掉。
    expect(D.feedAssistantDelta(ctx, 'ABC')).toBeNull();
    expect(ctx.dedup.guardBuf).toBe('ABC');
    // 第二帧发散（尾部只有 3 个字符）→ 一次性吐出**完整**缓冲（不得截断内容）。
    const out = D.feedAssistantDelta(ctx, 'DEFGHIJKLMNOP');
    expect(out, '发散时必须原样吐出全部缓冲，不丢内容').toBe('ABCDEFGHIJKLMNOP');
    expect(ctx.dedup.guardBuf.length, '缓冲必须被钉在 O(尾部 + 单帧)').toBeLessThanOrEqual(
      D.guardBufLimit(tail.content) + 'DEFGHIJKLMNOP'.length,
    );
    expect(ctx.dedup.guardActive, '发散后守卫必须解除').toBe(false);
  });

  it('长尾部（196K 量级）反复重放：缓冲恒 ≤ 尾部长度 + 单帧 delta（不变式，不是「函数被调用过」）', () => {
    const tail = { role: 'assistant', content: 'Z'.repeat(196_000) };
    const ctx = pane(tail);
    const frame = 1000;
    let peak = 0;
    for (let i = 0; i < 50; i++) {
      D.feedAssistantDelta(ctx, 'Z'.repeat(frame));
      peak = Math.max(peak, ctx.dedup.guardBuf.length);
    }
    // 守卫内的缓冲 = 已匹配前缀，恒不超过尾部长度（前缀不可能更长）。
    expect(peak).toBeLessThanOrEqual(D.guardBufLimit(tail.content));
    // 再灌一段必然发散的内容：吐出**完整**缓冲（不截断内容），随后释放缓冲。
    const out = D.feedAssistantDelta(ctx, 'Q'.repeat(200_000));
    expect(out?.length, '发散时必须原样吐出全部缓冲，不丢内容').toBe(50_000 + 200_000);
    expect(ctx.dedup.guardBuf, '发散后必须释放缓冲（改动前它会留到下一次进守卫）').toBe('');
  });
});

describe('W9229 · F-19 去重锚点在「整条被吞」后必须保留', () => {
  it('同一连接内第二次重连补发仍被去重（不得产生重复气泡）', () => {
    const ctx = pane({ role: 'assistant', content: 'ABC' });
    // 第一次重放：增量被吞 + done 全量一致 ⇒ 丢弃重复气泡。
    expect(D.feedAssistantDelta(ctx, 'ABC')).toBeNull();
    expect(D.finalAssistantDedup(ctx, 'ABC')).toBe(true);
    expect(ctx.dedup.tail, '整条被吞后锚点必须保留（否则第二次补发无从比较）').not.toBeNull();
    // 第二次重放（同一次连接里的第二次重连补发）：仍必须被吞掉。
    expect(D.feedAssistantDelta(ctx, 'ABC')).toBeNull();
    expect(D.finalAssistantDedup(ctx, 'ABC')).toBe(true);
  });

  it('对照：内容发散（不是重放）时锚点必须被清掉，不得继续吞新内容', () => {
    // 只喂**前缀**（'AB'）—— 若喂满 'ABC' 则 guardAll 已为真，done 必然丢（那是重放的正解）。
    const ctx = pane({ role: 'assistant', content: 'ABC' });
    expect(D.feedAssistantDelta(ctx, 'AB')).toBeNull();
    expect(D.finalAssistantDedup(ctx, 'XYZ'), '内容发散 ⇒ 不是重放，不得丢弃').toBe(false);
    expect(ctx.dedup.tail, '发散后锚点必须清掉').toBeNull();
    expect(D.feedAssistantDelta(ctx, '新内容'), '锚点清掉后新内容必须原样通过').toBe('新内容');
  });

  it('resetRestore 之后锚点与守卫全部归零（F-21 的复位语义）', () => {
    const ctx = pane({ role: 'assistant', content: 'ABC' });
    D.feedAssistantDelta(ctx, 'AB');
    D.resetRestore(ctx);
    expect(ctx.dedup).toEqual({ tail: null, guardActive: false, guardBuf: '', guardAll: false });
  });
});

describe('W9229 · F-20 裁剪后容器被清空必须留下可观测痕迹', () => {
  /** 只构造 recoverIfEmptied → renderEmptyHint → resetMessages 真正读写的字段。 */
  function fixture(): { el: unknown; hint: unknown; pane: unknown; cols: number } {
    const el = doc.createElement('div');
    const cols = 3;
    for (let i = 0; i < cols; i++) {
      const col = doc.createElement('div');
      col.className = 'mcol';
      el.appendChild(col);
    }
    doc.body.appendChild(el);
    const pane = {
      el,
      hint: doc.createElement('div'),
      assistant: null, thinkSeg: null, lastTextCol: null, turn: null, interjectNote: null,
      ops: new Map<string, unknown>(), step: 0,
      render: { timer: null, deadline: 0, cost: 0 },
    };
    return { el, hint: pane.hint, pane, cols };
  }

  it('有列时不动容器（返回 true，不画空态）', async () => {
    const { restoreMod } = await loadRestore();
    const f = fixture();
    expect(restoreMod.recoverIfEmptied(f.pane, f.cols)).toBe(true);
    expect((f.el as { querySelector(s: string): unknown }).querySelector('.empty-hint')).toBeNull();
    expect((f.el as { querySelectorAll(s: string): ArrayLike<unknown> }).querySelectorAll('.mcol').length).toBe(f.cols);
  });

  it('裁剪把列删空 ⇒ 就地恢复空态（返回 false，不留「消息全没了」的空白容器）', async () => {
    const { restoreMod } = await loadRestore();
    const f = fixture();
    (f.el as { replaceChildren(...n: unknown[]): void }).replaceChildren(); // 模拟 P0 误删
    expect(restoreMod.recoverIfEmptied(f.pane, f.cols), '被清空时必须返回 false').toBe(false);
    expect((f.el as { querySelector(s: string): unknown }).querySelector('.empty-hint'), '必须画出空态').not.toBeNull();
  });

  it('对照：本来就没有列（colsBefore=0）不当作异常', async () => {
    const { restoreMod } = await loadRestore();
    const f = fixture();
    (f.el as { replaceChildren(...n: unknown[]): void }).replaceChildren();
    expect(restoreMod.recoverIfEmptied(f.pane, 0)).toBe(true);
  });

  it('★ 接线判据（源码级）：restoreSessionHistory 必须在 prunePaneDom 之后调用它', async () => {
    // 为什么用源码级判据而不是行为判据：要**行为上**触发这条兜底，得先让 W9201 的 P0
    // 缺陷（跨父边界区间删除）重新出现 —— 而它已被修掉、没有可注入的缝。所以这里钉
    // 「调用点在不在」这一事实（与 check-fold-default.mjs / 本文件 F-21 同一手法），
    // 上面两条行为用例负责钉住它**被调用时**做对了什么。
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { WEB } = await import('./lib/w795-dom.js');
    const src = readFileSync(join(WEB, 'src', 'ui', 'restore.ts'), 'utf8');
    const prune = src.indexOf('prunePaneDom(ctx, true);');
    const guard = src.indexOf('recoverIfEmptied(ctx, colsBefore);');
    expect(prune, '必须仍有恢复收尾的那次裁剪').toBeGreaterThan(-1);
    expect(guard, '裁剪之后必须调用兜底（删掉这一行即红）').toBeGreaterThan(prune);
  });
});

describe('W9229 · F-21 复位入口必须接进真实路径（不再是死代码）', () => {
  it('restore.ts 的历史恢复收尾调用 resetRestore（源码级判据，唯一复位入口）', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { WEB } = await import('./lib/w795-dom.js');
    const src = readFileSync(join(WEB, 'src', 'ui', 'restore.ts'), 'utf8');
    expect(src, 'restore.ts 必须 import resetRestore 并真的调用它').toMatch(/resetRestore\(ctx\);/);
    expect(src, '不得再手写一遍 dedup 四字段复位（两处口径会分叉）').not.toMatch(/ctx\.dedup\.guardBuf = '';/);
  });
});
