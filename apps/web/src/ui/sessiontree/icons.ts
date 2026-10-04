// ============================================================================
// ui/sessiontree/icons.ts — 会话树图标的**兼容出口**（几何真源已搬去 ./../icons.ts）。
//
// W9324：全仓图标合并进 ui/icons.ts（唯一 paths 真源 + iconSvg/iconNode 两个出口）。
// 本文件保留 svgIcon/grantShieldIcon 两个函数名与 IconKind 别名，使 render.ts / live.ts
// 的调用点与既有测试**一字不改** —— 合并真源不需要顺带改一堆调用点，那只是噪音。
// 换言之：本文件现在只是 ui/icons.ts 的一层薄适配，几何零复制。
// ============================================================================
import { iconNode, type IconName } from '../icons';

/** 会话树用到的图标名（= IconName 的子集；保留旧名以免调用点与测试全改）。 */
export type IconKind = 'folder' | 'file' | 'search' | 'sort' | 'folder-plus' | 'plus';

/** 旧名 → 新名（两套名字同形，只是收进了同一张表）。 */
const KIND_ICON: Record<IconKind, IconName> = {
  folder: 'folder',
  file: 'file',
  search: 'search',
  sort: 'sort',
  'folder-plus': 'folder-plus',
  plus: 'plus',
};

/** 16 网格 · 13px · 描边 1.3（尺寸/线宽在 ui/icons.ts 的 DEFAULT_SIZE 里，逐字沿用原值）。 */
export function svgIcon(kind: IconKind): SVGSVGElement {
  return iconNode(KIND_ICON[kind]);
}

/** 侧栏用的小盾牌图标（实心；颜色由 .sess-leaf-grant 的 class 决定）。 */
export function grantShieldIcon(): SVGSVGElement {
  return iconNode('grant-shield');
}
