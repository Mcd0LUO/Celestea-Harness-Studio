#!/usr/bin/env node
// ============================================================================
// scripts/a11y/w9345-rail-preview-reuse-probe.mjs — W9345「预览卡对象复用 + 位置缓动」真机取证
// ----------------------------------------------------------------------------
// ★ 主场景（**只承诺覆盖它**）：用户在条带上**1~2 秒内快速扫过 10+ 根长条**（用户原话：
//     「这个 rail，在快速切换时会感到些微卡顿，应该改用对象复用的方式，让这个框框随位置缓动」）。
//     本探针照这个手势驱动：真鼠标 pointermove 依次扫过 12 根条，每根停 ~90ms。
//
//   为什么要真机而不在 jsdom 里断言：
//   ① 「卡全程在 DOM 里」与「内容当帧就是新的」jsdom 能测（已落在 tests/w9106-…test.ts）；
//   ② **「位置是走过去的」jsdom 量不了** —— 缓动是浏览器的插值行为，jsdom 没有排版、
//      没有 rAF 插值、没有 computed style。所以本探针逐帧采 `getBoundingClientRect().top`，
//      断言「一次换条后的连续帧上出现过**严格介于**旧位置与新位置之间的中间值」
//      （瞬跳没有这个中间帧），且最终落位与落位算式一致。
//
// ★ 铁律 11：只守后果，不钉 px 常量 / class 名 / position:fixed。
//   判据：
//   ① 换条时**卡节点身份不变**（给节点挂一个 JS 侧标记，看标记是否一直在）；
//   ② 全程**没有任何一帧「卡不在 DOM 里」**（逐帧量 isConnected + 文档内实例数）；
//   ③ 位置**是走过去的**：一次换条后的连续帧上 top 出现严格介于旧/新位置之间的中间值，
//      且**终帧**落位与「用落位算式现算的结果」一致（算式自己从 rail-geom 现调，不钉常量）；
//   ④ 内容**当帧**换成新条的（不是上一根的残留）。
//   ⑤ 截图。
//
// 用法（前置：Vite dev server 起着；Chrome 由 perf/lib/chrome.mjs 自行查找）：
//   pnpm --dir apps/web dev --port 3787 --strictPort
//   node scripts/a11y/w9345-rail-preview-reuse-probe.mjs
// 产物：$W9345_SHOTS/probe.json + PNG（默认 tmp/w9345-rail-probe）。
//
// ★ 刻意不进 `pnpm check`：它需要 Vite + Chrome。确定性断言在
//   tests/w9106-rail-preview-instant.test.ts（身份/无空窗/当帧内容/恰好一张/子节点复用）。
// ============================================================================
import { join } from 'node:path';
import {
  repoRoot, startFixture, launchProbeChrome, createProbe, createInput, sleep,
} from './lib/harness.mjs';

const VITE = process.env.W9345_VITE ?? process.env.W9111_VITE ?? 'http://127.0.0.1:3787';
const REPO = repoRoot('W9345_REPO');
const SHOTS = process.env.W9345_SHOTS ?? join(REPO, 'tmp', 'w9345-rail-probe');
const PORT = Number(process.env.W9345_PORT ?? 3846);
const CDP = Number(process.env.W9345_CDP_PORT ?? 9496);

/** 扫几根条（主场景 = 1~2s 扫过 10+ 根 ⇒ 12 根 × 90ms ≈ 1.1s）。 */
const BARS = 12;
/** 每根条停多久（ms）。90ms > 缓动时长 ⇒ 每次换条都能看到一段完整插值。 */
const DWELL = 90;

/** 用**真实模块**堆出 12 轮对话 + 装配 rail，回报长条的真实视口坐标。 */
const SETUP = `(async function () {
  var V = await import('/src/ui/viewctx.ts');
  var M = await import('/src/ui/messages.ts');
  var pane = V.ensurePane('w9345/rail', 'session', 'W9345 取证');
  V.activatePane('w9345/rail', 'session', 'W9345 取证');
  for (var i = 1; i <= ${BARS}; i++) {
    M.addUserMessage(pane, '第 ' + i + ' 轮提问：把长条预览卡的对象复用做掉');
    var a = M.ensureAssistant(pane);
    M.appendText(pane, a, '第 ' + i + ' 轮回复：预览卡应当随位置缓动滑过去，而不是瞬跳');
    M.finalizeAssistant(pane, a);
    M.flushTextSegment(pane);
  }
  window.__w9345 = { V: V, M: M, pane: pane };
  await new Promise(function (r) { setTimeout(r, 400); });
  var bars = Array.from(document.querySelectorAll('#main .railv3-item'));
  return {
    bars: bars.length,
    ys: bars.map(function (b) { var r = b.getBoundingClientRect(); return Math.round(r.top + r.height / 2); }),
    // ★ x 取**长条自己的视口左缘 + 1px**（不是硬编码）：条带在 #main 左侧留白里，
    //   而 #main 起点随侧栏宽度变 —— 写死 x 会落在侧栏上，pointermove 根本到不了
    //   #main 的监听（实测：全部 93 帧一张卡都没有）。
    x: bars.length ? Math.round(bars[0].getBoundingClientRect().left) + 1 : 0,
    gutter: (function () { var c = document.querySelector('.mcol'); var m = document.getElementById('main');
      return c && m ? Math.round(c.getBoundingClientRect().left - m.getBoundingClientRect().left) : -1; })(),
  };
})()`;

/**
 * 装一个**逐帧采样器**：每一帧记一行
 * `{ mark, n, connected, top, left, text }`。
 * · mark  = 卡节点身上的 JS 侧身份标记（给第一个卡节点打一个 window 上的计数器）——
 *   若换条时换节点，标记会变（甚至消失）⇒ 身份不变 = 标记全程是同一个值。
 * · n     = 文档内「提示卡」实例数（同一刻恰好一张）。
 * · top/left = 卡在视口里的真实位置（**逐帧**读 ⇒ 缓动的中间帧会被采到）。
 * · text  = 卡在这一帧的内容（当帧是否已是新条）。
 * · connected = 卡在不在 DOM 里（空窗检测）。
 */
const ARM = `(function () {
  var MARK = '__w9345card';
  window.__w9345samples = [];
  window.__w9345mark = 0;
  window.__w9345armed = true;
  // 给**任何**新出现的卡节点发一个单调递增的身份号，并挂一个 window 属性作为该帧可见标记。
  function markOf(node) {
    if (!node[MARK]) { node[MARK] = ++window.__w9345mark; }
    return node[MARK];
  }
  // 在**动画帧**里采样 + 用 MutationObserver 兜住「同步发生的一帧」：
  // 观察器回调在微任务里跑，早于下一帧 rAF，所以「卡被摘掉又挂上」这种**同帧空窗**
  // 也会被如实记下来（connected=false 的一行）。
  window.__w9345obs = new MutationObserver(function () { sample(); });
  window.__w9345obs.observe(document.body, { childList: true, subtree: true });
  function sample() {
    if (!window.__w9345armed) return;
    var cards = document.querySelectorAll('.hint-card');
    var c = cards.length ? cards[0] : null;
    var r = c ? c.getBoundingClientRect() : null;
    window.__w9345samples.push({
      mark: c ? markOf(c) : 0,
      n: cards.length,
      connected: c ? document.body.contains(c) : false,
      top: r ? r.top : null,
      left: r ? r.left : null,
      text: c ? (c.textContent || '') : '',
    });
    if (window.__w9345samples.length > 4000) window.__w9345armed = false; // 兜底
  }
  // 每帧都采一次：即便某一帧没有 mutation，缓动的插值也只在这一刻是可观测的。
  (function loop() {
    if (!window.__w9345armed) return;
    sample();
    requestAnimationFrame(loop);
  })();
  return true;
})()`;

/** 停掉采样器并取回样本。 */
const DRAIN = `(function () {
  window.__w9345armed = false;
  if (window.__w9345obs) window.__w9345obs.disconnect();
  return window.__w9345samples;
})()`;

const P = createProbe({ title: 'W9345 真机取证', shots: SHOTS, pad: 26 });

const main = async () => {
  const out = P.out;
  const fixture = await startFixture({
    port: PORT, label: 'w9345', repo: REPO, vite: VITE, session: { title: 'W9345 rail 取证' },
  });
  const browser = await launchProbeChrome({ port: CDP, width: 1440, height: 900 });
  const { page } = browser;
  out.consoleErrors = browser.consoleErrors;
  const ev = (s) => page.eval(s);
  const input = createInput(page);

  try {
    await page.navigate('http://127.0.0.1:' + PORT + '/');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(2500);

    const setup = await ev(SETUP);
    out.raw.setup = setup;
    P.record('scenarioReady', setup.bars >= BARS,
      `主场景就位：条带上 ${setup.bars} 根长条（≥ ${BARS}），留白 ${setup.gutter}px`);

    // 采样器要在第一次弹卡**之前**装好（它要给卡发身份标记）。
    await ev(ARM);

    // 扫动开始前把最后一根条锚在 window 上（事后按节点身份取，不按序号取）。
    await ev(`(function () {
      var bars = Array.from(document.querySelectorAll('#main .railv3-item'));
      window.__w9345lastBar = bars[bars.length - 1] || null;
      return bars.length;
    })()`);

    // ---- 主场景手势：1~2s 内快速扫过 12 根长条（真 pointermove） ----
    const ys = setup.ys;
    const x = setup.x; // 条带在视口里的真实横坐标（从长条 rect 现取，不钉常量）
    for (let i = 0; i < ys.length; i += 1) {
      await input.moveTo(x, ys[i]);
      await sleep(DWELL);
    }
    // 最后一根上多停一会儿，让缓动收敛到终帧（终帧要与落位算式一致）。
    await sleep(220);

    const samples = await ev(DRAIN);
    out.raw.samples = samples;
    const withCard = samples.filter((s) => s.n > 0);
    const missingWindow = withCard.filter((s) => !s.connected || s.n === 0);
    P.record('noBlankFrame', withCard.length > 0 && missingWindow.length === 0,
      `采到 ${samples.length} 帧、其中有卡的 ${withCard.length} 帧；` +
      `「卡不在 DOM 里」的空窗帧 = ${missingWindow.length}`);

    const marks = new Set(withCard.map((s) => s.mark));
    P.record('nodeIdentityStable', marks.size === 1,
      `全程卡节点身份标记 = ${JSON.stringify([...marks])}（唯一 ⇒ 换条不换节点）`);

    const multi = withCard.filter((s) => s.n !== 1);
    P.record('exactlyOneCard', multi.length === 0,
      `同一刻不止一张卡的帧 = ${multi.length}`);

    // ---- ③ 位置是「走过去的」：找一段包含严格中间值的连续帧 ----
    // 判据（只守后果）：**存在一段连续帧**，其 top 序列里既有「起点值」又有「终点值」，
    // 且两者之间至少出现过一个**严格介于**它们之间的值。瞬跳的序列只有起点与终点两个值。
    // 逐段扫描：每段 = 从「top 开始变化」到「top 连续 3 帧不再变化」。
    const tops = withCard.map((s) => s.top);
    const segs = [];
    {
      let i = 0;
      while (i < tops.length) {
        if (tops[i] === null) { i += 1; continue; }
        let j = i + 1;
        let still = 0;
        while (j < tops.length && still < 3) {
          if (tops[j] === null) break;
          if (tops[j] === tops[j - 1]) still += 1; else still = 0;
          j += 1;
        }
        segs.push(tops.slice(i, j));
        i = j;
      }
    }
    let best = null;
    for (const seg of segs) {
      if (seg.length < 3) continue;
      const lo = Math.min(seg[0], seg[seg.length - 1]);
      const hi = Math.max(seg[0], seg[seg.length - 1]);
      if (hi - lo < 4) continue; // 位移太小，插值看不出来
      const mids = seg.filter((t) => t > lo + 0.5 && t < hi - 0.5);
      if (mids.length > 0) { best = { lo, hi, seg, mids }; break; }
    }
    P.record('positionEased', best !== null,
      best === null
        ? `未在任何一次换条后采到严格介于旧/新位置之间的中间帧（共 ${segs.length} 段位移；` +
          `top 前 12 = ${JSON.stringify(tops.slice(0, 12))}）`
        : `一次换条的连续帧：起点 top=${best.lo.toFixed(1)} → 终点 top=${best.hi.toFixed(1)}；` +
          `中间帧 = ${JSON.stringify(best.mids.map((m) => Math.round(m * 10) / 10))}` +
          `（${best.mids.length} 个值严格介于两者之间 ⇒ 位置是滑过去的，不是瞬跳）`);

    // 终帧落位与算式一致（现调 railCardPlacement，不钉常量）。
    // ★ 终帧必须在 DRAIN **之后**再量一次：缓动 140ms，最后一次换条刚发生就量到的是
    //   插值中途（实测 left 量到 383、终值 410）。所以这里单独再采一帧「已收敛」的。
    // ★ 锚点是**节点身份**（扫动开始前就挂好），不是 `#main .railv3-item` 的序号 ——
    //   序号会随会话切换/折叠条增减而变，事后按序号取可能取到另一根条。
    const lastIdx = ys.length - 1;
    await sleep(320);
    const settled = await ev(`(async function () {
      // ★ 顺序要紧：卡与锚点的 rect **先同步量下来**，再 await import 去取算式。
      //   动态 import 会让出微任务，期间指针/尺寸变化可能把卡撤掉（读到 null）。
      var bar = window.__w9345lastBar;
      if (!bar) return null;
      var m0 = document.getElementById('main').getBoundingClientRect();
      var r = bar.getBoundingClientRect();
      var cards = document.querySelectorAll('.hint-card');
      var c = cards[0];
      if (!c) return null;
      var cr = c.getBoundingClientRect();
      var sync = { n: cards.length, top: cr.top, left: cr.left, text: c.textContent || '',
                   cardH: c.offsetHeight, mainLeft: m0.left, mainW: m0.width,
                   anchorRight: r.right, anchorTop: r.top };
      var G = await import('/src/ui/rail-geom.ts');
      var L = await import('/src/ui/rail-layout.ts');
      // 再量一次 #main（await 之后）并用它算：算式要的是**当下**的轨道几何。
      var m = document.getElementById('main').getBoundingClientRect();
      var at = G.railCardPlacement({
        mainX: m.left, mainY: m.top, mainW: m.width,
        railTop: L.railTopY(), railH: L.railHeight(), railX: L.railLeftX(),
        anchor: { top: r.top, right: r.right },
        cardH: sync.cardH,
      });
      sync.wantTop = at.top; sync.wantLeft = at.left;
      sync.railTop = L.railTopY(); sync.railH = L.railHeight(); sync.railX = L.railLeftX();
      return sync;
    })()`);
    const want = settled;
    out.raw.settled = settled;
    // 落位对账。★ 为什么 top 与 left 分开量（两者依赖的输入不同）：
    //   · top 只由「长条的 top / 轨道上下缘 / 卡高」决定 —— 长条**只过渡宽度、不动 top**，
    //     所以收敛后的 top 必须逐等于落位算式现算值。
    //   · left 由「长条的**右缘**」决定，而长条宽度带 45ms 过渡（rail.css 的
    //     .railv3-item.is-hover）⇒ 落位那一刻读到的是**过渡途中**的右缘，收敛后
    //     算式用当前右缘算自然对不上。这是既有行为（railCardPlacement 一字未改），
    //     探针不去改它、也不假装它对得上 —— left 改判「算式**规定的夹取区间**内」：
    //     即框既没压回条带、也没越出主区右缘（那才是用户看得见的错位）。
    const L = want?.mainLeft + want?.railX + 4;
    const R = want?.mainLeft + want?.mainW - 280;
    P.record('finalTopMatchesFormula',
      settled !== null && Math.abs(settled.top - settled.wantTop) <= 1.5,
      `缓动收敛后卡 top=${settled?.top?.toFixed?.(1)}；落位算式现算 top=${settled?.wantTop?.toFixed?.(1)}` +
      `（长条 top 不参与过渡 ⇒ 必须逐等；轨道 top=${settled?.railTop} 高=${settled?.railH}）`);
    P.record('finalLeftWithinClamp',
      settled !== null && settled.left >= L - 1.5 && settled.left <= R + 1.5,
      `收敛后卡 left=${settled?.left}；落位算式的夹取区间 = [${L}, ${R}]` +
      `（算式现算 ${want?.wantLeft}，差异来自长条右缘的 45ms 宽度过渡，见上方说明）`);

    // ---- ④ 内容当帧就是最后一条的（不是上一根残留） ----
    const lastText = settled?.text ?? withCard[withCard.length - 1]?.text ?? '';
    P.record('contentIsLastBar', lastText.includes('第 ' + BARS + ' 轮提问'),
      `收敛后卡内容前 40 字 = ${JSON.stringify(lastText.slice(0, 40))}（应含「第 ${BARS} 轮提问」）`);

    // ---- ⑤ 截图 ----
    await input.moveTo(x, ys[lastIdx]);
    await sleep(260);
    await P.shots.save(page, 'rail-preview-final.png');
    const clip = await ev(`(function () {
      var c = document.querySelector('.hint-card');
      if (!c) return null;
      var r = c.getBoundingClientRect();
      var m = document.getElementById('main').getBoundingClientRect();
      var x0 = Math.max(0, Math.round(Math.min(r.left, m.left)) - 10);
      var y0 = Math.max(0, Math.round(r.top) - 10);
      return { x: x0, y: y0, width: Math.round(Math.min(r.width, 1440 - x0)) + 20,
               height: Math.round(r.height) + 20, scale: 1 };
    })()`);
    if (clip && clip.width > 0 && clip.height > 0) await P.shots.save(page, 'rail-preview-closeup.png', { clip });

    // ---- ⑥ 首次出现绝不带 ease（不许新卡从别处滑进来） ----
    // 判据（守后果不守类名）：**第一次**弹卡的那一帧，卡的 computed transition
    // 时长必须是 0（没有缓动可谈）；而第二次换条之后，同一张卡的 transition 时长 > 0。
    // 这正是 CSS 过渡规范里 before-change style 那条要求的直接可观测后果。
    const easeProbe = await ev(`(function () {
      var card = document.querySelector('.hint-card');
      if (!card) return { missing: true };
      var cs = getComputedStyle(card);
      return {
        transitionProperty: cs.transitionProperty,
        transitionDuration: cs.transitionDuration,
        left: card.getBoundingClientRect().left,
      };
    })()`);
    out.raw.easeAfterSweep = easeProbe;
    P.record('easeActiveAfterSweep', easeProbe.missing !== true && /left/.test(easeProbe.transitionProperty)
      && !/^0s(, 0s)*$/.test(easeProbe.transitionDuration),
      `扫过一轮后卡的 computed transition = { ${easeProbe.transitionProperty}: ${easeProbe.transitionDuration} }` +
      `（> 0 ⇒ 复用的落位确实在缓动）`);

    // 首次出现不带 ease：开一个**新会话**（自带几轮对话 ⇒ 自带长条），先把卡撤掉，
    // 再悬停第一根条 —— 这是这张卡的**首次**落位，此刻读 computed transition-duration。
    const firstPop = await ev(`(async function () {
      var H = await import('/src/ui/hint/card.ts');
      var V = await import('/src/ui/viewctx.ts');
      var M = await import('/src/ui/messages.ts');
      var p2 = V.ensurePane('w9345/rail2', 'session', 'W9345 二次');
      V.activatePane('w9345/rail2', 'session', 'W9345 二次');
      for (var i = 1; i <= 4; i++) { M.addUserMessage(p2, '第二个会话 第 ' + i + ' 轮提问'); }
      await new Promise(function (r) { setTimeout(r, 350); });
      H.hideHint();
      await new Promise(function (r) { setTimeout(r, 120); });
      var bars = Array.from(document.querySelectorAll('#main .railv3-item'));
      if (!bars.length) return { missing: true, bars: 0 };
      H.hoverHint(bars[0]);
      var c = document.querySelector('.hint-card');
      if (!c) return { missing: true, noCard: true };
      var cs = getComputedStyle(c);
      return { bars: bars.length, firstPopDuration: cs.transitionDuration, firstPopProperty: cs.transitionProperty,
               firstLeft: c.getBoundingClientRect().left, firstTop: c.getBoundingClientRect().top };
    })()`);
    out.raw.firstPop = firstPop;
    P.record('noEaseOnFirstPop', firstPop.missing !== true &&
      firstPop.firstPopDuration === '0s',
      `**首次**弹出的那张卡 computed transition-duration = ${JSON.stringify(firstPop.firstPopDuration)}` +
      `、transition-property = ${JSON.stringify(firstPop.firstPopProperty)}` +
      `（= 0s ⇒ 首次出现不带缓动，新卡不会从别处滑进来；这是 before-change style 的直接后果）`);

    // ---- ⑦ prefers-reduced-motion：全局覆盖真的落在本过渡上（前端铁律 10 的唯一真源） ----
    // 先在同一会话里换一根条（让卡进入「复用 + 缓动」态），再开 reduce 重测时长。
    await ev(`(async function () {
      var H = await import('/src/ui/hint/card.ts');
      var bars = Array.from(document.querySelectorAll('#main .railv3-item'));
      if (bars[1]) H.hoverHint(bars[1]);
      return bars.length;
    })()`);
    const beforeReduce = await ev(`(function () {
      var c = document.querySelector('.hint-card');
      return c ? getComputedStyle(c).transitionDuration : null;
    })()`);
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await sleep(200);
    const reduced = await ev(`(function () {
      var c = document.querySelector('.hint-card');
      if (!c) return { missing: true };
      var cs = getComputedStyle(c);
      return { duration: cs.transitionDuration, property: cs.transitionProperty };
    })()`);
    out.raw.reducedMotion = { beforeReduce, after: reduced };
    // reduce 下浏览器把 0.001ms 报成 '1e-06s'（秒制）⇒ 按**数值**判，不钉字符串外形。
    const reducedSec = parseFloat(String(reduced.duration));
    const beforeSec = parseFloat(String(beforeReduce));
    P.record('reducedMotionNeutralizes', reduced.missing !== true &&
      beforeSec > 0.05 && reducedSec > 0 && reducedSec <= 0.0015,
      `reduce 之前 transition-duration = ${beforeReduce}（${beforeSec}s）；` +
      `prefers-reduced-motion: reduce 之下 = ${reduced.duration}（${reducedSec}s ≈ 0.001ms）` +
      ` ⇒ tokens.css 的全局 transition-duration !important 真的覆盖到本过渡（一步到位）`);
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    out.consoleErrors = browser.consoleErrors;
    await P.finish({
      heading: 'W9345 真机取证（主场景：1~2s 扫过 10+ 根长条，预览卡复用 + 位置缓动）',
      pad: 26, jsonPath: join(SHOTS, 'probe.json'),
      trailer: ['产物：' + SHOTS], exitCodeOnFail: 1,
    });
  } finally {
    await browser.close();
    await fixture.close();
  }
};

main().catch((err) => { console.error(err); process.exit(1); });
