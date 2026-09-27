/**
 * W9225 · 等待异步结果的**唯一正确姿势**：轮询到条件成立，而不是 sleep 一个时长。
 *
 * 为什么需要它（这是本仓 CI 反复变红的根因）：
 *
 * Martin Fowler《Eradicating Non-Determinism in Tests》对 `sleep` 的判词：
 *   「The common mistake here is to throw in a sleep... The second bite is that,
 *    **however long you sleep, sometimes it won't be enough**. There will be some
 *    change in the environment that will cause you to exceed the sleep — and you'll
 *    get false failure. As a result I strongly urge you to **never use bare sleeps**
 *    like this.」
 *
 * 本仓实测过的两个真实事故，都是这句话的实例：
 *   · `w833-adapter-payload.test.ts`：靠「睡 60ms 后断言仍然忙」建立前提。
 *     忙窗口 = 帧数 × deltaMs，而 `setTimeout(3)` 的实际节拍**随平台变**：
 *     Windows ~17ms（窗口 275ms）、Linux 3ms（窗口 **48ms**）⇒ Linux 上必然红。
 *   · `w9206-security-fixes.test.ts`：靠「循环 60 次比子进程活得久」赌 EPIPE，
 *     同理在 Linux 上抢跑，退出码 0 ⇒ 断言失败。
 * 两次都是**本机全绿、CI 才红** —— 因为 Windows 的定时器粒度粗，恰好把窗口撑大了。
 *
 * 正确做法：**等条件，不等时间**。`sleep` 表达的是「大概够了吧」，
 * `until` 表达的是「直到它真的发生」—— 前者是赌，后者是证明。
 * 而且它在**快机器上更快**（条件一成立就返回），`sleep` 则永远等满。
 *
 * 用法：
 *   await until(() => engine.isBusy(S1), "s1 to become busy");
 *   await until(() => logOf(h, "s1").includes("[from "), "the wake to land");
 *
 * @param check     条件（同步判定；每 `intervalMs` 求值一次）
 * @param what      超时信息里的人类可读描述 —— 失败时能直接看出在等什么
 * @param timeoutMs 上限（默认 5s；轮询间隔 5ms）
 */
export async function until(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // 先判一次：条件已成立时**零等待**返回（快机器上比任何 sleep 都快）。
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * 等一个**异步**条件（`check` 返回 Promise）。
 *
 * 与 `until` 分开是因为大多数条件其实是同步读状态（`isBusy()`、日志文本），
 * 用同步版可以避免每轮都造一个 Promise。
 */
export async function untilAsync(
  check: () => Promise<boolean>,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * 排空微任务队列（不是等时间，是等**已排队的**回调跑完）。
 *
 * 这是 `await new Promise((r) => setTimeout(r, 0))` 的正确替代：
 * 它推进事件循环 N 轮，让已 resolve 的 Promise 链落地。
 * 注意它**不保证**任何真实 I/O 完成 —— 那种情况请用 `until`。
 */
export async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}