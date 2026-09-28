// ============================================================================
// ui/workbench/open-url.ts — W2057：把正文外链送进**工作台浏览器面板**。
// ----------------------------------------------------------------------------
// 用户原话：「打开网页链接应该自动打开我们提供的浏览器而非新建页面。」
//
// 本模块是「外链 ⇒ 面板」这条策略的**唯一出口**（零 DOM、零事件监听）：
//   · openUrlInPanel(url) —— 复用已有浏览器面板（没有才新建）并导航到该 URL。
// 谁调它、什么时候调它（点击拦截 / 修饰键语义 / 键盘）在 link-open.ts。
//
// ★ 为什么**复用**已有面板而不是每次新开一个（本遍的判断，报告 §3.1）：
//   state.ts 的 openPanel 是「同 kind 可多开」的（它自己的头注这么写），但那是给
//   **用户从菜单显式开面板**用的语义。点正文外链不是「开一个面板」，而是
//   「看这个链接」—— 同一个动作重复 10 次只该留 1 个面板。若每次新开，用户点
//   10 个链接就得到 10 个 iframe（每个都持有一条真实的跨域加载），面板区被挤满、
//   还得逐个手关。复用则把「看链接」变成**同一个视图换地址**，与
//   ui/preview/panel.ts 的 openPreview（单一覆盖式预览面板，反复调用只换内容）
//   是**同一条**既有产品口径 —— 本模块沿用仓内已付过钱的那个语义，不另立一套。
//
// ★ 为什么必须显式 notify（不能只写 panel.data）：
//   state.ts 只在**增删改**时 emit()，而 `panel.data` 是渲染层直接读的对象
//   （browser.ts:31 读它）。复用路径上没有任何增删 ⇒ 不 notify 就不重画、
//   面板不会导航。notifyPanels() 是 state 的既有出口（openPanel 内部用的同一个）。
//   ★ 新建路径**同样**需要，且必须在写 data **之后** —— 见 openUrlInPanel 的注释：
//   openPanel 是先 emit 再 return 的，它那一次 emit 时 data 还没写。
// ============================================================================
import { listPanels, notifyPanels, openPanel, type PanelState } from './state';

/** 已有的**第一个**浏览器面板（没有则 null）。 */
function firstBrowserPanel(): PanelState | null {
  for (const p of listPanels()) if (p.kind === 'browser') return p;
  return null;
}

/**
 * 在浏览器面板里打开一个 URL：有浏览器面板就复用，没有才新开一个。
 *
 * 返回实际使用的那个面板（调用方/测试据此断言「复用」而不是「新开」）。
 * 写 `panel.data.url` 即触发渲染层导航 —— 这是**既有的**面板 ↔ URL 契约
 * （browser.ts:31/64），本遍不新增任何数据通道。
 */
export function openUrlInPanel(url: string): PanelState {
  const existing = firstBrowserPanel();
  const data = { url } as Record<string, unknown>;
  // 新建：data 经 openPanel 的第三个参数**在 emit 之前**就位（见 state.ts 的注释）
  // ⇒ 渲染层看到的**第一帧**就是完整的面板，不存在「先空后满」的中间帧。
  const panel = existing ?? openPanel('browser', 'right', data);
  panel.data = data;
  // ★ **两条路径都必须 notify**，而且必须在**写完 data 之后**。
  //   真机抓到的缺陷（CDP 审计，报告 §6）：openPanel() 内部是**先 emit 再 return**
  //   （state.ts：panels.push(panel); focused = ...; emit(); return panel;），
  //   所以新建路径上渲染层是在 panel.data **还没写**的时候跑的 —— 那一帧渲染出来
  //   的浏览器面板 current === '' ⇒ 不导航。于是「第一次点外链」开出一个**空面板**，
  //   第二次点（走复用路径）才正常。
  //   jsdom 单测当时只断言了 panel.data.url（它确实写对了），**看不见**这个缺陷；
  //   是真机审计里 frameSrc === null 把它抓出来的（报告 §6 原始数据）。
  //   ⇒ 出口统一成「写 data → notify」，两条路径同一个顺序，不再有分支差异。
  notifyPanels();
  return panel;
}