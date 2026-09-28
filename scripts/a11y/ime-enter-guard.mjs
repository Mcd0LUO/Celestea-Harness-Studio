#!/usr/bin/env node
// ============================================================================
// scripts/a11y/ime-enter-guard.mjs — W2033：自由文本输入框的 Enter **IME 守卫**真机审计
// ----------------------------------------------------------------------------
// 缺陷（本轮真机复现）：多个自由文本输入框的 Enter 处理器没有 IME 守卫 ⇒ 中文/日文
// 用户按 Enter **确认候选词**时同时触发了那个不可逆动作（真发 POST /api/sessions、
// 关掉不可逆确认框、导航到半截路径…）。
//
// 本脚本把「某个框的守卫生不生效」变成**真浏览器里可机械发现**的事：将来任何人给
// 输入框加 Enter 提交，跑一次就知道（与 scripts/a11y/audit-touch-targets.mjs 同一取向）。
//
// ★ **刻意不进门禁**：它需要 Vite dev server + Chrome，不是确定性离线门禁。
//   与 audit-touch-targets 一样是**人工/审计**用的工具，不进 check:fast / CI。
//
// 用法：
//   pnpm --dir apps/web dev --port 3787 --strictPort      # 前置（本脚本只读 /src/**）
//   node scripts/a11y/ime-enter-guard.mjs                 # 表格
//   node scripts/a11y/ime-enter-guard.mjs --json          # 机器可读
//   node scripts/a11y/ime-enter-guard.mjs --fail-on-violation
//
// 三种按键（每个框各打一次）：
//   ① isComposing=true          —— 常规组合中（CDP Input.imeSetComposition 真的开始组合）
//   ② keyCode=229, isComposing=false —— compositionend **先于** keydown 的那一次
//      （MDN keydown 原文；真 IME 才产生它，本机没有 IME 进程 ⇒ 用 CDP 的
//       windowsVirtualKeyCode=229 让**浏览器自己**产生一条 isTrusted 的 keydown）
//   ③ 普通 Enter                —— 对照：动作**必须**照常发生（防「守卫写成永远 return」）
//
// 判定：① 与 ② 必须**不**触发动作，③ 必须**触发**动作。任一不符 ⇒ 违规。
// ============================================================================
import { backendPort, cdpPort } from '../perf/lib/ports.mjs';
import { launchChrome } from '../perf/lib/chrome.mjs';
import { startBackend } from '../perf/lib/backend.mjs';

const VITE = process.env.W9111_VITE ?? 'http://127.0.0.1:3787';
const WEB = new URL('../../apps/web', import.meta.url).pathname;
const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const FAIL = args.includes('--fail-on-violation');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 每个框：怎么建、怎么聚焦、怎么读「动作发生了没」。 */
const BOXES = [
  {
    id: 'confirm',
    where: 'apps/web/src/ui/confirm.ts（逐字确认词框；Enter ⇒ settle(true)，不可逆）',
    text: '允许',
    setup: "var m = await import('/src/ui/confirm.ts'); window.__p = { settled: null };"
      + " m.confirmDialog({ message: 'IME 守卫审计', requireText: '允许', requireHint: '输入 允许' })"
      + "   .then(function (v) { window.__p.settled = v; }); return true;",
    ready: "return document.querySelector('.confirm-word-row input.cfg-input') !== null;",
    focus: "document.querySelector('.confirm-word-row input.cfg-input').focus(); return true;",
    acted: "return !!(window.__p && window.__p.settled !== null);",
  },
  {
    id: 'fsbrowser',
    where: 'apps/web/src/ui/fsbrowser.ts（目录地址栏；Enter ⇒ goBtn.click()）',
    text: '/中文目录',
    setup: "var m = await import('/src/ui/fsbrowser.ts');"
      + " m.openFsBrowser({ title: '审计', confirmLabel: '确定', busyLabel: '…', onPick: function () {} }); return true;",
    ready: "return document.querySelector('.ws-fs-addr input.cfg-input') !== null;",
    // ★ 必须等**初始浏览的响应被应用**再打字：它回来时会 `addrInput.value = r.path`
    //   并重画面包屑，晚到就会把我们刚组合的内容覆盖掉（实测：composing 列假绿）。
    //   判据取状态行的 .ok 类（loadDirs 成功后才加）—— 等条件，不等一个猜出来的时长。
    settle: "return document.querySelector('.ws-fs-status').classList.contains('ok');",
    focus: "document.querySelector('.ws-fs-addr input.cfg-input').focus(); return true;",
    acted: "return Array.prototype.some.call(document.querySelectorAll('.ws-fs-crumb'),"
      + " function (n) { return n.textContent === '中文目录'; });",
  },
  {
    id: 'newsession',
    where: 'apps/web/src/ui/sessiontree/newsession.ts（标题框；Enter ⇒ create.click() ⇒ POST /api/sessions）',
    text: '中文标题',
    setup: "var m = await import('/src/ui/sessiontree/newsession.ts');"
      + " m.newSessionDialog({ loadSessions: async function () {} }); return true;",
    ready: "return document.querySelector('.modal-card .prov-field input') !== null;",
    focus: "document.querySelector('.modal-card .prov-field input').focus(); return true;",
    // 读**请求本身**：create.click() 是唯一会发 POST /api/sessions 的路径。
    acted: "return fetch('/__imeguard/hits').then(function (r) { return r.json(); })"
      + ".then(function (d) { return d.sessions > 0; });",
  },
  {
    id: 'modelrow',
    where: 'apps/web/src/ui/providers/modelrow.ts（自定义推理档位；Enter ⇒ 收框 + 新增片）',
    text: '中文档位',
    setup: "var m = await import('/src/ui/providers/modelrow.ts');"
      + " var box = document.createElement('div'); box.id = 'pbox'; document.body.appendChild(box);"
      + " m.addModelRow({ modelsBox: box, rows: [], onLayout: function () {} }, 'm', 'M');"
      + " box.querySelector('.prov-effort-chips .btn-mini').click(); return true;",
    // ★ 高级区在 <details> 里（默认收起 ⇒ focus() 静默失败）：必须先展开，否则测的是主输入框。
    ready: "var d = document.querySelector('#pbox details.prov-model-adv'); if (d) d.open = true;"
      + " var i = document.querySelector('#pbox .prov-effort-chips input.cfg-input');"
      + " if (!i) return false; i.focus(); return document.activeElement === i;",
    focus: "return true;",
    acted: "var i = document.querySelector('#pbox .prov-effort-chips input.cfg-input'); return !!i && i.hidden === true;",
  },
  {
    id: 'browser',
    where: 'apps/web/src/ui/workbench/browser.ts（URL 框；Enter ⇒ navigate()）',
    text: '中文.example',
    setup: "var b = await import('/src/ui/workbench/browser.ts'); b.setLoadTimeout(80);"
      + " var body = document.createElement('div'); body.id = 'pbody'; document.body.appendChild(body);"
      + " window.__p = { panel: { id: 'p', kind: 'browser', title: 'p', dock: 'right', size: 300, seq: 0 } };"
      + " b.renderBrowserPanel(body, window.__p.panel, function () { return true; }); return true;",
    ready: "return document.querySelector('#pbody .wb-url-input') !== null;",
    focus: "document.querySelector('#pbody .wb-url-input').focus(); return true;",
    acted: "return !!(window.__p && window.__p.panel.data !== undefined);",
  },
];

async function waitFor(page, body, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.eval('(function(){ ' + body + ' })()')) return true;
    await sleep(80);
  }
  throw new Error('waitFor timeout: ' + label);
}

/**
 * 三种按键：CDP 让**浏览器自己**产生事件（isTrusted=true），不是 JS 构造的。
 *
 * ★ `text` 必须是**该框自己的**文本：`Input.imeSetComposition` 会把输入框的值**替换**成
 *   组合串。写死一个 'ni' 会让「逐字确认词框」的值不再是确认词 ⇒ 按钮仍禁用 ⇒ Enter
 *   什么都不做 ⇒ **假绿**（本轮实测踩到：confirm/fsbrowser 的 composing 列假绿）。
 */
async function press(page, kind, text) {
  const vk = kind === 'plain' ? 13 : kind === 'ime229' ? 229 : 13;
  if (kind === 'composing') {
    await page.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  }
  const k = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
}

/**
 * 跑一个用例（单次尝试）。
 *
 * ★ 为什么返回值里带 `origin`：Vite 在**第一次**加载某个模块时会做依赖重优化，
 *   并把客户端整页 reload —— 刚建好的弹窗会被冲掉，表现为「`window.__p` 不见了」。
 *   拿 `performance.timeOrigin` 当页面身份指纹：变了就说明中途 reload 过，这一次的数据
 *   不可信。**没有这个指纹的测量是假数据**（本轮实测踩到过，报告 §7 已如实登记）。
 */
async function runBoxOnce(page, box, kind) {
  await page.navigate('about:blank');
  await page.navigate(ORIGIN + '/');
  await waitFor(page, "return document.querySelector('.sess-pane:not([hidden])') !== null;", 'pane ready', 20000);
  const origin = await page.eval('performance.timeOrigin');
  await page.evalAsync(box.setup);
  await waitFor(page, box.ready, box.id + ' ready');
  if (box.settle) await waitFor(page, box.settle, box.id + ' settle');
  await page.evalAsync(box.focus);
  await page.eval('fetch("/__imeguard/reset").then(function () { return 1; })');
  // ★ 组合场景**不预填**：Input.imeSetComposition 是**追加**到现有值上的
  //   （实测：先填 '允许' 再组合 '允许' ⇒ '允许允许' ⇒ 确认按钮仍禁用 ⇒ Enter 什么都不做
  //    ⇒ 假绿）。组合串本身就是「用户正在打的内容」，让它自己去建立框里的文本才忠实。
  if (kind !== 'composing') {
    await page.eval("(function(){ var a = document.activeElement; if (!a || a.tagName !== 'INPUT') return false;"
      + ' a.value = ' + JSON.stringify(box.text) + "; a.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  }
  await press(page, kind, box.text);
  await sleep(250);
  // evalAsync 收的是**函数体**（它自己包成 async IIFE）⇒ 谓词直接是 `return …;`。
  // 这样 `acted` 既可以是同步谓词，也可以 await 一次 fetch（newsession 读请求计数）。
  const acted = await page.evalAsync(box.acted);
  const same = (await page.eval('performance.timeOrigin')) === origin;
  return { acted, same };
}

/** 同一个用例最多试 3 次；只有「页面身份没变」的那一次才算数。 */
async function runBox(page, box, kind) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await runBoxOnce(page, box, kind);
    if (r.same) return r.acted;
    await sleep(400);
  }
  throw new Error('[W2033] ' + box.id + '/' + kind + '：页面在用例中途被整页 reload，3 次都没拿到可信数据');
}

/**
 * 给夹具后端补两条本审计**自己的**确定性路由。
 *
 * 为什么必须补 `POST /api/sessions`：perf 夹具后端没有这条路由 ⇒ 请求会落到它的
 * 「未知路径回 index.html」兜底上（200 + HTML），新建会话弹窗于是走出**成功**分支、
 * 自己关掉 —— 那样「动作有没有发生」就再也读不到了（实测：断言读到 null）。
 * 这里一律回 400：既能证明「Enter 真的点了创建」，又**不会真建**会话，且终态确定。
 */
function patchBackend(backend) {
  const orig = backend.server.listeners('request')[0];
  backend.server.removeAllListeners('request');
  /** 每个用例前清零：
   *  ★ 「动作发生了没」读的是**请求本身**，不是 UI 的瞬时态 —— 新建会话弹窗在 4xx 之后
   *    会把按钮复位（disabled=false），250ms 后读按钮是读不到的（实测踩到）。 */
  const hits = { sessions: 0, browse: 0 };
  backend.server.on('request', (req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const cors = { 'access-control-allow-origin': req.headers.origin ?? '*' };
    const json = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { ...cors, 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
    };
    if (u.pathname === '/__imeguard/reset') { hits.sessions = 0; hits.browse = 0; return json(200, { ok: true }); }
    if (u.pathname === '/__imeguard/hits') return json(200, hits);
    if (u.pathname === '/api/sessions' && req.method === 'POST') {
      hits.sessions += 1;
      return json(400, { ok: false, error: 'ime-guard audit: create refused on purpose' });
    }
    if (u.pathname === '/api/fs/browse') {
      hits.browse += 1;
      return json(200, { path: u.searchParams.get('path') ?? '', dirs: [] });
    }
    return orig(req, res);
  });
}

const chrome = await launchChrome({ port: cdpPort(), width: 1440, height: 900 });
const backend = await startBackend({ port: backendPort(), webRoot: WEB, viteOrigin: VITE, history: [] });
patchBackend(backend);
const ORIGIN = backend.origin;
const { page } = chrome;
const consoleErrors = [];
page.on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error') consoleErrors.push((p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' '));
});
page.on('Runtime.exceptionThrown', (p) => consoleErrors.push('EXCEPTION ' + (p.exceptionDetails?.exception?.description ?? '')));

const rows = [];
try {
  // 热身：把**每个**用例要用的模块先 import 一遍，让 Vite 的依赖重优化一次跑完
  // （只热身第一个框不够 —— 后面几个框各自还会引入新依赖、各自触发一次 reload）。
  await page.navigate(ORIGIN + '/');
  await waitFor(page, "return document.querySelector('.sess-pane:not([hidden])') !== null;", 'pane ready', 20000);
  for (const box of BOXES) {
    try { await page.evalAsync(box.setup); } catch { /* 热身失败不影响正式用例 */ }
  }
  await sleep(600);
  for (const box of BOXES) {
    const composing = await runBox(page, box, 'composing');
    const ime229 = await runBox(page, box, 'ime229');
    const plain = await runBox(page, box, 'plain');
    // 违规 = 组合中/229 触发了动作（漏守卫）或普通 Enter 没触发（守卫写太宽）
    const violations = [];
    if (composing) violations.push('isComposing 组合中触发了动作（漏 IME 守卫）');
    if (ime229) violations.push('keyCode 229 触发了动作（漏 IME 守卫）');
    if (!plain) violations.push('普通 Enter 没有触发动作（守卫写太宽）');
    rows.push({ id: box.id, where: box.where, composing, ime229, plain, violations });
    if (!JSON_OUT) process.stdout.write('[' + box.id + '] done\n');
  }
} finally {
  await chrome.close();
  await backend.close();
}

const bad = rows.filter((r) => r.violations.length > 0);
if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ boxes: rows, consoleErrors, violations: bad.length }, null, 2) + '\n');
} else {
  process.stdout.write('\n自由文本输入框 · Enter 的 IME 守卫（真机 1440x900）\n');
  process.stdout.write('框            组合中  229   普通Enter  判定\n');
  for (const r of rows) {
    process.stdout.write(
      r.id.padEnd(13) + String(r.composing).padEnd(7) + String(r.ime229).padEnd(6) + String(r.plain).padEnd(11)
      + (r.violations.length ? '✗ ' + r.violations.join('；') : '✓') + '\n',
    );
  }
  process.stdout.write('console 错误：' + consoleErrors.length + '\n');
  process.stdout.write(bad.length === 0
    ? '✓ 5 个框的 IME 守卫全部生效，且普通 Enter 行为未被吞掉\n'
    : '✗ ' + bad.length + ' 个框违规\n');
}
if (FAIL && bad.length > 0) process.exit(1);
