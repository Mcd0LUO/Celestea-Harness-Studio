// ============================================================================
// utils/link-target.ts — 正文里 markdown 链接的**打开方式**（W2051）。
// ----------------------------------------------------------------------------
// 缺陷（真机 CDP 实测，隔离实例 3811）：渲染出的 `<a href>` 没有任何 target，
//   于是点正文里的链接 = **当前标签页导航** ⇒ 整个 Studio 应用被替换掉，当前会话
//   视图丢失。原始数据：Page.frameNavigated 记到 https://example.com/probe；
//   location.href 由 http://127.0.0.1:3811/ 变成外站；.content.rendered 由 1 个变
//   0 个；body.innerText 变成 "Example Domain…"。全仓 grep `closest('a')` /
//   `tagName === 'A'` 命中 **0** —— 从来就没有过任何点击拦截。
//
// 结论（本模块是这条策略的**唯一真源**）：要离开当前文档的链接一律**新标签页**。
//   · 本仓是**本地 Studio**（用户在浏览器里用它，没有 Electron 的
//     shell.openExternal），也没有任何客户端路由（全仓 pushState / popstate /
//     hashchange 命中 0）⇒「应用内打开」没有一个**存在**的视图可去；
//   · 工作台浏览器面板（ui/workbench/browser.ts）是 iframe，跨站站点用
//     X-Frame-Options / CSP frame-ancestors 拒绝被嵌入，父页面还读不到原因
//     （browser.ts:5 的既有注释）⇒ 拿它当外链出口只是把「导航走了」换成「白屏」；
//   · 新标签页是唯一**不会丢掉当前会话视图**、又不需要任何新 UI 的出口。
//
// 谁**不**走新标签页（两类，各有实测依据）：
//   · `#fragment`：**同文档**导航，本来就不会离开应用。本仓刻意保留标题 id
//     （utils/markdown-heading-id.ts 头注：「会话内定位都依赖它」），给它加
//     target=_blank 会把「跳到本页某个标题」变成「重开一份应用」—— 那是回归。
//   · `mailto:` / `tel:`：交给外部协议处理器，应用**留在原地**（真机实测：
//     无 target 时不产生任何新 target、页面不导航）。加 target=_blank 反而会留下
//     一个空白标签页（真机实测：产生 url:"" 的新 page target）⇒ 也不加。
//
// 安全：`rel="noopener noreferrer"`。
//   · noopener —— 被打开的页面拿不到 `window.opener`，堵住反向导航钓鱼
//     （opener 能把本页导航到仿冒登录页）。现代 Chrome 对 target=_blank 默认已是
//     noopener（本机实测 window.opener === null），但那是**浏览器默认**、不是我们的
//     契约；显式写出来才不依赖它，也让意图可读。
//   · noreferrer —— 本服务**不发 Referrer-Policy 头**（真机 curl -I 实测：响应里
//     没有 Referrer-Policy，也没有 CSP），所以默认策略会把本应用的 URL 作为
//     Referer 送给外站。这是本地 Studio（URL 形如 http://127.0.0.1:3811/），没有
//     理由把内部地址告诉外站。noreferrer 同时蕴含 noopener。
//
// 本模块**零 DOM、零依赖**：纯字符串判定，可在 node 里直接单测。
// ============================================================================

/** 外链的 target：一律新标签页。 */
export const LINK_TARGET = '_blank';

/**
 * 外链的 rel。`noreferrer` 蕴含 `noopener`，两个都写是为了让**意图**可读：
 * 前者防 Referer 泄漏、后者防 opener 反向导航 —— 任一被后人删掉都会红（单测钉住）。
 */
export const LINK_REL = 'noopener noreferrer';

/**
 * 该 href 是否应该在新标签页打开（= 它会不会离开当前文档）。
 *
 * 判定与 utils/sanitize 的 safeUrl **同一把尺子**：先剥控制字符与空白再判 scheme，
 * 否则 `\t#x` 这类写法会让两条判定分叉。传入的值应当已经过 safeUrl。
 */
export function linkOpensInNewTab(href: string): boolean {
  const squeezed = href.replace(/[\u0000-\u0020\u007f-\u009f]/g, '');
  if (squeezed === '') return false;
  // 同文档片段：留在本页（见文件头）。
  if (squeezed.startsWith('#')) return false;
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(squeezed);
  // 没有 scheme = 相对路径 / 协议相对（//host/path）。两者都是**真实导航**
  // （本应用没有客户端路由，任何非片段路径都会把 SPA 换掉）⇒ 走新标签页。
  if (m === null) return true;
  // noUncheckedIndexedAccess：捕获组一定存在（正则只有一个必选组），显式兜底。
  const scheme = (m[1] ?? '').toLowerCase();
  return scheme === 'http' || scheme === 'https';
}
