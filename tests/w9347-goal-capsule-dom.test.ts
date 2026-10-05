// @vitest-environment jsdom
/**
 * W9347 · 目标**浮动胶囊**（聊天区上方）—— jsdom 能量的那部分后果。
 *
 * 判据全是**后果**（铁律 11）：胶囊显隐、三个动作**各发什么请求**、展开编辑的
 * 保存/取消语义、以及 origin=goal 的注入行**显示成标签块而不是用户气泡**。
 * 量不了的（单行、≈2 汉字宽且真截断、命中区 ≥24px、不占布局）去真机量 ——
 * 见 scripts/a11y/w9347-goal-capsule-probe.mjs。
 *
 * stub 按冻结契约 v1 应答：{text?}/{paused?} 至少一个，先 text 再 paused，
 * 无目标时 pause = 422，回声里 paused 恒在。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flush, reply, resetHarness, type ElLike } from './lib/w795-dom.js';

interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): unknown;
  activatePane(id: string, kind?: string, title?: string): unknown;
  el: ElLike;
}
interface GoalMod {
  applyGoal(ctx: unknown, text: string): Promise<unknown>;
  renderGoalBar(): void;
}
interface MsgMod { renderInboxMessage(ctx: unknown, text: string, opts?: unknown): ElLike }

interface Body { text?: string; paused?: boolean }
interface Req { url: string; method: string; body: Body }

/** 契约忠实的 goal 端点 stub（按 file 头口径实现；`store` 就是后端 sidecar 的替身）。 */
function goalFetch(reqs: Req[]): (url: unknown, init?: { method?: string; body?: unknown }) => Promise<unknown> {
  let store: { text: string; paused: boolean } | null = null;
  return async (url: unknown, init?: { method?: string; body?: unknown }) => {
    const u = String(url);
    if (!/^\/api\/sessions\/.+\/goal$/.test(u)) return reply(404, { ok: false, error: 'not found' });
    let body: Body = {};
    try { body = JSON.parse(String(init?.body ?? '{}')) as Body; } catch { body = {}; }
    reqs.push({ url: u, method: String(init?.method ?? 'GET'), body });
    const hasText = Object.prototype.hasOwnProperty.call(body, 'text');
    const hasPaused = Object.prototype.hasOwnProperty.call(body, 'paused');
    if (hasText && typeof body.text !== 'string') return reply(422, { ok: false, error: "text must be a string" });
    if (hasPaused && typeof body.paused !== 'boolean') return reply(422, { ok: false, error: "paused must be a boolean" });
    if (hasText) {
      const t = (body.text as string).trim();
      store = t === '' ? null : { text: t, paused: store?.paused ?? false };
    }
    if (hasPaused && store === null) return reply(422, { ok: false, error: 'cannot pause: no goal' });
    if (hasPaused && store !== null) store = { text: store.text, paused: body.paused === true };
    const goal = store === null ? null : { text: store.text, paused: store.paused, createdAt: 'a', updatedAt: 'b' };
    return reply(200, { ok: true, session: 'ws/s1', goal });
  };
}

const capsule = (): ElLike | null => doc.querySelector('.goal-capsule');
const visible = (): boolean => capsule() !== null && !capsule()!.classList.contains('hidden');
/** 三个动作按钮（按 DOM 序：编辑 / 暂停 / 删除）。 */
const acts = (): ElLike[] => Array.from(doc.querySelectorAll('.goal-capsule-actions button')) as ElLike[];
const act = (name: string): ElLike | null => acts().find((b) => (b.dataset['act'] ?? '') === name) ?? null;
const lastBody = (reqs: Req[]): Body => reqs[reqs.length - 1]?.body ?? {};

/** 真键（带 key 字段的 keydown；jsdom 的 KeyboardEvent 需要手工补 key）。 */
function key(el: ElLike, k: string): void {
  const ev = new Ev('keydown', { bubbles: true });
  Object.defineProperty(ev, 'key', { value: k });
  el.dispatchEvent(ev);
}

async function boot(): Promise<{ goal: GoalMod; ctx: unknown; reqs: Req[] }> {
  const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
  ctxMod.initViewCtx();
  const ctx = ctxMod.ensurePane('ws/s1', 'session', '甲会话');
  ctxMod.activatePane('ws/s1', 'session', '甲会话');
  const reqs: Req[] = [];
  vi.stubGlobal('fetch', goalFetch(reqs));
  const goal = (await import(/* @vite-ignore */ at('ui/commands/goal.ts'))) as GoalMod;
  return { goal, ctx, reqs };
}

/** 设一个目标并等到胶囊出现（走真实的 applyGoal 路径）。 */
async function withGoal(goal: GoalMod, ctx: unknown, text = '把 W9347 的目标胶囊做完并让真机探针全绿'): Promise<void> {
  await goal.applyGoal(ctx, text);
  goal.renderGoalBar();
  await flush();
}

describe('W9347 · 目标胶囊：无目标时不出现、有目标时出现', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('没有目标时胶囊不出现（且不占位）', async () => {
    const { goal } = await boot();
    goal.renderGoalBar();
    await flush();
    expect(capsule()).not.toBeNull(); // 宿主存在
    expect(visible(), '无目标时必须隐藏').toBe(false);
    expect(capsule()!.textContent, '无目标时里面不得留残骸').toBe('');
  });

  it('设了目标就出现、删除后消失（回到不占位）', async () => {
    const { goal, ctx, reqs } = await boot();
    await withGoal(goal, ctx);
    expect(visible()).toBe(true);
    expect(doc.querySelector('.goal-capsule .goal-capsule-text')?.textContent).toContain('W9347');
    await goal.applyGoal(ctx, '');
    goal.renderGoalBar();
    await flush();
    expect(visible()).toBe(false);
    expect(lastBody(reqs), '删除走空串 text').toEqual({ text: '' });
  });
});

describe('W9347 · 三个动作各发什么（分派的后果）', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('三个图标按钮都在，顺序是 编辑 / 暂停 / 删除，且都有可访问名', async () => {
    const { goal, ctx } = await boot();
    await withGoal(goal, ctx);
    const order = acts().map((b) => b.dataset['act'] ?? '');
    expect(order).toEqual(['pencil', 'pause-glyph', 'trash']);
    for (const b of acts()) {
      const name = b.getAttribute('aria-label') ?? '';
      expect(name.length, '每个动作都要有可访问名（不许只有图标没有名字）').toBeGreaterThan(0);
      expect(b.querySelector('svg') !== null, '动作按钮里是一枚 svg 图标').toBe(true);
    }
  });

  it('点暂停：发 {paused:true}，胶囊进入暂停态（可见区分），再点发 {paused:false}', async () => {
    const { goal, ctx, reqs } = await boot();
    await withGoal(goal, ctx);
    act('pause-glyph')!.click();
    await flush();
    goal.renderGoalBar();
    await flush();
    expect(lastBody(reqs), '暂停走 paused:true（不是改 text）').toEqual({ paused: true });
    expect(visible()).toBe(true);
    expect(capsule()!.classList.contains('goal-capsule-paused'), '暂停态要有可见区分').toBe(true);
    act('pause-glyph')!.click();
    await flush();
    goal.renderGoalBar();
    await flush();
    expect(lastBody(reqs), '再点一次是恢复').toEqual({ paused: false });
    expect(capsule()!.classList.contains('goal-capsule-paused')).toBe(false);
  });

  it('暂停态点文字本体 = 恢复（发 paused:false）', async () => {
    const { goal, ctx, reqs } = await boot();
    await withGoal(goal, ctx);
    act('pause-glyph')!.click();
    await flush();
    goal.renderGoalBar();
    await flush();
    reqs.length = 0;
    const body = doc.querySelector('.goal-capsule button.goal-capsule-text');
    expect(body, '暂停态的文字本体是可点的').not.toBeNull();
    body!.click();
    await flush();
    expect(lastBody(reqs)).toEqual({ paused: false });
  });

  it('点删除：发空串 text，胶囊消失', async () => {
    const { goal, ctx, reqs } = await boot();
    await withGoal(goal, ctx);
    act('trash')!.click();
    await flush();
    goal.renderGoalBar();
    await flush();
    expect(lastBody(reqs)).toEqual({ text: '' });
    expect(visible(), '删除后胶囊必须消失').toBe(false);
  });
});

describe('W9347 · 编辑：展开 → Enter 保存 / Esc 取消 / 失焦取消', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('点笔展开成输入框，Enter 保存发 {text}', async () => {
    const { goal, ctx, reqs } = await boot();
    await withGoal(goal, ctx);
    act('pencil')!.click();
    await flush();
    const input = doc.querySelector('.goal-capsule .goal-input') as ElLike | null;
    expect(input, '点笔后要展开成可输入的一行').not.toBeNull();
    expect(input!.value).toContain('W9347');
    input!.value = '改成新的目标';
    reqs.length = 0;
    key(input as ElLike, 'Enter');
    await flush();
    expect(lastBody(reqs), '保存发 {text}（不是 paused）').toEqual({ text: '改成新的目标' });
    goal.renderGoalBar();
    await flush();
    expect(doc.querySelector('.goal-capsule .goal-capsule-text')?.textContent).toBe('改成新的目标');
  });

  it('Esc 取消：不发任何请求、输入框收起、原文不变', async () => {
    const { goal, ctx, reqs } = await boot();
    await withGoal(goal, ctx);
    act('pencil')!.click();
    await flush();
    const input = doc.querySelector('.goal-capsule .goal-input') as ElLike;
    input.value = '不该被保存';
    reqs.length = 0;
    key(input, 'Escape');
    await flush();
    expect(reqs.length, 'Esc 绝不偷存').toBe(0);
    expect(doc.querySelector('.goal-capsule .goal-input')).toBeNull();
    expect(doc.querySelector('.goal-capsule .goal-capsule-text')?.textContent).toContain('W9347');
  });

  it('失焦 = 取消（不发请求、不保存半截文本）', async () => {
    const { goal, ctx, reqs } = await boot();
    await withGoal(goal, ctx);
    act('pencil')!.click();
    await flush();
    const input = doc.querySelector('.goal-capsule .goal-input') as ElLike;
    input.value = '半截输入';
    reqs.length = 0;
    input.dispatchEvent(new Ev('blur', { bubbles: false }));
    await flush();
    expect(reqs.length, '失焦不偷存').toBe(0);
    expect(doc.querySelector('.goal-capsule .goal-input')).toBeNull();
  });
});

describe('W9347 · origin=goal 的注入行显示成标签块，不是用户气泡', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('常驻行与变更通知都渲染成 inbox 注入块，标题是「目标」', async () => {
    const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    ctxMod.initViewCtx();
    const ctx = ctxMod.ensurePane('ws/s1', 'session', '甲会话');
    ctxMod.activatePane('ws/s1', 'session', '甲会话');
    const M = (await import(/* @vite-ignore */ at('ui/messages.ts'))) as MsgMod;
    for (const line of ['[目标] 把 W9347 做完', '[目标] 已更新：把 W9347 做完并让真机探针全绿']) {
      M.renderInboxMessage(ctx, line, { kind: 'goal', into: ctxMod.el });
    }
    await flush();
    const rows = Array.from(doc.querySelectorAll('.msg.inbox'));
    expect(rows.length, '两行都必须是注入块').toBe(2);
    for (const r of rows) {
      expect(r.classList.contains('inbox-goal'), '要带 origin 的 class').toBe(true);
      expect(r.classList.contains('user'), '绝不许渲染成用户消息').toBe(false);
      expect(r.querySelector('.inbox-fold-title')?.textContent).toBe('目标');
    }
    // 折叠默认展开：目标是给人看的事件，折叠起来用户会以为它没发生。
    const box = doc.querySelector('.msg.inbox .inbox-fold') as unknown as { open: boolean } | null;
    expect(box?.open).toBe(true);
    // 正文是目标文本本身（不是被吞掉）。
    expect(doc.querySelector('.msg.inbox .inbox-content')?.textContent).toContain('[目标]');
  });
});
