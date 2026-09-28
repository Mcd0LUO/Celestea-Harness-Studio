// ============================================================================
// scripts/perf/lib/boot-race-seam.mjs — 启动序列的**测试专用**检查点（W2027）
// ----------------------------------------------------------------------------
// 为什么需要它：本模块服务的缺陷是「Chrome 进程已存在、但还没被登记进收尾表」这段
// 窗口里收到 SIGTERM ⇒ 孤儿 Chrome。窗口的长度由**真实时钟**决定（launchChrome 内部
// 轮询 /json/version 每 150ms 一次，上限 25s），所以用 `sleep 1.2; kill` 去撞它
// 是**赌时长**的测试 —— 本仓 W9225 门禁明令禁止这种写法，而且它必然 flake：
// 机器快时信号落在窗口外（假绿），机器慢时落在窗口外（假红）。
//
// 修法：把「窗口内的某一刻」变成一个**可注入的检查点**。生产路径下
// `bootRaceSeam()` **立即返回 null**，不读全局、不写文件、不 await —— 对启动序列
// 零影响（逐字见下）。门禁在自己的子进程里显式 `armBootRaceSeam(hook)`，让 hook
// 在检查点上写一个标记文件、再给自己发 SIGTERM ⇒ 信号**必然**落在窗口内，
// 与机器快慢无关。
//
// ★ 生产路径为什么不会被触发（两道锁，缺一不可）：
//   ① 默认 `armed === false` ⇒ `bootRaceSeam()` 走第一个 return，连 `hook` 都不看；
//   ② `armBootRaceSeam` / `disarmBootRaceSeam` **只被 tests/** 调用 ——
//      tests/w2027-perf-boot-race.test.ts 用 `git grep` 断言「除本文件（定义处）外，
//      scripts/ 下零引用」（结构性事实，不靠约定）。
//   所以「忘了关开关」这件事不存在：没有开关，只有显式函数调用。
// ============================================================================

/** 当前是否已武装（门禁用：断言生产路径下恒为 false）。 */
let armed = false;

/** 检查点回调；null = 没有注入（生产路径恒为 null）。 */
let hook = null;

/**
 * 武装检查点并注入回调。**只给门禁用**：scripts/ 下不得出现任何调用
 * （tests/w2027-perf-boot-race.test.ts 会机械地断言这一点）。
 * @param {(name: string) => unknown} fn 检查点回调；返回值被原样返回给调用方
 */
export function armBootRaceSeam(fn) {
  armed = true;
  hook = typeof fn === 'function' ? fn : null;
}

/** 解除武装（门禁用；生产代码不调用）。 */
export function disarmBootRaceSeam() {
  armed = false;
  hook = null;
}

/** 是否已武装（门禁用）。 */
export function isBootRaceSeamArmed() {
  return armed;
}

/**
 * 到达一个启动检查点。**生产路径 = 立即返回 null**（第一行就返回，不碰 hook）。
 * 返回值由注入的 hook 决定，调用方一律忽略它（只把它当作「这里可以停一下」的位置标记）。
 * @param {string} name 检查点名字
 */
export function bootRaceSeam(name) {
  if (!armed || hook === null) return null;
  return hook(name);
}
