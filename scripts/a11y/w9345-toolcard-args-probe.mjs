#!/usr/bin/env node
// ============================================================================
// scripts/a11y/w9345-toolcard-args-probe.mjs — W9345「工具卡参数重复」真机取证
// ----------------------------------------------------------------------------
// ★ 主场景（**只承诺覆盖它**）：一个 `read_file` 工具块、**参数很长**时，展开后
//     **截断那一行不再出现**，而**完整参数仍在**（可展开、可复制）。
//
//   为什么要量真机而不在 jsdom 里断言：用户报障是**看到的两个盒子**（一行省略号
//   + 一块完整 JSON）。「重复」是**视觉事实**：两行同时可见、文字重叠成两行。
//   jsdom 没有排版，只能证明「某个节点不存在」—— 那不等于「用户看到的不重复」。
//
// ★ 铁律 11：断言只守**后果**，不钉机制。守三条：
//   ① 展开后的 body 里，参数**全文只出现一次**（重复 = 用户报障）；
//   ② **完整**参数块还在（不是「删了重复的那份就完事」—— 那会把可复制的内容删没）；
//   ③ 复制出来的内容**仍含参数全文**（chat.tool.copyHint 的语义不许被改坏）。
// 不钉 `.tool-args` / `.toolcard-args-preview` 之外的任何排版常量。
//
// 用法（前置：Vite dev server 起着）：
//   pnpm --dir apps/web dev --port 3787 --strictPort
//   node scripts/a11y/w9345-toolcard-args-probe.mjs
// 产物：$W9345_SHOTS/probe.json + 若干 PNG（默认 tmp/w9345-probe）。
//
// ★ 刻意不进 `pnpm check`（与 w9336 / w9344 同一取向）：它需要 Vite + Chrome。
//   确定性断言在 tests/w9345-toolcard-args-dup.test.ts 与 tools/check-fold-default.mjs。
// ============================================================================
import { join } from 'node:path';
import {
  repoRoot, startFixture, launchProbeChrome, createProbe, createInput, sleep,
} from './lib/harness.mjs';

const VITE = process.env.W9345_VITE ?? process.env.W9111_VITE ?? 'http://127.0.0.1:3787';
const REPO = repoRoot('W9345_REPO');
const SHOTS = process.env.W9345_SHOTS ?? join(REPO, 'tmp', 'w9345-probe');
const PORT = Number(process.env.W9345_PORT ?? 3845);
const CDP = Number(process.env.W9345_CDP_PORT ?? 9495);

/** 主场景的参数：**长路径** ⇒ 摘要必然被截断 + 省略号（复现用户截图的形态）。 */
const LONG_PATH = 'D:\\tools\\celestea-studio\\results\\audit4\\probe\\very-long-directory-name\\index.ts';
const ARGS = JSON.stringify({ path: LONG_PATH, start: 1, limit: 2000 });

/** 摆出主场景：真实模块造一个 read_file 工具块（参数长），并**展开**它。 */
const SETUP = `(async function () {
  var V = await import('/src/ui/viewctx.ts');
  var M = await import('/src/ui/messages.ts');
  var T = await import('/src/ui/toolcards.ts');
  var pane = V.ensurePane('w9345/main', 'session', 'W9345 取证');
  V.activatePane('w9345/main', 'session', 'W9345 取证');
  M.addUserMessage(pane, '读一下那个文件');
  var col = T.pushToolCard(pane, { id: 'r1', name: 'read_file', args: ${JSON.stringify(JSON.parse(ARGS))} });
  // ★ 结果里**不放省略号**：本探针判的是「带省略号的那一行」，
  //   夹具自己带省略号会让断言把结果行误判成参数摘要行（实测踩到：探针假红）。
  T.applyToolResult(pane, { id: 'r1', ok: true, value: 'export const a = 1;' });
  // 展开：折叠态本来就看不到 body，重复只在展开时可见。
  var card = col.querySelector('.toolcard');
  card.open = true;
  window.__w9345 = { V: V, T: T, pane: pane, card: card };
  await new Promise(function (r) { setTimeout(r, 200); });
  return { open: card.open === true, args: ${JSON.stringify(ARGS)} };
})()`;

/** 展开态的 body：可见文本行、参数出现次数、完整块是否还在。 */
const BODY = `(function () {
  var body = document.querySelector('.toolcard-body');
  if (!body) return { missing: true };
  var cs = getComputedStyle(body);
  // **可见**（body 在折叠态被 display:none 藏起来）—— 量的是用户真的看得见的。
  var visible = cs.display !== 'none' && body.getBoundingClientRect().height > 0;
  var text = body.innerText || body.textContent || '';
  var lines = text.split('\\n').map(function (s) { return s.trim(); })
                    .filter(function (s) { return s.length > 0; });
  // 参数全文在这张卡的**整张 DOM 文本**里出现几次（用户能看到的范围）。
  var cardText = (document.querySelector('.toolcard').innerText || '');
  var args = ${JSON.stringify(ARGS)};
  var occurrences = cardText.split(args).length - 1;
  var pre = body.querySelector('pre');
  var preText = pre ? (pre.innerText || pre.textContent || '').trim() : null;
  return {
    missing: false, visible: visible,
    lineCount: lines.length,
    lines: lines.slice(0, 6),
    // 带省略号的那一行（用户截图里被点名要删的那行）
    ellipsisLines: lines.filter(function (s) { return s.indexOf('…') !== -1; }),
    argsOccurrences: occurrences,
    fullArgsPresent: preText !== null && preText.indexOf(args) !== -1,
    fullArgsLen: preText === null ? 0 : preText.length,
    argsLen: args.length,
    preVisible: pre ? getComputedStyle(pre).display !== 'none' : false,
    hasResultPreview: body.querySelector('.toolcard-result-preview') !== null,
    hasPreviewBtn: body.querySelector('.toolcard-preview') !== null,
  };
})()`;

/** 点复制按钮（真鼠标），回报写进剪贴板的内容。 */
const CLIP = `(async function () {
  try { return { ok: true, text: await navigator.clipboard.readText() }; }
  catch (e) { return { ok: false, err: String(e) }; }
})()`;

// verdict 表 / 汇总 / 退出码都在 harness 里。
const P = createProbe({ title: 'W9345 真机取证', shots: SHOTS, pad: 24 });

const main = async () => {
  const out = P.out;
  const fixture = await startFixture({
    port: PORT, label: 'w9345', repo: REPO, vite: VITE, session: { title: 'W9345 取证' },
  });
  const browser = await launchProbeChrome({ port: CDP, width: 1440, height: 900 });
  const { page } = browser;
  const consoleErrors = browser.consoleErrors;
  out.consoleErrors = consoleErrors;
  const ev = (s) => page.eval(s);
  const input = createInput(page);

  try {
    await page.navigate('http://127.0.0.1:' + PORT + '/');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(2200);
    // 剪贴板读需要权限；给 headless 授上，否则 §复制量不到。
    await page.send('Browser.grantPermissions', { origin: 'http://127.0.0.1:' + PORT, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    const setup = await ev(SETUP);
    out.raw.setup = setup;
    P.record('scenarioReady', setup.open === true, `read_file 工具块已建并展开（open=${setup.open}），参数长度 ${setup.args.length} 字符`);

    // ---- ① 用户报障的那一行（截断+省略号）不再出现 ----
    const body = await ev(BODY);
    out.raw.body = body;
    P.record('noTruncatedDup', body.missing === false && body.visible === true &&
      body.ellipsisLines.length === 0,
      `展开后可见 ${body.lineCount} 行；带省略号的行 = ${JSON.stringify(body.ellipsisLines)}（用户截图里被点名删掉的那一行）`);

    // ---- ② 完整参数仍在，且**只印一次** ----
    P.record('fullArgsOnce', body.fullArgsPresent === true && body.argsOccurrences === 1 && body.preVisible === true,
      `完整参数块可见=${body.preVisible}、长度 ${body.fullArgsLen}（参数全文 ${body.argsLen}）；` +
      `参数全文在这张卡里出现 ${body.argsOccurrences} 次（=1 才算不重复）`);

    // ---- ③ 复制语义不许变（chat.tool.copyHint：复制参数与结果 JSON） ----
    await input.click('.toolcard-copy', { hover: false });
    await sleep(300);
    const clip = await ev(CLIP);
    out.raw.clip = { ok: clip.ok, len: clip.ok ? clip.text.length : 0, hasArgs: clip.ok ? clip.text.includes(ARGS) : false };
    P.record('copyUnchanged', clip.ok === true && clip.text.includes(ARGS),
      `点复制后剪贴板 ${clip.ok ? `长度 ${clip.text.length}` : '读取失败'}；` +
      `仍含参数全文=${clip.ok ? clip.text.includes(ARGS) : false}（copyHint「复制参数与结果（JSON）」未因删行而变）`);

    // ---- ④ 可访问性不许丢（工具卡仍是 summary/可展开/有名字） ----
    await page.send('DOM.enable');
    await page.send('Accessibility.enable');
    const domRoot = (await page.send('DOM.getDocument', { depth: -1 })).root;
    const id = (await page.send('DOM.querySelector', { nodeId: domRoot.nodeId, selector: '.toolcard' })).nodeId;
    const ax = id ? (await page.send('Accessibility.getPartialAXTree', { nodeId: id, fetchRelatives: false })).nodes ?? [] : [];
    const headAx = ax.map((n) => ({ role: n.role?.value ?? null, name: n.name?.value ?? null, ignored: n.ignored === true }));
    out.raw.ax = headAx;
    P.record('axTree', headAx.some((n) => n.ignored !== true && (n.role === 'group' || n.role === 'button' || n.role === 'DisclosureTriangle')),
      `工具卡在 ax 树里 = ${JSON.stringify(headAx.slice(0, 3))}（可展开控件仍在，删一行没删掉语义）`);

    // ---- ⑤ 视觉证据（形态本身不是断言）----
    for (const theme of ['mono', 'claude']) {
      await ev(`(function () { document.documentElement.dataset.theme = ${JSON.stringify(theme)}; return true; })()`);
      await sleep(120);
      await P.shots.save(page, 'toolcard-' + theme + '.png');
    }
    const clipRect = await ev(`(function () {
      var c = document.querySelector('.toolcard').getBoundingClientRect();
      return { x: Math.max(0, Math.round(c.x) - 8), y: Math.max(0, Math.round(c.y) - 8),
               width: Math.round(c.width) + 16, height: Math.min(320, Math.round(c.height) + 16), scale: 1 };
    })()`);
    if (clipRect.width > 0 && clipRect.height > 0) await P.shots.save(page, 'toolcard-closeup.png', { clip: clipRect });

    out.consoleErrors = consoleErrors;
    await P.finish({
      heading: 'W9345 真机取证（主场景：read_file 长参数的展开态）',
      pad: 24, jsonPath: join(SHOTS, 'probe.json'),
      trailer: ['产物：' + SHOTS], exitCodeOnFail: 1,
    });
  } finally {
    await browser.close();
    await fixture.close();
  }
};

main().catch((err) => { console.error(err); process.exit(1); });
