#!/usr/bin/env node
// ============================================================================
// scripts/a11y/w9329-workbench-probe.mjs — W9329：工作台面板的**真机取证**探针
// ----------------------------------------------------------------------------
// 量的是**重做后的真应用**（不是原型）。它承担两类事：
//   ① **jsdom 量不了的后果**全部在这里判 —— 本仓铁律 11 禁止用「钉 CSS 声明」
//      代替「钉后果」，而下面这些后果必须有**排版**才能量：
//        · 撑开时会话列**真的变窄**、且面板**不覆盖**它（矩形零重叠）；
//        · 「代码文本列宽 == 可用宽 − 行号列宽」这条等式**逐档精确成立**；
//        · 行号列宽**不随面板宽变化**（不参与收缩），且行号停在**第一视觉行**
//          （长行折行后不跑到中间去）；
//        · 换行**真的折行**：长行在窄容器里行高增长；**够宽时不增长**；
//        · 窄屏降级后 #main **仍可读**（不被挤到 0），且面板**整块在视口内**
//          （原型在这里有 53px 溢出视口的真 bug，本轮修掉并锚住）。
//   ② 流式**分块追加**的原始数字 + 页脚如实（进度 == 实际画出的行数）。
//
// 用法：
//   pnpm --dir apps/web dev --port 3787 --strictPort       # 前置（本脚本只读 /src/**）
//   W9111_CHROME=<chrome-headless-shell> node scripts/a11y/w9329-workbench-probe.mjs
//
// ★ 刻意不进门禁（与 w2058-preview-probe.mjs 同一取向）：需要 Vite dev server +
//   Chrome。确定性断言在 tests/w9329-workbench-squeeze.test.ts。
// ============================================================================
import http from 'node:http';
// ★ W9323：本探针自带一个本地 HTTP 服务器，**请求处理器里不许有同步阻塞调用**
//   （会把事件循环冻到 syscall 返回）。所以 fs 一律走 fs/promises：
//   existsSync → statOrNull()（fs/promises 没有 exists）、readdirSync → readdir、
//   statSync → stat、readFileSync → readFile、writeFileSync/mkdirSync → writeFile/mkdir。
//   顶层那句 mkdir 也走 await（ESM 支持顶层 await），这样本文件**不再 import 任何
//   同步 fs**——从源头上不可能再引入同类违规（而不是靠记得）。
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from '../perf/lib/chrome.mjs';

const VITE = process.env.W9111_VITE ?? 'http://127.0.0.1:3787';
// ★ Windows：import.meta.url 是 file:///D:/...，直接 pathname 会得到 '/D:/...'，
//   再 join 就变成 'D:\D:\...'（ENOENT）。必须经 fileURLToPath 规范化。
const REPO = process.env.W9329_REPO ?? fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '');
const WEB = join(REPO, 'apps', 'web');
const SHOTS = process.env.W9329_SHOTS ?? join(REPO, 'tmp', 'w9329-probe');
const PORT = Number(process.env.W9329_PORT ?? 3829);
const CDP = Number(process.env.W9329_CDP_PORT ?? 9482);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await mkdir(SHOTS, { recursive: true });

/** stat 的「可能不存在」形态（fs/promises 故意没有 exists）。 */
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
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
};

const TMP = join(REPO, 'tmp');
/** 巨文件（流式 + 分块追加）。20 万行：2 万行在本地盘 <200ms 就读完，抓不到中间态。 */
const HUGE = join(TMP, 'w9329-huge.ts');
/** 200 字符长行：窄容器放不下 ⇒ 换行开关的「折行」后果可判。 */
const LONGLINE = join(TMP, 'w9329-longline.ts');
/** 短行文件：任何面板宽都放得下 ⇒ 换行开关「不该有影响」的对照。 */
const SHORTLINES = join(TMP, 'w9329-shortlines.ts');

/** 真·行窗口读（与 apps/studio/src/handlers/fs-read.ts 同口径：1-based offset + limit）。 */
async function readWindow(abs, offset, limit) {
  const raw = await readFile(abs, 'utf8');
  const lines = raw.split('\n');
  const totalLines = raw.endsWith('\n') ? lines.length - 1 : lines.length;
  const from = Math.max(1, offset) - 1;
  const slice = lines.slice(from, from + limit);
  const text = slice.join('\n') + (from + slice.length < lines.length ? '\n' : '');
  return { text, offset, limit, totalLines, truncated: from + slice.length < lines.length };
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

    if (p === '/api/fs/list') {
      const dir = url.searchParams.get('path') ?? '';
      const dirStat = await statOrNull(dir);
      if (dirStat === null || !dirStat.isDirectory()) return json(200, { path: dir, entries: [], truncated: false, error: 'not found' });
      const dirents = await readdir(dir, { withFileTypes: true });
      const entries = [];
      for (const e of dirents) {
        if (!e.isFile()) continue;
        const s = await statOrNull(join(dir, e.name));
        if (s === null) continue;
        entries.push({ name: e.name, type: 'file', size: s.size, mtime: new Date(s.mtimeMs).toISOString() });
      }
      return json(200, { path: dir, entries, truncated: false });
    }
    if (p === '/api/fs/read') {
      const abs = url.searchParams.get('path') ?? '';
      const absStat = await statOrNull(abs);
      if (absStat === null || !absStat.isFile()) return json(200, { kind: 'text', text: '', offset: 1, limit: 0, totalLines: 0, truncated: false, error: 'ENOENT' });
      const offset = Number(url.searchParams.get('offset') ?? '1') || 1;
      const limit = Number(url.searchParams.get('limit') ?? '2000') || 2000;
      return json(200, { kind: 'text', ...(await readWindow(abs, offset, limit)) });
    }

    if (p === '/api/health') return json(200, { ok: true, name: 'w9329', model: 'w9329', base_url: 'http://127.0.0.1:' + PORT, bind: '127.0.0.1:' + PORT, capabilities: {} }, cors);
    if (p === '/api/status') return json(200, { model: 'w9329', reasoning_effort: null, steps: 0, tokens_per_sec: 0, context_usage: { used: 0, window: 1000000, ratio: 0 }, usage: {}, session: 'w9329/main', busy: false }, cors);
    if (p === '/api/sessions') return json(200, { sessions: [{ id: 'w9329/main', title: 'W9329 取证', kind: 'session', busy: false, active: true, events: 0, workspace: 'w9329' }], active_session: 'w9329/main' }, cors);
    if (p === '/api/workspaces') return json(200, { workspaces: [{ name: 'w9329', path: REPO, sessions: 1 }], active_session: 'w9329/main' }, cors);
    if (p === '/api/events') { res.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); return; }
    for (const q of ['/api/config', '/api/providers', '/api/prompts', '/api/tools', '/api/plugins', '/api/permissions/presets', '/api/questions']) {
      if (p === q) return json(200, { ok: true, model: 'w9329', available: { models: [], efforts: [] }, providers: [], prompts: [], tools: [], plugins: [], presets: [], questions: [], disabled: [], messages: [] }, cors);
    }
    if (p === '/auth/check') return json(200, { ok: true, username: 'w9329' }, cors);
    if (p === '/api/usage/ledger') return json(200, { ok: true, entries: [] }, cors);
    const mMsg = /^\/api\/sessions\/(.+)\/messages$/.exec(p);
    if (mMsg) return json(200, { ok: true, session: decodeURIComponent(mMsg[1]), messages: [] }, cors);
    const mCtx = /^\/api\/sessions\/(.+)\/context$/.exec(p);
    if (mCtx) return json(200, { ok: true, context: [] }, cors);

    if (p.startsWith('/src/') || p.startsWith('/@') || p.startsWith('/node_modules/')) {
      try {
        const up = await fetch(VITE + p + url.search, { headers: { origin: 'http://127.0.0.1:' + PORT } });
        const body = Buffer.from(await up.arrayBuffer());
        res.writeHead(up.status, { ...cors, 'content-type': up.headers.get('content-type') ?? 'text/javascript; charset=utf-8' });
        return res.end(body);
      } catch (err) { res.writeHead(502, cors); return res.end('vite proxy failed: ' + String(err)); }
    }
    const rel = p === '/' ? '/index.html' : p;
    const full = join(WEB, normalize(rel).replace(/^([.][.][/\\])+/, ''));
    const fullStat = await statOrNull(full);
    if (fullStat !== null && fullStat.isFile()) {
      res.writeHead(200, { ...cors, 'content-type': MIME[extname(full)] ?? 'application/octet-stream' });
      return res.end(await readFile(full));
    }
    const indexHtml = join(WEB, 'index.html');
    const indexStat = await statOrNull(indexHtml);
    if (indexStat !== null && indexStat.isFile()) {
      res.writeHead(200, { ...cors, 'content-type': MIME['.html'] });
      return res.end(await readFile(indexHtml));
    }
    res.writeHead(404, cors); res.end('not found');
  });
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)));
}

/**
 * 页内探针：一次读回全部几何量。
 *
 * 每个字段都对应一条**后果**（不是声明）——见文件头 ①。
 */
const PROBE = `(function () {
  var q = function (s) { return document.querySelector(s); };
  var qa = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var R = function (el) { if (!el) return null; var r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2),
             right: +r.right.toFixed(2), bottom: +r.bottom.toFixed(2) }; };
  /** 轴对齐矩形的 X 重叠（>0 = 相交；本仓 modes.ts 判定法）。 */
  var signedX = function (a, b) { if (!a || !b) return null; return +(Math.min(a.right, b.right) - Math.max(a.x, b.x)).toFixed(2); };
  var host = q('.wb-host'), panel = q('.wb-panel'), code = q('.wb-file-code');
  var no = q('.wb-line-no'), tx = q('.wb-line-tx'), split = q('.wb-splitter');
  var lines = qa('.wb-line');
  var firstLine = lines[0] || null;
  var foot = q('.wb-file-foot');
  var main = q('#main');
  return {
    // ---- 挤压 / 覆盖 ----
    overlay: host ? host.classList.contains('overlay') : null,
    hostHidden: host ? host.classList.contains('hidden') : null,
    hostPosition: host ? getComputedStyle(host).position : null,
    hostWidth: host ? +host.getBoundingClientRect().width.toFixed(2) : null,
    mainWidth: main ? +main.getBoundingClientRect().width.toFixed(2) : null,
    mainRect: R(main),
    panelRect: R(panel),
    /** >0 ⇒ 面板压在会话列上（覆盖）；<=0 ⇒ 相邻（挤压）。 */
    mainVsPanelSignedX: signedX(R(main), R(panel)),
    splitterWidth: split ? +split.getBoundingClientRect().width.toFixed(2) : null,
    // ---- 宽度等式（代码文本列 vs 可用宽 − 行号列）----
    panelClientWidth: panel ? panel.clientWidth : null,
    codeClientWidth: code ? code.clientWidth : null,
    lineNoClientWidth: no ? +no.getBoundingClientRect().width.toFixed(2) : null,
    lineTxClientWidth: tx ? tx.clientWidth : null,
    txEqCodeMinusLineNo: (code && tx && no)
      ? +(tx.clientWidth - (code.clientWidth - no.getBoundingClientRect().width)).toFixed(2) : null,
    // ---- 行号：停在第一视觉行（长行折行后不跑到中间）----
    firstLineRect: R(firstLine),
    firstLineNoRect: no && firstLine ? R(no) : null,
    /** 行号顶边 − 行顶边。≈0 ⇒ 贴第一视觉行；正值大 ⇒ 跑到中间去了。 */
    lineNoTopDelta: (no && firstLine)
      ? +(no.getBoundingClientRect().top - firstLine.getBoundingClientRect().top).toFixed(2) : null,
    firstLineHeight: firstLine ? +firstLine.getBoundingClientRect().height.toFixed(2) : null,
    // ---- 换行 ----
    wrapOn: (function () { var f = q('.wb-file'); return f ? f.classList.contains('wrap') : null; })(),
    // ---- 流式 / 页脚 ----
    lineCount: lines.length,
    lastLineNo: (function () { var a = qa('.wb-line-no'); return a.length ? Number(a[a.length - 1].textContent) : 0; })(),
    footText: foot ? foot.textContent : null,
    // ---- 视口 ----
    viewport: { w: window.innerWidth, h: window.innerHeight }
  };
})()`;

/** 小工具：从探针结果里取出并判定一条后果。 */
const verdict = (ok, detail) => ({ pass: ok === true, detail });

const main = async () => {
  await mkdir(TMP, { recursive: true });
  // 20 万行巨文件（分块追加必须跨越可观测的时间窗）
  await writeFile(HUGE, Array.from({ length: 200000 }, (_, i) => 'const v' + i + ' = "line ' + i + ' ' + 'x'.repeat(60) + '";').join('\n') + '\n', 'utf8');
  // 200 字符长行（窄容器放不下 ⇒ 折行可判）
  await writeFile(LONGLINE, Array.from({ length: 40 }, (_, i) => 'const s' + i + ' = "' + 'y'.repeat(200) + '";').join('\n') + '\n', 'utf8');
  // 短行文件（任何宽度都放得下 ⇒ 换行**不该**有影响）
  await writeFile(SHORTLINES, Array.from({ length: 40 }, (_, i) => 'const a' + i + ' = ' + i + ';').join('\n') + '\n', 'utf8');

  const server = await startFixture();
  const chrome = await launchChrome({ port: CDP, width: 1440, height: 900, executablePath: process.env.W9111_CHROME });
  const { page } = chrome;
  const consoleErrors = [];
  page.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') consoleErrors.push((p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ')); });
  page.on('Runtime.exceptionThrown', (p) => { consoleErrors.push('EXCEPTION ' + (p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '')); });
  const ev = (s) => page.eval(s);
  const out = { consequences: {}, raw: {}, stream: [], consoleErrors };

  /** 打开面板并载入一个文件（走真入口：面板 data + notifyPanels）。 */
  const openFile = async (abs) => {
    await ev('(async function(){ var s = await import("/src/ui/workbench/state.ts"); var ps = s.listPanels().filter(function(x){return x.kind==="files"}); if(!ps.length){ await import("/src/ui/workbench/index.ts").then(function(m){ m.openPanel("files","right"); }); ps = s.listPanels().filter(function(x){return x.kind==="files"}); } ps[0].data = { path: ' + JSON.stringify(TMP) + ', selected: null, openFile: ' + JSON.stringify(abs) + ' }; s.notifyPanels(); return true; })()');
    await sleep(700);
  };
  /** 设面板宽（挤压态由 .wb-host 的宽决定）。 */
  const setWidth = async (w) => {
    await ev('(function(){ return import("/src/ui/workbench/state.ts").then(function(st){ st.listPanels().forEach(function(p){ if(p.dock==="right") p.size = ' + w + '; }); st.notifyPanels(); return true; }); })()');
    await sleep(450);
  };
  const setWrap = async (on) => {
    await ev('(async function(){ var m = await import("/src/ui/workbench/session-state.ts"); m.setWrapCode(' + String(on) + '); var s = await import("/src/ui/workbench/state.ts"); s.notifyPanels(); return true; })()');
    await sleep(450);
  };

  try {
    await page.navigate('http://127.0.0.1:' + PORT + '/');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(2600);

    // ---- 0. 面板关：基线（会话列有多宽）----
    const closed = await ev(PROBE);
    out.raw.closed = closed;

    // =====================================================================
    // ① 撑开 ≠ 覆盖：会话列**真的变窄**且不被覆盖
    // =====================================================================
    await openFile(SHORTLINES);
    await setWidth(420);
    const opened = await ev(PROBE);
    out.raw.opened = opened;
    out.consequences.squeeze = {
      mainClosed: closed.mainWidth,
      mainOpened: opened.mainWidth,
      shrankBy: +(closed.mainWidth - opened.mainWidth).toFixed(2),
      signedOverlapX: opened.mainVsPanelSignedX,
      ...verdict(
        closed.mainWidth - opened.mainWidth > 100 && opened.mainVsPanelSignedX <= 0,
        'main ' + closed.mainWidth + ' → ' + opened.mainWidth + '（变窄 ' + (closed.mainWidth - opened.mainWidth).toFixed(2) + 'px）；X 重叠 ' + opened.mainVsPanelSignedX + 'px（≤0 = 不相交）',
      ),
    };

    // =====================================================================
    // ② 宽度等式 + 行号列宽不随面板宽变化
    // =====================================================================
    out.raw.widthSweep = [];
    for (const w of [300, 420, 560, 760]) {
      await setWidth(w);
      out.raw.widthSweep.push({ reqW: w, probe: await ev(PROBE) });
    }
    const sweeps = out.raw.widthSweep;
    const eqDeltas = sweeps.map((s) => s.probe.txEqCodeMinusLineNo);
    out.consequences.widthEquation = {
      rows: sweeps.map((s) => ({ panelW: s.probe.panelClientWidth, codeW: s.probe.codeClientWidth, lineNoW: s.probe.lineNoClientWidth, txW: s.probe.lineTxClientWidth, delta: s.probe.txEqCodeMinusLineNo })),
      ...verdict(
        eqDeltas.every((d) => d === 0),
        '每个宽度下「文本列 == 代码列 − 行号列」偏差：[' + eqDeltas.join(', ') + ']（全 0 = 精确成立）',
      ),
    };
    const noWidths = sweeps.map((s) => s.probe.lineNoClientWidth);
    out.consequences.lineNoColumnStable = {
      widths: noWidths,
      ...verdict(
        noWidths.every((x) => x === noWidths[0]) && noWidths[0] > 0,
        '行号列宽 [' + noWidths.join(', ') + ']（面板 300→760 变化时它**不变** = 不参与收缩）',
      ),
    };

    // =====================================================================
    // ③ 换行：窄容器**真的折行**（行高增长）；短行**不该有影响**（行高相同）
    // =====================================================================
    // 3a 长行文件（200 字符）在窄面板（420）下：关 ⇒ 单行；开 ⇒ 多行
    await setWidth(420);
    await openFile(LONGLINE);
    await setWrap(false);
    const longOff = await ev(PROBE);
    await setWrap(true);
    const longOn = await ev(PROBE);
    out.raw.wrapLong = { off: longOff, on: longOn };
    out.consequences.wrapReflowsLongLine = {
      panelW: longOn.panelClientWidth,
      heightOff: longOff.firstLineHeight,
      heightOn: longOn.firstLineHeight,
      ...verdict(
        longOn.firstLineHeight > longOff.firstLineHeight * 1.5,
        '面板 ' + longOn.panelClientWidth + 'px：行高 ' + longOff.firstLineHeight + ' → ' + longOn.firstLineHeight + '（开 ⇒ 折行，行高增长）',
      ),
    };
    // 3b 行号停在**第一视觉行**（折行后不跑到中间）
    out.consequences.lineNoStaysOnFirstRow = {
      lineHeight: longOn.firstLineHeight,
      lineNoTopDelta: longOn.lineNoTopDelta,
      ...verdict(
        longOn.lineNoTopDelta !== null && Math.abs(longOn.lineNoTopDelta) <= 2,
        '长行折成 ' + longOn.firstLineHeight + 'px 高时，行号顶边与行顶边相差 ' + longOn.lineNoTopDelta + 'px（≈0 = 贴第一视觉行）',
      ),
    };
    const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(SHOTS, 'wrap-on-narrow.png'), Buffer.from(shot.data, 'base64'));

    // 3c 短行文件在**宽面板**下：开/关行高必须**相同**（换行不该有副作用）
    await setWidth(900);
    await openFile(SHORTLINES);
    await setWrap(false);
    const shortOff = await ev(PROBE);
    await setWrap(true);
    const shortOn = await ev(PROBE);
    out.raw.wrapShort = { off: shortOff, on: shortOn };
    out.consequences.wrapNoEffectWhenItFits = {
      panelW: shortOn.panelClientWidth,
      overlay: shortOn.overlay,
      heightOff: shortOff.firstLineHeight,
      heightOn: shortOn.firstLineHeight,
      ...verdict(
        shortOff.firstLineHeight === shortOn.firstLineHeight,
        '短行在面板 ' + shortOn.panelClientWidth + 'px 下：开/关行高 ' + shortOff.firstLineHeight + ' / ' + shortOn.firstLineHeight + '（相同 = 只在放不下时才折）',
      ),
    };
    await setWrap(false);

    // =====================================================================
    // ④ 流式：分块追加（行数随时间增长）+ 页脚 == 实际行数
    // =====================================================================
    await setWidth(560);
    await openFile(HUGE);
    const t0 = Date.now();
    for (let i = 0; i < 8; i += 1) {
      const pr = await ev(PROBE);
      out.stream.push({ atMs: Date.now() - t0, lineCount: pr.lineCount, lastLineNo: pr.lastLineNo, footText: pr.footText });
      if (pr.lineCount >= 200000) break;
      await sleep(150);
    }
    const grown = out.stream.length > 1 && out.stream[out.stream.length - 1].lineCount > out.stream[0].lineCount;
    const last = out.stream[out.stream.length - 1];
    const footMatch = /已加载\s*(\d+)\s*\/\s*共\s*(\d+)/.exec(last.footText ?? '');
    out.consequences.streamChunked = verdict(
      grown,
      '采样行数时序：' + out.stream.map((s) => s.atMs + 'ms=' + s.lineCount).join(' → ') + '（持续增长 = 分块追加，不是一次全出）',
    );
    out.consequences.streamFooterHonest = verdict(
      footMatch !== null && Number(footMatch[1]) === last.lineCount && last.lastLineNo === last.lineCount && Number(footMatch[2]) === 200000,
      '页脚「' + last.footText + '」；DOM 行数 ' + last.lineCount + '、末行号 ' + last.lastLineNo + '（三者必须一致 —— 漂移会让页脚比总数还大）',
    );
    const shot2 = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(SHOTS, 'wide-stream.png'), Buffer.from(shot2.data, 'base64'));

    // =====================================================================
    // ⑤ 窄屏诚实降级：正文不被挤到 0 + 面板整块在视口内（原型在这里溢出 53px）
    // =====================================================================
    await page.send('Emulation.setDeviceMetricsOverride', { width: 700, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(1000);
    const narrow = await ev(PROBE);
    out.raw.narrow = narrow;
    const insideViewport = narrow.panelRect !== null
      && narrow.panelRect.x >= -0.5 && narrow.panelRect.right <= narrow.viewport.w + 0.5;
    out.consequences.narrowKeepsChatReadable = {
      overlay: narrow.overlay,
      mainWidth: narrow.mainWidth,
      panelW: narrow.panelRect ? narrow.panelRect.w : null,
      panelX: narrow.panelRect ? narrow.panelRect.x : null,
      panelRight: narrow.panelRect ? narrow.panelRect.right : null,
      viewportW: narrow.viewport.w,
      ...verdict(
        narrow.overlay === true && narrow.mainWidth >= 360 && insideViewport,
        '降级=' + narrow.overlay + '；#main ' + narrow.mainWidth + 'px（≥360 = 仍可读）；面板 x=' + (narrow.panelRect ? narrow.panelRect.x : '?') + ' right=' + (narrow.panelRect ? narrow.panelRect.right : '?') + ' / 视口 ' + narrow.viewport.w + '（整块在视口内）',
      ),
    };
    const shot3 = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(SHOTS, 'narrow-overlay.png'), Buffer.from(shot3.data, 'base64'));

    out.consoleErrors = consoleErrors;
    const failed = Object.entries(out.consequences).filter(([, v]) => !v.pass);
    out.summary = { total: Object.keys(out.consequences).length, failed: failed.map(([k]) => k) };
    console.log(JSON.stringify(out, null, 2));
    if (failed.length > 0) process.exitCode = 3;
  } finally {
    await chrome.close();
    await new Promise((r) => server.close(r));
  }
};
main().catch((e) => { console.error('probe failed:', e); process.exit(1); });
