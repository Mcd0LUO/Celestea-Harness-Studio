// @vitest-environment jsdom
// ============================================================================
// W9324 验收：ui/icons.ts 是全仓 UI 图标的**唯一几何真源**。
//
// 守四件事，每件都对应一条变异负控制：
//   ① **两个出口几何一致**（iconSvg 与 iconNode 对同一 name 产出同一个 viewBox /
//      同一组 d / 同一套描边属性）—— 这条正是「绝不许两份真源」的机器证明：
//      只要有人给 iconNode 单独写一套属性逻辑而不复用 openTag，这里立刻红。
//   ② **视觉不回退**：迁移前的关键数值（网格 / 描边宽度 / 渲染尺寸 / currentColor）
//      逐项钉住 —— 合并真源最容易出的事故是「顺手归一化线宽」，那是改视觉。
//   ③ **未知 name 的行为明确**：抛错（不是静默返回空图标 —— 空图标在 UI 上看起来
//      「正常」，实际什么都没画，比崩更难查）。
//   ④ **默认装饰性 a11y + 允许覆盖**（ariaHidden:false 走语义性分支）。
// ============================================================================
import { describe, expect, it } from 'vitest';

import { ICONS, iconNode, iconSvg, type IconName } from './icons';

const ALL = Object.keys(ICONS) as IconName[];

/** 从节点上读出几何三元组（viewBox / d 列表 / 描边），用于与字符串出口对拍。 */
function geometryOf(node: SVGSVGElement): { viewBox: string; ds: string[]; strokeWidth: string | null } {
  const paths = Array.from(node.querySelectorAll('path'));
  return {
    viewBox: node.getAttribute('viewBox') ?? '',
    ds: paths.map((p) => p.getAttribute('d') ?? ''),
    strokeWidth: paths.length === 0 ? null : (paths[0]?.getAttribute('stroke-width') ?? null),
  };
}

/** 从 iconSvg 的字符串里读出同样的三元组（正则解析，不依赖 DOM）。 */
function geometryOfString(svg: string): { viewBox: string; ds: string[]; strokeWidth: string | null } {
  const viewBox = /viewBox="([^"]*)"/.exec(svg)?.[1] ?? '';
  const ds = Array.from(svg.matchAll(/<path d="([^"]*)"/g)).map((m) => m[1] ?? '');
  const strokeWidth = /stroke-width="([^"]*)"/.exec(svg)?.[1] ?? null;
  return { viewBox, ds, strokeWidth };
}

describe('W9324 ① iconSvg 与 iconNode 几何一致（同一份 paths 真源）', () => {
  it('每个图标的两个出口产出同一组几何', () => {
    for (const name of ALL) {
      const fromString = geometryOfString(iconSvg(name));
      const fromNode = geometryOf(iconNode(name));
      expect(fromNode.viewBox, `${name}: viewBox`).toBe(fromString.viewBox);
      expect(fromNode.ds, `${name}: path d 列表`).toEqual(fromString.ds);
      expect(fromNode.ds, `${name}: 必须真的画出东西`).not.toEqual([]);
    }
  });

  it('两个出口的描边宽度一致（实心图标除外 —— 它由 CSS 上色）', () => {
    for (const name of ALL) {
      const spec = ICONS[name];
      if (spec.filled === true) continue;
      expect(geometryOf(iconNode(name)).strokeWidth, name).toBe(String(spec.strokeWidth));
      expect(geometryOfString(iconSvg(name)).strokeWidth, name).toBe(String(spec.strokeWidth));
    }
  });

  it('节点出口的每个 path 都带 currentColor（颜色语义不回退）', () => {
    for (const name of ALL) {
      const node = iconNode(name);
      for (const p of Array.from(node.querySelectorAll('path'))) {
        // 描边图标写 fill="none" + stroke="currentColor"；实心图标写 fill="currentColor"。
        // 断言的是「**上色的那个通道**是 currentColor」，不是「恰好是哪个通道」。
        const fill = p.getAttribute('fill') ?? '';
        const stroke = p.getAttribute('stroke') ?? '';
        const painted = fill === 'none' ? stroke : fill;
        expect(painted, `${name}: 必须用 currentColor 上色`).toBe('currentColor');
      }
    }
  });
});

describe('W9324 ② 视觉不回退（迁移前逐字对齐的数值）', () => {
  it('网格 / 描边宽度 / 渲染尺寸与迁移前一致', () => {
    // 这张表 = 迁移前 9 个文件里的真实值。改这里等于改视觉。
    const BEFORE: Record<IconName, { viewBox: string; strokeWidth: number; size: string | null }> = {
      folder: { viewBox: '0 0 16 16', strokeWidth: 1.3, size: '13' },
      file: { viewBox: '0 0 16 16', strokeWidth: 1.3, size: '13' },
      search: { viewBox: '0 0 16 16', strokeWidth: 1.3, size: '13' },
      sort: { viewBox: '0 0 16 16', strokeWidth: 1.3, size: '13' },
      'folder-plus': { viewBox: '0 0 16 16', strokeWidth: 1.3, size: '13' },
      plus: { viewBox: '0 0 16 16', strokeWidth: 1.3, size: '13' },
      // grantShieldIcon：10px 实心盾（描边由 styles/grants.css 419 行给 1.2）
      'grant-shield': { viewBox: '0 0 16 16', strokeWidth: 1.2, size: '10' },
      // messages / toolcards 的折叠 chevron：14px、线宽 1.6
      'chevron-fold': { viewBox: '0 0 16 16', strokeWidth: 1.6, size: '14' },
      // plugins 的 chevron()：12 网格，**不写尺寸**（CSS 的 .plug-expand svg 给 12px）
      'chevron-expand': { viewBox: '0 0 12 12', strokeWidth: 1.6, size: null },
      // inputbar 的回形针：24 网格、16px、线宽 1.8
      'attach-clip': { viewBox: '0 0 24 24', strokeWidth: 1.8, size: '16' },
      // statusline 两枚徽标：13px、线宽 1.5
      'mode-standard': { viewBox: '0 0 16 16', strokeWidth: 1.5, size: '13' },
      'mode-execution': { viewBox: '0 0 16 16', strokeWidth: 1.5, size: '13' },
      // W9344 的复制图标：不是迁移来的，是**新画**的（取代代码块工具条上的文字「复制」）。
      // 网格/描边**刻意对齐本表既有的 16 网格 · 描边 1.5 档**（与 mode-* 同档），
      // 渲染尺寸 14px 与 chevron-fold 一致 —— 工具条里的小元素因此视觉同重。
      copy: { viewBox: '0 0 16 16', strokeWidth: 1.5, size: '14' },
      // W9347 目标胶囊的三枚动作图标（编辑/暂停/删除）：新画，网格与描边同样
      // 对齐 16 网格 · 描边 1.5 档，渲染 14px（与 copy / chevron-fold 一致）。
      pencil: { viewBox: '0 0 16 16', strokeWidth: 1.5, size: '14' },
      'pause-glyph': { viewBox: '0 0 16 16', strokeWidth: 1.5, size: '14' },
      trash: { viewBox: '0 0 16 16', strokeWidth: 1.5, size: '14' },
    };
    for (const name of ALL) {
      const want = BEFORE[name];
      const spec = ICONS[name];
      expect(spec.viewBox, `${name}: 表里的 viewBox`).toBe(want.viewBox);
      expect(spec.strokeWidth, `${name}: 描边宽度`).toBe(want.strokeWidth);
      const node = iconNode(name);
      // 断言**渲染出来**的 viewBox（不是只看表）—— 只看表的话，谁改坏 openTag
      // 里的 viewBox 拼接都不会红。这条断言是 W9324 变异负控制真正抓住的那一条。
      expect(node.getAttribute('viewBox'), `${name}: 渲染出的 viewBox`).toBe(want.viewBox);
      expect(geometryOfString(iconSvg(name)).viewBox, `${name}: 字符串出口的 viewBox`).toBe(want.viewBox);
      expect(node.getAttribute('width'), `${name}: width`).toBe(want.size);
      expect(node.getAttribute('height'), `${name}: height`).toBe(want.size);
    }
  });

  it('chevron-expand 保持「不写尺寸」的形态（写上去会盖过 CSS、改变视觉）', () => {
    // 注意断言用带空格的 ' width='/' height='：`stroke-width=` 也含 `width=` 子串。
    const svg = iconSvg('chevron-expand');
    expect(svg).not.toContain(' width=');
    expect(svg).not.toContain(' height=');
  });

  it('实心图标（grant-shield）不写 fill="none"（否则 CSS 的 fill 规则失效）', () => {
    expect(iconSvg('grant-shield')).not.toContain('fill="none"');
    expect(iconNode('grant-shield').querySelector('path')?.getAttribute('fill')).toBe('currentColor');
  });

  it('描边图标一律带圆头圆角接头（迁移前逐个显式写过）', () => {
    for (const name of ALL) {
      if (ICONS[name].filled === true) continue;
      const svg = iconSvg(name);
      expect(svg, `${name}: stroke-linecap`).toContain('stroke-linecap="round"');
      expect(svg, `${name}: stroke-linejoin`).toContain('stroke-linejoin="round"');
    }
  });
});

describe('W9324 ③ 未知 name 的行为明确（抛错，不是静默空图标）', () => {
  it('iconSvg 对未知名抛错', () => {
    expect(() => iconSvg('no-such-icon' as IconName)).toThrow(/未知图标名/);
  });

  it('iconNode 对未知名抛错', () => {
    expect(() => iconNode('no-such-icon' as IconName)).toThrow(/未知图标名/);
  });

  it('错误信息带上 offending 名字（便于定位是哪处调用点写错）', () => {
    expect(() => iconSvg('typo-folder' as IconName)).toThrow(/typo-folder/);
  });
});

describe('W9324 ④ 默认装饰性 a11y，且允许调用方覆盖', () => {
  it('默认加 aria-hidden + focusable=false', () => {
    for (const name of ALL) {
      const node = iconNode(name);
      expect(node.getAttribute('aria-hidden'), name).toBe('true');
      expect(node.getAttribute('focusable'), name).toBe('false');
    }
  });

  it('语义性图标：ariaHidden:false ⇒ 不藏、加 role=img 与 aria-label', () => {
    const node = iconNode('folder', { ariaHidden: false, ariaLabel: '文件夹' });
    expect(node.getAttribute('aria-hidden')).toBeNull();
    expect(node.getAttribute('role')).toBe('img');
    expect(node.getAttribute('aria-label')).toBe('文件夹');
  });

  it('className 覆盖生效，且经过转义（不给 innerHTML 留注入面）', () => {
    expect(iconSvg('folder', { className: 'ws-head' })).toContain('class="ws-head"');
    expect(iconSvg('folder', { className: 'a" onload="x' })).not.toContain('onload="x"');
    expect(iconNode('folder', { className: 'ws-head' }).getAttribute('class')).toBe('ws-head');
  });

  it('size 覆盖生效（0 = 不写尺寸，交给 CSS）', () => {
    expect(iconNode('folder', { size: 20 }).getAttribute('width')).toBe('20');
    expect(iconNode('folder', { size: 0 }).getAttribute('width')).toBeNull();
  });
});
