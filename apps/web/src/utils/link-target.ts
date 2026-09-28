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
// ★★ W2057 对上面第二条的**再评估**（用户原话：「打开网页链接应该自动打开我们
//    提供的浏览器而非新建页面」）—— W2051 把 browser.ts 的降级**当成不存在**了。
//    本遍真机复核（CDP，隔离实例）：
//      · 那条「加载超时 ⇒ 提示 + 在新标签打开」的降级**在改动前是死的**：
//        iframe 的 load 事件对**任何**失败都照常触发（X-Frame-Options 拒绝、
//        CSP frame-ancestors 拒绝、端口根本不存在 —— 三者实测 loads=1），
//        所以 browser.ts:71 的 `done = true` 一定会先跑，超时分支永远不进。
//        量化（15 个真实站点）：5 个被拒，其中**没有一个**出现提示 ⇒ 全是**白屏**。
//        W2051 的结论「拿它当外链出口只是把导航走了换成白屏」当时**完全正确**。
//      · 但根因不是「跨域读不到原因」（那是真的、无法绕过），而是**判据取错了**：
//        load 事件不区分成功与失败。真正的判据是
//        `frame.contentWindow.length` —— 加载成功的文档 length>0，被拒/超时 =0
//        （实测：XFO 拒绝 0 / CSP 拒绝 0 / 死端口 0 / 同源 200 成功 1 /
//         example.com 成功 1；见 browser.ts 头注与报告 §2）。
//      ⇒ 修好降级之后，「被拒 ⇒ 可读提示 + 在新标签打开」才真的成立，
//        W2051 否决面板的那条理由**今天不再成立**。
//    W2051 保留不动的两类（#fragment / mailto / tel）本遍**一字不改**：
//    它们各有真机实测依据，且判定由 linkOpensInNewTab 直接复用（不可能分叉）。
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
  const squeezed = squeeze(href);
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

/**
 * W2057：该 href 是否该由**工作台浏览器面板**接走（而不是交给浏览器）。
 *
 * 真值表（前两段是 W2051 的既有结论，本遍**一个字不改**）：
 *   `#fragment`            ⇒ false（同文档导航，留在原地）
 *   `mailto:` / `tel:`     ⇒ false（交给外部协议处理器，应用留在原地）
 *   相对路径 / `//host/p`  ⇒ false（面板补不出正确的绝对地址，见下）
 *   `http:` / `https:`     ⇒ **true**（面板唯一的适用范围）
 *
 * ★ 为什么相对路径不进面板：面板的 URL 归一化（browser.ts 的 normalizeUrl）
 *   对不带 scheme 的输入一律补 `https://` ⇒ `./README.md` 会变成
 *   `https://./README.md`（垃圾地址）。若改成按 location 解析，打开的其实是
 *   **Studio 自己**（同源）⇒ 面板里嵌一个自己，递归。两条路都不通，所以保持
 *   W2051 的新标签页行为（那时它至少是一个真实导航）。
 */
export function linkOpensInPanel(href: string): boolean {
  // 第一段直接复用 W2051 的判定：#fragment / mailto / tel 在这里就被挡掉，
  // 与 sanitize 落定的 target **不可能**分叉。
  if (!linkOpensInNewTab(href)) return false;
  // 第二段：只有绝对 http(s) 才有「一个网页」可以交给面板。
  return /^https?:/i.test(squeeze(href));
}

/**
 * 剥掉所有 C0/C1 控制字符与空白。
 *
 * safeUrl（utils/sanitize）与本模块的两个判定共用**同一把尺子**：只要有一处不剥，
 * `\t#x` 这类写法就会让判定分叉（W2051 头注已登记这条理由）。
 */
function squeeze(href: string): string {
  return href.replace(/[\u0000-\u0020\u007f-\u009f]/g, '');
}