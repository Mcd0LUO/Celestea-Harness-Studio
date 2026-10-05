// ============================================================================
// ui/commands/goal.ts — A3/W9347：持久目标（/goal）+ **浮动胶囊**。
// ----------------------------------------------------------------------------
// 语义（架构侧 2026-09-19 裁决）：一等概念——立一个目标，agent 每轮都能看到，
//   可查看、可编辑、可暂停、可删除（POST /api/sessions/{id}/goal）。
//   P0 明确不做「目标驱动自动续跑」：只做持久可见 + 每轮注入上下文（注入由服务端负责）。
// 可见性：聊天区（#main 消息区）**上方**的**浮动胶囊**（不占布局、不推走消息）。
//   statusline 的 #slGoal 徽标保留不动（本任务范围外）。
//
// 胶囊规格（守**后果**、不钉 px 常量 —— 铁律 11）：
//   · 一行高；文字区约 2 个汉字宽（≈2em），超出截断（完整文本进 title 悬停可读）；
//   · 右侧三个图标按钮，顺序固定：编辑（一支笔）/ 暂停 / 删除；命中区 ≥24×24（SC 2.5.8）；
//   · 编辑：点笔 ⇒ 胶囊展开成输入框（展开态不受 2 汉字宽限制）；
//     Enter 保存、Esc 取消、**失焦 = 取消**（绝不偷存）；保存走 applyGoal；
//   · 暂停：切换 paused；暂停态胶囊可见区分，且**暂停时点胶囊本体 = 恢复**；
//   · 删除：清空目标（空串）⇒ 胶囊消失；
//   · 无目标 ⇒ 胶囊不出现、不占位。
//
// 冻结契约 v1（后端已定，本文件只发正确请求、不改语义）：
//   请求 `{ text?, paused? }`（至少一个）；text 空/空白 = 删除；paused 必为 boolean；
//   200 回 `{ ok, session, goal: { text, paused, createdAt, updatedAt } | null }`。
//   **变更通知由后端负责**（等价写不产生通知；通知在下一 turn 投递）—— 前端只发请求。
// ============================================================================
import { el } from '../../utils/dom';
import { api, userErrorText } from '../../api';
import { iconNode } from '../icons';
import type { SessionPane } from '../viewctx';
import type { GoalInfo } from '../../types/goal';
import { activePane } from '../viewctx';
import { t } from '../../i18n';

/** 每个会话的目标（客户端缓存，供徽标/胶囊渲染；服务端仍是真源）。 */
const goals = new Map<string, GoalInfo | null>();
/** 订阅者（statusline / 胶囊重绘）。 */
const listeners = new Set<() => void>();

function emit(): void {
  for (const cb of listeners) cb();
}

/** 订阅目标变化（返回取消订阅）。 */
export function onGoalChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 某会话的当前目标（null = 无）。 */
export function goalOf(session: string): GoalInfo | null {
  return goals.get(session) ?? null;
}

function setLocal(session: string, g: GoalInfo | null): void {
  goals.set(session, g);
  emit();
}

/** 从服务端回声归一化目标（缺字段时保守回落；paused 缺省 false）。 */
function normalize(raw: unknown): GoalInfo | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const text = typeof r['text'] === 'string' ? r['text'] : '';
  if (text === '') return null;
  const now = new Date().toISOString();
  return {
    text,
    paused: r['paused'] === true,
    createdAt: typeof r['createdAt'] === 'string' ? r['createdAt'] : now,
    updatedAt: typeof r['updatedAt'] === 'string' ? r['updatedAt'] : now,
  };
}

/** 用请求体局部更新本地缓存（乐观），保持 createdAt、沿用旧 paused。 */
function optimistic(prev: GoalInfo | null, patch: { text?: string; paused?: boolean }): GoalInfo | null {
  const now = new Date().toISOString();
  const text = patch.text === undefined ? prev?.text ?? '' : patch.text.trim();
  if (text === '') return null;
  const paused = patch.paused === undefined ? prev?.paused === true : patch.paused;
  return { text, paused, createdAt: prev?.createdAt ?? now, updatedAt: now };
}

/**
 * 设置/清除目标。`text: ''` = 清除（完成）。
 * 乐观：先画终态，请求后台跑；失败回滚并抛出（调用方负责给可见说明，W795 口径）。
 * 返回最终目标（null = 已清除）。
 */
export async function applyGoal(ctx: SessionPane, text: string): Promise<GoalInfo | null> {
  const session = ctx.id;
  const prev = goals.get(session) ?? null;
  const wanted = text.trim();
  setLocal(session, optimistic(prev, { text: wanted }));
  ctx.goal = wanted === '' ? null : wanted;
  try {
    const r = await api.setGoal(session, { text: wanted });
    if (r.ok === false) throw new Error(r.error ?? t('chat.goal.failed'));
    const g = normalize(r.goal);
    setLocal(session, g);
    ctx.goal = g ? g.text : null;
    return g;
  } catch (err) {
    setLocal(session, prev); // 回滚
    ctx.goal = prev ? prev.text : null;
    throw new Error(t('chat.goal.saveFailed', { reason: userErrorText(err, t('settings.common.retryLater')) }));
  }
}

/**
 * W9347：暂停 / 恢复（冻结契约 v1 的 `paused` 字段）。
 * 契约：**当前没有目标**时后端 422 ⇒ 这里先本地挡一道（不发无意义的请求）。
 */
export async function setGoalPaused(ctx: SessionPane, paused: boolean): Promise<GoalInfo | null> {
  const session = ctx.id;
  const prev = goals.get(session) ?? null;
  if (prev === null) throw new Error(t('chat.goal.failed'));
  setLocal(session, optimistic(prev, { paused }));
  try {
    const r = await api.setGoal(session, { paused });
    if (r.ok === false) throw new Error(r.error ?? t('chat.goal.failed'));
    const g = normalize(r.goal);
    setLocal(session, g);
    return g;
  } catch (err) {
    setLocal(session, prev); // 回滚
    throw new Error(t('chat.goal.saveFailed', { reason: userErrorText(err, t('settings.common.retryLater')) }));
  }
}

/** `/goal` 无参数：显示当前目标（可读一句，不新建）。 */
export function currentGoalText(ctx: SessionPane): string {
  const g = goalOf(ctx.id);
  return g ? g.text : '';
}

// ---- W9349：会话被激活时把**已存在**的目标读回来（刷新后胶囊不消失的那一半） --------

/**
 * 竞态守卫（前端铁律 3）：切换会话是**异步**的 —— 晚到的旧会话回声不得覆盖当前会话。
 *
 * 为什么代号自增就够：结果只写**它自己那个会话的**缓存（`setLocal(asked, …)`），
 * 旧会话的回声落进旧会话的格子、当前会话的胶囊本来就不读它；而「同一会话的两次
 * 在途请求」（A→B→A，或 20s 轮询式的重入）只有代号能分辨，后到的**旧**那条会
 * 按更旧的快照覆盖掉新状态。代号自增后，在途请求一律作废。
 *
 * 先例：statusline/permission.ts 的 permSeq（本仓同一口径）、archive/panel.ts、
 * commands/popup.ts 的 seq。
 */
let readSeq = 0;

/**
 * 读一次该会话的目标并填进缓存 + 广播（胶囊/徽标按**既有**渲染路径自己出来，
 * 这里不为「刷新读回」新增任何渲染分支）。
 *
 * **失败不清缓存**：网络错 / 非 200 一律保持现状 —— 把「没读到」当成「没有目标」
 * 会让一次网络抖动把界面上真实存在的目标抹掉。只有明确读到 `goal: null` 才清。
 */
export async function readGoal(session: string): Promise<void> {
  // LOCAL 空容器（id === ''）没有服务端会话可问：发出去必然 404，白白制造失败。
  if (session === '') return;
  const asked = session;
  const seq = ++readSeq;
  try {
    const r = await api.getGoal(asked);
    if (seq !== readSeq) return; // 晚到的旧回声：丢弃，不覆盖当前会话
    setLocal(asked, normalize(r.goal));
  } catch {
    // 保持现状：不清缓存、不广播。下次激活 / 下次刷新会再读一次。
  }
}

/**
 * 会话被激活时读回目标。与 statusline / 胶囊的既有接线**同一个入口**
 * （ui/commands/index.ts 的 onPaneChange）—— 不另开一条装配路径。
 */
export function syncGoalOnActivate(pane: SessionPane | null): void {
  if (pane === null) return;
  void readGoal(pane.id);
}

// ---- 界面可见：聊天区上方的浮动胶囊 -------------------------------------------------
let capsuleEl: HTMLElement | null = null;
/** 展开编辑态（null = 收起）。只记归属的 pane —— 输入框的内容由它自己持有。 */
let editing: { pane: SessionPane } | null = null;

function ensureCapsule(): HTMLElement {
  if (capsuleEl && capsuleEl.isConnected) return capsuleEl;
  // ★ 先问 DOM 再建：模块级缓存只在**同一个模块实例**里有效，而真实页面里
  //   main.ts 走的是自己的 import 图，与任何按需 import 拿到的实例不是同一份
  //   模块状态 —— 只信缓存会在 #messages 里堆出**第二个**同名胶囊（真机实测：
  //   两个 .goal-capsule 并排，一个空一个满，querySelector 命中的是空的那个）。
  //   复用 DOM 里已有的那一个 ⇒ 「页面里永远只有一个胶囊」这条不变量由 DOM 兜住。
  const existing = document.querySelector<HTMLElement>('.goal-capsule');
  if (existing !== null) {
    capsuleEl = existing;
    return existing;
  }
  capsuleEl = el('div', 'goal-capsule hidden');
  capsuleEl.setAttribute('role', 'group');
  // 挂在 #messages（**position: relative**）而不是 #main（static）：绝对定位需要一个
  // 定位包含块，否则 `top: 0` 会落到视口顶端、被顶栏压住而不是贴在消息区上方。
  // #messages 是消息区的宿主，胶囊因此永远跟着消息区走（不随 #main 的 flex 变化漂移）。
  const host = document.getElementById('messages') ?? document.getElementById('main') ?? document.body;
  host.appendChild(capsuleEl);
  return capsuleEl;
}

/** 胶囊内的一个图标动作按钮（命中区由 CSS 撑到 ≥24px；名字给全，不靠图标说话）。 */
function actionButton(
  name: 'pencil' | 'pause-glyph' | 'trash',
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const b = el('button', 'goal-act') as HTMLButtonElement;
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.dataset['act'] = name;
  b.appendChild(iconNode(name, { size: 14, className: 'goal-act-icon' }));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** 展开态：可输入的一行。Enter 保存 / Esc 取消 / 失焦取消（**绝不偷存**）。 */
function buildEditor(pane: SessionPane, current: string): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = el('div', 'goal-capsule-input');
  const input = el('input', 'goal-input') as HTMLInputElement;
  input.type = 'text';
  input.value = current;
  input.setAttribute('aria-label', t('chat.goal.tag'));
  const cancel = (): void => { editing = null; renderGoalBar(); };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const wanted = input.value;
      editing = null;
      void applyGoal(pane, wanted).then(() => renderGoalBar()).catch(() => renderGoalBar());
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', () => { if (editing !== null) cancel(); });
  wrap.appendChild(input);
  return { wrap, input };
}

/** 重画胶囊（只在有目标时可见；无目标不出现也不占位）。 */
export function renderGoalBar(): void {
  const capsule = ensureCapsule();
  const pane = activePane();
  const g = pane ? goalOf(pane.id) : null;
  if (!pane || !g) {
    capsule.classList.add('hidden');
    capsule.replaceChildren();
    editing = null;
    return;
  }
  capsule.classList.remove('hidden');
  if (editing !== null && editing.pane.id !== pane.id) editing = null;

  // 展开编辑态：胶囊替换成输入框（不受 2 汉字宽限制）。
  if (editing !== null) {
    const { wrap, input } = buildEditor(pane, g.text);
    capsule.classList.add('goal-capsule-editing');
    capsule.replaceChildren(wrap);
    input.focus();
    input.select();
    return;
  }
  capsule.classList.remove('goal-capsule-editing');
  capsule.classList.toggle('goal-capsule-paused', g.paused);

  const title = g.paused ? t('chat.goal.pausedTitle', { text: g.text }) : t('chat.goal.title', { text: g.text });
  const label = el('span', 'goal-capsule-label');
  // 暂停态点胶囊本体 = 恢复（主人原话）。活跃态**不**把它做成可点控件：
  // 一个「点下去什么也不发生」的按钮是假的可点性，只会让读屏器宣告一个空操作。
  const text = g.paused
    ? (() => {
        const b = el('button', 'goal-capsule-text') as HTMLButtonElement;
        b.type = 'button';
        b.title = t('chat.goal.resume', { text: g.text });
        b.setAttribute('aria-label', b.title);
        b.textContent = g.text;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          void setGoalPaused(pane, false).then(() => renderGoalBar()).catch(() => renderGoalBar());
        });
        return b;
      })()
    : (() => {
        const s = el('span', 'goal-capsule-text', g.text);
        s.title = title;
        return s;
      })();
  label.appendChild(text);
  // 暂停角标：作为文字的**兄弟**放在 2 汉字宽的截断盒**外面** ——
  // 放进盒内（::after）会被 overflow:hidden 一起裁掉，真机实测看不见。
  if (g.paused) label.appendChild(el('span', 'goal-capsule-paused-mark', t('chat.goal.pausedMark')));

  const actions = el('span', 'goal-capsule-actions');
  actions.appendChild(actionButton('pencil', t('chat.goal.edit'), () => {
    editing = { pane };
    renderGoalBar();
  }));
  actions.appendChild(actionButton('pause-glyph', g.paused ? t('chat.goal.resumeShort') : t('chat.goal.pauseShort'), () => {
    void setGoalPaused(pane, !g.paused).then(() => renderGoalBar()).catch(() => renderGoalBar());
  }));
  actions.appendChild(actionButton('trash', t('chat.goal.delete'), () => {
    void applyGoal(pane, '').then(() => renderGoalBar()).catch(() => renderGoalBar());
  }));

  capsule.replaceChildren(label, actions);
}

/** 切会话时若有未保存的编辑态，收起它（切走不该把半截文本带过去）。 */
export function closeGoalEditing(): void {
  if (editing === null) return;
  editing = null;
  renderGoalBar();
}
