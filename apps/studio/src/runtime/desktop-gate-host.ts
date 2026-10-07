/**
 * M2 — 桌面闸门的**确认传输**：把「敏感操作要人点一次」接到本仓既有的挂起问题链路上。
 *
 * ## 复用的是**传输**，不是模型面的服务
 *
 * 规划 §4.2 要的是「零新增端点、不动 core/agent-loop」。真正被复用的三件东西是：
 *   · 进程级 [QuestionRegistry]（挂起表）——`POST /api/questions/{id}/answer` 按 id 就能找到它；
 *   · `question` SSE 帧（宿主已有的 `publishQuestion` 回调）——卡片出现在用户眼前；
 *   · 前端既有的确认卡与 `POST /api/questions/{id}/answer`。
 *
 * 刻意**不走** `user-questions.ts::ask`：那是模型面的服务，它带 `assertCaller`
 * （子代理不许问人）与「调用者必须活着」两道守卫——那两道守卫对模型提问是对的，对系统
 * 发起的确认是错的（用户正盯着这台机器，而确认的发起者不是某个 turn）。这里直接
 * park 一个 [PendingQuestion]，是同一个传输的下半层。
 *
 * ## 文案纪律（安全不变量）
 *
 * 卡片上的每一句话都是本文件的**固定常量**，绝不采用工具参数或模型文本。模型可控的
 * 两个值（应用名、窗口标题）只作为**数据**填进固定句式，且先过 [asData]：折叠控制字符
 * 与双向文本覆盖符、截断长度。选项标签同样是常量——「允许」这个词必须来自代码，
 * 不能来自被确认的对象（否则模型可以把自己的话写成按钮）。
 *
 * ## 反疲劳限流的生命周期
 *
 * 闸门实例活一代（一次 compose = 一个 turn 边界），而「连续 3 次拒绝进 5 分钟冷却」
 * 必须**跨代**累计，否则每个 turn 边界都把计数清零、反疲劳形同虚设。所以限流器按
 * 会话存在一张**进程级**表里（[PROCESS_LIMITERS]），跨代复用同一个对象。
 */

import type { AskUserQuestionItem } from "@celestea/core";
import { UserQuestionError } from "@celestea/core";
import type { SessionEvent } from "@celestea/core";
import { bounded, type AttachmentStore } from "@celestea/tools";
import type { GrantAppScope } from "../store/grants.js";
import {
  createDesktopConfirmLimiter,
  createDesktopGate,
  type DesktopConfirmChannel,
  type DesktopConfirmLimiter,
  type DesktopConfirmOutcome,
  type DesktopConfirmRequest,
  type DesktopGate,
  type DesktopGateGrant,
} from "@celestea/runtime";
import { PendingQuestion, type QuestionRegistry } from "../question-registry.js";
import { desktopConfirmAnsweredRow, desktopConfirmAskedRow } from "../question-rows.js";

/**
 * 确认卡的固定 id。前端可以据它认出「这是系统发起的确认」并渲染自己的固定文案
 * （规划 §4.2 的文案纪律要求前端固定常量）；服务端这一份是它的兜底与真源。
 */
export const DESKTOP_CONFIRM_QUESTION_ID = "desktop_gate_confirm";
/** 卡头（固定常量）。 */
export const DESKTOP_CONFIRM_HEADER = "桌面操作确认";
/** 题干（固定常量）。 */
export const DESKTOP_CONFIRM_QUESTION = "允许这一次桌面操作吗？";
/** 批准按钮（固定常量：这个词必须来自代码）。 */
export const DESKTOP_CONFIRM_APPROVE = "允许这一次";
/** 拒绝按钮（固定常量）。 */
export const DESKTOP_CONFIRM_DENY = "拒绝";
/** 明细行的固定句式前缀；应用名作为数据接在后面。 */
export const DESKTOP_CONFIRM_DETAIL_PREFIX = "目标应用：";

/** 模型可控文本作为**数据**出现时的长度上限。 */
const DATA_MAX_CHARS = 200;

export interface DesktopGateHostOptions {
  /** 授权提供方（每次判定现取；由 compose 时刻的 EffectiveGrants 映射而来）。 */
  grants: () => DesktopGateGrant;
  /**
   * 进程级挂起问题表。缺席 = **没有确认通道** —— 于是需要确认的调用一律被闸门拒掉
   * （fail-closed），而不是「没人拦着所以放行」。
   */
  registry?: QuestionRegistry | null;
  /** 把挂起的问题发到用户眼前（宿主已有的 `publishQuestion` 回调）。 */
  publish?: (question: PendingQuestion) => void;
  /**
   * M2-B2b：把一次确认写进会话日志（desktop_confirm / desktop_confirm_answer 两行）。
   *
   * 缺省 = 不写。缺席**不是**降级成别的行类型：闸门照常裁决，只是这次确认不在
   * 审计轨迹里——所以接线方（session-compose）必须挂上它，见那里的晚绑定。
   *
   * 它是**审计**旁路，写失败不许改变已经发生的裁决：一个写不进去的审计行不该把
   * 一次已经被人点了「允许」的操作翻成拒绝。
   */
  record?: (event: SessionEvent) => void;
  /** 本会话的 id（`null` = 分离代；答案端点按它做同会话校验）。 */
  sessionId: string | null;
  /** 限流器表（测试注入；缺省 = 进程级共享表，跨代存活）。 */
  limiters?: Map<string, DesktopConfirmLimiter>;
  /** 平台 id（规划 §7 的形参注入）。 */
  platform?: string;
  /** 单次确认预算（缺省 60s，规划 §4.2）；测试压小它。 */
  timeoutMs?: number;
  now?: () => number;
}

/**
 * 进程级的每会话限流器表。
 *
 * 为什么是模块级：它要活过一代 runtime（见文件头）。键用会话 id（`""` = 分离代），
 * 所以一个会话的连续拒绝不会把另一个会话锁进冷却。
 */
const PROCESS_LIMITERS = new Map<string, DesktopConfirmLimiter>();

/**
 * 一代 runtime 的 desktop 装配：compose 直接把它交给 `DesktopWiring`。
 *
 * 放在这里而不是 composer 里的理由只有一条，但是硬的：session-compose.ts 卡在
 * 450 行的架构预算上（eslint max-lines），而这段装配的每一行都属于本模块的职责。
 */
export interface DesktopWiringOptions {
  sessionId: string | null;
  /** 本代 compose 时刻读到的有效授权（desktop 位 + 应用清单）。 */
  grants: { desktop: boolean; apps: GrantAppScope };
  /** 会话附件仓库（截图落点）。 */
  attachments: AttachmentStore | null;
  registry?: QuestionRegistry | null | undefined;
  /** 宿主的发布回调（`question` SSE 帧）。 */
  publishQuestion?: ((sessionId: string | null, question: PendingQuestion) => void) | undefined;
  /**
   * M2-B2b：把 desktop_confirm 两行写进会话日志。缺省 = 不写（离线测试没有日志）。
   *
   * 形状是「一个函数」而不是「一个 log」：compose 里这代 runtime 还没成形，调用方
   * 只能递一个**晚绑定**的取数口进来（见 session-compose 的 desktopHolder）。
   */
  record?: ((event: SessionEvent) => void) | undefined;
  now?: (() => number) | undefined;
}

/** 装配一代桌面接线（附件仓库 + 闸门）。 */
export function desktopWiringOf(opts: DesktopWiringOptions): { attachments: AttachmentStore | null; gate: DesktopGate } {
  return {
    attachments: opts.attachments,
    gate: createDesktopGateHost({
      sessionId: opts.sessionId,
      grants: () => ({ desktop: opts.grants.desktop, apps: opts.grants.apps }),
      registry: opts.registry ?? null,
      ...(opts.publishQuestion === undefined ? {} : { publish: (question) => opts.publishQuestion?.(opts.sessionId, question) }),
      ...(opts.record === undefined ? {} : { record: opts.record }),
      ...(opts.now === undefined ? {} : { now: opts.now }),
    }),
  };
}


/**
 * M2-B2b: the desktop gate's audit sink, given the session log **by name** rather
 * than by value.
 *
 * Why a getter and not the log itself: compose() builds this wiring BEFORE the
 * runtime exists (that is the same late binding questionWiring exists for), so
 * the only thing available here is "the log, if this generation has one".
 *
 * Two guards, both deliberate:
 *   · absent log = no audit for this generation, NOT an error (an offline run
 *     has no log; a released generation's log now belongs to someone else);
 *   · a failed append is swallowed, because this channel is an audit SIDE
 *     channel: a full or unwritable log must not turn a desktop action the
 *     human already approved into a denial.
 */
export function createDesktopAuditSink(
  sessionOf: () => { append(event: SessionEvent): void } | null,
): (event: SessionEvent) => void {
  return (event: SessionEvent): void => {
    const log = sessionOf();
    if (log === null) return;
    try {
      log.append(event);
    } catch {
      /* audit-only row: the log's own degraded channel reports the failure */
    }
  };
}

/** 建一个桌面闸门，其确认走本进程既有的挂起问题链路。 */
export function createDesktopGateHost(opts: DesktopGateHostOptions): DesktopGate {
  const registry = opts.registry ?? null;
  const limiters = opts.limiters ?? PROCESS_LIMITERS;
  const key = opts.sessionId ?? "";
  let limiter = limiters.get(key);
  if (limiter === undefined) {
    limiter = createDesktopConfirmLimiter(opts.now === undefined ? {} : { now: opts.now });
    limiters.set(key, limiter);
  }
  // 通道 = 挂起表 **加** 发布回调，两件都要。只有表没有发布者的话，卡片永远到不了
  // 用户眼前，于是每一次确认都只能等满 60 秒再拒 —— 那是「假装有通道」。缺任一件就
  // 报「本宿主没有确认通道」（desktop_confirm_unavailable），比一个看不见的卡片诚实。
  const publish = opts.publish;
  return createDesktopGate({
    // 端口形状：宿主给的是「现取快照」的函数，闸门要的是它的一个方法（DesktopGateGrantSource）。
    grants: { read: opts.grants },
    // W2014：赛跑交给**统一原语**（本层本来就依赖 @celestea/tools，而闸门所在的
    // packages/desktop 只依赖 core —— 见 gate.ts::DesktopDeadline 的说明）。闸门只回答
    // 「超时算什么」：resolve 成 "timeout"，由它翻成 desktop_confirm_timeout 的 fail-closed。
    deadline: (work, timeoutMs, onTimeout) => bounded(work, timeoutMs, { mode: "resolve", value: onTimeout }),
    confirm: registry === null || publish === undefined ? null : channelOver(registry, publish, opts.sessionId, opts.now ?? Date.now, opts.record),
    limiter,
    ...(opts.platform === undefined ? {} : { platform: opts.platform }),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
}

/** 把一次确认请求 park 成一张问题，并把人答的结果翻译回裁决。 */
function channelOver(
  registry: QuestionRegistry,
  publish: ((question: PendingQuestion) => void) | undefined,
  sessionId: string | null,
  now: () => number,
  record: ((event: SessionEvent) => void) | undefined,
): DesktopConfirmChannel {
  return {
    confirm: async (request) => {
      const question = new PendingQuestion({
        requestId: registry.nextRequestId(),
        sessionId,
        questions: [confirmItem(request)],
        expiresAt: now() + request.timeoutMs,
        timeoutMs: request.timeoutMs,
      });
      // 计时从 park 起算：卡挂了多久 = 人想了多久，而这正是审计里唯一能区分
      // 「秒答」与「盯着屏幕拖到超时」的数字。
      const startedAt = now();
      // M2-B2b：ask 行在 park 的同一拍写。**不**等到结算才一并写，是因为进程死在
      // 等待途中也是一个要被看见的事实——那时没有 answer 行，恰恰说明这次确认
      // 没有结论。
      writeAudit(() => record?.(desktopConfirmAskedRow(question.requestId, askFactsOf(request))));
      registry.add(question);
      // 主动的计时那一半：即使没人读表，挂起的 await 也必须被解开（照
      // user-questions.ts::park 的同一条理由）。
      question.armTimer(now);
      publish?.(question);
      try {
        const outcome = verdictOf(await question.result);
        writeAudit(() => record?.(desktopConfirmAnsweredRow(question.requestId, outcome, now() - startedAt)));
        return outcome;
      } catch (error) {
        // 取消是一条**正常**的终态（用户把卡片关掉了），不是通道故障：如实报 cancelled，
        // 闸门据此给一个与「被拒」不同的原因码。其它异常照原样抛出去，闸门按
        // desktop_confirm_failed（fail-closed）处理——通道坏了与人不答应是两件事。
        if (error instanceof UserQuestionError && error.code === "ASK_CANCELLED") {
          writeAudit(() => record?.(desktopConfirmAnsweredRow(question.requestId, "cancelled", now() - startedAt)));
          return "cancelled";
        }
        // 通道故障（不是裁决）**没有** answer 行：那四态闭集里没有它的位置，而把一条
        // 异常伪装成某个裁决是审计最不能犯的错。ask 行仍在，它就是「这次没有结论」。
        throw error;
      } finally {
        // 每一条出口都注销：已结算的问题不再出现在恢复列表里。
        registry.remove(question.requestId);
      }
    },
  };
}

/**
 * 审计行里的模型可控字段，在**写日志的这一刻**过一次 asData。
 *
 * 为什么在这里再做一次而不是只信确认卡那份：asData 是本文件唯一处理模型可控文本的
 * 地方，让它同时守住两条出口（卡片与日志），才不会哪天有人给日志加一条不经它的新
 * 出口 —— 卡片上过了一次净化不等于日志里那份也过了。
 */
function askFactsOf(request: DesktopConfirmRequest): Parameters<typeof desktopConfirmAskedRow>[1] {
  return {
    method: request.method,
    app: asData(request.app),
    ...(request.title === undefined || request.title === "" ? {} : { title: asData(request.title) }),
    reason: request.reason,
    timeoutMs: request.timeoutMs,
  };
}

/**
 * 审计是**旁路**：写失败只让它失败，绝不改变已经发生的裁决。
 *
 * 一个写不进日志的确认卡不能把「人点了允许」翻成拒绝——那既是可用性事故，也是安全
 * 事故：fail-closed 的理由是「没人确认过」，不是「日志满了」。
 */
function writeAudit(fn: () => void): void {
  try {
    fn();
  } catch {
    /* audit-only row: the log's own degraded channel reports the failure */
  }
}

/** 人的答案 → 闸门的裁决。空答案（超时）与「没点允许」都落在拒绝之外的那两态上。 */
function verdictOf(outcome: { answers: Array<{ selected: string[] }>; timed_out: boolean }): DesktopConfirmOutcome {
  if (outcome.timed_out) return "timeout";
  return outcome.answers.some((answer) => answer.selected.includes(DESKTOP_CONFIRM_APPROVE)) ? "approve" : "deny";
}

/**
 * 一张确认卡。**全部字符串都是常量**，只有应用名/窗口标题作为数据填进去。
 *
 * 为什么应用名放 `detail` 而不是拼进题干：题干是用户读的那句话，它必须逐字可预期；
 * 把模型可控的字符串拼进去，等于让被确认的对象参与书写确认书。
 */
function confirmItem(request: DesktopConfirmRequest): AskUserQuestionItem {
  const lines = [DESKTOP_CONFIRM_DETAIL_PREFIX + asData(request.app)];
  if (request.title !== undefined && request.title !== "") lines.push(DESKTOP_CONFIRM_TITLE_PREFIX + asData(request.title));
  return {
    id: DESKTOP_CONFIRM_QUESTION_ID,
    header: DESKTOP_CONFIRM_HEADER,
    question: DESKTOP_CONFIRM_QUESTION,
    detail: lines.join("\n"),
    options: [{ label: DESKTOP_CONFIRM_APPROVE }, { label: DESKTOP_CONFIRM_DENY }],
  };
}

/** 明细里窗口标题那一行的固定前缀。 */
export const DESKTOP_CONFIRM_TITLE_PREFIX = "窗口标题：";

/**
 * 模型可控文本 → 可安全显示的**数据**。
 *
 * 折叠控制字符与**双向文本覆盖符**：后者能把一句话的显示顺序反过来（"exe.txt" 与
 * "txt.exe" 的视觉诡计），而这是一张「请点允许」的卡片，读错方向就是点错按钮。
 * 顺带折叠换行与空白，避免明细行数被模型控制。截断是最后一道：一张确认卡的正文
 * 不该由被确认方决定长度。
 */
function asData(value: string): string {
  const flat = value.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  return flat.length > DATA_MAX_CHARS ? flat.slice(0, DATA_MAX_CHARS) + "…" : flat;
}
