// ============================================================================
// ui/enhance/file-link-mark.ts — W2025：把**可点路径**补成键盘可达的控件。
// ----------------------------------------------------------------------------
// 问题（真机实测，CDP）：正文里的行内 code 是 tabIndex === -1，focus() 之后
// document.activeElement 不变 ⇒ 键盘用户**够不到**它 ⇒ 无法用 Enter/Space 触发。
// 工具卡上的 .toolcard-preview 是 button（键盘可达），但它的条件是
// PREVIEW_CONTENT_TOOLS.has(name)，而那张表只有 'read_file'（preview/detect.ts:51）
// ⇒ 它覆盖「工具卡认得的文件」，不覆盖「模型在正文里提到的任意路径」。
// 所以缺口是真的：同一个功能，指针可达、键盘不可达。
//
// 本模块只做**渲染期写入**：给命中节点打标记、并分配**唯一**的 Tab 停靠点。
// 打开动作（click / Enter / Space）在 file-link.ts 的委托里，本模块不碰事件。
//
// ★ 与 W2013 的「零逐节点 DOM 写入」冲突吗？——不冲突，理由要分清：
//   W2013 那条纪律的**理由**是流式（容器每个节拍被换掉、打在上面的标记会被丢弃）。
//   属性写在**节点**上，而节点身份在搬移中不变 ⇒ 与 hljs 的 innerHTML 写回、
//   code-copy 的 .code-wrap 包裹**同一条**既有理由。它确实是一次结构写入，但落在
//   节点而非容器上。而且 tabindex 只能在渲染时写（事件到达时补写 = 第一次 Tab
//   到不了它，等于没修），所以这里必须有一次真实的渲染期写入 —— 本遍唯一无法
//   回避的取舍，已在报告里如实登记。
//
// ★ 平衡 Tab 序列（tab stop pollution）：一条消息可能有 20 个可点路径，全给
//   tabindex=0 就是 20 个停靠点。做法是**一个正文容器同一时刻只留一个停靠点**：
//   paint 时只让第一个命中进序列，焦点/鼠标一动就把停靠点交给下一个。
//   Tab 序列长度因此与消息里路径的个数无关（真机实测对比见报告）。
// ============================================================================
import { t } from "../../i18n";
import { detectFromText } from "../preview/detect";
import { candidatesOfCode } from "./file-link-caret";

/** 只处理**消息正文**（与 file-link.ts 的 SCOPE_SELECTOR 同一个口径）。 */
export const SCOPE_SELECTOR = ".content.rendered";

/** 命中标记（选择器用）与命中携带的路径（值）。两个属性分开，避免值里有空格时选择器要转义。 */
export const HIT_ATTR = "data-fl-hit";
export const PATH_ATTR = "data-fl-path";
/** 文本节点分支包出来的包装元素。 */
const LABEL_CLASS = "file-link-label";
const LABEL_DONE = "flLabel";

/** 命中节点选择器（所有用到它的地方都走这里，绝不手写第二份）。 */
export const HIT_SEL = "[" + HIT_ATTR + '="1"]';
/** 当前停靠点。 */
export const STOP_SEL = HIT_SEL + '[tabindex="0"]';

/**
 * 给一段作用域里**所有可点路径**打上命中标记，并挑出唯一的 Tab 停靠点。
 *
 * 幂等：节点已带标记就跳过 —— 流式每节拍都会走到这里。
 * 作用域必须**已经在正文里**：临时 div 上画不出来（closest 判定为空），
 * 那条路径由 file-link.ts 的观察器补画。
 *
 * ★ 三种形态都要认（W2025 真机抓到的真 bug）：调用方给的 scope 可能是
 *   ① 正文容器**本身**；② 正文**内部**的一段新节点（流式补画）；
 *   ③ 正文的**祖先**。历史恢复路径一次 replaceChildren 把整列搬进正文容器，
 *   观察器看到的是 .mcol（正文是它的**后代**）—— 第一版只认 ②，于是刷新页面后
 *   正文里一个标记都没有（真机 hasHit:false 抓到的就是这个）。
 */
export function markScope(scope: Element): void {
  const self = scope.matches(SCOPE_SELECTOR) ? scope : null;
  const boxes = self !== null ? [self] : Array.from(scope.querySelectorAll(SCOPE_SELECTOR));
  if (boxes.length > 0) {
    for (const box of boxes) paintBox(box, box);
    return;
  }
  const box = scope.closest(SCOPE_SELECTOR);
  if (box !== null) paintBox(box, scope);
}

/** 在一个正文容器内、限定 scope 子树打标记，并重挑停靠点。 */
function paintBox(box: Element, scope: Element): void {
  let found = false;
  for (const el of Array.from(scope.querySelectorAll("code"))) found = markCode(el) || found;
  for (const el of textCandidates(scope)) found = markLabel(el) || found;
  // 已有停靠点且本遍没画新东西 ⇒ 什么都不写（流式稳态下零 DOM 写入）。
  if (found || box.querySelector(STOP_SEL) === null) applyStops(box);
}

/** 行内 code：还原成 code-span 源形态再判定（口径来自 detect.ts，零正则）。 */
function markCode(el: Element): boolean {
  if (el.closest("pre") !== null) return false; // 代码块是拿来复制的，不是拿来点的
  if (el.querySelector("code") !== null || el.hasAttribute(HIT_ATTR)) return false;
  const cand = candidatesOfCode(el)[0];
  if (cand === undefined) return false;
  markHit(el, cand.path);
  return true;
}

/**
 * 文本节点候选：按「元素的**直接**文本子节点」找，不按元素找。
 *
 * 为什么：markdown 的「文件：x」句式渲染出来就是一个光秃秃的文本节点，它不能聚焦，
 * 也没有任何属性可挂 —— 只能包一层 span。而包整个 p 会让同一段里的多个路径共用
 * 一个停靠点、也分不清 Enter 该开哪个，所以按 detectFromText 给出的候选区间把该
 * 文本节点**切段**：路径段包成命中节点，其余段原样留在原位（文本与顺序不变）。
 */
function textCandidates(scope: Element): Element[] {
  const out: Element[] = [];
  const walk = (el: Element): void => {
    if (el.closest("a[href]") !== null || el.closest("pre") !== null || el.closest("code") !== null) return;
    if (directTextNodes(el).length > 0) out.push(el);
    for (const c of Array.from(el.children)) walk(c);
  };
  walk(scope);
  return out;
}

/**
 * 把元素里**每一段**含路径的直接文本节点切成 [文本, 命中 span, 文本, …]。
 *
 * 为什么是「每一段」而不是「第一段」：`<p>先看 <code>a/b.ts</code> 再看 文件：c/d.ts 完</p>`
 * 里第一段直接文本是「先看 」（不含路径），含路径的那段在后面 —— 只看第一段会漏掉它
 * （单测 ⑩ 抓到）。
 *
 * 非文本子节点（例如已经命中的 code）**原样搬进新 fragment**，节点身份不变；
 * 只有文本被换成「原样的文本节点 + 路径 span」。文本内容与顺序逐字不变。
 */
function markLabel(el: Element): boolean {
  if (el.classList.contains(LABEL_CLASS) || done(el) || el.hasAttribute(HIT_ATTR)) return false;
  const plans: { node: Text; parts: Part[] }[] = [];
  for (const n of directTextNodes(el)) {
    const list = detectFromText(n.data);
    if (list.length === 0) continue;
    const parts = splitByCandidates(n.data, list);
    if (parts.length < 2) continue;
    plans.push({ node: n, parts });
  }
  if (plans.length === 0) return false;
  markDone(el);
  const doc = el.ownerDocument;
  const frag = doc.createDocumentFragment();
  for (const child of Array.from(el.childNodes)) {
    const plan = child.nodeType === 3 ? plans.find((p) => p.node === child) : undefined;
    if (plan === undefined) {
      frag.appendChild(child); // 非文本子节点：原样搬，身份不变
      continue;
    }
    for (const part of plan.parts) {
      if (part.path === null) {
        frag.appendChild(doc.createTextNode(part.text));
        continue;
      }
      const span = doc.createElement("span");
      span.className = LABEL_CLASS;
      span.textContent = part.text;
      markHit(span, part.path);
      frag.appendChild(span);
    }
  }
  el.replaceChildren(frag); // 只动这一个元素的子节点，兄弟与父级结构不变
  return true;
}

interface Part { text: string; path: string | null }

/** 按候选的字符区间切段（区间之外的原样保留；只用 indexOf 定位已给出的路径）。 */
function splitByCandidates(data: string, list: readonly { path: string }[]): Part[] {
  const spans: { at: number; end: number; path: string }[] = [];
  for (const c of list) {
    const at = data.indexOf(c.path);
    if (at >= 0) spans.push({ at, end: at + c.path.length, path: c.path });
  }
  spans.sort((a, b) => a.at - b.at);
  const out: Part[] = [];
  let cursor = 0;
  for (const s of spans) {
    if (s.at < cursor) continue;
    if (s.at > cursor) out.push({ text: data.slice(cursor, s.at), path: null });
    out.push({ text: data.slice(s.at, s.end), path: s.path });
    cursor = s.end;
  }
  if (cursor < data.length) out.push({ text: data.slice(cursor), path: null });
  return out;
}

/** 该元素是否已经处理过（标记打在元素上，流式每节拍都会重跑 ⇒ 必须幂等）。 */
function done(el: Element): boolean {
  return el instanceof HTMLElement && el.dataset[LABEL_DONE] === "1";
}

function markDone(el: Element): void {
  if (el instanceof HTMLElement) el.dataset[LABEL_DONE] = "1";
}

/** 元素的全部非空直接文本子节点（文档序）。 */
function directTextNodes(el: Element): Text[] {
  const out: Text[] = [];
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3 && (n.textContent ?? "") !== "") out.push(n as Text);
  }
  return out;
}

/**
 * 命中标记：属性写在**节点**上（节点身份跨流式搬移不变，见文件头 W2025）。
 *
 * 刻意**不设 tabindex** —— 那由 applyStops 统一分配，避免「先全设 0 再降级」的抖动，
 * 也避免碰到正文里别的可聚焦元素（图片灯箱的 img 也是 tabindex=0）。
 * role=button + title 是 WAI-ARIA 对「用 span/code 做按钮」的要求（4.1.2 Name, Role, Value）。
 */
function markHit(el: Element, path: string): void {
  el.setAttribute(HIT_ATTR, "1");
  el.setAttribute(PATH_ATTR, path);
  el.setAttribute("role", "button");
  el.setAttribute("title", t("chat.fileLink.open"));
}

/**
 * 一个正文容器同一时刻只留**一个** Tab 停靠点（见文件头「平衡 Tab 序列」）。
 *
 * 选择器一律带命中属性：正文里还有别的可聚焦元素（image-zoom 的 img[role=button]
 * 也是 tabindex=0），本遍绝不动它们。
 */
export function applyStops(box: Element): void {
  const hits = Array.from(box.querySelectorAll(HIT_SEL));
  if (hits.length === 0) return;
  const cur = box.querySelector(STOP_SEL);
  const keep = cur ?? hits[0];
  for (const el of hits) el.setAttribute("tabindex", el === keep ? "0" : "-1");
}

/** 焦点/鼠标一动 ⇒ 把停靠点交给新的那个（Tab 因此能一路走完所有可点路径）。 */
export function moveStop(target: EventTarget | null): void {
  const hit = hitOf(target);
  const box = hit === null ? null : hit.closest(SCOPE_SELECTOR);
  if (hit === null || box === null) return;
  const cur = box.querySelector(STOP_SEL);
  if (cur !== null && cur !== hit) cur.setAttribute("tabindex", "-1");
  hit.setAttribute("tabindex", "0");
}

/** 焦点离开停靠点 ⇒ 交给下一个，Tab 继续走（不是把整段路径变成死胡同）。 */
export function releaseStop(target: EventTarget | null): void {
  const t0 = hitOf(target);
  if (t0 === null || t0.getAttribute("tabindex") !== "0") return;
  const box = t0.closest(SCOPE_SELECTOR);
  if (box === null) return;
  const hits = Array.from(box.querySelectorAll(HIT_SEL));
  const i = hits.indexOf(t0);
  t0.setAttribute("tabindex", "-1");
  const next = hits[(i + 1) % hits.length];
  if (next === undefined) return;
  next.setAttribute("tabindex", "0");
}

/**
 * 事件目标 → 命中节点（没有标记 = 不是可点路径）。
 *
 * 用 closest 而不是「目标自己」：命中节点里面可能还有子元素（目前没有，但
 * markLabel 的 span 与 code 都可能被后续增强包一层 —— closest 让那不会变成 bug）。
 */
export function hitOf(target: EventTarget | null): Element | null {
  if (target === null || (target as Node).nodeType !== 1) return null;
  return (target as Element).closest(HIT_SEL);
}
