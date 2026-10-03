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
  const paced = (label: string, run: () => void): void => {
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
    });
  });
  // ★ 下面五条**轮次帧**（text/thinking/tool/tool_result/done）与 status 走同一条
  //   budget（它们都会写 DOM）；compact/question 不走，理由见上面 status 那段注释。
  sse.on('text', (p) => {
    paced('SSE text', () => h.onText(h.ctxFor(p), p));
  });
  sse.on('thinking', (p) => {
    paced('SSE thinking', () => h.onThinking(h.ctxFor(p), p));
  });
  sse.on('tool', (p) => {
    paced('SSE tool', () => h.onTool(h.ctxFor(p), p));
  });
  sse.on('tool_result', (p) => {
    paced('SSE tool_result', () => h.onToolResult(h.ctxFor(p), p));
  });
  sse.on('done', (p) => {
    paced('SSE done', () => {
      statusline.onSseDone();
      h.onDone(h.ctxFor(p), p);
    });
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
