// ============================================================================
// SSE client — typed wrappers around the /api/events stream.
// Event names preserved: status/text/thinking/tool/tool_result/done.
// 责任边界：仅解析/分发事件，不做状态归并（归并在 chat.ts）。
// Each event: {"turn":N,"seq":M,"payload":{...}, ...}
// ============================================================================
import type {
  CompactPayload,
  ConnState,
  DonePayload,
  QuestionPayload,
  SseEnvelope,
  SseEventName,
  StatusPayload,
  TextPayload,
  ThinkingPayload,
  ToolPayload,
  ToolResultPayload,
} from './types';
import type { TerminalFrame } from './types/terminal'; // W1528：真终端输出帧

export interface SseHandlerMap {
  status: (p: StatusPayload) => void;
  text: (p: TextPayload) => void;
  thinking: (p: ThinkingPayload) => void;
  tool: (p: ToolPayload) => void;
  tool_result: (p: ToolResultPayload) => void;
  done: (p: DonePayload) => void;
  compact: (p: CompactPayload) => void;
  /**
   * W784：模型向用户提问（挂起等待作答）。信封的 turn = 挂起那个 turn 的会话
   * 本地序号；payload 带 id/questions/expires_at/timeout_ms。
   */
  question: (p: QuestionPayload) => void;
  /**
   * W1528：工作台终端的 pty 字节。**唯一的非轮次事件** —— 它由服务端的终端
   * handler 发出，与 turn 无关（信封 turn 恒为 0），载荷是 {id, session, data}，
   * data 是不透明的终端输出。
   */
  terminal: (p: TerminalFrame) => void;
}

export type SseHandler<K extends SseEventName> = SseHandlerMap[K];

/**
 * W263: the envelope carries the turn/seq framing while the payload carries the
 * event body ({"turn":N,"seq":M,"payload":{...}}).
 * W514: the envelope may also carry {v:2, session} — merged in as well so every
 * handler can route the frame to the right session view (absent = legacy). Handlers read fields off ONE
 * flat object (chat.ts reads p.turn / p.phase / p.delta), so merge the envelope
 * fields into the payload WITHOUT dropping any payload field. Non-object
 * payloads (defensive) are passed through untouched.
 */
function withEnvelope(payload: unknown, env: SseEnvelope): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const out = { ...(payload as Record<string, unknown>) };
  if (env.turn !== undefined && out.turn === undefined) out.turn = env.turn;
  if (env.seq !== undefined) out.seq = env.seq;
  // W514：信封 v2 的会话路由字段（旧后端缺省 → 前端回落单会话行为）
  if (env.v !== undefined) out.v = env.v;
  if (env.session !== undefined && env.session !== null && out.session === undefined) {
    out.session = env.session;
  }
  return out;
}

/**
 * W1479: exactly the names the server can emit (`SSE_EVENT_NAMES` in
 * `@celestea/core`, frozen in `contracts/sse-events.json`). `context` and
 * `inbox` were listed here but are unemittable — the server's bus asserts the
 * contract list on every emit — so those subscriptions could never fire while
 * looking wired. A gate (`tools/check-sse-events.mjs`) keeps this list honest.
 */
const EVENT_NAMES: readonly SseEventName[] = [
  'status',
  'text',
  'thinking',
  'tool',
  'tool_result',
  'done',
  'compact',
  'question',
  // W1528：工作台终端的 pty 字节（契约第 10 个名字；唯一的非轮次事件）。
  'terminal',
];

export class SseClient {
  private es: EventSource | null = null;
  private handlers = new Map<SseEventName, Set<(p: unknown) => void>>();
  private connCbs = new Set<(state: ConnState) => void>();
  /**
   * ★ W9315（F1-01 P1）：**信封观察者** —— 每条到达本连接的信封各调一次。
   *
   * 为什么必须是「信封级」而不是「事件处理器级」：契约的 seq 是**进程级单调计数器**
   * （apps/studio/src/sse.ts 的 emit：seq++，与事件名、与订阅者都无关），所以
   * **任何**事件名都会推进它。而 [emit] 对「没有注册处理器」的名字直接 early-return
   * —— 在处理器层观察，terminal（本仓的接线层根本不为它注册处理器）的 seq 就永远
   * 看不见，基线不前进，下一条真实帧必被算成「丢了 N 帧」。
   *
   * 真实危害（探针 + 真机 CDP 复现，results/audit4/F1/evidence-seqgap-cdp.md）：一条
   * 完整无丢失的流，夹一个 question 帧就显示「连接中断，丢失了 1 帧输出」，夹三个
   * terminal 帧就显示「丢失了 3 帧」——数字随旁路帧数线性放大。ask_user_question
   * 是常驻工具、终端每批 pty 字节一帧，所以这是**每一轮**都会命中的可见面。
   *
   * 位置（withEnvelope 之后、事件分发之前）：既保证 seq 已并进载荷顶层（观测者与
   * 处理器读同一份对象），又保证**没有任何处理器的事件名也会被看到**。
   */
  private envelopeCbs = new Set<(p: unknown, name: SseEventName) => void>();

  constructor(readonly url = '/api/events') {}

  on<K extends SseEventName>(name: K, handler: SseHandler<K>): void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler as (p: unknown) => void);
  }

  onConn(cb: (state: ConnState) => void): void {
    this.connCbs.add(cb);
  }

  /**
   * ★ W9315（F1-01）：订阅「每条信封」。回调在 withEnvelope 之后、事件分发之前被调用，
   * 因此载荷顶层已带 seq；且**没有注册处理器的事件名同样会触发**（这正是 terminal）。
   *
   * 唯一消费者是 ui/sse-wire.ts 的丢帧检测（SeqGapWatcher）。它必须挂在这里而不是
   * 各事件的处理器里：seq 是进程级全局计数器，按事件名挑着看就会漏看，而漏看的那些
   * 帧照样推进了计数器 ⇒ 下一条被看到的帧必被误判为「丢了 N 帧」。
   */
  onEnvelope(cb: (p: unknown, name: SseEventName) => void): void {
    this.envelopeCbs.add(cb);
  }

  connect(): void {
    this.close();
    const es = new EventSource(this.url);
    this.es = es;
    es.onopen = () => this.emitConn('online');
    es.onerror = () => this.emitConn('down');
    for (const name of EVENT_NAMES) {
      es.addEventListener(name, (e: MessageEvent<string>) => {
        try {
          const env = JSON.parse(e.data) as SseEnvelope;
          // ★ W9315（F1-01）：只 withEnvelope 一次，观测者与处理器读**同一个**载荷对象
          // （读两份就可能读到不同的 seq，丢帧检测的基线就成了薛定谔的）。
          const payload = withEnvelope(env.payload !== undefined ? env.payload : env, env);
          // 观察者在分发之前：无处理器的事件名（terminal）也要被看到。
          this.emitEnvelope(name, payload);
          this.emit(name, payload);
        } catch (err) {
          console.warn('[sse] failed to parse', name, err);
        }
      });
    }
  }

  close(): void {
    if (this.es) {
      this.es.close();
      this.es = null;
    }
  }

  /**
   * ★ W9315（F1-01）：把每条信封交给观察者。**刻意排在 [emit] 之前** —— emit 对没有
   * 处理器的名字会 early-return，而那些帧的 seq 同样推进了全局计数器，必须照样被看到。
   *
   * 观察者抛错不得影响事件分发：丢帧检测坏掉时，聊天流本身必须照常工作。
   */
  private emitEnvelope(name: SseEventName, payload: unknown): void {
    for (const cb of this.envelopeCbs) {
      try {
        cb(payload, name);
      } catch (err) {
        console.warn('[sse] envelope hook failed for', name, err);
      }
    }
  }

  private emit(name: SseEventName, payload: unknown): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const h of set) {
      try {
        (h as (p: unknown) => void)(payload);
      } catch (err) {
        console.warn('[sse] handler failed for', name, err);
      }
    }
  }

  private emitConn(state: ConnState): void {
    for (const cb of this.connCbs) {
      try {
        cb(state);
      } catch {
        /* ignore listener errors */
      }
    }
  }
}
