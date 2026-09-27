// ============================================================================
// scripts/lib/gate-cleanup.mjs — 门禁子进程收尾登记：**中断时不留孤儿 gate**
// ----------------------------------------------------------------------------
// 为什么需要它（W2026 实测）：scripts/check-parallel.mjs 用
// `spawn(cmd, { shell: true })` 起门禁，而 `shell: true` 会插入一层 `/bin/sh -c`
// —— **杀 sh 不会杀它的子进程**。实测 `node scripts/check-parallel.mjs` 被 SIGTERM
// 之后（修复前）：
//   · `sh -c 'pnpm --dir apps/web run build && …'` 死了，
//   · 但它下面的 pnpm / tsc / vitest 被 init 收养（ppid=1）后**继续跑完**。
// 孤儿 gate 是有限序列、跑完即退，**不是永久泄漏** —— 但在这之前重跑 `pnpm check`
// 就是**两批 gate 并发**，而本仓有已知的并发敏感测试（bwrap 的 /proc/self/fd、
// lifecycle 的 fd 计数）⇒ **假红**（「全量 check 红、单独跑绿」的一个来源）。
//
// 设计（与 scripts/perf/lib/cleanup.mjs 同源；四问对应见 W2026 报告 §2）：
//   ① 收尾动作必须**同步**做完：`process.on('SIGTERM', fn)` 丢弃 fn 的返回值，
//      写成 async 也没人等它。所以 reapChild() 在**第一个 await 之前**就把 SIGTERM
//      发给整个进程组，再把「等它死 / 到点升级 SIGKILL」的 Promise 交出去。
//   ② 不漏不重：每个 gate 起来时 registerCleanup()、close 时注销 ⇒ 信号到达时登记表里
//      恰好是「还活着」的那些（0..JOBS 个都对）。drain 先取快照再清空 ⇒ 幂等。
//   ③ 按**进程组**回收：gate 用 detached:true 自成一组，一条 kill(-pid) 收掉
//      sh 中间层 + pnpm 垫片 + vitest worker（只杀直接子进程会漏掉后两层）。
//      Windows 没有进程组，退回 taskkill /T /F（best-effort，与
//      packages/tools/src/sandbox/child.ts 的 taskkillTree 同一套口径）。
//   ④ 有上限：SIGTERM 后宽限 SIGKILL_GRACE_MS 升级 SIGKILL，最多等 REAP_TOTAL_MS；
//      信号路径另有 FORCE_EXIT_MS 的硬上限 —— 宁可少收一个，也不让门禁挂住。
//   ⑤ 正常路径零副作用：登记表清空时把信号处理器摘掉；没登记任何 gate 的进程不被本模块
//      改变信号语义。
// ============================================================================
import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:os';

/** 要接管的信号。两个都是「正常请求退出」语义，不接 SIGKILL（接不了）。 */
export const CLEANUP_SIGNALS = ['SIGTERM', 'SIGINT'];

/** 信号路径的硬上限：到点就退出（宁可少收一个，也不能让门禁挂住）。 */
export const FORCE_EXIT_MS = 2000;

/** 发 SIGTERM 之后的宽限期；到期还没死就升级 SIGKILL。 */
export const SIGKILL_GRACE_MS = 400;

/** 单个 gate 的回收总上限（含升级 SIGKILL 之后）。必须 < FORCE_EXIT_MS。 */
export const REAP_TOTAL_MS = 1500;

/** 回收轮询间隔。 */
export const REAP_POLL_MS = 50;

/** 退出码：全部通过。 */
export const OK_EXIT_CODE = 0;

/** 退出码：有门禁失败（**改动前的既有语义，不得变**）。 */
export const GATE_FAILURE_EXIT_CODE = 1;

/**
 * 退出码：被 SIGTERM/SIGINT 中断。
 *
 * ★ 这里**故意不用** cleanup.mjs 的 `128 + signum`（143/130），理由：
 *   · 128+n 是 shell 对「进程**被信号打死**」的记法。本脚本的整个修复恰恰是
 *     **不被信号打死**（自己收尾、自己退出）—— 用 128+n 会让「收尾成功」与
 *     「没收尾、硬死」在日志里**完全同形**，丢掉最有价值的诊断信息。
 *   · 门禁的退出码要被 pnpm/CI 解读：中断必须与「门禁失败」可区分（失败=1），
 *     否则 Ctrl-C 会被读成「门禁红了」。两个信号统一给 2，判定只看一个数。
 *   信息没有丢：中断消息里同时打印 shell 口径的 128+n（见 handleSignal）。
 */
export const INTERRUPTED_EXIT_CODE = 2;

/** 退出码：用法/配置错误（例如 --gates 文件读不了）——与门禁失败区分开。 */
export const CONFIG_ERROR_EXIT_CODE = 3;

/** taskkill 是本机有界操作；绝不让超时路径卡住。 */
export const WINDOWS_TASKKILL_TIMEOUT_MS = 5000;

/** 还活着的 gate 的收尾函数（Set 按身份去重 ⇒ 同一个 gate 不会被登记两次）。 */
const registry = new Set();

/** 已安装的监听器；null = 当前没有安装。 */
let installed = null;

/** 宿主注入的回调（check-parallel 用；测试用 installSignalCleanup 直接注入）。 */
let hooks = {};

/** 是否已经在收尾（第二次信号 = 不再等，立即退出）。 */
let draining = false;

/**
 * 信号 → shell 口径退出码（`128 + signum`）：SIGTERM → 143、SIGINT → 130。
 * 只用于**打印**（让人能对上 `timeout` / `$?` 的习惯），不用作本脚本的退出码。
 */
export function exitCodeFor(signal) {
  const n = constants.signals[signal];
  return typeof n === 'number' ? 128 + n : GATE_FAILURE_EXIT_CODE;
}

/** 中断时本脚本实际使用的退出码（两个信号统一，见 INTERRUPTED_EXIT_CODE）。 */
export function cleanupExitCode(_signal) {
  return INTERRUPTED_EXIT_CODE;
}

/** 登记表当前条目数（门禁用：证明「不漏也不重复关」的边界）。 */
export function activeCleanupCount() {
  return registry.size;
}

/** 信号收尾是否已挂上（门禁用：没有活 gate 时必须是 false）。 */
export function isSignalCleanupInstalled() {
  return installed !== null;
}

function callSafely(fn, arg) {
  try {
    if (typeof fn === 'function') fn(arg);
  } catch {
    /* 回调失败不得掩盖原始退出原因 */
  }
}

/**
 * 登记宿主回调（`onSignal(signal)` / `onInterrupt(code)`）——**不安装**监听器。
 * 宿主可以在还没有任何 gate 时先登记回调，等第一个 registerCleanup() 再真正安装，
 * 于是「没有活 gate 的进程不被改变信号语义」这条仍然成立。
 */
export function setSignalHooks(nextHooks) {
  hooks = nextHooks ?? {};
}

/** 安装信号处理器（幂等）。传了 nextHooks 就顺带更新回调。 */
export function installSignalCleanup(nextHooks) {
  if (nextHooks !== undefined) hooks = nextHooks;
  if (installed !== null) return;
  const listeners = [];
  for (const signal of CLEANUP_SIGNALS) {
    const listener = () => handleSignal(signal);
    process.on(signal, listener);
    listeners.push([signal, listener]);
  }
  installed = { listeners };
}

/** 摘掉信号处理器（幂等）。正常路径跑完时调用 ⇒ 不改变进程的信号语义。 */
export function uninstallSignalCleanup() {
  if (installed === null) return;
  for (const [signal, listener] of installed.listeners) process.removeListener(signal, listener);
  installed = null;
}

/** 登记一个 gate 的收尾函数（返回「注销」函数）。 */
export function registerCleanup(fn) {
  registry.add(fn);
  installSignalCleanup(hooks);
  return () => {
    registry.delete(fn);
    if (registry.size === 0) uninstallSignalCleanup();
  };
}

/**
 * **同步**调用并清空登记表；返回它们的 Promise（已吞掉拒绝，交给调用方按需 await）。
 * 先清空再调用 ⇒ 重入/重复 drain 都不会把同一个收尾函数再跑一遍。
 */
export function drainCleanup() {
  const pending = [];
  for (const fn of [...registry]) {
    registry.delete(fn);
    try {
      const result = fn();
      if (result && typeof result.then === 'function') pending.push(Promise.resolve(result).catch(() => {}));
    } catch {
      /* 收尾失败不掩盖原始退出原因 */
    }
  }
  if (registry.size === 0) uninstallSignalCleanup();
  return pending;
}

/** 正常路径用：等所有登记过的收尾跑完（信号路径不走这里，见 handleSignal）。 */
export async function closeAllRegistered() {
  await Promise.all(drainCleanup());
}

/**
 * 信号路径：**同步**把 SIGTERM 发给每个 gate 的进程组，再**有上限地**等它们死
 * （宽限期后升级 SIGKILL），最后以 INTERRUPTED_EXIT_CODE 自己退出。
 * 第二次信号不再等（立即退出）。
 */
export function handleSignal(signal) {
  const code = cleanupExitCode(signal);
  const captured = hooks;
  if (draining) {
    process.exit(code);
    return;
  }
  draining = true;
  try {
    process.stderr.write('\n[check] 收到 ' + signal + '（shell 口径 ' + exitCodeFor(signal) + '）：正在回收 ' + registry.size + ' 个 gate 子进程…\n');
  } catch {
    /* stderr 关了也要收尾 */
  }
  callSafely(captured.onSignal, signal);
  const pending = drainCleanup();
  const deadline = new Promise((resolve) => setTimeout(resolve, FORCE_EXIT_MS));
  const done = () => {
    callSafely(captured.onInterrupt, code);
    process.exit(code);
  };
  Promise.race([Promise.all(pending), deadline]).then(done, done);
}

/** 进程是否还活着（signal 0 = 只做存在性检查）。 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** gate 的**整个进程组**是否还有成员活着（POSIX）；Windows 没有组，只问直接子进程。 */
function groupAlive(pid) {
  if (process.platform === 'win32') return isAlive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 给 gate 的**整个进程组**发信号（POSIX 负 pid）。Windows 退回 `taskkill /T /F`
 * —— 那里没有进程组，taskkill 是 OS 唯一的树回收手段（best-effort）。
 */
export function signalTree(child, signal) {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: WINDOWS_TASKKILL_TIMEOUT_MS });
    } catch {
      /* taskkill 不可用：直接子进程下面就只能放弃了（best-effort） */
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    /* 组已消失，或不是我们的组 */
  }
  try {
    child.kill(signal);
  } catch {
    /* 已经退出 */
  }
}

/**
 * 回收一个 gate：**同步**发 SIGTERM，返回「等它死、到点升级 SIGKILL」的有上限 Promise。
 * ★ 约定（同 cleanup.mjs）：关键动作在第一个 await 之前完成 —— 信号路径不 await 前半段。
 */
export function reapChild(child, options = {}) {
  const pid = child.pid;
  if (pid === undefined) return Promise.resolve();
  signalTree(child, 'SIGTERM');
  const graceMs = options.graceMs ?? SIGKILL_GRACE_MS;
  const totalMs = options.totalMs ?? REAP_TOTAL_MS;
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (!groupAlive(pid)) {
        resolve();
        return;
      }
      const waited = Date.now() - started;
      if (waited >= totalMs) {
        signalTree(child, 'SIGKILL');
        resolve();
        return;
      }
      if (waited >= graceMs) signalTree(child, 'SIGKILL');
      setTimeout(tick, REAP_POLL_MS);
    };
    setTimeout(tick, REAP_POLL_MS);
  });
}

/**
 * 起一个 gate 并**登记**它。POSIX 下 detached:true 让它自成进程组 ⇒ 一条
 * kill(-pid) 收掉 sh 中间层 + pnpm 垫片 + vitest worker；Windows 下不开 detached
 * （那里 detached 只会新开控制台窗口），改由 signalTree 走 taskkill /T。
 */
export function spawnRegistered(command, options = {}) {
  const child = spawn(command, {
    shell: true,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const unregister = registerCleanup(() => reapChild(child));
  return { child, unregister };
}
