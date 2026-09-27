// scripts/perf/lib/app.mjs — 装配：起确定性假后端 + Chrome，导航到冻结前端。
import { launchChrome } from './chrome.mjs';
import { startBackend, SESSION_ID } from './backend.mjs';
import { repoRootFrom } from './repo-root.mjs';
import { registerCleanup } from './cleanup.mjs';

/**
 * 冻结检出根。`W9111_REPO` 覆盖优先；未设时**从本文件位置推导**仓根
 * （`scripts/perf/lib/app.mjs` → 上溯到含 `package.json` 的目录）。
 *
 * 为什么不再写死 `C:/Users/lenovo/AppData/Local/Temp/perf-w9111/repo`：那是作者那台
 * Windows 的临时目录，换机器/换 OS 就是个不存在的路径，而报错发生在"静态服务器 404 →
 * 页面里没有 .sess-pane"这种下游位置，看不出根因。推导失败时返回 `null`（不编造）。
 *
 * ★ 推导出的仓根是**活工作树**，而 README 要求正式测量跑在 `git archive` 导出的冻结
 *   检出上（否则并发改动会让数字不可复现）。所以走回落时打一条警告，让"忘了设
 *   W9111_REPO"这件事**看得见**，而不是悄悄换了测量对象。
 */
export function resolveRepo(env = process.env, importMetaUrl = import.meta.url) {
  const override = env.W9111_REPO;
  if (override !== undefined && override.trim() !== '') return override;
  const derived = repoRootFrom(importMetaUrl);
  if (derived !== null) {
    process.stderr.write('[perf] W9111_REPO 未设置，使用推导出的仓根（活工作树）：' + derived +
      '\n[perf] 正式测量请设 W9111_REPO=<git archive 导出的冻结检出>（README §前置）\n');
  }
  return derived;
}

export const DEFAULT_REPO = resolveRepo();
export const DEFAULT_VITE = process.env.W9111_VITE ?? 'http://127.0.0.1:3787';
export { SESSION_ID };

/**
 * 起一个「被测应用」实例。
 * @param {object} o
 * @param {number} o.port        fixture 后端端口
 * @param {number} o.cdpPort     Chrome 调试端口
 * @param {Array}  [o.history]   历史消息夹具（GET /api/sessions/{id}/messages）
 * @param {string} [o.initScript] 每个新文档执行前的注入脚本
 */
export async function boot(o) {
  const repo = o.repo ?? DEFAULT_REPO;
  if (repo === null) {
    throw new Error('repo root not found：设 W9111_REPO=<冻结检出根>（推导：从 scripts/perf/lib 上溯含 package.json 的目录）');
  }
  const webRoot = repo + '/apps/web';
  const backend = await startBackend({
    port: o.port,
    webRoot,
    viteOrigin: o.vite ?? DEFAULT_VITE,
    history: o.history ?? [],
  });
  const chrome = await launchChrome({
    port: o.cdpPort,
    width: o.width ?? 1440,
    height: o.height ?? 900,
    extraArgs: o.extraArgs ?? [],
  });
  const { page } = chrome;
  const consoleErrors = [];
  const consoleAll = [];
  page.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    consoleAll.push({ type: p.type, text });
    if (p.type === 'error') consoleErrors.push(text);
  });
  page.on('Runtime.exceptionThrown', (p) => {
    consoleErrors.push('EXCEPTION ' + (p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? ''));
  });
  if (o.initScript) await page.addInitScript(o.initScript);

  // ---- 进程收尾（W2021）----------------------------------------------------
  // 一个实例**一个** close：chrome 与 backend 各自幂等，这里再包一层「同一个 Promise」，
  // 让正常路径（case 的 finally）与信号路径（cleanup.mjs 的 drain）拿到同一次收尾。
  // ★ 关键动作（kill Chrome / server.close() 释放监听端口）都在**第一个 await 之前**
  //   同步发生 —— 信号处理器里不能 await，同步部分才是「一定不会留下孤儿」的保证。
  let closePromise = null;
  const close = () => {
    if (closePromise === null) closePromise = (async () => { await chrome.close(); await backend.close(); })();
    return closePromise;
  };
  // 起来之后登记、关完之后注销 ⇒ 信号到达时登记表里恰好是「已起来且还没关」的实例，
  // 0/1/2 个都对；登记表清空时 cleanup.mjs 会把信号处理器摘掉（正常路径不被改动）。
  const unregister = registerCleanup(() => { const p = close(); p.then(unregister, unregister); return p; });
  return {
    ...chrome,
    backend,
    consoleErrors,
    consoleAll,
    origin: backend.origin,
    async boot() {
      await page.navigate(backend.origin + '/');
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: o.width ?? 1440, height: o.height ?? 900, deviceScaleFactor: 1, mobile: false,
      });
      return page;
    },
    // 幂等：重复调用返回同一次收尾（不抛错），并在关完后从登记表摘掉自己。
    async close() {
      try { await close(); } finally { unregister(); }
    },
  };
}

/** 等待某个页面内谓词为真（谓词体是函数体，返回真值即停）。 */
export async function waitFor(page, exprBody, { timeoutMs = 20000, label = 'condition', intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.eval('(function(){ ' + exprBody + ' })()');
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timeout (' + label + '); last=' + JSON.stringify(last));
}

/** 直接打后端的控制面。 */
export async function control(app, path, body) {
  const res = await fetch(app.origin + path, body === undefined
    ? undefined
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
