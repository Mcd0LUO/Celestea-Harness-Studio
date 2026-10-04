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
//
// ★ W9340：本探针**只出证据、不出 verdict**（它是几何快照，不是验收门禁）——
//   脚手架（静态 fixture 服务端 / Vite 反代 / 截图落盘 / 汇总与退出码）已收进
//   scripts/a11y/lib/harness.mjs。原先那句「请求处理器里不许有同步阻塞调用」（W9323）
//   现在由 harness 结构性保证（连 `readdirSync` / `statSync` 那三处基线违规一并消失）。
// ★ 同一轮顺手修掉一个**只在 Windows 上犯**的真 bug：原来自带服务端用
//   `new URL('../..', import.meta.url).pathname` 取仓库根 ⇒ `apps/web/index.html`
//   永远 404 ⇒ `#main` 是 null ⇒ 本探针**每次都以
//   `getComputedStyle(null)` 崩掉**（跑三次三次崩）。harness 的 repoRoot() 走 fileURLToPath。
//
// 用法：W9111_CHROME=<chrome> node scripts/a11y/w2058-scroll-probe.mjs
// ============================================================================
import { dirname, join } from 'node:path';
import {
  repoRoot, startFixture, fsRoutes, launchProbeChrome, createProbe, sleep,
} from './lib/harness.mjs';

const REPO = repoRoot('W2058_REPO');
const TARGET = process.env.W2058_TARGET ?? join(REPO, 'docs', 'ARCHITECTURE.md');
const WSROOT = dirname(TARGET);
const SHOTS = process.env.W2058_SHOTS ?? '/tmp/w2058-preview';
const PORT = Number(process.env.W2058_PORT ?? 3816);
const CDP = Number(process.env.W2058_CDP_PORT ?? 9476);

const main = async () => {
  const P = createProbe({ title: 'W2058 长文件滚动 · 真机取证', shots: SHOTS, pad: 20 });
  const fixture = await startFixture({
    port: PORT,
    label: 'w',
    repo: REPO,
    session: { id: 'w/main', title: 'W2058 取证', workspace: 'w', workspacePath: WSROOT },
    // 文件管理器要列目录（带 parent/roots），预览面板要读行窗口
    routes: fsRoutes({ list: 'dirs', roots: [WSROOT] }),
    spaFallback: true,
  });
  const browser = await launchProbeChrome({ port: CDP, width: 1440, height: 900 });
  const { page } = browser;
  const errs = browser.consoleErrors;
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
    const shot = await P.shots.save(page, 'scroll-coexist.png');
    console.log(JSON.stringify({ target: TARGET, before, after, consoleErrors: errs, shot }, null, 2));
    // 本探针不带断言：verdict 表为空 ⇒ 汇总行是「0 条 FAIL」。判读靠上面这份几何 JSON。
    await P.finish({
      heading: 'W2058 长文件滚动 · 真机取证',
      pad: 20,
      trailer: ['产物：' + SHOTS + '（本探针只出证据、不带断言）'],
    });
  } finally {
    await browser.close();
    await fixture.close();
  }
};
main().catch((e) => { console.error('probe failed:', e); process.exit(1); });
