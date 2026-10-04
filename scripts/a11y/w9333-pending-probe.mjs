#!/usr/bin/env node
// ============================================================================
// scripts/a11y/w9333-pending-probe.mjs — W9333：「等待反馈」占位的**真机取证**探针
// ----------------------------------------------------------------------------
// 按铁律 11：jsdom 量不了的后果**移到真机**，而不是退回钉机制（不钉 position /
// box-shadow / 某个 px 常量）。本探针量的是**重做后的真应用**（不是原型）。
//
// 六条后果（每条都要排版 / 动画时钟 / 可访问性树才能量）：
//   ① 占位就在**助手那一格**：列的左缘与宽度与助手列逐像素一致（同缩进、同宽度上限）；
//   ② **就地替换不跳版**：首个 token 接管后，正文列的**顶边**与占位顶边相差 0px，
//      且列的位置（兄弟序号）与节点身份都不变；
//   ③ **脉冲星芒的节律**（定格相位）：负 animation-delay + animation-play-state: paused，
//      **保留每颗星各自的偏移**（calc(var(--d) + .18s)）；扫相位读三颗星的实际透明度 ——
//      任何相位下三颗都不得一样亮，且三颗的峰值**依次**出现（间隔 ≈ .18s）。
//      这一条正是原型踩过的坑（「七帧一模一样」），所以必须量「不一样」本身。
//   ④ **animation-fill-mode: backwards 是承重的**：把基准延迟设成**正**的大值
//      （10s ⇒ 三颗都还在延迟期），再对比 `fill-mode: none` —— 没有 backwards 时
//      还没开始动的那两颗渲染的是**基础样式**（满亮 1.0），有 backwards 时是 0% 关键帧
//      （0.32）。这是真机上的**变异负控制**：差异就是那一条声明的价值。
//   ⑤ **prefers-reduced-motion 停动效**（CDP 媒体仿真）：动效被 tokens.css 的全局块
//      关掉（duration → 0.001ms），而阶段标签与「用时」照常、秒数照常走。
//   ⑥ **秒数不进可访问性树**（CDP Accessibility.getFullAXTree）：aria-hidden 的秒数
//      节点必须不出现在可播报节点里；阶段标签是 live=polite 的 status。
//
// ★ W9340：脚手架（静态 fixture 服务端 / Vite 反代 / 截图落盘 / verdict 表 +
//   PASS/FAIL 汇总 + 退出码）已收进 scripts/a11y/lib/harness.mjs —— 本文件只剩
//   「场景 + 断言」。原先「请求处理器里不许有同步阻塞调用」（W9323）那条自律现在
//   由 harness 结构性保证（它一个同步 fs 都不 import）。
//
// 用法：
//   pnpm --dir apps/web dev --port 3787 --strictPort      # 前置（本脚本只读 /src/**）
//   W9111_CHROME=<chrome-headless-shell> node scripts/a11y/w9333-pending-probe.mjs
//
// ★ 刻意不进门禁（与 w9329/w2058 同一取向）：需要 Vite dev server + Chrome。
//   确定性断言在 tests/w9333-pending-placeholder.test.ts。
// ============================================================================
import { join } from 'node:path';
import {
  repoRoot, startFixture, launchProbeChrome, createProbe, sleep,
} from './lib/harness.mjs';

const VITE = process.env.W9333_VITE ?? process.env.W9111_VITE ?? 'http://127.0.0.1:3787';
const REPO = repoRoot('W9333_REPO');
const SHOTS = process.env.W9333_SHOTS ?? join(REPO, 'tmp', 'w9333-probe');
const PORT = Number(process.env.W9333_PORT ?? 3833);
const CDP = Number(process.env.W9333_CDP_PORT ?? 9483);

/** 页内：把占位放好（走真组件），并把量到的几何读回来。 */
const SETUP = `(async function () {
  var V = await import('/src/ui/viewctx.ts');
  V.initViewCtx();
  var pane = V.ensurePane('w9333/main', 'session', 'W9333 取证');
  V.activatePane('w9333/main', 'session', 'W9333 取证');
  var P = await import('/src/ui/messages/pending.ts');
  window.__w9333 = { V: V, pane: pane, P: P };
  P.showPending(pane, 'delivering', Date.now());
  return true;
})()`;

/** 页内：量几何（占位 vs 助手列）。 */
const GEOM = `(function () {
  var q = function (s) { return document.querySelector(s); };
  var R = function (el) { if (!el) return null; var r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2),
             right: +r.right.toFixed(2), bottom: +r.bottom.toFixed(2) }; };
  var pane = window.__w9333.pane;
  var col = q('.sess-pane.is-active .msg.assistant.pend');
  var colEl = col ? col.parentElement : null;
  return {
    pane: R(pane.el),
    pendMsg: R(col),
    pendCol: R(colEl),
    pendColIndex: colEl ? Array.prototype.indexOf.call(pane.el.children, colEl) : -1,
    childCount: pane.el.children.length,
    isLast: colEl ? colEl === pane.el.lastElementChild : null,
    label: q('.pend-lab') ? q('.pend-lab').textContent : null,
    secs: q('.pend-secs') ? q('.pend-secs').textContent : null,
    secsHidden: q('.pend-secs') ? q('.pend-secs').getAttribute('aria-hidden') : null,
    liveCount: document.querySelectorAll('[aria-live]').length,
    labelLive: q('.pend-lab') ? q('.pend-lab').getAttribute('aria-live') : null,
    labelRole: q('.pend-lab') ? q('.pend-lab').getAttribute('role') : null,
    starCount: document.querySelectorAll('.pend-star').length
  };
})()`;

/** 页内：首个 token 接管（走真 ensureAssistant）。 */
const TAKE = `(async function () {
  var M = await import('/src/ui/messages.ts');
  var s = window.__w9333;
  var pendCol = document.querySelector('.msg.assistant.pend').parentElement;
  window.__w9333.pendCol = pendCol;
  var a = M.ensureAssistant(s.pane);
  M.appendText(s.pane, a, '首个 token 到了。');
  await new Promise(function (r) { setTimeout(r, 60); });
  var R = function (el) { if (!el) return null; var r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) }; };
  var col = document.querySelector('.sess-pane.is-active .msg.assistant .bubble').parentElement.parentElement;
  return {
    sameNode: col === pendCol,
    colRect: R(col),
    colIndex: Array.prototype.indexOf.call(s.pane.el.children, col),
    childCount: s.pane.el.children.length,
    pendGone: document.querySelector('.msg.assistant.pend') === null,
    text: (document.querySelector('.sess-pane.is-active .msg.assistant .content') || {}).textContent || null
  };
})()`;

/**
 * 页内：定格相位读三颗星的实际透明度。
 * ★ 保留每颗星**各自的**偏移（calc(var(--d) + .18s)）——用同一条 --d 覆盖所有星
 *   会强制同相，正好把要测的「依次」抹掉。基准 --d 由调用方给（负值 = 进入活动期，
 *   正的大值 = 停在延迟期，用于量 fill-mode 的后果）。
 */
const freezeFn = (d, fillNone) => `(function () {
  var st = document.getElementById('w9333-freeze');
  if (!st) { st = document.createElement('style'); st.id = 'w9333-freeze'; document.head.appendChild(st); }
  st.textContent = ':root{--d:${d}s}'
    + '.pend-star{animation-delay:calc(var(--d) + 0s) !important;animation-play-state:paused !important;'
    + '${fillNone ? 'animation-fill-mode:none !important;' : ''}' + '}'
    + '.pend-star.s2{animation-delay:calc(var(--d) + .18s) !important}'
    + '.pend-star.s3{animation-delay:calc(var(--d) + .36s) !important}';
  var out = Array.prototype.map.call(document.querySelectorAll('.pend-star'), function (p) {
    var cs = getComputedStyle(p);
    var r = p.getBoundingClientRect();
    return { o: +cs.opacity, t: cs.transform, cx: +(r.x + r.width / 2).toFixed(2), cy: +(r.y + r.height / 2).toFixed(2),
             dur: cs.animationDuration, fill: cs.animationFillMode, state: cs.animationPlayState };
  });
  return out;
})()`;

// verdict 表 / 汇总 / 退出码都在 harness 里（判据、阈值、文案仍归本探针）。
const P = createProbe({ title: 'W9333 真机取证', shots: SHOTS, pad: 22 });
const verdict = P.verdict;
const round2 = (n) => Math.round(n * 100) / 100;

const main = async () => {
  const out = P.out;
  const fixture = await startFixture({ port: PORT, label: 'w9333', repo: REPO, vite: VITE, session: { title: 'W9333 取证' } });
  const browser = await launchProbeChrome({ port: CDP, width: 1440, height: 900 });
  const { page } = browser;
  const consoleErrors = browser.consoleErrors;
  out.consoleErrors = consoleErrors;
  const ev = (s) => page.eval(s);

  try {
    await page.navigate('http://127.0.0.1:' + PORT + '/');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(2200);
    await ev(SETUP);
    await sleep(250);
    // 视觉证据（形态本身不是断言：颜色/间距由 token 决定，见 pending.css）
    for (const theme of ['mono', 'dark']) {
      await ev(`(function(){ document.documentElement.dataset.theme = '${theme}'; return true; })()`);
      await sleep(80);
      await P.shots.save(page, 'pending-' + theme + '.png');
    }
    await ev(`(function(){ document.documentElement.dataset.theme = 'mono'; return true; })()`);
    await sleep(60);
    out.raw.shape = await ev(`(function(){
      var msg = document.querySelector('.sess-pane.is-active .msg.assistant.pend');
      var box = document.querySelector('.pend-ico-box'); var svg = document.querySelector('.pend-ico');
      var R = function (el) { if (!el) return null; var r = el.getBoundingClientRect();
        return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) }; };
      var cs = msg ? getComputedStyle(msg) : null;
      return { msg: R(msg), icoBox: R(box), svg: R(svg), lab: R(document.querySelector('.pend-lab')),
               msgDisplay: cs ? cs.display : null, msgMinH: cs ? cs.minHeight : null, msgPad: cs ? cs.padding : null,
               msgH: cs ? cs.height : null, gap: cs ? cs.gap : null };
    })()`);

    // ---- ① 占位在助手那一格 + ② 就地替换不跳版 ----
    const before = await ev(GEOM);
    out.raw.before = before;
    const after = await ev(TAKE);
    out.raw.after = after;
    // 与助手列比几何：接管后那一列的左缘/宽度必须与占位列逐像素一致。
    const dx = round2(after.colRect.x - before.pendCol.x);
    const dw = round2(after.colRect.w - before.pendCol.w);
    const dy = round2(after.colRect.y - before.pendCol.y);
    out.consequences.slot = verdict(
      before.pendCol !== null && before.isLast === true && before.pendCol.w <= before.pane.w &&
        Math.abs(dx) <= 0.5 && Math.abs(dw) <= 0.5,
      `占位列 x=${before.pendCol?.x} w=${before.pendCol?.w}（pane w=${before.pane?.w}，末尾=${before.isLast}）`,
    );
    out.consequences.inPlace = verdict(
      after.sameNode === true && Math.abs(dy) <= 0.5 && after.colIndex === before.pendColIndex &&
        after.pendGone === true && before.childCount === after.childCount,
      `同一节点=${after.sameNode} 顶边位移=${dy}px 列序号 ${before.pendColIndex}→${after.colIndex} 占位已消失=${after.pendGone}`,
    );

    // ---- ③ 脉冲星芒的节律（定格相位扫描）----
    // 重新放一个占位（接管后没有 .pend-star 了）
    await ev(`(async function(){ var s = window.__w9333; s.P.showPending(s.pane, 'awaiting', Date.now()); return true; })()`);
    await sleep(120);
    const sweep = [];
    const STEP = 0.05;
    for (let i = 0; i <= 27; i += 1) {
      const d = round2(-i * STEP);
      const stars = await ev(freezeFn(d, false));
      sweep.push({ d, o: stars.map((s) => s.o), dur: stars[0]?.dur, fill: stars[0]?.fill, state: stars[0]?.state, cx: stars.map((s) => s.cx), cy: stars.map((s) => s.cy) });
    }
    out.raw.sweep = sweep;
    const spread = sweep.map((f) => round2(Math.max(...f.o) - Math.min(...f.o)));
    const minSpread = Math.min(...spread);
    const maxSpread = Math.max(...spread);
    const argmax = [0, 1, 2].map((k) => sweep.reduce((best, f, i) => (f.o[k] > sweep[best].o[k] ? i : best), 0));
    const gap12 = round2((argmax[1] - argmax[0]) * STEP);
    const gap23 = round2((argmax[2] - argmax[1]) * STEP);
    const ranges = [0, 1, 2].map((k) => round2(Math.max(...sweep.map((f) => f.o[k])) - Math.min(...sweep.map((f) => f.o[k]))));
    out.consequences.rhythm = verdict(
      minSpread > 0.05 && maxSpread > 0.4 && ranges.every((r) => r > 0.4) &&
        argmax[0] < argmax[1] && argmax[1] < argmax[2] && Math.abs(gap12 - 0.18) <= 0.08 && Math.abs(gap23 - 0.18) <= 0.08,
      `相位扫描 ${sweep.length} 帧：三颗星的亮度差 min=${minSpread} max=${maxSpread}；` +
        `各自明暗幅度=${JSON.stringify(ranges)}；峰值依次出现在 d=${sweep[argmax[0]].d}/${sweep[argmax[1]].d}/${sweep[argmax[2]].d}s（间隔 ${gap12}s / ${gap23}s，设计 .18s）`,
    );
    // 缩放是否以星心为中心（path 的 transform-origin = g 平移后的 (0,0)）：
    // 绕星心缩放 ⇒ **每一颗自己**的星心不动（三颗星的 x 本来就不同，不能跨星取极差）。
    const cxDrift = round2(Math.max(...[0, 1, 2].map((k) =>
      Math.max(...sweep.map((f) => f.cx[k])) - Math.min(...sweep.map((f) => f.cx[k])))));
    out.consequences.scaleOrigin = verdict(cxDrift <= 0.5, `整轮扫描里三颗星的星心 x 漂移 ${cxDrift}px（≤0.5 ⇒ 缩放绕星心，不是绕原点）`);

    // ---- ④ animation-fill-mode: backwards 的后果（真机变异负控制）----
    const beforePhase = await ev(freezeFn(10, false)); // 基准 +10s ⇒ 三颗都停在延迟期
    const withoutFill = await ev(freezeFn(10, true)); // 同相位，去掉 backwards
    out.raw.fillMode = { backwards: beforePhase.map((s) => s.o), none: withoutFill.map((s) => s.o) };
    out.consequences.fillModeBackwards = verdict(
      beforePhase.every((s) => s.o <= 0.36) && withoutFill.every((s) => s.o >= 0.99),
      `延迟期渲染：有 backwards ⇒ 透明度 ${JSON.stringify(beforePhase.map((s) => s.o))}（0% 关键帧 .32）；` +
        `去掉 backwards ⇒ ${JSON.stringify(withoutFill.map((s) => s.o))}（基础样式满亮）`,
    );

    // ---- ⑤ prefers-reduced-motion 停动效，文字与秒数照常 ----
    await ev(`(function(){ var st = document.getElementById('w9333-freeze'); if (st) st.textContent = ''; return true; })()`);
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(120);
    const rm1 = await ev(`(function(){
      var p = document.querySelector('.pend-star'); var cs = getComputedStyle(p);
      var anims = (p.getAnimations ? p.getAnimations() : []);
      return { dur: cs.animationDuration, iter: cs.animationIterationCount, play: anims.map(function(a){return a.playState;}),
               label: (document.querySelector('.pend-lab')||{}).textContent, secs: (document.querySelector('.pend-secs')||{}).textContent };
    })()`);
    await sleep(1250);
    const rm2 = await ev(`(function(){ return { secs: (document.querySelector('.pend-secs')||{}).textContent }; })()`);
    out.raw.reducedMotion = { first: rm1, second: rm2 };
    // Chrome 把 0.001ms 序列化成 '1e-06s' —— 判据按**数值**（秒），不钉序列化字面量。
    const durSec = (() => {
      const m = /^([\d.eE+-]+)(ms|s)$/.exec(rm1.dur ?? '');
      if (m === null) return Number.NaN;
      return Number(m[1]) * (m[2] === 'ms' ? 0.001 : 1);
    })();
    const stillRunning = rm1.play.filter((s) => s === 'running').length;
    out.consequences.reducedMotion = verdict(
      durSec <= 0.000002 && stillRunning === 0 && rm1.label !== null && rm1.label !== '' && rm1.secs !== rm2.secs,
      `reduce 下 animation-duration=${rm1.dur}（≈0，全局块关停；仍在跑的动画 ${stillRunning} 个）、` +
        `标签「${rm1.label}」照常、用时 ${rm1.secs} → ${rm2.secs} 仍在走`,
    );
    await page.send('Emulation.setEmulatedMedia', { features: [] });

    // ---- ⑥ 秒数不进可访问性树；阶段标签是 live=polite 的 status ----
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
        live: n.properties?.find((p) => p.name === 'live')?.value?.value ?? null,
        ignored: n.ignored === true,
        reason: n.ignoredReasons?.map((x) => x.name).join(',') ?? null,
      }));
    };
    const labAx = await axOf('.pend-lab');
    const secsAx = await axOf('.pend-secs');
    const axAll = (await page.send('Accessibility.getFullAXTree')).nodes ?? [];
    const nodes = axAll.map((n) => ({
      role: n.role?.value ?? null,
      name: n.name?.value ?? null,
      live: n.properties?.find((p) => p.name === 'live')?.value?.value ?? null,
      ignored: n.ignored === true,
    }));
    out.raw.ax = { label: labAx, seconds: secsAx, liveNodes: nodes.filter((n) => n.live !== null) };
    const secsText = nodes.filter((n) => /用时\s*\d+\s*秒|Elapsed\s*\d+s/.test(n.name ?? '') && n.ignored !== true);
    out.consequences.secondsNotAnnounced = verdict(
      secsAx.every((n) => n.ignored === true) && secsText.length === 0,
      secsAx.length === 0
        ? '秒数节点在可访问性树里**不存在**（aria-hidden 已把它摘掉）'
        : `秒数节点 ignored=${JSON.stringify(secsAx.map((n) => n.ignored))}（reason=${secsAx[0]?.reason}）；` +
          `全树里含秒数文本的可播报节点 ${secsText.length} 个`,
    );
    const labOk = labAx.some((n) => n.role === 'status' && n.live === 'polite' && n.ignored !== true);
    out.consequences.labelIsLiveStatus = verdict(
      labOk && before.labelRole === 'status' && before.labelLive === 'polite',
      `阶段标签在可访问性树里是 ${JSON.stringify(labAx.map((n) => ({ role: n.role, live: n.live, ignored: n.ignored })))}；` +
        `DOM 上 role=${before.labelRole} aria-live=${before.labelLive}`,
    );

    out.consoleErrors = consoleErrors;
    await P.finish({
      heading: 'W9333 真机取证',
      pad: 22,
      printJson: true,
      jsonPath: join(SHOTS, 'probe.json'),
      exitCodeOnFail: 1,
    });
  } finally {
    await browser.close();
    await fixture.close();
  }
};

main().catch((err) => { console.error(err); process.exit(1); });
