#!/usr/bin/env node
// ============================================================================
// scripts/a11y/w9347-goal-capsule-probe.mjs — W9347「目标浮动胶囊」的真机取证
// ----------------------------------------------------------------------------
// ★ 主场景（探针**只承诺覆盖它**，其余不做）——
//   **设一个长目标之后**（主人原话：「在聊天栏的上方展示一个独立浮动胶囊显示这个 goal，
//   胶囊只占一行，大约 2 个汉字宽，过长文字可截断，右侧是 编辑/暂停/删除」）：
//     ① 胶囊**恰好一行**、**不占布局**（消息区的几何一个像素都没被推走）；
//     ② 文字区**≈2 个汉字宽**且**确实截断**（scrollWidth > clientWidth）；
//     ③ 三个图标都可见、命中区 ≥24×24（WCAG 2.5.8）；
//     ④ 点笔能改成新目标；点暂停进暂停态；点删除胶囊消失。
//   为什么要「长目标」当主场景：短目标压根不会触发截断 —— ① ② 只在有溢出时
//   才量得到（实测教训：静态摆拍量布局，量不到主场景里的 bug）。
//
// ★ ★ fetch 桩（必读）：后端 `POST /api/sessions/{id}/goal` 的 paused 扩展由**另一个
//   worker 同时在写**（W9347 契约 v1 的 B 段）。本探针在**页面里**用
//   `Fetch.enable` 拦下 `/api/sessions/*/goal` 并按契约 v1 应答（等价写不产生
//   通知、paused 恒在、无目标时 422）—— 也就是**这一段是桩**：证明的是
//   「**前端发对了请求 ⇒ UI 后果正确**」，不是「后端真会那样回」。
//   判定里的 `requestShape*` 几条就是在量「前端发出去的请求体对不对」，
//   那部分不是桩的产物（桩只在**应答**侧参与）。除此之外全部是真渲染、真几何。
//
// 用法（前置：Vite dev server 起着；Chrome 由 perf/lib/chrome.mjs 自行查找）：
//   pnpm --dir apps/web dev --port 3787 --strictPort
//   node scripts/a11y/w9347-goal-capsule-probe.mjs
// 产物：tmp/w9347-probe/probe.json + 若干 PNG。
//
// ★ 刻意不进 `pnpm check`（与 w9344 / w9336 同一取向）：它需要 Vite + Chrome。
//   确定性断言在 tests/w9347-goal-capsule-dom.test.ts。
// ============================================================================
import { join } from 'node:path';
import {
  repoRoot, startFixture, launchProbeChrome, createProbe, createInput, sleep,
} from './lib/harness.mjs';

const VITE = process.env.W9347_VITE ?? process.env.W9111_VITE ?? 'http://127.0.0.1:3787';
const REPO = repoRoot('W9347_REPO');
const SHOTS = process.env.W9347_SHOTS ?? join(REPO, 'tmp', 'w9347-probe');
const PORT = Number(process.env.W9347_PORT ?? 3847);
const CDP = Number(process.env.W9347_CDP_PORT ?? 9497);

/** 主人要验的「长目标」：必须长到 2 汉字宽装不下，否则截断这条根本量不到。 */
const LONG_GOAL = '把 W9347 的目标浮动胶囊按主人的原话落地：单行、约两个汉字宽、超长截断、'
  + '右侧编辑暂停删除三个图标，并且每一次变更都要在下一轮通知模型';

// ---- 页内脚本 ------------------------------------------------------------------

/** 起一个会话并把胶囊挂上（走**真实模块**，只换掉「数据从哪来」这一处）。 */
const SETUP = `(async function () {
  var V = await import('/src/ui/viewctx.ts');
  var G = await import('/src/ui/commands/goal.ts');
  V.ensurePane('w9347/main', 'session', 'W9347 取证');
  V.activatePane('w9347/main', 'session', 'W9347 取证');
  var pane = V.activePane();
  window.__w = { V: V, G: G, pane: pane, reqs: [] };
  // 记录真实 fetch 请求体（断言「前端发对了请求」的那几条量的是它）。
  var real = window.fetch.bind(window);
  window.fetch = function (url, init) {
    try {
      if (String(url).indexOf('/goal') >= 0) window.__w.reqs.push(JSON.parse(String(init && init.body || '{}')));
    } catch (e) { /* 非 JSON 不记 */ }
    return real(url, init);
  };
  await G.applyGoal(pane, ${JSON.stringify(LONG_GOAL)});
  await new Promise(function (r) { setTimeout(r, 250); });
  G.renderGoalBar();
  await new Promise(function (r) { setTimeout(r, 400); });
  return { paneId: pane.id, text: (G.goalOf(pane.id) || {}).text || '',
           activePaneId: (V.activePane() || {}).id || null,
           goalNow: !!(G.goalOf(pane.id)) };
})()`;

/**
 * 几何：一次性读完，避免多次强制布局抖动。
 *   · `oneLine`：胶囊高度 ≤ 一行（把它与同字体单行 span 的行高比 —— 不钉 px 常量）；
 *   · `floats`：胶囊是 absolute/fixed（**不占布局**）且不与消息列相交地「压」布局；
 *   · `noLayoutPush`：**决定性的一条** —— 设目标前后 #messages 的几何逐像素相同；
 *   · `truncates`：文字区 scrollWidth > clientWidth（**确实截断**，不是恰好放得下）；
 *   · `textWidthEm`：文字区宽 / 该字号一个汉字的宽 ≈ 2（用实测的汉字宽度算，不抄 em）。
 */
const GEO = `(function () {
  var cap = document.querySelector('.goal-capsule');
  if (!cap) return { missing: true };
  var text = cap.querySelector('.goal-capsule-text');
  if (!text) return { missing: true, noText: true, html: cap.outerHTML.slice(0, 600) };
  var acts = cap.querySelectorAll('.goal-capsule-actions button');
  var R = function (e) { var r = e.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
  // 一个汉字实测宽度：同一字号、同一字体的探针 span（不抄 1em 这个常数）。
  var probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;';
  probe.style.font = getComputedStyle(text).font;
  probe.textContent = '目';
  document.body.appendChild(probe);
  var han = probe.getBoundingClientRect().width;
  probe.remove();
  // 同字号单行的高度基准（胶囊只占一行的判据）。
  var line = document.createElement('div');
  line.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;';
  line.style.font = getComputedStyle(text).font;
  line.textContent = '目标';
  document.body.appendChild(line);
  var lineH = line.getBoundingClientRect().height;
  line.remove();
  var main = document.getElementById('main');
  var msgs = document.getElementById('messages');
  var buttons = Array.from(acts).map(function (b) {
    var r = b.getBoundingClientRect();
    var cs = getComputedStyle(b);
    return { act: b.dataset.act, name: b.getAttribute('aria-label'),
             w: Math.round(r.width), h: Math.round(r.height),
             visible: r.width > 0 && r.height > 0 &&
               (b.checkVisibility ? b.checkVisibility({ checkVisibilityCSS: true }) : true),
             hasIcon: b.querySelector('svg') !== null, cursor: cs.cursor };
  });
  // 消息区几何（与 SETUP 之前比 —— 「不占布局」的决定性判据）。
  // ★ 只取四个**共有**键（x/y/w/h），别把 R() 的 right/bottom 混进来比
  //   （基准快照没有它们，逐字 JSON.stringify 必不等 ⇒ 假红，实测踩到）。
  var box4 = function (e) { var r = e.getBoundingClientRect();
    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
  return {
    missing: false,
    pos: getComputedStyle(cap).position,
    cap: R(cap), text: R(text), buttons: buttons,
    // 活跃态的描边色（与暂停态比，证明「暂停态的区分是真的换了颜色」而不是只挂 class）。
    activeBorder: getComputedStyle(cap).borderTopColor,
    hidden: cap.classList.contains('hidden'),
    // 截断：内容比可见盒子宽（>0 差值），且 CSS 走的是 ellipsis。
    truncated: text.scrollWidth > text.clientWidth,
    scrollWidth: text.scrollWidth, clientWidth: text.clientWidth,
    textOverflow: getComputedStyle(text).textOverflow,
    whiteSpace: getComputedStyle(text).whiteSpace,
    textTitle: text.getAttribute('title') || text.title || '',
    textContent: text.textContent,
    hanWidth: Math.round(han * 100) / 100,
    textWidthEm: Math.round((text.getBoundingClientRect().width / han) * 100) / 100,
    // ★ 「只占一行」量的是**文字区渲染出的行数**（不是胶囊高）：胶囊高度由 ≥24px 的
    //   命中区按钮撑起来（那是命中区，不是行数）。判据 = 文字盒高 ÷ 单行高。
    lineHeightPx: Math.round(lineH * 100) / 100,
    textLines: Math.round((text.getBoundingClientRect().height / lineH) * 100) / 100,
    capLines: Math.round((cap.getBoundingClientRect().height / lineH) * 100) / 100,
    msgsBox: msgs ? box4(msgs) : null,
    messagesTop: msgs ? Math.round(msgs.getBoundingClientRect().y) : null,
    capBottom: Math.round(cap.getBoundingClientRect().bottom),
  };
})()`;

/** 编辑展开态：胶囊变成一行输入（不受 2 汉字宽限制）。 */
const EDIT_GEO = `(function () {
  var cap = document.querySelector('.goal-capsule');
  var input = cap && cap.querySelector('.goal-input');
  if (!input) return { missing: true };
  var r = input.getBoundingClientRect();
  var focused = document.activeElement === input;
  return { missing: false, focused: focused, value: input.value,
           w: Math.round(r.width), h: Math.round(r.height) };
})()`;

/** 请求体快照（断言「编辑保存发 text、暂停发 paused:true、删除发空串」）。 */
const REQS = `(function () { return window.__w.reqs.slice(); })()`;

/** 当前胶囊态（暂停区分 class、删除后是否隐藏、暂停角标**真的画出来了**）。 */
const STATE = `(function () {
  var cap = document.querySelector('.goal-capsule');
  if (!cap) return { missing: true };
  var mark = cap.querySelector('.goal-capsule-paused-mark');
  var markBox = null;
  if (mark) { var r = mark.getBoundingClientRect();
    markBox = { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x) }; }
  var text = cap.querySelector('.goal-capsule-text');
  var textBox = text ? text.getBoundingClientRect() : null;
  return { missing: false, hidden: cap.classList.contains('hidden'),
           paused: cap.classList.contains('goal-capsule-paused'),
           editing: cap.querySelector('.goal-input') !== null,
           text: text ? text.textContent : '',
           markText: mark ? mark.textContent : null,
           markBox: markBox,
           markVisible: !!(markBox && markBox.w > 0 && markBox.h > 0),
           // 角标在截断盒**外面**（x 不在 [text.x, text.right] 内）才看得见。
           markOutsideClip: !!(textBox && markBox && (markBox.x >= textBox.x + textBox.width - 1)),
           strike: text ? getComputedStyle(text).textDecorationLine : null };
})()`;

// verdict 表 / 汇总 / 退出码都在 harness 里（判据、阈值、文案仍归本探针）。
const P = createProbe({ title: 'W9347 真机取证', shots: SHOTS, pad: 24 });
const round = (n) => Math.round(n * 10) / 10;

/** 页内 fetch 桩：按冻结契约 v1 应答 goal 端点（见文件头 ★★）。 */
async function installGoalStub(page, sessionId) {
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/sessions/*/goal*' }] });
  let store = null;
  page.on('Fetch.requestPaused', async (ev) => {
    const body = JSON.parse(ev.request.postData || '{}');
    const hasText = Object.prototype.hasOwnProperty.call(body, 'text');
    const hasPaused = Object.prototype.hasOwnProperty.call(body, 'paused');
    let status = 200;
    if (!hasText && !hasPaused) status = 422;
    else {
      if (hasText) {
        const t = String(body.text).trim();
        store = t === '' ? null : { text: t, paused: store ? store.paused : false };
      }
      if (hasPaused && store === null) status = 422;
      else if (hasPaused) store = { text: store.text, paused: body.paused === true };
    }
    const goal = store === null
      ? null
      : { text: store.text, paused: store.paused, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    await page.send('Fetch.fulfillRequest', {
      requestId: ev.requestId,
      responseCode: status,
      responseHeaders: [{ name: 'content-type', value: 'application/json; charset=utf-8' }],
      body: Buffer.from(JSON.stringify(status === 200
        ? { ok: true, session: sessionId, goal }
        : { ok: false, error: 'cannot pause: no goal' }), 'utf8').toString('base64'),
    });
  });
}

const main = async () => {
  const out = P.out;
  const fixture = await startFixture({
    port: PORT, label: 'w9347', repo: REPO, vite: VITE, session: { title: 'W9347 取证' },
  });
  const browser = await launchProbeChrome({ port: CDP, width: 1440, height: 900 });
  const { page } = browser;
  const consoleErrors = browser.consoleErrors;
  out.consoleErrors = consoleErrors;
  const ev = (s) => page.eval(s);
  const input = createInput(page);
  /**
   * 目标不存在时**记 false 而不是抛**：抛出去整份 verdict 表就打不出来，
   * 读者只看到一个 TypeError，看不到本该红的几何断言（变异负控制实测）。
   */
  const safeClick = async (sel) => {
    const at = await ev(`(function () { return document.querySelector(${JSON.stringify(sel)}) !== null; })()`);
    if (at !== true) return false;
    await input.click(sel, { hover: false });
    return true;
  };

  try {
    await page.navigate('http://127.0.0.1:' + PORT + '/');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(2400);
    // ★ 重载一次：开发态 Vite 会在源码改动后给**页面里已加载的**那个模块打上 ?t=
    //   时间戳，而探针按路径 import 拿到的是**无时间戳的另一份** —— 于是同一段代码在
    //   页面里存在两个模块实例（各自的模块级状态），胶囊会在 #messages 里出现两个。
    //   重载让 app 与探针都从「无 ?t= 的那一份」起，模块实例重新合一。
    await page.send('Page.reload', { ignoreCache: false });
    await sleep(2600);
    await installGoalStub(page, 'w9347/main');

    // ---- 基准：还没有目标时，消息区几何（用来判「不占布局」） ----
    const before = await ev(`(function () {
      var m = document.getElementById('messages');
      var r = m.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    })()`);
    out.raw.before = before;

    // ---- 设一个长目标（主场景） ----
    const setup = await ev(SETUP);
    out.raw.setup = setup;
    const geo = await ev(GEO);
    out.raw.geo = geo;
    if (geo.missing === true) {
      // 诊断优先于判定：胶囊没画出时先把真实 DOM 与 setup 结果摊开（否则下游每一行
      // 都在报「读 undefined」，把真因埋在最后一堆 TypeError 里）。
      console.log('SETUP 诊断: ' + JSON.stringify(setup, null, 2));
      console.log('GEO 诊断: ' + JSON.stringify(geo, null, 2));
      const dupes = await ev(`(function () {
        var all = document.querySelectorAll('.goal-capsule');
        return { count: all.length, hosts: Array.prototype.map.call(all, function (c) {
          return (c.parentElement && c.parentElement.id) || (c.parentElement && c.parentElement.className) || '?';
        }) };
      })()`);
      console.log('胶囊实例: ' + JSON.stringify(dupes));
    }

    P.record('capsuleShown', geo.missing === false && geo.hidden === false && geo.textContent.length > 0,
      `设了长目标后胶囊出现：hidden=${geo.hidden}，文字 ${String(geo.textContent).length} 字` +
      `（「${String(geo.textContent).slice(0, 18)}…」），几何 ${geo.cap?.w}×${geo.cap?.h}px`);

    // ① 恰好一行（量**文字区**的行数；胶囊高度由 ≥24px 的命中区按钮撑起，那不是行数）
    P.record('oneLine', geo.missing === false && geo.textLines <= 1.15,
      `文字区高 ${geo.text?.h}px ÷ 同字号单行高 ${geo.lineHeightPx}px = **${geo.textLines} 行**（≤1.15 ⇒ 恰好一行；` +
      `判据是比值不是 px 常量 —— 换字号/主题不会假红）。胶囊整高 ${geo.cap?.h}px（= ${geo.capLines}× 行高，` +
      `多出来的是 ≥24px 的命中区按钮，不是第二行文字）`);

    // ① 浮动：不占布局
    P.record('floatsNoLayout', geo.missing === false && (geo.pos === 'absolute' || geo.pos === 'fixed') &&
      JSON.stringify(geo.msgsBox) === JSON.stringify(before),
      `胶囊 position=${geo.pos}（浮动）；设目标前后 #messages 几何 [x,y,w,h] 逐像素相同：` +
      `${JSON.stringify(before)} vs ${JSON.stringify(geo.msgsBox)} ⇒ 消息区一个像素都没被推走`);

    // ② 文字区 ≈2 汉字宽 + 确实截断
    P.record('truncates', geo.missing === false && geo.truncated === true && geo.textOverflow === 'ellipsis',
      `文字区 scrollWidth=${geo.scrollWidth} > clientWidth=${geo.clientWidth} ⇒ **确实截断**` +
      `（text-overflow=${geo.textOverflow}, white-space=${geo.whiteSpace}）`);

    P.record('twoHanWide', geo.missing === false && geo.textWidthEm >= 1.5 && geo.textWidthEm <= 2.5,
      `文字区宽 ${geo.text?.w}px ÷ 该字号一个汉字实测 ${geo.hanWidth}px = **${geo.textWidthEm} 汉字**` +
      `（目标「大约 2 个汉字」；汉字宽是**实测**的，不是抄 1em）`);

    P.record('fullTextInTitle', geo.missing === false && String(geo.textTitle).includes('W9347'),
      `截断后的完整文本在 title 里（悬停可读）：「${String(geo.textTitle).slice(0, 40)}…」`);

    // 胶囊贴在消息区**上缘**（聊天栏的上方），且不飘到顶栏那边去
    P.record('aboveMessages', geo.missing === false && geo.cap.y >= (geo.messagesTop ?? 0) - 2 &&
      geo.cap.y - (geo.messagesTop ?? 0) <= 24,
      `胶囊上缘 y=${geo.cap?.y}，#messages 上缘 y=${geo.messagesTop} ⇒ 贴在消息区上缘往下 ` +
      `${geo.cap?.y - (geo.messagesTop ?? 0)}px 处（浮在消息之上、盖住首条消息不超过一行的量）`);

    // ③ 三个图标都可见、命中区 ≥24、顺序对
    const order = geo.buttons.map((b) => b.act);
    P.record('threeActsVisible', geo.missing === false && geo.buttons.length === 3 &&
      String(order) === 'pencil,pause-glyph,trash' && geo.buttons.every((b) => b.visible && b.hasIcon && b.name),
      `三个图标按钮，顺序=${JSON.stringify(order)}（编辑/暂停/删除），都可见=${geo.buttons.map((b) => b.visible).join(',')}、` +
      `都是 svg 图标、都有可访问名=${JSON.stringify(geo.buttons.map((b) => b.name))}`);

    const minSide = Math.min(...geo.buttons.map((b) => Math.min(b.w, b.h)));
    P.record('hitArea24', geo.missing === false && minSide >= 24,
      `三个按钮命中区 ${geo.buttons.map((b) => b.w + '×' + b.h).join(' / ')}px；最小边 ${minSide}px ≥ 24（WCAG 2.5.8）`);

    // ④ 点笔 → 展开成输入（不受 2 汉字宽限制）
    await input.click('.goal-capsule-actions button[data-act="pencil"]', { hover: false });
    await sleep(250);
    const edit = await ev(EDIT_GEO);
    out.raw.edit = edit;
    P.record('editExpands', edit.missing === false && edit.focused === true && edit.w > geo.clientWidth,
      `点笔后胶囊展开成输入框：已聚焦=${edit.focused}，宽 ${edit.w}px > 收起态文字区 ${geo.clientWidth}px` +
      ` ⇒ 展开态**不受 2 汉字宽限制**；原值已预填`);

    // ④ 改成新目标（真键盘：全选 + 重打 + Enter）
    // ★ 找不到输入框时**不抛**：抛出去会让整份 verdict 表打不出来（变异负控制实测：
    //   把胶囊改成占布局时，展开态的输入框根本画不出来，探针在第一处崩掉，
    //   读者只看到一个 TypeError，看不到本该红的 floatsNoLayout）。此处只记 false。
    const typing = await ev(`(function () {
      var i = document.querySelector('.goal-input');
      if (!i) return { found: false };
      i.value = '改过的新目标：跑通真机探针';
      return { found: true, value: i.value };
    })()`);
    if (typing.found === true) await input.press('Enter', 'Enter', 13);
    await sleep(400);
    const afterEdit = await ev(STATE);
    const reqsAfterEdit = await ev(REQS);
    out.raw.afterEdit = { typing, state: afterEdit, reqs: reqsAfterEdit };
    P.record('editSaves', typing.found === true && !afterEdit.editing &&
      String(afterEdit.text).includes('跑通真机探针') &&
      JSON.stringify(reqsAfterEdit[reqsAfterEdit.length - 1]) === JSON.stringify({ text: '改过的新目标：跑通真机探针' }),
      `Enter 保存：胶囊收起、文字变成「${afterEdit.text}」，最后一条请求体=${JSON.stringify(reqsAfterEdit[reqsAfterEdit.length - 1])}`);

    // ④ 点暂停 → 暂停态（可见区分）；再点文字本体恢复
    await safeClick('.goal-capsule-actions button[data-act="pause-glyph"]');
    await sleep(350);
    const paused = await ev(STATE);
    const reqsPaused = await ev(REQS);
    out.raw.paused = { state: paused, reqs: reqsPaused };
    P.record('pauseToggles', paused.paused === true && paused.hidden === false &&
      JSON.stringify(reqsPaused[reqsPaused.length - 1]) === JSON.stringify({ paused: true }),
      `点暂停：胶囊进入暂停态（class=${paused.paused}，仍可见），请求体=${JSON.stringify(reqsPaused[reqsPaused.length - 1])}`);

    // 暂停态的**可见区分**必须真的画出来了：角标可见 + 在截断盒之外（否则被裁掉），
    // 文字有删除线，描边色也与活跃态不同（不只靠一个 class 名）。
    const pausedBorder = await ev(`(function () {
      var c = document.querySelector('.goal-capsule');
      if (!c) return { border: null, color: null };
      return { border: getComputedStyle(c).borderTopColor, color: getComputedStyle(c).color };
    })()`);
    out.raw.pausedBorder = pausedBorder;
    P.record('pausedLooksDifferent', paused.paused === true && paused.markVisible === true &&
      paused.markOutsideClip === true && String(paused.strike).includes('line-through') &&
      pausedBorder.border !== geo.activeBorder,
      `暂停态的可见区分（**必须画出来，不只是挂个 class**）：角标「${paused.markText}」` +
      `${paused.markBox?.w}×${paused.markBox?.h}px 可见=${paused.markVisible}，` +
      `且落在 2 汉字宽截断盒**之外**（角标 x=${paused.markBox?.x} ≥ 文字右缘）=${paused.markOutsideClip}，` +
      `文字删除线=${paused.strike}；描边色 活跃=${geo.activeBorder} → 暂停=${pausedBorder.border}（不同=${pausedBorder.border !== geo.activeBorder}）`);

    // 暂停态点文字本体 = 恢复
    await safeClick('.goal-capsule button.goal-capsule-text');
    await sleep(350);
    const resumed = await ev(STATE);
    const reqsResume = await ev(REQS);
    out.raw.resume = { state: resumed, reqs: reqsResume };
    P.record('pausedClickResumes', resumed.paused === false &&
      JSON.stringify(reqsResume[reqsResume.length - 1]) === JSON.stringify({ paused: false }),
      `暂停态点文字本体 = 恢复：class=${resumed.paused}，请求体=${JSON.stringify(reqsResume[reqsResume.length - 1])}`);

    // ④ 点删除 → 胶囊消失
    await safeClick('.goal-capsule-actions button[data-act="trash"]');
    await sleep(350);
    const gone = await ev(STATE);
    const reqsDelete = await ev(REQS);
    out.raw.gone = { state: gone, reqs: reqsDelete };
    P.record('deleteRemoves', gone.hidden === true && JSON.stringify(reqsDelete[reqsDelete.length - 1]) === JSON.stringify({ text: '' }),
      `点删除：胶囊消失（hidden=${gone.hidden}），请求体=${JSON.stringify(reqsDelete[reqsDelete.length - 1])}（空串 text = 删除）`);

    // ---- 视觉证据：设回长目标，两套主题各一张（形态本身不是断言） ----
    await ev(SETUP);
    await sleep(350);
    for (const theme of ['mono', 'claude']) {
      await ev(`(function () { document.documentElement.dataset.theme = ${JSON.stringify(theme)}; return true; })()`);
      await sleep(150);
      await P.shots.save(page, 'goal-capsule-' + theme + '.png');
    }
    await ev(`(function () { document.documentElement.dataset.theme = 'mono'; return true; })()`);
    // 暂停态特写（证明暂停态是**画得出来的**，不是只有一个 class）
    await safeClick('.goal-capsule-actions button[data-act="pause-glyph"]');
    await sleep(350);
    const clip = await ev(`(function () {
      var c = document.querySelector('.goal-capsule');
      if (!c) return { width: 0, height: 0 };
      var b = c.getBoundingClientRect();
      return { x: Math.max(0, Math.round(b.x) - 12), y: Math.max(0, Math.round(b.y) - 12),
               width: Math.round(b.width) + 24, height: Math.round(b.height) + 24, scale: 2 };
    })()`);
    if (clip.width > 0 && clip.height > 0) await P.shots.save(page, 'goal-capsule-paused-closeup.png', { clip });
    // 展开编辑态特写
    await safeClick('.goal-capsule-actions button[data-act="pause-glyph"]'); // 恢复
    await sleep(250);
    await safeClick('.goal-capsule-actions button[data-act="pencil"]');
    await sleep(250);
    const clip2 = await ev(`(function () {
      var c = document.querySelector('.goal-capsule');
      if (!c) return { width: 0, height: 0 };
      var b = c.getBoundingClientRect();
      return { x: Math.max(0, Math.round(b.x) - 12), y: Math.max(0, Math.round(b.y) - 12),
               width: Math.round(b.width) + 24, height: Math.round(b.height) + 24, scale: 2 };
    })()`);
    if (clip2.width > 0 && clip2.height > 0) await P.shots.save(page, 'goal-capsule-editing-closeup.png', { clip: clip2 });

    // ---- 无目标时：胶囊不出现（真几何：display:none ⇒ 无盒子） ----
    await ev(`(async function () {
      var G = await import('/src/ui/commands/goal.ts');
      await G.applyGoal(window.__w.pane, '');
      G.renderGoalBar();
      return true;
    })()`);
    await sleep(300);
    const none = await ev(`(function () {
      var c = document.querySelector('.goal-capsule');
      if (!c) return { missing: true };
      var r = c.getBoundingClientRect();
      return { hidden: c.classList.contains('hidden'), display: getComputedStyle(c).display,
               w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
    out.raw.noGoal = none;
    P.record('noGoalNoCapsule', none.hidden === true && none.display === 'none' && none.w === 0,
      `无目标时：hidden=${none.hidden}，display=${none.display}，盒子 ${none.w}×${none.h}px ⇒ 胶囊不出现、**不占位**`);

    out.consoleErrors = consoleErrors;
    await P.finish({
      heading: 'W9347 真机取证（主场景：设一个长目标之后的浮动胶囊）',
      pad: 24,
      jsonPath: join(SHOTS, 'probe.json'),
      trailer: [
        '★ 桩说明：/api/sessions/{id}/goal 的**应答侧**是页内 fetch 桩（后端 paused 扩展由',
        '  另一个 worker 同时在写）。requestShape 类断言量的是前端**真的发出去的请求体**（非桩产物）。',
        '产物：' + SHOTS,
      ],
      exitCodeOnFail: 1,
    });
  } finally {
    await browser.close();
    await fixture.close();
  }
};

main().catch((err) => { console.error(err); process.exit(1); });
