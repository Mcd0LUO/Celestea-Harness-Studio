// ============================================================================
// i18n/dom.ts — 静态 DOM（index.html）的 i18n 填充。
//   · `data-i18n`            → textContent
//   · `data-i18n-title`      → title 属性
//   · `data-i18n-aria-label` → aria-label 属性
//   · `data-i18n-placeholder`→ placeholder 属性（W9109）
//   语言切换后由 installI18nSettings 统一重画；index.html 里不放中文，只放 key。
// ============================================================================
import { getLocale, t, type Key } from './index';

/**
 * `<html lang>`：屏幕阅读器与浏览器翻译器据此判断页面语言。
 *   index.html 里写死 zh-CN；切到英文后若不更新，**英文界面会被当成中文**
 *   （读屏按中文音读、浏览器翻译器不会提供翻译）。必须跟着语言切换走。
 */
export function applyDocumentLang(doc: Document): void {
  doc.documentElement.lang = getLocale() === 'zh' ? 'zh-CN' : 'en';
}

/**
 * 伪元素（`::after`）的 `content` 读不到 i18n 字典 —— 把这类文案写进 CSS 变量，
 * 由 styles 侧取值（当前唯一消费者：views.css 的
 * `.msg.user.steering/.queued .who::after`）。
 *
 * 为什么值要过 `JSON.stringify`：`content: var(--x)` 只接受**字符串 token**。
 * 实测（Chrome headless）：变量值写成裸文本 ` · 下一步送达` ⇒ 计算值 `content: none`
 * （后缀根本不生成）；写成带引号的 `" · 下一步送达"` ⇒ 计算值 `" · 下一步送达"`。
 * JSON.stringify 产出的正是带双引号、转义正确的 CSS 字符串字面量。
 *
 * 为什么写在 documentElement：自定义属性沿 DOM 继承，一处写入即全页可见；
 * 语言切换是整页重载（见 i18n/settings.ts 的方案 A），启动那一帧写一次就够。
 */
const CSS_COPY_VARS: ReadonlyArray<readonly [string, Key]> = [
  ['--i18n-lane-steer', 'chat.lane.nextStep'],
  ['--i18n-lane-queued', 'chat.lane.nextTurn'],
];

/** 把「只能由 CSS 消费」的文案写进 documentElement 的自定义属性。 */
function applyCssCopyVars(root: ParentNode): void {
  const asDoc = root as Partial<Document>;
  const html = asDoc.documentElement ?? (root as Partial<Element>).ownerDocument?.documentElement;
  if (!html) return;
  for (const [name, key] of CSS_COPY_VARS) {
    html.style.setProperty(name, JSON.stringify(' · ' + t(key)));
  }
}

/**
 * W9226（F5）：**属性型填充的最后一道守卫**。
 *
 * 为什么需要它（除了 t() 已改成回落 key 之外）：`setAttribute(name, v)` 的 v 是
 * 非空 DOMString，`v = undefined` 不抛错、被 WebIDL 转成**字面量 `"undefined"`**
 * 写进属性 —— 用户悬停看到一个写着 undefined 的 tooltip，而「非空」断言照样通过
 * （w9109 的 `if (text === '') unset.push(…)` 正是这样被绕过的）。
 *
 * 判据覆盖「没有文案」的三种形态，全部不写属性：
 *   · undefined —— t() 被改回旧契约时的兜底（W9226 变异 M1 专门验证这条分支）；
 *   · ''        —— 字典里刻意的空值（本仓实有：'shell.status.online'）；
 *   · key 本身  —— t() 的「两语都没有」回落（= index.html 里拼错的 key）。
 *
 * 刻意**不打日志**：这条守卫是「不写出坏值」的防线，而 `t()` 已经把「拼错的 key」
 * 变成界面上的可见事实（回落 key 本身），诊断信息已经足够。反之，多一行 console.warn
 * 会同时抬高两个机械计数：bundle gzip 棘轮（提示语进产物）与
 * tests/doc-conventions ⑩（ARCHITECTURE.md §6.5.5 的 console.warn 计数由 apps/web/src
 * 派生，实测会从 38 变成 39）—— 后者要改 docs/ARCHITECTURE.md，不在本轮授权清单内。
 */
function setAttr(node: Element, attr: string, key: string, value: string | undefined): void {
  if (!value || value === key) return;
  node.setAttribute(attr, value);
}

/** 把 root 内所有带 data-i18n* 属性的元素设为对应 key 的当前语言文案。 */
export function applyI18n(root: ParentNode): void {
  applyCssCopyVars(root);
  for (const node of root.querySelectorAll('[data-i18n]')) {
    const key = node.getAttribute('data-i18n');
    // textContent 分支本来就是安全的（undefined → 空串，会被 w9109 的判空抓到），
    // 故这里不加守卫，保持既有语义逐字不变。
    if (key) node.textContent = t(key as Key);
  }
  for (const node of root.querySelectorAll('[data-i18n-title]')) {
    const key = node.getAttribute('data-i18n-title');
    if (key) setAttr(node, 'title', key, t(key as Key));
  }
  for (const node of root.querySelectorAll('[data-i18n-aria-label]')) {
    const key = node.getAttribute('data-i18n-aria-label');
    if (key) setAttr(node, 'aria-label', key, t(key as Key));
  }
  for (const node of root.querySelectorAll('[data-i18n-placeholder]')) {
    const key = node.getAttribute('data-i18n-placeholder');
    if (key) setAttr(node, 'placeholder', key, t(key as Key));
  }
}

/*
 * W9109：为什么 `data-i18n-placeholder` 走 applyI18n 就够了 ——
 *   `#input` 的 placeholder 随后由 ui/inputbar.ts 按「输入模式 × 提交车道」重写
 *   （renderSubmitUi / setInputMode 里都调了按语言的取值函数）。applyI18n 只在
 *   启动那一帧写一次**空闲态**值，正是 initInputBar 之前的正确显示；之后每次模式或
 *   车道变化都由 inputbar 自己按当前语言写。两个写者不会互相覆盖，因为 applyI18n
 *   不在模式变化时被调用（语言切换是整页重载，见 i18n/settings.ts 的方案 A）。
 */
