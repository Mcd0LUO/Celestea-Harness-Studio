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
// ★ W9340：脚手架（静态 fixture 服务端 / Vite 反代 / 截图落盘 / verdict 表 +
//   PASS/FAIL 汇总 + 退出码）已收进 scripts/a11y/lib/harness.mjs —— 本文件只剩
//   「场景 + 断言」。原先那句「请求处理器里不许有同步阻塞调用」（W9323）现在由
//   harness 从源头上保证：它一个同步 fs 都不 import，请求回调里只有 fs/promises。
//
// 用法：
//   pnpm --dir apps/web dev --port 3787 --strictPort       # 前置（本脚本只读 /src/**）
//   W9111_CHROME=<chrome-headless-shell> node scripts/a11y/w9329-workbench-probe.mjs
//
// ★ 刻意不进门禁（与 w2058-preview-probe.mjs 同一取向）：需要 Vite dev server +
//   Chrome。确定性断言在 tests/w9329-workbench-squeeze.test.ts。
// ============================================================================
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  repoRoot, startFixture, fsRoutes, launchProbeChrome, createProbe, ensureDir, sleep,
} from './lib/harness.mjs';

// ★ Windows：仓库根一律经 fileURLToPath 规范化（见 harness 的 repoRoot）。
const REPO = repoRoot('W9329_REPO');
const SHOTS = process.env.W9329_SHOTS ?? join(REPO, 'tmp', 'w9329-probe');
const PORT = Number(process.env.W9329_PORT ?? 3829);
const CDP = Number(process.env.W9329_CDP_PORT ?? 9482);

const TMP = join(REPO, 'tmp');
/** 巨文件（流式 + 分块追加）。20 万行：2 万行在本地盘 <200ms 就读完，抓不到中间态。 */
const HUGE = join(TMP, 'w9329-huge.ts');
/** 200 字符长行：窄容器放不下 ⇒ 换行开关的「折行」后果可判。 */
const LONGLINE = join(TMP, 'w9329-longline.ts');
/** 短行文件：任何面板宽都放得下 ⇒ 换行开关「不该有影响」的对照。 */
const SHORTLINES = join(TMP, 'w9329-shortlines.ts');

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

// verdict 表 / 汇总 / 退出码都在 harness 里（判据、阈值、文案仍归本探针）。
const P = createProbe({ title: 'W9329 真机取证', shots: SHOTS, pad: 22 });
const verdict = P.verdict;

const main = async () => {
  const out = P.out;
  out.stream = [];
  await ensureDir(TMP);
  // 20 万行巨文件（分块追加必须跨越可观测的时间窗）
  await writeFile(HUGE, Array.from({ length: 200000 }, (_, i) => 'const v' + i + ' = "line ' + i + ' ' + 'x'.repeat(60) + '";').join('\n') + '\n', 'utf8');
  // 200 字符长行（窄容器放不下 ⇒ 折行可判）
  await writeFile(LONGLINE, Array.from({ length: 40 }, (_, i) => 'const s' + i + ' = "' + 'y'.repeat(200) + '";').join('\n') + '\n', 'utf8');
  // 短行文件（任何宽度都放得下 ⇒ 换行**不该**有影响）
  await writeFile(SHORTLINES, Array.from({ length: 40 }, (_, i) => 'const a' + i + ' = ' + i + ';').join('\n') + '\n', 'utf8');

  const fixture = await startFixture({
    port: PORT,
    label: 'w9329',
    repo: REPO,
    session: { title: 'W9329 取证' },
    // 真文件系统的两个端点（工作台的文件面板靠它们）
    routes: fsRoutes({ list: 'files' }),
    spaFallback: true,
  });
  const browser = await launchProbeChrome({ port: CDP, width: 1440, height: 900 });
  const { page } = browser;
  const consoleErrors = browser.consoleErrors;
  out.consoleErrors = consoleErrors;
  const ev = (s) => page.eval(s);

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
    await P.shots.save(page, 'wrap-on-narrow.png');

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
    await P.shots.save(page, 'wide-stream.png');

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
    await P.shots.save(page, 'narrow-overlay.png');

    out.consoleErrors = consoleErrors;
    out.summary = P.summary();
    await P.finish({ printJson: true, pad: 22, exitCodeOnFail: 3 });
  } finally {
    await browser.close();
    await fixture.close();
  }
};
main().catch((e) => { console.error('probe failed:', e); process.exit(1); });
