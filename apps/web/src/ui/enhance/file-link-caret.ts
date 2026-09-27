// ============================================================================
// ui/enhance/file-link-caret.ts — W2013 的「点击落点 ⇒ 路径候选」助手（纯函数）。
// ----------------------------------------------------------------------------
// 从 file-link.ts 拆出来（W2025）：给正文路径补上键盘通道之后，那个文件会同时装
// 「委托 / 渲染期写入 / 落点判定」三件事，越过单文件行数上限。这里只留**落点判定**，
// 逻辑一行没改 —— 拆分的唯一目的是行数，不是行为。
//
// 依赖方向：只 import ui/preview/detect.ts（判定真源），不 import 两个兄弟模块
// ⇒ 不成环（file-link.ts ← file-link-mark.ts ← 本文件）。
// ============================================================================
import { classifyByPath, detectFromText, type PreviewCandidate } from "../preview/detect";

/**
 * 点击目标 → 一个路径候选（判定全部来自 detect.ts，本文件**零正则**）。
 *
 * 归一顺序与 detect.ts 的形态一一对应：
 *   · 已打标记的命中（渲染期算过一遍，路径存在属性里）→ 直接用标记里的路径；
 *   · 内联 code（行内反引号形态）→ 边界由 DOM 直接给出，最明确；
 *   · 否则看点击落点所在的文本节点（「文件：x」句式）。
 *
 * ★ marked（W2025）：渲染期已经把候选算过一遍并写在节点属性上。用它有两个好处 ——
 *   ① paint 与 click 用**同一个答案**，不可能出现「画成可点但点了没反应」；
 *   ② 文本节点被切段之后（见 file-link-mark.ts 的 markLabel），节点级偏移不再等于
 *      原文本偏移，靠标记可以直接绕开那次坐标换算。
 */
export function candidateAt(
  target: Element,
  ev: MouseEvent,
  marked: string | null,
): PreviewCandidate | null {
  if (marked !== null) {
    return marked === "" ? null : { path: marked, kind: classifyByPath(marked), source: "code-span" };
  }
  // 代码块整个跳过：它是拿来复制的，不是拿来点的。必须在 code 分支**之前**返回 ——
  // 否则会掉进下面的文本分支，把 pre 里的 "a/b.ts" 当成正文里的路径（真 bug，
  // 由 file-link.test.ts 的 ⑦ 号用例抓到）。
  if (target.closest("pre") !== null) return null;
  const code = target.closest("code");
  if (code !== null) return candidatesOfCode(code)[0] ?? null;
  const point = clickPoint(target, ev);
  if (point === null) return null;
  // ★ W2025：元素里若有命中节点，说明这段文本被 markLabel 切过段 —— 那时
  //   「节点级偏移」与「元素级偏移」不再是同一个坐标。用**元素全文**（切段前后
  //   逐字相同）与换算后的元素级偏移，把判定拉回 W2013 的原坐标，
  //   于是「点在这段文字的任意位置」的行为与改动前**逐字一致**。
  const split = target.querySelector("[data-fl-hit]") !== null;
  const data = split ? (target.textContent ?? "") : point.node.data;
  const offset = split ? elementOffset(target, point.node, point.offset) : point.offset;
  const list = detectFromText(data);
  if (list.length === 0) return null;
  // 只有一个候选 ⇒ 就是它；多个 ⇒ 必须用落点偏移挑，绝不猜（猜错会打开错的文件）。
  if (list.length === 1) return list[0] ?? null;
  return candidateAtOffset(data, list, offset);
}

/**
 * 内联代码节点的候选：把内容还原成 code-span 的**源形态**再交给 detectFromText。
 *
 * 为什么可以这样还原：DOM 里 code 的主要来源就是 markdown 的行内反引号，所以
 * 「节点类型 = 形态」由构造保证。本函数只负责把内容送回那条**已存在**的判定，
 * 而不是重写一条「看起来差不多」的。含反引号的内容还原不忠实 ⇒ 直接放弃
 * （那种文本本来也不是路径）。
 */
export function candidatesOfCode(code: Element): PreviewCandidate[] {
  const text = code.textContent ?? "";
  if (text === "" || text.includes("`")) return [];
  return detectFromText("`" + text + "`");
}

/** 一个文本节点 + 点击落点在该节点内的字符偏移（取不到偏移 ⇒ null）。 */
export interface TextPoint {
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
export function firstTextNode(el: Element): Text | null {
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
 * 元素内某个文本节点的**节点级偏移** → **元素级偏移**（切段之前的原坐标）。
 *
 * 找不到那个节点（caret API 给了别的子树 / 偏移未知）⇒ null：调用方据此退回
 * 「只有单候选才处理」的安全口径，绝不猜一个偏移（猜错会打开错的文件）。
 */
export function elementOffset(root: Element, node: Text, local: number | null): number | null {
  if (local === null) return null;
  let seen = 0;
  let found: number | null = null;
  const walk = (el: Element): boolean => {
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3) {
        if (n === node) {
          found = seen + local;
          return true;
        }
        seen += (n.textContent ?? "").length;
        continue;
      }
      if (n.nodeType === 1 && walk(n as Element)) return true;
    }
    return false;
  };
  return walk(root) ? found : null;
}

/**
 * 多候选时按落点偏移挑出被点中的那一个。
 *
 * 只用 indexOf 在**已由 detectFromText 给出的**路径上定位 —— 不再跑任何新的匹配，
 * 否则「哪个子串算路径」就又有了第二份口径。偏移落在某个路径的字符区间内即命中。
 */
export function candidateAtOffset(
  data: string,
  list: readonly PreviewCandidate[],
  offset: number | null,
): PreviewCandidate | null {
  if (offset === null) return null;
  for (const c of list) {
    const i = data.indexOf(c.path);
    if (i >= 0 && offset >= i && offset <= i + c.path.length) return c;
  }
  return null;
}
