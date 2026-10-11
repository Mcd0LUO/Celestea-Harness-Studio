// @vitest-environment jsdom
/**
 * W9349 · 目标**读回**（页面打开 / 切换会话时把已存在的目标读回来）。
 *
 * 缺陷本体：`ui/commands/goal.ts` 的客户端缓存只由 POST 的回声填充 ⇒ 目标明明还
 * 在服务端盘上，用户一刷新，界面什么都不显示（胶囊消失）。
 *
 * 判据全是**后果**（铁律 11）：
 *   ① 激活会话会发 GET（不是「实现了 readGoal」这种自证）；
 *   ② 回声有目标 ⇒ 胶囊出现，且 paused 态照回声画对；
 *   ③ 回声 goal:null ⇒ 胶囊不出现；
 *   ④ 晚到的**旧会话**回声不覆盖当前会话（铁律 3 的竞态守卫）；
 *   ⑤ GET 失败（网络错 / 非 200）⇒ 缓存保持不变（**不清成 null**）。
 *
 * 桩按冻结契约应答：GET 200 = {ok, session, goal}，与 POST 回声**逐字同形**
 * （paused 恒在）；`goal:null` = 无目标。非 200 / 抛错 = 失败路径。
 *
 * ★ ④⑤ 是**变异负控制**钉的（见报告）：删掉竞态守卫 / 把 catch 改成清缓存，
 *   对应用例必须红 —— 证明它们真的在守东西，而不是恒真断言。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, flush, reply, resetHarness, type ElLike } from './lib/w795-dom.js';

interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): unknown;
  activatePane(id: string, kind?: string, title?: string): unknown;
}
interface GoalMod {
  applyGoal(ctx: unknown, text: string): Promise<unknown>;
  renderGoalBar(): void;
  goalOf(session: string): { text: string; paused: boolean } | null;
}
interface CmdMod {
  installCommands(): void;
}

/** 一个 GET 的应答（延迟可挂起，用来造「晚到」）。按会话 id 分开，避免两格互相污染。 */
interface GetPlan {
  goal: { text: string; paused: boolean } | null;
  /** 挂起本次 GET：手写回声之前绝不 resolve。 */
  hold?: boolean;
  status?: number;
}
interface Req { url: string; method: string; session: string }

const capsule = (): ElLike | null => doc.querySelector('.goal-capsule');
const visible = (): boolean => capsule() !== null && !capsule()!.classList.contains('hidden');

/** URL 里的会话 id（'ws/s1'）。goal 桩按它分辨是哪一格。 */
function sessionOf(url: string): string {
  const m = /^\/api\/sessions\/(.+)\/goal$/.exec(url);
  return m?.[1] === undefined ? '' : decodeURIComponent(m[1]);
}

/**
 * 契约忠实的 goal 端点桩：GET 读 `plans[会话]`（没登记的会话 = 无目标），
 * POST 写 `store[会话]`。`hold` 的那次 GET 挂起，手写回声（`settle`）模拟**晚到**。
 */
function makeFetch(
  plans: Record<string, GetPlan>,
  reqs: Req[],
  store: Record<string, { text: string; paused: boolean } | null>,
) {
  const holds: ((v: unknown) => void)[] = [];
  const view = (s: { text: string; paused: boolean } | null): unknown =>
    s === null ? null : { text: s.text, paused: s.paused, createdAt: 'a', updatedAt: 'b' };
  const fn = async (url: unknown, init?: { method?: string; body?: unknown }): Promise<unknown> => {
    const u = String(url);
    const method = String(init?.method ?? 'GET').toUpperCase();
    if (!/^\/api\/sessions\/.+\/goal$/.test(u)) return reply(404, { ok: false, error: 'not found' });
    const sid = sessionOf(u);
    reqs.push({ url: u, method, session: sid });
    if (method === 'GET') {
      const plan = plans[sid] ?? { goal: null };
      if (plan.status !== undefined && plan.status !== 200) return reply(plan.status, { ok: false, error: 'boom' });
      const payload = { ok: true, session: sid, goal: view(plan.goal) };
      if (plan.hold !== true) return reply(200, payload);
      // 挂起：只有 settle 之后才 resolve（此时页面早已切走）。
      return new Promise((resolve) => { holds.push(resolve); });
    }
    // POST：写入并回声。
    const b = (JSON.parse(String(init?.body ?? '{}')) as { text?: string; paused?: boolean });
    if (b.text !== undefined) {
      const t = String(b.text).trim();
      store[sid] = t === '' ? null : { text: t, paused: store[sid]?.paused ?? false };
    } else if (b.paused !== undefined && store[sid] !== undefined && store[sid] !== null) {
      store[sid] = { text: store[sid]!.text, paused: b.paused === true };
    }
    return reply(200, { ok: true, session: sid, goal: view(store[sid] ?? null) });
  };
  const settle = (i: number, goal: { text: string; paused: boolean } | null): void => {
    holds[i]?.(reply(200, { ok: true, session: 'ws/s1', goal: view(goal) }));
  };
  return { fn, settle };
}

/** 装好 fetch 桩、起好 viewctx、装上装配（installCommands 会注册 onPaneChange 读回）。 */
async function boot(
  plans: Record<string, GetPlan>,
): Promise<{ goal: GoalMod; reqs: Req[]; settle: (i: number, g: { text: string; paused: boolean } | null) => void }> {
  const reqs: Req[] = [];
  const store: Record<string, { text: string; paused: boolean } | null> = {};
  const { fn, settle } = makeFetch(plans, reqs, store);
  vi.stubGlobal('fetch', fn);
  const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
  ctxMod.initViewCtx();
  ctxMod.ensurePane('ws/s1', 'session', '甲会话');
  ctxMod.activatePane('ws/s1', 'session', '甲会话');
  const cmd = (await import(/* @vite-ignore */ at('ui/commands/index.ts'))) as CmdMod;
  cmd.installCommands(); // 同一个 onPaneChange 入口：读回 + 胶囊重画
  const goal = (await import(/* @vite-ignore */ at('ui/commands/goal.ts'))) as GoalMod;
  return { goal, reqs, settle };
}

/** 切走再切回 ⇒ 触发 ws/s1 的读回（onPaneChange 只在**真的换了容器**时才广播）。 */
async function reactivate(
  mod: ViewCtxMod,
): Promise<void> {
  mod.ensurePane('ws/s2', 'session', '乙会话');
  mod.activatePane('ws/s2', 'session', '乙会话');
  await flush();
  mod.activatePane('ws/s1', 'session', '甲会话');
  await flush();
}
const viewctx = async (): Promise<ViewCtxMod> =>
  (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;

const gets = (reqs: Req[]): Req[] => reqs.filter((r) => r.method === 'GET');

describe('W9349 · 激活会话时读回已存在的目标（刷新后胶囊不消失）', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('激活会话会发 GET /goal（读一次，不是实现自证）', async () => {
    const { reqs } = await boot({ 'ws/s2': { goal: { text: '把 W9349 收尾切片做完', paused: false } } });
    const ctxMod = await viewctx();
    ctxMod.ensurePane('ws/s2', 'session', '乙会话');
    ctxMod.activatePane('ws/s2', 'session', '乙会话'); // 切会话 ⇒ 读回 ws/s2
    await flush();
    const readGets = gets(reqs).filter((r) => r.url.includes('/goal'));
    expect(readGets.length, '激活会话必须发 GET /api/sessions/{id}/goal').toBeGreaterThan(0);
    expect(readGets[0]!.url, '读的正是被激活的那个会话').toBe('/api/sessions/ws%2Fs2/goal');
  });

  it('回声有目标 ⇒ 胶囊出现，且 paused 态照回声画对', async () => {
    const { goal } = await boot({
      'ws/s1': { goal: { text: '把 W9349 的读回做完并让真机探针全绿', paused: false } },
    });
    await reactivate(await viewctx()); // 切走再切回 ws/s1 ⇒ 读回
    goal.renderGoalBar();
    await flush();
    expect(visible(), '回声有目标 ⇒ 胶囊出现（刷新后不再消失）').toBe(true);
    expect(doc.querySelector('.goal-capsule .goal-capsule-text')?.textContent).toContain('W9349');
    expect(capsule()!.classList.contains('goal-capsule-paused'), 'paused:false ⇒ 非暂停态').toBe(false);
  });

  it('回声 paused:true ⇒ 胶囊进入暂停态（读回保留 paused 字段）', async () => {
    const { goal } = await boot({ 'ws/s1': { goal: { text: '已暂停的目标', paused: true } } });
    await reactivate(await viewctx());
    goal.renderGoalBar();
    await flush();
    expect(visible()).toBe(true);
    expect(capsule()!.classList.contains('goal-capsule-paused'), 'paused:true ⇒ 读回后就是暂停态').toBe(true);
  });

  it('回声 goal:null ⇒ 胶囊不出现（没有目标不占位）', async () => {
    const { goal } = await boot({ 'ws/s1': { goal: null } });
    await reactivate(await viewctx());
    goal.renderGoalBar();
    await flush();
    expect(visible(), '回声无目标 ⇒ 胶囊不出现').toBe(false);
  });
});

describe('W9349 · 竞态守卫（铁律 3）与失败不清缓存', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('★ 晚到的旧会话回声不覆盖当前会话（变异：去掉守卫 ⇒ 必须红）', async () => {
    // ws/s1 的读回**挂起**；切到 ws/s2 之后，才让 ws/s1 的旧回声到达。
    // 判据：旧回声被守卫丢弃 —— ws/s1 的缓存仍是 null，而 ws/s2 那一格也不受影响。
    const plans = { 'ws/s1': { goal: { text: '旧会话的慢目标', paused: false }, hold: true } };
    const { goal, reqs, settle } = await boot(plans);
    const ctxMod = await viewctx();
    ctxMod.ensurePane('ws/s2', 'session', '乙会话');
    // ① 先切到 ws/s2（当前是 ws/s1，确实换了容器 ⇒ 广播，seq=1；ws/s2 无目标）
    ctxMod.activatePane('ws/s2', 'session', '乙会话');
    await flush();
    // ② 切到 ws/s1 ⇒ 读回（此 GET 挂起，seq=2）
    ctxMod.activatePane('ws/s1', 'session', '甲会话');
    await flush(1);
    expect(gets(reqs).some((r) => r.session === 'ws/s1'), 'ws/s1 的读回确实发出去了（此 GET 挂起）').toBe(true);
    // ③ 再切到 ws/s2 ⇒ 读回（seq=3；ws/s1 的在途请求就此作废）
    ctxMod.activatePane('ws/s2', 'session', '乙会话');
    await flush();
    // ④ 旧回声此刻才到 —— 若没有代号守卫，它会写进 ws/s1 的缓存
    settle(0, { text: '旧会话的慢目标', paused: false });
    await flush();
    expect(goal.goalOf('ws/s1'), '晚到的旧回声被丢弃：不得写进缓存').toBeNull();
    expect(goal.goalOf('ws/s2'), '当前会话的一格不被旧回声污染').toBeNull();
    // ⑤ 再切回 ws/s1 ⇒ 重新读回（seq=4），这次不挂起 ⇒ 正常落地
    plans['ws/s1'].hold = false;
    ctxMod.activatePane('ws/s1', 'session', '甲会话');
    await flush();
    expect(goal.goalOf('ws/s1')?.text, '切回后重新读回 ⇒ 胶囊这次真的出来').toBe('旧会话的慢目标');
    expect(gets(reqs).filter((r) => r.session === 'ws/s1').length).toBeGreaterThan(0);
  });

  it('★ GET 失败（非 200）⇒ 缓存保持不变，不清成 null（变异：catch 里清缓存 ⇒ 必须红）', async () => {
    // 先用 POST 把 ws/s1 的目标写进缓存（模拟界面上已经有的目标）。
    const { goal } = await boot({ 'ws/s1': { goal: null, status: 500 } });
    const ctxMod = await viewctx();
    const pane = ctxMod.ensurePane('ws/s1', 'session', '甲会话');
    // fetch 对 GET 返 500；POST 仍照常回声 ⇒ 缓存里有目标
    await goal.applyGoal(pane, '界面上已经有的目标');
    expect(goal.goalOf('ws/s1'), 'POST 回声后缓存有目标').not.toBeNull();
    await reactivate(ctxMod); // 触发读回：GET 500 ⇒ 失败 ⇒ 缓存必须保持原样
    expect(goal.goalOf('ws/s1'), 'GET 失败绝不把已有目标清成 null').not.toBeNull();
    expect(goal.goalOf('ws/s1')!.text).toBe('界面上已经有的目标');
  });

  it('★ 网络层抛错（fetch reject）⇒ 同样保持现状', async () => {
    const { goal } = await boot({ 'ws/s1': { goal: { text: '盘上已有的目标', paused: false } } });
    const ctxMod = await viewctx();
    const pane = ctxMod.ensurePane('ws/s1', 'session', '甲会话');
    await goal.applyGoal(pane, '盘上已有的目标');
    // 之后 GET 一律网络失败
    vi.stubGlobal('fetch', async () => { throw new Error('offline'); });
    await reactivate(ctxMod);
    expect(goal.goalOf('ws/s1'), '网络错也不清缓存').not.toBeNull();
    expect(goal.goalOf('ws/s1')!.text).toBe('盘上已有的目标');
  });

  it('★ GET 明确读到 goal:null ⇒ 才把该会话清空（这是唯一清缓存的路径）', async () => {
    const { goal } = await boot({ 'ws/s1': { goal: null } });
    const ctxMod = await viewctx();
    const pane = ctxMod.ensurePane('ws/s1', 'session', '甲会话');
    await goal.applyGoal(pane, '先设一个目标');
    expect(goal.goalOf('ws/s1')).not.toBeNull();
    await reactivate(ctxMod); // 读回 goal:null ⇒ 缓存被清
    expect(goal.goalOf('ws/s1'), '明确读到 goal:null ⇒ 清缓存').toBeNull();
  });
});
