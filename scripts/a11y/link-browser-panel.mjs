#!/usr/bin/env node
// ============================================================================
// scripts/a11y/link-browser-panel.mjs — W2057：正文外链「打开方式」真机审计
// ----------------------------------------------------------------------------
// 用户原话：「打开网页链接应该自动打开我们提供的浏览器而非新建页面。」
//
// 把「点正文外链之后到底发生了什么」变成**真浏览器里可机械读出**的事：
//   · 新建了几个 page target（新标签页）？opener 是谁？
//   · 当前页 URL 变了吗（被导航走了）？
//   · 工作台浏览器面板开了吗？iframe 指向哪个 URL？
//   · 跨域站点被 X-Frame-Options / CSP frame-ancestors 拒绝时，用户看到的是
//     「可读提示 + 新标签出口」还是**白屏**？
//
// ★ 刻意不进门禁（与 ime-enter-guard.mjs / file-link-affordance.mjs 同一取向）：
//   需要 Vite dev server + Chrome，不是确定性离线门禁。确定性断言在
//   apps/web/src/ui/workbench/link-open.test.ts（jsdom，进门禁）。
//
// 用法：
//   pnpm --dir apps/web dev --port 3797 --strictPort
//   W9111_CHROME=<chrome-headless-shell> W2057_TAG=before node scripts/a11y/link-browser-panel.mjs
//   W9111_CHROME=<chrome-headless-shell> W2057_TAG=after  node scripts/a11y/link-browser-panel.mjs
// ============================================================================
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { launchChrome } from '../perf/lib/chrome.mjs';
import { startBackend } from '../perf/lib/backend.mjs';

const VITE = process.env.W2057_VITE ?? 'http://127.0.0.1:3797';
const TAG = process.env.W2057_TAG ?? 'unknown';
const WEB = process.env.W2057_WEBROOT ?? new URL('../../apps/web', import.meta.url).pathname;
const SHOTS = process.env.W2057_SHOTS ?? '/tmp/w2057-shots';
const W = Number(process.env.W2057_WIDTH ?? 1440);
const H = Number(process.env.W2057_HEIGHT ?? 900);
const VP = process.env.W2057_VIEWPORT ?? 'desktop';
const PORT = Number(process.env.W2057_BACKEND_PORT ?? 3798);
const CDP = Number(process.env.W2057_CDP_PORT ?? 9471);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SHOTS, { recursive: true });

/** 正文夹具：四类链接各一条 + 一个标题供 #fragment 用。 */
const BODY = [
  '外链：[示例站点](https://example.com/probe)',
  '',
  '片段：[跳到本节](#section-1)',
  '',
  '邮件：[写信](mailto:a@b.c) 电话：[打电话](tel:+8613800000000)',
  '',
  '## 本节',
].join('\n');
const HISTORY = [{ role: 'assistant', content: BODY }];

/** 真的发 X-Frame-Options: DENY 的「外站」（确定性复现跨域被拒）。 */
const denySrv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY' });
  res.end('<!doctype html><title>deny</title><h1>deny-site</h1>');
});
await new Promise((r) => denySrv.listen(0, '127.0.0.1', r));
const DENY_URL = 'http://127.0.0.1:' + denySrv.address().port + '/';

const chrome = await launchChrome({ port: CDP, width: W, height: H });
const backend = await startBackend({ port: PORT, webRoot: WEB, viteOrigin: VITE, history: HISTORY });
const { page, browser } = chrome;
const consoleErrors = [];
page.on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error') consoleErrors.push((p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' '));
});
page.on('Runtime.exceptionThrown', (p) => consoleErrors.push('EXCEPTION ' + (p.exceptionDetails?.exception?.description ?? '')));

/** 新建 page target 的账本（父页面读不到子页，只有 CDP 看得到）。 */
const targets = [];
const seen = new Set();
browser.on('Target.targetCreated', (p) => {
  const t = p.targetInfo;
  if (!t || t.type !== 'page' || seen.has(t.targetId)) return;
  seen.add(t.targetId);
  targets.push({ targetId: t.targetId, url: t.url, openerId: t.openerId ?? null });
});
browser.on('Target.targetInfoChanged', (p) => {
  const t = p.targetInfo;
  if (!t || t.type !== 'page') return;
  const hit = targets.find((x) => x.targetId === t.targetId);
  if (hit) hit.urlNow = t.url;
});
await browser.send('Target.setDiscoverTargets', { discover: true });

async function waitFor(body, label, t = 30000) {
  const dl = Date.now() + t;
  while (Date.now() < dl) { if (await page.eval('(function(){ ' + body + ' })()')) return true; await sleep(120); }
  throw new Error('waitFor timeout: ' + label);
}

/** 面板状态快照（**不**依赖内部模块，只读真实 DOM）。 */
const PANEL = `(function(){
  var f = document.querySelector('.wb-frame');
  var n = document.querySelector('.wb-notice');
  var e = document.querySelector('.wb-url-external');
  var i = document.querySelector('.wb-url-input');
  return {
    frameCount: document.querySelectorAll('.wb-frame').length,
    panelCount: document.querySelectorAll('.wb-panel').length,
    frameSrc: f ? f.getAttribute('src') : null,
    inputValue: i ? i.value : null,
    noticeShown: n ? !n.classList.contains('hidden') : null,
    noticeText: n ? n.textContent : null,
    externalPresent: e !== null,
    externalShown: e ? !e.classList.contains('hidden') : null
  };
})()`;

/** 真鼠标点一个选择器（坐标取自元素自己的盒模型中心）。 */
async function clickAt(sel, { modifiers = 0, button = 'left' } = {}) {
  const box = await page.eval(`(function(){
    var a = document.querySelector(${JSON.stringify(sel)});
    if (!a) return null;
    a.scrollIntoView({ block: 'center' });
    var r = a.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (box === null) throw new Error('no element: ' + sel);
  const buttons = button === 'middle' ? 4 : 1;
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', buttons: 0 });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button, buttons, clickCount: 1, modifiers });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button, buttons: 0, clickCount: 1, modifiers });
}

/** 关掉所有面板（回到「没有面板」的起点），只走 UI 的关闭按钮。 */
async function closeAllPanels() {
  for (let i = 0; i < 12; i += 1) {
    const n = await page.eval("document.querySelectorAll('.wb-panel .wb-close').length");
    if (n === 0) break;
    await page.eval("(function(){ var b=document.querySelector('.wb-panel .wb-close'); if(b) b.click(); return true; })()");
    await sleep(180);
  }
}

async function observe(label, sel, opts) {
  const before = targets.length;
  const urlBefore = await page.eval('location.href');
  const panelsBefore = await page.eval("document.querySelectorAll('.wb-panel').length");
  await clickAt(sel, opts);
  await sleep(1100);
  return {
    label, selector: sel, options: opts ?? {},
    newPageTargets: targets.slice(before).map((t) => ({ url: t.urlNow ?? t.url, hasOpener: t.openerId !== null })),
    urlChanged: (await page.eval('location.href')) !== urlBefore,
    appStillHere: await page.eval("document.querySelectorAll('.content.rendered').length"),
    panelsBefore,
    panel: await page.eval(PANEL),
  };
}

const out = { tag: TAG, viewport: VP, width: W, height: H, denyUrl: DENY_URL, backend: backend.origin };
try {
  await page.navigate(backend.origin + '/');
  await waitFor("return document.querySelector('.sess-pane:not([hidden])') !== null;", 'pane ready');
  await waitFor("return document.querySelector('.content.rendered a[href]') !== null;", 'anchors rendered');
  await sleep(500);

  out.anchors = await page.eval(`(function(){
    return Array.prototype.map.call(document.querySelectorAll('.content.rendered a'), function(a){
      return { text: a.textContent, href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel'), tabIndex: a.tabIndex };
    });
  })()`);
  await page.screenshot(SHOTS + '/w2057-' + TAG + '-' + VP + '-0-before.png');

  // ① 正文 http 外链（左键、无修饰键）
  out.clickExternal = await observe('正文外链 · 左键', '.content.rendered a[href^="https://"]');
  await page.screenshot(SHOTS + '/w2057-' + TAG + '-' + VP + '-1-external.png');

  // ② #fragment（先关面板，确保「没开面板」不是因为复用）
  await closeAllPanels();
  out.clickFragment = await observe('同文档片段', '.content.rendered a[href^="#"]');
  // ③ mailto
  out.clickMailto = await observe('mailto', '.content.rendered a[href^="mailto:"]');
  // ④ tel
  out.clickTel = await observe('tel', '.content.rendered a[href^="tel:"]');

  // ⑤ Ctrl+Click（modifiers=2）
  await closeAllPanels();
  out.clickCtrl = await observe('Ctrl+Click 外链', '.content.rendered a[href^="https://"]', { modifiers: 2 });
  // ⑥ 中键
  out.clickMiddle = await observe('中键点击外链', '.content.rendered a[href^="https://"]', { button: 'middle' });

  // ⑦ 键盘：聚焦外链后按 Enter（真 CDP 按键，浏览器自己产生 click）
  await closeAllPanels();
  await page.eval("(function(){ var a=document.querySelector('.content.rendered a[href^=\"https://\"]'); a.focus(); return document.activeElement === a; })()");
  const nBefore = targets.length;
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(1100);
  out.enterKey = { newPageTargets: targets.slice(nBefore).map((t) => t.urlNow ?? t.url), panel: await page.eval(PANEL) };
  await page.screenshot(SHOTS + '/w2057-' + TAG + '-' + VP + '-1b-enter.png');

  /**
   * 在**浏览器面板里**打开一个 URL —— 只走**用户真实路径**（右上角「+」菜单开面板，
   * 再在 URL 框里打地址按 Enter），不 import 任何本次新增的模块。
   * ★ 为什么必须这样：本脚本要在**改动前**也跑得动（对照基线），而改动前没有
   *   openUrlInPanel 这个出口；走 UI 则在两个版本里都是同一条路径、同一份数据。
   */
  async function openInPanelViaUi(url) {
    await closeAllPanels();
    await page.eval("(function(){ var b=document.getElementById('btnWorkbench'); if(b) b.click(); return true; })()");
    await sleep(250);
    const clicked = await page.eval(`(function(){
      var items = Array.prototype.slice.call(document.querySelectorAll('#wbMenu .wb-menu-item'));
      var hit = items.filter(function(n){ return n.textContent.indexOf(${JSON.stringify('浏览器')}) !== -1 || n.textContent.indexOf('Browser') !== -1; })[0];
      if (!hit) return false; hit.click(); return true;
    })()`);
    if (!clicked) throw new Error('workbench menu: browser item not found');
    await sleep(400);
    await page.eval(`(function(){
      var i = document.querySelector('.wb-url-input');
      i.value = ${JSON.stringify(url)};
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`);
  }

  // ⑧ 跨域被拒的站点（真发 XFO: DENY）在**面板里**的表现
  await openInPanelViaUi(DENY_URL);
  await sleep(6500); // 远超 browser.ts 的 4000ms 超时
  out.denyInPanel = await page.eval(PANEL);
  await page.screenshot(SHOTS + '/w2057-' + TAG + '-' + VP + '-2-xfo-deny.png');

  // ⑨ 真·跨域站点 example.com
  await openInPanelViaUi('https://example.com/');
  await sleep(6500);
  out.exampleInPanel = await page.eval(PANEL);
  await page.screenshot(SHOTS + '/w2057-' + TAG + '-' + VP + '-3-example.png');
} finally {
  out.consoleErrors = consoleErrors;
  await chrome.close();
  await backend.close();
  denySrv.close();
}
process.stdout.write(JSON.stringify(out, null, 2) + '\n');