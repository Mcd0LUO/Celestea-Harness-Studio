// @vitest-environment jsdom
/**
 * W9334 验收（乙）：卡片本体 —— 结构 / 文案 / 阈值 / 空态 / 双向折叠 / 平台门控 /
 * 复制失败降级 / 插件门控 / **真 SSE 帧驱动的活路径**。
 *
 * 铁律 11：本文件只守**后果**（用户看得见的东西：哪些行在、按钮在不在、点下去之后
 * 变成什么、失败时说的是不是「失败」），不钉实现（没有 56px、没有 position: fixed、
 * 没有内部函数名）。像素级排版（rtl 截断真的保住了文件名、命中区真的 ≥ --tap-hit）
 * jsdom **量不了** —— 属已知边界，写在交付报告里。
 *
 * 行为规格 = apps/web/prototype/turn-edits.html（联调定稿的 11 条）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, click, doc, Ev, flush, resetHarness, WEB, type ElLike } from './lib/w795-dom.js';

const SESSION = 'ws/s1';
const ID = 'display.turnEdits';
const KEY = 'studio:client-plugins-changed';

interface PaneLike { el: ElLike; id: string }
interface ViewMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): PaneLike;
  activatePane(id: string, kind?: string, title?: string): unknown;
}
interface ApplyMod {
  startClientPlugins(): void;
  whenClientPluginsReady(): Promise<void>;
  isClientPluginOn(id: string): boolean;
}
interface RegisterMod { activatePlugin(id: string): void; deactivatePlugin(id: string): void }
interface WireMod {
  initTurnEdits(): void;
  noteTurnToolCall(ctx: unknown, p: unknown): void;
  noteTurnToolResult(ctx: unknown, p: unknown): void;
  settleTurnEdits(ctx: unknown): void;
  turnEditsRowsOf(ctx: unknown): { rows: Array<{ kind: string; path: string }>; hidden: number };
}
interface CardMod {
  createTurnEditsColumn(rows: unknown[], shellish: number): ElLike;
  turnEditsStateOf(col: unknown): { rows: unknown[] } | null;
}
interface ModelMod { setRevealCapability(cap: unknown): void; setTurnEditsThreshold(n: number): void }
interface DictMod { localeDict(l: string): Record<string, string>; getLocale(): string }

let lastES: FakeES | null = null;
/** 最小 EventSource 替身（与 w9333 同一形状：真 SSE 帧 → 真 chat.ts 处理器）。 */
class FakeES {
  listeners: Record<string, Array<(e: unknown) => void>> = {};
  constructor() { lastES = this; }
  addEventListener(n: string, f: (e: unknown) => void): void { (this.listeners[n] ??= []).push(f); }
  close(): void { /* no-op */ }
  fire(name: string, payload: Record<string, unknown>): void {
    for (const f of this.listeners[name] ?? []) f({ data: JSON.stringify(payload) });
  }
}

const cols = (): ElLike[] => Array.from(doc.querySelectorAll('[data-turn-edits]'));
const card = (): ElLike | null => doc.querySelector('.te');
const listRows = (): ElLike[] => Array.from(doc.querySelectorAll('.te-row'));
const text = (sel: string): string => doc.querySelector(sel)?.textContent ?? '';
const menuLabels = (): string[] => Array.from(doc.querySelectorAll('.te-menu-item')).map((b) => b.textContent ?? '');
const toast = (): string => text('.te-toast');

/** 装配：真 viewctx + 真插件装配（启用表 + 登记项）+ 真接线。 */
async function boot(): Promise<{ A: ApplyMod; W: WireMod; pane: PaneLike }> {
  const V = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as unknown as ViewMod;
  V.initViewCtx();
  const pane = V.ensurePane(SESSION, 'session', '甲会话');
  V.activatePane(SESSION, 'session', '甲会话');
  const A = (await import(/* @vite-ignore */ at('plugins/apply.ts'))) as unknown as ApplyMod;
  A.startClientPlugins(); // 登记项在这里变成真挂载的增强遍（关掉 = 真注销）
  await A.whenClientPluginsReady();
  const W = (await import(/* @vite-ignore */ at('ui/turn-edits/wire.ts'))) as unknown as WireMod;
  W.initTurnEdits();
  return { A, W, pane };
}

/** 一次成功的写文件调用（调用帧 + 结果帧）。 */
function write(W: WireMod, pane: PaneLike, id: string, path: string): void {
  W.noteTurnToolCall(pane, { id, name: 'write_file', args: { path, content: 'x\n' } });
  W.noteTurnToolResult(pane, { id, ok: true });
}

/** 合成行直接建列（用来钉「来源给不出数字」时那条渲染契约）。 */
async function synthetic(rows: unknown[], shellish = 0): Promise<CardMod> {
  const C = (await import(/* @vite-ignore */ at('ui/turn-edits/card.ts'))) as unknown as CardMod;
  const E = (await import(/* @vite-ignore */ at('ui/enhance/index.ts'))) as unknown as { runEnhancers(c: unknown): void };
  const host = doc.createElement('div') as ElLike;
  doc.body.appendChild(host);
  host.appendChild(C.createTurnEditsColumn(rows, shellish));
  E.runEnhancers(host);
  return C;
}

function failClipboard(): void {
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: () => Promise.reject(new Error('denied')) },
  });
}
function okClipboard(): void {
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: () => Promise.resolve() },
  });
}
function execCommand(result: boolean | null): void {
  Object.defineProperty(doc, 'execCommand', { configurable: true, value: result === null ? undefined : () => result });
}

/**
 * 派发「插件开关/配置变了」这条事件（真源是 plugins/store.ts 的 notify()）。
 * 根 tsconfig 的 lib 里没有 DOM，`window` 这个名字不存在 —— 用 globalThis（jsdom 里
 * 二者同一对象），与夹具的 `doc`/`Ev` 同一口径。
 */
function pluginsChanged(): void {
  (globalThis as unknown as { dispatchEvent(e: unknown): void }).dispatchEvent(new Ev(KEY));
}

beforeEach(() => { resetHarness(); lastES = null; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); doc.body.replaceChildren(); });

describe('W9334 乙-① 结构（DOM 层面可判的几何）', () => {
  it('表头（图标 + 标题 + 副标题 + 折叠按钮）/ 行列表 / 页脚；每行是 字母+路径+动作', async () => {
    const { W, pane } = await boot();
    write(W, pane, 'c1', 'packages/core/src/sandbox.ts');
    W.settleTurnEdits(pane);
    expect(card()).not.toBeNull();
    const head = doc.querySelector('.te-head') as ElLike;
    expect(head.querySelector('.te-icon svg'), '表头图标').not.toBeNull();
    expect(head.querySelector('.te-title')?.textContent).toBeTruthy();
    expect(head.querySelector('.te-sub')?.textContent).toBeTruthy();
    expect(head.querySelector('.te-fold')?.getAttribute('aria-expanded'), '表头默认是展开的').toBe('true');
    expect(listRows()).toHaveLength(1);
    const r = listRows()[0] as ElLike;
    expect(r.querySelector('.te-kind')?.textContent, '字母标记').toBe('W');
    expect(r.querySelector('.te-path .te-file')?.textContent, '文件名单独成节点').toBe('sandbox.ts');
    expect(r.querySelector('.te-path .te-dir')?.textContent, '目录单独成节点').toBe('packages/core/src/');
    expect(r.querySelector('.te-open')?.textContent).toBe('打开');
    expect(r.querySelector('.te-caret')?.getAttribute('aria-haspopup')).toBe('menu');
    expect(r.querySelector('.te-caret')?.getAttribute('aria-expanded'), '菜单默认收起').toBe('false');
  });

  it('折叠箭头来自 ui/icons.ts 的 chevron：同网格、方向交给 CSS、装饰性可访问属性齐', async () => {
    const { W, pane } = await boot();
    write(W, pane, 'c1', 'a.ts');
    W.settleTurnEdits(pane);
    const svg = (doc.querySelector('.te-caret') as ElLike).querySelector('.te-chev') as ElLike;
    expect(svg.getAttribute('viewBox')).toBe('0 0 16 16');
    expect((svg.querySelector('path') as ElLike).getAttribute('d'), '与 toolcards/messages 同一枚几何').toBe('M6 3.5 10.5 8 6 12.5');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(svg.getAttribute('class'), '方向靠 class，不靠 Unicode 字形').toContain('is-down');
    expect(doc.body.innerHTML, '不得出现 ▾▸▴ 这类系统字体字形').not.toMatch(/[▾▸▴]/);
  });

  it('合成行：M/A/D 三种字母与每行 +X −Y 都画得出来（人给得出数字时）', async () => {
    await boot();
    await synthetic([
      { kind: 'edit', path: 'a.ts', add: 5, del: 1 },
      { kind: 'add', path: 'b.ts', add: 3, del: 0 },
      { kind: 'delete', path: 'c.ts', add: 0, del: 46 },
    ]);
    expect(Array.from(doc.querySelectorAll('.te-kind')).map((k) => k.textContent)).toEqual(['M', 'A', 'D']);
    const first = listRows()[0] as ElLike;
    expect(first.querySelector('.te-diff')?.textContent, '该行 +X −Y').toBe('+5−1');
    expect(text('.te-sum'), '表头聚合 = 全量').toBe('+8−47');
  });

  it('来源给不出数字（方案 A 的可达路径）⇒ 每行与聚合**都不出现**，不写 +0 −0', async () => {
    const { W, pane } = await boot();
    write(W, pane, 'c1', 'a.ts');
    W.settleTurnEdits(pane);
    expect(doc.querySelector('.te-diff'), '行的数字块不出现').toBeNull();
    expect(doc.querySelector('.te-sum'), '聚合块不出现（说一个偏小的数比不说更糟）').toBeNull();
    expect(text('.te-sub'), '副标题仍然给构成').toContain('写入 1');
  });
});

describe('W9334 乙-② 文案：真实已本地化（不是 key、不是空串，两语不同）', () => {
  it('卡片上的每一句都等于当前语言字典里的那一句', async () => {
    const { W, pane } = await boot();
    const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as unknown as DictMod;
    const d = i18n.localeDict(i18n.getLocale());
    write(W, pane, 'c1', 'a/b.ts');
    W.noteTurnToolCall(pane, { id: 'c2', name: 'run_shell', args: { command: 'x' } });
    W.noteTurnToolResult(pane, { id: 'c2', ok: true });
    W.settleTurnEdits(pane);
    expect(text('.te-title')).toBe((d['chat.turnEdits.title'] ?? '').replace('{n}', '1'));
    expect(text('.te-sub')).toBe((d['chat.turnEdits.kind.write'] ?? '').replace('{n}', '1'));
    expect(text('.te-note'), '看不见的调用如实附注').toBe((d['chat.turnEdits.otherCalls'] ?? '').replace('{n}', '1'));
    expect((doc.querySelector('.te-open') as ElLike).textContent).toBe(d['chat.turnEdits.open']);
    const zh = i18n.localeDict('zh');
    const en = i18n.localeDict('en');
    for (const k of ['chat.turnEdits.title', 'chat.turnEdits.empty', 'chat.turnEdits.copyFailed', 'chat.turnEdits.otherCalls']) {
      expect(zh[k], k + ' zh').toBeTruthy();
      expect(en[k], k + ' en').toBeTruthy();
      expect(zh[k], k + ' 不得把 key 当文案').not.toBe(k);
      expect(zh[k], k + ' 两种语言必须是两句不同的话').not.toBe(en[k]);
    }
  });
});

describe('W9334 乙-③ 阈值：插件配置（默认 5）真的决定折几行', () => {
  it('阈值 5 ⇒ 6 个文件只列 5 行 + 「还有 1 个文件…」；配置改成 2 ⇒ 只列 2 行', async () => {
    const { W, pane } = await boot();
    for (let i = 1; i <= 6; i += 1) write(W, pane, 'c' + i, 'f' + i + '.ts');
    W.settleTurnEdits(pane);
    expect(listRows()).toHaveLength(5);
    expect(text('.te-more'), '还有 1 个文件…').toBe('还有 1 个文件…');
    const M = (await import(/* @vite-ignore */ at('ui/turn-edits/model.ts'))) as unknown as ModelMod;
    M.setTurnEditsThreshold(2);
    // 阈值是**插件配置**：改完由 apply 层推给实现，卡片按同一条渲染路径重画。
    const C = (await import(/* @vite-ignore */ at('ui/turn-edits/card.ts'))) as unknown as CardMod;
    (C as unknown as { turnEditsStateOf(c: unknown): unknown }).turnEditsStateOf;
    pluginsChanged();
    expect(listRows(), '阈值 2 ⇒ 只列前 2 行').toHaveLength(2);
    M.setTurnEditsThreshold(5);
  });
});

describe('W9334 乙-④ 空态：卡片保留、去掉折叠按钮与聚合', () => {
  it('本轮只有 shell 调用 ⇒ 空态同形图标 + 两句文案 + 覆盖附注；没有折叠按钮、没有聚合', async () => {
    const { W, pane } = await boot();
    const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as unknown as DictMod;
    const d = i18n.localeDict(i18n.getLocale());
    W.noteTurnToolCall(pane, { id: 'c1', name: 'run_shell', args: { command: 'rm -rf x' } });
    W.noteTurnToolResult(pane, { id: 'c1', ok: true });
    W.settleTurnEdits(pane);
    expect(card()?.getAttribute('data-empty')).toBe('true');
    expect(text('.te-title')).toBe(d['chat.turnEdits.empty']);
    expect(text('.te-sub')).toBe(d['chat.turnEdits.emptySub']);
    expect(text('.te-note')).toBe((d['chat.turnEdits.otherCalls'] ?? '').replace('{n}', '1'));
    expect(doc.querySelector('.te-fold'), '空态去掉折叠按钮').toBeNull();
    expect(doc.querySelector('.te-sum'), '空态去掉聚合').toBeNull();
    expect(doc.querySelector('.te-list')).toBeNull();
    expect((doc.querySelector('.te-icon') as ElLike).className).toContain('is-empty');
    // 静音**同形**：与主图标同一个文档轮廓（同一个 d），只是降色。
    const emptyD = (doc.querySelector('.te-icon svg path') as ElLike).getAttribute('d');
    const C = (await import(/* @vite-ignore */ at('ui/turn-edits/card.ts'))) as unknown as { createTurnEditsColumn(r: unknown[], s: number): ElLike };
    const host = doc.createElement('div') as ElLike;
    doc.body.appendChild(host);
    host.appendChild(C.createTurnEditsColumn([{ kind: 'write', path: 'a.ts', add: null, del: null }], 0));
    (await import(/* @vite-ignore */ at('ui/enhance/index.ts')) as unknown as { runEnhancers(c: unknown): void }).runEnhancers(host);
    const solidD = (host.querySelector('.te-icon svg path') as ElLike).getAttribute('d');
    expect(emptyD, '空态与常态是同一个文档轮廓').toBe(solidD);
  });

  it('纯聊天轮（一个工具调用都没有）⇒ 连卡片都不出现（空卡是噪声）', async () => {
    const { W, pane } = await boot();
    W.settleTurnEdits(pane);
    expect(cols()).toHaveLength(0);
    expect(card()).toBeNull();
  });
});

describe('W9334 乙-⑤ 双向折叠：点开 / 收起 / 再点开都闭合，且聚合不随折叠变', () => {
  it('「还有 N 个文件…」→ 全部 + 「收起」→ 回到阈值内 → 再展开', async () => {
    const { W, pane } = await boot();
    for (let i = 1; i <= 8; i += 1) write(W, pane, 'c' + i, 'f' + i + '.ts');
    W.settleTurnEdits(pane);
    expect(listRows()).toHaveLength(5);
    click(doc.querySelector('.te-more'), true);
    expect(listRows(), '展开 ⇒ 全部 8 行').toHaveLength(8);
    expect(text('.te-more'), '双向：展开后给的是「收起」').toContain('收起');
    click(doc.querySelector('.te-more'), true);
    expect(listRows(), '收起 ⇒ 回到阈值内').toHaveLength(5);
    click(doc.querySelector('.te-more'), true);
    expect(listRows(), '再展开仍能闭合').toHaveLength(8);
  });

  it('聚合按全量算：折叠前后表头是同一个数（折叠一次数字就变 ⇒ 无法解释）', async () => {
    await boot();
    await synthetic([
      { kind: 'add', path: 'a.ts', add: 3, del: 0 },
      { kind: 'edit', path: 'b.ts', add: 5, del: 1 },
      { kind: 'delete', path: 'c.ts', add: 0, del: 46 },
      { kind: 'edit', path: 'd.ts', add: 2, del: 1 },
      { kind: 'edit', path: 'e.ts', add: 2, del: 1 },
      { kind: 'edit', path: 'f.ts', add: 2, del: 1 },
    ]);
    expect(listRows()).toHaveLength(5);
    const before = text('.te-sum');
    click(doc.querySelector('.te-more'), true);
    expect(listRows()).toHaveLength(6);
    expect(text('.te-sum'), '展开后仍是同一个聚合').toBe(before);
    expect(before, '删除的文件也进聚合').toBe('+14−50');
  });

  it('表头折叠按钮：点一下整卡折叠（列表与页脚都不显示），再点回来', async () => {
    const { W, pane } = await boot();
    write(W, pane, 'c1', 'a.ts');
    W.settleTurnEdits(pane);
    const fold = doc.querySelector('.te-fold') as ElLike;
    click(fold, true);
    expect(card()?.getAttribute('data-folded')).toBe('true');
    expect((doc.querySelector('.te-fold') as ElLike).getAttribute('aria-expanded')).toBe('false');
    click(doc.querySelector('.te-fold'), true);
    expect(card()?.getAttribute('data-folded')).toBe('false');
  });
});

describe('W9334 乙-⑥ 平台门控：Linux 上整项不出现（不是禁用）', () => {
  it('没有宿主动作 / Linux ⇒ 菜单只有「打开」「复制路径」；macOS ⇒ 多出「在文件管理器中显示」', async () => {
    const { W, pane } = await boot();
    const M = (await import(/* @vite-ignore */ at('ui/turn-edits/model.ts'))) as unknown as ModelMod;
    write(W, pane, 'c1', 'a.ts');
    W.settleTurnEdits(pane);
    const caret = doc.querySelector('.te-caret') as ElLike;
    click(caret, true);
    expect(menuLabels()).toEqual(['打开', '复制路径']);
    click(caret, true);
    M.setRevealCapability({ platform: 'linux', reveal: () => { /* 不该被调到 */ } });
    pluginsChanged(); // 重画（同一渲染路径）
    click(doc.querySelector('.te-caret'), true);
    expect(menuLabels(), 'Linux：整项**不出现**').toEqual(['打开', '复制路径']);
    const fired: string[] = [];
    M.setRevealCapability({ platform: 'macos', reveal: (p: string) => fired.push(p) });
    pluginsChanged();
    click(doc.querySelector('.te-caret'), true);
    expect(menuLabels()).toEqual(['打开', '在文件管理器中显示', '复制路径']);
    const reveal = Array.from(doc.querySelectorAll('.te-menu-item')).find((b) => b.textContent === '在文件管理器中显示') as ElLike;
    click(reveal, true);
    expect(fired, '点了就真的执行宿主动作').toEqual(['a.ts']);
    M.setRevealCapability(null);
  });
});

describe('W9334 乙-⑦ 复制路径：失败要如实显示「复制失败」', () => {
  it('两条路都失败 ⇒ 显示「复制失败」且用失败色；回退成功 ⇒ 「已复制路径」', async () => {
    const { W, pane } = await boot();
    const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as unknown as DictMod;
    const d = i18n.localeDict(i18n.getLocale());
    write(W, pane, 'c1', 'a.ts');
    W.settleTurnEdits(pane);
    failClipboard();
    execCommand(null); // execCommand 不存在（jsdom 实况）
    click(doc.querySelector('.te-caret'), true);
    const copy = Array.from(doc.querySelectorAll('.te-menu-item')).find((b) => b.textContent === '复制路径') as ElLike;
    click(copy, true);
    await flush(2);
    expect(toast()).toBe(d['chat.turnEdits.copyFailed']);
    expect((doc.querySelector('.te-toast') as ElLike).className, '失败不得用成功色').toContain('is-err');
    // 回退通道能成 ⇒ 如实报成功（不因为 clipboard 不可用就直接放弃）
    execCommand(true);
    click(doc.querySelector('.te-caret'), true);
    const copy2 = Array.from(doc.querySelectorAll('.te-menu-item')).find((b) => b.textContent === '复制路径') as ElLike;
    click(copy2, true);
    await flush(2);
    expect(toast()).toBe(d['chat.turnEdits.copied']);
    expect((doc.querySelector('.te-toast') as ElLike).className).not.toContain('is-err');
    okClipboard();
    click(doc.querySelector('.te-caret'), true);
    const copy3 = Array.from(doc.querySelectorAll('.te-menu-item')).find((b) => b.textContent === '复制路径') as ElLike;
    click(copy3, true);
    await flush(2);
    expect(toast()).toBe(d['chat.turnEdits.copied']);
  });
});

describe('W9334 乙-⑧ 插件门控：关掉 ⇒ 这张卡整体不出现', () => {
  it('关掉时结算**连空列都不留**；已渲染的卡在关掉后立刻消失，重新打开又回来', async () => {
    const { W, pane } = await boot();
    const R = (await import(/* @vite-ignore */ at('plugins/register.ts'))) as unknown as RegisterMod;
    R.deactivatePlugin(ID);
    write(W, pane, 'c1', 'a.ts');
    W.settleTurnEdits(pane);
    expect(cols(), '关掉插件 ⇒ 不挂列（不是挂一张空卡）').toHaveLength(0);

    R.activatePlugin(ID);
    write(W, pane, 'c2', 'b.ts');
    W.settleTurnEdits(pane);
    expect(card()).not.toBeNull();
    R.deactivatePlugin(ID);
    pluginsChanged();
    expect((cols()[0] as unknown as { childElementCount: number }).childElementCount, '已渲染的卡被收掉（列留空，不占位）').toBe(0);
    R.activatePlugin(ID);
    pluginsChanged();
    expect(card(), '重新打开后按同一账本重画').not.toBeNull();
    expect(listRows()).toHaveLength(1);
  });
});

describe('W9334 乙-⑨ 活路径：真 SSE 帧驱动（工具帧 → 结果帧 → 轮次终态）', () => {
  it('一轮里写了文件 ⇒ 轮次结束出现卡片；纯聊天轮 ⇒ 不出现', async () => {
    const { pane } = await boot();
    vi.stubGlobal('EventSource', FakeES);
    const chat = (await import(/* @vite-ignore */ at('chat.ts'))) as unknown as { connectSse(): void };
    chat.connectSse();
    expect(pane.id).toBe(SESSION);
    lastES!.fire('status', { phase: 'start', turn: 1, session: SESSION });
    await flush(4);
    lastES!.fire('tool', { id: 'c1', name: 'write_file', args: { path: 'apps/web/src/ui/icons.ts', content: 'x\n' }, turn: 1, session: SESSION });
    lastES!.fire('tool_result', { id: 'c1', ok: true, value: 'ok', turn: 1, session: SESSION });
    await flush(4);
    expect(card(), '轮次没结束 ⇒ 还没有卡').toBeNull();
    lastES!.fire('status', { phase: 'completed', turn: 1, session: SESSION });
    await flush(6);
    expect(card()).not.toBeNull();
    expect(text('.te-title')).toContain('1');
    expect((doc.querySelector('.te-path .te-file') as ElLike).textContent).toBe('icons.ts');
    // 第二轮：没有任何工具调用 ⇒ 不产生第二张卡
    lastES!.fire('status', { phase: 'start', turn: 2, session: SESSION });
    lastES!.fire('status', { phase: 'completed', turn: 2, session: SESSION });
    await flush(6);
    expect(cols(), '纯聊天轮不长空卡').toHaveLength(1);
  });
});

describe('W9334 乙-⑩ 策略：组件层零硬编码颜色（铁律 11 允许的策略例外）', () => {
  it('turn-edits 的 ts/css 里没有 hex / rgb() / hsl() 字面量', () => {
    const files = [
      join(WEB, 'src', 'ui', 'turn-edits', 'model.ts'),
      join(WEB, 'src', 'ui', 'turn-edits', 'card.ts'),
      join(WEB, 'src', 'ui', 'turn-edits', 'wire.ts'),
      join(WEB, 'src', 'styles', 'turn-edits.css'),
    ];
    const bad: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g)) bad.push(f + ' -> ' + String(m[0]));
    }
    expect(bad).toEqual([]);
  });
});
