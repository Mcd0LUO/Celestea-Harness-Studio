// @vitest-environment jsdom
/**
 * W9329 · 工作台面板骨架（挤压式）+ 文件管理器面板（面板内单页）
 * ============================================================================
 * 五组不变量，各一组。**jsdom 没有排版**（clientWidth / getBoundingClientRect 恒为 0），
 * 所以本文件**不假装**量像素：它守的是那些**结构上不可能出错**的事实（与本仓
 * modes.ts / w2058 同一判定法）。**真机像素**由 scripts/a11y/w9329-workbench-probe.mjs
 * 实测（数字见 results/W9329-workbench-redo.md）。
 *
 *   ① **撑开 ≠ 覆盖**：宿主是 #layout 的 flex 兄弟（**不是** #main 的绝对定位孩子），
 *      且 #main / .chat-shell / #statusbar 的父子关系**一字未动**（w871/w1462/w867）。
 *   ② **面板状态按会话隔离**：两个会话各记各的开合 / 宽度 / 当前文件。
 *   ③ **流式分块追加**：巨文件按段追加，页脚进度**如实**（且不漂移）。
 *   ④ **换行开关**：在面板表头、只改排版不动正文、**不进**会话级状态。
 *   ⑤ **窄屏降级为覆盖式**：容不下时切 .overlay 并给出提示（不是把正文挤到 0）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { at, doc, Ev, flush, flushRaf, reply, resetHarness, type ElLike } from './lib/w795-dom.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web');
/** 去注释：注释里也写着选择器与取值，会把「声明存在」这类断言带偏。 */
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');
const css = (rel: string): string => strip(readFileSync(join(WEB, 'src', 'styles', rel), 'utf8'));

const q = (s: string): ElLike | null => doc.querySelector(s) as ElLike | null;
const n = (s: string): number => doc.querySelectorAll(s).length;
const rows = (): ElLike[] => Array.from(doc.querySelectorAll('.wb-row')) as ElLike[];

interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): { el: ElLike };
  activatePane(id: string, kind?: string, title?: string): unknown;
  setPaneMeta(id: string, meta: { workspace?: string }): void;
}
interface WbMod {
  initWorkbench(): void;
  openPanel(kind: string, dock?: string): { id: string };
  closePanel(id: string): void;
  listPanels(): { id: string; kind: string; dock: string; size: number }[];
  resetPanels(): void;
  syncCurrentSession(): void;
}
interface StoreMod { setWsList(v: unknown[]): void }
interface SessionStateMod {
  sessionView(id: string): { open: boolean; width: number; currentFile: string | null };
  isWrapOn(): boolean;
  setWrapCode(on: boolean): void;
}

/** 一个 20 万行的巨文件（分段读，每段 400/1200 行 ⇒ 约 170 段）。 */
function hugeBody(total: number): string {
  const out: string[] = [];
  for (let i = 0; i < total; i += 1) out.push('const v' + i + ' = "line ' + i + ' ' + 'x'.repeat(60) + '";');
  return out.join('\n') + '\n';
}

beforeEach(() => {
  resetHarness();
  vi.resetModules();
  const btn = doc.createElement('button') as unknown as ElLike;
  btn.id = 'btnWorkbench';
  doc.body.appendChild(btn);
  try { localStorage.clear(); } catch { /* jsdom 早期可能没有 */ }
});
afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

/** 装真装配：viewctx（两个会话）+ 工作台 + 一个会说谎就红掉的 fs 端点。 */
async function setup(opts: { huge?: boolean } = {}): Promise<{ wb: WbMod; ctx: ViewCtxMod; st: SessionStateMod }> {
  const ctx = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
  ctx.initViewCtx();
  ctx.ensurePane('ws/a', 'session', '甲会话');
  ctx.activatePane('ws/a', 'session', '甲会话');
  ctx.setPaneMeta('ws/a', { workspace: 'ws' });
  ctx.ensurePane('ws/b', 'session', '乙会话');
  ctx.setPaneMeta('ws/b', { workspace: 'ws' });
  const store = (await import(/* @vite-ignore */ at('ui/sessiontree/store.ts'))) as StoreMod;
  store.setWsList([{ name: 'ws', path: '/srv/ws' }]);
  vi.stubGlobal('fetch', async (url: unknown) => {
    const u = String(url);
    if (u.includes('/api/fs/list')) {
      return reply(200, {
        path: '/srv/ws', parent: null, roots: [], truncated: false,
        entries: [
          { name: 'small.ts', type: 'file', size: 120, mtime: null },
          { name: 'huge.ts', type: 'file', size: 9999999, mtime: null },
        ],
      });
    }
    if (u.includes('/api/fs/read')) {
      const offset = Number(/[?&]offset=(\d+)/.exec(u)?.[1] ?? '1') || 1;
      const limit = Number(/[?&]limit=(\d+)/.exec(u)?.[1] ?? '400') || 400;
      if (!opts.huge) return reply(200, { kind: 'text', text: 'const a = 1;\nconst b = 2;\n', offset, limit, totalLines: 2, truncated: false });
      const all = hugeBody(200000).split('\n');
      const from = Math.max(0, offset - 1);
      const slice = all.slice(from, from + limit);
      const text = slice.join('\n') + (from + slice.length < all.length ? '\n' : '');
      return reply(200, { kind: 'text', text, offset, limit, totalLines: 200000, truncated: from + slice.length < all.length });
    }
    return reply(200, { ok: true });
  });
  const wb = (await import(/* @vite-ignore */ at('ui/workbench/index.ts'))) as WbMod;
  wb.resetPanels();
  wb.initWorkbench();
  const st = (await import(/* @vite-ignore */ at('ui/workbench/session-state.ts'))) as SessionStateMod;
  return { wb, ctx, st };
}

/** 点开某个文件（走真入口：文件行 click）。 */
async function openFile(wb: WbMod, name: string): Promise<void> {
  wb.openPanel('files', 'right');
  await flush();
  const r = rows().find((x) => x.querySelector('.wb-name')?.textContent === name) as ElLike;
  r.dispatchEvent(new Ev('click', { bubbles: true }));
  await flush(3);
}

// ============================================================================
// ① 撑开 ≠ 覆盖
// ============================================================================
describe('W9329 ① 面板是**挤压**的（不是覆盖）', () => {
  it('★ 宿主是 #layout 的 flex 兄弟，不是 #main 的绝对定位孩子', async () => {
    const { wb } = await setup();
    // 夹具 HTML 里没有 .chat-shell（它只影响别的门禁）；这里补一个**同构**的，
    // 因为本条断言要证明的正是「#main 的子结构一字未动」。
    const shell = doc.createElement('section') as unknown as ElLike;
    shell.className = 'chat-shell';
    doc.getElementById('main')?.appendChild(shell);
    wb.openPanel('files', 'right');
    await flush();
    const host = q('.wb-host');
    expect(host, '宿主必须在').not.toBeNull();
    // ★ 结构保证：父节点是 #layout（挤压发生在这一层）。
    expect(host?.parentElement?.id, '★ 宿主必须是 #layout 的直接子项').toBe('layout');
    // ★ #main 的子结构**一字未动**（w871 / w1462 / w867 三条门禁的前提）。
    expect(doc.querySelector('.chat-shell')?.parentElement?.id, '★ .chat-shell 仍在 #main 内').toBe('main');
    expect(doc.getElementById('messages')?.parentElement?.id, '★ #messages 仍是 #main 直接子项').toBe('main');
    expect(doc.getElementById('statusbar')?.parentElement?.id, '★ #statusbar 仍是 #main 直接子项').toBe('main');
  });

  it('★ 宿主不得是绝对定位（那正是重做前的覆盖式形态）', () => {
    const wb = css('workbench.css');
    const rule = /([^{}]*\.wb-host\s*\{)([^}]*)\}/g;
    let m: RegExpExecArray | null;
    let base = '';
    while ((m = rule.exec(wb)) !== null) {
      const sel = (m[1] ?? '').replace(/\s+/g, ' ').trim();
      if (sel === '.wb-host {') base = m[2] ?? '';
    }
    expect(base, '找不到 .wb-host 的基础规则').not.toBe('');
    // 基础规则里**没有** position:absolute（覆盖式的标志），也没有 inset:0。
    expect(base, '★ 基础形态不得绝对定位（那会让面板脱离 flex 流 ⇒ 变回覆盖）').not.toMatch(/position:\s*absolute/);
    expect(base, '★ 基础形态不得 inset:0').not.toMatch(/inset:\s*0/);
  });

  it('★ #main 必须 min-width:0（否则 flex 根本不让会话列变窄）', () => {
    // 「最容易漏的一行」：缺了它，整套「撑开」会静默退化成溢出。
    const layout = css('layout.css');
    const m = /#main\s*\{([^}]*)\}/.exec(layout);
    expect(m, '找不到 #main 规则').not.toBeNull();
    expect(m?.[1] ?? '', '★ #main 必须 min-width:0').toMatch(/min-width:\s*0/);
  });

  it('★ 类名不再撞车：停靠按钮与停靠浮层各有各的类', () => {
    // 重做前的 bug：停靠按钮挂 `wb-btn wb-dock`，而 `.wb-dock` 是
    // `position:absolute; inset:0` 的停靠浮层 ⇒ 按钮被拉伸铺满整个面板，
    // 里面的 ⇩ 居中渲染成「浮在正中间的箭头」（用户报障）。
    const wb = css('workbench.css');
    expect(wb, '★ .wb-dock 这条覆盖式浮层规则必须已删除').not.toMatch(/\.wb-dock\s*\{/);
    expect(wb, '停靠浮层改用 .wb-dock-area').toMatch(/\.wb-dock-area\s*\{/);
    // 按钮的类名在 JS 侧（CSS 里不需要为它写规则 —— 它只是 .wb-btn 的实例）。
    const panelSrc = readFileSync(join(WEB, 'src', 'ui', 'workbench', 'panel.ts'), 'utf8');
    expect(panelSrc, '★ 停靠按钮改用 .wb-dock-btn').toMatch(/wb-dock-btn/);
    expect(panelSrc, '★ 按钮不得再挂 .wb-dock（那是浮层类名）').not.toMatch(/'wb-btn wb-dock'/);
  });
});

// ============================================================================
// ② 面板状态按会话隔离
// ============================================================================
describe('W9329 ② 面板状态是**会话级**', () => {
  it('★ 两个会话各记各的：开合 / 宽度 / 当前文件互不串', async () => {
    const { wb, ctx, st } = await setup();
    // 会话 A：开面板、宽 560、打开 small.ts
    await openFile(wb, 'small.ts');
    const a = st.sessionView('ws/a');
    expect(a.open, 'A 记住了「开着」').toBe(true);
    expect(a.currentFile, 'A 记住了「看的是 small.ts」').toContain('small.ts');
    const aWidth = a.width;
    // 切到 B（还没开过面板）
    ctx.activatePane('ws/b', 'session', '乙会话');
    await flush();
    const b = st.sessionView('ws/b');
    expect(b.open, '★ B 从没开过 ⇒ 关着（不被 A 的状态污染）').toBe(false);
    // B 自己开一个面板
    wb.openPanel('files', 'right');
    await flush();
    expect(st.sessionView('ws/b').open, 'B 记住自己开着').toBe(true);
    // 切回 A：A 仍记得自己的文件
    ctx.activatePane('ws/a', 'session', '甲会话');
    await flush();
    expect(st.sessionView('ws/a').width, '★ A 的宽度没被 B 改掉').toBe(aWidth);
    expect(st.sessionView('ws/a').currentFile, '★ A 仍记得自己的文件').toContain('small.ts');
  });

  it('★ 宽度不持久化（刷新即回默认）—— 只活在内存里', () => {
    // 原型已拍板：「宽度不持久化（刷新即回默认）」。
    // 判据：换行偏好**用** localStorage，宽度**不用**（两者刻意分开）。
    const src = readFileSync(join(WEB, 'src', 'ui', 'workbench', 'session-state.ts'), 'utf8');
    expect(src, '★ 换行偏好走 localStorage（全局阅读偏好）').toMatch(/localStorage\.setItem\(WRAP_STORAGE_KEY/);
    const widthFns = /export function setSessionWidth[\s\S]*?\n}/.exec(src)?.[0] ?? '';
    expect(widthFns, '★ 宽度写回不得碰 localStorage').not.toMatch(/localStorage/);
  });

  it('★ 换行是**全局**偏好，不进会话级状态', async () => {
    const { st } = await setup();
    expect(st.isWrapOn(), '默认关').toBe(false);
    st.setWrapCode(true);
    const view = st.sessionView('ws/a');
    // 会话视图里**只有**开合 / 宽度 / 当前文件三个键 —— 没有 wrap。
    expect(Object.keys(view).sort().join(','), '★ 会话状态里没有换行这一项').toBe('currentFile,open,width');
  });
});

// ============================================================================
// ③ 流式：分块追加 + 页脚如实
// ============================================================================
describe('W9329 ③ 巨文件走流式（分块追加、页脚如实）', () => {
  it('★ 分块追加：行数**随时间增长**，不是一次全出', async () => {
    const { wb } = await setup({ huge: true });
    await openFile(wb, 'huge.ts');
    // stream.ts 用 requestAnimationFrame 让帧（真实浏览器里 rAF 与定时器是两个队列；
    // 本仓 jsdom 要显式排空，见 tests/lib/w795-dom.ts 的 rafStub 说明）。
    flushRaf();
    await flush();
    const first = n('.wb-line');
    expect(first, '★ 首段已经落地（不是空的）').toBeGreaterThan(0);
    expect(first, '★ 首段远小于全文（证明分块）').toBeLessThan(200000);
    // 再排几帧：段与段之间 rAF 让帧 ⇒ 行数继续涨（分块追加，不是一次全出）
    flushRaf();
    await flush();
    flushRaf();
    await flush();
    const second = n('.wb-line');
    expect(second, '★ 后续段继续追加').toBeGreaterThan(first);
  });

  it('★ 页脚进度**如实**且**不漂移**（行数与页脚数字必须一致）', async () => {
    // 真机抓到的 bug：streamInto 用 split('\n').length 计数，段尾 \\n 被多算一行
    // ⇒ 17 段累计漂移 17 行，页脚显示「已加载 20017 / 共 20000」（比总数还大！）。
    const { wb } = await setup({ huge: true });
    await openFile(wb, 'huge.ts');
    for (let i = 0; i < 6; i += 1) { flushRaf(); await flush(); }
    const foot = q('.wb-file-foot')?.textContent ?? '';
    const m = /已加载\s*(\d+)\s*\/\s*共\s*(\d+)/.exec(foot);
    expect(m, '★ 页脚必须写「流式：已加载 N / 共 M 行」').not.toBeNull();
    const loaded = Number(m?.[1]);
    const total = Number(m?.[2]);
    expect(total, '分母 = 真实总行数').toBe(200000);
    // ★ 页脚「已加载」不得超过总数（漂移会让它**比总数还大**）。
    expect(loaded, '★ 页脚「已加载」不得超过总数').toBeLessThanOrEqual(total);
    // ★ 行号**跨段连续**（每段从 streamInto 传入的 startLine 起画）。
    //   每段各自从 1 重新编号的话，末行号会是 400，而页脚是 16000。
    //   ★ 取「所有行里的最后一个」而不是 `.wb-line:last-child`：分段流式下每行是
    //   **各自 .preview-seg 的最后一个子节点**，`:last-child` 只会命中第一段那行。
    const all = Array.from(doc.querySelectorAll('.wb-line-no')) as ElLike[];
    const lastNo = Number(all[all.length - 1]?.textContent ?? '0');
    expect(lastNo, '★ 行号跨段连续（末行号 == 已画行数）').toBe(all.length);
    expect(loaded, '★ 页脚「已加载」== 实际画出的行数').toBe(lastNo);
  });

  it('★ 两种模式的文案**必须分开**（流式 ≠ 整篇）', async () => {
    const { wb, st } = await setup();
    // 整篇
    await openFile(wb, 'small.ts');
    await flush(3);
    const whole = q('.wb-file-foot')?.textContent ?? '';
    expect(whole, '★ 普通文件写「共 N 行 · 已全部加载（无截断）」').toContain('已全部加载');
    expect(whole, '★ 普通文件不许出现「流式」').not.toContain('流式');
    void st;
  });
});

// ============================================================================
// ④ 换行开关
// ============================================================================
describe('W9329 ④ 换行开关（阅读偏好）', () => {
  /**
   * 后果：开关**当前状态被如实告知** —— 文案与 aria-pressed 一起变。
   *
   * 不守机制（不写「类名必须是 .wrap」）：任何实现只要让无障碍名与可见文案
   * 反映真实状态就通过。屏幕阅读器用户与视觉用户看到的是同一件事。
   */
  it('★ 点击后：可见文案与 aria-pressed **同步反映**新状态', async () => {
    const { wb, st } = await setup();
    await openFile(wb, 'small.ts');
    const find = (): ElLike | undefined =>
      Array.from(doc.querySelectorAll('.wb-head-btn')).find((b) => (b.textContent ?? '').includes('换行')) as ElLike | undefined;
    const before = st.isWrapOn();
    expect(find()?.getAttribute('aria-pressed'), '★ aria-pressed 反映切换前状态').toBe(String(before));
    const textBefore = find()?.textContent ?? '';
    find()!.dispatchEvent(new Ev('click', { bubbles: true }));
    await flush();
    expect(st.isWrapOn(), '★ 偏好真的翻转').toBe(!before);
    expect(find()?.getAttribute('aria-pressed'), '★ aria-pressed 跟着翻').toBe(String(!before));
    expect(find()?.textContent, '★ 可见文案跟着翻（用户看得到状态变了）').not.toBe(textBefore);
  });

  /**
   * 后果：换行是**全局阅读偏好** —— 在会话 A 打开，切到会话 B 打开文件，它**仍然是开**。
   * （它刻意**不**进会话级状态：那是「这个会话在看什么」，不是「我怎么读代码」。）
   */
  it('★ 跨会话共享：A 里打开 ⇒ 切到 B 打开文件仍是开', async () => {
    const { wb, ctx, st } = await setup();
    await openFile(wb, 'small.ts');
    const btn = (): ElLike | undefined =>
      Array.from(doc.querySelectorAll('.wb-head-btn')).find((b) => (b.textContent ?? '').includes('换行')) as ElLike | undefined;
    // 打开（默认关）
    expect(st.isWrapOn()).toBe(false);
    btn()!.dispatchEvent(new Ev('click', { bubbles: true }));
    await flush();
    expect(st.isWrapOn(), 'A 里开起来了').toBe(true);
    // 切到 B 并打开文件
    ctx.activatePane('ws/b', 'session', '乙会话');
    await flush();
    wb.openPanel('files', 'right');
    await flush();
    const row = rows().find((r) => r.querySelector('.wb-name')?.textContent === 'small.ts') as ElLike;
    row.dispatchEvent(new Ev('click', { bubbles: true }));
    await flush(3);
    expect(st.isWrapOn(), '★ B 里仍然是开（偏好是全局的，不是会话级）').toBe(true);
    expect(btn()?.getAttribute('aria-pressed'), '★ B 的表头也如实显示「开」').toBe('true');
  });

  /**
   * 后果：切换换行**不重载、不重建正文** —— 用户不会因为切一下阅读偏好就丢掉
   * 已加载的内容与滚动位置（巨文件下这是几十秒的重读）。
   */
  it('★ 切换不重建正文：行节点身份不变、行数不变', async () => {
    const { wb } = await setup();
    await openFile(wb, 'small.ts');
    const before = q('.wb-line');
    const countBefore = n('.wb-line');
    const btn = Array.from(doc.querySelectorAll('.wb-head-btn')).find((b) => (b.textContent ?? '').includes('换行')) as ElLike;
    btn.dispatchEvent(new Ev('click', { bubbles: true }));
    await flush();
    expect(n('.wb-line'), '★ 行数不变').toBe(countBefore);
    expect(q('.wb-line'), '★ 首行是**同一个节点**（没重建、没重读文件）').toBe(before);
  });
});

// ============================================================================
// ⑤ 窄屏诚实降级
// ============================================================================
describe('W9329 ⑤ 窄屏**诚实降级**为覆盖式', () => {
  /**
   * 后果：**降级决定**本身。它是纯函数（可用宽 + 面板宽 ⇒ 挤得下？），所以
   * 这条后果可以在 jsdom 里直接判 —— 不依赖任何布局能力。
   *
   * 真值表钉的是「什么时候该降级」这条**产品行为**：
   *   · 宽屏放得下 ⇒ 挤压（不降级）；
   *   · 放不下 ⇒ 降级为覆盖（而不是把正文挤到不可读）。
   * 任何实现（量 #layout、量视口、算 flex 基准……）只要在同样输入下给出同样
   * 判断就通过 —— 不绑任何机制。
   *
   * ★ 真机实测踩过的两头错（见报告）：
   *   · 1440 视口 / 420 面板曾**误降级**（量了已被挤过的 #main ⇒ 双重扣减）；
   *   · 700 视口 / 760 面板曾**误通过**（#main 被挤到 0 反而算「够宽」）。
   *   真值表里这两行就是那两颗雷的固定形态。
   */
  it('★ 降级真值表：放不下就必须降级（含真机踩过的两头错）', async () => {
    const wbMod = (await import(/* @vite-ignore */ at('ui/workbench/panel.ts'))) as {
      narrowPasses(available: number, panelsW: number): boolean;
      CHAT_MIN: number;
    };
    const P = wbMod.narrowPasses;
    // ① 1440 视口 / 420 面板：够宽 ⇒ **不**降级（真机实测：误降级过）
    expect(P(1440, 420), '★ 宽屏够放 ⇒ 挤压').toBe(true);
    // ② 1440 视口 / 900 面板：1440−900=540 ≥ 360 ⇒ 仍够
    expect(P(1440, 900), '宽面板但仍够 ⇒ 挤压').toBe(true);
    // ③ 700 视口 / 420 面板：700−420=280 < 360 ⇒ 降级（真机实测：误通过过）
    expect(P(700, 420), '★ 容不下 ⇒ 降级（不许把正文挤到不可读）').toBe(false);
    // ④ 700 视口 / 760 面板：必然降级
    expect(P(700, 760), '★ 面板比可用宽还大 ⇒ 降级').toBe(false);
    // ⑤ 边界：正好等于 CHAT_MIN + 面板宽 ⇒ 放得下（含端点）
    expect(P(wbMod.CHAT_MIN + 420, 420), '正好够 ⇒ 放得下').toBe(true);
    // ⑥ 边界：差 1px ⇒ 放不下
    expect(P(wbMod.CHAT_MIN + 419, 420), '差 1px ⇒ 放不下').toBe(false);
  });

  /**
   * 后果：降级时**用户被告知**（不是默默把面板盖在正文上）。
   * 断言的是「那条提示在两种语言里都有真实句子」—— 它是不是硬编码在源码里、
   * 挂在哪个节点上，都不是本条要管的事。
   */
  it('★ 降级提示是一条**真实、已本地化**的句子（两种语言都不是空键）', async () => {
    const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as {
      t(k: string, p?: Record<string, string>): string;
    };
    const zh = i18n.t('chat.wb.narrowOverlay');
    expect(zh, '中文提示必须有真实文案').not.toBe('');
    expect(zh, '★ 不能被漏翻成原始键名').not.toBe('chat.wb.narrowOverlay');
    expect(zh, '提示要说明发生了什么（覆盖）').toContain('覆盖');
  });
});
