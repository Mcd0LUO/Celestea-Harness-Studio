// ============================================================================
// ui/rail-card.ts — 灵动选择条的**预览卡内容**（W872 从 rail.ts 纯搬家；W9345 对象复用）
// ----------------------------------------------------------------------------
// W790 起「悬停弹预览」是注册进 ui/hint 注册缝的一个提供者（id 'rail-preview'，
// 见 ui/rail.ts 的 railHintPlugin）：本模块只负责「取内容」——该轮消息列的首行前 40
// 字（数据全部取自已渲染消息 DOM，零请求）。
// 注册/认领/落位仍留在 ui/rail.ts（它才知道条目表、fisheye 与轨道几何；落位算式
// 的唯一真源是 ./rail-geom.ts 的 railCardPlacement，W871）。
//
// 为什么搬家（W872）：本轮要在 rail.ts 里加「中间判定（视口中间指示）」的接线，而
// rail.ts 受模块体积棘轮约束（tools/module-size-baseline.json 登记上限只许降不许升）。
// 把与中间判定无关的这一整段（取内容算式逐字未改）挪出来，新能力才有地方放。
//
// ★ W9345（用户：「快速切换时会感到些微卡顿，应该改用对象复用的方式，让这个框框随位置缓动」）：
//   卡的结构（Q 行 / 分隔线 / A 行，各带标签与文本 span）**只建一次**；换条只改
//   文本、显隐与 class（同一批子节点被复用）。折叠条形态与普通条**共用同一骨架**
//   （折叠 = 只显示 Q 行且标签换成 '⋯'）—— 不再是另一棵各建各的树。
//   首次构造与后续更新走**同一条**代码路径：构造函数 = 建骨架 + 调一次 render()。
// ============================================================================
import { el } from '../utils/dom';
import { t } from '../i18n';

/** 预览首行截断长度（W238 起未变）。 */
const PREVIEW_CHARS = 40;

/** 预览卡需要知道的条目字段（ui/rail.ts 的 RailItem 是它的超集）。 */
export interface RailCardItem {
  /** 轮起点（user 消息；孤立 assistant 为其自身）。 */
  startCol: HTMLElement;
  /** 该轮全部消息列（user + assistant 段）。 */
  cols: HTMLElement[];
  /** 该轮是否已有 assistant 回复。 */
  hasReply: boolean;
  /** >0 = 折叠条（表示更早 N 轮已折叠）。 */
  fold: number;
}

/** 消息内容首行前 N 字（压平空白、取第一个非空行）。 */
function firstLine(col: HTMLElement): string {
  const c = col.querySelector('.content');
  const raw = (c?.textContent ?? '').replace(/[ \t]+/g, ' ').trim();
  if (!raw) return '';
  const line =
    raw
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s.length > 0) ?? '';
  return line.length > PREVIEW_CHARS ? line.slice(0, PREVIEW_CHARS) + '…' : line;
}

/** 该轮第一条 assistant 回复的内容首行（轮内查找，不跨轮）。 */
function replyLine(it: RailCardItem): string {
  for (const col of it.cols) {
    if (col.querySelector('.msg.assistant')) return firstLine(col);
  }
  return '';
}

/** 骨架里「标签 + 文本」那一行的两个子节点（建一次，之后只改文本）。 */
interface Row {
  box: HTMLElement;
  tag: HTMLElement;
  text: HTMLElement;
}

function row(cls: string, tagText: string): Row {
  const box = el('div', cls);
  const tag = el('span', 'railv3-card-tag', tagText);
  const text = el('span', null, '');
  box.appendChild(tag);
  box.appendChild(text);
  return { box, tag, text };
}

/**
 * W9345：把 `it` 的内容写进这张**已建好骨架**的卡。
 *
 * 首次构造与每次换条共用这一份逻辑（构造函数末尾也调它）—— 于是「新建的卡」与
 * 「复用后的卡」内容口径必然一致，不存在只在 build 路径才生效的分支。
 * 只写文本 / class / hidden，不 append、不 remove、不重建任何子节点。
 */
function render(q: Row, sep: HTMLElement, a: Row, it: RailCardItem): void {
  if (it.fold > 0) {
    // 折叠条：只说折叠了几轮（Q 行 + '⋯' 标签），A 行与分隔线不出现。
    q.tag.textContent = '⋯';
    q.text.textContent = t('chat.rail.folded', { n: it.fold });
    q.box.hidden = false;
    sep.hidden = true;
    a.box.hidden = true;
    a.box.classList.remove('railv3-card-noa');
    return;
  }
  const qt = firstLine(it.startCol);
  q.tag.textContent = 'Q';
  q.text.textContent = qt;
  q.box.hidden = qt === ''; // 提问行为空 ⇒ 整行不出现（与旧实现「q 非空才建行」等价）
  if (it.hasReply) {
    const at = replyLine(it);
    a.box.classList.remove('railv3-card-noa');
    if (at) {
      a.tag.textContent = 'A';
      a.text.textContent = at;
      a.box.hidden = false;
      sep.hidden = false;
      return;
    }
  } else {
    a.box.classList.add('railv3-card-noa');
    a.tag.textContent = 'A';
    a.text.textContent = t('chat.rail.noReply');
    a.box.hidden = false;
    sep.hidden = false;
    return;
  }
  // hasReply 为真但本轮找不到可读的 assistant 首行：旧实现只建到 Q 行。
  a.box.hidden = true;
  a.box.classList.remove('railv3-card-noa');
  sep.hidden = true;
}

/** 骨架句柄挂在卡节点自身上（不落全局 Map ⇒ 卡被摘掉即随节点回收）。 */
interface Skeleton {
  __q: Row;
  __sep: HTMLElement;
  __a: Row;
}

/**
 * W9345：**同源复用的把手**（ui/hint/registry.ts 的 HintHandle.update）。
 *
 * 契约：`box` 一定是本提供者 `build` 出来的那种节点（引擎只在同源时才调 update）。
 * 换条只重写文本/显隐/class，卡片节点与它的骨架子节点原样保留 ⇒
 * ① 没有任何一帧「卡不在 DOM 里」；② 不产生整棵子树的新对象（对象复用本身）。
 */
export function updateRailCard(box: HTMLElement, it: RailCardItem): void {
  const skel = box as unknown as Partial<Skeleton>;
  if (!skel.__q || !skel.__sep || !skel.__a) return;
  render(skel.__q, skel.__sep, skel.__a, it);
}

/**
 * 造预览卡（骨架建一次 + 走一次与后续换条**同一条**渲染路径）。
 * 折叠条与普通条共用同一骨架：形状差异由 render() 的显隐与标签表达，不是另一棵树。
 */
export function buildRailCard(it: RailCardItem): HTMLElement {
  const card = el('div', 'railv3-card');
  const q = row('railv3-card-q', 'Q');
  const sep = el('div', 'railv3-card-sep');
  const a = row('railv3-card-a', 'A');
  card.appendChild(q.box);
  card.appendChild(sep);
  card.appendChild(a.box);
  Object.assign(card, { __q: q, __sep: sep, __a: a } satisfies Skeleton);
  render(q, sep, a, it);
  return card;
}
