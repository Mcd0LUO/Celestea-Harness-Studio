// ============================================================================
// scripts/perf/lib/chrome.mjs — 启动 headless Chrome + attach 一个 page
// ----------------------------------------------------------------------------
// profile 一律写到 $TEMP（results/ 会被 ESLint 扫，且绝不能把浏览器 profile 提交）。
//
// 可移植性（W2019）：原来只认 5 条**写死**的候选路径，其中两条是作者那台 Windows 的
// 安装位置，其余（/usr/bin/google-chrome 等）在很多机器上也不存在 ⇒ `findChrome()`
// 返回 null，`launchChrome` 直接 `throw new Error('chrome not found')`，整个工具包
// **一行都跑不了**。现在按三级查找：
//   ① `W9111_CHROME` 环境变量（显式覆盖，**最高优先级**，连 Playwright 都不用装）；
//   ② 原有的 5 条候选路径（**逐字保留**，Windows/macOS 行为不变）；
//   ③ Playwright 浏览器缓存（`~/.cache/ms-playwright/<browser>-<build>/…`，
//      含 `chrome-headless-shell`）——**按目录名倒序**，新构建优先。
// 查不到仍然返回 `null`（不编造路径），由 `launchChrome` 报错。
//
// ★ W2027（启动窗口的孤儿）：收尾登记从 `launchChrome` **返回之后**（app.mjs 里）
//   提前到 **spawn() 之后的第一个 await 之前**（见下）。原来的窗口是「Chrome 进程已
//   存在、但还没进收尾表」—— 这段时间里收到 SIGTERM，Node 直接退出，Chrome 被 init
//   收养，继续占着 CDP 端口与 profile。窗口长度 = launchChrome 内部轮询
//   /json/version 的时长（数百 ms ~ 数秒），所以它**必然**能被撞到。
// ============================================================================
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cdp, CdpPage, openCdp } from './cdp.mjs';
import { adoptCleanup } from './cleanup.mjs';
import { bootRaceSeam } from './boot-race-seam.mjs';

/** 显式指定 Chrome 可执行文件的环境变量名（README「环境变量」表里也登记了它）。 */
export const CHROME_ENV = 'W9111_CHROME';

/** 原有候选列表（**逐字保留**：Windows / macOS / 常见 Linux 发行版路径）。 */
export const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

/** Playwright 各浏览器目录下的可执行文件相对路径（Linux / macOS / Windows 三种布局）。 */
const PLAYWRIGHT_RELATIVE = [
  join('chrome-linux64', 'chrome'),
  join('chrome-linux', 'chrome'),
  join('chrome-headless-shell-linux64', 'chrome-headless-shell'),
  join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  join('chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  join('chrome-win64', 'chrome.exe'),
  join('chrome-win', 'chrome.exe'),
];

/** Playwright 缓存根（Playwright 自己的 `PLAYWRIGHT_BROWSERS_PATH` 优先）。 */
export function playwrightCacheRoot(env = process.env) {
  const override = env.PLAYWRIGHT_BROWSERS_PATH;
  if (override !== undefined && override.trim() !== '') return override;
  return join(homedir(), '.cache', 'ms-playwright');
}

/**
 * 展开 Playwright 缓存里的 Chrome 候选：`<root>/<browser>-<build>/<relative>`。
 * 目录名倒序 ⇒ 新构建优先（`chromium_headless_shell-1234` > `…-1000`）。
 * 目录不存在时返回空数组（不抛错：没有 Playwright 是正常情况）。
 */
export function playwrightCandidates(root = playwrightCacheRoot()) {
  let names = [];
  try {
    names = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort().reverse()) {
    for (const rel of PLAYWRIGHT_RELATIVE) out.push(join(root, name, rel));
  }
  return out;
}

/**
 * 完整候选序列：环境变量 → 原有候选 → Playwright 缓存。
 * 单独导出是为了让门禁能**不启动浏览器**就检查查找顺序（tests/w2019-perf-harness-gate.test.ts）。
 */
export function chromeCandidates({ env = process.env, playwright = playwrightCandidates() } = {}) {
  const out = [];
  const override = env[CHROME_ENV];
  if (override !== undefined && override.trim() !== '') out.push(override);
  out.push(...CHROME_CANDIDATES, ...playwright);
  return out;
}

/**
 * 找到可用的 Chrome 可执行文件；找不到返回 `null`。
 *
 * ★ `W9111_CHROME` 一旦设置就**无条件**返回它（即使该文件不存在）：显式覆盖是操作者
 *   的意图，悄悄换用另一个浏览器会让测量数字来自**另一个 Chrome 版本** —— 口径不可复核
 *   比报错更糟。路径不存在时由 `launchChrome` 报出明确错误。
 */
export function findChrome({ env = process.env, playwright = playwrightCandidates(), exists = existsSync } = {}) {
  const override = env[CHROME_ENV];
  if (override !== undefined && override.trim() !== '') return override;
  for (const p of [...CHROME_CANDIDATES, ...playwright]) if (exists(p)) return p;
  return null;
}

/**
 * 启动 Chrome，返回 { browser, page, close, unregister, port, profileDir, chromePath, version }。
 *
 * ★ W2027：**本函数在 spawn() 之后立刻把收尾登记进 cleanup.mjs**（第一个 await 之前）
 *   ⇒ 从「Chrome 进程存在」那一刻起，任何时刻收到 SIGTERM 都不会留下孤儿。
 *   返回值里的 `unregister` 是「注销这条登记」的句柄：调用方若要把收尾**接管**过去
 *   （app.mjs 的复合 close 就是），必须用它把这条换掉，而不是再登记一条。
 */
export async function launchChrome(opts = {}) {
  const exe = opts.executablePath ?? findChrome();
  if (!exe) throw new Error('chrome not found（设 W9111_CHROME=<可执行文件> 或安装 Chrome/Playwright 浏览器）');
  if (!existsSync(exe)) throw new Error('chrome executable does not exist: ' + exe);
  // ★ W9263（CI 实证）：在负载高的 runner 上，Chrome 的 devtools 端点可能错过那 25 s
  //   窗口 —— 同一个提交几分钟前刚绿过，所以这是**偶发的启动失败**，不是环境坏了。
  //   一次重试（失败那次已经走过**同一条**收尾：kill child + 删 profile + 注销）把它
  //   从「门禁变红」降级成「多花几秒」，而断言一个字没动。
  const attempts = Math.max(1, opts.launchAttempts ?? 2);
  let failure = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await launchAttempt(exe, opts);
    } catch (error) {
      failure = error;
      if (attempt < attempts) {
        // 可见地记一行：偶发启动失败必须能一眼看出来，而不是变成一桩悬案。
        console.error(
          '[perf] chrome launch attempt ' + attempt + '/' + attempts + ' failed: ' + String(error?.message ?? error).split('\n')[0],
        );
      }
    }
  }
  throw failure;
}

/** 一次启动尝试；重试契约见 [launchChrome]。 */
async function launchAttempt(exe, opts) {
  const profileDir = opts.userDataDir ?? mkdtempSync(join(tmpdir(), 'w9111-chrome-'));
  const port = opts.port ?? 9333;
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-size=' + (opts.width ?? 1440) + ',' + (opts.height ?? 900),
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profileDir,
    ...(opts.extraArgs ?? []),
    'about:blank',
  ];
  const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += String(b); });

  // ---- 收尾登记（W2027）：★ 必须在**第一个 await 之前**、且**无条件**发生 -------
  // 为什么把 close 的定义搬到这里（原来是函数末尾）：登记要的是「关掉这个 child」的
  // 能力，而它此刻已经具备（spawn 已返回 ⇒ pid 已知、profile 目录已建）。等到
  // openCdp / Page.enable 都跑完再登记，中间那段就是孤儿窗口。
  //
  // ★ 为什么不是「在 app.mjs 里 let chromeRef = null 提前登记」：那个 ref 在
  //   `chromeRef = chrome` 执行前仍是 null，窗口只是被挪了个位置、并没有关严
  //   （而且收尾函数还要多一个 null 分支）。登记必须在**知道 child 的那一刻**做。
  //
  // ★ 为什么不是「让 app.mjs 与这里都登记」：close() 是**幂等**的，但幂等 ≠ 可以重复
  //   登记 —— 登记表里若有两个指向同一个 Chrome 的收尾，信号到达时会跑两次，而
  //   close() 的异步尾巴（等 300ms + 删 profile）**第二次也要再等一遍**，退出被拖长。
  //   所以本函数是**唯一登记者**（登记表里最多一条），由 adoptCleanup 保证
  //   「关完即注销」；app.mjs 那边改用 unregister() **移交**所有权，不再自己登记。
  // `browser` 此刻还没连上（openCdp 在后面）。先给个空壳，让 close() 从这一行起就是
  // **完整**的：kill child + 删 profile 都不依赖 CDP 连接，只有「关 ws」需要它。
  // 连上之后 `browser` 被重新赋值，close() 闭包读的是同一个绑定 ⇒ 正常路径行为不变。
  let browser = { close() { /* 还没连上：没有 ws 要关 */ } };
  let closePromise = null;
  const close = () => {
    if (closePromise !== null) return closePromise;
    closePromise = (async () => {
      try { browser.close(); } catch { /* ignore */ }
      try { child.kill(); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 300));
      if (!opts.keepProfile) { try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ } }
    })();
    return closePromise;
  };
  const unregister = adoptCleanup(close);
  // 门禁专用检查点（tests/w2027-perf-boot-race.test.ts）：生产路径下
  // bootRaceSeam() **立即返回 null**，不读全局、不写文件、不 await ⇒ 对启动序列零影响。
  bootRaceSeam('chrome:spawned');

  const versionUrl = 'http://127.0.0.1:' + port + '/json/version';
  const deadline = Date.now() + (opts.startupTimeoutMs ?? 25000);
  let version = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(versionUrl);
      if (res.ok) { version = await res.json(); break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!version) {
    // 起不来也要走**同一条**收尾（kill + 删 profile + 注销），而不是裸 child.kill()：
    // 原来这条路径会把 profile 目录留在 $TEMP 里（与 W2021 修的是同一类泄漏）。
    try { await close(); } catch { /* 收尾失败不掩盖下面这条更有用的错误 */ }
    throw new Error('chrome devtools endpoint never came up.\n' + stderr.slice(-2000));
  }

  browser = await openCdp(version.webSocketDebuggerUrl);
  // flat 模式：所有 session 消息走同一条 ws。
  const { targetInfos } = await browser.send('Target.getTargets');
  let info = targetInfos.find((t) => t.type === 'page');
  if (!info) {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    info = { targetId };
  }
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
  const page = new CdpPage(browser, sessionId);

  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Network.enable');
  await page.send('Performance.enable');

  // close 与 unregister 已在 spawn 之后定义/登记（见上，W2027）：此处只返回它们。
  // 幂等语义不变（W2021）：正常路径的 finally 与信号路径的 drain 拿到**同一个** Promise，
  // 第二次调用不重复 kill、不重复删 profile、不抛错。
  // `unregister` 交给调用方（app.mjs）：当这个 Chrome 的收尾被**别人接管**时注销本登记。
  return { browser, page, close, unregister, port, profileDir, chromePath: exe, version };
}

export { Cdp, CdpPage, openCdp };
