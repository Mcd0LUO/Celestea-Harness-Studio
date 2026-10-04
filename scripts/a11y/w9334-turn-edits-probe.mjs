#!/usr/bin/env node
// ============================================================================
// scripts/a11y/w9334-turn-edits-probe.mjs — W9334：「本轮编辑」卡片的**真机取证**
// ----------------------------------------------------------------------------
// 为什么需要它（主会话裁定：这次的验收**必须给视觉证据**）：
//   · jsdom 量不了排版（rtl 头部截断、命中区、行高对齐），也量不了颜色（没有样式计算）；
//   · 卡片是**显示组件**，它的规格来自联调定稿的**原型**（apps/web/prototype/turn-edits.html）
//     —— 「与同状态的原型并排」只能在同一张真机截图里做（不引图像处理库、不拼图）。
//
// 怎么做到的（**不是复刻**）：
//   · 左边 = **真模块**（`/src/ui/turn-edits/card.ts` 建列 + 真增强遍渲染）+ **真 CSS**
//     （应用启动后 main.ts 已经 import 了 styles/turn-edits.css）；
//   · 右边 = 原型**本体**（同源 iframe `/prototype/turn-edits.html`），状态由它自己的
//     联调开关（`#v-size` / `#v-th` / `#v-long` …）驱动到**同一组数据**上；
//   · 数据只有一份：原型的 `MOCK` / `LONG` 常量**逐字从原型文件里取**（不另抄一份，
//     抄一份就是「两份真源」，改了原型截图就开始撒谎）。
//
// 量的后果（全部是**真机**上量的，不是源码级断言）：
//   ① 并排几何/文案**逐项相等**（行高、卡片宽、标题、副标题、聚合、每行数字）；
//   ② 字母三档颜色**在真机上可辨**：M 中性（r≈g≈b）、A 绿（g 最强）、D 红（r 最强）；
//   ③ 长路径 rtl 截断**真的保住了文件名**（确实被截断，且文件名整段落在可见框内）；
//   ④ 胶囊命中区 ≥ `--tap-hit`（fold 按钮与 caret 按钮的实际 rect）。
//
// 用法：
//   pnpm --dir apps/web dev --port 3788 --strictPort          # 前置（本脚本只读 /src/**）
//   W9111_CHROME=<chrome-headless-shell> node scripts/a11y/w9334-turn-edits-probe.mjs
//
// ★ 刻意不进门禁（与 w9329/w9333 同一取向）：需要 Vite dev server + Chrome。
//   确定性断言在 tests/w9334-turn-edits-{model,dom}.test.ts。
// ============================================================================
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
// W9323：请求处理器是**回调**，里面不许有同步阻塞调用 —— 静态服务走 fs/promises。
// 顶层（不在任何回调里）的 mkdirSync / writeFileSync 不在此列，保持同步。
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from '../perf/lib/chrome.mjs';

const VITE = process.env.W9334_VITE ?? 'http://127.0.0.1:3788';
const REPO = process.env.W9334_REPO ?? fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '');
const WEB = join(REPO, 'apps', 'web');
const SHOTS = process.env.W9334_SHOTS ?? join(REPO, 'tmp', 'w9334-probe');
const PORT = Number(process.env.W9334_PORT ?? 3834);
const CDP = Number(process.env.W9334_CDP_PORT ?? 9484);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SHOTS, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/**
 * 取证页 —— 左「实现」右「原型」。**不引任何依赖**：并排靠 flex + iframe，
 * 截图靠 CDP（Page.captureScreenshot），所以不需要图像库。
 */
const PAGE = `<!doctype html>
<html lang="zh-CN" data-theme="mono">
<head>
<meta charset="utf-8">
<title>W9334 · 本轮编辑卡片 · 真机取证</title>
<style>
  html, body { margin: 0; background: #101010; }
  #grid { display: flex; gap: 0; align-items: flex-start; }
  .side { flex: none; }
  .side h3 { margin: 14px 0 0 24px; font: 600 11px/1.4 var(--mono, ui-monospace, monospace);
             letter-spacing: .08em; text-transform: uppercase; color: #7a7a7a; }
  .side .note { margin: 4px 0 0 24px; font: 400 12px/1.5 system-ui, sans-serif; color: #9a9a9a; max-width: 700px; }
  #stage { padding: 40px 24px; }
  #proto { width: 760px; height: 1120px; border: 0; }
</style>
</head>
<body>
<div id="grid">
  <div class="side" style="width:760px">
    <h3>实现 · apps/web/src/ui/turn-edits（真模块 + 真 CSS）</h3>
    <div id="stage"><div id="mine"></div></div>
  </div>
  <div class="side" style="width:760px">
    <h3 id="proto-title">原型 · apps/web/prototype/turn-edits.html（同状态）</h3>
    <div class="note" id="proto-note"></div>
    <iframe id="proto" src="/prototype/turn-edits.html"></iframe>
  </div>
</div>
<script type="module">
// **真 CSS**：与应用同一条来源（Vite 把这三个文件当模块注入 <style>）。
// 不 import 它们时（--c-ok）之类的 token 未定义 ⇒ computed color 全黑、--tap-hit 为空
// —— 那量到的就不是产品，是「忘了穿衣服的页面」（第一版探针就踩了这条）。
await import('/src/styles/tokens.css');
await import('/src/styles/base.css');
await import('/src/styles/theme-claude.css'); // 原型那一族色卡（浅色与原型逐字相同）
await import('/src/styles/turn-edits.css');
// 真模块：建列走 createTurnEditsColumn，渲染走**增强遍**（与应用同一条路径）。
const C = await import('/src/ui/turn-edits/card.ts');
const E = await import('/src/ui/enhance/index.ts');

// 原型里的 MOCK / LONG **逐字取回来**（eval 的是数组字面量，只有一份真源）。
const protoHtml = await (await fetch('/prototype/turn-edits.html')).text();
const mockText = /const MOCK = (\\[[\\s\\S]*?\\n\\];)/.exec(protoHtml)[1].replace(/;\\s*$/, '');
const MOCK = (0, eval)(mockText);
const LONG = /const LONG = "([^"]+)"/.exec(protoHtml)[1];

/** 原型的行 → 我的行（字段名不同，语义同一个：能算出区间的那些行）。 */
const exactRows = (n, longFirst) => MOCK.slice(0, n).map((r, i) => ({
  kind: r.kind, path: longFirst && i === 0 ? LONG : r.path,
  add: r.add, del: r.del, written: null,
}));

/** S3：真实来源的形态（write_file 只给得出「写入 N 行」）。 */
const writtenRows = [
  { kind: 'edit', path: 'packages/tools/src/sandbox/child.ts', add: null, del: null, written: 109 },
  { kind: 'edit', path: 'apps/studio/src/plugins.ts', add: null, del: null, written: 16 },
  { kind: 'add', path: 'docs/feature-plugin-hotswap.md', add: null, del: null, written: 88 },
];

const STATES = {
  's1-exact3': { rows: exactRows(3, false), shellish: 0, proto: { size: '3', th: '5', long: 'false', fold: 'false' } },
  's2-long12-folded': { rows: exactRows(12, true), shellish: 0, proto: { size: '12', th: '5', long: 'true', fold: 'false' } },
  's3-written': { rows: writtenRows, shellish: 2, proto: null, note: '这一档原型没有对应形态：来源只有 write_file 的新内容 ⇒ 每行给「写入 N 行」（旧内容不可知，不给 −），页脚说明口径。' },
  's4-empty': { rows: [], shellish: 1, proto: { size: '0', th: '5', long: 'false', fold: 'false' } },
  // ⑤ 极端长路径：用来**在真机上证明** rtl 头部截断确实保住文件名（原型自己的 LONG 在
  //    760px 舞台里未必真的被截断 —— 不被截断就不构成证据）。
  's5-verylong': { rows: [{ kind: 'edit', path: LONG + '/' + LONG, add: 1, del: 1, written: null }], shellish: 0, proto: null,
    note: '极端长路径：证明 rtl 头部截断真的把省略号推到了行首、文件名整段留在可见框内。' },
};

const proto = document.getElementById('proto');
let renderPath = null;

function renderMine(state) {
  const host = document.getElementById('mine');
  host.replaceChildren();
  const col = C.createTurnEditsColumn(state.rows, state.shellish);
  host.appendChild(col);
  // ① 优先走**增强遍注册表**（与应用完全同一条路径）；注册表里没有它时才直接调本体
  //    （两条都记进 probe.json，不假装）。
  const before = host.querySelector('.te') !== null;
  E.runEnhancers(host);
  if (host.querySelector('.te') !== null) renderPath = 'enhancer-registry';
  else { C.turnEditsEnhancer().enhance(host); renderPath = 'enhancer-direct'; }
  return before;
}

function driveProto(state, theme) {
  const side = proto.closest('.side');
  const note = document.getElementById('proto-note');
  if (state.proto === null) {
    side.style.display = 'none';
    note.textContent = '';
    return;
  }
  side.style.display = '';
  note.textContent = '（开关状态：规模 ' + state.proto.size + ' / 阈值 ' + state.proto.th + ' / 长路径 ' + state.proto.long + '）';
  const pd = proto.contentDocument;
  const set = (id, v) => { const n = pd.getElementById(id); n.value = v; n.dispatchEvent(new Event('change')); };
  set('v-on', 'on');
  set('v-size', state.proto.size);
  set('v-th', state.proto.th);
  set('v-fold', state.proto.fold);
  set('v-long', state.proto.long);
  set('v-os', 'windows');
  set('v-theme', theme);
}

window.__w9334 = {
  set(name, appTheme, protoTheme) {
    const state = STATES[name];
    document.documentElement.dataset.theme = appTheme;
    renderMine(state);
    driveProto(state, protoTheme);
    return { name, appTheme, protoTheme, renderPath, rows: state.rows.length, shellish: state.shellish };
  },
  /** 真机上量到的后果（见文件头四条）。 */
  measure() {
    const num = (v) => Math.round(Number(v) * 100) / 100;
    const rgb = (s) => {
      const m = /rgba?\\(([^)]+)\\)/.exec(s);
      if (m === null) return null;
      const p = m[1].split(',').map((x) => Number(x.trim()));
      return { r: p[0], g: p[1], b: p[2] };
    };
    const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
      return { x: num(r.x), y: num(r.y), w: num(r.width), h: num(r.height), right: num(r.right), left: num(r.left) }; };
    const mine = document.querySelector('#mine .te');
    const chips = {};
    for (const k of ['edit', 'add', 'delete']) {
      const el = document.querySelector('#mine .te-kind[data-k="' + k + '"]');
      if (el === null) continue;
      const cs = getComputedStyle(el);
      chips[k] = {
        letter: el.textContent,
        color: rgb(cs.color), colorRaw: cs.color,
        bg: rgb(cs.backgroundColor), bgRaw: cs.backgroundColor,
        title: el.getAttribute('aria-label'),
      };
    }
    const pathEl = document.querySelector('#mine .te-row .te-path');
    const fileEl = document.querySelector('#mine .te-row .te-file');
    const tap = getComputedStyle(document.documentElement).getPropertyValue('--tap-hit').trim();
    const caret = document.querySelector('#mine .te-caret');
    const fold = document.querySelector('#mine .te-fold');
    /**
     * **有效命中区**：按钮视觉缩小、命中区靠 ::after 扩出来 ⇒ getBoundingClientRect
     * 量到的只是「看得见的那块」。真机上用 elementFromPoint 在四周逐像素试探，
     * 取命中点的包围盒 —— 那才是「点得到」的区域。
     */
    const hitBox = (el) => {
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      let l = Infinity, t = Infinity, rt = -Infinity, b = -Infinity;
      for (let y = Math.floor(r.top) - 6; y <= Math.ceil(r.bottom) + 6; y += 1) {
        for (let x = Math.floor(r.left) - 6; x <= Math.ceil(r.right) + 6; x += 1) {
          const hit = document.elementFromPoint(x + 0.5, y + 0.5);
          // ::after 伪元素的命中会报回**它的宿主**（就是 el 本身）⇒ 判 hit === el 即可。
          if (hit !== el) continue;
          if (x < l) l = x;
          if (y < t) t = y;
          if (x > rt) rt = x;
          if (y > b) b = y;
        }
      }
      if (l === Infinity) return { w: null, h: null, visual: { w: r.width, h: r.height }, miss: true };
      return {
        w: Math.round((rt - l + 1) * 100) / 100,
        h: Math.round((b - t + 1) * 100) / 100,
        visual: { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 },
      };
    };
    const rowEl = document.querySelector('#mine .te-row');
    const rowParts = rowEl === null ? [] : Array.from(rowEl.children).map((n) => ({
      cls: n.className, box: R(n), cs: { lineHeight: getComputedStyle(n).lineHeight, fontSize: getComputedStyle(n).fontSize },
    }));
    const pd = proto.contentDocument;
    const pRow = pd.querySelector('.te-row');
    const pCard = pd.querySelector('.te');
    return {
      renderPath,
      mine: {
        card: R(mine),
        row: R(document.querySelector('#mine .te-row')),
        title: (document.querySelector('#mine .te-title') || {}).textContent ?? null,
        sub: (document.querySelector('#mine .te-sub') || {}).textContent ?? null,
        sum: (document.querySelector('#mine .te-sum') || {}).textContent ?? null,
        sums: Array.from(document.querySelectorAll('#mine .te-sum > *')).map((n) => n.textContent),
        noteTexts: Array.from(document.querySelectorAll('#mine .te-note')).map((n) => n.textContent),
        firstDiff: (document.querySelector('#mine .te-row .te-diff') || {}).textContent ?? null,
        diffs: Array.from(document.querySelectorAll('#mine .te-row .te-diff')).map((n) => n.textContent),
        chips,
        rowParts,
        pathTruncated: pathEl === null ? null : pathEl.scrollWidth > pathEl.clientWidth,
        pathBox: R(pathEl),
        fileBox: R(fileEl),
        tapHit: tap,
        caret: R(caret),
        fold: R(fold),
        caretHit: hitBox(caret),
        foldHit: hitBox(fold),
      },
      proto: {
        card: R(pCard),
        row: R(pRow),
        title: (pd.querySelector('.te-title') || {}).textContent ?? null,
        sub: (pd.querySelector('.te-sub') || {}).textContent ?? null,
        sum: (pd.querySelector('.te-sum') || {}).textContent ?? null,
        firstDiff: (pd.querySelector('.te-row .te-diff') || {}).textContent ?? null,
        diffs: Array.from(pd.querySelectorAll('.te-row .te-diff')).map((n) => n.textContent),
        chipLetter: (pd.querySelector('.te-kind') || {}).textContent ?? null,
      },
    };
  },
};
window.__w9334Ready = true;
</script>
</body>
</html>`;

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
    if (p === '/') {
      res.writeHead(200, { ...cors, 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (p === '/api/health') return json(200, { ok: true, name: 'w9334', model: 'w9334', capabilities: {} }, cors);
    if (p === '/api/status') return json(200, { model: 'w9334', busy: false, session: 'w9334/main' }, cors);
    if (p === '/api/sessions') return json(200, { sessions: [{ id: 'w9334/main', title: 'W9334 取证', kind: 'session', busy: false, active: true }], active_session: 'w9334/main' }, cors);
    if (p === '/api/workspaces') return json(200, { workspaces: [{ name: 'w9334', path: REPO, sessions: 1 }], active_session: 'w9334/main' }, cors);
    if (p === '/api/display-plugins') return json(200, { ok: true, disabled: [], config: {} }, cors);
    if (p === '/api/events') {
      res.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      return;
    }
    for (const q of ['/api/config', '/api/providers', '/api/prompts', '/api/tools', '/api/plugins', '/api/permissions/presets', '/api/questions']) {
      if (p === q) {
        return json(200, {
          ok: true, model: 'w9334', available: { models: [], efforts: [] }, providers: [], prompts: [],
          tools: [], plugins: [], presets: [], questions: [], disabled: [], messages: [],
        }, cors);
      }
    }
    if (p === '/auth/check') return json(200, { ok: true, username: 'w9334' }, cors);
    if (p.startsWith('/src/') || p.startsWith('/@') || p.startsWith('/node_modules/') || p.startsWith('/prototype/')) {
      try {
        const up = await fetch(VITE + p + url.search, { headers: { origin: 'http://127.0.0.1:' + PORT } });
        const body = Buffer.from(await up.arrayBuffer());
        res.writeHead(up.status, { ...cors, 'content-type': up.headers.get('content-type') ?? 'text/javascript; charset=utf-8' });
        return res.end(body);
      } catch (err) {
        res.writeHead(502, cors);
        return res.end('vite proxy failed: ' + String(err));
      }
    }
    const rel = p === '/' ? '/index.html' : p;
    const full = join(WEB, normalize(rel).replace(/^([.][.][/\\])+/, ''));
    // W9323：**异步**读（同步读会把事件循环冻到 syscall 返回，而且目录命中会抛 EISDIR）。
    try {
      if ((await stat(full)).isFile()) {
        const body = await readFile(full);
        res.writeHead(200, { ...cors, 'content-type': MIME[extname(full)] ?? 'application/octet-stream' });
        return res.end(body);
      }
    } catch {
      /* 不存在：404 */
    }
    res.writeHead(404, cors);
    res.end('not found');
  });
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)));
}

const verdict = (ok, detail) => ({ pass: ok === true, detail });
const near = (a, b, tol = 1) => a !== null && b !== null && Math.abs(a - b) <= tol;

const main = async () => {
  const server = await startFixture();
  const chrome = await launchChrome({ port: CDP, width: 1600, height: 1240, executablePath: process.env.W9111_CHROME });
  const { page } = chrome;
  const consoleErrors = [];
  page.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') consoleErrors.push((p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' '));
  });
  page.on('Runtime.exceptionThrown', (p) => consoleErrors.push('EXCEPTION ' + (p.exceptionDetails?.exception?.text ?? '')));
  const ev = (s) => page.eval(s);
  const out = { consequences: {}, raw: {}, consoleErrors, shots: [] };

  try {
    await page.navigate('http://127.0.0.1:' + PORT + '/');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1240, deviceScaleFactor: 1, mobile: false });
    await sleep(2500); // 应用启动（真 CSS 就位）
    const ready = await ev('window.__w9334Ready === true');
    out.raw.ready = ready;
    await ev(`(function(){ var f = document.getElementById('proto'); return new Promise(function(r){
      if (f.contentDocument && f.contentDocument.readyState === 'complete') return r(true);
      f.addEventListener('load', function(){ r(true); });
    }); })()`);
    await sleep(300);

    const STATES = ['s1-exact3', 's2-long12-folded', 's3-written', 's4-empty', 's5-verylong'];
    /**
     * 三套主题（**深色 + 浅色都要给**，且要说明白哪一套才与原型同色）：
     *   · `claude` 浅/深 —— 原型用的就是这一族色卡（原型浅色的 --s-green-500/#3f7d4e 与
     *     theme-claude.css **逐字相同**）；深色那套由 `prefers-color-scheme` 选。
     *   · `dark` —— 应用自己的**单色**深色主题（W256 起是黑白 ins 风）：它把 ok/err 定义成
     *     灰阶，所以 M/A/D 在那里靠**底色**与明度区分、不是绿/红。这一套也照，因为它是默认族。
     */
    const THEMES = [
      { shot: 'claude-light', app: 'claude', proto: 'light', media: 'light' },
      { shot: 'claude-dark', app: 'claude', proto: 'dark', media: 'dark' },
      { shot: 'mono-dark', app: 'dark', proto: 'dark', media: 'dark' },
    ];
    for (const name of STATES) {
      for (const t of THEMES) {
        await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: t.media }] });
        const info = await ev(`window.__w9334.set(${JSON.stringify(name)}, ${JSON.stringify(t.app)}, ${JSON.stringify(t.proto)})`);
        out.raw[name + '-' + t.shot] = info;
        await sleep(170);
        const shot = await page.send('Page.captureScreenshot', { format: 'png' });
        const file = join(SHOTS, name + '-' + t.shot + '.png');
        writeFileSync(file, Buffer.from(shot.data, 'base64'));
        out.shots.push(file);
      }
    }
    await page.send('Emulation.setEmulatedMedia', { features: [] });

    // ---- 后果①②③④：全部在**真机**上量 ----
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await ev(`window.__w9334.set('s2-long12-folded','claude','dark')`);
    await sleep(200);
    const claudeDark = await ev('window.__w9334.measure()');
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await ev(`window.__w9334.set('s2-long12-folded','claude','light')`);
    await sleep(160);
    const claudeLight = await ev('window.__w9334.measure()');
    await page.send('Emulation.setEmulatedMedia', { features: [] });
    await ev(`window.__w9334.set('s2-long12-folded','dark','dark')`);
    await sleep(160);
    const monoDark = await ev('window.__w9334.measure()');
    await ev(`window.__w9334.set('s1-exact3','claude','light')`);
    await sleep(160);
    const s1 = await ev('window.__w9334.measure()');
    out.raw.claudeDark = claudeDark;
    out.raw.claudeLight = claudeLight;
    out.raw.monoDark = monoDark;
    out.raw.s1 = s1;

    // ① 并排逐项相等：同一组数据 ⇒ 行高 / 卡片宽 / 标题 / 副标题 / 聚合 / 每行数字
    const sameText = (a, b) => a !== null && b !== null && String(a).replace(/\s+/g, '') === String(b).replace(/\s+/g, '');
    out.consequences.parityS1 = verdict(
      near(s1.mine.row.h, s1.proto.row.h, 1) && near(s1.mine.card.w, s1.proto.card.w, 1) &&
        sameText(s1.mine.title, s1.proto.title) && sameText(s1.mine.sub, s1.proto.sub) &&
        sameText(s1.mine.sum, s1.proto.sum) && JSON.stringify(s1.mine.diffs) === JSON.stringify(s1.proto.diffs),
      `S1 并排：行高 ${s1.mine.row.h} vs ${s1.proto.row.h}px、卡片宽 ${s1.mine.card.w} vs ${s1.proto.card.w}px、` +
        `标题「${s1.mine.title}」vs「${s1.proto.title}」、副标题「${s1.mine.sub}」vs「${s1.proto.sub}」、` +
        `聚合「${s1.mine.sum}」vs「${s1.proto.sum}」、每行数字 ${JSON.stringify(s1.mine.diffs)} vs ${JSON.stringify(s1.proto.diffs)}`,
    );
    out.consequences.parityS2 = verdict(
      near(claudeDark.mine.row.h, claudeDark.proto.row.h, 1) && sameText(claudeDark.mine.sum, claudeDark.proto.sum) &&
        claudeDark.mine.diffs.length === claudeDark.proto.diffs.length,
      `S2（长路径 + 折叠）并排：行高 ${claudeDark.mine.row.h} vs ${claudeDark.proto.row.h}px、聚合「${claudeDark.mine.sum}」vs「${claudeDark.proto.sum}」、` +
        `可见行数 ${claudeDark.mine.diffs.length} vs ${claudeDark.proto.diffs.length}`,
    );

    // ② 三档颜色：**claude 族**（= 原型用的色卡）下必须是绿 / 红 / 中性；单色主题下
    //    不要求绿红（那是主题的设计意图），但三档必须**彼此可辨**。
    const neutral = (x) => x !== null && x !== undefined && Math.abs(x.r - x.g) <= 12 && Math.abs(x.g - x.b) <= 12;
    const greenish = (x) => x !== null && x !== undefined && x.g > x.r && x.g > x.b;
    const reddish = (x) => x !== null && x !== undefined && x.r > x.g && x.r > x.b;
    const tiersOf = (m) => m.mine.chips;
    /** 两个色值是否**看起来一样**（含 alpha 的原始串比较；对象比较要先展开，否则全是 "[object Object]"）。 */
    const sameChip = (a, b) => a !== undefined && b !== undefined && a.colorRaw === b.colorRaw && a.bgRaw === b.bgRaw;
    const distinct = (c) =>
      c.edit !== undefined && c.add !== undefined && c.delete !== undefined &&
      !sameChip(c.edit, c.add) && !sameChip(c.add, c.delete) && !sameChip(c.edit, c.delete);
    const cl = tiersOf(claudeLight);
    const cd = tiersOf(claudeDark);
    out.consequences.chipTiersPrototypePalette = verdict(
      cl.edit !== undefined && greenish(cl.add?.color) && reddish(cl.delete?.color) && neutral(cl.edit?.color),
      `claude 浅色（原型色卡，逐字同色）：M=${cl.edit?.colorRaw} A=${cl.add?.colorRaw} D=${cl.delete?.colorRaw}；` +
        `底色 ${JSON.stringify([cl.edit?.bgRaw, cl.add?.bgRaw, cl.delete?.bgRaw])}`,
    );
    out.consequences.chipTiersClaudeDark = verdict(
      cd.edit !== undefined && greenish(cd.add?.color) && reddish(cd.delete?.color) && neutral(cd.edit?.color),
      `claude 深色：M=${cd.edit?.colorRaw} A=${cd.add?.colorRaw} D=${cd.delete?.colorRaw}；` +
        `底色 ${JSON.stringify([cd.edit?.bgRaw, cd.add?.bgRaw, cd.delete?.bgRaw])}`,
    );
    const mono = tiersOf(monoDark);
    out.consequences.chipTiersMonoTheme = verdict(
      distinct(mono),
      `应用单色深色主题（默认族）：三档**彼此可辨**（颜色或底色不同）=${distinct(mono)}；` +
        `M=${mono.edit?.colorRaw}/${mono.edit?.bgRaw}、A=${mono.add?.colorRaw}/${mono.add?.bgRaw}、` +
        `D=${mono.delete?.colorRaw}/${mono.delete?.bgRaw}（**不要求绿红**：mono 主题自己把 ok/err 定义成灰阶，` +
        `组件不绕过主题写死颜色 —— 与原型同色的那一族是 claude）`,
    );

    // ③ rtl 头部截断真的保住了文件名（用**极端长路径**那一档来证明机制本身）
    await ev(`window.__w9334.set('s5-verylong','claude','dark')`);
    await sleep(160);
    const long = await ev('window.__w9334.measure()');
    out.raw.darkVeryLong = long;
    const pb = long.mine.pathBox;
    const fb = long.mine.fileBox;
    out.consequences.rtlKeepsFilename = verdict(
      long.mine.pathTruncated === true && fb !== null && pb !== null && fb.left >= pb.left - 0.5 && fb.right <= pb.right + 0.5 && fb.w > 0,
      `极端长路径确实被截断（scrollWidth>clientWidth=${long.mine.pathTruncated}）：路径框宽 ${pb?.w}px，` +
        `文件名框 x=${fb?.left}..${fb?.right}（可见框 ${pb?.left}..${pb?.right}）⇒ 省略号吃掉的只有目录，文件名整段可见`,
    );

    // ④ 命中区 ≥ --tap-hit：量的是**有效命中区**（elementFromPoint 逐像素试探的包围盒），
    //    不是按钮视觉框 —— 胶囊是「视觉缩小、命中靠 ::after 扩」的。
    const hit = parseFloat(long.mine.tapHit) || 24;
    const caretHit = long.mine.caretHit;
    const foldHit = long.mine.foldHit;
    out.consequences.tapHit = verdict(
      caretHit !== null && foldHit !== null && caretHit.miss !== true && foldHit.miss !== true &&
        caretHit.h >= hit && caretHit.w >= hit && foldHit.h >= hit && foldHit.w >= hit,
      `--tap-hit=${long.mine.tapHit}：caret 有效 ${caretHit?.w}×${caretHit?.h}（视觉 ${caretHit?.visual?.w}×${caretHit?.visual?.h}）、` +
        `fold 有效 ${foldHit?.w}×${foldHit?.h}（视觉 ${foldHit?.visual?.w}×${foldHit?.visual?.h}）`,
    );

    out.consoleErrors = consoleErrors;
    const failed = Object.entries(out.consequences).filter(([, v]) => !v.pass);
    writeFileSync(join(SHOTS, 'probe.json'), JSON.stringify(out, null, 2));
    console.log(JSON.stringify({
      chips: { claudeLight: claudeLight.mine.chips, claudeDark: claudeDark.mine.chips, monoDark: monoDark.mine.chips },
      notes: claudeLight.mine.noteTexts,
    }, null, 2));
    console.log('\n===== W9334 真机取证 =====');
    for (const [k, v] of Object.entries(out.consequences)) console.log((v.pass ? 'PASS ' : 'FAIL ') + k.padEnd(20) + v.detail);
    console.log('shots: ' + out.shots.length + ' 张 -> ' + SHOTS);
    console.log('consoleErrors: ' + (consoleErrors.length === 0 ? '(empty)' : JSON.stringify(consoleErrors.slice(0, 3))));
    console.log(failed.length === 0 ? '\n全部 PASS' : `\n${failed.length} 条 FAIL`);
  } finally {
    await chrome.close();
    server.close();
  }
};

main().catch((err) => { console.error(err); process.exit(1); });
