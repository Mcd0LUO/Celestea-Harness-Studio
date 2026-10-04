// ============================================================================
// scripts/a11y/ime-completion-guard.mjs — W2036：**命令补全框**的 IME 组合守卫真机审计
// ----------------------------------------------------------------------------
// 缺陷（本轮真机复现，桌面 1440x900 + CDP 原生事件）：输入框打 "/" ⇒ 补全框出现
// （首项 /run）⇒ 切中文输入法打拼音 ⇒ 组合串进 textarea、补全框**仍然可见** ⇒ 按 Enter
// **确认候选词**，那一次 Enter 被补全框当成「选中补全项」⇒ 输入框被写成 "/run " 并被关框。
// 每确认一次候选词污染一次输入框。
//
// 为什么 W2032/W2033 的守卫没挡住：那些 isImeKey 守卫在 ui/inputbar/newline.ts 的
// enterAction 内部，而 bindEnterKey 第一行 `if (interceptCommandKey(e)) return;` 先让
// 补全框消费掉了这次按键 ⇒ 守卫根本跑不到。修法见 ui/commands/popup.ts 的 completionKey
// 与 utils/overlays.ts 的 onKeydown（后者是**全仓唯一**的 document 级 Esc 监听）。
//
// ★ **刻意不进门禁**：它需要 Vite dev server + Chrome，不是确定性离线门禁。
//   确定性断言在 tests/w2036-ime-completion-dom.test.ts（jsdom，进门禁）。
//   与 scripts/a11y/ime-enter-guard.mjs、audit-touch-targets.mjs 同一取向。
//
// 用法：
//   pnpm --dir apps/web dev --port 3788 --strictPort          # 前置（本脚本只读 /src/**）
//   W2036_VITE=http://127.0.0.1:3788 W2036_TAG=after \
//     W9111_CHROME=<chrome-headless-shell 路径> \
//     node scripts/a11y/ime-completion-guard.mjs             # 修复后应 ALL_PASS
//
// A/B 口径（本脚本就是这么用的）：同一套仪表分别跑修复前/修复后 ——
//   修复前：git show HEAD:apps/web/src/ui/commands/popup.ts > …/popup.ts（overlays.ts 同理）
//           W2036_TAG=before ⇒ 期望 4 条 FAIL（组合 Enter ×2、组合 Esc、触摸组合 Enter）
//   修复后：W2036_TAG=after  ⇒ 期望 11 条全 PASS
//   两次都要 consoleErrors=0。
//
// 三种按键 × 桌面/触摸：
//   composing —— CDP Input.imeSetComposition 真开始组合（isTrusted 的 keydown）
//   ime229    —— compositionend 早于 keydown 的那一次（windowsVirtualKeyCode=229）
//   plain     —— 对照：非组合按键**必须**照常生效（防「守卫写成永远拦」）
// ============================================================================
import { backendPort, cdpPort } from '../perf/lib/ports.mjs';
import { launchChrome } from '../perf/lib/chrome.mjs';
import { startBackend } from '../perf/lib/backend.mjs';

const VITE = process.env.W2036_VITE ?? 'http://127.0.0.1:3788';
const TAG = process.env.W2036_TAG ?? 'unknown';
const WEB = new URL('../../apps/web', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = await launchChrome({ port: cdpPort() + 41, width: 1440, height: 900 });
const backend = await startBackend({ port: backendPort() + 41, webRoot: WEB, viteOrigin: VITE, history: [] });
const ORIGIN = backend.origin;
const { page } = chrome;
const consoleErrors = [];
page.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') consoleErrors.push((p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ')); });
page.on('Runtime.exceptionThrown', (p) => consoleErrors.push('EXCEPTION ' + (p.exceptionDetails?.exception?.description ?? '')));

async function waitFor(body, label, t = 25000) {
  const dl = Date.now() + t;
  while (Date.now() < dl) { if (await page.eval('(function(){ ' + body + ' })()')) return true; await sleep(80); }
  throw new Error('waitFor timeout: ' + label);
}
const STATE = "(function(){ var i=document.getElementById('input'); var b=document.getElementById('cmdPopup'); var a=b&&b.querySelector('.cmd-row.active');"
  + " return { value: i.value, caret: i.selectionStart, popupVisible: !!b && !b.classList.contains('hidden'),"
  + " active: a?a.querySelector('.cmd-name').textContent:null, rows: b?b.querySelectorAll('.cmd-row').length:0 }; })()";

/** 装仪表：捕获阶段记每一次 keydown 的原始字段。 */
const INSTRUMENT = "(function(){ window.__keys=[]; document.addEventListener('keydown', function(e){"
  + " window.__keys.push({ key:e.key, isComposing:e.isComposing, keyCode:e.keyCode, defaultPrevented:e.defaultPrevented,"
  + " valueAtEvent: document.getElementById('input').value }); }, true); return true; })()";

/** arm='slash'：真打 '/' 等补全框出现；arm='text'：置 'abc'（补全框不参与）。 */
async function arm(mode) {
  if (mode === 'text') {
    await page.eval("(function(){ var i=document.getElementById('input'); i.focus(); i.value='abc';"
      + " i.setSelectionRange(3,3); i.dispatchEvent(new Event('input',{bubbles:true})); return true; })()");
    await sleep(200);
    return page.eval(STATE);
  }
  await page.eval("document.getElementById('input').focus()");
  await page.send('Input.insertText', { text: '/' });
  await waitFor("var b=document.getElementById('cmdPopup'); return !!b && !b.classList.contains('hidden');", 'popup');
  return page.eval(STATE);
}
async function press(kind, text, key, vkPlain, code) {
  const vk = kind === 'ime229' ? 229 : vkPlain;
  if (kind === 'composing') await page.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  const k = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  if (key === 'Enter') k.text = '\r';
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
}

const RESULTS = [];
async function run(label, kind, key, vkPlain, code, text, expect, armMode) {
  await page.navigate(ORIGIN + '/');
  await waitFor("return document.querySelector('.sess-pane:not([hidden])') !== null;", 'pane');
  const origin = await page.eval('performance.timeOrigin');
  await page.eval(INSTRUMENT);
  const before = await arm(armMode ?? 'slash');
  await press(kind, text ?? '', key, vkPlain, code);
  await sleep(250);
  const after = await page.eval(STATE);
  const keys = await page.eval('window.__keys');
  const trusted = (await page.eval('performance.timeOrigin')) === origin;
  const ok = expect(after, before);
  RESULTS.push({ label, trusted, ok, before, after, keys });
  console.log('[' + label + '] trusted=' + trusted + ' ' + (ok ? 'PASS' : 'FAIL'));
  console.log('   before: ' + JSON.stringify(before));
  console.log('   after : ' + JSON.stringify(after));
  console.log('   keydown@document(capture): ' + JSON.stringify(keys));
  return ok;
}

await page.navigate(ORIGIN + '/');
await waitFor("return document.querySelector('.sess-pane:not([hidden])') !== null;", 'pane');
await page.evalAsync("await import('/src/ui/commands/index.ts'); await import('/src/ui/inputbar.ts'); return true;");
await sleep(1200);

console.log('########## 变体 = ' + TAG + ' ##########');
console.log('======== 桌面 1440x900 ========');
await run('桌面 · 组合中 Enter（拼音 run ⇒ 确认候选词）', 'composing', 'Enter', 13, 'Enter', 'run',
  (a) => a.value === '/run' && a.popupVisible === true);
await run('桌面 · keyCode=229 的 Enter（compositionend 早到）', 'ime229', 'Enter', 13, 'Enter', '',
  (a) => a.value === '/' && a.popupVisible === true);
await run('桌面 · 非组合 Enter（对照：必须照常选中 /run）', 'plain', 'Enter', 13, 'Enter', '',
  (a) => a.value === '/run ' && a.popupVisible === false);
await run('桌面 · 组合中 ArrowDown（翻候选页，不改高亮）', 'composing', 'ArrowDown', 40, 'ArrowDown', 'run',
  (a, b) => a.active === b.active);
await run('桌面 · 非组合 ArrowDown（对照：必须翻页）', 'plain', 'ArrowDown', 40, 'ArrowDown', '',
  (a, b) => a.active !== b.active);
await run('桌面 · 组合中 Escape（取消组合，不关框）', 'composing', 'Escape', 27, 'Escape', 'run',
  (a) => a.popupVisible === true);
await run('桌面 · 非组合 Escape（对照：必须关框）', 'plain', 'Escape', 27, 'Escape', '',
  (a) => a.popupVisible === false);

console.log('======== 触摸端 390x844（W2028 行为） ========');
await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }] });
await run('触摸 · 组合中 Enter（必须仍是 native ⇒ 浏览器插换行）', 'composing', 'Enter', 13, 'Enter', 'ni hao',
  (a) => a.value === '/ni hao\n');
await run('触摸 · 非组合 Enter + 补全框可见（照常选中，与桌面同规则）', 'plain', 'Enter', 13, 'Enter', '',
  (a) => a.value === '/run ' && a.popupVisible === false);
await run('触摸 · 非组合 Enter（无补全框 ⇒ 必须仍插换行、不发送）', 'plain', 'Enter', 13, 'Enter', '',
  (a) => a.value === 'abc\n', 'text');
await run('触摸 · 组合中 Enter + 补全框可见（不许被补全框选中）', 'composing', 'Enter', 13, 'Enter', 'run',
  (a) => a.value === '/run\n');

console.log('======== 截图（桌面，组合中的状态） ========');
await page.send('Emulation.clearDeviceMetricsOverride');
await page.send('Emulation.setEmulatedMedia', { features: [] });
await page.navigate(ORIGIN + '/');
await waitFor("return document.querySelector('.sess-pane:not([hidden])') !== null;", 'pane');
await arm('slash');
await page.send('Input.imeSetComposition', { text: 'run', selectionStart: 3, selectionEnd: 3 });
await sleep(350);
console.log('  composing 状态: ' + JSON.stringify(await page.eval(STATE)));
console.log('  shot: ' + await page.screenshot('results/w2036-' + TAG + '-composing.png'));

// ─── W2036 返工：另两处 document 级 Esc（清点全仓共 3 处，此前只覆盖补全框这一处） ───
// 这两处的状态是各自模块的**局部量**（抽屉的 open / 提示卡的 hovered），不在这条浮层栈上，
// 所以它们是**独立**的缺陷点，必须各自纳入审计 —— 只测补全框会漏掉它们。
console.log('======== 侧栏抽屉 + 提示卡（全仓另两处 document 级 Esc） ========');

/** 触摸端骨架：点 #btnSidebar 开抽屉 → 聚焦真实搜索框。 */
async function armDrawer() {
  await page.eval("document.getElementById('btnSidebar').click()");
  await sleep(250);
  await page.eval("(function(){ var i=document.querySelector('.ws-search-input'); if(i) i.focus(); return true; })()");
  return page.eval(DRAWER_STATE);
}
/**
 * 桌面：给一个真实锚点登记 hint 并 focus 它（onFocusIn 直接弹卡，不等停留）。
 *
 * ★ 必须走 ui/hint/index.ts（= main.ts 里 `initHints()` 用的**同一个**模块实例），
 *   不能直接 import card.ts —— 实测那样拿到的是**未装配**的实例（hintsMounted()=false、
 *   提供者表为空）⇒ 卡永远弹不出来 ⇒ 用例变成假绿（本轮实测踩到，已修）。
 */
async function armHint() {
  const ready = await page.evalAsync([
    "window.__h = await import('/src/ui/hint/index.ts');",
    "if (!window.__h.hintsMounted()) window.__h.initHints();",
    "return window.__h.hintsMounted() && window.__h.hintPlugins().length > 0;",
  ].join(""));
  if (!ready) throw new Error('hint 引擎未装配或没有提供者 ⇒ 该用例会假绿，直接失败');
  // ★ 焦点必须留在 #input（组合事件只会送进**已聚焦**的那个元素）：
  //   若先 focus 锚点再 imeSetComposition，浏览器会把焦点搬到 textarea ⇒ 触发
  //   focusout ⇒ hideHint() ⇒ 卡被**焦点变化**撤掉，而不是被 Esc 撤掉（假红）。
  //   本轮实测踩到过这个假红，故这里显式先聚焦 #input。
  // ★ 弹卡走**真实指针路径**（pointerover → onOver → hoverHint → 150ms 停留 → show），
  //   不用 focus 路径 —— 后者会夺走 #input 的焦点，正是上面那条假红的来源。
  await page.eval([
    "(function(){",
    "  var i = document.getElementById('input'); if (i) i.focus();",
    "  var b = document.getElementById('btnSidebar');",
    "  b.setAttribute('data-hint', 'W2036 审计');",
    "  b.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));",
    "  return true;",
    "})()",
  ].join(""));
  await sleep(500); // 引擎缺省停留 150ms，留足余量
  const st = await page.eval(HINT_STATE);
  if (!st.card) throw new Error('hint 卡没弹出来 ⇒ 后续断言会假绿，直接失败');
  return st;
}

const DRAWER_STATE = "(function(){ var b=document.getElementById('btnSidebar'); var a=document.getElementById('app');"
  + " return { drawerOpen: a ? a.classList.contains('drawer-open') : null, ariaExpanded: b ? b.getAttribute('aria-expanded') : null,"
  + "   focus: document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : null }; })()";
const HINT_STATE = "(function(){ var c = window.__h ? window.__h.hintCardEl() : null;"
  + " return { card: !!c, text: c ? c.textContent : null }; })()";

/** 通用用例：新文档 → arm → 按键 → 读 after。 */
async function runSite(label, setup, read, press2, expect) {
  await page.navigate(ORIGIN + '/');
  await waitFor("return document.querySelector('.sess-pane:not([hidden])') !== null;", 'pane');
  const origin = await page.eval('performance.timeOrigin');
  const before = await setup();
  await press2();
  await sleep(300);
  const after = await page.eval(read);
  const trusted = (await page.eval('performance.timeOrigin')) === origin;
  const ok = expect(after, before);
  RESULTS.push({ label, trusted, ok, before, after });
  console.log('[' + label + '] trusted=' + trusted + ' ' + (ok ? 'PASS' : 'FAIL'));
  console.log('   before: ' + JSON.stringify(before));
  console.log('   after : ' + JSON.stringify(after));
  return ok;
}

// 触摸端 390x844：抽屉只在移动端生效
await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'width', value: '390px' }] });
for (const [kind, text] of [['composing', 'zhongwen'], ['ime229', ''], ['plain', '']]) {
  const label = '侧栏抽屉 · ' + (kind === 'plain' ? '普通 Esc（对照：必须仍收抽屉）' : kind + ' 的 Esc（不许收抽屉）');
  await runSite(label, armDrawer, DRAWER_STATE,
    () => press(kind, text, 'Escape', 27, 'Escape'),
    kind === 'plain' ? (a) => a.drawerOpen === false : (a) => a.drawerOpen === true);
}

// 桌面：提示卡
await page.send('Emulation.clearDeviceMetricsOverride');
await page.send('Emulation.setEmulatedMedia', { features: [] });
for (const [kind, text] of [['composing', 'zhongwen'], ['ime229', ''], ['plain', '']]) {
  const label = '提示卡 · ' + (kind === 'plain' ? '普通 Esc（对照：必须仍撤卡）' : kind + ' 的 Esc（不许撤卡）');
  await runSite(label, armHint, HINT_STATE,
    () => press(kind, text, 'Escape', 27, 'Escape'),
    kind === 'plain' ? (a) => a.card === false : (a) => a.card === true);
}

console.log('======== 汇总（' + TAG + '） ========');
for (const r of RESULTS) console.log((r.ok && r.trusted ? 'PASS ' : 'FAIL ') + r.label);
console.log('consoleErrors=' + consoleErrors.length + ' ' + JSON.stringify(consoleErrors));
const bad = RESULTS.filter((r) => !r.trusted || !r.ok);
console.log('W2036_AB_' + TAG + '_' + (bad.length === 0 ? 'ALL_PASS' : 'HAS_FAILURES'));
await chrome.close();
await backend.close();
