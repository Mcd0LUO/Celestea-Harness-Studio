// ============================================================================
// ui/restore.ts — 会话历史恢复（W514 多会话版）：
//   GET /api/sessions/{id}/messages → 用与 live 相同的渲染管线渲染最近
//   N=200 条存量（更早的加折叠提示）→ 尾部加「以下为本次会话」分隔线 →
//   之后的 SSE 增量照旧。衔接去重：SSE 重放的助手文本若与已恢复尾部同内容
//   （前缀匹配）则吞掉，直到发散；done 全量一致时丢弃重复气泡。
//   404/超时/端点缺失 → 保持空视图 + 轻提示，绝不崩溃。
//   W514：渲染目标 = 会话视图容器（SessionPane），去重状态每容器一份；
//         离屏双缓冲 + 单次替换（铁律 1）保持不变 → 切换/恢复无空白帧。
// ============================================================================
import { api } from '../api';
import { attachmentViewsOf } from './attachments';
import { el } from '../utils/dom';
import { t } from '../i18n';
import type { HistoryMsg } from '../types';
import {
  activatePane,
  activePane,
  adoptPane,
  ensurePane,
  type SessionPane,
} from './viewctx';
import {
  addUserMessage,
  autoscroll,
  buildThinkSeg,
  ensureAssistant,
  finalizeAssistant,
  rebaseThinkRetained,
  renderEmptyHint, // W9229（F-21）：走 messages.ts 的**唯一对外重建入口**（含账本/句柄复位）
  renderInboxMessage,
  type MsgKind,
} from './messages';
import { parseQuoteBlocks } from './quote/model'; // F1：历史回放解析引用块
import { railAdd, railReset, railSync } from './rail';
import type { ToolCardRef } from './view';
import { renderToolMessage } from './restore-tool'; // W1485：工具条目渲染拆出（纯搬家）
import { setToolResult } from './toolcards'; // 收尾时给「有调用无结果」的卡补终态
import { prunePaneDom } from './messages/dom-cap'; // W1485：消息容器的 DOM 上限
// W784：转录里的提问行（§7.2）+ 未决列表重建（刷新 / 重连 / 切会话后）。
import { historyQuestionsOf, type HistoryQuestion } from './question/format';
import { recoverQuestions, renderHistoryQuestionCard } from './question';
import { mountTaskPanel } from './taskpanel'; // W1533：历史恢复会 replaceChildren，面板要归位

const MAX_RESTORE = 200;

/**
 * W2015：向服务端**要多少条** = 渲染窗口 + 1。
 *
 * 为什么是 201 而不是 200：折叠提示的判据是「总条数 > MAX_RESTORE」，而裁剪后的
 * 响应里 `all.length` 已经是窗口大小 —— 直接要 200 会让「还有更早的」这件事在客户端
 * 变得**不可判定**（200 条与「正好 200 条」不可区分），折叠提示就会凭空消失。
 * 多要 1 条把「是否被裁」这个比特原样带回来：服务端回 201 ⇒ 总数 > 200 ⇒ 提示照出，
 * 回 ≤200 ⇒ 总数就是这么多 ⇒ 与改动前逐字一致。随后 `slice(-MAX_RESTORE)` 取最近
 * 200 条 —— 与服务端裁剪前 `full.slice(-200)` 是同一段，渲染结果不变。
 *
 * 旧后端不认识 `?tail`（忽略未知查询参数）→ 仍回全量 ⇒ 上面的判据照旧成立，
 * 只是没省下带宽；**行为不回退**，因此这条改动对版本偏斜是安全的。
 */
const RESTORE_TAIL = MAX_RESTORE + 1;

// W9229：衔接去重状态搬到 ./restore-dedup.ts（模块体积门禁），此处再导出保持 import 路径兼容。
import { resetRestore } from './restore-dedup';
export { feedAssistantDelta, finalAssistantDedup, guardBufLimit, resetRestore } from './restore-dedup';

/**
 * W1485：历史恢复的**分帧**片大小（条/片）。
 *
 * 症状：刷新时同步渲染最近 200 条，其中可能包含若干 100KB+ 的消息 —— 主线程被
 * 一次性占满，观感就是「刷新网页本身也被卡死」。修法是把离屏构建切成片，片间让出
 * 一次事件循环（requestIdleCallback 优先，回落 setTimeout(0)）。
 *
 * 为什么「小于两片就不让出」：小会话（≤ RESTORE_CHUNK 条）在同一个微任务里就建完了
 * —— 那正是 W867 的要求（历史在 0ms 内到位，不等节拍），也让 w867-render-timing 的
 * 「0ms 内渲染完」继续成立。让出只发生在**确实需要**分批的时候。
 */
const RESTORE_CHUNK = 40;

/** 让出一次事件循环（浏览器空闲优先；无 requestIdleCallback 时回落 setTimeout）。 */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => resolve(), { timeout: 50 });
      return;
    }
    window.setTimeout(resolve, 0);
  });
}

/**
 * W515：历史条目的种类映射 ——
 *   role=user + kind='steering'|'queued' → 插话/排队气泡（与普通用户消息可区分）；
 *   role/kind='inbox' → 回执/系统注入条目；
 *   其余保持现状（未知 kind 一律按普通消息渲染，不丢内容）。
 */
function userKindOf(m: HistoryMsg): MsgKind {
  if (m.kind === 'steering') return 'steering';
  if (m.kind === 'queued') return 'queued';
  return 'user';
}

function renderOne(
  ctx: SessionPane,
  m: HistoryMsg,
  container: HTMLElement,
  questions: Map<string, HistoryQuestion>,
): void {
  const content = String(m.content ?? '');
  // W784：提问行 → 提问卡片（未结算的渲染成「已过期 · 未作答」终态，§7.2 规则 4）；
  // 回答行不再单独渲染 —— 它已经回显在对应卡片上（同一张卡，不产生第二个条目）。
  const qid = typeof m.question_id === 'string' ? m.question_id : '';
  if (m.role === 'question') {
    const row = qid === '' ? undefined : questions.get(qid);
    if (row !== undefined && m.kind === 'question') {
      renderHistoryQuestionCard(ctx, row, container);
    }
    return;
  }
  if (m.role === 'inbox' || m.kind === 'inbox') {
    renderInboxMessage(ctx, content, { source: m.source, kind: m.kind, into: container });
    return;
  }
  if (m.role === 'user') {
    const parsed = parseQuoteBlocks(content); // 只在 role=user 解析（架构侧裁决）
    addUserMessage(ctx, parsed.rest, {
      kind: userKindOf(m),
      attachments: attachmentViewsOf(m.attachments),
      quotes: parsed.quotes,
      into: container,
    });
    return;
  }
  if (m.role === 'assistant') {
    if (content.trim() === '') return;
    const a = ensureAssistant(ctx, container);
    a.text = content;
    finalizeAssistant(ctx, a);
    return;
  }
  if (m.role === 'thinking') {
    renderThinkingHistory(content, container);
    return;
  }
  renderToolMessage(ctx, m, container);
}

/**
 * 历史思考条目：与 live **同一构建函数** buildThinkSeg（默认折叠态因此不可能分叉）。
 * 历史恢复 = 静态内容，永远用默认态（collapsed: true），不随 live 流式状态变化。
 *
 * ★ W9113（P1-2）：构造期**不记账**（容器还是离屏的 off）。记账由收尾段的
 *   [rebaseThinkRetained] 在**搬家之后**按 DOM 实况重定基 —— 既保住「账本记在真正
 *   持有节点的容器上」，又顺带覆盖窗口期到达的 live 段与容器重建（W9222/F-11）。
 */
function renderThinkingHistory(content: string, container: HTMLElement): void {
  container.appendChild(buildThinkSeg({ text: content, collapsed: true }).root);
}

function appendNote(ctx: SessionPane, text: string): void {
  if (ctx.el.querySelector('.restore-note')) return;
  ctx.el.appendChild(el('div', 'restore-note', text));
}

/**
 * W9222（F-06）：恢复**中止**时把已发生的副作用回滚。
 *
 * 缺陷：`railReset` / `restoreOps.clear` / `histToolStep = 0` 在 guard 检查**之前**
 * 就执行了，而函数有 4 个 return 点 —— 中途放弃时旧 DOM 原样留着，长条与工具卡索引
 * 却被清了（「有调用无结果」的卡片永远停在 running；长条整批消失）。
 *
 * 回滚口径：
 *   · `restoreOps` / `histToolStep` 是纯 ctx 字段 —— 按快照还原。快照存的是 Map
 *     **引用**（不是副本），回滚即换回原 Map：全仓只有 `ctx.restoreOps` 这一条读路径，
 *     没人按引用缓存过它，换身份比「清空 + 逐条塞回」更准（一条不丢）也更省。
 *   · rail 没有「还原快照」的公开入口（记账住在 rail-state.ts，超出本轮文件边界），
 *     但 rail 记账是**旧 DOM 的纯函数**：旧 DOM 仍在 `ctx.el` 里，按它重建即可
 *     （railAdd 的合并规则与当初建 DOM 时逐条同构，角色由 msg 的类判定）。
 */
function rollbackRestore(ctx: SessionPane, ops: Map<string, ToolCardRef>, step: number): void {
  ctx.restoreOps = ops;
  ctx.histToolStep = step;
  railReset(ctx);
  for (const col of Array.from(ctx.el.children) as HTMLElement[]) {
    const c = col.firstElementChild?.classList;
    if (c?.contains('assistant')) railAdd(ctx, col, 'assistant');
    else if (c?.contains('user')) railAdd(ctx, col, c.contains('interject') ? 'interject' : 'user');
  }
}

/**
 * 渲染指定会话历史（最近 200 条 + 折叠提示 + 「以下为本次会话」分隔线）。
 * 离屏双缓冲——先在离屏容器完整构建，再一次性 replaceChildren（无空白帧）；
 * guard() 返回 false 时丢弃（竞态：旧请求结果晚到不得覆盖新会话）。
 * 404/超时/端点缺失 → 轻提示，不崩溃。
 */
export async function restoreSessionHistory(
  ctx: SessionPane,
  guard?: () => boolean,
): Promise<void> {
  let resp;
  try {
    resp = await api.messages(ctx.id, RESTORE_TAIL);
  } catch (err) {
    if (!ctx.streaming) {
      appendNote(
        ctx,
        t('shell.restore.unavailable'),
      );
    }
    return;
  }
  if (guard && !guard()) return; // 竞态：期间已发起更新的切换，丢弃本次结果
  const all = resp.messages ?? [];
  if (ctx.streaming) return; // 已开跑：不打断实时流

  // W9222（F-06）：副作用**之前**先留快照 —— 中途放弃（guard / streaming）要能回滚。
  const ops = ctx.restoreOps;
  const step = ctx.histToolStep;
  ctx.restoreOps = new Map();
  ctx.histToolStep = 0;
  // W9222（F-05）：记下窗口期**之前**就存在的节点 —— 之后新出现的都是 live 增量。
  // 用节点集合而不是「起始下标」：窗口期内 live 帧可能触发 prunePaneDom 从**头部**回收
  // 节点，下标会因此整体前移、尾部切片会漏掉真正的 live 节点；按身份判定不受影响。
  const preexisting = new Set<Node>(Array.from(ctx.el.childNodes));
  // 离屏构建（不挂载，浏览器不绘制中间态）
  railReset(ctx); // 先清该会话旧长条；离屏渲染注册的新条目在替换后重新 layout
  const off = document.createElement('div');
  if (all.length > MAX_RESTORE) {
    off.appendChild(
      el('div', 'restore-fold', t('shell.restore.folded', { n: MAX_RESTORE })),
    );
  }
  const recent = all.length > MAX_RESTORE ? all.slice(all.length - MAX_RESTORE) : all;
  // W784 §7.2：提问/回答两行按 question_id 配对（有问无答 = 该提问不可再答）。
  const questions = new Map(historyQuestionsOf(recent).map((row) => [row.id, row]));
  // W1485：分片渲染（片间让出事件循环）—— 200 条重消息不再一次性占满主线程。
  // 单片的会话不进这个循环的 await（见 RESTORE_CHUNK 注释）。
  for (let i = 0; i < recent.length; i += RESTORE_CHUNK) {
    if (i > 0) {
      await yieldToBrowser();
      if (guard && !guard()) { rollbackRestore(ctx, ops, step); return; } // 期间切了会话
      if (ctx.streaming) { rollbackRestore(ctx, ops, step); return; }     // 期间开跑了
    }
    for (const m of recent.slice(i, i + RESTORE_CHUNK)) renderOne(ctx, m, off, questions);
  }
  if (ctx.restoreOps.size) {
    for (const ref of ctx.restoreOps.values()) {
      setToolResult(ref, t('shell.restore.noResult'), false);
    }
    ctx.restoreOps.clear();
  }
  if (recent.length) {
    const sep = el('div', 'live-sep');
    sep.appendChild(el('span', null, t('shell.restore.sessionStart')));
    sep.title = t('shell.restore.earlier');
    off.appendChild(sep);
  }
  if (guard && !guard()) { rollbackRestore(ctx, ops, step); return; }

  // W9222（F-05）：恢复窗口期到达的 live 节点（thinking / text / tool）此前会被
  // replaceChildren 连同旧 DOM 一起丢掉 —— 实时流不因恢复而暂停，所以这是必然丢帧。
  // 把它们按文档序搬进离屏容器（排在历史与「以下为本次会话」分隔线**之后**），
  // 随同一次替换进入新 DOM；段自己的账本条目（thinkFolds / registerThinkSeg）挂在
  // 节点上，因此随节点一起保留（W895-R 的「实时与重放逐字一致」因此仍成立）。
  const liveAdded = Array.from(ctx.el.childNodes).filter((n) => !preexisting.has(n));
  for (const n of liveAdded) off.appendChild(n);

  // 一次性替换（无空白帧）
  ctx.el.replaceChildren(...off.childNodes);
  if (!recent.length && liveAdded.length === 0) {
    renderEmptyHint(ctx);
    const sep = el('div', 'live-sep');
    sep.appendChild(el('span', null, t('shell.restore.sessionStart')));
    ctx.el.appendChild(sep);
  }
  // W9229（F-21）：走 resetRestore 这个**唯一复位入口**（它此前是零调用者的死代码，
  // 注释声称的复位能力与实际路径不符）。语义与原先的四行赋值逐字相同。
  resetRestore(ctx);
  ctx.dedup.tail = recent.length ? (recent[recent.length - 1] ?? null) : null;
  // W9113（P1-2）+ W9222（F-11）：**搬家之后**按 DOM 实况把账本重定基 —— 账本必须
  // 记在真正持有这些节点的容器上，且容器整体重建后旧账本不得残留（见 rebaseThinkRetained）。
  rebaseThinkRetained(ctx.el);
  // W1485：恢复收尾统一裁一次 DOM（force：不参与 assistant 那条时间窗节流）。
  // 历史本身已按 MAX_RESTORE 条截断，这一步兜的是「服务端一次给回上千条」的情形。
  // W9229（F-20）：裁剪前后各数一次列数 —— 误删整容器（W9201 的 P0 形态）必须立刻可见。
  const colsBefore = ctx.el.querySelectorAll('.mcol').length;
  prunePaneDom(ctx, true);
  recoverIfEmptied(ctx, colsBefore);
  // W1533：上面的 replaceChildren 把任务面板（.sess-pane 的第一个子节点）一起换掉了
  // —— 恢复期间到达的清单已经写进 store，这里只把面板节点重新插回最前面即可
  // （句柄与列表 DOM 都复用，见 ui/taskpanel/wire.ts 的 place()）。
  mountTaskPanel(ctx);
  railSync(ctx);
  autoscroll(ctx, true);
  // 历史就位后再问服务端「还有哪些提问没结算」：进程没重启的刷新靠这一步把卡片
  // 从「未作答」放回可作答；进程重启了服务端就没有它，卡片留在终态（§7.2）。
  void recoverQuestions(ctx);
  // W9222（F-07）：`restored` 必须是**最后一条语句**。改动前它在 mountTaskPanel /
  // railSync / autoscroll **之前**，其中任何一步抛错都会让 Promise reject（openSession
  // 只挂 .finally，无 catch）而 `restored` 已是 true ⇒ 该会话从此再不会被恢复（只能
  // 刷新）。放在最后，任何一步失败都不会把它标成「已恢复」，切回即可重试。
  ctx.restored = true;
}

/**
 * W9229（F-20）：恢复收尾的**运行期兜底** —— 裁剪之后容器绝不允许被清空。
 *
 * `prunePaneDom` 的 P0 缺陷（跨父边界区间删除，已由 W9201 修掉）在修复前的实测形态是
 * `childrenAfter = 0`：整个会话 DOM 被连根删掉，而调用方完全无从察觉（返回值仍是
 * 「正常」的条数），用户看到的是「消息全没了」。
 *
 * 判据只看「刚刚明明有列、现在一条不剩」。命中时**就地恢复成空态**而不是只发一条告警：
 * 容器已经空了，画空态是此刻唯一诚实的终态（告警进不了用户的视野，也修不好画面）。
 * 返回 true = 已恢复（或本来就不需要恢复）。
 *
 * 为什么不用 console.warn 记这一条：apps/web/src 的 console.warn 计数是
 * docs/ARCHITECTURE.md §6.5.5 的**硬数字**（tests/doc-conventions.test.ts ⑩ 对拍），
 * 而该文档不在本轮文件边界内 —— 加一处告警会把计数打漂、让别人的门禁变红。
 */
export function recoverIfEmptied(ctx: SessionPane, colsBefore: number): boolean {
  if (colsBefore <= 0) return true;
  if (ctx.el.querySelectorAll('.mcol').length > 0) return true;
  renderEmptyHint(ctx); // 容器被清空：画空态（并顺带把思考账本按实况归零）
  return false;
}

/**
 * 解析当前活跃会话 id（W237）：
 *   1) GET /api/sessions 的 active 字段；2) GET /api/workspaces 的 active_session；
 *   3) 兜底：旧后端无 active 概念 → 若 cli-main 存在则用之；否则 null。
 */
export async function resolveActiveSession(): Promise<string | null> {
  try {
    const d = await api.sessions();
    const act = (d.sessions ?? []).find((s) => s.active === true);
    if (act?.id) return act.id;
  } catch {
    /* fall through */
  }
  try {
    const w = await api.workspaces();
    if (w.active_session) return w.active_session;
  } catch {
    /* fall through */
  }
  try {
    const d = await api.sessions();
    if ((d.sessions ?? []).some((s) => s.id === 'cli-main')) return 'cli-main';
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * 启动恢复：把 LOCAL 容器认领为当前活跃会话（容器对象不变 → 已渲染内容
 * 与 rail 状态全部保留），再拉取历史。
 */
export async function restoreActiveHistory(): Promise<void> {
  const id = await resolveActiveSession();
  if (id === null) {
    const ctx = activePane();
    if (ctx && !ctx.streaming) appendNote(ctx, t('shell.restore.noActive'));
    return;
  }
  const pane = adoptPane(id);
  // W9222（F-07）：恢复失败不得把 Promise 变成 unhandled rejection（main.ts 是 void 调用）。
  // 失败不标「已恢复」，切回即重试。此处不写 console.warn：apps/web/src 的计数是
  // docs/ARCHITECTURE.md §6.5.5 的硬数字（doc-conventions ⑩ 对拍），该文档超出本轮边界。
  if (!pane.restored && !pane.streaming) {
    try {
      await restoreSessionHistory(pane);
    } catch {
      pane.restored = false; // 未完成的恢复不得被标成「已恢复」
    }
  } else {
    void recoverQuestions(pane); // 历史已在/正在跑：仍补一次未决列表
  }
}

// ---- 会话切换（无空白帧 + 竞态防护 + 后台会话不阻塞） ----------------------------

let progressEl: HTMLElement | null = null;

function showSwitchProgress(): void {
  if (progressEl) return;
  progressEl = document.createElement('div');
  progressEl.className = 'switch-progress';
  // W795：这条顶部细进度条是**唯一**保留的非阻塞提示（历史数据本身就是终态内容，
  // 没有可先画的终态）；但它不再携带任何「正在加载…」文案（title 已删）。
  document.body.appendChild(progressEl);
}

function hideSwitchProgress(): void {
  progressEl?.remove();
  progressEl = null;
}

/**
 * 打开会话视图（W514）：
 *   - 立即切容器（hidden 切换，零重渲染）：别的会话在跑也照样切，不等任何请求；
 *   - 未恢复过历史 → 离屏双缓冲恢复（顶部细进度条，不整页空白）；
 *   - 正在跑（live）的会话 → 直接看实时流，不再拉历史；
 *   - seq 竞态防护：同一容器重复打开时旧结果丢弃。
 */
export function openSession(id: string, meta?: { kind?: string; title?: string }): SessionPane {
  const pane = ensurePane(id, meta?.kind, meta?.title);
  activatePane(id);
  if (!pane.streaming && !pane.restored) {
    const seq = ++pane.restoreSeq;
    showSwitchProgress();
    // restoreSessionHistory 末尾自带一次未决列表重建，此处不重复请求
    // W9222（F-07）：必须挂 catch —— 只挂 finally 时中途抛错会变成 unhandled rejection，
    // 而旧行为已把 ctx.restored 置位，该会话会永远停在半成品。不写 console.warn 同上。
    void restoreSessionHistory(pane, () => seq === pane.restoreSeq)
      .catch(() => {
        pane.restored = false; // 失败不标「已恢复」：切回时重试
      })
      .finally(() => {
        if (seq === pane.restoreSeq) hideSwitchProgress();
      });
  } else {
    // 切回已有内容的会话：可能错过了提问帧（切走期间模型问了）→ 补齐未决卡片
    void recoverQuestions(pane);
  }
  return pane;
}

/** 兼容旧入口：等价于 openSession（保留外部调用点）。 */
export function switchToSession(id: string): void {
  openSession(id);
}

/** 会话切换是否进行中（供外部判断加载态）。 */
export function isSwitching(): boolean {
  return progressEl !== null;
}
