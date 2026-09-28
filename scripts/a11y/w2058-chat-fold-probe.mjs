#!/usr/bin/env node
// ============================================================================
// scripts/a11y/w2058-chat-fold-probe.mjs — W2058 真机：**聊天侧折叠必须完好**
// ----------------------------------------------------------------------------
// 任务 A 的范围是 (a) 只取消**预览**里的折叠。这条探针守反面：
//   聊天正文里一个 >30 行的代码块，**必须仍然**有「展开」按钮且默认折叠。
//   同一次运行里再开一个预览，断言那边**没有**折叠按钮 —— 两侧在同一页面、
//   同一份增强链、同一时刻对照，排除「code-extras 整个没挂」这种假绿。
// 用法：W9111_CHROME=<chrome> node scripts/a11y/w2058-chat-fold-probe.mjs
// ============================================================================
import http from 'node:http';
import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { launchChrome } from '../perf/lib/chrome.mjs';

const VITE = process.env.W9111_VITE ?? 'http://127.0.0.1:3787';
const REPO = process.env.W2058_REPO ?? new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const WEB = join(REPO, 'apps', 'web');
const TARGET = process.env.W2058_TARGET ?? join(REPO, 'docs', 'ARCHITECTURE.md');
const SHOTS = process.env.W2058_SHOTS ?? '/tmp/w2058-preview';
const PORT = Number(process.env.W2058_PORT ?? 3817);
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
/** 聊天夹具：一条 assistant 消息，正文里一个 40 行的 fenced 代码块。 */
const CODE = Array.from({ length: 40 }, (_, i) => 'const line' + i + ' = ' + i + ';').join('\n');
const BODY = '这里是一段很长的示例：\n\n```ts\n' + CODE + '\n```\n\n上面就是全部。';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const p = url.pathname;
  const cors = { 'access-control-allow-origin': req.headers.origin ?? '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS' };
  const json = (c, o) => { const b = JSON.stringify(o); res.writeHead(c, { ...cors, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(b) }); res.end(b); };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (p === '/api/fs/read') { const abs = url.searchParams.get('path') ?? ''; if (!existsSync(abs)) return json(200, { kind:'text', text:'', offset:1, limit:0, totalLines:0, truncated:false, error:'ENOENT' });
    return json(200, { kind: 'text', ...readWindow(abs, Number(url.searchParams.get('offset') ?? 1) || 1, Number(url.searchParams.get('limit') ?? 2000) || 2000) }); }
  if (p === '/api/health') return json(200, { ok:true, name:'x', model:'x', base_url:'', bind:'', capabilities:{} }, cors);
  if (p === '/api/status') return json(200, { model:'x', reasoning_effort:null, steps:0, tokens_per_sec:0, context_usage:{used:0,window:1000000,ratio:0}, usage:{}, session:'w/main', busy:false }, cors);
  if (p === '/api/sessions') return json(200, { sessions:[{ id:'w/main', title:'W2058', kind:'session', busy:false, active:true, events:0, workspace:'w' }], active_session:'w/main' }, cors);
  if (p === '/api/workspaces') return json(200, { workspaces:[{ name:'w', path: dirname(TARGET), sessions:1 }], active_session:'w/main' }, cors);
  if (p === '/api/events') { res.writeHead(200, { ...cors, 'content-type':'text/event-stream','cache-control':'no-cache',connection:'keep-alive' }); return; }
  for (const q of ['/api/config','/api/providers','/api/prompts','/api/tools','/api/plugins','/api/permissions/presets','/api/questions']) if (p === q) return json(200, { ok:true, model:'x', available:{models:[],efforts:[]}, providers:[], prompts:[], tools:[], plugins:[], presets:[], questions:[], disabled:[], messages:[] }, cors);
  if (p === '/auth/check') return json(200, { ok:true, username:'w' }, cors);
  if (p === '/api/usage/ledger') return json(200, { ok:true, entries:[] }, cors);
  const m = /^\/api\/sessions\/(.+)\/messages$/.exec(p);
  if (m) return json(200, { ok:true, session:m[1], messages:[{ role:'assistant', content: BODY }] }, cors);
  const mc = /^\/api\/sessions\/(.+)\/context$/.exec(p); if (mc) return json(200, { ok:true, context:[] }, cors);
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
const chrome = await launchChrome({ port: 9477, width: 1440, height: 900 });
const { page } = chrome;
const errs = [];
page.on('Runtime.consoleAPICalled', (x) => { if (x.type === 'error') errs.push((x.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')); });
page.on('Runtime.exceptionThrown', (x) => { errs.push('EXCEPTION ' + (x.exceptionDetails?.exception?.description ?? '')); });
try {
  await page.navigate('http://127.0.0.1:' + PORT + '/');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(2500); // 等历史恢复把聊天正文画出来
  const chat = await page.eval(`(function(){
    var c = document.querySelector('#messages .content') || document.querySelector('.content');
    return {
      contentFound: c !== null,
      fold: c ? c.querySelectorAll('.code-fold').length : -1,
      foldText: c && c.querySelector('.code-fold') ? c.querySelector('.code-fold').textContent : null,
      folded: c ? c.querySelectorAll('.code-folded').length : -1,
      cl: c ? c.querySelectorAll('.cl').length : -1,
      badge: c && c.querySelector('.code-badge') ? c.querySelector('.code-badge').textContent : null,
      copy: c ? c.querySelectorAll('.code-copy').length : -1
    };
  })()`);
  await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }).then(async (s) => writeFileSync(join(SHOTS, 'chat-fold.png'), Buffer.from(s.data, 'base64')));
  // 同一页再开预览：那边必须没有折叠
  await page.eval('(async function(){ var m = await import("/src/ui/workbench/files-open.ts"); m.openFilePreview(' + JSON.stringify(TARGET) + '); return true; })()');
  await sleep(2500);
  const preview = await page.eval(`(function(){
    var b = document.querySelector('.preview-body');
    return { found: b !== null, fold: b ? b.querySelectorAll('.code-fold').length : -1, badge: b && b.querySelector('.code-badge') ? b.querySelector('.code-badge').textContent : null, cl: b ? b.querySelectorAll('.cl').length : -1 };
  })()`);
  const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(SHOTS, 'chat-plus-preview.png'), Buffer.from(shot.data, 'base64'));
  console.log(JSON.stringify({ chat, preview, consoleErrors: errs, shots: [join(SHOTS,'chat-fold.png'), join(SHOTS,'chat-plus-preview.png')] }, null, 2));
} finally { await chrome.close(); await new Promise((r) => server.close(r)); }
