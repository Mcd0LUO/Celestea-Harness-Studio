// ============================================================================
// ui/workbench/files-view.ts — W9329：**面板内单页**的文件视图（照原型已拍板）。
// ----------------------------------------------------------------------------
// 用户原话：「打开文件，内容**原地**全量呈现」；原型 right-panel.html 已拍板：
//   「打开文件 = 面板内单页：内容原地呈现，「← 树」返回。**不做左右分栏**。」
//
// 三条设计（全部照原型，不重新发明）：
//   ① **单页**：面板表头是 路径 + 换行开关 + 「← 树」；正文只有一块（文件树**或**
//      文件内容），不做「左边树右边内容」的分栏。
//   ② **巨文件走流式**：**直接复用** ui/preview/stream.ts 的既有能力 —— 本模块只
//      提供 sink（容器/守卫/页脚）与 provider（读一段），分段追加、竞态守卫、
//      段间让帧、content-visibility 全部在那边，**不另写一套流式循环**。
//      本面板与右侧预览唯一的差别是「每段长什么样」：那边是 pre>code（高亮切行），
//      这边是带 **56px 固定行号列**的 .wb-line（workbench.css）。这个差别由
//      stream.ts 新增的 renderSegment 钩子承接（见它的头注）。
//   ③ **页脚如实**：流式写「流式：已加载 N / 共 M 行」；整篇写「共 N 行 · 已全部加载
//      （无截断）」。两种模式的文案**必须分开** —— 混成一句就是把「还在读」说成
//      「读完了」。
// ============================================================================
import { el } from '../../utils/dom';
import { createReader, countLines } from './files-open';
import { highlightCode } from '../../utils/hljs';
import { collectSegments, splitCodeLines } from '../enhance/code-extras';
import { extOf } from '../preview/detect';
import { LANG_BY_EXT } from '../preview/lang';
import { PREVIEW_MAX_CHARS } from '../preview/renderers';
import { classifyByPath, type PreviewKind } from '../preview/detect';
import { streamInto, splitForHighlight, type StreamFill, type StreamSink } from '../preview/stream';
import { isWrapOn, setWrapCode, backToTreeLabel } from './session-state';
import { t } from '../../i18n';

/** 超过这个行数就走流式（照原型 renderPanel 的 2000 行判据）。 */
export const STREAM_THRESHOLD_LINES = 2000;

/** 不认识扩展名时按纯文本渲染（与 files-open 的 kindOf 同一口径，避免两处漂移）。 */
function kindOf(path: string): PreviewKind {
  const k = classifyByPath(path);
  return k === 'markdown' || k === 'diff' || k === 'code' ? k : 'code';
}

/**
 * 一段文本 → **高亮后**的 `.wb-line` 行，追加到 scope。
 *
 * ★ 复用两处既有能力，**不另写一套**：
 *   ① `utils/hljs.ts` 的 `highlightCode`：真的 hljs（跨行词法正确）+ 有界 LRU 缓存。
 *      它对 >32 KB 的块**自动跳过**（既有取舍）—— 所以巨文件的分段块保持纯文本、
 *      不会把主线程拖死（流式的 1200 行段 ≈ 72 KB，正在这条规则内）。
 *   ② `code-extras` 的 `collectSegments` + `splitCodeLines`：把**跨行**的 hljs span
 *      （多行注释 / 模板串）按换行拆开、**保留 class 栈**。
 *      自己写这个切分正是 bug 温床（hljs 的 span 可以横跨很多行），所以直接借用
 *      仓库里那一份已存在的实现。
 *
 * 为什么不用 `<pre><code>` 直接当正文（像 preview 面板那样）：那个形态的行号是
 * `.cl::before` 的 `min-width:2ch` 伪元素，**不是** 56px 的固定列，且行号来自
 * CSS counter（做不了「跨段连续」）。本面板的口径是**每个 .wb-line 自带行号列**
 * —— 行号由调用方给的 startLine 决定，分段追加时天然连续（见 renderSegment 注释）。
 */
function appendHighlightedLines(scope: HTMLElement, text: string, startLine: number, path: string): number {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (body === '') return 0;
  const lang = LANG_BY_EXT[extOf(path)];
  let line = startLine;
  // ★ 必须先按 HL_BLOCK_MAX_CHARS（24 KB）切块，**再**逐块跑 hljs —— 否则整篇
  //   塞进一个块时，hljs 那条「>32 KB 跳过」的既有规则会让**大文件一个字都不高亮**
  //   （真机/本用例实测：500 行 ≈ 75 KB ⇒ .hljs-keyword = 0）。
  //   这个切块函数是 stream.ts 的那一份（同一口径、同一取舍），不另写。
  for (const chunk of splitForHighlight(body)) {
    if (chunk === '') continue;
    // ① 装一个 pre>code，走真 hljs（跨行词法正确 + 有界 LRU 缓存）。
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    if (lang !== undefined) code.className = 'language-' + lang;
    code.textContent = chunk;
    pre.appendChild(code);
    highlightCode(pre);
    // ② 借用 code-extras 的跨行切分（保留 hljs class 栈；多行注释/模板串不会断在行中）。
    const lines = splitCodeLines(collectSegments(code));
    // ③ 铺成 .wb-line（行号列 + 文本列，几何见 workbench.css）。
    const frag = document.createDocumentFragment();
    for (let i = 0; i < lines.length; i += 1) {
      const row = el('div', 'wb-line');
      row.appendChild(el('span', 'wb-line-no', String(line + i + 1)));
      const tx = el('span', 'wb-line-tx');
      for (const seg of lines[i]?.segments ?? []) {
        if (seg.classes.length === 0) tx.appendChild(document.createTextNode(seg.text));
        else {
          const s = el('span', seg.classes.join(' '));
          s.textContent = seg.text;
          tx.appendChild(s);
        }
      }
      row.appendChild(tx);
      frag.appendChild(row);
    }
    scope.appendChild(frag);
    line += lines.length;
  }
  return line - startLine;
}

/** 文件视图的对外出口（files.ts 调它；它不认面板状态层，只认容器与守卫）。 */
export interface FileViewDeps {
  /** 正文容器（.wb-body）。 */
  body: HTMLElement;
  /** 面板表头容器（放路径 + 换行开关 + 「← 树」）。 */
  head: HTMLElement;
  /** 绝对路径。 */
  path: string;
  /** 竞态守卫：这一段还属于当前文件吗（panel 的 seq 口径）。 */
  isCurrent(): boolean;
  /** 「← 树」按钮的回调。 */
  onBack(): void;
}

/**
 * 脚手架：表头三件套 + 正文滚动容器 + 页脚。
 *
 * 表头是**每次打开文件重建**的（换行开关是全局偏好，值每次读当前偏好），
 * 正文是**追加**的（铁律 1/2）—— 两者分工在这一个函数里写死。
 */
function scaffold(d: FileViewDeps): { file: HTMLElement; code: HTMLElement; foot: HTMLElement } {
  const file = el('div', 'wb-file' + (isWrapOn() ? ' wrap' : ''));
  // ★ 正文容器必须带 .rendered：hljs 的颜色规则**全部**作用域限定在它下面
  //   （components.css 的 `.rendered .hljs-keyword`）。少了它，hljs 的 class
  //   都加上了、颜色一条都不命中 —— 那正是 W1532「原地展开的文件没有高亮」的
  //   同一个 bug（见 preview/panel.ts:207 的同一处理）。
  const code = el('div', 'wb-file-code rendered');
  const foot = el('div', 'wb-file-foot');
  file.appendChild(code);
  file.appendChild(foot);
  d.body.replaceChildren(file);

  // 表头：路径（单行省略）+ 换行开关 + 「← 树」。全部**常驻可见**（W1526 的教训：
  // hover 才显形 / opacity:0 的控件在触屏上等于不存在）。
  const pathLabel = el('span', 'wb-head-path', d.path);
  pathLabel.title = d.path;
  const wrapBtn = el('button', 'wb-head-btn', isWrapOn() ? t('chat.wb.wrapOn') : t('chat.wb.wrapOff')) as HTMLButtonElement;
  wrapBtn.type = 'button';
  wrapBtn.setAttribute('aria-pressed', String(isWrapOn()));
  wrapBtn.addEventListener('click', () => {
    setWrapCode(!isWrapOn());
    // 换行是**纯阅读偏好**：只改类名/文案/aria-pressed，**正文一个字不动**。
    file.classList.toggle('wrap', isWrapOn());
    wrapBtn.textContent = isWrapOn() ? t('chat.wb.wrapOn') : t('chat.wb.wrapOff');
    wrapBtn.setAttribute('aria-pressed', String(isWrapOn()));
  });
  const back = el('button', 'wb-head-btn', backToTreeLabel()) as HTMLButtonElement;
  back.type = 'button';
  back.title = backToTreeLabel();
  back.addEventListener('click', d.onBack);
  d.head.replaceChildren(pathLabel, wrapBtn, back);
  return { file, code, foot };
}

/**
 * 打开一个文件：整篇或流式，**原地**呈现在面板里。
 *
 * 判据用**首段的真实 totalLines**（不是猜的、不是文件名）：≤ 2000 行走整篇，
 * 超出走流式。首段是真实第一次读，所以阈值是量出来的。
 */
export async function renderFileView(d: FileViewDeps): Promise<void> {
  const { code, foot } = scaffold(d);
  const reader = createReader(d.path);

  // ---- 首段：真读一次，拿到总行数（判据） ----
  let first: StreamFill;
  try {
    first = await reader.next();
  } catch {
    first = { text: '', totalLines: 0, more: false, degraded: t('chat.preview.degradeReadFailed') };
  }
  if (!d.isCurrent()) return; // 竞态：晚到的首段整段丢弃
  if (first.degraded !== undefined) {
    foot.textContent = first.degraded;
    return;
  }
  const total = first.totalLines;

  if (total <= STREAM_THRESHOLD_LINES) {
    // ---- 整篇：读完剩下的（同一个 reader），一次性铺进去 ----
    let text = first.text;
    let cur: StreamFill = first;
    while (cur.more) {
      let next: StreamFill;
      try {
        next = await reader.next();
      } catch {
        next = { text: '', totalLines: total, more: false, degraded: t('chat.preview.degradeReadFailed') };
      }
      if (!d.isCurrent()) return;
      text += next.text;
      cur = next;
    }
    const n = countLines(text);
    appendHighlightedLines(code, text, 0, d.path);
    // ★ 整篇的页脚：**如实**说「已全部加载（无截断）」。被 8 MiB 客户端闸门夹住时
    //   改说实话（capped），绝不谎报「全部加载」—— 两种模式的文案不许混。
    foot.textContent = cur.capped === true
      ? t('chat.preview.streamLimit', { mb: Math.round(PREVIEW_MAX_CHARS / (1024 * 1024)) })
      : t('chat.wb.fileTotal', { n: String(n) });
    return;
  }

  // ---- 巨文件：流式（**复用** preview/stream.ts 的分段追加 / 竞态 / 让帧） ----
  // 首段已经读到手上了，用一次「先给首段、再给后续段」的 provider 把它**交回**
  // streamInto —— 这样首段也走同一条 append 路径（同一套行 DOM、同一套竞态守卫），
  // 不用在 streamInto 之外另铺一次 DOM（两份铺法迟早会漂移）。
  let loaded = 0; // 已画行数（renderSegment 累加；note 读它出进度）
  let primed = false; // provider 是否已交回首段
  const sink: StreamSink = {
    body: code,
    path: d.path,
    kind: kindOf(d.path),
    isCurrent: d.isCurrent,
    // 页脚由**本面板**的文案接管（chat.wb.fileStream：流式：已加载 N / 共 M 行）。
    // streamInto 传进来的默认文案在此**被忽略**（两个面板的措辞本就不同）。
    // loaded 由 renderSegment 顺带累加（它是唯一知道「本段画了几行」的地方）。
    note: (): void => {
      foot.textContent = t('chat.wb.fileStream', { loaded: String(loaded), total: String(total) });
    },
    // 每段 → 本面板的行 DOM（56px 固定行号列 + 文本列；几何见 workbench.css）。
    // 行号从 startLine 起：streamInto 逐段累加传入，跨段的行号因此**连续**
    // （自增计数器做不到这件事 —— 那是 code-extras 的 `.cl::before` 口径）。
    renderSegment: (text: string, startLine: number, scope: HTMLElement): HTMLElement | null => {
      const drawn = appendHighlightedLines(scope, text, startLine, d.path);
      if (drawn === 0) return null;
      loaded = startLine + drawn;
      return scope;
    },
  };
  await streamInto(sink, async (): Promise<StreamFill> => {
    if (!primed) {
      primed = true;
      return first;
    }
    return reader.next();
  });
}
