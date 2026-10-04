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
// ★ W9340：本探针**只出证据、不出 verdict**（它是取证快照，不是验收门禁）——
//   脚手架（静态 fixture 服务端 / Vite 反代 / 截图落盘 / 汇总与退出码）已收进
//   scripts/a11y/lib/harness.mjs。原先那句「请求处理器里不许有同步阻塞调用」（W9323）
//   现在由 harness 结构性保证。
// ★ 同一轮顺手修掉一个**只在 Windows 上犯**的真 bug：原来自带服务端用
//   `new URL('../..', import.meta.url).pathname` 取仓库根，在 Windows 上是 `/D:/…`，
//   经 `path.join` 变成 `\D:\…` ⇒ `apps/web/index.html` 永远 404、页面其实是 404 文本，
//   探针量到的是「没穿衣服的页面」。harness 的 repoRoot() 一律走 fileURLToPath。
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
import { dirname, join } from 'node:path';
import {
  repoRoot, startFixture, fsRoutes, launchProbeChrome, createProbe, sleep,
} from './lib/harness.mjs';

const REPO = repoRoot('W2058_REPO');
const TAG = process.env.W2058_TAG ?? 'unknown';
const TARGET = process.env.W2058_TARGET ?? join(REPO, 'tmp', 'dsh-archive-dryrun', 'REPORT.md');
const SHOTS = process.env.W2058_SHOTS ?? '/tmp/w2058-preview';
const PORT = Number(process.env.W2058_PORT ?? 3814);
const CDP = Number(process.env.W2058_CDP_PORT ?? 9474);

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
  const P = createProbe({ title: 'W2058 文件预览面板 · 真机取证', shots: SHOTS, pad: 20 });
  const evidence = { tag: TAG, target: TARGET, viewports: {}, consoleErrors: [] };
  const fixture = await startFixture({
    port: PORT,
    label: 'w2058',
    repo: REPO,
    session: { id: 'w2058/main', title: 'W2058 取证', workspace: 'w2058', workspacePath: dirname(dirname(TARGET)) },
    // 预览面板只读文件（不列目录）⇒ list: 'empty'
    routes: fsRoutes({ list: 'empty' }),
    spaFallback: true,
  });
  const browser = await launchProbeChrome({ port: CDP, width: 1440, height: 900 });
  const { page } = browser;
  P.out.consoleErrors = browser.consoleErrors;
  evidence.consoleErrors = browser.consoleErrors;
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
      evidence.viewports[vp.name] = await page.eval(PROBE);
      evidence.viewports[vp.name].screenshot = await P.shots.save(page, TAG + '-' + vp.name + '.png');
    }
    console.log(JSON.stringify(evidence, null, 2));
    // 本探针不带断言：verdict 表为空 ⇒ 汇总行是「0 条 FAIL」。run.sh / 报告靠 JSON 与截图判读。
    await P.finish({
      heading: 'W2058 文件预览面板 · 真机取证',
      pad: 20,
      trailer: ['产物：' + SHOTS + '（本探针只出证据、不带断言）'],
    });
  } finally {
    await browser.close();
    await fixture.close();
  }
};
main().catch((e) => { console.error('probe failed:', e); process.exit(1); });
