#!/usr/bin/env node
// ============================================================================
// scripts/a11y/w9346-trend-color-probe.mjs — W9346「趋势线太浅 / 图例色块看不见」真机取证
// ----------------------------------------------------------------------------
// ★ 主场景（**只承诺覆盖它**）：**深色主题**下的「每日 Token 趋势」、**两条序列** ——
//     ① 折线对背景的对比度达标（线看得见）；② 两条序列**彼此可分**（不撞色）；
//     ③ 图例色块**不是背景色**（看得见）；④ 图例与折线**同源**（同一色）。
//
// ★ 铁律 11：断言**不钉任何具体色值**。只量「对比度 / 差色 / 非背景」三个**后果**。
//   换主题、换色卡、调色都不该让这三条红 —— 它们红只意味着「线看不见了」。
//
// ★ 为什么必须真机：对比度是**合成后的像素**与真实底色的关系；jsdom 没有排版，
//   拿不到 computed style，也读不到 SVG 的实际 stroke。
//
// 用法（前置：Vite dev server 起着）：
//   pnpm --dir apps/web dev --port 3787 --strictPort
//   node scripts/a11y/w9346-trend-color-probe.mjs
// 产物：$W9346_SHOTS/probe.json + PNG（默认 tmp/w9346-probe）。
//
// ★ 刻意不进 `pnpm check`（与 w9336 / w9344 / w9345 同一取向）：需要 Vite + Chrome。
// ============================================================================
import { join } from 'node:path';
import {
  repoRoot, startFixture, launchProbeChrome, createProbe, sleep,
} from './lib/harness.mjs';

const VITE = process.env.W9346_VITE ?? process.env.W9111_VITE ?? 'http://127.0.0.1:3787';
const REPO = repoRoot('W9346_REPO');
const SHOTS = process.env.W9346_SHOTS ?? join(REPO, 'tmp', 'w9346-probe');
const PORT = Number(process.env.W9346_PORT ?? 3846);
const CDP = Number(process.env.W9346_CDP_PORT ?? 9496);

/** 主场景夹具：**两条序列** × 若干天（日期近几天，模型名用真机截图里的那两个）。 */
const POINTS = [
  { date: '2026-10-01', modelId: 'MiniMax-M3.1-Flash-Preview', totalTokens: 12000 },
  { date: '2026-10-02', modelId: 'MiniMax-M3.1-Flash-Preview', totalTokens: 26000 },
  { date: '2026-10-03', modelId: 'MiniMax-M3.1-Flash-Preview', totalTokens: 31000 },
  { date: '2026-10-04', modelId: 'MiniMax-M3.1-Flash-Preview', totalTokens: 22000 },
  { date: '2026-10-01', modelId: 'DeepSeek-V3.2', totalTokens: 30000 },
  { date: '2026-10-02', modelId: 'DeepSeek-V3.2', totalTokens: 15000 },
  { date: '2026-10-03', modelId: 'DeepSeek-V3.2', totalTokens: 9000 },
  { date: '2026-10-04', modelId: 'DeepSeek-V3.2', totalTokens: 28000 },
];

const SETUP = `(async function () {
  var T = await import('/src/ui/usage/trend.ts');
  var host = document.createElement('div');
  host.className = 'usage-card';
  host.id = 'trendHost';
  document.querySelector('#app').appendChild(host);
  var drew = T.mountTrend(host, ${JSON.stringify(POINTS)});
  window.__w9346 = { T: T, host: host };
  await new Promise(function (r) { setTimeout(r, 200); });
  return { drew: drew, series: host.querySelectorAll('.usage-trend-line').length,
           swatches: host.querySelectorAll('.usage-legend-swatch').length };
})()`;

/**
 * 量：两条折线的**解析后** stroke、图例色块的解析 background、卡片底色。
 * 全部走 `getComputedStyle` / 真实 SVG 几何 ⇒ 拿到的是**合成后**的颜色与像素位置。
 */
const MEASURE = `(function () {
  var host = document.getElementById('trendHost');
  if (!host) return { missing: true };
  var svg = host.querySelector('.usage-trend-svg');
  var lines = Array.from(host.querySelectorAll('.usage-trend-line'));
  var swatches = Array.from(host.querySelectorAll('.usage-legend-swatch'));
  var dots = Array.from(host.querySelectorAll('.usage-trend-dot'));
  if (!svg || lines.length === 0) return { missing: true, lines: lines.length };

  // 卡片真实底色：沿祖先找第一个非透明背景（与 w9336 的 bgOf 同一手法）。
  var bgOf = function (el) {
    for (var n = el; n; n = n.parentElement) {
      var c = getComputedStyle(n).backgroundColor;
      if (c && c !== 'transparent' && !/rgba\\(0, 0, 0, 0\\)/.test(c)) return c;
    }
    return getComputedStyle(document.body).backgroundColor || 'rgb(255,255,255)';
  };
  // 折线是否真的画出了有面积的像素（长宽 > 0）—— 看不见的线可能"存在但为零高"。
  var rectOf = function (el) { var r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y) }; };

  return {
    missing: false,
    theme: document.documentElement.dataset.theme || '(unset)',
    cardBg: bgOf(host),
    svgW: Math.round(svg.getBoundingClientRect().width),
    lines: lines.map(function (l) { return {
      stroke: getComputedStyle(l).stroke, rect: rectOf(l) }; }),
    dots: dots.slice(0, 4).map(function (d) { return {
      fill: getComputedStyle(d).fill, rect: rectOf(d) }; }),
    swatches: swatches.map(function (s) { return {
      bg: getComputedStyle(s).backgroundColor, series: s.getAttribute('data-series'),
      rect: rectOf(s) }; }),
    // 每条折线在**竖直方向**的跨度（都压成一条水平线 = 看不出是趋势）
    lineSpread: lines.map(function (l) {
      var ys = l.getAttribute('points').split(' ').map(function (p) { return Number(p.split(',')[1]); });
      return Math.round(Math.max.apply(null, ys) - Math.min.apply(null, ys));
    }),
  };
})()`;

const P = createProbe({ title: 'W9346 真机取证', shots: SHOTS, pad: 24 });

// ---- 与 w9336 同一套 WCAG 算式（相对亮度 / 对比度） ----
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
const round = (n) => Math.round(n * 100) / 100;
/** 两条色的「差色程度」：ΔE76（CIE76）在 sRGB 下的常用近似。>20 视为可辨。 */
function deltaE(a, b) {
  const pa = parseColor(over(a, '#ffffff')); const pb = parseColor(over(b, '#ffffff'));
  return Math.sqrt((pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2 + (pa[2] - pb[2]) ** 2);
}

const main = async () => {
  const out = P.out;
  const fixture = await startFixture({
    port: PORT, label: 'w9346', repo: REPO, vite: VITE, session: { title: 'W9346 取证' },
  });
  const browser = await launchProbeChrome({ port: CDP, width: 1440, height: 900 });
  const { page } = browser;
  const consoleErrors = browser.consoleErrors;
  out.consoleErrors = consoleErrors;
  const ev = (s) => page.eval(s);

  try {
    await page.navigate('http://127.0.0.1:' + PORT + '/');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(2200);

    // ★ 主场景：**深色主题**。先切主题再挂载（挂载只写 var(--usage-series-N)，
    //   所以色值随主题即时生效 —— 这正是「色值只活在 CSS 里」的可测后果）。
    await ev(`(function () { document.documentElement.dataset.theme = 'dark'; return true; })()`);
    await sleep(150);
    const setup = await ev(SETUP);
    out.raw.setup = setup;
    P.record('scenarioReady', setup.drew === true && setup.series === 2 && setup.swatches === 2,
      `深色主题下趋势图就位：画出来了=${setup.drew}，折线 ${setup.series} 条、图例色块 ${setup.swatches} 个（主场景 = 两条序列）`);

    const m = await ev(MEASURE);
    out.raw.dark = m;
    const lineContrasts = m.lines.map((l) => round(contrast(l.stroke, m.cardBg)));
    const swatchContrasts = m.swatches.map((s) => round(contrast(s.bg, m.cardBg)));

    // ---- ① 折线对背景的对比度达标（WCAG 1.4.11 非文本 ≥ 3:1）----
    P.record('lineVisible', m.missing === false && lineContrasts.every((c) => c >= 3),
      `深色底 ${m.cardBg}；两条折线合成色 ${JSON.stringify(m.lines.map((l) => l.stroke))}，` +
      `对底对比度 ${JSON.stringify(lineContrasts)}（要求 ≥ 3:1）`);

    // ---- ② 两条序列彼此可分（不撞色）----
    const de = m.lines.length >= 2 ? round(deltaE(m.lines[0].stroke, m.lines[1].stroke)) : 0;
    out.raw.darkDeltaE = de;
    P.record('seriesDistinct', m.lines.length >= 2 && de >= 20,
      `两条折线色差 ΔE76 = ${de}（≥ 20 视为可辨；同色/撞色会 = 0）`);

    // ---- ③ 图例色块非背景色（截图里第一条几乎看不见）----
    P.record('swatchVisible', m.missing === false && swatchContrasts.every((c) => c >= 3) &&
      m.swatches.every((s) => s.rect.w >= 6 && s.rect.h >= 6),
      `两个图例色块 ${JSON.stringify(m.swatches.map((s) => s.bg))}，对底对比度 ${JSON.stringify(swatchContrasts)}；` +
      `尺寸 ${JSON.stringify(m.swatches.map((s) => s.rect.w + '×' + s.rect.h))}px`);

    // ---- ④ 图例与折线同源（同一个色 ⇒ 一处改两处一起改）----
    P.record('legendMatchesLine', m.lines.length >= 2 && m.swatches.length >= 2 &&
      m.lines[0].stroke === m.swatches[0].bg && m.lines[1].stroke === m.swatches[1].bg,
      `折线色 ${JSON.stringify(m.lines.map((l) => l.stroke))} vs 图例色块 ${JSON.stringify(m.swatches.map((s) => s.bg))}（逐条相等 = 同源）`);

    // ---- ⑤ 线不是被压成一条水平线（有 trend 形状）----
    P.record('linesHaveShape', m.missing === false && m.lineSpread.every((d) => d > 20),
      `两条折线竖直跨度 ${JSON.stringify(m.lineSpread)} viewBox 单位（=0 就是一条平线，看不出趋势）`);

    // ---- ⑥ 浅色主题顺带看一眼（多主题都成立：同一个 var，换主题就换色）----
    await ev(`(function () { document.documentElement.dataset.theme = 'mono'; return true; })()`);
    await sleep(150);
    const light = await ev(MEASURE);
    const lightLineC = light.lines.map((l) => round(contrast(l.stroke, light.cardBg)));
    out.raw.light = light;
    P.record('lightThemeOk', light.missing === false && lightLineC.every((c) => c >= 3),
      `浅色底 ${light.cardBg}；折线 ${JSON.stringify(light.lines.map((l) => l.stroke))}，` +
      `对底对比度 ${JSON.stringify(lightLineC)}（≥ 3:1）—— 同一个 var，换主题即换色`);

    // ---- 视觉证据 ----
    for (const theme of ['dark', 'mono']) {
      await ev(`(function () { document.documentElement.dataset.theme = ${JSON.stringify(theme)}; return true; })()`);
      await sleep(150);
      await P.shots.save(page, 'trend-' + theme + '.png');
    }
    const clip = await ev(`(function () {
      var h = document.getElementById('trendHost').getBoundingClientRect();
      return { x: Math.max(0, Math.round(h.x) - 8), y: Math.max(0, Math.round(h.y) - 8),
               width: Math.round(h.width) + 16, height: Math.min(340, Math.round(h.height) + 16), scale: 1 };
    })()`);
    await ev(`(function () { document.documentElement.dataset.theme = 'dark'; return true; })()`);
    await sleep(150);
    if (clip.width > 0 && clip.height > 0) await P.shots.save(page, 'trend-dark-closeup.png', { clip });

    out.consoleErrors = consoleErrors;
    await P.finish({
      heading: 'W9346 真机取证（主场景：深色主题 · 两条序列）',
      pad: 24, jsonPath: join(SHOTS, 'probe.json'),
      trailer: ['产物：' + SHOTS], exitCodeOnFail: 1,
    });
  } finally {
    await browser.close();
    await fixture.close();
  }
};

main().catch((err) => { console.error(err); process.exit(1); });
