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
// ============================================================================
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cdp, CdpPage, openCdp } from './cdp.mjs';

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

/** 启动 Chrome，返回 { browser, page, close, port, profileDir }。 */
export async function launchChrome(opts = {}) {
  const exe = opts.executablePath ?? findChrome();
  if (!exe) throw new Error('chrome not found（设 W9111_CHROME=<可执行文件> 或安装 Chrome/Playwright 浏览器）');
  if (!existsSync(exe)) throw new Error('chrome executable does not exist: ' + exe);
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
    child.kill();
    throw new Error('chrome devtools endpoint never came up.\n' + stderr.slice(-2000));
  }

  const browser = await openCdp(version.webSocketDebuggerUrl);
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

  const close = async () => {
    try { browser.close(); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 300));
    if (!opts.keepProfile) { try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  };
  return { browser, page, close, port, profileDir, chromePath: exe, version };
}

export { Cdp, CdpPage, openCdp };
