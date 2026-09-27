// ============================================================================
// scripts/a11y/lib/scenarios.mjs — 审计用的**页面场景**（把目标"召唤"出来）
// ----------------------------------------------------------------------------
// 为什么需要它：审计只看得见**当前 DOM**。空页面只有 17 个目标，而真实使用中的
// 页面有 200+（会话树 + 历史消息里的注入块 + 设置页）。不把场景摆出来，
// 「undersized 有几个」这种结论既复现不了，也守不住。
//
// ★ 场景必须**互斥**地摆：抽屉与设置页是两个浮层，同时打开时下层控件的 24px 圆
//   会与上层控件相交 ⇒ 量出一堆**遮挡造成的假警报**（实测踩到）。这不是标准说的
//   「目标挨得太近」，故本模块把每个浮层拆成独立场景，并在 settings 场景里显式
//   先关掉抽屉。`full` 保留但**明确标注为叠层**，只用于「最坏情况」观察，
//   不作为判定依据。
//
// 场景：
//   empty     空会话（夹具默认）—— 最干净的基线
//   inbox     注入 5 种 origin 的历史条目 ⇒ 出现 5 个 .inbox-fold-head
//   drawer    会话抽屉拉开（移动端侧栏）
//   settings  设置页打开（抽屉已关）
//   full      drawer + settings **叠层**（非真实状态，仅用于观察遮挡假警报）
// ============================================================================

/**
 * 注入块历史夹具：**5 种 origin 各一条**，正好对应 ui/messages/user.ts 的
 * inboxKind() 五分支（skill / memory / receipt / steering / compact）。
 * 五种都会渲染 <details><summary class="inbox-fold-head">。
 */
export function inboxHistory() {
  const kinds = ['skill', 'memory', 'receipt', 'steering', 'compact'];
  return [
    { role: 'user', kind: 'user', content: '审计用的一条普通用户消息。' },
    ...kinds.map((kind, i) => ({
      role: 'inbox',
      kind,
      source: 'audit-fixture',
      content: '注入块 #' + (i + 1) + '（' + kind + '）\n第二行用于撑出内容高度。',
    })),
    { role: 'assistant', kind: 'assistant', content: '收到。' },
  ];
}

/** 点一个按钮并回报结果（走真实交互路径，不直接改 class）。 */
async function clickAndReport(page, id, okExpr) {
  return page.eval([
    '(function(){',
    '  const btn = document.getElementById(' + JSON.stringify(id) + ');',
    '  if (!btn) return "no-button";',
    '  btn.click();',
    '  return (' + okExpr + ') ? "open" : "closed";',
    '})()',
  ].join('\n'));
}

/**
 * 在页面里执行场景动作。**一律走真实交互路径**（点真按钮），不直接改 class ——
 * 直接改 class 会绕过 ui 代码，量到的就不是用户看到的东西了。
 *
 * @param {object} page CdpPage
 * @param {string} name 场景名
 */
export async function applyScenario(page, name) {
  if (name === 'empty') return { opened: [] };
  const opened = [];
  if (name === 'inbox' || name === 'full') opened.push('inbox-history');

  if (name === 'settings' || name === 'full') {
    // 设置页自带全屏模态；先确保抽屉是关的（否则叠层 ⇒ 假警报）。
    const closed = await page.eval([
      '(function(){',
      '  const app = document.getElementById("app");',
      '  if (!app.classList.contains("drawer-open")) return "already-closed";',
      '  document.getElementById("btnSidebar").click();',
      '  return app.classList.contains("drawer-open") ? "still-open" : "closed";',
      '})()',
    ].join('\n'));
    opened.push('drawer-closed:' + closed);
  }

  if (name === 'drawer' || name === 'full') {
    // 移动端侧栏是覆盖式抽屉（transform 移出屏幕，**不是** display:none）。
    const drawer = await clickAndReport(page, 'btnSidebar',
      'document.getElementById("app").classList.contains("drawer-open")');
    opened.push('drawer:' + drawer);
  }

  if (name === 'settings' || name === 'full') {
    // 设置入口在抽屉左下角；抽屉已关时它仍可点（DOM 里在，几何也在），故直接点。
    const settings = await clickAndReport(page, 'btnSettingsEntry',
      '!document.getElementById("settingsPage").classList.contains("hidden")');
    opened.push('settings:' + settings);
  }
  return { opened };
}
