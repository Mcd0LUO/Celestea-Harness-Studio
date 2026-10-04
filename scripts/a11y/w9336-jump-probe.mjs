#!/usr/bin/env node
// ============================================================================
// scripts/a11y/w9336-jump-probe.mjs — W9336「回到底部」浮标的**真机取证**
// ----------------------------------------------------------------------------
// 按铁律 11：jsdom 里判不了的那一半移到真机 —— 本探针量的是**真应用**（真 main.ts
// 装配出来的浮标，不是原型的复刻），五件事：
//   ① **出现 / 消失阈值在真几何下成立**（真 scrollHeight / clientHeight，真滚轮输入）；
//   ② **点击真的是平滑的**：真鼠标点击后逐帧采 scrollTop —— 采样点必须多、单调不减、
//      终点贴底（证明不是「一步跳」）；同一发点击在 reduced-motion 下必须**一步到位**
//      （同一份采样口径的反面对照）；
//   ③ **键盘**：真 Tab 键把焦点送到浮标（`document.activeElement`），`:focus-visible`
//      真的匹配、焦点环真的画出来（outline 非 none、宽度/颜色可读、对比度 ≥ 3:1），
//      真 Enter / 真 Space 各触发一次回到底部；
//   ④ **可访问性树**：浮标是 role=button 且名字带「回到底部」（有新消息时带条数）；
//      可见数字 aria-hidden ⇒ 不重复播报；
//   ⑤ **不破坏既有行为**：贴底时新列仍把视图留在底部；用户上滚后新列**不把人拽回**，
//      并顺带量浮标的落位（在消息区右下角内、不压到输入胶囊）。
//
// ★ W9340：脚手架（静态 fixture 服务端 / Vite 反代 / 截图落盘 / **CDP 输入原语**
//   （滚轮 / 按键 / Tab / 点击）/ verdict 表 + PASS/FAIL 汇总 + 退出码）已收进
//   scripts/a11y/lib/harness.mjs —— 本文件只剩「场景 + 断言」。
//
// 用法（前置：Vite dev server 起着；Chrome 由 perf/lib/chrome.mjs 自行查找）：
//   pnpm --dir apps/web dev --port 3787 --strictPort
//   node scripts/a11y/w9336-jump-probe.mjs
// 产物：$W9336_SHOTS/probe.json + 若干 PNG（默认 tmp/w9336-probe）。
//
// ★ 刻意不进 `pnpm check`（与 w2058 / w9329 / w9333 同一取向）：它需要 Vite + Chrome。
//   确定性断言在 tests/w9336-jump-bottom.test.ts。
// ============================================================================
import { join } from 'node:path';
import {
  repoRoot, startFixture, launchProbeChrome, createProbe, createInput, sleep,
} from './lib/harness.mjs';

const VITE = process.env.W9336_VITE ?? process.env.W9111_VITE ?? 'http://127.0.0.1:3787';
const REPO = repoRoot('W9336_REPO');
const SHOTS = process.env.W9336_SHOTS ?? join(REPO, 'tmp', 'w9336-probe');
const PORT = Number(process.env.W9336_PORT ?? 3836);
const CDP = Number(process.env.W9336_CDP_PORT ?? 9486);

// ---- 页内脚本 --------------------------------------------------------------

/** 用**真实模块**堆出一个够长的会话（真几何才有得量），并回报浮标的装配状态。 */
const SETUP = `(async function () {
  var V = await import('/src/ui/viewctx.ts');
  var M = await import('/src/ui/messages.ts');
  var pane = V.ensurePane('w9336/main', 'session', 'W9336 取证');
  V.activatePane('w9336/main', 'session', 'W9336 取证');
  var filler = new Array(30).join('内容 ');
  for (var i = 1; i <= 16; i++) {
    M.addUserMessage(pane, '第 ' + i + ' 轮：' + filler);
    var a = M.ensureAssistant(pane);
    M.appendText(pane, a, '回复 ' + i + '：' + filler);
    M.finalizeAssistant(pane, a);
    M.flushTextSegment(pane);
  }
  pane.el.scrollTop = pane.el.scrollHeight;
  window.__w9336 = { V: V, M: M, pane: pane };
  await new Promise(function (r) { setTimeout(r, 150); });
  var b = document.querySelector('.jump-bottom');
  return {
    hasButton: b !== null,
    hostId: b && b.parentElement ? b.parentElement.id : null,
    tag: b ? b.tagName : null,
    type: b ? b.getAttribute('type') : null,
    hiddenAtBottom: b ? b.classList.contains('hidden') : null,
    tabIndex: b ? b.tabIndex : null,
    scrollHeight: pane.el.scrollHeight,
    clientHeight: pane.el.clientHeight,
    canScroll: pane.el.scrollHeight > pane.el.clientHeight,
    cols: pane.el.children.length
  };
})()`;

/** 一行读完：浮标态 + 距底 + 落位 + 输入胶囊矩形（压没压到它）。 */
const GEO = `(function () {
  var b = document.querySelector('.jump-bottom');
  var n = document.querySelector('.jump-bottom-count');
  var p = window.__w9336.pane.el;
  var cs = b ? getComputedStyle(b) : null;
  var R = function (e) { if (!e) return null; var r = e.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
  var pr = R(p), br = R(b), cr = R(document.querySelector('.chat-shell'));
  var hit = br && cr && Math.min(br.right, cr.right) - Math.max(br.x, cr.x) > 0 &&
            Math.min(br.bottom, cr.bottom) - Math.max(br.y, cr.y) > 0;
  return {
    shown: b ? !b.classList.contains('hidden') : null,
    display: cs ? cs.display : null,
    badge: n ? n.textContent : null,
    badgeHidden: n ? n.classList.contains('hidden') : null,
    badgeAriaHidden: n ? n.getAttribute('aria-hidden') : null,
    label: b ? b.getAttribute('aria-label') : null,
    title: b ? b.getAttribute('title') : null,
    gap: Math.round(p.scrollHeight - p.clientHeight - p.scrollTop),
    top: Math.round(p.scrollTop),
    btn: br, pane: pr, composer: cr, btnOverComposer: hit
  };
})()`;

/** 逐帧采样 scrollTop（rAF；本探针的「平滑」判据全靠它）。 */
const SAMPLER = `(function () {
  var p = window.__w9336.pane.el;
  var t0 = performance.now();
  var out = [];
  window.__w9336.samples = out;
  (function loop() {
    out.push([Math.round(performance.now() - t0), Math.round(p.scrollTop)]);
    if (performance.now() - t0 < 1400) requestAnimationFrame(loop);
  })();
  return true;
})()`;

/** 在**列内部**追加内容（子树变化）+ 真加高，用于「离开底部」的非滚动形态。 */
const GROW = `(function () {
  var p = window.__w9336.pane.el;
  var cols = p.children;
  var last = cols[cols.length - 1];
  var d = document.createElement('div');
  d.style.height = '400px';
  d.textContent = '尾部补充内容（展开/图片加载那种长高）';
  last.appendChild(d);
  return { cols: cols.length, scrollTop: Math.round(p.scrollTop) };
})()`;

/** 真消息路径追加 N 列（思考段 + 收段 ⇒ 每轮一条新列），非 force 的贴底节拍。 */
const APPEND = (n) => `(async function () {
  var M = window.__w9336.M, p = window.__w9336.pane;
  for (var i = 0; i < ${n}; i++) { M.appendThinking(p, '推理…'); M.flushThinkSegment(p); }
  await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
  return true;
})()`;

const SET_SCROLLTOP = (top) => `(function () {
  var p = window.__w9336.pane.el;
  p.scrollTop = ${top};
  return Math.round(p.scrollTop);
})()`;

const SCROLL_BY = (delta) => `(function () {
  var p = window.__w9336.pane.el;
  p.scrollTop = p.scrollHeight - p.clientHeight - ${delta};
  return Math.round(p.scrollTop);
})()`;

const FOCUS_RING = `(function () {
  var b = document.querySelector('.jump-bottom');
  var cs = getComputedStyle(b);
  var bgOf = function (el) {
    for (var n = el; n; n = n.parentElement) {
      var c = getComputedStyle(n).backgroundColor;
      if (c && c !== 'transparent' && !/rgba\\(0, 0, 0, 0\\)/.test(c)) return c;
    }
    return 'rgb(255, 255, 255)';
  };
  return {
    isButton: b.tagName === 'BUTTON',
    focused: document.activeElement === b,
    focusVisible: b.matches(':focus-visible'),
    outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth,
    outlineColor: cs.outlineColor, outlineOffset: cs.outlineOffset,
    ringBg: bgOf(b.parentElement),
    boxShadow: cs.boxShadow
  };
})()`;

// verdict 表 / 汇总 / 退出码都在 harness 里（判据、阈值、文案仍归本探针）。
const P = createProbe({ title: 'W9336 真机取证', shots: SHOTS, pad: 20 });
const verdict = P.verdict;
const round = (n) => Math.round(n * 10) / 10;

/** WCAG 相对亮度 / 对比度（与 tests/w9226 的算式同口径）。 */
function parseColor(v) {
  const s = String(v).trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (hex !== null) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (fn === null) throw new Error('unsupported color: ' + s);
  const p = fn[1].split(/[,\/]/).map((x) => x.trim()).filter((x) => x !== '');
  return [Number(p[0]), Number(p[1]), Number(p[2]), p.length > 3 ? Number(p[3]) : 1];
}
const over = (fg, bg) => {
  const [r, g, b, a] = parseColor(fg);
  const [br, bgc, bb] = parseColor(bg);
  const mix = (c, d) => Math.round(c * a + d * (1 - a));
  return '#' + [mix(r, br), mix(g, bgc), mix(b, bb)].map((c) => c.toString(16).padStart(2, '0')).join('');
};
const luminance = (hex) => {
  const [r, g, b] = parseColor(hex);
  const f = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => {
  const l1 = luminance(a); const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

/** 从采样里切出「点击之后」的那一段（点击前的采样是常数）。 */
function movement(samples) {
  if (samples.length === 0) return { path: [], distinct: 0, monotonic: true, ms: 0 };
  const start = samples[0][1];
  const i0 = samples.findIndex((s) => s[1] !== start);
  if (i0 < 0) return { path: [], distinct: 0, monotonic: true, ms: 0 };
  const path = samples.slice(i0);
  let monotonic = true;
  for (let i = 1; i < path.length; i += 1) if (path[i][1] < path[i - 1][1]) monotonic = false;
  let ms = 0;
  for (const s of path) if (s[1] !== path[path.length - 1][1]) ms = s[0];
  return { path, distinct: new Set(path.map((s) => s[1])).size, monotonic, ms };
}

const main = async () => {
  const out = P.out;
  const fixture = await startFixture({
    port: PORT,
    label: 'w9336',
    repo: REPO,
    vite: VITE,
    session: { title: 'W9336 取证' },
  });
  const browser = await launchProbeChrome({ port: CDP, width: 1440, height: 900 });
  const { page } = browser;
  const consoleErrors = browser.consoleErrors;
  out.consoleErrors = consoleErrors;
  const ev = (s) => page.eval(s);
  const input = createInput(page);

  try {
    await page.navigate('http://127.0.0.1:' + PORT + '/');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(2200);
    const setup = await ev(SETUP);
    out.raw.setup = setup;
    out.consequences.assembled = verdict(
      setup.hasButton === true && setup.hostId === 'messages' && setup.tag === 'BUTTON' && setup.type === 'button' &&
        setup.tabIndex === 0 && setup.hiddenAtBottom === true && setup.canScroll === true,
      `真 main.ts 装配出浮标=${setup.hasButton}，宿主=#${setup.hostId}，<${setup.tag} type=${setup.type}> tabIndex=${setup.tabIndex}；` +
        `贴底时隐藏=${setup.hiddenAtBottom}；消息区可滚=${setup.canScroll}（${setup.scrollHeight}>${setup.clientHeight}）`,
    );

    // ---- ① 真几何下的出现 / 消失阈值（真滚轮 + 精确摆位）----
    const atBottom = await ev(GEO);
    const below = await ev(SCROLL_BY(199)); // 差 1px 到 200 阈值
    await sleep(80);
    const belowG = await ev(GEO);
    const above = await ev(SCROLL_BY(201)); // 越过阈值
    await sleep(80);
    const aboveG = await ev(GEO);
    await input.wheel(-120, 6, { at: 'window.__w9336.pane.el' }); // 真滚轮往上滚（用户路径）
    await sleep(120);
    const wheelG = await ev(GEO);
    out.raw.threshold = { atBottom, below, belowG, above, aboveG, wheelG };
    out.consequences.threshold = verdict(
      atBottom.shown === false && belowG.shown === false && aboveG.shown === true && wheelG.shown === true,
      `贴底显示=${atBottom.shown}；距底 ${atBottom.gap}px 时显示=${belowG.shown}；距底 ${belowG.gap}px(199) 显示=${belowG.shown}；` +
        `距底 ${aboveG.gap}px(201) 显示=${aboveG.shown}；真滚轮上滚后距底 ${wheelG.gap}px 显示=${wheelG.shown}`,
    );

    // ---- ② 数字：出现之后新增的消息数（列内部长高也算「离开底部」）----
    await ev(SCROLL_BY(0));
    await sleep(80);
    const beforeBadge = await ev(GEO);
    await ev(SCROLL_BY(900));
    await sleep(80);
    const armedEmpty = await ev(GEO);
    await ev(APPEND(3));
    const afterThree = await ev(GEO);
    await ev(GROW); // 列内部长高（子树变化）
    await sleep(120);
    const grew = await ev(GEO);
    out.raw.badge = { beforeBadge, armedEmpty, afterThree, grew };
    out.consequences.badge = verdict(
      armedEmpty.badge === '' && armedEmpty.badgeHidden === true && afterThree.badge === '3' &&
        afterThree.badgeHidden === false && afterThree.label.includes('3'),
      `刚出现时数字=「${armedEmpty.badge}」(hidden=${armedEmpty.badgeHidden})；追加 3 列后数字=「${afterThree.badge}」` +
        `(hidden=${afterThree.badgeHidden})，可访问名=「${afterThree.label}」；列内部长高后仍显示=${grew.shown}`,
    );

    // ---- ③ 平滑点击（真鼠标 + 逐帧采样）----
    await ev(SCROLL_BY(1200));
    await sleep(80);
    await ev(SAMPLER);
    const clickPt = await input.click('.jump-bottom', { hover: false });
    await sleep(900);
    const smoothSamples = await ev('window.__w9336.samples');
    const smoothG = await ev(GEO);
    const mv = movement(smoothSamples);
    out.raw.smooth = { clickPt, samples: smoothSamples.length, path: mv.path.slice(0, 40), distinct: mv.distinct, ms: round(mv.ms), end: smoothG };
    out.consequences.smooth = verdict(
      mv.distinct >= 4 && mv.monotonic && smoothG.gap === 0 && smoothG.shown === false,
      `真鼠标点击后采样 ${mv.path.length} 帧 / ${mv.distinct} 个不同位置（单调不减=${mv.monotonic}），` +
        `走完用 ${round(mv.ms)}ms，终点距底 ${smoothG.gap}px、浮标已收起=${smoothG.shown === false}`,
    );

    // ---- ④ reduced-motion：同一发点击必须一步到位（同口径的反面对照）----
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(80);
    const rmMatches = await ev(`window.matchMedia('(prefers-reduced-motion: reduce)').matches`);
    await ev(SCROLL_BY(1200));
    await sleep(80);
    await ev(SAMPLER);
    await input.click('.jump-bottom', { hover: false });
    await sleep(700);
    const rmSamples = await ev('window.__w9336.samples');
    const rmG = await ev(GEO);
    const rmMv = movement(rmSamples);
    out.raw.reducedMotion = { matches: rmMatches, path: rmMv.path.slice(0, 20), distinct: rmMv.distinct, end: rmG };
    out.consequences.reducedMotion = verdict(
      rmMatches === true && rmMv.distinct <= 2 && rmG.gap === 0 && rmG.shown === false,
      `reduce 媒体查询生效=${rmMatches}；点击后只有 ${rmMv.distinct} 个不同位置（平滑那发是 ${mv.distinct} 个）` +
        `，终点距底 ${rmG.gap}px（一步到位）`,
    );
    await page.send('Emulation.setEmulatedMedia', { features: [] });

    // ---- ⑤ 键盘：真 Tab 聚焦 + 焦点环 + 真 Enter / 真 Space ----
    await ev(SCROLL_BY(1200));
    await sleep(100);
    const tabs = await input.tabTo('.jump-bottom', { max: 6, from: 'window.__w9336.pane.el' });
    await sleep(80);
    const ring = await ev(FOCUS_RING);
    const ringHex = over(ring.outlineColor, ring.ringBg);
    const ringContrast = round(contrast(ringHex, ring.ringBg));
    await input.press('Enter', 'Enter', 13, '\r');
    await sleep(500);
    const afterEnter = await ev(GEO);
    await ev(SCROLL_BY(1200));
    await sleep(120);
    const tabs2 = await input.tabTo('.jump-bottom', { max: 6, from: 'window.__w9336.pane.el' });
    await input.press(' ', 'Space', 32, ' ');
    await sleep(500);
    const afterSpace = await ev(GEO);
    out.raw.keyboard = { tabs, ring, ringHex, ringContrast, afterEnter, tabs2, afterSpace };
    out.consequences.keyboard = verdict(
      tabs > 0 && tabs2 > 0 && ring.focused === true && ring.focusVisible === true &&
        ring.outlineStyle === 'solid' && parseFloat(ring.outlineWidth) >= 1 &&
        afterEnter.gap === 0 && afterSpace.gap === 0,
      `${tabs} 次真 Tab 聚焦到浮标（再次聚焦用 ${tabs2} 次）；:focus-visible=${ring.focusVisible}、` +
        `outline=${ring.outlineStyle} ${ring.outlineWidth} ${ring.outlineColor}（合成后 ${ringHex}，对底 ${ring.ringBg} = ${ringContrast}:1）；` +
        `真 Enter 后距底 ${afterEnter.gap}px、真 Space 后距底 ${afterSpace.gap}px`,
    );
    out.consequences.focusRingContrast = verdict(
      ringContrast >= 3,
      `焦点环合成色 ${ringHex} 对底色 ${ring.ringBg} = ${ringContrast}:1（WCAG 2.4.11 要求 ≥ 3:1）`,
    );

    // ---- ⑥ 可访问性树：role=button + 名字带条数；数字不重复播报 ----
    await ev(SCROLL_BY(1200));
    await ev(APPEND(2));
    await page.send('DOM.enable');
    await page.send('Accessibility.enable');
    const domRoot = (await page.send('DOM.getDocument', { depth: -1 })).root;
    const nodeIdOf = async (sel) => (await page.send('DOM.querySelector', { nodeId: domRoot.nodeId, selector: sel })).nodeId;
    const axOf = async (sel) => {
      const id = await nodeIdOf(sel);
      if (!id) return [];
      const r = await page.send('Accessibility.getPartialAXTree', { nodeId: id, fetchRelatives: false });
      return (r.nodes ?? []).map((n) => ({
        role: n.role?.value ?? null,
        name: n.name?.value ?? null,
        ignored: n.ignored === true,
        reason: n.ignoredReasons?.map((x) => x.name).join(',') ?? null,
      }));
    };
    const btnAx = await axOf('.jump-bottom');
    const numAx = await axOf('.jump-bottom-count');
    out.raw.ax = { button: btnAx, count: numAx };
    out.consequences.axTree = verdict(
      btnAx.some((n) => n.role === 'button' && n.ignored !== true && /回到底部/.test(n.name ?? '') && /\d/.test(n.name ?? '')) &&
        numAx.every((n) => n.ignored === true),
      `浮标在可访问性树里 = ${JSON.stringify(btnAx.map((n) => ({ role: n.role, name: n.name, ignored: n.ignored })))}；` +
        `可见数字节点 = ${JSON.stringify(numAx.map((n) => ({ ignored: n.ignored, reason: n.reason })))}`,
    );

    // ---- ⑦ 不破坏既有行为：贴底仍跟随 / 上滚不被拽回 ----
    await ev(SCROLL_BY(0));
    await sleep(100);
    const followBefore = await ev(GEO);
    await ev(`(function () { var M = window.__w9336.M, p = window.__w9336.pane;
      M.addUserMessage(p, '贴底时来的一条新消息'); return true; })()`);
    await sleep(200);
    const followAfter = await ev(GEO);
    await ev(SCROLL_BY(1500));
    await sleep(100);
    const parked = await ev(GEO);
    await ev(APPEND(2)); // 用户上滚期间来了两列（非 force 的贴底节拍）
    await sleep(200);
    const stillParked = await ev(GEO);
    out.raw.regression = { followBefore, followAfter, parked, stillParked };
    out.consequences.noRegression = verdict(
      followAfter.gap === 0 && stillParked.top === parked.top && stillParked.shown === true,
      `贴底时新消息后距底 ${followAfter.gap}px（仍跟随）；用户上滚到 top=${parked.top} 后来 2 列，` +
        `top 仍是 ${stillParked.top}（未拽回），浮标可见=${stillParked.shown}`,
    );

    // ---- ⑧ 落位：在消息区右下角内、不压输入胶囊 ----
    const placed = await ev(GEO);
    out.raw.placement = placed;
    out.consequences.placement = verdict(
      placed.btn !== null && placed.btn.w === 36 && placed.btn.h === 36 &&
        placed.btn.right <= placed.pane.right && placed.btn.bottom <= placed.pane.bottom &&
        placed.btnOverComposer === false,
      `浮标 ${placed.btn?.w}×${placed.btn?.h} @(${placed.btn?.x},${placed.btn?.y})，` +
        `消息区右下 (${placed.pane?.right},${placed.pane?.bottom})，压到输入胶囊=${placed.btnOverComposer}`,
    );

    // ---- 视觉证据（形态本身不是断言）----
    for (const theme of ['mono', 'claude']) {
      await ev(`(function () { document.documentElement.dataset.theme = ${JSON.stringify(theme)}; return true; })()`);
      await sleep(100);
      await P.shots.save(page, 'jump-' + theme + '.png');
    }
    await ev(`(function () { document.documentElement.dataset.theme = 'mono'; return true; })()`);

    out.consoleErrors = consoleErrors;
    await P.finish({
      heading: 'W9336 真机取证',
      pad: 20,
      jsonPath: join(SHOTS, 'probe.json'),
      trailer: ['产物：' + SHOTS],
      exitCodeOnFail: 1,
    });
  } finally {
    await browser.close();
    await fixture.close();
  }
};

main().catch((err) => { console.error(err); process.exit(1); });
