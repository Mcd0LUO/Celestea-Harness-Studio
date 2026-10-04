// ============================================================================
// scripts/a11y/lib/harness.mjs — 真机探针的**共享脚手架**（服务端 / 截图 / 输入 / 判定）
// ----------------------------------------------------------------------------
// 为什么有它：scripts/a11y/ 下有 7 个探针，**每一个都各写了一遍同一套脚手架** ——
//   ① 静态 fixture 服务端（`node:http` + `createServer` + `listen` + MIME + Vite 反代
//      + 「够应用启动」的那一打 JSON 端点）；
//   ② 截图落盘（`Page.captureScreenshot` → base64 → `mkdir` → `writeFile`）；
//   ③ CDP 输入助手（滚轮 / 按键 / Tab / 点击）；
//   ④ verdict 表 + PASS/FAIL 汇总 + 退出码。
// 这四件事与「这个探针要证明什么」**无关**，却占了每个探针一半以上的行数，而且是同一份
// 代码的 N 份拷贝：改一处（比如 W9323 那条「请求处理器里不许有同步阻塞调用」）要改 N 遍，
// 漏一个就有一份悄悄退化。抽到这里之后，**新探针只剩「场景 + 断言」**。
//
// ★ 判据、阈值、文案的所有权仍归**探针**：本模块只提供「量」与「报」，
//   不提供任何业务断言（那是探针存在的理由，不该被共享化抹平）。
//
// ★ W9323：本文件的请求处理器里**一个同步 fs 调用都没有**（`fs/promises` + 顶层 await）。
//   不是「记得别写」——是「不可能写」：本文件根本不 import 同步 fs。
//
// 典型用法（脚手架 ≈ 6 行 import + 5 行装配）：
//   import { repoRoot, startFixture, launchProbeChrome, createProbe, createInput, sleep }
//     from './lib/harness.mjs';
//   const REPO = repoRoot('W9400_REPO');
//   const fixture = await startFixture({ port: 3840, label: 'w9400' });
//   const chrome = await launchProbeChrome({ port: 9490, width: 1440, height: 900 });
//   const P = createProbe({ title: 'W9400 真机取证', shots: join(REPO, 'tmp', 'w9400-probe') });
//   const input = createInput(chrome.page);
//   try {
//     await chrome.page.navigate(fixture.origin + '/');
//     ... 场景 ...
//     P.record('something', pred, '量到的原始数字');
//   } finally { await chrome.close(); await fixture.close(); }
//   await P.finish({ exitCodeOnFail: 1 });
// ============================================================================
import http from 'node:http';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from '../../perf/lib/chrome.mjs';

/** 仓库根（从**本文件**的位置推：scripts/a11y/lib → 上三级）。 */
export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/[\\/]$/, '');

/**
 * 仓库根，可用环境变量覆盖（各探针原来各写一遍 `process.env.WXXXX_REPO ?? fileURLToPath(...)`）。
 * ★ Windows：`import.meta.url` 是 `file:///D:/...`，直接取 `pathname` 会得到 `/D:/...`，
 *   再 join 就变成 `D:\D:\...`（ENOENT）—— 所以一律经 fileURLToPath 规范化。
 */
export function repoRoot(envName) {
  const v = envName === undefined ? undefined : process.env[envName];
  return (v !== undefined && v.trim() !== '' ? v : REPO_ROOT).replace(/[\\/]$/, '');
}

/** `apps/web`（Vite 的 root，也是开发态静态托管的根）。 */
export function webRootOf(repo = REPO_ROOT) {
  return join(repo, 'apps', 'web');
}

/** `apps/web/dist`（构建产物；harness 的静态服务端同样能托管它）。 */
export function distRootOf(repo = REPO_ROOT) {
  return join(repo, 'apps', 'web', 'dist');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 异步 mkdir -p（截图目录、夹具目录）。 */
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
  return dir;
}

/** stat 的「可能不存在」形态（`fs/promises` 故意没有 exists）。 */
async function statOrNull(p) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.ts': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json; charset=utf-8',
};

/** 应用启动所需的最小 JSON 端点集（各探针原来各抄一份；**并集**，多一条不影响渲染）。 */
const SHELL_PATHS = [
  '/api/config', '/api/providers', '/api/prompts', '/api/tools',
  '/api/plugins', '/api/permissions/presets', '/api/questions',
];

/**
 * 真·行窗口读（与 `apps/studio/src/handlers/fs-read.ts` 同口径：1-based offset + limit）。
 * 异步版 —— 供 `/api/fs/read` 这类**请求回调内**的调用点使用（W9323）。
 */
export async function readFileWindow(abs, offset = 1, limit = 2000) {
  const raw = await readFile(abs, 'utf8');
  const lines = raw.split('\n');
  const totalLines = raw.endsWith('\n') ? lines.length - 1 : lines.length;
  const from = Math.max(1, offset) - 1;
  const slice = lines.slice(from, from + limit);
  const text = slice.join('\n') + (from + slice.length < lines.length ? '\n' : '');
  return { text, offset, limit, totalLines, truncated: from + slice.length < lines.length };
}

/**
 * 真文件系统的两个端点（预览面板 / 文件管理器的唯一数据来源）。
 * 全异步 ⇒ 可以安全地挂在请求回调里（W9323）。
 *
 * @param {object} opts
 * @param {'dirs'|'files'|'empty'|'none'} [opts.list]  `/api/fs/list` 的形态：
 *   `dirs` 目录+文件（带 parent/roots，文件管理器用）；`files` 只列文件（工作台用）；
 *   `empty` 恒空列表（预览面板不需要列目录）；`none` 不挂这条路由。
 * @param {string[]} [opts.roots] `dirs` 形态回的 roots（默认空数组）。
 * @param {number} [opts.maxEntries] 截断上限（默认 0 = 不截断）。★ 与原来各探针里那份
 *   夹具的差别：它们无条件回 `truncated: false`（哪怕 `slice(0, 50)` 真的切掉了东西）。
 *   这里回**真话**：不切就一定是 false，切了就一定是 true。
 */
export function fsRoutes({ list = 'dirs', roots = [], maxEntries = 0 } = {}) {
  const routes = {
    '/api/fs/read': async ({ url, json }) => {
      const abs = url.searchParams.get('path') ?? '';
      const s = await statOrNull(abs);
      if (s === null || !s.isFile()) {
        return json(200, { kind: 'text', text: '', offset: 1, limit: 0, totalLines: 0, truncated: false, error: 'ENOENT' });
      }
      const offset = Number(url.searchParams.get('offset') ?? '1') || 1;
      const limit = Number(url.searchParams.get('limit') ?? '2000') || 2000;
      return json(200, { kind: 'text', ...(await readFileWindow(abs, offset, limit)) });
    },
  };
  if (list === 'none') return routes;
  routes['/api/fs/list'] = async ({ url, json }) => {
    const dir = url.searchParams.get('path') ?? '';
    const dirStat = await statOrNull(dir);
    if (dirStat === null || !dirStat.isDirectory()) {
      return json(200, { path: dir, entries: [], truncated: false, error: 'not found' });
    }
    if (list === 'empty') return json(200, { path: dir, entries: [], truncated: false });
    const dirents = await readdir(dir, { withFileTypes: true });
    const entries = [];
    for (const e of dirents) {
      if (list === 'files' && !e.isFile()) continue;
      const s = await statOrNull(join(dir, e.name));
      if (s === null) continue;
      entries.push({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        size: s.size,
        mtime: new Date(s.mtimeMs).toISOString(),
      });
    }
    const truncated = maxEntries > 0 && entries.length > maxEntries;
    const body = { path: dir, entries: truncated ? entries.slice(0, maxEntries) : entries, truncated };
    if (list === 'dirs') { body.parent = dirname(dir); body.roots = roots; }
    return json(200, body);
  };
  return routes;
}

/**
 * 把 `routes` 的三种写法归一化成判定表：
 *   · 对象 `{ '/api/x': handle }`（精确路径 → 处理器）
 *   · 数组 `[{ path, handle }]` / `[{ when, handle }]`（`when` 可做动态路径）
 *   · 上述两者的**嵌套数组**（方便把 `fsRoutes()` 的返回值与自己的路由写在一起）
 */
function normalizeRoutes(routes) {
  const list = [];
  const walk = (r) => {
    if (r === null || r === undefined) return;
    if (Array.isArray(r)) { for (const x of r) walk(x); return; }
    const handle = r.handle ?? r.handler;
    if (handle !== undefined) {
      const when = typeof r.when === 'function' ? r.when : (u) => u.pathname === (r.path ?? r.when);
      list.push({ when, handle });
      return;
    }
    for (const [path, h] of Object.entries(r)) list.push({ when: (u) => u.pathname === path, handle: h });
  };
  walk(routes);
  return list;
}

/**
 * 启动**静态 fixture 服务端**：托管 `apps/web`（或 `apps/web/dist`）、把 `/src/**` 等反代到
 * Vite、并回答「够真应用启动」的那一打 JSON 端点。
 *
 * ★ 请求处理器里**没有同步 fs 调用**（W9323）：一律 `fs/promises` + `await`。
 *
 * @param {object} opts
 * @param {number} opts.port 监听端口（返回的 `port` 与它一致）。
 * @param {string} [opts.label] 夹具自称的名字（写进 /api/health、/api/status 与默认会话 id）。
 * @param {string} [opts.repo] 仓库根（默认本模块推出来的）。
 * @param {string} [opts.webRoot] 静态根（默认 `apps/web`；传 `distRootOf(repo)` 即托管构建产物）。
 * @param {string|null} [opts.vite] Vite dev server 源（默认 `$W9111_VITE` 或 :3787）；传 null 不反代。
 * @param {string[]} [opts.proxyPrefixes] 反代到 Vite 的路径前缀。
 * @param {object} [opts.session] 会话夹具 `{ id, title, workspace, workspacePath }`。
 * @param {string} [opts.html] `/` 返回的自定义 HTML（省略 = 走静态托管）。
 * @param {object|Array} [opts.routes] 探针自己的端点（**先于**内建端点判定）。
 * @param {boolean} [opts.spaFallback] 未命中静态文件时是否回落到 index.html。
 * @returns {Promise<{server, port, origin, url, close, label, repo, webRoot}>}
 */
export async function startFixture(opts = {}) {
  const repo = opts.repo ?? REPO_ROOT;
  const label = opts.label ?? 'probe';
  const webRoot = opts.webRoot ?? webRootOf(repo);
  const vite = opts.vite === undefined ? (process.env.W9111_VITE ?? 'http://127.0.0.1:3787') : opts.vite;
  const proxyPrefixes = opts.proxyPrefixes ?? ['/src/', '/@', '/node_modules/'];
  const routeList = normalizeRoutes(opts.routes);
  const html = opts.html ?? null;
  const spaFallback = opts.spaFallback === true;
  const sess = {
    id: label + '/main', title: label + ' 取证', workspace: label, workspacePath: repo, ...(opts.session ?? {}),
  };
  const health = {
    ok: true, name: label, model: label, base_url: 'http://127.0.0.1:' + (opts.port ?? 0),
    bind: '127.0.0.1:' + (opts.port ?? 0), capabilities: {},
  };
  const status = {
    model: label, reasoning_effort: null, steps: 0, tokens_per_sec: 0,
    context_usage: { used: 0, window: 1000000, ratio: 0 }, usage: {}, session: sess.id, busy: false,
  };
  const sessionsBody = {
    sessions: [{ id: sess.id, title: sess.title, kind: 'session', busy: false, active: true, events: 0, workspace: sess.workspace }],
    active_session: sess.id,
  };
  const workspacesBody = {
    workspaces: [{ name: sess.workspace, path: sess.workspacePath, sessions: 1 }],
    active_session: sess.id,
  };
  const shellBody = {
    ok: true, model: label, available: { models: [], efforts: [] }, providers: [], prompts: [],
    tools: [], plugins: [], presets: [], questions: [], disabled: [], messages: [],
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const p = url.pathname;
    const cors = {
      'access-control-allow-origin': req.headers.origin ?? '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    };
    const json = (code, obj) => {
      const b = JSON.stringify(obj);
      res.writeHead(code, { ...cors, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(b) });
      res.end(b);
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    // ---- 探针自己的端点（优先：夹具内容由探针决定）----
    const ctx = { req, res, url, json, cors, vite, port: opts.port, repo, webRoot, label, origin: 'http://127.0.0.1:' + (opts.port ?? 0) };
    for (const r of routeList) {
      if (!r.when(url, req)) continue;
      const handled = await r.handle(ctx);
      if (handled !== false) return undefined;
    }

    // ---- 内建：够真应用启动的最小壳 ----
    if (p === '/api/health') return json(200, health);
    if (p === '/api/status') return json(200, status);
    if (p === '/api/sessions') return json(200, sessionsBody);
    if (p === '/api/workspaces') return json(200, workspacesBody);
    if (p === '/api/events') {
      res.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      return undefined;
    }
    if (SHELL_PATHS.includes(p)) return json(200, shellBody);
    if (p === '/auth/check') return json(200, { ok: true, username: label });
    if (p === '/api/usage/ledger') return json(200, { ok: true, entries: [] });
    if (p === '/api/display-plugins') return json(200, { ok: true, disabled: [], config: {} });
    const mMsg = /^\/api\/sessions\/(.+)\/messages$/.exec(p);
    if (mMsg) return json(200, { ok: true, session: decodeURIComponent(mMsg[1]), messages: [] });
    const mCtx = /^\/api\/sessions\/(.+)\/context$/.exec(p);
    if (mCtx) return json(200, { ok: true, context: [] });

    // ---- 自定义首页（探针要自己的取证页时）----
    if (html !== null && p === '/') {
      res.writeHead(200, { ...cors, 'content-type': MIME['.html'] });
      return res.end(html);
    }

    // ---- Vite（TS/裸模块转换）----
    if (vite !== null && proxyPrefixes.some((pre) => p.startsWith(pre))) {
      try {
        const up = await fetch(vite + p + url.search, { headers: { origin: ctx.origin } });
        const body = Buffer.from(await up.arrayBuffer());
        res.writeHead(up.status, { ...cors, 'content-type': up.headers.get('content-type') ?? MIME['.js'] });
        return res.end(body);
      } catch (err) {
        res.writeHead(502, cors);
        return res.end('vite proxy failed: ' + String(err));
      }
    }

    // ---- 静态（异步读；不存在 / 是目录 ⇒ 404，不再可能抛未捕获的 EISDIR）----
    const rel = p === '/' ? '/index.html' : p;
    const full = join(webRoot, normalize(rel).replace(/^([.][.][/\\])+/, ''));
    const fullStat = await statOrNull(full);
    if (fullStat !== null && fullStat.isFile()) {
      res.writeHead(200, { ...cors, 'content-type': MIME[extname(full)] ?? 'application/octet-stream' });
      return res.end(await readFile(full));
    }
    if (spaFallback) {
      const index = join(webRoot, 'index.html');
      const indexStat = await statOrNull(index);
      if (indexStat !== null && indexStat.isFile()) {
        res.writeHead(200, { ...cors, 'content-type': MIME['.html'] });
        return res.end(await readFile(index));
      }
    }
    res.writeHead(404, cors);
    return res.end('not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', resolve);
  });

  let closed = null;
  return {
    server,
    label,
    repo,
    webRoot,
    port: opts.port,
    origin: 'http://127.0.0.1:' + opts.port,
    /**
     * 收尾：先掐掉所有在途连接（`/api/events` 是一条**永不结束**的 SSE 流，
     * 只 `server.close()` 会一直等它 ⇒ 句柄残留、进程不退出），再等 close 回调。
     * 幂等：重复调用拿到同一个 Promise。
     */
    close() {
      if (closed !== null) return closed;
      closed = new Promise((resolve) => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close(() => resolve());
      });
      return closed;
    },
  };
}

// ---- 截图 -------------------------------------------------------------------

/**
 * 截图落盘器：自己 mkdir、自己写文件、**返回路径**。
 * 探针里不再出现 base64 / Buffer / mkdir 这些与断言无关的噪音。
 *
 * @param {string} dir 落盘目录（默认 `tmp/<name>`，由探针给）
 */
export function createShots(dir) {
  let ready = null;
  return {
    dir,
    /** 目录只在第一次落盘前建一次。 */
    ensure() {
      if (ready === null) ready = ensureDir(dir);
      return ready;
    },
    path(name) { return join(dir, name); },
    /**
     * 抓一张 PNG 并落盘。
     * @param {object} page CdpPage
     * @param {string} name 文件名（如 `wrap-on-narrow.png`）
     * @param {object} [opts] `{ clip, full }`：`clip` 走 CDP 的裁剪，`full` 截图超出视口的部分。
     */
    async save(page, name, opts = {}) {
      await this.ensure();
      const params = { format: 'png', captureBeyondViewport: opts.full === true };
      if (opts.clip !== undefined) params.clip = opts.clip;
      const shot = await page.send('Page.captureScreenshot', params);
      const file = join(dir, name);
      await writeFile(file, Buffer.from(shot.data, 'base64'));
      return file;
    },
  };
}

/** 一次性截图（不需要复用落盘器时）。 */
export async function shot(page, dir, name, opts) {
  return createShots(dir).save(page, name, opts);
}

// ---- CDP 输入助手 -----------------------------------------------------------

/**
 * 真输入原语：**让浏览器自己产生事件**（isTrusted=true），而不是页内 `element.click()`。
 * 与页内脚本的差别是探针能不能测「用户路径」的分界线 ——
 * 滚轮落在**指针位置**、Tab 走**真实焦点顺序**、Enter/Space 触发**默认行为**。
 *
 * @param {object} page CdpPage
 * @param {object} [opts] `{ sleep }` 可注入（默认本模块的 sleep）
 */
export function createInput(page, opts = {}) {
  const wait = opts.sleep ?? sleep;
  /**
   * 「元素」参数的两种写法：`'#id' / '.cls' / '[attr]'` 当**选择器**，
   * 其余字符串当**页内表达式**（探针常需要 `window.__x.pane.el` 这种非选择器取法）。
   * `{ sel }` / `{ expr }` 是显式写法，`{ x, y }` 直接用坐标。
   */
  const elemExpr = (at) => {
    if (typeof at !== 'string') return null;
    if (at.startsWith('{') || at.startsWith('(')) return at;
    return /^[#.[]/.test(at) ? 'document.querySelector(' + JSON.stringify(at) + ')' : '(' + at + ')';
  };
  /** 页内表达式的元素 → 视口中心点（滚轮/点击都按指针位置派发）。 */
  const centerOf = async (at) => {
    const sel = typeof at === 'object' && at !== null ? at.sel : undefined;
    const expr = sel !== undefined ? 'document.querySelector(' + JSON.stringify(sel) + ')' : elemExpr(at);
    return page.eval(
      '(function () { var r = (' + expr + ').getBoundingClientRect();'
      + ' return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()',
    );
  };
  const api = {
    page,
    sleep: wait,
    /** 元素（选择器 / 表达式 / `{x,y}`）→ 视口坐标。 */
    async point(at) {
      if (typeof at === 'object' && at !== null && typeof at.x === 'number' && typeof at.y === 'number') return at;
      return centerOf(at);
    },
    async moveTo(x, y, extra = {}) {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, ...extra });
    },
    /**
     * 真滚轮：先把指针移到目标元素中心（滚轮按指针位置派发），再连发 `times` 次。
     * @param {number} deltaY 负 = 向上滚
     * @param {number} times 次数
     * @param {object} [o] `{ at, stepMs }`：`at` 是元素表达式（默认整个文档）
     */
    async wheel(deltaY, times, o = {}) {
      const pt = await api.point(o.at ?? 'document.documentElement');
      await api.moveTo(pt.x, pt.y);
      for (let i = 0; i < times; i += 1) {
        await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: 0, deltaY, buttons: 0 });
        await wait(o.stepMs ?? 40);
      }
      return pt;
    },
    /** 在坐标处真按下 + 真释放（真 hit-test）。 */
    async clickAt(x, y, o = {}) {
      const button = o.button ?? 'left';
      const clickCount = o.clickCount ?? 1;
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount, buttons: 1, ...(o.modifiers ? { modifiers: o.modifiers } : {}) });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount, buttons: 0, ...(o.modifiers ? { modifiers: o.modifiers } : {}) });
      return { x, y };
    },
    /** 真点击一个元素（正中）。 */
    async click(at, o = {}) {
      const pt = await api.point(at);
      if (o.hover !== false) await api.moveTo(pt.x, pt.y, o.button === 'right' ? { button: 'none' } : {});
      await api.clickAt(pt.x, pt.y, o);
      return pt;
    },
    /**
     * 真按键。`text` 给了就走 `keyDown`（浏览器会当作可输入字符），
     * 不给就走 `rawKeyDown`（Tab / Tab 键那种不含文本的键）。
     */
    async press(key, code, vk, text) {
      const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
      await page.send('Input.dispatchKeyEvent', { type: text === undefined ? 'rawKeyDown' : 'keyDown', ...base, ...(text === undefined ? {} : { text }) });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    },
    /**
     * 真 Tab 走到目标：先把顺序焦点起点放到 `from`（目标的前一个可聚焦祖先），
     * 再一路按 Tab，直到 `document.activeElement` 命中 `selector`。
     * @returns {Promise<number>} 用了几次 Tab；走不到返回 -1
     */
    async tabTo(selector, o = {}) {
      const max = o.max ?? 6;
      if (o.from !== undefined) {
        const from = typeof o.from === 'object' && o.from !== null ? elemExpr('#' + o.from.id) : elemExpr(o.from);
        await page.eval('(function () { (' + from + ').focus(); return true; })()');
      }
      const sel = JSON.stringify(selector);
      for (let i = 1; i <= max; i += 1) {
        await api.press('Tab', 'Tab', 9);
        await wait(o.stepMs ?? 60);
        const at = await page.eval('(function () { return document.activeElement === document.querySelector(' + sel + '); })()');
        if (at === true) return i;
      }
      return -1;
    },
  };
  return api;
}

// ---- 浏览器 + verdict 表 -----------------------------------------------------

/**
 * 启动 headless Chrome，并把**控制台错误 / 未捕获异常**收进数组
 * （探针原来各写一遍 `page.on('Runtime.consoleAPICalled', …)`）。
 *
 * @param {object} opts `{ port, width, height, executablePath }`
 * @returns {Promise<{chrome, page, close, consoleErrors}>}
 */
export async function launchProbeChrome(opts = {}) {
  const chrome = await launchChrome({
    port: opts.port,
    width: opts.width ?? 1440,
    height: opts.height ?? 900,
    executablePath: opts.executablePath ?? process.env.W9111_CHROME,
  });
  const { page } = chrome;
  const consoleErrors = [];
  page.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') consoleErrors.push((p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' '));
  });
  page.on('Runtime.exceptionThrown', (p) => {
    consoleErrors.push('EXCEPTION ' + (p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? ''));
  });
  return { chrome, page, close: () => chrome.close(), consoleErrors };
}

/**
 * 探针的「量 + 报」壳：verdict 表收集 → PASS/FAIL 汇总 → 退出码。
 *
 * `verdict(ok, detail)` 的返回形状 `{ pass, detail }` 与各探针原来的本地实现**逐字相同**
 * —— 迁移不改变任何判据、阈值与文案，只把它们从 N 份拷贝收成一份。
 *
 * @param {object} opts
 * @param {string} [opts.title] 汇总行的标题（如 `W9333 真机取证`）
 * @param {string} [opts.shots] 截图目录（给了就有 `P.shots`）
 * @param {number} [opts.pad] verdict 名补白宽度（各探针原来 20 / 22 不一，保持原样）
 * @param {number} [opts.exitCodeOnFail] 有 FAIL 时的进程退出码（0 = 不设）
 */
export function createProbe(opts = {}) {
  const out = { consequences: {}, raw: {}, consoleErrors: [] };
  const shots = opts.shots === undefined ? null : createShots(opts.shots);
  const verdict = (ok, detail) => ({ pass: ok === true, detail });
  const failed = () => Object.entries(out.consequences).filter(([, v]) => !v.pass);
  return {
    out,
    verdict,
    shots,
    /** 记一条判定（`out.consequences[name] = verdict(ok, detail)` 的糖）。 */
    record(name, ok, detail) {
      const v = verdict(ok, detail);
      out.consequences[name] = v;
      return v;
    },
    /** `{ total, failed: [名字…] }`（有的探针把它写进 JSON 产物）。 */
    summary() {
      return { total: Object.keys(out.consequences).length, failed: failed().map(([k]) => k) };
    },
    /**
     * 收尾：落 JSON（可选）→ 打印 PASS/FAIL 表 → console 错误 → 汇总 → 退出码。
     *
     * @param {object} [o]
     * @param {string} [o.heading] 表头标题（省略不打印标题行）
     * @param {number} [o.pad] 名字补白宽度
     * @param {number[]} [o.consoleErrors] 默认 `out.consoleErrors`
     * @param {number} [o.consoleErrorsLimit] 只打印前 N 条
     * @param {string} [o.jsonPath] 把整份 `out` 写到这里
     * @param {boolean} [o.printJson] 是否把整份 `out` 打到 stdout
     * @param {string[]} [o.extraLines] 表格之后、console 错误之前追加的行
     * @param {string[]} [o.trailer] 汇总行之后追加的行
     * @param {number} [o.exitCodeOnFail] 覆盖构造时的默认值
     */
    async finish(o = {}) {
      const bad = failed();
      if (o.jsonPath !== undefined) {
        await ensureDir(dirname(o.jsonPath));
        await writeFile(o.jsonPath, JSON.stringify(out, null, 2));
      }
      if (o.printJson === true) console.log(JSON.stringify(out, null, 2));
      const title = o.heading ?? opts.title;
      if (title !== undefined) console.log('\n===== ' + title + ' =====');
      const pad = o.pad ?? opts.pad ?? 20;
      for (const [k, v] of Object.entries(out.consequences)) {
        console.log((v.pass ? 'PASS ' : 'FAIL ') + k.padEnd(pad) + v.detail);
      }
      for (const line of o.extraLines ?? []) console.log(line);
      const errs = o.consoleErrors ?? out.consoleErrors;
      const shown = o.consoleErrorsLimit === undefined ? errs : errs.slice(0, o.consoleErrorsLimit);
      console.log('consoleErrors: ' + (shown.length === 0 ? '(empty)' : JSON.stringify(shown)));
      console.log(bad.length === 0 ? '\n全部 PASS' : '\n' + bad.length + ' 条 FAIL');
      for (const line of o.trailer ?? []) console.log(line);
      const code = o.exitCodeOnFail ?? opts.exitCodeOnFail ?? 1;
      if (bad.length > 0 && code > 0) process.exitCode = code;
      return { total: Object.keys(out.consequences).length, failed: bad.map(([k]) => k) };
    },
  };
}
