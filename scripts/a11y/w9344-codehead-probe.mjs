#!/usr/bin/env node
// ============================================================================
// scripts/a11y/w9344-codehead-probe.mjs — W9344「代码块工具条」的真机取证
// ----------------------------------------------------------------------------
// ★ 主场景（探针**只承诺覆盖它**，其余不做）——
//   一个 `run_code` 的 JSON 结果块，在**流式还没结束**（每个节拍重跑增强链）时：
//     · 右上角出现 `[复制图标] [json]`，顺序与相对位置都成立；
//     · 点图标能复制、成功有回显（且回显**不遮文字**）；
//     · 长行横向滚动时它们不盖住文字、也不跟着滑走；
//     · 键盘能 Tab 到、焦点环可见、可访问名正确、axTree 里读得到。
//   为什么要把「流式还没结束」写进主场景：增强链每节拍重跑（铁律 ③ 的幂等面），
//   而工具条/徽标/按钮是**两个增强遍分别注入**的 —— 顺序对不对、会不会被重排成
//   [json][复制]、按钮会不会被第二个节拍重造一遍，只有在真会重跑的页面上才验得到。
//   在静止页面上量一次布局，量不到这个 bug。
//
// ★ 为什么大部分断言要用**真几何**（铁律 11：jsdom 量不了排版）：
//   「在右上角」「不盖文字」「跟着滑走」「焦点环对比度」全是像素事实。
//   DOM 顺序与可访问名由 tests/ 里的单测守（那两样 jsdom 量得了），真机守像素。
//
// 用法（前置：Vite dev server 起着；Chrome 由 perf/lib/chrome.mjs 自行查找）：
//   pnpm --dir apps/web dev --port 3787 --strictPort
//   node scripts/a11y/w9344-codehead-probe.mjs
// 产物：$W9344_SHOTS/probe.json + 若干 PNG（默认 tmp/w9344-probe）。
//
// ★ 刻意不进 `pnpm check`（与 w9336 / w2058 同一取向）：它需要 Vite + Chrome。
//   确定性断言在 apps/web/src/ui/enhance/code-copy.test.ts 与 code-layout.test.ts。
// ============================================================================
import { join } from 'node:path';
import {
  repoRoot, startFixture, launchProbeChrome, createProbe, createInput, sleep,
} from './lib/harness.mjs';

const VITE = process.env.W9344_VITE ?? process.env.W9111_VITE ?? 'http://127.0.0.1:3787';
const REPO = repoRoot('W9344_REPO');
const SHOTS = process.env.W9344_SHOTS ?? join(REPO, 'tmp', 'w9344-probe');
const PORT = Number(process.env.W9344_PORT ?? 3844);
const CDP = Number(process.env.W9344_CDP_PORT ?? 9494);

// ---- 页内脚本 --------------------------------------------------------------

/** 一条**超长行**的 JSON：逼出横向滚动（真机实测 scrollWidth 远大于 clientWidth）。 */
const LONG_JSON = JSON.stringify({
  ok: true,
  note: '长字段用于把这一行撑到必须横向滚动才能看全 —— ' + 'x'.repeat(420),
  rows: Array.from({ length: 3 }, (_, i) => ({ id: 'row-' + i, path: 'apps/web/src/ui/enhance/code-copy.ts' + i })),
});

/** 流式的分片：围栏不闭合 ⇒ 每节拍重跑增强链（主场景的关键）。 */
const CHUNKS = [
  '结果（run_code 的 JSON）：\n\n```json\n',
  LONG_JSON.slice(0, 180),
  LONG_JSON.slice(180, 360),
  LONG_JSON.slice(360),
  '\n',
  '\n```',
];

/**
 * 摆出主场景：用**真实模块**（ui/viewctx + ui/messages + ui/toolcards）造一个
 * `run_code` 工具卡，返回它的结果 JSON 块，然后**让助手消息继续流式**
 * （每个节拍重跑增强链的那条真实路径）。
 */
const SETUP = `(async function () {
  var V = await import('/src/ui/viewctx.ts');
  var M = await import('/src/ui/messages.ts');
  var T = await import('/src/ui/toolcards.ts');
  // code-copy / code-extras 已由真 main.ts 的插件装配进链（plugins/descriptor.ts），
  // 这里**不**自己注册 —— 手工注册就量不到「真装配」的那条路径了。
  var pane = V.ensurePane('w9344/main', 'session', 'W9344 取证');
  V.activatePane('w9344/main', 'session', 'W9344 取证');
  M.addUserMessage(pane, '用 run_code 跑一下这段 JSON：');

  // 真实工具卡路径（pushToolCard → 工具卡 → 工具结果 .tool-out）
  T.pushToolCard(pane, { id: 't1', name: 'run_code', args: { code: 'print(1)' } });
  T.applyToolResult(pane, { id: 't1', ok: true, value: ${JSON.stringify(JSON.parse(LONG_JSON))} });

  // ★ 主场景的关键：会话**仍在流**（setPaneStreaming 打开），围栏不闭合
  //   ⇒ 助手正文每节拍重跑整条增强链，而工具条/徽标/按钮是两个遍分别注入的。
  V.setPaneStreaming(pane, true);
  var a = M.ensureAssistant(pane);
  window.__w9344 = { V: V, M: M, T: T, pane: pane, view: a, tick: 0,
                    chunks: ${JSON.stringify(CHUNKS)} };
  await new Promise(function (r) { setTimeout(r, 120); });
  var pre = document.querySelector('.code-wrap pre');
  return { hasPre: pre !== null, streaming: pane.streaming === true };
})()`;

/** 再流 N 个节拍（**流式还没结束**）：每个节拍都会重跑整条增强链。 */
const TICK = (chunks) => `(async function () {
  var w = window.__w9344;
  var n = Math.min(${chunks}, w.chunks.length);
  for (var i = 0; i < n; i++) {
    w.M.appendText(w.pane, w.view, w.chunks[w.tick]);
    w.tick += 1;
    await new Promise(function (r) { setTimeout(r, 60); });
  }
  await new Promise(function (r) { setTimeout(r, 200); });
  return { tick: w.tick, streaming: w.pane.streaming === true };
})()`;

/**
 * 工具条几何 + 相交判定 + 滚动跟随（一次读完，避免多次强制布局抖动）。
 *
 * 关键量：
 *   · `copyRight/badgeRight` 与 `preRight`：证明徽标落在**右端**；
 *   · `headOverPre`：工具条与 pre 的轴对齐矩形**不相交**（不盖文字的第一层保证）；
 *   · `copyOverText/badgeOverText`：与 **pre 内可见文字**的包围盒是否相交（真·盖住文字）；
 *   · `copyBeforeBadge`：文档序 + x 序都是「复制在左」；
 *   · `rightGap`：徽标右缘到 wrap 右缘的距离（不贴边）。
 */
const GEO = `(function () {
  var wrap = document.querySelector('.code-wrap');
  if (!wrap) return { missing: true };
  var head = wrap.querySelector('.code-head');
  var pre = wrap.querySelector('pre');
  var copy = head && head.querySelector('button.code-copy');
  var badge = head && head.querySelector('.code-badge');
  if (!head || !pre || !copy || !badge) return { missing: true, has: {
    head: !!head, pre: !!pre, copy: !!copy, badge: !!badge } };
  var R = function (e) { if (!e) return null; var r = e.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
  var hit = function (a, b) {
    if (!a || !b) return false;
    return Math.min(a.right, b.right) - Math.max(a.x, b.x) > 0 &&
           Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 0;
  };
  // pre 内**可见文字**的包围盒（逐行合并；代码块被分成 .cl 行）
  var textBox = function () {
    var lines = pre.querySelectorAll('.cl');
    var pool = lines.length > 0 ? Array.from(lines) : [pre.querySelector('code')].filter(Boolean);
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
    for (var e of pool) {
      var r = e.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      n += 1;
      minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.right); maxY = Math.max(maxY, r.bottom);
    }
    return n === 0 ? null : { x: Math.round(minX), y: Math.round(minY),
      right: Math.round(maxX), bottom: Math.round(maxY) };
  };
  var wrapR = R(wrap), headR = R(head), preR = R(pre), copyR = R(copy), badgeR = R(badge);
  var tb = textBox();
  // 只在文字**当前可见**（落在 pre 的可视带内）的那部分上判相交 ——
  // 横向滚动时被推出视野的文字本就不该要求它避开控件。
  var visText = tb === null ? null : {
    x: Math.max(tb.x, preR.x), right: Math.min(tb.right, preR.right),
    y: Math.max(tb.y, preR.y), bottom: Math.min(tb.bottom, preR.bottom),
  };
  return {
    missing: false,
    order: Array.from(head.children).map(function (c) {
      return c.classList.contains('code-copy') ? 'copy' : c.classList.contains('code-badge') ? 'badge' : 'other';
    }).filter(function (x) { return x !== 'other'; }),
    // ★ 键名别与下面的可见文字包围盒重复：同名键会被后者覆盖（实测踩到：
    //   「可见文字」读出来是 [object Object]，断言于是假红）。
    btnText: copy.textContent,
    hasIcon: copy.querySelector('svg') !== null,
    iconHidden: copy.querySelector('svg') ? copy.querySelector('svg').getAttribute('aria-hidden') : null,
    aria: copy.getAttribute('aria-label'),
    title: copy.getAttribute('title'),
    tabIndex: copy.tabIndex,
    copy: copyR, badge: badgeR, head: headR, pre: preR, wrap: wrapR, text: visText,
    headOverPre: hit(headR, preR),
    copyOverText: hit(copyR, visText),
    badgeOverText: hit(badgeR, visText),
    copyBeforeBadgeX: copyR.x < badgeR.x,
    rightGap: wrapR.right - badgeR.right,
    leftGap: copyR.x - wrapR.x,
    scrollLeft: pre.scrollLeft,
    scrollWidth: pre.scrollWidth,
    clientWidth: pre.clientWidth,
    canScrollX: pre.scrollWidth > pre.clientWidth,
    // ★ W9347：工具条**在块内**（块的外壳现在是 .code-wrap，不是 pre）—— 量
    //   「工具条的矩形是否落在 wrap 的矩形之内」。这是"从块外一行收进块内右上角"的
    //   **后果**，不钉任何 px 常量。
    headInsideWrap: headR.x >= wrapR.x - 1 && headR.right <= wrapR.right + 1 &&
      headR.y >= wrapR.y - 1 && headR.bottom <= wrapR.bottom + 1,
    // ★ 首行没被压：工具条底 ≤ 首行文本框顶（短块场景的关键不变量）。
    headBottom: headR.bottom,
    wrapH: Math.round(wrapR.h),
    preH: Math.round(preR.h),
  };
})()`;

/** 横向滚到底（真滚轮打在 pre 上），回报控件是否**跟着滑走**。 */
const SCROLL_X = `(function () {
  var pre = document.querySelector('.code-wrap pre');
  if (!pre) return { missing: true };
  pre.scrollLeft = pre.scrollWidth;
  var head = pre.parentElement.querySelector('.code-head');
  var copy = head.querySelector('button.code-copy');
  var badge = head.querySelector('.code-badge');
  return {
    scrollLeft: Math.round(pre.scrollLeft),
    copyX: Math.round(copy.getBoundingClientRect().x),
    badgeX: Math.round(badge.getBoundingClientRect().x),
    headScrollLeft: head.scrollLeft,
  };
})()`;

/** 点一次复制（真鼠标），回报回显文本与 aria-label 变化。 */
const AFTER_CLICK = `(function () {
  var wrap = document.querySelector('.code-wrap');
  var copy = wrap.querySelector('button.code-copy');
  var note = wrap.querySelector('.code-copy-note');
  return {
    aria: copy.getAttribute('aria-label'),
    noteText: note ? note.textContent : null,
    noteRole: note ? note.getAttribute('role') : null,
    noteW: note ? Math.round(note.getBoundingClientRect().width) : 0,
    noteVisible: note ? getComputedStyle(note).display !== 'none' : false,
  };
})()`;

/** 焦点环的样式 + 底色（对比度在 Node 侧算，与 w9336 同口径）。 */
const FOCUS_RING = `(function () {
  var copy = document.querySelector('.code-wrap .code-head button.code-copy');
  if (!copy) return { missing: true };
  var cs = getComputedStyle(copy);
  var bgOf = function (el) {
    for (var n = el; n; n = n.parentElement) {
      var c = getComputedStyle(n).backgroundColor;
      if (c && c !== 'transparent' && !/rgba\\(0, 0, 0, 0\\)/.test(c)) return c;
    }
    return 'rgb(255, 255, 255)';
  };
  return {
    focused: document.activeElement === copy,
    focusVisible: copy.matches(':focus-visible'),
    outlineStyle: cs.outlineStyle,
    outlineWidth: cs.outlineWidth,
    outlineColor: cs.outlineColor,
    outlineOffset: cs.outlineOffset,
    ringBg: bgOf(copy.parentElement),
    iconColor: (function () {
      var p = copy.querySelector('svg path');
      return p ? getComputedStyle(p).stroke : null;
    })(),
  };
})()`;

// verdict 表 / 汇总 / 退出码都在 harness 里（判据、阈值、文案仍归本探针）。
const P = createProbe({ title: 'W9344 真机取证', shots: SHOTS, pad: 22 });
const verdict = P.verdict;
const round = (n) => Math.round(n * 10) / 10;

/** WCAG 相对亮度 / 对比度（与 w9336 的算式同口径）。 */
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

const main = async () => {
  const out = P.out;
  const fixture = await startFixture({
    port: PORT, label: 'w9344', repo: REPO, vite: VITE, session: { title: 'W9344 取证' },
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

    // ---- ① 流式中（每个节拍重跑增强链之后）：右上角 [复制图标] [json] ----
    // 逐节拍喂完整个围栏 ⇒ 增强链在「尾部未固化」的真实路径上至少重跑了 N 次。
    const ticks = [];
    for (let i = 0; i < CHUNKS.length; i += 1) {
      ticks.push(await ev(TICK(1)));
      await sleep(120);
    }
    await sleep(300);
    const geo = await ev(GEO);
    out.raw.ticks = ticks;
    out.raw.geo = geo;
    P.record('streamInProgress', ticks.length === CHUNKS.length && geo.missing === false &&
      ticks[ticks.length - 1]?.streaming === true && geo.canScrollX === true,
      `主场景：run_code 的 JSON 结果块在流中就位（${ticks.length} 个节拍喂完围栏，仍在流=` +
      `${ticks[ticks.length - 1]?.streaming}，每节拍重跑增强链）；块必须可横向滚动=${geo.canScrollX}` +
      `（scrollWidth=${geo.scrollWidth} > clientWidth=${geo.clientWidth}）`);
    P.record('headOrder', !geo.missing && String(geo.order) === 'copy,badge',
      `工具条文档序=${JSON.stringify(geo.order)}（期望 ["copy","badge"]）；` +
      `几何上复制 x=${geo.copy?.x} < json x=${geo.badge?.x} ⇒ ${geo.copyBeforeBadgeX}`);
    P.record('badgeTopRight', !geo.missing &&
      // 徽标落在工具条**右半区**（x 越过中线）且右缘不超出块 —— 这两条合起来
      // 就是「右上角」；边距由下一条 notFlushedToEdge 单独判（不重复判）。
      geo.badge.x > (geo.wrap.x + geo.wrap.w) / 2 && geo.badge.right <= geo.wrap.right,
      `json 徽标 x=${geo.badge?.x} 越过工具条中线 ${Math.round((geo.wrap?.x + geo.wrap?.w) / 2)}，` +
      `right=${geo.badge?.right} ≤ 块右缘 ${geo.wrap?.right} ⇒ 落在右上角`);
    P.record('notFlushedToEdge', !geo.missing && geo.rightGap >= 2 && geo.leftGap >= 0,
      `徽标右缘到块右缘 ${geo.rightGap}px、复制左缘到块左缘 ${geo.leftGap}px（都留了边距，没贴边）`);

    // ---- ② 复制是**图标**，且顺序在 json 左边 ----
    // ★ 名字在**首次注入时**就量（geo 早于任何点击）：回显结束后 setTimeout 会把
    //   aria-label 按 i18n 改回常态，所以「点过一次之后的常态」**测不出**
    //   「首次注入就没给名字」的变异（实测踩到）。
    P.record('iconNotText', !geo.missing && geo.hasIcon === true && geo.iconHidden === 'true' && geo.btnText === '',
      `复制控件含 svg=${geo.hasIcon}（aria-hidden=${geo.iconHidden}），可见文字=「${geo.btnText}」（空 ⇒ 是图标不是文字按钮）`);
    P.record('initialName', !geo.missing && /复制/.test(geo.aria ?? '') && (geo.title ?? '') !== '',
      `首次注入时的可访问名=「${geo.aria}」/ title=「${geo.title}」（在点击之前量的）`);

    // ---- ③ 不盖文字（铁律 ⑨ 的几何面：控件不许压正文）----
    P.record('noTextOverlap', !geo.missing && geo.headOverPre === false &&
      geo.copyOverText === false && geo.badgeOverText === false,
      `工具条与正文块相交=${geo.headOverPre}；复制图标压文字=${geo.copyOverText}；json 压文字=${geo.badgeOverText}`);

    // ---- ③' W9347：工具条在**块内**右上角，且首行**一点都没被压** ----
    P.record('headInsideBlock', !geo.missing && geo.headInsideWrap === true,
      `工具条矩形 @(${geo.head?.x},${geo.head?.y},${geo.head?.w}×${geo.head?.h}) 完全落在块 ` +
      `.code-wrap @(${geo.wrap?.x},${geo.wrap?.y},${geo.wrap?.w}×${geo.wrap?.h}) 之内 = ${geo.headInsideWrap}` +
      `（块总高 ${geo.wrapH}px，其中正文 pre 占 ${geo.preH}px）`);

    P.record('firstLineClear', !geo.missing && geo.text !== null &&
      geo.headBottom <= geo.text.y + 1,
      `工具条底 ${geo.headBottom} ≤ 首行文本框顶 ${geo.text?.y}（首行一个像素都没被压）`);

    // ---- ④ 长行横向滚动：控件不盖文字、也不跟着滑走 ----
    const scrolled = await ev(SCROLL_X);
    const geo2 = await ev(GEO);
    out.raw.scroll = { scrolled, geo2 };
    P.record('staysOnHScroll', !geo2.missing && scrolled.scrollLeft > 0 &&
      scrolled.copyX === geo.copy.x && scrolled.badgeX === geo.badge.x &&
      geo2.copyOverText === false && geo2.badgeOverText === false,
      `pre 横向滚到 scrollLeft=${scrolled.scrollLeft}（scrollWidth=${geo.scrollWidth} > clientWidth=${geo.clientWidth}）；` +
      `复制图标 x ${geo.copy?.x}→${scrolled.copyX}、json x ${geo.badge?.x}→${scrolled.badgeX}（都不动）；` +
      `滚到最右后仍压文字 复制=${geo2.copyOverText} json=${geo2.badgeOverText}`);
    await ev('(function(){var p=document.querySelector(".code-wrap pre"); p.scrollLeft=0; return true;})()');

    // ---- ⑤ 点图标能复制，成功有回显（且回显也进 a11y 树）----
    await input.click('.code-wrap .code-head button.code-copy', { hover: false });
    await sleep(200);
    const clicked = await ev(AFTER_CLICK);
    out.raw.click = clicked;
    P.record('copyFeedback', clicked.aria !== geo.aria &&
      typeof clicked.noteText === 'string' && clicked.noteText.length > 0 &&
      clicked.noteRole === 'status',
      `点图标后 aria-label「${geo.aria}」→「${clicked.aria}」；视觉回显=「${clicked.noteText}」` +
      `（role=${clicked.noteRole}，宽 ${clicked.noteW}px，可见=${clicked.noteVisible}）`);

    // ---- ⑥ 键盘可达 + 焦点环可见（真 Tab）----
    // ★ 起点取**工具卡自己的复制按钮**（它就在同一列、位于本工具条之前），
    //   然后一路真 Tab 到代码块工具条的复制图标 —— 真实判据是
    //   「顺序焦点能从上一站走到它」，而不是「从页首 Tab 几百次能到」。
    //   （从 document.body 起 Tab 要穿过整页所有控件，实测 >24 次走不到：
    //   那是探针量程问题，不是「键盘不可达」。）
    await ev(`(function () {
      var b = document.querySelector('.code-wrap .code-head button.code-copy');
      b.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    await sleep(150);
    const tabs = await input.tabTo('.code-wrap .code-head button.code-copy',
      { max: 12, from: '.toolcard-copy' });
    await sleep(80);
    const ring = await ev(FOCUS_RING);
    const ringHex = over(ring.outlineColor, ring.ringBg);
    const ringContrast = round(contrast(ringHex, ring.ringBg));
    out.raw.keyboard = { tabs, ring, ringHex, ringContrast };
    P.record('keyboard', tabs > 0 && ring.focused === true && ring.focusVisible === true &&
      ring.outlineStyle === 'solid' && parseFloat(ring.outlineWidth) >= 1,
      `${tabs} 次真 Tab 聚焦到复制图标；:focus-visible=${ring.focusVisible}，` +
      `outline=${ring.outlineStyle} ${ring.outlineWidth} ${ring.outlineColor}（图标描边色 ${ring.iconColor}）`);
    P.record('focusRingContrast', ringContrast >= 3,
      `焦点环合成色 ${ringHex} 对底色 ${ring.ringBg} = ${ringContrast}:1（WCAG 2.4.11 要求 ≥ 3:1）`);

    // ---- ⑦ 可访问性树：role=button + 名字带「复制」，图标不重复播报 ----
    // ★ 必须**先**等回显的 1.2s 过去、名字回到常态再量：否则量到的是
    //   「复制：已复制」—— 那条里同样含「复制」二字，**会把「名字压根没给」的
    //   变异掩盖过去**（W9344 变异负控制 A 实测踩到：探针当时全 PASS）。
    //   FEEDBACK_MS = 1200（code-copy.ts），多给 300ms 余量。
    await sleep(1500);
    const resting = await ev(`(function () {
      var c = document.querySelector('.code-wrap .code-head button.code-copy');
      return { aria: c.getAttribute('aria-label'),
               note: (c.parentElement.querySelector('.code-copy-note') || {}).textContent || '' };
    })()`);
    out.raw.resting = resting;
    P.record('restingName', /复制/.test(resting.aria ?? '') && resting.note === '',
      `回显消退后按钮的可访问名回到常态=「${resting.aria}」，视觉回显已清空=「${resting.note}」（空）`);

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
      }));
    };
    const btnAx = await axOf('.code-wrap .code-head button.code-copy');
    const svgAx = await axOf('.code-wrap .code-head button.code-copy svg');
    out.raw.ax = { button: btnAx, icon: svgAx };
    P.record('axTree', btnAx.some((n) => n.role === 'button' && n.ignored !== true && /复制/.test(n.name ?? '')) &&
      svgAx.every((n) => n.ignored === true),
      `复制控件在 ax 树里 = ${JSON.stringify(btnAx.map((n) => ({ role: n.role, name: n.name, ignored: n.ignored })))}；` +
      `图标节点 = ${JSON.stringify(svgAx.map((n) => ({ role: n.role, ignored: n.ignored })))}（应被忽略，不重复播报）`);

    // ---- ⑧ 视觉证据（两套主题各一张；形态本身不是断言）----
    for (const theme of ['mono', 'claude']) {
      await ev(`(function () { document.documentElement.dataset.theme = ${JSON.stringify(theme)}; return true; })()`);
      await sleep(120);
      await P.shots.save(page, 'codehead-' + theme + '.png');
    }
    // 流式中工具条特写（证明它长在真实渲染里，不是静态摆拍）
    const clip = await ev(`(function () {
      var w = document.querySelector('.code-wrap').getBoundingClientRect();
      return { x: Math.max(0, Math.round(w.x) - 8), y: Math.max(0, Math.round(w.y) - 8),
               width: Math.round(w.width) + 16, height: Math.min(360, Math.round(w.height) + 16), scale: 1 };
    })()`);
    if (clip.width > 0 && clip.height > 0) await P.shots.save(page, 'codehead-closeup.png', { clip });

    out.consoleErrors = consoleErrors;
    await P.finish({
      heading: 'W9344 真机取证（主场景：流式中的 run_code JSON 块）',
      pad: 22,
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
