/**
 * `@celestea/swarm` 的纯类型层与冻结常量（零依赖，零 I/O）。
 *
 * 为什么类型单独成层：scheduler / roster / result-xml 三块状态机都只靠这一层的
 * 形状通信，把它们抽出来才能让三块在没有运行时代码的情况下互相引用。
 *
 * **文案归属（本文件与 result-xml.ts 共同遵守）**：写入 `<agent_swarm_result>` 的
 * 文案（中止、超时、限流放弃…）面向**模型**而非人，不进 i18n 字典；面向人的同类信息
 * 走 Statusline 的 `swarm?` 可选字段与 zh/en 字典。理由：字典化会让这些常量横跨
 * 写 XML 的包与写字典的前端两个 write scope，而消费方是模型，收益为零。
 */

/** 任务来源种类。本仓只实现 `spawn`：不做 resume（无 resume_agent_ids，见 feature-agent-swarm §12 非目标）。 */
export type SwarmTaskKind = "spawn";

/** 一个子代理任务规格。`index` 全链一致：1 起始、顺序即 spec 顺序。 */
export interface SwarmTaskSpec {
  kind: SwarmTaskKind;
  /** 1-based 编号。结果落位与渲染顺序都以它为准，全链不得出现 0-based 混用（feature §6）。 */
  index: number;
  /** 填入 `{{item}}` 的原始 item 值（已 trim）。 */
  item: string;
  /** 展开后的完整 prompt。 */
  prompt: string;
}

/** 任务最终结果。 */
export type SwarmOutcome = "completed" | "failed" | "aborted";

/** 子代理是否真的启动过（与 outcome 正交：取消的成员也可能是 started）。 */
export type SwarmState = "started" | "not_started";

/** 单任务结果。渲染成 `<subagent>` 元素。 */
export interface SwarmTaskResult {
  spec: SwarmTaskSpec;
  outcome: SwarmOutcome;
  state?: SwarmState;
  /** provider 返回的截断原因（如 `max_tokens`）。 */
  stopReason?: string;
  /** outcome === "completed" 时的子代理最终文本。 */
  result?: string;
  /** outcome !== "completed" 时的错误文案。 */
  error?: string;
  agentId?: string;
}

// ───────────────────────── 校验 ─────────────────────────

export const SWARM_ERROR_CODES = {
  /**
   * 入参本身不是对象（undefined / null / 数组 / 原始值 / 函数）。
   *
   * 为什么单列一条而不是复用 ITEMS_TOO_FEW：那条码描述的是"数量不够"，
   * 它的 message 与 details 都会把调用方引去数条数；而入参压根不是对象时
   * 调用方要改的是**入参本身**，报"至少需要 2 条"是误导。
   * 放在表首——它是所有其它校验的前置条件（见 validate.ts 的入口防护）。
   */
  INVALID_INPUT: "INVALID_INPUT",
  /** items 少于 2（本仓无 resume 运行时分支，故没有豁免路径）。 */
  ITEMS_TOO_FEW: "ITEMS_TOO_FEW",
  /** 展开后成员总数超过 128。 */
  TOO_MANY_SUBAGENTS: "TOO_MANY_SUBAGENTS",
  /** 某个 item 元素 trim 后为空串：每条 item 必须含至少 1 个非空白字符。 */
  ITEM_EMPTY: "ITEM_EMPTY",
  /** 某个 item 元素不是字符串：不做隐式强转，避免 123/null 被静默当成 item 派发。 */
  ITEM_NOT_STRING: "ITEM_NOT_STRING",
  /** 提供了 items 却没有 prompt_template。 */
  PROMPT_TEMPLATE_REQUIRED: "PROMPT_TEMPLATE_REQUIRED",
  /** prompt_template 不含 `{{item}}` 占位符。 */
  PROMPT_TEMPLATE_PLACEHOLDER_MISSING: "PROMPT_TEMPLATE_PLACEHOLDER_MISSING",
  /** 两个 item 展开出完全相同的 prompt。 */
  DUPLICATE_PROMPTS: "DUPLICATE_PROMPTS",
  /**
   * 同一轮回复里 `agent_swarm` 不是唯一的工具调用。
   *
   * **落点在 tool.ts，不在调度器**（feature §3.3 已拍板"工具内自检"）：排他判定是
   * 本轮工具调用的属性，调度器只看见已展开的 specs，看不见同轮的其它调用。
   * 本仓不做 resume / fork 上下文（§12），故没有 MODEL_* / FORK_* / DELEGATION_* 这些码。
   */
  NOT_EXCLUSIVE: "NOT_EXCLUSIVE",
} as const;

export type SwarmErrorCode = (typeof SWARM_ERROR_CODES)[keyof typeof SWARM_ERROR_CODES];

/** 结构化校验错误：错误码 + 人可读 message + 可选机器可读 details。失败是结果不是异常（feature §3.2）。 */
export interface SwarmValidationError {
  code: SwarmErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** 工具入参。 */
export interface SwarmRequestInput {
  /** 整个 swarm 的简短描述（模型提供）。 */
  description?: string;
  /** 含 `{{item}}` 的 prompt 模板。 */
  promptTemplate?: string;
  /** 每个元素展开一个子代理。 */
  items?: readonly string[];
  /**
   * 可选的整批 LLM 路由：`LlmRegistry` 的注册名（feature §5.2）。
   * 解析落点在 executor 侧，**不搬**上游的白名单匹配：本仓没有子代理白名单概念。
   */
  model?: string;
}

// ───────────────────────── 常量 ─────────────────────────

/** 成员总数硬上限。 */
export const SWARM_MAX_SUBAGENTS = 128;
/** 最小 items 数：swarm 的定义就是"一批"，单发是 spawn_worker 的活（feature §2）。 */
export const SWARM_MIN_ITEMS = 2;
/** 模板占位符字面量。 */
export const SWARM_PROMPT_PLACEHOLDER = "{{item}}";

// ───────────────────────── 调度器 ─────────────────────────

/**
 * 调度器可调参数。默认值的依据见 feature-agent-swarm §4。
 *
 * 退避的**抖动**不在这里配置：随机源是环境依赖不是策略参数，故放在
 * `SwarmSchedulerDeps.randomFn`（见下），使测试可注入确定性随机。
 */
export interface SwarmSchedulerConfig {
  /** 正常模式无间隔连发个数（"首波"）。 */
  initialLaunchLimit: number;
  /** 首波之后每个任务的放量间隔。 */
  initialLaunchIntervalMs: number;
  /** 限流退避基数（毫秒）。 */
  retryBaseMs: number;
  /** 退避指数因子。 */
  retryFactor: number;
  /** 两次容量收缩之间的最小间隔（防抖）。 */
  capacityShrinkDebounceMs: number;
  /** 容量恢复的检查间隔。 */
  capacityRecoveryIntervalMs: number;
  /**
   * 硬并发上限。**缺省 16**（不是 undefined=无上限）。
   *
   * 为什么本仓必须默认有限：本仓没有宿主派发池兜底，这道闸门是并发失控的唯一防线；
   * "undefined = 无上限"在有宿主池的源仓成立，搬过来就是没有防线的同形。
   * 给定值必须是 >= 1 的整数，由构造期校验把关（0 会让 `active.size >= 0` 恒真 = 静默不放量）。
   */
  maxConcurrency: number;
  /**
   * 单任务超时（毫秒）。**0 = 禁用**（显式定义，消解上游 D8 的"undefined 还是 0"歧义）。
   * 调度器超时闸门 abort 的是**成员信号**，与用户中断共用同一条取消通道。
   */
  timeoutMs: number;
  /**
   * 单成员限流重试上限：**与"是否唯一未完成"无关**的第二重判死阈值。
   *
   * 为什么需要它：只认"只剩它一个未完成且 retryCount>=1"时，>=2 个成员**同时**持续限流
   * 会让该条件恒不成立，而退避分支没有上限 ⇒ 批次被无限重排队，批次 Promise 永不 resolve。
   * 给上限后这条路必然落定，且它是 per-task 的，不会因为某个成员限流就连坐拖死整批。
   *
   * **缺省 3**（本仓默认开启；源仓为 undefined 保持向后兼容）。
   * 给定值必须是 >= 1 的整数。
   */
  maxRateLimitRetries: number;
}

export const DEFAULT_SWARM_SCHEDULER_CONFIG: SwarmSchedulerConfig = {
  initialLaunchLimit: 5,
  initialLaunchIntervalMs: 700,
  retryBaseMs: 3000,
  retryFactor: 2,
  capacityShrinkDebounceMs: 2000,
  capacityRecoveryIntervalMs: 180_000,
  maxConcurrency: 16,
  timeoutMs: 7_200_000,
  maxRateLimitRetries: 3,
};

/**
 * 容量恢复**无上界**：每 recoveryIntervalMs 加 1，加到当前并发数为止。
 *
 * 为什么没有 ceiling：一次短暂抖动把容量永久锁在低位后，批次会以远低于宿主上限的速度跑完，
 * 且没有任何事件能把它抬回去——上限会把一次抖动固化成永久惩罚。源仓决策笔记已论证同一条。
 */

/** 单次尝试的成功返回。 */
export interface SwarmAttemptResult {
  /** 子代理最终文本。 */
  result?: string;
  /** provider 返回的截断原因。 */
  stopReason?: string;
}

/** 注入给执行函数的单次尝试上下文。 */
export interface SwarmAttemptContext {
  /** 第几次尝试（1-based）。 */
  readonly attempt: number;
  readonly signal: AbortSignal;
  /**
   * 执行函数在「子代理已向 provider 发出首个请求」时调用。
   * 语义用途：结果里的 `state`（started/not_started）判定，以及批次中断时对未 ready 成员的放弃路径。
   */
  markReady(): void;
  /** 记录本次尝试拿到的 agentId（成功或失败都可调用）。 */
  setAgentId(agentId: string): void;
  /** 上一次尝试拿到的 agentId（仅在本任务因限流被重排队后存在）。 */
  readonly previousAgentId?: string;
}

/** 执行函数：跑一个 spec。限流通过 reject 抛出，由 isRateLimitError 判定。 */
export interface SwarmExecutor {
  run(spec: SwarmTaskSpec, context: SwarmAttemptContext): Promise<SwarmAttemptResult>;
}

/** 定时器句柄。真实实现为 NodeJS.Timeout，测试为 vitest fake timer 返回值。 */
export type SwarmTimerHandle = unknown;

/** 调度器全部外部依赖（时钟、定时器、执行、限流判定、批次信号、随机源）。 */
export interface SwarmSchedulerDeps {
  /** 单调时钟，毫秒。 */
  now(): number;
  setTimeout(handler: () => void, ms: number): SwarmTimerHandle;
  clearTimeout(handle: SwarmTimerHandle): void;
  /** 执行函数。 */
  executor: SwarmExecutor;
  /** 限流判定门：true 表示该错误应重排队而非判终态 failed。 */
  isRateLimitError(error: unknown): boolean;
  /**
   * 退避抖动的随机源，取值 [0,1)。缺省 Math.random。
   *
   * 放 deps 而非 config：随机源是**环境依赖**不是策略参数。它必须可注入，
   * 否则 jitter 的断言只能写成区间 flaky 测试（铁律 2 要求断言真的能红）。
   */
  randomFn?(): number;
  /** 任务被限流挂起（重排队）时的回调。 */
  onSuspended?(event: SwarmSuspendedEvent): void;
  /** 任务被放弃（死锁防护 / 批次取消）时的回调。 */
  onAbandoned?(event: SwarmAbandonedEvent): void;
  /** 批次级中断信号。 */
  signal?: AbortSignal;
}

/** 一次限流挂起事件。 */
export interface SwarmSuspendedEvent {
  spec: SwarmTaskSpec;
  agentId?: string;
  reason: string;
  /** 该任务因限流被重排队的累计次数（1 = 第一次）。 */
  retryCount: number;
  /** 本次计算出的重试延迟（毫秒，**已含 jitter**）。 */
  retryDelayMs: number;
  /** 最早可重试的时刻（`deps.now()` 坐标系）。 */
  retryReadyAt: number;
}

/** 一次任务放弃事件。 */
export interface SwarmAbandonedEvent {
  spec: SwarmTaskSpec;
  agentId?: string;
  outcome: "failed" | "cancelled";
  error: string;
}

/**
 * 成员快照（调度器对外暴露的进度读数）。
 *
 * `ready` 与 `state` 正交：ready 只表示"已向 provider 发出过请求"，
 * 跨重试保留；state 表示"本批次内是否真的启动过"，结果是启动过的成员被取消时仍是 started。
 */
export interface SwarmSchedulerSnapshot {
  config: SwarmSchedulerConfig;
  results: readonly SwarmTaskResult[];
  done: number;
  total: number;
  /** 批次是否已收尾（settled 与 finished 同义，两个名字都给，兼容两种读法）。 */
  readonly settled: boolean;
  readonly finished: boolean;
  readonly failed: boolean;
  /** 批次是否真的跑起来过（曾 markReady 或曾拿到 agentId），跨重试保留。 */
  readonly started: boolean;
  // ── 以下是限流态的扁平读数 ──
  // 为什么与上面的调度态并成**一个**扁平对象而不是分两个 snapshot()：容量收缩、容量恢复、
  // 唤醒保活这几类行为只能通过「下一次何时放量」观察，宿主与测试必须在**同一次读数**里
  // 同时看到 pendingCount / activeCount 与 rateLimitCapacity——分两个方法就会出现
  // 「读了容量、期间批次变了」这种撕裂读数，断言会变成 flaky。
  readonly rateLimitMode: boolean;
  readonly rateLimitCapacity: number;
  readonly globalRetryIntervalMs: number;
  readonly nextRateLimitLaunchAt: number;
  /** 正常模式下已成功启动过的成员数（进入限流时的容量起点）。 */
  readonly startedSuccessCount: number;
  /** 已发出请求但未落定的成员数。 */
  readonly activeCount: number;
  /** 仍在队列里的成员数。 */
  readonly pendingCount: number;
}

