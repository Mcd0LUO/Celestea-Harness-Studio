// ============================================================================
// ui/workbench/session-sync.ts — W9329：把工作台面板**绑到当前会话**。
// ----------------------------------------------------------------------------
// 用户原话（原型已拍板）：「**面板状态是会话级**：每个会话各自记住开合 / 宽度 /
// 当前文件；切会话即切面板。」
//
// 本模块是那件事的**接线**，两条边：
//   ① 切会话 ⇒ **存**旧会话的视图（开合 / 宽度 / 当前文件）→ **应用**新会话的；
//   ② 会话内改动（开关面板、拖宽度、点文件）⇒ 由面板层在改动后调 syncCurrentSession()
//      **写回**当前会话。
// ③ 换行开关**不在这条边上**（它是全局阅读偏好，见 session-state 的分界注释）。
//
// ★ 为什么「应用」是**改数据 + 重渲染**而不是删了重建：
//   ① 重建会把 .wb-panel 整个换掉，终端面板持有的 pty（真进程）也会跟着重挂
//      （W1528 的 reapClosedTerminals 会误判成「面板没了 ⇒ 杀进程」）；
//   ② 重建会让**所有**面板的滚动位与已画内容归零，而用户的直觉是「我只是切了个会话」。
//   改 data.openFile 再 refreshFilesPanel 只重画**这一个文件管理器面板的正文**，
//   #messages / .chat-shell 的节点身份照旧不动（铁律 5）。
// ============================================================================
import { activeSessionId, onPaneChange } from '../viewctx';
import { listPanels, closePanel, openPanel, setPanelSize, type PanelState } from './state';
import { sessionView, setSessionFile, setSessionOpen, setSessionWidth } from './session-state';
import { refreshFilesPanel } from './panel';

/** 当前绑定的会话 id（装配时取一次，之后由 onPaneChange 推进）。 */
let bound: string | null = null;

/** 本会话此刻的面板视图（从活着的面板里读出来）。 */
function readLive(): { open: boolean; width: number; file: string | null } {
  const files = listPanels().find((p) => p.kind === 'files');
  if (files === undefined) return { open: false, width: sessionView(bound ?? '').width, file: null };
  const d = files.data as { openFile?: string | null } | undefined;
  return { open: true, width: files.size, file: d?.openFile ?? null };
}

/** 把**当前**面板状态写回**当前**会话。 */
export function syncCurrentSession(): void {
  if (bound === null) bound = activeSessionId();
  const live = readLive();
  setSessionOpen(bound, live.open);
  setSessionWidth(bound, live.width);
  setSessionFile(bound, live.file);
}

/** 把某会话记住的视图**应用**到面板上。 */
function apply(sessionId: string): void {
  const v = sessionView(sessionId);
  const files = listPanels().find((p) => p.kind === 'files');
  if (!v.open) {
    // 关：把这个会话的面板全部收掉（多开的面板也一起，否则会串到别的会话）。
    for (const p of listPanels()) closePanel(p.id);
    return;
  }
  if (files === undefined) {
    const panel: PanelState = openPanel('files', 'right', { openFile: v.currentFile });
    setPanelSize(panel.id, v.width);
    return;
  }
  // 已有面板：改数据 + 改宽 + 重画正文（**不**换面板节点 ⇒ 滚动位/pty 不受影响）。
  if (files.size !== v.width) setPanelSize(files.id, v.width);
  const d = files.data as { openFile?: string | null } | undefined;
  if (d !== undefined && (d.openFile ?? null) !== v.currentFile) {
    d.openFile = v.currentFile;
    refreshFilesPanel(files.id);
  } else {
    refreshFilesPanel(files.id);
  }
}

/** 装一次（幂等）：订阅会话切换。 */
export function installSessionSync(): void {
  if (bound !== null) return;
  bound = activeSessionId();
  onPaneChange(() => {
    const now = activeSessionId();
    if (now === bound) return;
    if (bound !== null) {
      // 切走：先把此刻的活状态存进**旧**会话（用户可能刚拖过宽度、点过文件）。
      const live = readLive();
      setSessionOpen(bound, live.open);
      setSessionWidth(bound, live.width);
      setSessionFile(bound, live.file);
    }
    bound = now;
    apply(now);
  });
}

/** 当前绑定的会话 id（测试/诊断用）。 */
export function boundSessionId(): string | null {
  return bound;
}

/** 解除绑定（测试/卸载用；让 installSessionSync 可再次装配）。 */
export function resetSessionSync(): void {
  bound = null;
}
