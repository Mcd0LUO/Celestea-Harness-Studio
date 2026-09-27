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
// ★ 为什么委托宿主是 document.body，而不是传进来的 container（W2013 最重要的发现）：
//   registry 的合同说 enhance(container) 收到的是「包住目标的容器」。这句话在
//   **重放/重置**路径上成立（assistant.ts:190 传 view.content），但在**流式**路径上
//   不成立 —— assistant.ts:103-108 的 runEnhancersOnFragment 会把本 tick 的新节点搬进
//   一个**临时 div**、对它跑增强、再把子节点搬回 fragment 插入正文。于是：
//     · 挂在该 div 上的监听随 div 一起被丢弃（节点搬走了，监听不跟着走）；
//     · 打在该 div 上的 dataset 标记同样被丢弃。
//   实测（W2013 探针）：把监听挂在传入容器上，点击正文节点 hits=[] —— 死的。
//   节点身份在搬移中保持不变（这正是 hljs 的 innerHTML 写回、code-copy 的 .code-wrap
//   包裹能活下来的原因），但**容器不是**。所以委托宿主取 document.body。
//   代价与对策：body 级监听是全局的，处理器自己重新判定作用域与注册状态。
//
// ★ 为什么不抢外链（detect.ts 的既有口径）—— 两道彼此独立的守卫：
//   ① 锚点一律放行：markdown 的 [docs/readme.md](/some/url) 渲染出的锚点**正文**
//      恰好是一个合法路径，只靠判定拦不住它。
//   ② 判定只走 detectFromText / looksLikePath，它对 http(s)/file 等 scheme 一律返回空。
//
// ★ 幂等：标记打在**委托宿主**上（dataset.fileLinkDone），沿用 builtin.ts 的
//   dataset.hlDone 范例。宿主是 body（活得比任何容器都久），所以流式每节拍重跑
//   整条链不会重复挂。
//
// ★★ W2025（键盘等效路径）—— 本遍原先只有 click 委托，键盘用户够不到正文里的路径。
//   真机实测（CDP，隔离实例）：正文行内 code 是 tabIndex === -1，focus() 之后
//   document.activeElement 不变 ⇒ **无法聚焦 ⇒ 无法用 Enter/Space 触发**。
//   工具卡上的 .toolcard-preview 是 button（键盘可达），但它的条件是
//   PREVIEW_CONTENT_TOOLS.has(name)，而那张表只有 'read_file'（preview/detect.ts:51）
//   ⇒ 它覆盖的是「工具卡认得的文件」，不覆盖「模型在正文里提到的任意路径」。
//   缺口因此是真的：同一个功能，指针可达、键盘不可达。
//
//   修法（两件事，各自独立）：
//     ① **渲染期**给命中节点补上 tabindex / role=button / title，并保证一个正文容器
//        同一时刻只有一个 Tab 停靠点 —— 见 file-link-mark.ts（含与 W2013 纪律的关系）；
//     ② **事件期**加一个 Enter/Space 的委托 keydown，与 click 走**同一个出口**
//        （resolveTarget + openFilePreview），口径不可能分叉。
//   鼠标行为一字不动：click 仍是**原来那个**处理器，defaultPrevented 与打开结果不变。
// ============================================================================
import { joinPath } from "../fs-path";
import { workspacePath } from "../commands/files";
import { openFilePreview } from "../workbench/files-open";
import { candidateAt } from "./file-link-caret";
import { HIT_SEL, PATH_ATTR, SCOPE_SELECTOR, applyStops, hitOf, markScope, moveStop, releaseStop } from "./file-link-mark";
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

/** 只处理**消息正文**（唯一真源在 file-link-mark.ts，这里转出去给测试与调用方用）。 */
export { SCOPE_SELECTOR };

/** 键盘语义：与原生 button 一致（Enter / Space）。 */
const ACTIVATE_KEYS: ReadonlySet<string> = new Set(["Enter", " "]);

/** 一个「正文里的文件路径可点开预览」的增强遍（工厂：幂等，可反复调用）。 */
export function fileLinkEnhancer(): Enhancer {
  return { id: FILE_LINK_ID, order: ORDER_FILE_LINK, enhance: applyFileLinks };
}

/**
 * 幂等：委托宿主上只挂**一次**监听（流式每节拍都会重跑整条链）。
 *
 * 宿主取 ownerDocument.body，**不是**传进来的 container —— 理由见文件头。
 * 五个监听全是委托：click / keydown 是功能本体；focusin / focusout / mouseover
 * 只为「Tab 停靠点移交」服务（见 file-link-mark.ts 的 applyStops）。
 */
function applyFileLinks(container: Element): void {
  const host = delegationHost(container);
  if (host === null) return;
  if (host.dataset[DONE] !== "1") {
    host.dataset[DONE] = "1";
    host.addEventListener("click", onDelegatedClick);
    host.addEventListener("keydown", onDelegatedKeydown);
    host.addEventListener("focusin", onFocusIn);
    host.addEventListener("focusout", onFocusOut);
    host.addEventListener("mouseover", onHover);
    observeInsertions(host.ownerDocument);
  }
  // 渲染期写入：属性只有在**渲染时**就落在 DOM 上，Tab 才够得到它（见文件头 W2025）。
  markScope(container);
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
  const hit = candidateAt(target, ev, markedPath(target));
  if (hit === null) return;
  const abs = resolveTarget(hit.path);
  if (abs === null) return;
  ev.preventDefault();
  openFilePreview(abs);
}

/**
 * W2025 委托键盘处理器：Enter/Space 打开预览 —— 与点击**同一个出口**
 * （resolveTarget + openFilePreview），所以「什么算路径」「打不开就不开」的口径
 * 不可能分叉。
 *
 * 只认**命中节点自己**收到的事件：正文里的其它控件（复制按钮、csv 表头、图片灯箱）
 * 有自己的键盘语义，本遍不抢。Space 必须 preventDefault（否则页面会滚一屏）。
 */
function onDelegatedKeydown(ev: KeyboardEvent): void {
  if (!enhancerIds().includes(FILE_LINK_ID)) return;
  if (!ACTIVATE_KEYS.has(ev.key)) return;
  const target = ev.target;
  if (!isElement(target) || target.closest(SCOPE_SELECTOR) === null) return;
  const hit = hitOf(target);
  if (hit === null) return;
  const abs = resolveTarget(hit.getAttribute(PATH_ATTR) ?? "");
  if (abs === null) return;
  ev.preventDefault();
  openFilePreview(abs);
}

/** 命中节点上存着的路径（没打标记 ⇒ null，交给 candidateAt 走 W2013 的判定）。 */
function markedPath(target: Element): string | null {
  const hit = hitOf(target);
  return hit === null ? null : hit.getAttribute(PATH_ATTR);
}

/** 事件目标 → Element（用 nodeType 判定：跨文档/跨 window 也成立）。 */
function isElement(node: EventTarget | null): node is Element {
  return node !== null && (node as Node).nodeType === 1;
}

/** 焦点进来时把停靠点落到真正拿到焦点的那个命中上（多 pane 并存时不串台）。 */
function onFocusIn(ev: FocusEvent): void {
  moveStop(ev.target);
}
/** 焦点离开停靠点 ⇒ 交给下一个，Tab 继续走（不是把整段路径变成死胡同）。 */
function onFocusOut(ev: FocusEvent): void {
  releaseStop(ev.target);
}
/** 鼠标悬停也移交停靠点：先动鼠标再按 Tab 的用户，落点与视觉焦点一致。 */
function onHover(ev: MouseEvent): void {
  moveStop(ev.target);
}

// ---------------------------------------------------------------------------
// W2025 · 流式路径的补画（渲染期写入做不到，必须观察插入）
// ---------------------------------------------------------------------------

/** 观察器单例（每个 document 一个）。 */
const observed = new WeakSet<Document>();

/**
 * 为什么必须有观察器：流式路径上 enhance 收到的容器是一个**临时 div**（见文件头），
 * 它此刻不在正文里 ⇒ markScope 的作用域判定（closest）必然为空，画不上属性。
 * 而 tabindex 必须在渲染时就位（见文件头），所以只能等节点真的进了正文再补画一次。
 *
 * 代价：body 级 childList 观察（subtree: true，但回调只处理**本 tick 新增的节点**，
 * 不做全量重扫 —— 与 W9229 收窄增强作用域的动机一致）。
 */
function observeInsertions(doc: Document): void {
  if (observed.has(doc) || doc.body === null) return;
  observed.add(doc);
  new MutationObserver((records) => {
    if (!enhancerIds().includes(FILE_LINK_ID)) return;
    for (const r of records) {
      for (const n of Array.from(r.addedNodes)) {
        if (n.nodeType === 1) markScope(n as Element);
      }
    }
  }).observe(doc.body, { childList: true, subtree: true });
}

/**
 * 候选路径 → 可打开的**绝对**路径（服务端 GET /api/fs/read 只收绝对路径）。
 *
 * 已是绝对路径（POSIX / 盘符 / UNC）就原样；相对路径拼当前工作区根；根未知 ⇒ null
 * （宁可不打开，也不去猜一个可能不存在的绝对路径 —— 猜错会弹一个读不出来的面板）。
 */
export function resolveTarget(path: string): string | null {
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\/]/.test(path)) return path;
  const root = workspacePath();
  return root === "" ? null : joinPath(root, path);
}

/** 停靠点重算（调用方在正文容器变化后重挑一个；正文没命中时是 no-op）。 */
export function refreshStops(scope: Element): void {
  const box = scope.closest(SCOPE_SELECTOR);
  if (box !== null && box.querySelector(HIT_SEL) !== null) applyStops(box);
}
