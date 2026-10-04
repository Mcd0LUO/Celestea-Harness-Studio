// ============================================================================
// ui/icons.ts — **全仓 UI 图标的唯一真源**（W9324）。
//
// 起因：散在 9 个文件里的内联 SVG（ui/sessiontree、utils/model-icon、statusline/mode、
// ui/fsbrowser、ui/plugins、ui/inputbar、ui/messages、ui/toolcards、ui/usage/trend）各自
// 手写一遍 `<svg …><path d=…></svg>`，同一个 folder / chevron 抄了三份，改线宽要改三处。
// 这里把几何收成**一张表**（ICONS），两个出口（iconSvg / iconNode）从同一份 paths 派生。
//
// 纪律：
//   · **不引图标库**（本仓零 UI 依赖是硬约束）。本文件不含任何 import —— 它是叶子模块，
//     任何人都能 import 它而不会被拖进依赖网。
//   · **不改任何图标的视觉**：网格、描边宽度、渲染尺寸、颜色语义（currentColor）全部
//     按迁移前逐字保留。合并只改变「几何写在哪个文件」，不改变「几何长什么样」。
//   · 两个出口共用同一份 `paths`：`iconSvg` 与 `iconNode` 不可能漂移（有测试钉住）。
//
// 网格口径（W9324 实测，解释了为什么下面混着 16 网格与 12 网格）：
//   · 本仓 16 网格 / 描边 1.3 渲染 13px → 有效描边 1.056px
//   · Lucide 24 网格 / 描边 2   渲染 13px → 有效描边 1.083px
//   比值 1.0256，差 2.6%，肉眼不可分 ⇒ 两套网格可直接混用，不必把任何 path 重画到统一网格。
//   `grid` 字段只是**记账**（哪条几何出自哪套网格），不参与渲染。
// ============================================================================

/**
 * 许可与来源
 * -----------
 * 本文件的路径分两拨来源，**两者都不需要 npm 依赖**：
 *
 * 1) **本仓既有几何**（`source: 'repo/*'`）：从 apps/web/src 各文件逐字搬过来的内联
 *    SVG 路径。W748（ui/sessiontree/icons.ts）、W765（ui/messages.ts 的 chevron）、
 *    W778（ui/toolcards.ts 的 chevron + utils/model-icons.generated.ts 的品牌图标）、
 *    W847（ui/inputbar.ts 的回形针）、W1513（statusline/mode.ts 的两枚徽标）都是本仓
 *    自己的设计，版权属本仓。
 *
 * 2) **Lucide**（`source: 'lucide/<name>'`）：个别几何取自 Lucide 图标集**作为路径来源
 *    逐条抄录**。Lucide 是 ISC 许可，其版权与许可声明照录如下；抄录不引入任何运行时或
 *    构建期依赖（package.json 未新增任何条目）。
 *
 *    ---------------------------------------------------------------
 *    Lucide — https://lucide.dev
 *    Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of
 *    Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors
 *    2022.
 *
 *    Permission to use, copy, modify, and/or distribute this software for any purpose
 *    with or without fee is hereby granted, provided that the above copyright notice
 *    and this permission notice appear in all copies.
 *
 *    THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 *    REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 *    AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 *    INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
 *    OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
 *    TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
 *    THIS SOFTWARE.
 *    ---------------------------------------------------------------
 *
 *    本次实际抄录：仅 `attach-clip`（回形针）一条 —— 它本就是 Lucide `paperclip` 的
 *    路径，由 W847 内联进 ui/inputbar.ts；本次只是把它登记进表里，**路径逐字未改**。
 *    其余全部是 ①类本仓几何。
 */

/** 一条图标的完整几何描述（渲染所需的全部信息，没有第二份真源）。 */
export interface IconSpec {
  /** viewBox，保留各图标原网格（16/24/12），不改几何。 */
  viewBox: string;
  /** `<path>` 的 d 串（按序，共享同一份）。 */
  paths: string[];
  /** 描边宽度（filled 图标忽略此字段）。 */
  strokeWidth: number;
  /**
   * 实心图标：不写 `fill="none"`，描边/填充由 CSS 决定。
   * 迁移前 grantShield 与模型品牌图标就是这个形态（见 styles/grants.css 419 行）。
   */
  filled?: boolean;
  /** 记账字段：几何出处（`repo/*` 或 `lucide/<name>`），不参与渲染。 */
  source?: string;
  /** 记账字段：几何出自哪套网格（16 / 24 / 12），不参与渲染。 */
  grid?: 16 | 24 | 12;
}

/** 全部图标名。收自迁移前散落的 9 个文件。 */
export type IconName =
  // sessiontree / fsbrowser（16 网格 · 13px · 描边 1.3）
  | 'folder'
  | 'file'
  | 'search'
  | 'sort'
  | 'folder-plus'
  | 'plus'
  // 侧栏授权盾（16 网格 · 10px · 实心，颜色由 .sess-leaf-grant 的 CSS 决定）
  | 'grant-shield'
  // messages / toolcards 折叠 chevron（16 网格 · 14px · 描边 1.6）
  | 'chevron-fold'
  // plugins 展开 chevron（12 网格 · CSS 定尺寸 · 描边 1.6）
  | 'chevron-expand'
  // inputbar 回形针（24 网格 · 16px · 描边 1.8）
  | 'attach-clip'
  // statusline 工作方式徽标（16 网格 · 13px · 描边 1.5）
  | 'mode-standard'
  | 'mode-execution';

/**
 * 图标几何唯一真源。
 *
 * `paths` 是**唯一**的一份：iconSvg 与 iconNode 都从这里读，谁都不许另抄一份 d 串。
 * 数值（尺寸/线宽/网格）逐字对齐迁移前的原处，未做任何「归一化」。
 */
export const ICONS: Record<IconName, IconSpec> = {
  folder: {
    viewBox: '0 0 16 16',
    paths: ['M1.5 3.5h4l1.5 2h7.5v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z'],
    strokeWidth: 1.3,
    source: 'repo/sessiontree+fsbrowser',
    grid: 16,
  },
  file: {
    viewBox: '0 0 16 16',
    paths: ['M3 1.5h6l4 4v9h-10zM9 1.5v4h4'],
    strokeWidth: 1.3,
    source: 'repo/sessiontree',
    grid: 16,
  },
  search: {
    viewBox: '0 0 16 16',
    paths: ['M6.5 11.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zM14.5 14.5l-3.8-3.8'],
    strokeWidth: 1.3,
    source: 'repo/sessiontree',
    grid: 16,
  },
  sort: {
    viewBox: '0 0 16 16',
    paths: ['M2 4h12M5 8h7M8 12h4'],
    strokeWidth: 1.3,
    source: 'repo/sessiontree',
    grid: 16,
  },
  'folder-plus': {
    viewBox: '0 0 16 16',
    paths: ['M1.5 3.5h4l1.5 2h7.5v4M1.5 3.5v8a1 1 0 0 0 1 1h5.5M11 9v5M8.5 11.5h5'],
    strokeWidth: 1.3,
    source: 'repo/sessiontree',
    grid: 16,
  },
  plus: {
    viewBox: '0 0 16 16',
    paths: ['M8 3v10M3 8h10'],
    strokeWidth: 1.3,
    source: 'repo/sessiontree',
    grid: 16,
  },
  // 实心：迁移前 grantShieldIcon 只写 viewBox/width/height/aria-hidden，
  // 描边与填充全靠 styles/grants.css 的 .sess-leaf-grant svg path 规则。
  'grant-shield': {
    viewBox: '0 0 16 16',
    paths: ['M8 1.6 13.2 3.4v4.2c0 3.1-2.1 5.6-5.2 6.8-3.1-1.2-5.2-3.7-5.2-6.8V3.4z'],
    strokeWidth: 1.2,
    filled: true,
    source: 'repo/sessiontree',
    grid: 16,
  },
  // 同一枚 chevron 在 messages（思考段）与 toolcards（工具卡）各抄了一份 —— 本次合并为一条。
  'chevron-fold': {
    viewBox: '0 0 16 16',
    paths: ['M6 3.5 10.5 8 6 12.5'],
    strokeWidth: 1.6,
    source: 'repo/messages+toolcards',
    grid: 16,
  },
  // 12 网格：迁移前 plugins 的 chevron() **不写** width/height（尺寸由 .plug-expand svg 定）。
  'chevron-expand': {
    viewBox: '0 0 12 12',
    paths: ['M4 2.5 L8 6 L4 9.5'],
    strokeWidth: 1.6,
    source: 'repo/plugins',
    grid: 12,
  },
  'attach-clip': {
    viewBox: '0 0 24 24',
    paths: ['M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48'],
    strokeWidth: 1.8,
    source: 'lucide/paperclip',
    grid: 24,
  },
  'mode-standard': {
    viewBox: '0 0 16 16',
    paths: ['M2.4 4.2h.01M5.4 4.2h8.2M2.4 8h.01M5.4 8h8.2M2.4 11.8h.01M5.4 11.8h8.2'],
    strokeWidth: 1.5,
    source: 'repo/statusline-mode',
    grid: 16,
  },
  'mode-execution': {
    viewBox: '0 0 16 16',
    paths: ['M3 4.6 6.4 8 3 11.4M8.6 11.6h4.4'],
    strokeWidth: 1.5,
    source: 'repo/statusline-mode',
    grid: 16,
  },
};

/** 每个图标的默认渲染尺寸（px）。**逐字取自迁移前的调用点**，未归一化。 */
const DEFAULT_SIZE: Record<IconName, number> = {
  folder: 13,
  file: 13,
  search: 13,
  sort: 13,
  'folder-plus': 13,
  plus: 13,
  'grant-shield': 10,
  'chevron-fold': 14,
  // 迁移前 plugins 的 chevron() 不设尺寸（CSS 的 .plug-expand svg 给 12px）。
  // 保持「不写 width/height」这个形态，否则会盖过 CSS、改变现有视觉。
  'chevron-expand': 0,
  'attach-clip': 16,
  'mode-standard': 13,
  'mode-execution': 13,
};

/** 调用点可覆盖的渲染参数。 */
export interface IconOptions {
  /**
   * 渲染尺寸（px）。`undefined` = 用 `DEFAULT_SIZE`。
   * `0` = **不写** width/height（尺寸交给 CSS）—— 迁移前 plugins chevron 就是这个形态。
   */
  size?: number;
  /** 挂在 `<svg>` 上的 class（不带点）。 */
  className?: string;
  /**
   * 语义性图标的覆盖口。
   *   · `undefined`（默认）⇒ 装饰性：`aria-hidden="true" focusable="false"`。
   *   · `false`         ⇒ 同上（显式装饰）。
   *   · `true`          ⇒ **语义性**：不写 aria-hidden，另加 `role="img"`，可配 `ariaLabel`。
   * 一个真实存在过的坑：sessiontree 的 6 枚图标迁移前**根本没有** aria-hidden
   * （能被读屏器读成无名字的 graphic），本次顺手补上默认值属「无障碍修好」，
   * 但**不改几何、不改视觉**；`ariaHidden: true` 就是留给需要回到旧形态的调用方的。
   */
  ariaHidden?: boolean;
  /** 语义性图标的无障碍名（`ariaHidden: false` 时写成 `aria-label`）。 */
  ariaLabel?: string;
}

function specOf(name: IconName): IconSpec {
  const spec = ICONS[name];
  if (spec === undefined) {
    // 走到这里只可能是 TS 被绕过（`as IconName` 的外部输入）。抛错而不是返回空图标：
    // 空图标在 UI 上是「看起来正常、其实什么都没画」，比崩更难查。
    // copy-gate-allow：这是开发者可见的异常消息（进 console / 测试断言），
    // **不是**渲染给用户的中文文案，故不过 i18n。
    throw new Error('ui/icons: 未知图标名 ' + JSON.stringify(name)); // copy-gate-allow
  }
  return spec;
}

/** 属性值转义（className / aria-label 可能来自运行时，SVG 是 XML 上下文）。 */
function esc(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 组装开标签（两个出口共用，保证开标签逐字一致）。 */
function openTag(name: IconName, spec: IconSpec, opts: IconOptions): string {
  const size = opts.size === undefined ? (DEFAULT_SIZE[name] ?? 0) : opts.size;
  const cls = opts.className === undefined || opts.className === '' ? '' : ' class="' + esc(opts.className) + '"';
  const wh = size > 0 ? ' width="' + size + '" height="' + size + '"' : '';
  // 默认装饰性；ariaHidden:false = 语义性（不藏，加 role/label）。
  const semantic = opts.ariaHidden === false;
  const a11y = semantic
    ? ' role="img"' + (opts.ariaLabel === undefined || opts.ariaLabel === '' ? '' : ' aria-label="' + esc(opts.ariaLabel) + '"')
    : ' aria-hidden="true" focusable="false"';
  return '<svg' + cls + ' viewBox="' + spec.viewBox + '"' + wh + a11y + '>';
}

/** 组装内部 path 标记（两个出口共用，保证几何逐字一致）。 */
function innerMarkup(spec: IconSpec): string {
  const paint = spec.filled === true
    ? ' fill="currentColor"'
    : ' fill="none" stroke="currentColor" stroke-width="' + spec.strokeWidth + '"' +
      ' stroke-linecap="round" stroke-linejoin="round"';
  let out = '';
  for (const d of spec.paths) out += '<path d="' + d + '"' + paint + '></path>';
  return out;
}

/**
 * 出口 A —— **字符串**，给模板字面量 / innerHTML（toolcards、plugins、messages、mode、inputbar）。
 *
 * 源码是常量 + 调用点给的 className/ariaLabel，**不经过任何用户输入的路径数据**；
 * className/ariaLabel 仍走 esc()，不给 innerHTML 留注入面。
 */
export function iconSvg(name: IconName, opts: IconOptions = {}): string {
  const spec = specOf(name);
  return openTag(name, spec, opts) + innerMarkup(spec) + '</svg>';
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 出口 B —— **DOM 节点**，给 createElementNS 路线（sessiontree、fsbrowser）。
 *
 * 属性与出口 A 逐字相同（同一个 openTag 组装逻辑 ⇒ 几何不可能漂移，有测试钉住）。
 */
export function iconNode(name: IconName, opts: IconOptions = {}): SVGSVGElement {
  const spec = specOf(name);
  const holder = document.createElementNS(SVG_NS, 'svg');
  // 复用出口 A 的标签组装：把开标签解析成属性再逐个 setAttribute，
  // 避免「字符串版」与「节点版」各写一套属性逻辑而漂移。
  const tag = openTag(name, spec, opts);
  const attrRe = /([a-zA-Z-]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(tag)) !== null) {
    if (m[1] !== undefined && m[2] !== undefined) holder.setAttribute(m[1], m[2]);
  }
  for (const d of spec.paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    if (spec.filled === true) p.setAttribute('fill', 'currentColor');
    else {
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', String(spec.strokeWidth));
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
    }
    holder.appendChild(p);
  }
  return holder;
}

/**
 * 品牌图标（模型家族）：**只把 SVG 源接进本表，按模型 id 查表的逻辑原地不动**。
 *
 * 为什么不并入 ICONS：品牌标识与 UI chrome 是两类东西（前者是「这是哪个厂商」的身份，
 * 后者是操作控件）。混在一张表里会让两类失去边界 —— 按 id 查表、未命中返回 null、
 * CSS 用 --mi-<key> 上色这套逻辑一行未改，只多一个从本表取几何的口子。
 *
 * 几何仍来自 utils/model-icons.generated.ts（W778 抓取 @lobehub/icons-static-svg@1.95.0，
 * MIT），生成器与产物都没动；本函数只负责**包裹**（viewBox 0 0 24 24 / 12px /
 * fill=currentColor / aria-hidden），与迁移前 model-icon.ts 的包裹逐字一致。
 *
 * 没有 `key` 参数：家族色由**外层** .sl-micon-<key> 的 CSS 变量（--mi-<key>）决定，
 * 迁移前的包裹也不带 key（class 恒为 .sl-micon-svg），照原样。
 */
export function modelBrandSvg(pathsMarkup: string): string {
  return (
    '<svg class="sl-micon-svg" viewBox="0 0 24 24" width="12" height="12" fill="currentColor" ' +
    'aria-hidden="true" focusable="false">' +
    pathsMarkup +
    '</svg>'
  );
}
