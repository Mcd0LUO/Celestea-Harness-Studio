// ============================================================================
// ui/workbench/session-state.ts — W9329：**面板状态是会话级**（每个会话各自记得
//   开合 / 宽度 / 当前文件；切会话即切面板）。
// ----------------------------------------------------------------------------
// 用户原话（prototype/right-panel.html 已拍板）：「面板状态是会话级：每个会话各自
// 记住开合 / 宽度 / 当前文件；切会话即切面板。」「宽度不持久化（刷新即回默认）」。
//
// 两条边界，刻意分开：
//   · **会话级**（本文件的主数据）：open / width / currentFile —— 这是「这个会话在看
//     什么」，跟着会话走，**只活在内存**（刷新即失，符合已拍板的「宽度不持久化」）。
//   · **全局阅读偏好**（wrapCode / setWrapCode）：换行是「怎么读代码」，不属于任何
//     会话 ⇒ 走 localStorage，跨会话共享（与 sidebar 宽度的持久化同一口径）。
//
// 为什么要独立成文件而不是塞进 state.ts：state.ts 是**面板集合**（PanelState[]）的
// 纯数据层，零 DOM、被 g4-workbench 全部用例直接读；会话视图是**另一个维度**的映射
// （sessionId → 该会话的面板视图）。混进同一个数组会让「切会话」变成删了再建一个面板，
// 而那是「重建」（铁律 5 会把背景节点身份弄丢）。
// ============================================================================
import { t } from '../../i18n';

const WRAP_STORAGE_KEY = 'celestea.wb.wrapCode';

/** 一个会话记住的面板视图。 */
export interface SessionPanelView {
  open: boolean;
  width: number;
  /** 当前打开的文件（绝对路径）；null = 显示文件树。 */
  currentFile: string | null;
}

const DEFAULT_WIDTH = 420;

/** sessionId → 视图。模块级 Map（只活在内存，刷新即回默认）。 */
const views = new Map<string, SessionPanelView>();

function defaults(): SessionPanelView {
  return { open: false, width: DEFAULT_WIDTH, currentFile: null };
}

/** 取某会话的视图（**不存在则创建默认值**并登记 ⇒ 写回时必有对象）。 */
export function sessionView(sessionId: string): SessionPanelView {
  let v = views.get(sessionId);
  if (!v) {
    v = defaults();
    views.set(sessionId, v);
  }
  return v;
}

/** 面板开合（会话级）。 */
export function setSessionOpen(sessionId: string, open: boolean): void {
  sessionView(sessionId).open = open;
}

/** 面板宽度（会话级；夹在 [最小, 最大] 内，见 panel.ts 的 SPLIT_MIN/MAX）。 */
export function setSessionWidth(sessionId: string, width: number): void {
  const v = sessionView(sessionId);
  v.width = Math.round(width);
}

/** 当前打开的文件（null = 回到文件树）。 */
export function setSessionFile(sessionId: string, file: string | null): void {
  sessionView(sessionId).currentFile = file;
}

/** 该会话当前是否开着面板。 */
export function isSessionOpen(sessionId: string): boolean {
  return views.get(sessionId)?.open === true;
}

// ---------------------------------------------------------------------------
// 全局阅读偏好：换行开关（跨会话共享、持久化 —— 它是偏好，不是「这个会话在看什么」）
// ---------------------------------------------------------------------------
function readWrap(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(WRAP_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

let wrapCode = readWrap();

/** 当前是否开启自动换行（全局）。 */
export function isWrapOn(): boolean {
  return wrapCode;
}

/** 设置自动换行（全局；持久化到 localStorage）。 */
export function setWrapCode(on: boolean): void {
  wrapCode = on;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(WRAP_STORAGE_KEY, on ? '1' : '0');
  } catch {
    // localStorage 不可用（隐私模式 / 测试 jsdom 早期）：换行偏好退回内存内生效，
    // 不抛 —— 阅读偏好转瞬即逝不该让面板打不开。
  }
}

/** 「← 树」返回按钮的标题（走字典，避免硬编码中文文案）。 */
export function backToTreeLabel(): string {
  return t('chat.wb.backToTree');
}
