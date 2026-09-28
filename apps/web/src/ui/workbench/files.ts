// ============================================================================
// ui/workbench/files.ts — G4：文件管理器面板（Win 风格）。
// ----------------------------------------------------------------------------
// 数据源：GET /api/fs/list?path=（冻结形状 {name,type,size,mtime} + truncated）。
//   · 点文件夹进入、点文件**在右侧预览面板打开**（W1545，取代 W1532 的行内展开）；
//     面包屑 + 上级；
//   · 目录被截断（truncated）/ 端点报错 → **显式可读提示**，不静默。
// 竞态：调用方给 seq + isCurrent（每次导航取新 seq，晚到的旧目录结果丢弃）；
//       文件内容的竞态由**预览面板自己的 seq** 守着（openPreview 每次 ++seq，
//       晚到的旧文件段落一个字都画不进去）。
// 铁律：离屏构建 + 单次 replaceChildren（只动本面板 body）。
//
// ★ W1545（用户：「打开文件应该直接渲染完整的文件（流式打开巨文件）而不是直接原地
//   展开，且原地展开的文件还没有高亮」+「右侧的预览是应该几乎瞬时出现的」）：
//   W1532 的行内展开被**整块移除**（.wb-inline / files-inline.ts 已删）。理由三条，
//   都是用户点出来的：
//     · 行内块长在目录列表里，天然只能给一个小窗口（旧上限 128 KiB + max-height 340px），
//       而用户要的是**完整文件**；
//     · 行内块**没有** .rendered 祖先，hljs 的颜色规则（components.css 的
//       `.rendered .hljs-keyword`）一条都命中不了 ⇒ 类加上了、颜色没生效；
//     · 右侧预览面板才是「看文件」的地方（工具卡预览、F2 都走它），两块渲染面
//       本来就该是同一块。
//   内容装载在 ./files-open.ts：分段取（offset/limit）⇒ 面板壳先出、内容逐段追加。
// ============================================================================
import { el } from '../../utils/dom';
import { api } from '../../api';
import { workspacePath } from '../commands/files';
import type { FsListEntry } from '../../types/fs-list';
import { nextSeq, type PanelState } from './state';
import { joinPath, parentOfPath } from '../fs-path'; // 平台路径（win32 盘符/UNC vs POSIX）
import { openFilePreview } from './files-open';
import { bindListKeys, consumeFocusAfterNav, focusFirstRow, markRowButton, ROW_SEL } from './files-keys'; // W2040/W2053：行的键盘通道
import { t } from '../../i18n';

/** 单面板内的浏览状态（挂在面板 data 上，切换时不丢）。 */
interface FilesData {
  path: string;
  selected: string | null;
}

/** 人类可读大小。 */
function fmtSize(n: number | null): string {
  if (n === null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

/** 人类可读时间（本地）。 */
function fmtTime(iso: string | null): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => (n < 10 ? '0' : '') + String(n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function dataOf(panel: PanelState): FilesData {
  const d = panel.data as unknown as Partial<FilesData> | undefined;
  if (d && typeof d.path === 'string') {
    if (d.selected === undefined) d.selected = null;
    return d as FilesData;
  }
  const init: FilesData = { path: workspacePath(), selected: null };
  panel.data = init as unknown as Record<string, unknown>;
  return init;
}

/** 渲染文件管理器面板内容（可重入：导航时重新调用，只动 body）。 */
export async function renderFilesPanel(
  body: HTMLElement,
  panel: PanelState,
  seq: number,
  isCurrent: (id: string, seq: number) => boolean,
): Promise<void> {
  const data = dataOf(panel);
  if (data.path === '') {
    body.replaceChildren(el('div', 'wb-notice', t('chat.wb.noWorkspace')));
    return;
  }
  const path = data.path;
  let resp;
  try {
    resp = await api.fsList(path);
  } catch {
    if (!isCurrent(panel.id, seq)) return;
    body.replaceChildren(el('div', 'wb-notice', t('chat.wb.listUnavailable')));
    return;
  }
  if (!isCurrent(panel.id, seq)) return; // 竞态：晚到的旧目录结果丢弃
  if (resp.error !== undefined && resp.error !== '') {
    body.replaceChildren(el('div', 'wb-notice', t('chat.wb.dirOpenFailed', { reason: resp.error })));
    return;
  }
  const entries = resp.entries ?? [];
  const off = document.createElement('div');
  const bar = el('div', 'wb-crumbs');
  const up = el('button', 'wb-crumb', t('chat.wb.up')) as HTMLButtonElement;
  up.type = 'button';
  // 已在根（POSIX '/' / Windows 'C:\' / UNC '\\server\share\'）：上一级就是它自己 ⇒ 禁用，
  // 避免一次「导航到原地」的无效请求（后端在盘符根会把 parent 回成 C:\ 自身）。
  const atRoot = parentOfPath(path) === path;
  up.disabled = atRoot;
  if (atRoot) up.title = t('chat.wb.upAtRoot');
  up.addEventListener('click', () => {
    if (atRoot) return;
    data.path = parentOfPath(path);
    data.selected = null;
    // 导航取**新** seq：晚到的旧目录结果会被 isCurrent 判为过期而丢弃。
    void renderFilesPanel(body, panel, nextSeq(panel.id), isCurrent);
  });
  bar.appendChild(up);
  const label = el('span', 'wb-crumb wb-crumb-cur', path);
  label.title = path;
  bar.appendChild(label);
  off.appendChild(bar);
  if (resp.truncated === true) off.appendChild(el('div', 'wb-notice', t('chat.wb.dirTruncated')));
  const list = el('div', 'wb-list');
  if (entries.length === 0) list.appendChild(el('div', 'wb-notice', t('chat.wb.dirEmpty')));
  for (const e of entries) list.appendChild(row(e, data, path, body, panel, isCurrent));
  // W2040：列表整体的键盘通道（roving tabindex：整个列表只占 1 个 Tab 停靠点）。
  // 挂在**列表**上而不是每一行：行是每次导航整体重建的，委托让重建不需要注销动作。
  bindListKeys(list);
  off.appendChild(list);
  body.replaceChildren(...Array.from(off.childNodes));
  // W2040：键盘进入目录后列表被重建，原来那行已不在 DOM 上（焦点会掉回 <body>）⇒
  // 把焦点接回新列表的第一行。**只有键盘导航会置位**，鼠标路径一字不变。
  if (consumeFocusAfterNav()) focusFirstRow(body);
}

function row(
  e: FsListEntry,
  data: FilesData,
  dir: string,
  body: HTMLElement,
  panel: PanelState,
  isCurrent: (id: string, seq: number) => boolean,
): HTMLElement {
  // W2040：行是**列表项**（不是 W2025 正文里的行内元素）⇒ 走 roving tabindex：
  // 每行都可被编程聚焦（-1），但同一时刻只有一行进 Tab 序列（0，由 bindListKeys 分配）。
  // role=button + title 是 WAI-ARIA 对「用 div 做按钮」的要求（4.1.2 Name, Role, Value），
  // 与 file-link-mark.ts 的 markHit 同一口径。★ 属性写在**节点**上（行每次新建，天然幂等）。
  const r = el('div', 'wb-row' + (e.type === 'dir' ? ' dir' : '') + (data.selected === e.name ? ' sel' : ''));
  // W2053：改调共享内核（原来手写 tabIndex/role 两行）—— 内核会**同时**打上 roving
  // 标记属性，那是键盘通道认行的唯一依据（5 处列表行共用同一个常量，不存在两份
  // 选择器漂移的机会）。不传 label ⇒ 用内容取名：行里只有图标+文件名+大小+时间，
  // 内容取名恰好就是用户想听的那串（真机 AX 实测）。
  markRowButton(r);
  r.title = t('chat.wb.rowOpen');
  r.appendChild(el('span', 'wb-icon', e.type === 'dir' ? '📁' : '📄'));
  r.appendChild(el('span', 'wb-name', e.name));
  r.appendChild(el('span', 'wb-size', fmtSize(e.size)));
  r.appendChild(el('span', 'wb-time', fmtTime(e.mtime)));
  r.addEventListener('click', () => {
    if (e.type === 'dir') {
      data.path = joinPath(dir, e.name);
      data.selected = null;
      void renderFilesPanel(body, panel, nextSeq(panel.id), isCurrent);
      return;
    }
    // W1545：点文件 ⇒ **右侧预览面板**（不再是行下方内联展开）。
    // 清选中态按**本面板**作用域（同一种面板可多开，document 级会误伤别的面板）。
    body.querySelectorAll(ROW_SEL).forEach((n) => n.classList.remove('sel'));
    r.classList.add('sel');
    data.selected = e.name;
    // 同步调用：面板壳当帧出现，内容由 files-open.ts 分段喂（首段小 ⇒ 首屏快）。
    openFilePreview(joinPath(dir, e.name));
  });
  return r;
}
