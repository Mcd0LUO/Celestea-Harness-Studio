// ============================================================================
// reactive/signal.ts — 细粒度响应式原语（signal / computed / effect / batch）
// ----------------------------------------------------------------------------
// 为什么有这个模块（而不是引入 React/Preact/Solid）：
//   本仓前端的更新模式是「状态变化 → 手动调用纯写入函数改对应 DOM」（见
//   statusline/ring.ts 的「纯写入函数」、taskpanel/{store,wire,panel}.ts 三件套）。
//   这套模式性能最好（精确更新、零 reconcile），但**连线是手工的**：新增一个
//   字段就要在 wire 里多写一行「谁变了通知谁」，漏一处就是「界面不更新」。
//
//   框架提供的开发体验核心只有两条：① 状态自动追踪依赖；② 依赖变化自动重跑。
//   而**它不需要 vdom**（vdom = 全树 diff，与本仓「精确更新」取向相反）。
//   本模块只实现这两条 —— 依赖追踪 + 定向重跑 —— 零运行时依赖、零 reconcile。
//
// 与既有纪律的关系（必须遵守，否则等于绕过护栏）：
//   · 前端铁律 1「禁先清空后加载」：effect 里仍然走离屏构建 + 单次替换，
//     本模块不提供任何「清空容器」的便利函数。
//   · effect 是**同步**执行的（可预测优先）：set() 立即跑受影响的 effect，
//     不引入微任务时序。需要合并多次写入时用 batch(fn)。
//
// ----------------------------------------------------------------------------
// 健壮性契约（四道闸，都有测试 + 变异负控制）：
//
//   ① **自触发保护**：运行中的 effect 再次被调度会被丢弃并 warn，绝不嵌套重入自己。
//   ② **循环深度保护**：effect 链相互触发（A→B→A）会在嵌套到 MAX_DEPTH 时停住并
//      warn，不会无限递归到栈溢出。正常的多级更新深度 < 10，阈值取 100。
//   ③ **抛错隔离**：一个 effect 抛错只 warn（带 err 对象），既不打断同批其它 effect，
//      也不把异常抛回 set() 的调用方 —— 与 ui/hint/registry.ts 的既有取舍一致。
//   ④ **清理钩子**：`onCleanup(fn)` 注册的清理函数在该 effect **重跑前**与**注销时**
//      各跑一次（隔离抛错）。effect 里挂监听器/定时器时不写它，就会在每次重跑时叠加。
//
// 读值有两个入口，绝不是同一个：
//   · `get()`    —— 在 effect 内读 = **声明依赖**（推荐，也是默认意图）；
//   · `peek()`   —— 读值但**不**建立依赖（需要「我只想看一眼，不想被它唤醒」时用）。
//   用错这两个是本模块最容易踩的坑，所以它俩在类型上同样是显式方法名，没有歧义。
// ============================================================================

/** 只读信号（下游消费方视图）。 */
export interface ReadonlySignal<T> {
  /** 读值。在 effect 内读 = **声明依赖**。 */
  get(): T;
  /** 读值**但不**建立依赖（「看一眼，但别因为它的变化唤醒我」）。 */
  peek(): T;
}

/** 可读写信号。 */
export interface Signal<T> extends ReadonlySignal<T> {
  /** 写值。同值（Object.is）不触发任何 effect。 */
  set(value: T): void;
  /** 只读视图（供下游消费，防止误写）。 */
  readonly(): ReadonlySignal<T>;
}

/** 一个 effect 实体。 */
interface EffectNode {
  run: () => void;
  /** 本 effect 依赖的所有订阅源（用于定向清理）。 */
  deps: Set<Source>;
  /** onCleanup 注册的清理函数（重跑前 / 注销时执行）。 */
  cleanups: Set<() => void>;
  /** 已注销（注销后不再被调度）。 */
  disposed: boolean;
}

/** 依赖源：一个「有订阅者的集合」。signal 与 computed 共用这个形状。 */
type Source = Set<EffectNode>;

/** 当前正在收集依赖的 effect。 */
let active: EffectNode | null = null;

/** 正在执行的 effect（自触发保护用）。 */
const running = new Set<EffectNode>();

/** 当前 invoke 嵌套深度（循环保护用）。 */
let depth = 0;

/** 嵌套深度上限。正常多级更新 < 10；超过即为互相触发的环。 */
const MAX_DEPTH = 100;

/** batch 深度（>0 时所有调度进入 pending）。 */
let batchDepth = 0;

/** batch 期间待执行的 effect（Set 天然去重：同一 effect 一轮只跑一次）。 */
let pending: Set<EffectNode> = new Set();

/** 在 effect 内把一个订阅源登记为依赖。 */
function track(source: Source): void {
  if (!active) return;
  source.add(active);
  active.deps.add(source);
}

/** 调度一个 effect：batch 中入队，否则同步跑。 */
function schedule(node: EffectNode): void {
  if (node.disposed) return;
  if (batchDepth > 0) {
    pending.add(node);
    return;
  }
  invoke(node);
}

/** 执行并清空一个 effect 的清理函数（抛错隔离：一个坏清理不该拖垮其余的）。 */
function runCleanups(node: EffectNode): void {
  if (node.cleanups.size === 0) return;
  const fns = [...node.cleanups];
  node.cleanups.clear();
  for (const fn of fns) {
    try {
      fn();
    } catch (err) {
      console.warn('[reactive] cleanup threw', err);
    }
  }
}

/** 真正执行一个 effect（四道闸都在这里）。 */
function invoke(node: EffectNode): void {
  if (node.disposed) return;

  // 闸① 自触发保护：同一 effect 正在运行 → 丢弃本次调度。
  if (running.has(node)) {
    console.warn('[reactive] effect re-entered itself; dropped the re-run (use batch() to merge writes)');
    return;
  }
  // 闸② 循环深度保护：effect 链互相触发时在这里停住，而不是栈溢出。
  if (depth >= MAX_DEPTH) {
    console.warn('[reactive] effect chain exceeded depth ' + MAX_DEPTH + ' (possible cycle); dropped the run');
    return;
  }

  runCleanups(node);

  // 重收集依赖：先解绑旧依赖，跑完再绑新的。
  for (const d of node.deps) d.delete(node);
  node.deps.clear();

  const prev = active;
  active = node;
  running.add(node);
  depth += 1;
  try {
    node.run();
  } catch (err) {
    // 闸③ 抛错隔离：不让一个坏 effect 打断同批其它 effect，也不抛回 set()。
    console.warn('[reactive] effect threw', err);
  } finally {
    depth -= 1;
    running.delete(node);
    active = prev;
  }
}

/**
 * 创建一个可写信号。
 *
 * ★ 等值写入（Object.is）不触发 effect —— 这是「状态没变就别动 DOM」的第一道闸门，
 *   与流式渲染「同一内容不重排」的既有取向一致。
 */
export function signal<T>(initial: T): Signal<T> {
  let value = initial;
  const subs: Source = new Set();

  const self: Signal<T> = {
    get(): T {
      track(subs);
      return value;
    },
    peek(): T {
      return value;
    },
    set(next: T): void {
      if (Object.is(value, next)) return;
      value = next;
      // 快照后再遍历：effect 里可能注销别的 effect，改变集合。
      for (const node of [...subs]) schedule(node);
    },
    readonly(): ReadonlySignal<T> {
      return {
        get: () => self.get(),
        peek: () => value,
      };
    },
  };
  return self;
}

/**
 * 派生信号：值由上游信号算出，上游变化时自动重算并向下游传播。
 *
 * 实现是惰性启动：**第一次 get() 时才建立订阅**（此前不占用任何订阅关系）。
 * 这与「面板先渲染、再连线」的既有顺序一致。
 */
export function computed<T>(fn: () => T): ReadonlySignal<T> {
  // 初值只用 `undefined` 占位（首次 get 前无人读它），故这里的断言是有意为之。
  const out = signal<T>(undefined as unknown as T);
  let started = false;
  return {
    get(): T {
      if (!started) {
        started = true;
        effect(() => {
          out.set(fn());
        });
      }
      return out.get();
    },
    peek(): T {
      return out.peek();
    },
  };
}

/**
 * 注册一个副作用：立即执行一次以**收集依赖**，此后仅在依赖变化时重跑。
 * 返回值是注销器（对齐本仓 `register(...) -> dispose` 的既有形状）。
 *
 * 首次执行若抛错，会被闸③ 隔离（warn）—— 依赖收集可能只完成一部分，但**不会**
 * 把异常抛给调用方（装配点不该因为一个面板坏掉而整体中断，见 wire.ts 同类先例）。
 */
export function effect(fn: () => void): () => void {
  const node: EffectNode = {
    run: fn,
    deps: new Set(),
    cleanups: new Set(),
    disposed: false,
  };
  invoke(node);
  return () => {
    if (node.disposed) return;
    node.disposed = true;
    runCleanups(node);
    for (const d of node.deps) d.delete(node);
    node.deps.clear();
  };
}

/**
 * 批量更新：把 fn 内所有 set() 触发的 effect 合并，结束时各跑一次。
 *
 * 为什么需要它：同步 effect 的默认语义是「一次 set 一次重跑」。一次用户动作
 * 里若改动 N 个信号（例如「切换会话」同时改标题/消息数/权限档位），不 batch
 * 就会跑 N 次。batch 把「一次动作」还原成「一次重排」。
 * fn 抛错时 pending 仍会被消费（finally），不会把队列卡住。
 */
export function batch(fn: () => void): void {
  batchDepth += 1;
  try {
    fn();
  } catch (err) {
    console.warn('[reactive] batch callback threw', err);
  } finally {
    batchDepth -= 1;
    if (batchDepth === 0) {
      const queued = pending;
      pending = new Set();
      for (const node of queued) invoke(node);
    }
  }
}

/**
 * 在 fn 内**不**收集依赖（读多少 signal 都不会让当前 effect 依赖它们）。
 * 用于「取一个值做判断/记日志，但它的变化不该唤醒我」。
 */
export function untrack<T>(fn: () => T): T {
  const prev = active;
  active = null;
  try {
    return fn();
  } finally {
    active = prev;
  }
}

/**
 * 注册清理函数：本 effect **重跑前**与**注销时**各执行一次。
 *
 * 必须在 effect 内调用 —— 在 effect 外调用无从归属，只 warn 不登记（绝不静默挂到
 * 别人身上）。用途：effect 里挂的监听器/定时器/订阅，必须在重跑前撤掉，
 * 否则每次重跑都会叠加一份。
 */
export function onCleanup(fn: () => void): void {
  if (!active) {
    console.warn('[reactive] onCleanup() called outside of an effect; ignored');
    return;
  }
  active.cleanups.add(fn);
}
