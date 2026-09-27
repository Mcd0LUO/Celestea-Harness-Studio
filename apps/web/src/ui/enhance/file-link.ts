// ============================================================================
// ui/enhance/file-link.ts — 正文里的文件路径 ⇒ 已有的右侧预览面板（W2013 · A.5）。
// ----------------------------------------------------------------------------
// 用户要的：正文里提到的文件路径点一下就能看，而不是只能当纯文本读。
// 这份能力早就付过钱了（ui/preview/ 全套：面板 / 分段装载 / 双视图 / 降级），
// 但过去只有工具卡能开它（ui/toolcards.ts 的 openPreview）。本遍把那扇门接到正文上。
//
// ★ 为什么不另写正则（复盘 §1.4：同一个判定抄三遍必漏一处）：
//   「什么算文件路径」的唯一真源是 ui/preview/detect.ts 的 detectFromText 与它内部
//   共用的 looksLikePath（URL 一律不算、必须命中已知扩展名、裸词要属文档类…）。
//   本遍只调它，不复制任何一条判定：
//     · 内联 code 节点（markdown 行内反引号的渲染结果）→ 还原成 code-span 源形态；
//     · 文本节点（「文件：x」句式）→ 直接 detectFromText(node.data)。
//   于是「正文里可点的东西」与「工具卡认得的文件」永远是同一个答案。
//
// ★ 为什么委托宿主是 document.body，而不是传进来的 container（本遍最重要的发现）：
//   registry 的合同说 enhance(container) 收到的是「包住目标的容器」。这句话在
//   **重放/重置**路径上成立（assistant.ts:190 传 view.content），但在**流式**路径上
//   不成立 —— assistant.ts:103-108 的 runEnhancersOnFragment 会把本 tick 的新节点搬进
//   一个**临时 div**、对它跑增强、再把子节点搬回 fragment 插入正文。于是：
//     · 挂在该 div 上的监听随 div 一起被丢弃（节点搬走了，监听不跟着走）；
//     · 打在该 div 上的 dataset 标记同样被丢弃。
//   实测（W2013 探针，见报告）：把监听挂在传入容器上，点击正文节点 hits=[] —— 死的。
//   而流式恰恰是本遍最需要覆盖的路径。节点身份在搬移中保持不变（这正是 hljs 的
//   innerHTML 写回、code-copy 的 .code-wrap 包裹能活下来的原因），但**容器不是**。
//   所以：委托宿主必须是**比节点活得久**的那个元素 ⇒ document.body。
//   代价与对策：body 级监听是全局的，因此处理器自己重新判定作用域（见 SCOPE_SELECTOR）
//   与「插件是否仍注册」（见 enhancerIds 门），不依赖任何闭包里的容器引用。
//
// ★ 为什么不抢外链（detect.ts:11 的既有口径，必须保住）—— 两道彼此独立的守卫：
//   ① 锚点一律放行：marked 渲染的外链/站内链接都是 a[href]，浏览器按原语义处理。
//      这一条是必要的：markdown 的 [docs/readme.md](/some/url) 渲染出的锚点**正文**
//      恰好是一个合法路径，只靠判定拦不住它。
//   ② 判定只走 detectFromText / looksLikePath，它对 http(s)/file 等 scheme 一律返回空
//      ⇒ 不以锚点形态出现的 URL（例如正文里裸写的 https://…/a.ts）也不会被拦下。
//
// ★ 幂等：标记打在**委托宿主**上（dataset.fileLinkDone），沿用 builtin.ts 的
//   dataset.hlDone 范例 —— 同一个宿主只挂一次监听。宿主是 body（活得比任何容器都久），
//   所以「流式每节拍重跑整条链」不会重复挂。
//
// 铁律（FRONTEND-RULES）：本遍不重建任何节点、不写 innerHTML、不 replaceChildren，
//   只挂一个委托监听 ⇒ 铁律 1/2/4/5 均不适用（没有可违反的动作）。
// ============================================================================
import { joinPath } from "../fs-path";
import { workspacePath } from "../commands/files";
import { detectFromText, type PreviewCandidate } from "../preview/detect";
import { openFilePreview } from "../workbench/files-open";
import { enhancerIds, type Enhancer } from "./registry";

/** 登记表 / 设置页 / 测试共用的身份。 */
export const FILE_LINK_ID = "builtin.fileLink";

/**
 * 顺序键：**必须晚于 ORDER_HLJS=10 与 ORDER_MATH=20**（见 builtin.ts:30-31）。
 *
 * 本遍只读文本、不依赖前两遍的产物；排在它们之后是**声明式**的理由：内置两遍是
 * 基础设施（过去写死在渲染管线里），后加的可选遍不该插到它们中间。而「关掉再打开
 * = 注销 + 重新注册」必然把本遍排到当时已注册的其它遍之后 —— 只有 order 常量能
 * 保证相对顺序不随注册时机漂移（这正是 W9108 引入 order 的原因）。
 */
export const ORDER_FILE_LINK = 30;

/** 委托宿主上的幂等标记（照 builtin.ts 的 dataset.hlDone 范例）。 */
const DONE = "fileLinkDone";

/**
 * 只处理**消息正文**：ui/messages/user.ts:66 与 ui/messages/assistant.ts:365 都用
 * "content rendered" 建正文容器。
 *
 * 为什么必须自己判定：委托宿主是 body，事件来自整个文档。预览面板自己的正文是
 * "preview-body rendered"，不匹配本选择器 ⇒ 在预览里点路径不会递归开新预览；
 * 代码块（pre > code）也在下面被显式跳过 —— 代码块是拿来复制的，不是拿来点的。
 */
const SCOPE_SELECTOR = ".content.rendered";

/** 一个「正文里的文件路径可点开预览」的增强遍（工厂：幂等，可反复调用）。 */
export function fileLinkEnhancer(): Enhancer {
  return { id: FILE_LINK_ID, order: ORDER_FILE_LINK, enhance: applyFileLinks };
}

/**
 * 幂等：委托宿主上只挂**一次**监听（流式每节拍都会重跑整条链）。
 *
 * 宿主取 ownerDocument.body，**不是**传进来的 container —— 理由见文件头
 * 「为什么委托宿主是 document.body」。标记打在宿主上而不是每个可点节点上：
 * 本遍因此零逐节点 DOM 写入（不改结构、不加 class、不加属性）。
 */
function applyFileLinks(container: Element): void {
  const host = delegationHost(container);
  if (host === null || host.dataset[DONE] === "1") return;
  host.dataset[DONE] = "1";
  host.addEventListener("click", onDelegatedClick);
}

/** 委托宿主：比任何正文节点活得久的那个元素（见文件头）。 */
function delegationHost(container: Element): HTMLElement | null {
  const doc = container.ownerDocument;
  return doc === null ? null : doc.body ?? doc.documentElement;
}

/**
 * 委托处理器：把点击点归一到一个**路径文本**，再交给已有的预览面板。
 *
 * 处理器不持有任何容器引用 —— 每次点击都从事件本身重新判定作用域、路径与目标。
 * 这既是「节点在 fragment 与正文之间搬来搬去」的解，也是「宿主比插件活得久」的解。
 */
function onDelegatedClick(ev: MouseEvent): void {
  // 插件被关掉时监听仍在（它挂在 body 上，注销器够不到它）⇒ 以注册表为唯一真源。
  if (!enhancerIds().includes(FILE_LINK_ID)) return;
  const target = ev.target;
  if (!isElement(target)) return;
  const scope = target.closest(SCOPE_SELECTOR);
  if (scope === null) return;
  // 外链守卫①：锚点（markdown 链接的渲染结果）一律交给浏览器，不抢默认行为。
  if (target.closest("a[href]") !== null) return;
  const hit = candidateAt(target, ev);
  if (hit === null) return;
  const abs = resolveTarget(hit.path);
  if (abs === null) return;
  ev.preventDefault();
  openFilePreview(abs);
}

/** 事件目标 → Element（用 nodeType 判定：跨文档/跨 window 也成立）。 */
function isElement(node: EventTarget | null): node is Element {
  return node !== null && (node as Node).nodeType === 1;
}

/**
 * 点击目标 → 一个路径候选（判定全部来自 detect.ts，本文件**零正则**）。
 *
 * 归一顺序与 detect.ts 的形态一一对应：
 *   · 内联 code（行内反引号形态）优先 —— 边界由 DOM 直接给出，最明确；
 *   · 否则看点击落点所在的文本节点（「文件：x」句式）。
 */
function candidateAt(target: Element, ev: MouseEvent): PreviewCandidate | null {
  // 代码块整个跳过：它是拿来复制的，不是拿来点的。必须在 code 分支**之前**返回 ——
  // 否则会掉进下面的文本分支，把 pre 里的 "a/b.ts" 当成正文里的路径（真 bug，
  // 由 tests 的 ⑦ 号用例抓到）。
  if (target.closest("pre") !== null) return null;
  const code = target.closest("code");
  if (code !== null) return candidatesOfCode(code)[0] ?? null;
  const point = clickPoint(target, ev);
  if (point === null) return null;
  const list = detectFromText(point.node.data);
  if (list.length === 0) return null;
  // 只有一个候选 ⇒ 就是它；多个 ⇒ 必须用落点偏移挑，绝不猜（猜错会打开错的文件）。
  if (list.length === 1) return list[0] ?? null;
  return candidateAtOffset(point.node.data, list, point.offset);
}

/**
 * 内联代码节点的候选：把内容还原成 code-span 的**源形态**再交给 detectFromText。
 *
 * 为什么可以这样还原：DOM 里 code 的主要来源就是 markdown 的行内反引号，所以
 * 「节点类型 = 形态」由构造保证。本函数只负责把内容送回那条**已存在**的判定，
 * 而不是重写一条「看起来差不多」的。含反引号的内容还原不忠实 ⇒ 直接放弃
 * （那种文本本来也不是路径）。
 */
function candidatesOfCode(code: Element): PreviewCandidate[] {
  const text = code.textContent ?? "";
  if (text === "" || text.includes("`")) return [];
  return detectFromText("`" + text + "`");
}

/** 一个文本节点 + 点击落点在该节点内的字符偏移（取不到偏移 ⇒ null）。 */
interface TextPoint {
  node: Text;
  offset: number | null;
}

/**
 * 真机取 caret 的两个 API（各引擎实现不同）。
 *
 * 为什么用 Partial + 断言而不是 interface extends Document：lib.dom 已经声明了这两个
 * 方法，而 jsdom 与旧引擎**运行时**没有 —— 接口继承会与库声明冲突（TS2430），
 * Partial 则如实表达「类型上有、运行时可能没有」，调用点用 ?. 兜住。
 */
interface CaretApi {
  caretRangeFromPoint(x: number, y: number): Range | null;
  caretPositionFromPoint(x: number, y: number): CaretPosition | null;
}

/**
 * 点击落在哪个文本节点、哪个字符上。
 *
 * 真机走 caretRangeFromPoint（浏览器自己的排版与字符边界，与正文同源）；
 * 取不到（jsdom / 旧引擎）时退化为「目标元素里的第一个文本节点」并把偏移留空 ——
 * 那时只有单候选的形态会被处理，多候选一律放弃（**静默不处理比误判安全**）。
 */
function clickPoint(target: Element, ev: MouseEvent): TextPoint | null {
  const doc = target.ownerDocument;
  const api = doc === null ? null : (doc as unknown as Partial<CaretApi>);
  const range = api?.caretRangeFromPoint?.(ev.clientX, ev.clientY) ?? null;
  const pos = api?.caretPositionFromPoint?.(ev.clientX, ev.clientY) ?? null;
  const node: Node | null = range?.startContainer ?? pos?.offsetNode ?? null;
  // isConnected：caret API 可能返回别的文档里的节点，那种节点不属于本次点击。
  if (node !== null && node.nodeType === 3 && node.isConnected) {
    const offset = range === null ? (pos === null ? null : pos.offset) : range.startOffset;
    return { node: node as Text, offset };
  }
  const fallback = firstTextNode(target);
  return fallback === null ? null : { node: fallback, offset: null };
}

/** 元素子树里的第一个非空文本节点（深度优先，与文档序一致）。 */
function firstTextNode(el: Element): Text | null {
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3) {
      if ((n.textContent ?? "") !== "") return n as Text;
      continue;
    }
    const deep = n.nodeType === 1 ? firstTextNode(n as Element) : null;
    if (deep !== null) return deep;
  }
  return null;
}

/**
 * 多候选时按落点偏移挑出被点中的那一个。
 *
 * 只用 indexOf 在**已由 detectFromText 给出的**路径上定位 —— 不再跑任何新的匹配，
 * 否则「哪个子串算路径」就又有了第二份口径。偏移落在某个路径的字符区间内即命中。
 */
function candidateAtOffset(data: string, list: readonly PreviewCandidate[], offset: number | null): PreviewCandidate | null {
  if (offset === null) return null;
  for (const c of list) {
    const i = data.indexOf(c.path);
    if (i >= 0 && offset >= i && offset <= i + c.path.length) return c;
  }
  return null;
}

/**
 * 候选路径 → 可打开的**绝对**路径（服务端 GET /api/fs/read 只收绝对路径）。
 *
 * 已是绝对路径（POSIX / 盘符 / UNC）就原样；相对路径拼当前工作区根；根未知 ⇒ null
 * （宁可不打开，也不去猜一个可能不存在的绝对路径 —— 猜错会弹一个读不出来的面板）。
 */
export function resolveTarget(path: string): string | null {
  if (path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  const root = workspacePath();
  return root === "" ? null : joinPath(root, path);
}
