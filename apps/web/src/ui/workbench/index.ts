// ============================================================================
// ui/workbench/index.ts — G4：多面板工作区对外入口（装配一次）。
//   第一步：面板系统 + 右上角入口菜单 + 文件管理器。
//   第二步：终端 + 浏览器 + dock 拖拽（同一套 state/panel）。
// ============================================================================
import { installWorkbench } from './panel';
import { installWorkbenchEntry } from './menu';
import { installLinkOpen } from './link-open'; // W2057：正文外链 ⇒ 浏览器面板
import { installSessionSync } from './session-sync'; // W9329：面板状态绑到当前会话

export { installWorkbench, installWorkbenchEntry };
export { openPanel, closePanel, listPanels, setPanelDock, setPanelSize, onPanelsChange, resetPanels } from './state';
export { toggleWorkbenchMenu, openWorkbenchPanel, closeWorkbenchMenu } from './menu';
export { openUrlInPanel } from './open-url';
export { installLinkOpen } from './link-open';
export { renderWorkbench, refreshFilesPanel } from './panel';
// W9329：会话级面板状态（开合 / 宽度 / 当前文件）+ 全局换行偏好。
export { sessionView, setSessionOpen, setSessionWidth, setSessionFile, isSessionOpen, isWrapOn, setWrapCode } from './session-state';
export { syncCurrentSession, installSessionSync, resetSessionSync, boundSessionId } from './session-sync';
export type { SessionPanelView } from './session-state';
export type { PanelKind, DockSide, PanelState } from './state';

let installed = false;

/** 装配多面板工作区（幂等；main.ts 调用一次）。 */
export function initWorkbench(): void {
  if (installed) return;
  installed = true;
  installWorkbench();
  installWorkbenchEntry();
  // W9329：面板状态是**会话级** —— 订阅会话切换，切会话即切面板。
  installSessionSync();
  // W2057：正文外链的点击委托。挂在这里（而不是 main.ts）的理由：它是
  // **工作台**的能力（出口是工作台面板），与面板系统同生同死；main.ts 是
  // 装配清单，多一行 import 就够，不需要知道委托的存在。
  installLinkOpen();
}