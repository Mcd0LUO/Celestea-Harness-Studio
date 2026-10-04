// ============================================================================
// ui/usage/trend.ts — 每日 Token 趋势（**手写 SVG**，无图表库）。
// ----------------------------------------------------------------------------
//   照参考实现的视觉语义：
//     · 按模型分序列（最多 6 条）+ 图例（色块 + 模型名）；
//     · Y 轴范围跟随**可见序列的单点峰值**（不是每日总量：独立折线而非堆叠图，
//       用总量当上限会把实际可见曲线压在底部 —— 参考实现注释里踩过的坑）；
//     · X 轴刻度按天数抽稀（≤14 天全画，>45 天每 7 个，否则每 5 个，首尾恒画）。
//
//   为什么手写而不是引库：本仓前端零图表依赖（见 FRONTEND-RULES 与
//   apps/web/package.json 的 dependencies —— 本轮一字未动）。SVG 先例：
//   statusline/ring.ts（环形进度）、ui/sessiontree/icons.ts（图标路径）。
//
//   坐标一律用 viewBox 单位（0..W / 0..H），由 CSS 拉伸到容器宽 —— 于是不需要
//   在 resize 时重算，也不依赖任何布局测量（无 ResizeObserver、无 getBBox）。
// ============================================================================
import { getLocale, t } from '../../i18n';
import { formatDay, formatTokens } from './format';
import { buildChart, shouldShowAxisLabel, type ChartData } from './stats';
import type { DayModelPoint } from './model';

const NS = 'http://www.w3.org/2000/svg';
/** viewBox 尺寸（不是像素；CSS 负责缩放）。 */
const W = 720;
const H = 220;
/** 绘图区内边距：左右留出首尾日期文本的半宽，否则 SVG 会把它们裁掉。 */
const PAD = { top: 10, right: 24, bottom: 26, left: 24 };
/**
 * W9346：第 i 条序列的颜色 = **CSS 变量引用**，不再是写死的色值。
 *
 * 为什么不再写死：旧实现是一组灰阶（`'#1a1a1a'` 起），注释写「黑白主题下用不同灰阶」。
 * 灰阶在**深色主题**上就等于背景（深底 #131313 vs 第一条 #1a1a1a ≈ 1.05:1）
 * ⇒ 折线与图例色块一起看不见（用户报障：趋势线太浅、图例第一条色块几乎不可见）。
 * 写死值也不可能让多套主题各自可读。
 *
 * 落地：色值**只在** `styles/usage.css` 的 `--usage-series-1..6` 定义一次
 * （:root 浅色基准 + 每个主题各自覆盖），本文件只写 `var(--usage-series-N)`
 * ⇒ 图例色块与折线读**同一个** var，一处改两处一起改（要求 2）。
 * 唯一真源是 CSS，主题切换即时生效、无需重渲。
 */
const SERIES_VAR_PREFIX = 'var(--usage-series-';

/** 第 i 条序列（1-based）的颜色引用；越界回落到第 1 条（与旧实现的取模回退同语义）。 */
function seriesColor(i: number): string {
  return SERIES_VAR_PREFIX + String((i % 6) + 1) + ')';
}

function svg(tag: string): SVGElement {
  return document.createElementNS(NS, tag);
}

/** 第 `i` 个点的 x（单点时居中；多点按 (n-1) 等分，首点贴左、末点贴右）。 */
function xAt(i: number, n: number, innerW: number): number {
  return n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW;
}

/** 值 → y（`max<=0` 时贴底；越大越靠上）。折线与数据点共用，保证两者对齐。 */
function yAt(value: number, max: number, innerH: number): number {
  return max <= 0 ? innerH : innerH - (value / max) * innerH;
}

/** 折线 `points` 属性：一串 `x,y`。 */
function linePoints(values: number[], max: number, innerW: number, innerH: number): string {
  const n = values.length;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(String(round(xAt(i, n, innerW))) + ',' + String(round(yAt(values[i] ?? 0, max, innerH))));
  }
  return out.join(' ');
}

/** 保留 2 位小数：viewBox 单位下足够，且让产物字节可预测。 */
function round(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 空数据 / 全零：显示空态而不是画一条贴底的假线。 */
function emptyState(): HTMLElement {
  const box = document.createElement('div');
  box.className = 'usage-empty';
  const title = document.createElement('div');
  title.className = 'usage-empty-title';
  title.textContent = t('usage.empty.title');
  const desc = document.createElement('div');
  desc.className = 'usage-empty-desc';
  desc.textContent = t('usage.empty.desc');
  box.appendChild(title);
  box.appendChild(desc);
  return box;
}

/** 图例：色块 + 模型名（未上报模型名的走「未知模型」文案）。 */
function legend(data: ChartData): HTMLElement {
  const row = document.createElement('div');
  row.className = 'usage-legend';
  row.setAttribute('role', 'list');
  const locale = getLocale();
  data.series.forEach((s, i) => {
    const item = document.createElement('div');
    item.className = 'usage-legend-item';
    item.setAttribute('role', 'listitem');
    const swatch = document.createElement('span');
    swatch.className = 'usage-legend-swatch';
    // W9346：色块与折线**同源** —— 这里只挂下标，色值由 usage.css 的
    // `.usage-legend-swatch[data-series="N"]` → `var(--usage-series-N)` 给。
    // （不再 inline 写 background：inline 会盖过主题变量，切主题不改色。）
    swatch.setAttribute('data-series', String((i % 6) + 1));
    const label = document.createElement('span');
    label.className = 'usage-legend-label';
    const name = s.modelId === UNKNOWN ? t('usage.trend.unknownModel') : s.modelId;
    label.textContent = name;
    label.title = formatTokens(locale, s.values.reduce((a, b) => a + b, 0));
    item.appendChild(swatch);
    item.appendChild(label);
    row.appendChild(item);
  });
  return row;
}

/** 账本给「模型没上报」的占位标签（与 ui/usage/model.ts 的 UNKNOWN_MODEL 同值）。 */
const UNKNOWN = '(unknown model)';

/**
 * 挂载/更新趋势图。**单次 replaceChildren**（铁律 1：离屏构建后一次性替换）。
 * 返回是否画出了图（false = 空态），便于测试断言。
 */
export function mountTrend(host: HTMLElement, points: DayModelPoint[]): boolean {
  const data = buildChart(points);
  if (data.maxTokens <= 0 || data.series.length === 0) {
    const off = document.createElement('div');
    off.appendChild(emptyState());
    host.replaceChildren(...off.childNodes);
    return false;
  }

  const off = document.createElement('div');
  const head = document.createElement('div');
  head.className = 'usage-trend-head';
  const title = document.createElement('h5');
  title.className = 'usage-sec-title';
  title.textContent = t('usage.trend.title');
  head.appendChild(title);
  off.appendChild(head);
  off.appendChild(legend(data));

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const root = svg('svg');
  root.setAttribute('class', 'usage-trend-svg');
  root.setAttribute('viewBox', '0 0 ' + String(W) + ' ' + String(H));
  root.setAttribute('preserveAspectRatio', 'none');
  root.setAttribute('role', 'img');
  root.setAttribute('aria-label', t('usage.trend.title'));

  const g = svg('g');
  g.setAttribute('transform', 'translate(' + String(PAD.left) + ',' + String(PAD.top) + ')');

  // 横向网格线（3 条：顶/中/底）—— 竖向网格线在长区间会糊成一片，不画。
  for (let i = 0; i <= 2; i++) {
    const y = (innerH / 2) * i;
    const grid = svg('line');
    grid.setAttribute('x1', '0');
    grid.setAttribute('x2', String(innerW));
    grid.setAttribute('y1', String(round(y)));
    grid.setAttribute('y2', String(round(y)));
    grid.setAttribute('class', 'usage-trend-grid');
    g.appendChild(grid);
  }

  // 折线：`maxTokens` 来自**可见序列的单点峰值**（见 stats.buildChart）。
  // 同时画**数据点**：只有一天有用量时，一条 polyline 只有一个点 —— 画不出任何
  // 线段（真机实测：图例在、曲线看不见，读起来像图坏了）。点让稀疏数据可见。
  data.series.forEach((s, i) => {
    const color = seriesColor(i);
    const line = svg('polyline');
    line.setAttribute('points', linePoints(s.values, data.maxTokens, innerW, innerH));
    // W9346：几何/线宽搬进 CSS（.usage-trend-line），颜色写 `var(--usage-series-N)`
    // ⇒ 深浅主题各自取自己的色值，JS 不再知道任何色值。
    line.setAttribute('stroke', color);
    line.setAttribute('class', 'usage-trend-line');
    g.appendChild(line);
    s.values.forEach((value, idx) => {
      if (value <= 0) return; // 没有用量的日子不画点（0 不是观测值，是补位）
      const dot = svg('circle');
      dot.setAttribute('cx', String(round(xAt(idx, s.values.length, innerW))));
      dot.setAttribute('cy', String(round(yAt(value, data.maxTokens, innerH))));
      dot.setAttribute('r', '2.2');
      dot.setAttribute('fill', color);
      dot.setAttribute('class', 'usage-trend-dot');
      g.appendChild(dot);
    });
  });

  // X 轴日期：抽稀后画在绘图区下方（用 SVG <text>，随 viewBox 缩放）。
  const locale = getLocale();
  data.dates.forEach((date, i) => {
    if (!shouldShowAxisLabel(i, data.dates.length)) return;
    const x = data.dates.length === 1 ? innerW / 2 : (i / (data.dates.length - 1)) * innerW;
    const text = svg('text');
    text.setAttribute('x', String(round(x)));
    text.setAttribute('y', String(innerH + 16));
    text.setAttribute('class', 'usage-trend-tick');
    // 首尾贴边时让文字向内对齐，避免被 viewBox 裁掉半个字。
    if (i === 0 && data.dates.length > 1) text.setAttribute('text-anchor', 'start');
    else if (i === data.dates.length - 1 && data.dates.length > 1) {
      text.setAttribute('text-anchor', 'end');
    } else text.setAttribute('text-anchor', 'middle');
    text.textContent = formatDay(locale, date);
    g.appendChild(text);
  });

  root.appendChild(g);
  off.appendChild(root);
  host.replaceChildren(...off.childNodes);
  return true;
}
