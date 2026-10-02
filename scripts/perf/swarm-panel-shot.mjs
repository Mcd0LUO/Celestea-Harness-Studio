// ============================================================================
// scripts/perf/swarm-panel-shot.mjs — agent_swarm 状态栏面板的真机取证（铁律 3）
// ----------------------------------------------------------------------------
// 为什么需要：jsdom 没有排版引擎，rect 恒 0；docs/AGENT.md 铁律 3 又明载「只数
// DOM 节点」曾让一个不可见面板全绿通过。本脚本用仓内既有的零依赖 CDP harness
// （lib/cdp.mjs —— 本仓没有 playwright/puppeteer，装它们要动共享工作树的 node_modules）
// 起真 Blink，量三样只有真机能量的事：
//   1) #slSwarm 的 getBoundingClientRect 宽高 > 0（非零几何）；
//   2) getComputedStyle 的 display 可见性（隐藏档 / 可见档 / 弹层展开档各一遍）；
//   3) 点开徽标后截整条 statusline（含弹层）。第 3 样重点验的是 index.html
//      注释里点名过的真实裁剪风险：
//        「三个 .sl-popup 都从 statusline 向上弹出（bottom: calc(100% - 2px)），
//         裁剪会切掉面板」
//      —— .chat-shell 的圆角/overflow 若真裁到弹层，只有真机看得见。
//
// 模式 (b)：页面内动态 import 被测模块 + 喂合成名册，不依赖 apps/studio 接线
//   （与 tests/w2055 测模型图标同招：页面内 import + 真实交互路径点开）。
//   等 studio 侧接完后可加 (a) 走真实后端的终验模式。
//
// 用法：
//   SWARM_LABEL=b1 SWARM_PORT=3789 SWARM_CDP_PORT=9346 node scripts/perf/swarm-panel-shot.mjs
//
// 落盘纪律（铁律 6 同款理由）：
//   · Chrome profile 一律落 $TEMP（chrome.mjs 保证），绝不提交；
//   · results/ 只落 JSON / MD / PNG，不含任何真实会话数据 ——
//     本脚本注入的是下面那份自造合成名册（alpha/beta/gamma/delta task）。
// ============================================================================
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot } from './lib/app.mjs';
import { mdTable } from './lib/stats.mjs';

const LABEL = process.env.SWARM_LABEL ?? 'b1';
const RESULTS = process.env.SWARM_RESULTS ?? 'results/swarm-panel';
const PORT = Number(process.env.SWARM_PORT ?? 3789);
const CDP_PORT = Number(process.env.SWARM_CDP_PORT ?? 9346);
const WIDTH = Number(process.env.SWARM_WIDTH ?? 1440);
const HEIGHT = Number(process.env.SWARM_HEIGHT ?? 900);

// 合成名册（不是真实会话数据）：一个批次、4 个成员、四个相位各一 ——
// 正好把四组折叠默认值（前两组展开 / 后两组收起）一次拍全。
// 成员数 4 >= MIN_MEMBERS(2)，所以徽标该显示。
const ROSTER = {
  active: true,
  batches: [{
    id: 'b1',
    model: 'demo-model',
    done: 1,
    total: 4,
    members: [
      { id: '1', label: 'alpha task', phase: 'running' },
      { id: '2', label: 'beta task', phase: 'failed', error: 'boom' },
      { id: '3', label: 'gamma task', phase: 'done' },
      { id: '4', label: 'delta task', phase: 'cancelled' },
    ],
  }],
};

// 把几何 / 可见性一次读全（页面内执行，返回可 JSON 化对象）。
const PROBE = [
  'const btn = document.getElementById("slSwarm");',
  'const popup = document.querySelector(".swarm-popup");',
  'const statusline = document.getElementById("statusline");',
  'const shell = document.querySelector(".chat-shell");',
  'const rectOf = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }; };',
  'const visOf = (n) => { if (!n) return null; const cs = getComputedStyle(n); return { display: cs.display, visibility: cs.visibility, opacity: cs.opacity }; };',
  'return {',
  '  badge: { present: btn !== null, rect: rectOf(btn), vis: visOf(btn), text: btn ? btn.textContent : null, hidden: btn ? btn.classList.contains("hidden") : null, title: btn ? btn.getAttribute("title") : null },',
  '  popup: { present: popup !== null, rect: rectOf(popup), vis: visOf(popup), groups: Array.from(document.querySelectorAll(".swarm-group-head")).map((h) => ({ label: (h.textContent || "").trim(), expanded: h.getAttribute("aria-expanded") })) },',
  '  statusline: { rect: rectOf(statusline), vis: visOf(statusline) },',
  '  chatShell: { rect: rectOf(shell), vis: visOf(shell), overflowY: shell ? getComputedStyle(shell).overflowY : null, borderRadius: shell ? getComputedStyle(shell).borderRadius : null },',
  '};',
].join('\n');

// 裁剪风险判据：弹层是否完整落在视口内、且没被祖先的 overflow 切掉。
const CLIPPING = [
  'const p = document.querySelector(".swarm-popup");',
  'if (!p) return { popupMissing: true };',
  'const r = p.getBoundingClientRect();',
  'const vw = window.innerWidth, vh = window.innerHeight;',
  '// 逐级看祖先有没有 overflow 裁切（.chat-shell 是 index.html 点名的风险点）。',
  'const cutters = [];',
  'let n = p.parentElement;',
  'while (n) {',
  '  const cs = getComputedStyle(n);',
  '  if (cs.overflow !== "visible" || cs.overflowX !== "visible" || cs.overflowY !== "visible") {',
  '    const cr = n.getBoundingClientRect();',
  '    cutters.push({ tag: n.tagName.toLowerCase(), id: n.id || null, cls: String(n.className || ""), overflow: cs.overflow, overflowX: cs.overflowX, overflowY: cs.overflowY, rect: { w: Math.round(cr.width), h: Math.round(cr.height), top: Math.round(cr.top), bottom: Math.round(cr.bottom), left: Math.round(cr.left), right: Math.round(cr.right) } });',
  '  }',
  '  n = n.parentElement;',
  '}',
  '// 命中测试：弹层中心是否仍落在每个裁切祖先的矩形内？任一不落即被裁。',
  'let clippedBy = null;',
  'const cx = r.left + r.width / 2, cy = r.top + r.height / 2;',
  'for (const c of cutters) {',
  '  const cr = c.rect;',
  '  if (cx < cr.left || cx > cr.left + cr.w || cy < cr.top || cy > cr.top + cr.h) { clippedBy = c; break; }',
  '}',
  'return {',
  '  popupMissing: false,',
  '  rect: { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) },',
  '  fullyInViewport: r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw,',
  '  viewport: { w: vw, h: vh },',
  '  cutters: cutters,',
  '  clippedBy: clippedBy,',
  '};',
].join('\n');

// 装被测模块 + 喂合成名册 + 装徽标（页面内动态 import，(b) 模式的核心）。
const ARM = [
  'const m = await import("/src/statusline/swarm.ts");',
  'window.__SWARMM = window.__SWARMM || {};',
  'window.__SWARMM.swarm = m;',
  'm.initSwarmBadge();',
  'm.setSwarmRoster(' + JSON.stringify(ROSTER) + ');',
  'return { armed: true, exports: Object.keys(m).length };',
].join('\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// page.eval 的参数是**函数体**（含 return），不是表达式 —— 裸语句会被解析成
// top-level return 而报 Illegal return statement。与 lib/app.mjs 的 waitFor 同一约定。
const asBody = (src) => '(function(){ ' + src + ' })()';

// 几何判据：w/h 都必须 > 0。
const nonZero = (r) => r !== null && r !== undefined && r.w > 0 && r.h > 0;

// 机械判定（数值面）；四角完整性交人眼。
function assess(out) {
  const baseVis = out.baseline.badge.vis;
  const actVis = out.active.badge.vis;
  return {
    geometry: out.active.badge.present === true && nonZero(out.active.badge.rect),
    visibility: out.baseline.badge.hidden === true && baseVis !== null && baseVis.display === 'none'
      && out.active.badge.hidden === false && actVis !== null && actVis.display !== 'none',
    popupGeometry: out.clipping.popupMissing !== true && nonZero(out.clipping.rect),
    notClipped: out.clipping.clippedBy === null && out.clipping.fullyInViewport === true,
  };
}

const fmtRect = (r) => (r ? r.w + '×' + r.h : 'null');
const dispOf = (v) => (v === null || v === undefined ? 'null' : v.display);

function renderMd(out) {
  const pass = assess(out);
  const cutters = out.clipping.cutters || [];
  const groups = out.opened.popup.groups || [];
  const L = [];
  L.push('# agent_swarm 状态栏面板 · 真机取证 · ' + out.label);
  L.push('');
  L.push('模式 (b)：页面内动态 import 被测模块 + 喂合成名册（不含真实会话数据）。视口 ' + out.viewport.w + '×' + out.viewport.h + '。');
  L.push('');
  L.push('## 1) 非零几何 + 2) 可见性');
  L.push('');
  L.push(mdTable(['阶段', 'present', 'rect w×h', 'display', '带 hidden 类', '文案'], [
    ['基线（未喂名册）', out.baseline.badge.present, fmtRect(out.baseline.badge.rect), dispOf(out.baseline.badge.vis), out.baseline.badge.hidden, out.baseline.badge.text],
    ['喂名册后', out.active.badge.present, fmtRect(out.active.badge.rect), dispOf(out.active.badge.vis), out.active.badge.hidden, out.active.badge.text],
    ['点开弹层后', out.opened.badge.present, fmtRect(out.opened.badge.rect), dispOf(out.opened.badge.vis), out.opened.badge.hidden, out.opened.badge.text],
  ]));
  L.push('');
  L.push('## 3) 弹层与裁剪风险（.chat-shell overflow 会切面板 —— index.html 点名过）');
  L.push('');
  L.push(mdTable(['弹层 rect w×h', '完全在视口内', '视口', '裁切祖先数', '被谁裁到'], [
    [fmtRect(out.clipping.rect), out.clipping.fullyInViewport, out.clipping.viewport.w + '×' + out.clipping.viewport.h, cutters.length, out.clipping.clippedBy === null ? 'null（没被裁）' : (out.clipping.clippedBy.id || out.clipping.clippedBy.cls || out.clipping.clippedBy.tag)],
  ]));
  L.push('');
  if (cutters.length > 0) {
    L.push('祖先链上带 overflow 的元素（弹层从 statusline 向上弹出，这些是潜在裁切者）：');
    L.push('');
    L.push(mdTable(['tag', 'id', 'class', 'overflow', 'overflow-x', 'overflow-y', 'rect h'], cutters.map((c) => [c.tag, c.id === null ? '' : c.id, String(c.cls).slice(0, 40), c.overflow, c.overflowX, c.overflowY, c.rect.h])));
    L.push('');
  }
  L.push('## 四组折叠默认值（进行中/失败 展开，已完成/取消 收起）');
  L.push('');
  L.push(mdTable(['相位组', 'aria-expanded'], groups.map((g) => [g.label, g.expanded])));
  L.push('');
  L.push('## 判定');
  L.push('');
  L.push('- 非零几何（徽标 w>0 且 h>0）：**' + (pass.geometry ? 'PASS' : 'FAIL') + '**');
  L.push('- 可见性（基线 display:none、喂名册后非 none）：**' + (pass.visibility ? 'PASS' : 'FAIL') + '**');
  L.push('- 弹层非零几何：' + (pass.popupGeometry ? 'PASS' : 'FAIL'));
  L.push('- 弹层未被祖先 overflow 裁掉（四角完整性仍要人眼看截图）：' + (pass.notClipped ? 'PASS' : 'FAIL'));
  L.push('- 控制台错误：' + (out.consoleErrors.length === 0 ? '无' : out.consoleErrors.join(' / ')));
  L.push('');
  L.push('★ 「未被裁掉」这一条脚本只能给数值证据（弹层矩形 vs 裁切祖先矩形 vs 视口）；');
  L.push('四角是否真的完整仍要人眼看 swarm-panel-' + out.label + '-statusline.png ——');
  L.push('docs/AGENT.md 铁律 3：机械断言替代不了眼睛。');
  return L.join('\n');
}

async function run() {
  const app = await boot({ port: PORT, cdpPort: CDP_PORT, width: WIDTH, height: HEIGHT });
  try {
    // 用 boot() 而不是 bootApp()：bootApp 额外等 `.sess-pane` 就绪，而那是**消息面板**
    // 场景的前置（perf 夹具不起会话）；本脚本只验状态栏面板，不需要它，也就不该被它卡住。
    // boot() 本身不导航，所以这里补上它平时由 app.boot() 做的两步（导航 + 视口）。
    await app.page.navigate(app.origin + '/');
    await app.page.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(700);
    const baseline = await app.page.eval(asBody(PROBE));

    // 2) 装被测模块 + 喂合成名册（(b) 模式：不依赖 studio 接线）
    const armed = await app.page.evalAsync(ARM);
    const badgeVisible = await app.page.eval(asBody('return document.getElementById("slSwarm") && !document.getElementById("slSwarm").classList.contains("hidden");'));
    const active = await app.page.eval(asBody(PROBE));

    // 3) 点开徽标 → 弹层 + 裁剪风险
    await app.page.eval(asBody('document.getElementById("slSwarm").click(); return true;'));
    await sleep(300);
    const opened = await app.page.eval(asBody(PROBE));
    const clipping = await app.page.eval(asBody(CLIPPING));

    // 4) 截图：整页 + 只裁 statusline 那一条（弹层向上弹出，整页图里可能贴边）
    const full = await app.page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const sl = opened.statusline.rect;
    const clip = {
      x: Math.max(0, sl.left - 8),
      y: Math.max(0, sl.top - 300),
      width: Math.min(WIDTH, sl.right - sl.left + 16),
      height: Math.min(HEIGHT, 340),
      scale: 1,
    };
    const cropped = await app.page.send('Page.captureScreenshot', { format: 'png', clip: clip });

    return {
      label: LABEL, port: PORT, cdpPort: CDP_PORT, viewport: { w: WIDTH, h: HEIGHT },
      armed: armed, badgeVisible: badgeVisible, baseline: baseline, active: active, opened: opened, clipping: clipping,
      shots: { full: full.data, statusline: cropped.data, clip: clip },
      consoleErrors: app.consoleErrors || [],
    };
  } finally {
    await app.close();
  }
}

const out = await run();
mkdirSync(RESULTS, { recursive: true });
writeFileSync(join(RESULTS, 'swarm-panel-' + LABEL + '.json'), JSON.stringify(out, null, 1));
writeFileSync(join(RESULTS, 'swarm-panel-' + LABEL + '.md'), renderMd(out));
if (out.shots.full) writeFileSync(join(RESULTS, 'swarm-panel-' + LABEL + '.png'), Buffer.from(out.shots.full, 'base64'));
if (out.shots.statusline) writeFileSync(join(RESULTS, 'swarm-panel-' + LABEL + '-statusline.png'), Buffer.from(out.shots.statusline, 'base64'));

const pass = assess(out);
const clippedName = out.clipping.clippedBy === null ? null : (out.clipping.clippedBy.id || out.clipping.clippedBy.cls || out.clipping.clippedBy.tag);
console.log(JSON.stringify({
  label: out.label,
  badgeRect: out.active.badge.rect,
  badgeDisplay: dispOf(out.active.badge.vis),
  badgeText: out.active.badge.text,
  popupRect: out.clipping.rect,
  fullyInViewport: out.clipping.fullyInViewport,
  cutterCount: (out.clipping.cutters || []).length,
  clippedBy: clippedName,
  groups: out.opened.popup.groups,
  pass: pass,
  consoleErrors: out.consoleErrors.length,
}, null, 1));
if (!pass.geometry || !pass.visibility || !pass.popupGeometry || !pass.notClipped) process.exitCode = 1;
