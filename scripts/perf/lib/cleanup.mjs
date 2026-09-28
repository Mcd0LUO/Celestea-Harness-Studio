// ============================================================================
// scripts/perf/lib/cleanup.mjs — 进程收尾登记：**无论怎么退出**都不留 Chrome 与端口
// ----------------------------------------------------------------------------
// 为什么需要它（W2021 实测）：Node 的 SIGTERM/SIGINT 默认行为是**立即退出** ——
// `finally` 不跑、`process.on('exit')` 也不跑。于是 `timeout 115 node scripts/perf/run.mjs q1`
// 或 Ctrl-C 之后：
//   · backend 的监听端口随进程消失（OS 回收监听套接字），**但**
//   · Chrome 是 spawn 出来的**独立进程**，被 init 收养后继续活着，继续占着 CDP 端口与
//     $TEMP 下的 profile 目录（修复前实测：kill 后 9433 仍被 chrome-headless 占着，
//     /tmp/w9111-chrome-* 只增不减）。
// 下一次测量就撞在 `listen EADDRINUSE` / CDP 连不上，而报错指向 node:net，看不出根因。
//
// 设计（对应 W2021 报告 §2 的四问）：
//   ① 信号处理器里**不能 await**：`process.on('SIGTERM', fn)` 丢弃 `fn` 的返回值，写成
//      `async` 也没人等它。所以**关键动作必须同步完成** —— `child.kill()` 与
//      `server.close()`（Node 的 `server.close()` **同步**释放监听端口，回调只等存量连接）。
//      本模块同步 drain 登记表，再把它们的 Promise 交给一次**有上限**的等待（见
//      FORCE_EXIT_MS），上限到了就退出 ⇒ 既不无限等，也不丢同步部分。
//   ② 多实例：每个实例 `registerCleanup()` 进集合、`close()` 出集合 ⇒ 信号到达时集合里
//      恰好是「还活着」的那些（0/1/2 个都对），既不漏也不重复关。
//   ③ 幂等：drain 取快照后**先清空再调用** ⇒ 同一个收尾函数至多被调一次；实例自己的
//      `close()` 另有「已在关闭」标志兜底，重复调用返回同一个 Promise（不抛错）。
//   ④ 不改变测量语义：**没登记任何实例时不安装信号处理器**（登记表空了就摘掉）—— 正常
//      路径（跑完 → 各 case 的 finally 关掉 → 登记表空）与改动前逐字同形，不打印、不占句柄。
// ============================================================================
import { constants } from 'node:os';

/** 要接管的信号。两个都是「正常请求退出」语义，不接 SIGKILL（接不了）。 */
export const CLEANUP_SIGNALS = ['SIGTERM', 'SIGINT'];

/** 收尾等待上限：到点就退出（宁可少删一个 profile 目录，也不能让进程挂住）。 */
export const FORCE_EXIT_MS = 2000;

/** 还活着的实例的收尾函数（Set 按身份去重 ⇒ 同一实例不会被登记两次）。 */
const registry = new Set();

/** 已安装的监听器；null = 当前没有安装（登记表为空时不占信号）。 */
let installed = null;

/** 是否已经在收尾（第二次信号 = 不再等，立即退出）。 */
let draining = false;

/**
 * 信号 → 退出码：`128 + signum`，与 shell 的 `timeout` / `$?` 口径一致
 * （SIGTERM → 143、SIGINT → 130）。查不到的信号给 1（不编造 0：0 会被当成成功）。
 */
export function exitCodeFor(signal) {
  const n = constants.signals[signal];
  return typeof n === 'number' ? 128 + n : 1;
}

/** 登记表当前条目数（门禁用：证明「不漏也不重复关」的边界）。 */
export function activeCleanupCount() {
  return registry.size;
}

/** 信号收尾是否已挂上（门禁用：未登记实例时必须是 false，否则正常路径被动了手脚）。 */
export function isSignalCleanupInstalled() {
  return installed !== null;
}

function uninstallSignalCleanup() {
  if (installed === null) return;
  for (const [signal, listener] of installed.listeners) process.removeListener(signal, listener);
  installed = null;
}

function ensureSignalCleanup() {
  if (installed !== null) return;
  const listeners = [];
  for (const signal of CLEANUP_SIGNALS) {
    const listener = () => handleSignal(signal);
    process.on(signal, listener);
    listeners.push([signal, listener]);
  }
  installed = { listeners };
}

/**
 * 信号路径：**同步**跑完所有收尾（kill Chrome / close 监听），再**有上限地**等它们的
 * Promise，然后以 128+n 退出。第二次信号不再等（此时监听器通常已随登记表清空被摘掉，
 * 默认行为就是立即终止 —— 这条是双保险）。
 */
export function handleSignal(signal) {
  const code = exitCodeFor(signal);
  if (draining) {
    process.exit(code);
    return;
  }
  draining = true;
  try { process.stderr.write('[perf] 收到 ' + signal + '：正在收尾（Chrome / 端口 / profile）…\n'); } catch { /* stderr 关了也要收尾 */ }
  const pending = drainCleanup();
  const deadline = new Promise((resolve) => setTimeout(resolve, FORCE_EXIT_MS));
  Promise.race([Promise.all(pending), deadline]).then(
    () => process.exit(code),
    () => process.exit(code),
  );
}

/**
 * 登记一个收尾函数（返回「注销」函数）。首次登记时**才**安装信号处理器；
 * 登记表清空时把它摘掉 —— 没有活实例的进程不该被这个模块改变信号语义。
 *
 * ★ 约定：收尾函数必须在**第一个 await 之前**做完关键动作（信号路径不 await 它的前半段）。
 */
export function registerCleanup(fn) {
  registry.add(fn);
  ensureSignalCleanup();
  return () => { registry.delete(fn); maybeUninstall(); };
}

/**
 * ★ W2027：登记一个收尾，**并在它跑完后自动注销**（返回「手动注销」函数）。
 *
 * 为什么不能直接用 `registerCleanup(() => close().then(unregister))` 表达同一件事：
 * 那样写会**派生一个新 Promise**（close() 本身是「同步 kill + 异步尾巴（等 300ms +
 * 删 profile）」）。信号路径把登记表里每条收尾的返回值纳入等待，派生出来的那个比
 * close() 本身晚一个微任务 settle —— 正常路径无所谓，但它是白白多出来的一跳。
 * 这里在 `finally` 里注销：语义相同、不派生新 Promise。
 *
 * 幂等：注销函数可重复调用（Set.delete 本来就幂等）。
 */
export function adoptCleanup(fn) {
  let unregister = null;
  const run = () => {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return Promise.resolve(result).finally(() => { if (unregister !== null) unregister(); });
    }
    if (unregister !== null) unregister();
    return result;
  };
  unregister = registerCleanup(run);
  return unregister;
}

function maybeUninstall() {
  if (registry.size === 0) uninstallSignalCleanup();
}

/**
 * **同步**调用并清空登记表；返回它们返回的 Promise（已吞掉拒绝，交给调用方按需 await）。
 * 先清空再调用 ⇒ 重入/重复 drain 都不会把同一个收尾函数再跑一遍。
 */
export function drainCleanup() {
  const pending = [];
  for (const fn of [...registry]) {
    registry.delete(fn);
    try {
      const result = fn();
      if (result && typeof result.then === 'function') pending.push(Promise.resolve(result).catch(() => {}));
    } catch { /* 收尾失败不掩盖原始退出原因 */ }
  }
  maybeUninstall();
  return pending;
}

/** 正常路径用：等所有登记过的收尾跑完（信号路径不走这里，见 handleSignal）。 */
export async function closeAllRegistered() {
  await Promise.all(drainCleanup());
}
