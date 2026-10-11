/**
 * tests/lib/dom-tree.ts — 工具树形状助手（真 jsdom）。
 *
 * 历史（W9395）：这些判定原先住在 tests/lib/w1467-dom.ts 的**手搓最小 DOM 垫片**里，
 * 依赖自实现的 El（只有 parentNode、matches 不认祖先链、textContent 不拼子节点）。
 * W9395 把 6 个使用垫片的门禁全部迁到真 jsdom（`// @vitest-environment jsdom`），
 * 垫片与 `bundleFrontend` 一并删除，树形状判定搬到本文件并按真 DOM 语义重写：
 *   · 元素子节点一律走 `children`（真 DOM 的 `childNodes` 含文本节点）；
 *   · `textContent` 由真 DOM 递归拼接，不再需要手写递归（[textOf] 因此是一层皮）；
 *   · `depthOf` 走 `parentElement`（真 DOM 有它；垫片只有 `parentNode`）。
 *
 * 本文件只放机制，不放断言 —— 断言全部留在 `*.test.ts` 里。
 */
import { doc, type ClassList } from "./w795-dom.js";

/**
 * 真 DOM 元素的最小结构面（根 tsconfig 的 lib 只有 ES2023，没有 DOM，
 * 所以这里按 w795-dom.ts 的口径自己声明；成员按本目录测试真正用到的收）。
 *
 * 注意：`children` / `childNodes` / `querySelectorAll` 在真 DOM 里返回的是
 * HTMLCollection / NodeList（可迭代但**没有数组方法**）。这里为了书写方便标成数组，
 * 取数组方法时**必须**先 `Array.from`（本文件与各测试都遵守这条）。
 */
export interface DomEl {
  tagName: string;
  id: string;
  className: string;
  textContent: string | null;
  title: string;
  type: string;
  value: string;
  disabled: boolean;
  hidden: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  style: Record<string, unknown>;
  dataset: Record<string, string | undefined>;
  classList: ClassList;
  childNodes: DomEl[];
  children: DomEl[];
  firstChild: DomEl | null;
  parentNode: DomEl | null;
  parentElement: DomEl | null;
  nextElementSibling: DomEl | null;
  isConnected: boolean;
  appendChild(n: DomEl): DomEl;
  insertBefore(n: DomEl, ref: DomEl | null): DomEl;
  replaceChildren(...n: DomEl[]): void;
  remove(): void;
  click(): void;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  addEventListener(t: string, f: (e: unknown) => void): void;
  dispatchEvent(e: unknown): boolean;
  contains(n: unknown): boolean;
  querySelector(sel: string): DomEl | null;
  querySelectorAll(sel: string): DomEl[];
}

/** 建一个真 DOM 元素（经共用夹具的 document，保持单一入口）。 */
export const domEl = (tag: string): DomEl => doc.createElement(tag) as unknown as DomEl;

/** 直接子元素里带该 class 的第一个（null = 无）。 */
export const child = (node: DomEl | null | undefined, cls: string): DomEl | null => {
  if (!node) return null;
  for (const c of Array.from(node.children)) if (c.classList.contains(cls)) return c;
  return null;
};

/** 后代里带该 class 的第一个（真 DOM 的 querySelector，文档序与手写 DFS 一致）。 */
export const deep = (node: DomEl | null | undefined, cls: string): DomEl | null =>
  node ? node.querySelector("." + cls) : null;

/** 节点子树的全部文本。真 DOM 的 textContent 本就递归拼接（垫片时代要手写）。 */
export const textOf = (n: DomEl | null | undefined): string => n?.textContent ?? "";

/**
 * 结构 class 白名单：决定「这棵树长什么样」的类。
 *
 * 刻意**排除**状态类（running / ok / err / has / streaming …）：live 与 replay 在
 * 这些位上本来就不同 —— 实时的卡还没结果（running），恢复的卡已经是终态
 * （ok / noResult）。本门禁比的是**树的形状**，把状态一起比会把「结构正确」淹没在
 * 「状态必然不同」的噪声里。状态本身由各自的门禁覆盖。
 */
const STRUCTURAL_CLASSES = new Set([
  "mcol", "msg", "tool", "bubble", "toolcard", "toolcard-subs",
  "toolcard-body", "toolcard-head", "toolcard-row1", "content",
  "msg-caption", "toolcard-args-preview", "toolcard-result-preview",
  "tool-args", "tool-out", "step-tag", "toolcard-name", "toolcard-state",
  "toolcard-copy", "toolcard-fold", "ts-dot", "ts-label", "who", "live-sep",
  "attach-grid", "toolcard-preview",
]);

/**
 * **工具树骨架**：只走决定「谁缩进在谁之下」的节点
 * （`.mcol` / `.msg.tool` / `.toolcard` / `.toolcard-subs`），
 * 忽略结果正文、状态类、以及恢复路径特有的分隔线。
 *
 * 为什么门禁比的是它而不是整棵树：live 抓的是「结果还没回来」的时刻，replay 的
 * 行里结果已经在了 —— 内容必然不同，而本仓要求一致的是**结构**（子调用缩进在
 * 哪个父项之下）。比整棵树会把「结构对」淹没在「内容本来就不同」里。
 */
export function treeSkeleton(n: DomEl): string {
  const isCard =
    n.classList.contains("mcol") ||
    n.classList.contains("toolcard") ||
    n.classList.contains("toolcard-subs");
  const inner = Array.from(n.children)
    .map(treeSkeleton)
    .filter((s) => s !== "")
    .join(",");
  if (!isCard) return inner; // 非骨架节点：透明穿透，只把下面的骨架提上来
  const name = n.classList.contains("mcol") ? "mcol" : n.classList.contains("toolcard") ? "card" : "subs";
  return name + (inner === "" ? "" : "[" + inner + "]");
}

/** 整棵子树的「标签 + 结构 class」形状（忽略文案、属性与状态类）。 */
export function shapeOf(n: DomEl): string {
  const cls = String(n.className || "")
    .trim()
    .split(/\s+/)
    .filter((s) => STRUCTURAL_CLASSES.has(s))
    .sort()
    .join(".");
  const head = cls === "" ? n.tagName.toLowerCase() : n.tagName.toLowerCase() + "." + cls;
  const kids = Array.from(n.children);
  return kids.length === 0 ? head : head + "[" + kids.map(shapeOf).join(",") + "]";
}

/** 子项相对父项的缩进层数（0 = 顶层平铺）。 */
export function depthOf(node: DomEl): number {
  let d = 0;
  for (let p = node.parentElement; p !== null; p = p.parentElement) {
    if (p.classList.contains("toolcard-subs")) d += 1;
  }
  return d;
}

/** 子树里每张工具卡的缩进层数（文档序）。 */
export function depthOfCards(root: DomEl): number[] {
  return Array.from(root.querySelectorAll(".toolcard")).map(depthOf);
}
