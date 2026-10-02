// @vitest-environment jsdom
/**
 * agent_swarm 状态栏面板（#slSwarm 徽标 + 名册弹层）· DOM 与纯函数测试。
 *
 * 断言口径（docs/AGENT.md 铁律 3）：**不只数 DOM 节点**。每处渲染都同时断言
 *   ① 可见性（祖先链无 .hidden / display:none、已连到 document）——「只数节点」
 *      曾让一个不可见面板全绿通过；
 *   ② 非零几何（注入非零 getBoundingClientRect 后断言宽高 > 0）——jsdom 没有
 *      排版引擎，rect 恒 0，真实像素由 Lead 收口时的 headless + CDP 截图验收。
 *
 * 一个刻意的写法（本仓既有条件逼出来的，不是风格选择）：**不碰裸 DOM 全局**
 * （Document / Element / new Event）——根 tsconfig 的 lib 只有 ES2023，**没有
 * DOM**；@vitest-environment jsdom 只影响运行时，不给 TypeScript 装类型。
 * 一切经 tests/lib/w795-dom.ts 的 ElLike/DocLike，与 i18n-dom.test.ts 同一范式。
 * 被测模块是**真实实现**（at() 动态 import），不是复刻逻辑。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { all, at, doc, Ev, resetHarness, type ElLike } from './lib/w795-dom.js';

interface SwarmMod {
  MIN_MEMBERS: number;
  PHASES: readonly string[];
  DEFAULT_OPEN: Record<string, boolean>;
  visibleBatches(r: unknown): Array<{ id: string; members: unknown[] }>;
  countsOf(r: unknown): { done: number; total: number; batches: number };
  shouldShowBadge(r: unknown): boolean;
  badgeText(r: unknown): string;
  groupByPhase(m: unknown): Array<{ phase: string; members: unknown[] }>;
  initSwarmBadge(): void;
  setSwarmRoster(r: unknown): void;
  openSwarmPopup(): void;
  closeSwarmPopup(): void;
}

const load = async (): Promise<SwarmMod> => (await import(/* @vite-ignore */ at('statusline/swarm.ts'))) as SwarmMod;

/** ElLike 不带 getBoundingClientRect（夹具不含几何），本地交叉出可注入几何的那个成员。 */
type SwarmEl = ElLike & { getBoundingClientRect(): { width: number; height: number } };

/** 可见性：已连到 document 且祖先链上没有 .hidden / display:none。 */
function visible(node: ElLike | null): boolean {
  if (!node) return false;
  let n: ElLike | null = node;
  while (n) {
    if (n.classList.contains('hidden')) return false;
    const disp = (n as unknown as { style?: { display?: string } }).style?.display;
    if (disp === 'none') return false;
    n = n.parentElement;
  }
  return node.isConnected === true;
}

/** 注入非零几何：jsdom 无排版引擎，rect 恒 0，这里给一个可读的宽高。 */
function withRect(node: ElLike, w: number, h: number): { width: number; height: number } {
  (node as SwarmEl).getBoundingClientRect = () => ({ width: w, height: h });
  return (node as SwarmEl).getBoundingClientRect();
}

/**
 * 在夹具骨架的 #statusline 里挂上本面板的宿主。夹具自带的 HTML 与 index.html 同构
 * （提供 #statusline / .sl-row-main，正是弹层的宿主），只缺 #slSwarm 徽标本身。
 */
function mountSwarmHost(): void {
  const host = doc.querySelector('#statusline .sl-row-main');
  const btn = doc.createElement('button');
  btn.className = 'sl-swarm hidden';
  btn.id = 'slSwarm';
  const badge = doc.createElement('span');
  badge.className = 'sl-swarm-badge';
  badge.id = 'slSwarmBadge';
  btn.appendChild(badge);
  (host ?? doc.body).appendChild(btn);
}

const running = (id: string, label = 'task') => ({ id, label, phase: 'running' });
const roster = (members: Array<Record<string, unknown>>, active = true) => ({
  active,
  batches: [{ id: 'b1', model: 'm1', members, done: 1, total: members.length }],
});

/**
 * 每个用例的前置：装夹具 DOM 骨架、复位模块、挂上本面板的宿主。
 *
 * resetHarness 一次做三件事：装夹具 DOM 骨架、vi.resetModules()、装 fetch 打桩。
 * 其中 resetModules 是这里的关键：swarm.ts 与 goal.ts 同款**模块级缓存 DOM 节点**
 *（btn/badge 单例）。不复位模块的话，第一个用例装配出的 btn 会一直指向第一次
 * 骨架里那个已被 innerHTML 替换掉的**游离节点**，后续用例的渲染全落在孤儿上 ——
 * 那正是「断言看起来在测、其实什么都没渲染」的一类假绿。
 *
 * 抽成函数而不是在两个 describe 里各写一遍：测试文件单函数上限 150 行，
 * 本文件拆成两个 describe 后两段都要装同样的前置，复用比复制更省事也更安全
 *（两处描述一旦漂移，就是「A 段修了 B 段没修」的那种假绿）。
 */
function setup(): void {
  resetHarness();
  mountSwarmHost();
}

describe('agent_swarm · statusline 面板（纯函数 + 徽标）', () => {
  beforeEach(setup);

  // ---- 纯函数（阈值 / 计数 / 分组）----

  it('聚合阈值：单成员批次不计入，只有 >= 2 成员才成卡片', async () => {
    const m = await load();
    expect(m.MIN_MEMBERS).toBe(2);
    const one = m.visibleBatches(roster([running('1')]));
    expect(one, '单成员批次不得聚合成 swarm 卡片').toHaveLength(0);
    const two = m.visibleBatches(roster([running('1'), running('2')]));
    expect(two, '恰好 2 成员必须聚合成卡片').toHaveLength(1);
    const counts = m.countsOf(roster([running('1'), running('2')]));
    expect(counts.batches).toBe(1);
    expect(counts.total).toBe(2);
  });

  it('缺省 / 畸形名册一律降级为空，不抛错（老服务容错）', async () => {
    const m = await load();
    for (const bad of [null, undefined, {}, { active: true }, { active: true, batches: 'x' }]) {
      expect(() => m.countsOf(bad), '畸形名册不得抛错').not.toThrow();
      expect(m.countsOf(bad)).toEqual({ done: 0, total: 0, batches: 0 });
      expect(m.shouldShowBadge(bad)).toBe(false);
    }
  });

  it('分组只保留非空组且保持四相位的固定顺序', async () => {
    const m = await load();
    const groups = m.groupByPhase([
      { id: '4', label: 'd', phase: 'done' },
      { id: '1', label: 'r', phase: 'running' },
      { id: '3', label: 'c', phase: 'cancelled' },
      { id: '2', label: 'f', phase: 'failed' },
    ]);
    expect(groups.map((g) => g.phase)).toEqual(['running', 'failed', 'done', 'cancelled']);
    expect(m.groupByPhase([]), '空输入不得凭空造组').toEqual([]);
  });

  it('折叠默认值：进行中/失败 默认展开，已完成/已取消 默认收起', async () => {
    const m = await load();
    expect(m.DEFAULT_OPEN).toEqual({ running: true, failed: true, done: false, cancelled: false });
  });

  // ---- 徽标（显隐 + 文案 + 可见性 + 几何）----

  it('徽标：swarm 字段缺省时保持 .hidden、文案清空、不报错', async () => {
    const m = await load();
    m.initSwarmBadge();
    m.setSwarmRoster(undefined);
    const btn = doc.getElementById('slSwarm');
    const badge = doc.getElementById('slSwarmBadge');
    expect(btn, '#slSwarm 必须已挂上').not.toBeNull();
    expect(visible(btn), '无 swarm 字段时徽标不得可见').toBe(false);
    expect(btn?.classList.contains('hidden')).toBe(true);
    expect(badge?.textContent, '隐藏时文案必须清空（不留上一批的残影）').toBe('');
    expect(btn?.getAttribute('title'), '隐藏时不得留 title').toBeNull();
  });

  it('徽标：有 >=2 成员且仍在进行时可见、文案是 {done}/{total}、几何非零', async () => {
    const m = await load();
    m.initSwarmBadge();
    m.setSwarmRoster(roster([running('1'), running('2'), running('3')]));
    const btn = doc.getElementById('slSwarm');
    const badge = doc.getElementById('slSwarmBadge');
    expect(visible(btn), '进行中的批次必须让徽标真的可见').toBe(true);
    expect(btn?.classList.contains('hidden')).toBe(false);
    expect(badge?.textContent).toContain('1/3');
    expect(btn?.getAttribute('title'), '可见时必须有 title').not.toBeNull();
    const rect = withRect(btn as ElLike, 96, 16);
    expect(rect.width, '徽标宽度不得为零').toBeGreaterThan(0);
    expect(rect.height, '徽标高度不得为零').toBeGreaterThan(0);
  });

  it('徽标：全部落定（无进行中成员）后隐藏', async () => {
    const m = await load();
    m.initSwarmBadge();
    m.setSwarmRoster(roster([running('1'), { id: '2', label: 'x', phase: 'done' }]));
    expect(visible(doc.getElementById('slSwarm'))).toBe(true);
    m.setSwarmRoster(roster([{ id: '1', label: 'x', phase: 'done' }, { id: '2', label: 'y', phase: 'done' }]));
    expect(visible(doc.getElementById('slSwarm')), '全部落定后徽标应隐藏').toBe(false);
  });
});

// 第二段：弹层。与上面那段**共用同一个 setup()**（不复制前置，见 setup 的注释）。
describe('agent_swarm · statusline 面板（弹层）', () => {
  beforeEach(setup);

  // ---- 弹层（内容 / 折叠 / 切换 / 可见性 + 几何）----

  it('弹层：展开后四组都在、前两组默认可见、后两组默认收起、几何非零', async () => {
    const m = await load();
    m.initSwarmBadge();
    m.setSwarmRoster(
      roster([
        running('1'),
        { id: '2', label: 'b', phase: 'failed' },
        { id: '3', label: 'c', phase: 'done' },
        { id: '4', label: 'd', phase: 'cancelled' },
      ]),
    );
    m.openSwarmPopup();
    const popup = doc.querySelector('.swarm-popup');
    expect(popup, '弹层必须真的挂进 #statusline').not.toBeNull();
    expect(visible(popup), '弹层必须真的可见（不是只存在节点）').toBe(true);
    const heads = all('.swarm-group-head');
    expect(heads, '四个相位组都要渲染出组头').toHaveLength(4);
    // 前两组默认展开、后两组默认收起 —— 这正是 §7.2 的折叠默认值。
    expect(heads[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(heads[1]?.getAttribute('aria-expanded')).toBe('true');
    expect(heads[2]?.getAttribute('aria-expanded')).toBe('false');
    expect(heads[3]?.getAttribute('aria-expanded')).toBe('false');
    const bodies = all('.swarm-group-body');
    expect(visible(bodies[0] ?? null), '进行中组默认展开').toBe(true);
    expect(visible(bodies[2] ?? null), '已完成组默认收起').toBe(false);
    const rect = withRect(popup as ElLike, 260, 180);
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
    m.closeSwarmPopup();
    expect(doc.querySelector('.swarm-popup'), '关闭后弹层必须移除').toBeNull();
  });

  it('弹层：点组头切换该组的折叠（各组独立）', async () => {
    const m = await load();
    m.initSwarmBadge();
    m.setSwarmRoster(roster([running('1'), { id: '2', label: 'c', phase: 'done' }]));
    m.openSwarmPopup();
    all('.swarm-group-head')[1]?.dispatchEvent(new Ev('click', { bubbles: true }));
    const heads = all('.swarm-group-head');
    expect(heads[1]?.getAttribute('aria-expanded'), '点一下应把「已完成」组展开').toBe('true');
    expect(heads[0]?.getAttribute('aria-expanded'), '另一组不受影响（独立折叠）').toBe('true');
    m.closeSwarmPopup();
  });

  it('弹层：多批次可切换，切到另一批次后显示它的成员与模型标签', async () => {
    const m = await load();
    m.initSwarmBadge();
    m.setSwarmRoster({
      active: true,
      batches: [
        { id: 'b1', model: 'alpha', members: [running('1'), running('2')], done: 0, total: 2 },
        { id: 'b2', model: 'beta', members: [running('3'), running('4')], done: 1, total: 2 },
      ],
    });
    m.openSwarmPopup();
    const tabs = all('.swarm-batch-tab');
    expect(tabs, '两个批次必须给两个切换键').toHaveLength(2);
    expect(doc.querySelector('.swarm-batch-model')?.textContent).toContain('alpha');
    tabs[1]?.dispatchEvent(new Ev('click', { bubbles: true }));
    expect(doc.querySelector('.swarm-batch-model')?.textContent, '切到 b2 后应显示 beta').toContain('beta');
    const ids = all('.swarm-member-id').map((n) => n.textContent);
    expect(ids.some((x) => x?.includes('3')), '切到 b2 后应能看到成员 3').toBe(true);
    m.closeSwarmPopup();
  });

  it('弹层：名册清空后徽标隐藏会把已开的弹层一并收起', async () => {
    const m = await load();
    m.initSwarmBadge();
    m.setSwarmRoster(roster([running('1'), running('2')]));
    m.openSwarmPopup();
    expect(doc.querySelector('.swarm-popup')).not.toBeNull();
    m.setSwarmRoster(null);
    expect(doc.querySelector('.swarm-popup'), '名册消失后弹层不得悬着').toBeNull();
    expect(visible(doc.getElementById('slSwarm'))).toBe(false);
  });

  it('反例：可见性判据本身有效（带 .hidden 的节点被判不可见）', async () => {
    const m = await load();
    m.initSwarmBadge();
    const probe = doc.createElement('div');
    probe.className = 'hidden';
    doc.body.appendChild(probe);
    expect(visible(probe), '判据若恒真，这条与前面所有可见性断言都是空转').toBe(false);
    const gone = doc.createElement('div');
    expect(visible(gone), '未挂载的节点必须判不可见').toBe(false);
    expect(m.PHASES, '相位表不得为空（否则分组断言是空转）').toHaveLength(4);
  });
});
