// ============================================================================
// ui/sse-wire.ts — W9298（F1-01）：SSE 接线段（从 chat.ts 整段搬出，纯搬家）
// ----------------------------------------------------------------------------
// 为什么搬：chat.ts 顶在**前端硬上限 450 行**（例外表为空），F1-01 要在这里给 onStatus
// 加分支、外加新增的 recheckLagged —— 留在原地就顶破上限。
//
// 依赖方向（docs/ARCHITECTURE.md）：本模块**不 import chat.ts**。轮次处理函数
// （onStatus/onText/…）仍留在 chat.ts，由 chat.ts 在调用 connectWiredSse 时**注入**；
// 这样 ui/* 不会反向依赖编排层，依赖方向保持 core ← L1 ← runtime ← apps。
//
// 帧内预算的判读（为什么接在接线层）：预算是 **UI 工作量**的控制，而 SseClient 的契约
// 是「解析 + 分发」；接在接线层才能让同一条总线上的 status/text/thinking/tool/
// tool_result/done 共用一个队列（跨事件名保序）。设计理由见 messages/frame-budget.ts。
// ============================================================================
import { S } from '../state';
import { SseClient } from '../sse';
import { pickStatusFields, statusline } from '../statusline';
import { setStatus } from './statusbar';
import { onCompact } from './compact';
import { registerQuestionSse } from './question';
import { createFrameBudget } from './messages/frame-budget';
import { isActivePane, type SessionPane } from './viewctx';
import { t } from '../i18n';
import type {
  DonePayload,
  StatusPayload,
  TextPayload,
  ThinkingPayload,
  ToolPayload,
  ToolResultPayload,
} from '../types';

/**
 * ★ W9298（F1-06 P2）：**丢帧检测器** —— 用信封自带的 `seq` 发现「漏了一整段」。
 *
 * 背景：契约的 `seq` 是**进程级单调计数器**（apps/studio/src/sse.ts 的 `emit`：
 * `seq: seq++`，与订阅者无关），而重连时 `bus.subscribe()` 建的是**全新订阅**、**不重放**
 * 历史帧（handlers/dialog.ts 的 `registerEvents` 直接进入 next 循环）。于是
 * **一次重连 ⇒ 上一条收到的 seq 与下一条收到的 seq 之间必然出现断号**，断掉的那段就是
 * 断线期间发生的、且**永远补不回来**的帧。改动前前端从不读 `p.seq`，于是这段丢失
 * 完全不可见——用户看到的是「模型答到一半就跳到下一句」。
 *
 * 能做什么 / 不能做什么（边界写清楚，别让后人误以为它能恢复）：
 *  · 能：**如实告诉用户丢了多少帧**（检测 + 提示），这是契约内、不需改后端的全部能力。
 *  · 不能：**补齐**。没有补发端点，本帧之后也拿不到那些内容。要补齐必须改契约 +
 *    后端（超出本文件与本 worker 的范围），已在报告里作为后续项写明。
 *
 * 三条纪律（每条都有测试）：
 *  · **只认单调前进**：`seq <= last` 一律不报（重复投递 / 旧后端重排都不是丢帧）；
 *  · **只报一次**：一次断连只提示一次，恢复后继续跟踪（不刷屏）；
 *  · **旧后端无 seq**：`typeof seq !== 'number'` 直接放行，绝不把「没有序号」误报成「丢了」。
 */
export class SeqGapWatcher {
  private last: number | null = null;
  private reported = false;

  /**
   * 记一条帧的 seq；返回「这次丢了多少帧」（0 = 无丢失/不可判定）。
   * @param seq 该帧信封的 seq（withEnvelope 已把它并进 payload）。
   */
  observe(seq: unknown): number {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) {
      // 旧后端不带 seq：不可判定，既不记也不报。
      return 0;
    }
    const prev = this.last;
    if (prev === null) {
      this.last = seq;              // 首帧只立基线
      return 0;
    }
    // 不前进（重复投递 / 回退）**既不报、也不移动基线** —— 移动了就会在下一帧凭空
    // 造出一次「丢帧」（回退到 3 之后再收到 5，会被算成丢了 1 帧，而那 1 帧我们收到过）。
    if (seq <= prev) return 0;
    this.last = seq;
    const gap = seq - prev - 1;
    if (gap <= 0) return 0;
    // 本次断连只提示一次：已提示过就返回 0（缺口由 stats() 的累计值如实记录，不刷屏）。
    if (this.reported) return 0;
    this.reported = true;
    return gap;
  }

  /** 连接重建：允许再提示一次（新的断连是新的事实）。 */
  reset(): void {
    this.reported = false;
  }

  /** 供测试/诊断只读。 */
  stats(): { last: number | null; reported: boolean } {
    return { last: this.last, reported: this.reported };
  }
}

/** chat.ts 注入的轮次处理器与路由（本模块不 import chat.ts，见文件头依赖方向）。 */
export interface WireHandlers {
  ctxFor(p: { session?: string | null }): SessionPane;
  mergePaneStatus(ctx: SessionPane, p: StatusPayload): void;
  onStatus(ctx: SessionPane, p: StatusPayload): void;
  onStatusInbox(ctx: SessionPane, p: StatusPayload): void;
  onText(ctx: SessionPane, p: TextPayload): void;
  onThinking(ctx: SessionPane, p: ThinkingPayload): void;
  onTool(ctx: SessionPane, p: ToolPayload): void;
  onToolResult(ctx: SessionPane, p: ToolResultPayload): void;
  onDone(ctx: SessionPane, p: DonePayload): void;
}

export function connectWiredSse(h: WireHandlers): SseClient {  const sse = new SseClient();
  // W9113（P0-1）：轮次帧的 UI 工作统一过一个**帧内预算**队列 —— 症状（一帧 584 个
  // 回调 / 7.9–9.4 秒冻结）、K 的取法、「为什么保序」「为什么在这一层接线」全部写在
  // ./ui/messages/frame-budget.ts 的模块头，这里只留接线与错误隔离。
  const budget = createFrameBudget();
  // W9298（F1-06）：丢帧检测与预算**并行**——预算管「一帧做多少工作」，它管「有没有漏」。
  const gaps = new SeqGapWatcher();
  const paced = (label: string, run: () => void, frame?: unknown): void => {
    // W9298（F1-06）：**在进队列之前**就记 seq —— 排队中的帧同样算「已送达本浏览器」，
    // 而预算只延后不丢弃（frame-budget 模块头），所以「seq 连续」==「没漏帧」。
    // 放在 run() 里则会把「预算还没排到的那几帧」误判成丢帧。
    if (frame !== undefined) {
      const missed = gaps.observe((frame as { seq?: unknown } | null)?.seq);
      if (missed > 0) {
        statusline.setNote(t('chat.status.seqGap', { n: missed }), 6000);
      }
    }
    budget.push(() => {
      try {
        run();
      } catch (err) {
        console.warn(label, err);
      }
    });
  };
  sse.onConn((state) => {
    S.conn = state;
    // W9298（F1-06）：连接重建 ⇒ 允许下一次断号再提示一次（这是新的一次断连）。
    gaps.reset();
    if (state === 'online') {
      setStatus(S.streaming ? t('chat.phase.running') : t('shell.status.online'), S.streaming ? 'busy' : 'ok');
    } else if (state === 'down') {
      setStatus(t('shell.status.reconnecting'), 'err');
    }
  });
  // ★ W9201：status **也走 budget**。旧注释「前两者不碰消息容器」是错的：status 是唯一
  //   同时写「消息容器 + 状态栏 + 会话条」的事件（onStatus → finalizeTurn/renderInfoBlock；
  //   onStatusInbox → renderInboxMessage 追加一整条 .mcol）。后端 status 速率不低
  //   （adapter:388 / fallback-host:150），一次宏任务里同步 emit 一批就是 W9111 的形状。
  //   更关键是**全局保序**（frame-budget.ts:34-36）：status 直连时 `status:completed` 能插到
  //   已排队的 `tool_result` 之前落地（finalizeTurn 先跑、applyToolResult 后跑）。
  //   compact/question 仍不走：前者重载消息区（自带 await），后者是用户交互卡片。
  sse.on('status', (p) => {
    paced('SSE status', () => {
      const ctx = h.ctxFor(p);
      if (isActivePane(ctx)) {
        statusline.fromSse(p);
        if (p.session && ctx.status) ctx.status = { ...ctx.status, ...pickStatusFields(p) };
      } else {
        h.mergePaneStatus(ctx, p);
      }
      h.onStatus(ctx, p);
      // W1479: the injected-message lane rides ON the status frame (the backend
      // has always sent `placement` + `inbox` here). It used to have its own
      // `inbox` event, which the server can never emit, so live injection showed
      // up only after a refresh replayed the transcript.
      h.onStatusInbox(ctx, p);
    }, p);
  });
  // ★ 下面五条**轮次帧**（text/thinking/tool/tool_result/done）与 status 走同一条
  //   budget（它们都会写 DOM）；compact/question 不走，理由见上面 status 那段注释。
  sse.on('text', (p) => {
    paced('SSE text', () => h.onText(h.ctxFor(p), p), p);
  });
  sse.on('thinking', (p) => {
    paced('SSE thinking', () => h.onThinking(h.ctxFor(p), p), p);
  });
  sse.on('tool', (p) => {
    paced('SSE tool', () => h.onTool(h.ctxFor(p), p), p);
  });
  sse.on('tool_result', (p) => {
    paced('SSE tool_result', () => h.onToolResult(h.ctxFor(p), p), p);
  });
  sse.on('done', (p) => {
    paced('SSE done', () => {
      statusline.onSseDone();
      h.onDone(h.ctxFor(p), p);
    }, p);
  });
  sse.on('compact', (p) => {
    try {
      onCompact(p);
    } catch (err) {
      console.warn('SSE compact', err);
    }
  });
  // W784：提问帧 → 卡片；重连 → 用未决列表补齐（都在模块内，chat.ts 只留这一行）
  registerQuestionSse(sse, h.ctxFor);
  sse.connect();
  return sse;
}
