#!/usr/bin/env node
// ============================================================================
// scripts/a11y/w2058-preview-probe.mjs — W2058：文件预览面板的**真机取证**探针
// ----------------------------------------------------------------------------
// 三件事，一次跑完，输出机器可读 JSON + 截图：
//   ① 【取证】截图里那个「markdown 徽标 + 展开按钮 + 行号」到底是谁的？
//      走**真入口** openFilePreview()（= 文件管理器行点击调用的那个函数），
//      读 DOM 实测：.code-badge 文本 / .code-fold 数量 / .cl 行数 / .preview-head 文本。
//   ② 【任务 B 门禁】预览面板与正文是否**覆盖**？
//      量 .preview-panel 与 #messages 的轴对齐矩形是否相交（本仓 modes.ts 的判定法）。
//   ③ 截图（桌面 / 触摸端各一张）。
//
// 用法：
//   pnpm --dir apps/web dev --port 3787 --strictPort      # 前置（本脚本只读 /src/**）
//   W9111_CHROME=<chrome-headless-shell> node scripts/a11y/w2058-preview-probe.mjs
//   W2058_TAG=before|after  node ...   # 前后对照标注（写进 JSON 与文件名）
//   W2058_TARGET=<绝对路径>  node ...  # 预览哪个文件（默认 tmp/dsh-archive-dryrun/REPORT.md）
//
// ★ 刻意不进门禁（与 ime-enter-guard.mjs / audit-touch-targets.mjs 同一取向）：
//   需要 Vite dev server + Chrome，不是确定性离线门禁。确定性断言在 tests/。
// ============================================================================
import http from 'node:http';
import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, extname, normalize, dirname, basename } from 'node:path';
import { launchChrome } from '../perf/lib/chrome.mjs';

const VITE = process.env.W9111_VITE ?? 'http://127.0.0.1:3787';
const REPO = process.env.W2058_REPO ?? new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const WEB = join(REPO, 'apps', 'web');
const TAG = process.env.W2058_TAG ?? 'unknown';
const TARGET = process.env.W2058_TARGET ?? join(REPO, 'tmp', 'dsh-archive-dryrun', 'REPORT.md');
const SHOTS = process.env.W2058_SHOTS ?? '/tmp/w2058-preview';
const PORT = Number(process.env.W2058_PORT ?? 3814);
const CDP = Number(process.env.W2058_CDP_PORT ?? 9474);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SHOTS, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.ts': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
};

/** 真·行窗口读（与 apps/studio/src/handlers/fs-read.ts 同口径：1-based offset + limit）。 */
function readWindow(abs, offset, limit) {
  const raw = readFileSync(abs, 'utf8');
  const lines = raw.split('\n');
  const totalLines = raw.endsWith('\n') ? lines.length - 1 : lines.length;
  const from = Math.max(1, offset) - 1;
  const slice = lines.slice(from, from + limit);
  const text = slice.join('\n') + (from + slice.length < lines.length ? '\n' : '');
  const readLines = slice.length;
  return { text, offset, limit, totalLines, truncated: from + readLines < lines.length };
}

function startFixture() {
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

    // ---- 真文件系统的两个端点（预览面板唯一的两个数据来源） ----
    if (p === '/api/fs/list') {
      const dir = url.searchParams.get('path') ?? '';
      if (!existsSync(dir)) return json(200, { path: dir, entries: [], truncated: false, error: 'not found' });
      const names = readFileSync('/dev/null'); // unreachable
      return json(200, { path: dir, entries: [], truncated: false });
    }
    if (p === '/api/fs/read') {
      const abs = url.searchParams.get('path') ?? '';
      if (!existsSync(abs)) return json(200, { kind: 'text', text: '', offset: 1, limit: 0, totalLines: 0, truncated: false, error: 'ENOENT' });
      const offset = Number(url.searchParams.get('offset') ?? '1') || 1;
      const limit = Number(url.searchParams.get('limit') ?? '2000') || 2000;
      return json(200, { kind: 'text', ...readWindow(abs, offset, limit) });
    }

    // ---- 最小应用壳所需端点 ----
    if (p === '/api/health') return json(200, { ok: true, name: 'w2058-fixture', model: 'w2058', base_url: 'http://127.0.0.1:' + PORT, bind: '127.0.0.1:' + PORT, capabilities: {} }, cors);
    if (p === '/api/status') return json(200, { model: 'w2058', reasoning_effort: null, steps: 0, tokens_per_sec: 0, context_usage: { used: 0, window: 1000000, ratio: 0 }, usage: {}, session: 'w2058/main', busy: false }, cors);
    if (p === '/api/sessions') return json(200, { sessions: [{ id: 'w2058/main', title: 'W2058 取证', kind: 'session', busy: false, active: true, events: 0, workspace: 'w2058' }], active_session: 'w2058/main' }, cors);
    if (p === '/api/workspaces') return json(200, { workspaces: [{ name: 'w2058', path: dirname(dirname(TARGET)), sessions: 1 }], active_session: 'w2058/main' }, cors);
    if (p === '/api/events') { res.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); return; }
    for (const q of ['/api/config', '/api/providers', '/api/prompts', '/api/tools', '/api/plugins', '/api/permissions/presets', '/api/questions']) {
      if (p === q) return json(200, { ok: true, model: 'w2058', available: { models: [], efforts: [] }, providers: [], prompts: [], tools: [], plugins: [], presets: [], questions: [], disabled: [], messages: [] }, cors);
    }
    if (p === '/auth/check') return json(200, { ok: true, username: 'w2058' }, cors);
    if (p === '/api/usage/ledger') return json(200, { ok: true, entries: [] }, cors);
    const mMsg = /^\/api\/sessions\/(.+)\/messages$/.exec(p);
    if (mMsg) return json(200, { ok: true, session: decodeURIComponent(mMsg[1]), messages: [] }, cors);
    const mCtx = /^\/api\/sessions\/(.+)\/context$/.exec(p);
    if (mCtx) return json(200, { ok: true, context: [] }, cors);

    // ---- Vite（TS 转换） ----
    if (p.startsWith('/src/') || p.startsWith('/@') || p.startsWith('/node_modules/')) {
      try {
        const up = await fetch(VITE + p + url.search, { headers: { origin: 'http://127.0.0.1:' + PORT } });
        const body = Buffer.from(await up.arrayBuffer());
        res.writeHead(up.status, { ...cors, 'content-type': up.headers.get('content-type') ?? 'text/javascript; charset=utf-8' });
        return res.end(body);
      } catch (err) { res.writeHead(502, cors); return res.end('vite proxy failed: ' + String(err)); }
    }
    // ---- 静态 ----
    const rel = p === '/' ? '/index.html' : p;
    const full = join(WEB, normalize(rel).replace(/^([.][.][/\\])+/, ''));
    if (existsSync(full) && statSync(full).isFile()) {
      res.writeHead(200, { ...cors, 'content-type': MIME[extname(full)] ?? 'application/octet-stream' });
      return res.end(readFileSync(full));
    }
    if (existsSync(join(WEB, 'index.html'))) {
      res.writeHead(200, { ...cors, 'content-type': MIME['.html'] });
      return res.end(readFileSync(join(WEB, 'index.html')));
    }
    res.writeHead(404, cors); res.end('not found');
  });
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)));
}

/** 页内探针：读 DOM 实测值 + 矩形相交判定。 */
const PROBE = `(function () {
  var q = function (s) { return document.querySelector(s); };
  var qa = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var rect = function (el) { if (!el) return null; var r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
  var inter = function (a, b) { if (!a || !b) return null;
    var w = Math.min(a.right, b.right) - Math.max(a.x, b.x);
    var h = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
    return { overlapX: Math.max(0, w), overlapY: Math.max(0, h), intersects: w > 0 && h > 0 }; };
  var host = q('.preview-host'), panel = q('.preview-panel'), msgs = q('#messages'), main = q('#main'), body = q('.preview-body');
  var folds = qa('.preview-body .code-fold');
  var badges = qa('.preview-body .code-badge');
  var badgesAnywhere = qa('.code-badge');
  return {
    previewOpen: host !== null && !host.classList.contains('hidden'),
    hostRect: rect(host), panelRect: rect(panel), messagesRect: rect(msgs), mainRect: rect(main),
    panelVsMessages: inter(rect(panel), rect(msgs)),
    panelVsMain: inter(rect(panel), rect(main)),
    hostPosition: host ? getComputedStyle(host).position : null,
    hostWidth: host ? getComputedStyle(host).width : null,
    hostPointerEvents: host ? getComputedStyle(host).pointerEvents : null,
    panelPointerEvents: panel ? getComputedStyle(panel).pointerEvents : null,
    headText: (q('.preview-head') ? q('.preview-head').textContent : '').trim(),
    headRect: rect(q('.preview-head')),
    headHeight: q('.preview-head') ? Math.round(q('.preview-head').getBoundingClientRect().height) : null,
    pathText: q('.preview-path') ? q('.preview-path').textContent : null,
    titleText: q('.preview-title') ? q('.preview-title').textContent : null,
    foldCountInPreview: folds.length,
    foldTextsInPreview: folds.map(function (b) { return b.textContent; }),
    badgeCountInPreview: badges.length,
    badgeTextsInPreview: badges.map(function (b) { return b.textContent; }),
    badgeCountDocument: badgesAnywhere.length,
    lineCountInPreview: qa('.preview-body .cl').length,
    previewCodeBlocks: qa('.preview-body pre').length,
    streamNote: q('.preview-stream-note') && !q('.preview-stream-note').classList.contains('hidden') ? q('.preview-stream-note').textContent : '',
    bodyScrollHeight: body ? body.scrollHeight : null,
    bodyClientHeight: body ? body.clientHeight : null,
    wbHostRect: rect(q('.wb-host')), wbPanels: qa('.wb-panel').length,
    viewport: { w: window.innerWidth, h: window.innerHeight }
  };
})()`;

const main = async () => {
  const server = await startFixture();
  const chrome = await launchChrome({ port: CDP, width: 1440, height: 900 });
  const { page } = chrome;
  const consoleErrors = [];
  page.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') consoleErrors.push((p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ')); });
  page.on('Runtime.exceptionThrown', (p) => { consoleErrors.push('EXCEPTION ' + (p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '')); });
  const out = { tag: TAG, target: TARGET, viewports: {}, consoleErrors };
  try {
    await page.navigate('http://127.0.0.1:' + PORT + '/');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(1500);
    // ★ 真入口：文件管理器行点击调用的就是 openFilePreview()。
    await page.eval('(async function(){ var m = await import("/src/ui/workbench/files-open.ts"); window.__w2058 = m; m.openFilePreview(' + JSON.stringify(TARGET) + '); return true; })()');
    await sleep(2500);
    for (const vp of [{ name: 'desktop', w: 1440, h: 900, touch: false }, { name: 'touch', w: 390, h: 844, touch: true }]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.touch });
      if (vp.touch) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await sleep(700);
      out.viewports[vp.name] = await page.eval(PROBE);
      const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const f = join(SHOTS, TAG + '-' + vp.name + '.png');
      writeFileSync(f, Buffer.from(shot.data, 'base64'));
      out.viewports[vp.name].screenshot = f;
    }
    out.consoleErrors = consoleErrors;
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await chrome.close();
    await new Promise((r) => server.close(r));
  }
};
main().catch((e) => { console.error('probe failed:', e); process.exit(1); });
