// ============================================================================
// statusline/swarm.ts — agent_swarm：状态栏批次徽标（#slSwarm）+ 名册弹层（§7.2）。
//
//   数据真源 = Statusline.swarm?（packages/core/src/types.ts 的 SwarmRosterView）。
//   刻意用**可选字段**而不是新 SSE 事件（§7.1 冻结线）：快照里没有 swarm 时
//   整块降级为「不渲染」，徽标保持 .hidden 且不报错（老服务 / 未挂载插件）。
//
//   三条口径都在这个文件里、且只有这一份：
//     · 聚合阈值：单次调用 >= MIN_MEMBERS 个成员才算一张 swarm 卡片；
//     · 折叠默认值：进行中/失败 默认展开，已完成/已取消 默认收起；
//     · 徽标计数：各批次 done 之和 / total 之和（只数达阈值的批次）。
//   组装方（apps/studio）**不得**预先过滤单成员批次 —— 呈现规则归呈现层。
//
//   帧纪律：roster 更新**不进 frame-budget 队列**，由 statusline 轮询直接派发
//   （dsh-agent-swarm 审查记录的已知权衡：高频进度帧优先于合帧）。
// ============================================================================
import { el, need } from '../utils/dom';
import { popOverlay, pushOverlay, type OverlayHandle } from '../utils/overlays';
import { t } from '../i18n';

/** 聚合阈值：同一次调用 >= 2 个成员才聚合成 swarm 卡片（§7.2）。 */
export const MIN_MEMBERS = 2;

/** 四组相位的**展示顺序**（与 types.ts 的 SWARM_MEMBER_PHASES 同序）。 */
export const PHASES = ['running', 'failed', 'done', 'cancelled'] as const;

export type Phase = (typeof PHASES)[number];

/** 前两组默认展开（§7.2）；后两组默认收起 —— 终态是回看，不是当下的重点。 */
export const DEFAULT_OPEN: Record<Phase, boolean> = {
  running: true,
  failed: true,
  done: false,
  cancelled: false,
};

export interface MemberView {
  id: string;
  label: string;
  phase: Phase;
  error?: string;
}

export interface BatchView {
  id: string;
  model: string;
  members: MemberView[];
  done: number;
  total: number;
}

export interface RosterView {
  active: boolean;
  batches: BatchView[];
}

/** 徽标计数：各达阈值批次的 done / total 之和。 */
export interface Counts {
  done: number;
  total: number;
  batches: number;
}

/**
 * 达阈值的批次（成员数 >= MIN_MEMBERS）。
 *
 * 容错：roster / batches / members 缺省或不是数组一律当空，**不抛错** ——
 * 这一层跑在轮询路径上，抛错会连带打断状态栏其余字段的渲染。
 */
export function visibleBatches(roster: RosterView | null | undefined): BatchView[] {
  const list = Array.isArray(roster?.batches) ? roster.batches : [];
  return list.filter((b) => Array.isArray(b?.members) && b.members.length >= MIN_MEMBERS);
}

/** 徽标计数（只数达阈值的批次）。空名册 ⇒ 0/0/0。 */
export function countsOf(roster: RosterView | null | undefined): Counts {
  const batches = visibleBatches(roster);
  let done = 0;
  let total = 0;
  for (const b of batches) {
    done += Number.isFinite(b.done) ? b.done : 0;
    total += Number.isFinite(b.total) ? b.total : b.members.length;
  }
  return { done, total, batches: batches.length };
}

/**
 * 徽标该显示吗：有名册、有达阈值的批次，且**仍有进行中**的成员。
 * 全部落定后徽标隐藏 —— 终态去留由用户自己决定，不占常驻状态栏的位置。
 */
export function shouldShowBadge(roster: RosterView | null | undefined): boolean {
  const batches = visibleBatches(roster);
  if (batches.length === 0) return false;
  if (roster?.active === false) return false;
  return batches.some((b) => b.members.some((m) => m?.phase === 'running'));
}

/** 徽标文案（走字典，中英各一份）。 */
export function badgeText(roster: RosterView | null | undefined): string {
  const c = countsOf(roster);
  return t('statusline.swarm.badge', { done: c.done, total: c.total });
}

/** 把一批成员按相位分组；只保留非空组，保持 PHASES 的固定顺序。 */
export function groupByPhase(members: readonly MemberView[]): Array<{ phase: Phase; members: MemberView[] }> {
  const out: Array<{ phase: Phase; members: MemberView[] }> = [];
  for (const phase of PHASES) {
    const bucket = (Array.isArray(members) ? members : []).filter((m) => m?.phase === phase);
    if (bucket.length > 0) out.push({ phase, members: bucket });
  }
  return out;
}

// ---- DOM 状态（模块级；与 goal.ts 同款单例）----

let btn: HTMLElement | null = null;
let badge: HTMLElement | null = null;
let popup: HTMLElement | null = null;
let popupOverlay: OverlayHandle | null = null;
/** 最新名册（弹层开着时用它就地重画，避免重建背景节点）。 */
let roster: RosterView | null = null;
/** 当前展开的批次 id（多批次切换键）。 */
let currentBatch = '';
/** 每组独立折叠的展开态；缺项时回落到 DEFAULT_OPEN。 */
let open: Record<string, boolean> = {};

/** 关闭弹层（幂等）。 */
export function closeSwarmPopup(): void {
  if (popupOverlay) {
    popOverlay(popupOverlay);
    popupOverlay = null;
  }
  if (popup) {
    popup.remove();
    popup = null;
  }
}

/** 当前展开的批次（多批次时的稳定选择；找不到就退到第一个）。 */
function pickBatch(batches: BatchView[]): BatchView | undefined {
  return batches.find((b) => b.id === currentBatch) ?? batches[0];
}

/** 渲染一个相位分组（头行可点，body 随展开态显隐）。 */
function renderGroup(batch: BatchView, phase: Phase, members: MemberView[]): HTMLElement {
  const key = batch.id + ':' + phase;
  const expanded = open[key] ?? DEFAULT_OPEN[phase];
  const wrap = el('div', 'swarm-group');
  const head = el('button', 'swarm-group-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', String(expanded));
  // 拼键：四个相位键由 PHASES 驱动，静态扫描看不见（check-ui-copy.mjs 的
  // DYNAMIC_KEY_PREFIXES 已登记 'statusline.swarm.phase.' 前缀）。t() 的形参是
  // 字面量联合，拼接出来的是 string —— 这里显式收窄一次，不改 t() 的签名
  // （t 收紧会波及全仓 995 个键的调用点）。
  const phaseKey = 'statusline.swarm.phase.' + phase;
  head.appendChild(el('span', 'swarm-group-label', t(phaseKey as Parameters<typeof t>[0])));
  head.appendChild(el('span', 'swarm-group-count', String(members.length)));
  const body = el('div', 'swarm-group-body');
  body.classList.toggle('hidden', !expanded);
  for (const m of members) {
    const row = el('div', 'swarm-member' + (m.phase === 'failed' ? ' is-failed' : ''));
    row.appendChild(el('span', 'swarm-member-id', t('statusline.swarm.memberNo', { id: m.id })));
    row.appendChild(el('span', 'swarm-member-label', m.label || t('statusline.unknown')));
    body.appendChild(row);
  }
  head.addEventListener('click', () => {
    open[key] = !(open[key] ?? DEFAULT_OPEN[phase]);
    drawPopup();
  });
  wrap.appendChild(head);
  wrap.appendChild(body);
  return wrap;
}

/** 画弹层内容（宿主节点复用，只换内容）。 */
function drawPopup(): void {
  if (!popup) return;
  popup.replaceChildren();
  const batches = visibleBatches(roster);
  if (batches.length === 0) {
    popup.appendChild(el('div', 'swarm-empty', t('statusline.swarm.empty')));
    return;
  }
  popup.appendChild(el('div', 'sl-popup-title', t('statusline.swarm.title', { count: batches.length })));
  if (batches.length > 1) {
    const tabs = el('div', 'swarm-batch-tabs');
    for (const b of batches) {
      const tab = el('button', 'swarm-batch-tab', b.model || b.id);
      tab.type = 'button';
      if (b.id === currentBatch) tab.classList.add('is-active');
      tab.addEventListener('click', () => {
        currentBatch = b.id;
        drawPopup();
      });
      tabs.appendChild(tab);
    }
    popup.appendChild(tabs);
  }
  const batch = pickBatch(batches);
  if (!batch) return;
  popup.appendChild(
    el(
      'div',
      'swarm-batch-model',
      batch.model
        ? t('statusline.swarm.batchModel', { model: batch.model })
        : t('statusline.swarm.modelInherit'),
    ),
  );
  const body = el('div', 'sl-popup-body');
  for (const g of groupByPhase(batch.members)) body.appendChild(renderGroup(batch, g.phase, g.members));
  popup.appendChild(body);
}

/** 打开弹层（挂 #statusline 根，与 picker/mode 同款）。 */
export function openSwarmPopup(): void {
  if (!btn) return;
  if (popup) {
    closeSwarmPopup();
    return;
  }
  const host = btn.closest('#statusline') ?? document.body;
  const node = el('div', 'sl-popup swarm-popup');
  node.setAttribute('role', 'dialog');
  host.appendChild(node);
  popup = node;
  popupOverlay = pushOverlay(() => closeSwarmPopup());
  drawPopup();
}

/** 徽标显隐 + 文案 + 弹层就地重画。 */
function render(): void {
  if (!btn || !badge) return;
  if (!shouldShowBadge(roster)) {
    btn.classList.add('hidden');
    badge.textContent = '';
    btn.removeAttribute('title');
    closeSwarmPopup();
    return;
  }
  btn.classList.remove('hidden');
  badge.textContent = badgeText(roster);
  btn.title = t('statusline.swarm.title', { count: countsOf(roster).batches });
  if (popup) drawPopup();
}

/** 装配 swarm 徽标（幂等；statusline.start 之后调用一次）。 */
export function initSwarmBadge(): void {
  if (!btn) {
    const host = document.getElementById('slSwarm');
    if (!host) return;
    btn = host;
    badge = need<HTMLElement>('#slSwarmBadge', host);
    // 闭包捕获**局部** const（而不是模块级 let btn）：模块级变量的收窄不会跨
    // 闭包边界，TS 会报 'btn' is possibly null。局部引用同时让这段监听与
    // 「本次装配到的那个按钮」一一对应。
    const self = host;
    self.addEventListener('click', () => openSwarmPopup());
    // 点别处收起（与 picker/mode 同款：事件路径判定，避免乐观重绘误判）。
    document.addEventListener('click', (e) => {
      if (!popup) return;
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      const hit = path.some((n) => n === popup || n === self) || popup.contains(e.target as Node) || self.contains(e.target as Node);
      if (!hit) closeSwarmPopup();
    });
  }
  render();
}

/**
 * 喂一份名册快照（缺省 = 无 swarm 字段 ⇒ 徽标隐藏）。
 * 轮询每次拿到 status 帧都调它；**不进 frame-budget 队列**（见文件头帧纪律）。
 */
export function setSwarmRoster(next: RosterView | null | undefined): void {
  roster = next ?? null;
  render();
}

/** 当前名册（测试与收口接线用；徽标未装配时为 null）。 */
export function swarmRoster(): RosterView | null {
  return roster;
}
