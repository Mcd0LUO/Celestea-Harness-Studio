// ============================================================================
// ui/taskpanel/store.ts — W1533 任务面板的**每会话状态层**（零 DOM、零请求）。
// ----------------------------------------------------------------------------
// 一份清单属于一个**会话视图容器**（SessionPane 对象），不是全局：切到别的会话就
// 该看到那个会话的清单。
//
// ★ 为什么键是**容器对象**而不是会话 id 字符串：`viewctx.adoptPane` 会把 LOCAL
//   容器**就地改名**（`local.id = id`，对象不变）。用字符串做键时，认领那一刻键就
//   与容器脱钩，清单会挂在旧 id 上再也画不出来。容器对象在认领/切会话/重建 DOM
//   的全过程中身份不变，用它做键天然免疫这一类改名 bug。
//
// 状态只由两条路写进来（都在 ./wire.ts）：
//   · live  —— SSE 的 tool_result 帧（update_tasks 的结果）；
//   · 恢复  —— 历史恢复时同一条 tool 行。
// 没有轮询、没有端点：清单是「已经发生过的事实」，不是需要反复问服务端的状态。
//
// ----------------------------------------------------------------------------
// W-reac（本次改造）：内部订阅机制换成 reactive 的 signal。
//
//   改造前：本模块自己维护 `listeners` + `emit`（**手写版依赖追踪**），订阅是
//   **全局**的 —— 任何容器变化都会通知**所有**订阅者，订阅者再自己 `panels.get(pane)`
//   判断「这条是不是我的」。容器多了就是 O(订阅者) 的无效唤醒。
//
//   改造后：**每个容器一个 signal**。`effectTasks(pane, cb)` 按容器精确订阅 ——
//   只有该容器变化时它才跑。行为与渲染时机完全不变（同一容器、同一时刻、同一回调），
//   变化的是「谁被唤醒」：从「所有人」收窄到「该容器的那一个」。
//
//   `onTasksChange` 保留为**兼容层**（既有调用方与测试在用全局语义），
//   新代码请用 `effectTasks` —— 调用方清零后这一层即可删除。
// ============================================================================

import type { SessionPane } from '../viewctx';
import { allPanes } from '../viewctx';
import { effect, signal, type ReadonlySignal, type Signal } from '../../reactive';
import { deltaOf, readTasks, sameTasks, snapshotOf, type TaskDelta, type TaskItem, type TaskSnapshot } from './model';

/** 容器 → 清单信号（值 null = 该容器还没有清单）。 */
const states = new Map<SessionPane, Signal<TaskSnapshot | null>>();

/** 容器 → 由 `effectTasks` 建立的注销器（`pruneTasks` 回收容器时一并注销）。 */
const paneDisposers = new Map<SessionPane, Set<() => void>>();

/** 取（必要时建立）某容器的清单信号。 */
function stateOf(pane: SessionPane): Signal<TaskSnapshot | null> {
  let s = states.get(pane);
  if (s === undefined) {
    s = signal<TaskSnapshot | null>(null);
    states.set(pane, s);
  }
  return s;
}

/** 兼容层：全局订阅者（任何容器变化都会收到）。 */
const listeners = new Set<(pane: SessionPane, snap: TaskSnapshot | null) => void>();

/**
 * 兼容层：**全局**订阅（任何容器的清单变化都会回调）。
 * 新代码请用 `effectTasks`（按容器精确订阅）。
 */
export function onTasksChange(cb: (pane: SessionPane, snap: TaskSnapshot | null) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * **按容器**订阅清单（signal 版）。回调在该容器建立时立刻跑一次（拿到当前值），
 * 此后仅在该容器的清单变化时重跑。返回注销器。
 *
 * ★ 回调抛错被隔离（只 warn）：一个容器的渲染回调坏掉，不该影响别的容器。
 */
export function effectTasks(pane: SessionPane, cb: (snap: TaskSnapshot | null) => void): () => void {
  const s = stateOf(pane);
  const dispose = effect(() => {
    try {
      cb(s.get());
    } catch (err) {
      console.warn('[taskpanel] tasks effect failed', err);
    }
  });
  const set = paneDisposers.get(pane) ?? new Set<() => void>();
  set.add(dispose);
  paneDisposers.set(pane, set);
  return () => {
    dispose();
    set.delete(dispose);
    if (set.size === 0) paneDisposers.delete(pane);
  };
}

/** 该容器的清单信号（只读；不创建条目）。诊断/测试用。 */
export function tasksSignalOf(pane: SessionPane): ReadonlySignal<TaskSnapshot | null> | null {
  return states.get(pane)?.readonly() ?? null;
}

/** 该会话容器的清单快照（null = 没有）。在 effect 内读 = 声明依赖。 */
export function tasksOf(pane: SessionPane): TaskSnapshot | null {
  return states.get(pane)?.get() ?? null;
}

/** 有**清单**的容器数（诊断/测试用）。注意不是 `states.size` —— 只有订阅、还没清单的容器不该计入。 */
export function taskPaneCount(): number {
  let n = 0;
  for (const s of states.values()) if (s.get() !== null) n += 1;
  return n;
}

/**
 * 丢掉**已经不在视图容器表里**的条目。
 * 容器被淘汰（evictIfNeeded）或会话被删除（dropPane）后，它的清单没有意义；
 * Map 持有强引用，不清理就会让被淘汰的容器永远无法回收（长会话下的堆泄漏）。
 * 每次容器变化/写入时跑一次，表最多 12 项，成本可忽略。
 *
 * ★ 与手写版的一处差异：这里**同时注销**该容器上的 effect。手写版的 listeners 是
 *   全局的（无 per-pane 资源）所以不用管；signal 版每个容器一个 effect，
 *   容器被淘汰却不注销就是一条真实泄漏。
 */
export function pruneTasks(): number {
  const live = new Set(allPanes());
  let dropped = 0;
  for (const pane of [...states.keys()]) {
    if (live.has(pane)) continue;
    states.delete(pane);
    for (const dispose of paneDisposers.get(pane) ?? []) dispose();
    paneDisposers.delete(pane);
    dropped += 1;
  }
  return dropped;
}

function emit(pane: SessionPane, snap: TaskSnapshot | null): void {
  for (const cb of [...listeners]) {
    try {
      cb(pane, snap);
    } catch (err) {
      console.warn('[taskpanel] listener failed', err);
    }
  }
}

/**
 * 写入一份清单（REPLACE 语义：传进来的是**全量**，不是补丁）。
 *
 * 返回本次的**结构差异**，渲染层据此选局部更新还是离屏重建（铁律 1/2）。
 * 与当前快照逐行相同 ⇒ 'same' 且**不通知** —— 重放的同一帧不该引起任何重画。
 * （signal 侧的等值去重在这里不生效，因为快照每次都是新对象；判据是 delta==='same'。）
 */
export function setTasks(pane: SessionPane, tasks: readonly TaskItem[]): TaskDelta {
  const prev = states.get(pane)?.get()?.tasks ?? [];
  const delta = deltaOf(prev, tasks);
  if (delta === 'same') return 'same';
  const snap = snapshotOf(tasks);
  stateOf(pane).set(snap); // 按容器精确驱动 effectTasks 的订阅者
  emit(pane, snap); // 兼容层：全局订阅者
  return delta;
}

/**
 * 从一条工具结果/工具参数的原始载荷里收下清单。
 * 形状不对（不是 update_tasks / 没有 tasks）⇒ 什么都不做，返回 false。
 */
export function noteTasksFrom(pane: SessionPane, payload: unknown): boolean {
  const tasks = readTasks(payload);
  if (tasks === null) return false;
  setTasks(pane, tasks);
  return true;
}

/** 清空一个容器的清单（会话被删除/容器被淘汰时调用）。 */
export function dropTasks(pane: SessionPane): void {
  const s = states.get(pane);
  if (s === undefined) return;
  states.delete(pane);
  s.set(null);
  emit(pane, null);
}

/** 全部清空（测试/诊断）。 */
export function resetTasks(): void {
  const panes = [...states.keys()];
  for (const pane of panes) {
    states.get(pane)?.set(null);
    for (const dispose of paneDisposers.get(pane) ?? []) dispose();
  }
  states.clear();
  paneDisposers.clear();
  for (const pane of panes) emit(pane, null);
}

/** 该容器此刻是否已经有清单（面板据此决定显隐，避免空态闪一下）。 */
export function hasTasks(pane: SessionPane): boolean {
  return (states.get(pane)?.get() ?? null) !== null;
}

/** 清单是否与给定的一份逐行相同（恢复路径的幂等判据，诊断用）。 */
export function isSameAs(pane: SessionPane, tasks: readonly TaskItem[]): boolean {
  return sameTasks(states.get(pane)?.get()?.tasks ?? [], tasks);
}
