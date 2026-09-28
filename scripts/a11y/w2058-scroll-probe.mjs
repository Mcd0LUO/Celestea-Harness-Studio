#!/usr/bin/env node
// ============================================================================
// scripts/a11y/w2058-scroll-probe.mjs — W2058 真机：长文件滚动 + 与工作台共存
// ----------------------------------------------------------------------------
// 补三件 probe 没覆盖的事（用户要求「一个长文件（任务 B 的滚动）」）：
//   ① 长文件（.md，>400 行）在**停靠面板**里真的可滚（scrollHeight > clientHeight，
//      且滚到底后 scrollTop 真的变了）；
//   ② 面板高度 = #main 高（停靠栏撑满），不是内容高；
//   ③ 与工作台右栏**共存**：先开 files 面板（dock=right），再开预览，
//      量两者矩形 —— 必须**零重叠**（这是本轮最容易打架的一处）。
// 用法：W9111_CHROME=<chrome> node scripts/a11y/w2058-scroll-probe.mjs
// ============================================================================
import http from 'node:http';
import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { launchChrome } from '../perf/lib/chrome.mjs';

const VITE = process.env.W9111_VITE ?? 'http://127.0.0.1:3787';
const REPO = process.env.W2058_REPO ?? new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const WEB = join(REPO, 'apps', 'web');
const TARGET = process.env.W2058_TARGET ?? join(REPO, 'docs', 'ARCHITECTURE.md');
const WSROOT = dirname(TARGET);
const SHOTS = process.env.W2058_SHOTS ?? '/tmp/w2058-preview';
const PORT = Number(process.env.W2058_PORT ?? 3816);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SHOTS, { recursive: true });
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.ts':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml' };

function readWindow(abs, offset, limit) {
  const raw = readFileSync(abs, 'utf8');
  const lines = raw.split('\n');
  const totalLines = raw.endsWith('\n') ? lines.length - 1 : lines.length;
  const from = Math.max(1, offset) - 1;
  const slice = lines.slice(from, from + limit);
  return { text: slice.join('\n') + (from + slice.length < lines.length ? '\n' : ''), offset, limit, totalLines, truncated: from + slice.length < lines.length };
}
function listDir(dir) {
  const { readdirSync } = require('node:fs');
  return [];
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const p = url.pathname;
  const cors = { 'access-control-allow-origin': req.headers.origin ?? '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS' };
  const json = (c, o) => { const b = JSON.stringify(o); res.writeHead(c, { ...cors, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(b) }); res.end(b); };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (p === '/api/fs/read') { const abs = url.searchParams.get('path') ?? ''; if (!existsSync(abs)) return json(200, { kind:'text', text:'', offset:1, limit:0, totalLines:0, truncated:false, error:'ENOENT' });
    return json(200, { kind: 'text', ...readWindow(abs, Number(url.searchParams.get('offset') ?? 1) || 1, Number(url.searchParams.get('limit') ?? 2000) || 2000) }); }
  if (p === '/api/fs/list') {
    const dir = url.searchParams.get('path') ?? WSROOT;
    const { readdirSync } = await import('node:fs');
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).slice(0, 50).map((e) => {
        let size = null, mtime = null;
        try { const st = statSync(join(dir, e.name)); size = st.size; mtime = new Date(st.mtimeMs).toISOString(); } catch {}
        return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size, mtime };
      });
    } catch {}
    return json(200, { path: dir, parent: dirname(dir), entries, roots: [WSROOT], truncated: false });
  }
  if (p === '/api/health') return json(200, { ok:true, name:'x', model:'x', base_url:'', bind:'', capabilities:{} }, cors);
  if (p === '/api/status') return json(200, { model:'x', reasoning_effort:null, steps:0, tokens_per_sec:0, context_usage:{used:0,window:1000000,ratio:0}, usage:{}, session:'w/main', busy:false }, cors);
  if (p === '/api/sessions') return json(200, { sessions:[{ id:'w/main', title:'W2058', kind:'session', busy:false, active:true, events:0, workspace:'w' }], active_session:'w/main' }, cors);
  if (p === '/api/workspaces') return json(200, { workspaces:[{ name:'w', path: WSROOT, sessions:1 }], active_session:'w/main' }, cors);
  if (p === '/api/events') { res.writeHead(200, { ...cors, 'content-type':'text/event-stream','cache-control':'no-cache',connection:'keep-alive' }); return; }
  for (const q of ['/api/config','/api/providers','/api/prompts','/api/tools','/api/plugins','/api/permissions/presets','/api/questions']) if (p === q) return json(200, { ok:true, model:'x', available:{models:[],efforts:[]}, providers:[], prompts:[], tools:[], plugins:[], presets:[], questions:[], disabled:[], messages:[] }, cors);
  if (p === '/auth/check') return json(200, { ok:true, username:'w' }, cors);
  if (p === '/api/usage/ledger') return json(200, { ok:true, entries:[] }, cors);
  const m = /^\/api\/sessions\/(.+)\/(messages|context)$/.exec(p); if (m) return json(200, m[2] === 'messages' ? { ok:true, session:m[1], messages:[] } : { ok:true, context:[] }, cors);
  if (p.startsWith('/src/') || p.startsWith('/@') || p.startsWith('/node_modules/')) {
    try { const up = await fetch(VITE + p + url.search, { headers: { origin: 'http://127.0.0.1:' + PORT } }); const b = Buffer.from(await up.arrayBuffer());
      res.writeHead(up.status, { ...cors, 'content-type': up.headers.get('content-type') ?? 'text/javascript; charset=utf-8' }); return res.end(b); } catch (e) { res.writeHead(502, cors); return res.end('vite fail ' + e); } }
  const rel = p === '/' ? '/index.html' : p;
  const full = join(WEB, normalize(rel).replace(/^([.][.][/\\])+/, ''));
  if (existsSync(full) && statSync(full).isFile()) { res.writeHead(200, { ...cors, 'content-type': MIME[extname(full)] ?? 'application/octet-stream' }); return res.end(readFileSync(full)); }
  if (existsSync(join(WEB, 'index.html'))) { res.writeHead(200, { ...cors, 'content-type': MIME['.html'] }); return res.end(readFileSync(join(WEB, 'index.html'))); }
  res.writeHead(404, cors); res.end('nf');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const chrome = await launchChrome({ port: 9476, width: 1440, height: 900 });
const { page } = chrome;
const errs = [];
page.on('Runtime.consoleAPICalled', (x) => { if (x.type === 'error') errs.push((x.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')); });
page.on('Runtime.exceptionThrown', (x) => { errs.push('EXCEPTION ' + (x.exceptionDetails?.exception?.description ?? '')); });
try {
  await page.navigate('http://127.0.0.1:' + PORT + '/');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(1500);
  // ① 先开工作台 files 面板（dock=right），② 再从它的行点击打开预览
  await page.eval('(async function(){ var wb = await import("/src/ui/workbench/index.ts"); wb.initWorkbench(); var st = await import("/src/ui/workbench/state.ts"); st.openPanel("files", "right"); return true; })()');
  await sleep(1200);
  await page.eval('(async function(){ var m = await import("/src/ui/workbench/files-open.ts"); m.openFilePreview(' + JSON.stringify(TARGET) + '); return true; })()');
  await sleep(2500);
  const before = await page.eval(`(function(){
    var b = document.querySelector('.preview-body');
    var p = document.querySelector('.preview-panel'), wbh = document.querySelector('.wb-host'), wbp = document.querySelector('.wb-panel');
    var main = document.getElementById('main');
    var r = function(e){ if(!e) return null; var x=e.getBoundingClientRect(); return {x:Math.round(x.x),y:Math.round(x.y),w:Math.round(x.width),h:Math.round(x.height),right:Math.round(x.right),bottom:Math.round(x.bottom)}; };
    var inter=function(a,c){ if(!a||!c) return null; var w=Math.min(a.right,c.right)-Math.max(a.x,c.x); var h=Math.min(a.bottom,c.bottom)-Math.max(a.y,c.y); return {ox:Math.max(0,w),oy:Math.max(0,h),hit:w>0&&h>0}; };
    var pr=r(p), wr=r(wbp), mr=r(main);
    return {
      panel: pr, wbPanel: wr, main: mr,
      panelVsWb: inter(pr, wr),
      panelTop: pr && pr.y, mainTop: mr && mr.y, panelBottom: pr && pr.bottom, mainBottom: mr && mr.bottom,
      bodyScrollH: b && b.scrollHeight, bodyClientH: b && b.clientHeight,
      canScroll: b ? b.scrollHeight > b.clientHeight : false,
      scrollTop0: b && b.scrollTop,
      lines: document.querySelectorAll('.preview-body .cl').length,
      folds: document.querySelectorAll('.preview-body .code-fold').length,
      badge: (document.querySelector('.preview-body .code-badge')||{}).textContent,
      mainPadRight: getComputedStyle(main).paddingRight,
      wbHostRight: getComputedStyle(wbh).right
    };
  })()`);
  // 滚到底：证明长文件在停靠面板里真的能滚
  const after = await page.eval(`(function(){
    var b = document.querySelector('.preview-body');
    b.scrollTop = b.scrollHeight;
    return { scrollTop: b.scrollTop, scrollH: b.scrollHeight, clientH: b.clientHeight };
  })()`);
  await sleep(400);
  const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(SHOTS, 'scroll-coexist.png'), Buffer.from(shot.data, 'base64'));
  console.log(JSON.stringify({ target: TARGET, before, after, consoleErrors: errs, shot: join(SHOTS, 'scroll-coexist.png') }, null, 2));
} finally { await chrome.close(); await new Promise((r) => server.close(r)); }
