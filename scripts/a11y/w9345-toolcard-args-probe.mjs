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
/** 结果正文（短、且**不含省略号**）—— 用来证明「删了摘要行/补了标签，内容一个字没少」。 */
const RESULT_TEXT = 'export const a = 1;\nexport const b = 2;';

/**
 * ★ 主场景（W9348）：**一张已完成的 run_shell 卡** —— 完整参数块带「参数」标签、
 *   完整结果块带「结果」标签，两块内容与夹具**逐字相等**；
 *   外加**一张运行中的卡**：**没有**「结果」标签，也没有空的结果块。
 */
const SETUP = `(async function () {
  var V = await import('/src/ui/viewctx.ts');
  var M = await import('/src/ui/messages.ts');
  var T = await import('/src/ui/toolcards.ts');
  var pane = V.ensurePane('w9345/main', 'session', 'W9345 取证');
  V.activatePane('w9345/main', 'session', 'W9345 取证');
  M.addUserMessage(pane, '跑一下命令');

  // ① 已完成卡（run_shell）：有参数块 + 结果块
  T.pushToolCard(pane, { id: 's1', name: 'run_shell', args: { command: 'echo hi' } });
  T.applyToolResult(pane, { id: 's1', ok: true, value: ${JSON.stringify(RESULT_TEXT)} });
  // ② 运行中卡：只有参数块，**没有**结果块
  T.pushToolCard(pane, { id: 's2', name: 'run_shell', args: { command: 'sleep 100' } });

  // 展开两张（折叠态本来看不到 body）。
  var cards = Array.from(document.querySelectorAll('.toolcard'));
  for (var c of cards) c.open = true;
  var done = cards[0];
  window.__w9345 = { V: V, T: T, pane: pane, card: done };
  await new Promise(function (r) { setTimeout(r, 200); });
  return { open: done.open === true, cards: cards.length };
})()`;

/**
 * 量一张卡：标签是否可见、是否与块关联（aria-labelledby 指向真实标签节点）、
 * 块内容是否逐字等于夹具。**不钉字号/颜色/坐标**（铁律 11）——
 * 只钉「标签看得见」+「标签与块绑定」+「内容逐字」三个后果。
 */
const CARD = (idx) => `(function () {
  var cards = Array.from(document.querySelectorAll('.toolcard'));
  var card = cards[${idx}];
  if (!card) return { missing: true };
  var body = card.querySelector('.toolcard-body');
  if (!body) return { missing: true, noBody: true };
  var read = function (blockCls) {
    var block = body.querySelector('.' + blockCls);
    if (!block) return { present: false };
    var by = block.getAttribute('aria-labelledby');
    var label = by ? card.ownerDocument.getElementById(by) : null;
    var lr = label ? label.getBoundingClientRect() : null;
    var br = block.getBoundingClientRect();
    // ★ 标签可能**不存在**（变异：标签被抽掉）—— 那时按「不可见」如实记，不要崩：
    //   getComputedStyle(null) 会抛，探针一崩就看不到别的断言结果了。
    var cs = label ? getComputedStyle(label) : null;
    // ★ 「不压首行」要量的是**首行**（正文第一行的行盒），不是块的 border box ——
    //   标签**本来就该**落在块的上内边距带里（那是不额外占一行的代价），
    //   拿标签底 vs 块顶去比，量的是「标签在不在块里」而不是「有没有压住字」。
    //   ★ 首行怎么取：工具卡的 pre 里是**纯文本**（没有 .cl 行元素、也没有 code 子节点）
    //   ⇒ 用 Range 框住第一段文本拿它的真实行盒（实测踩过：querySelector 落空时
    //   量到的是 pre 自己，padTop 恒为 0，断言假红）。
    var firstLine = function (blk) {
      var walker = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);
      var n = walker.nextNode();
      if (!n || (n.nodeValue || '') === '') return blk.getBoundingClientRect();
      var r = document.createRange();
      r.setStart(n, 0);
      r.setEnd(n, Math.min(1, n.nodeValue.length)); // 第一行的第一个字符足够框出该行
      return r.getBoundingClientRect();
    };
    var fr = firstLine(block);
    // 块的上内边距带高度 = 正文起点 - 块顶（标签落脚的地方）
    var padTop = Math.round(fr.top - br.top);
    return {
      present: true,
      labelText: label ? label.textContent : null,
      labelVisible: lr !== null && lr.width > 0 && lr.height > 0 &&
        cs !== null && cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0,
      labelW: lr ? Math.round(lr.width) : 0, labelH: lr ? Math.round(lr.height) : 0,
      labelledBy: by, labelFound: label !== null,
      labelBottom: lr ? Math.round(lr.bottom) : null,
      blockTop: Math.round(br.top),
      firstLineTop: Math.round(fr.top),
      padTop: padTop,
      // 标签带**完全在首行上方**（= 不压首行；标签底 ≤ 首行顶）
      labelAboveFirstLine: lr !== null && lr.bottom <= fr.top + 1,
      // 标签**不产生额外行高**：块的上内边距带高度必须容得下标签（否则就是压字了）
      bandFitsLabel: lr !== null && padTop >= Math.round(lr.height) - 1,
      text: (block.innerText || block.textContent || '').trim(),
    };
  };
  return { missing: false, args: read('tool-args'), out: read('tool-out'),
           running: card.classList.contains('running'),
           state: (card.querySelector('.ts-label') || {}).textContent || '' };
})()`;

/**
 * 一张卡的 body：截断行**都**没了 + 两行摘要行都不在（截断行不许复活）。
 * 与 CARD 分开：CARD 量「标签 + 关联 + 内容」，这里量「不该有的东西确实没了」。
 */
const BODY = `(function () {
  var body = document.querySelector('.toolcard-body');
  if (!body) return { missing: true };
  var cs = getComputedStyle(body);
  var visible = cs.display !== 'none' && body.getBoundingClientRect().height > 0;
  var text = body.innerText || body.textContent || '';
  var lines = text.split('\\n').map(function (s) { return s.trim(); })
                    .filter(function (s) { return s.length > 0; });
  return {
    missing: false, visible: visible,
    lineCount: lines.length,
    ellipsisLines: lines.filter(function (s) { return s.indexOf('…') !== -1; }),
    argsPreview: body.querySelector('.toolcard-args-preview') !== null,
    resultPreview: body.querySelector('.toolcard-result-preview') !== null,
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
    P.record('scenarioReady', setup.open === true && setup.cards === 2,
      `主场景就位：${setup.cards} 张 run_shell 卡（① 已完成 ② 运行中），均已展开`);

    // ---- ① 截断行保持删除（W9345 的诉求不许被这一轮改回去） ----
    const body = await ev(BODY);
    out.raw.body = body;
    P.record('truncationStillGone', body.missing === false && body.visible === true &&
      body.ellipsisLines.length === 0 && body.argsPreview === false && body.resultPreview === false,
      `展开后可见 ${body.lineCount} 行；带省略号的行 = ${JSON.stringify(body.ellipsisLines)}；` +
      `参数摘要节点还在=${body.argsPreview}、结果摘要节点还在=${body.resultPreview}（截断渲染必须仍然删除）`);

    // ---- ② W9348 主场景：已完成的卡，两个块各带一个**可见且关联**的标签 ----
    const done = await ev(CARD(0));
    out.raw.doneCard = done;
    P.record('labelsVisible', done.missing === false &&
      done.args.present === true && done.out.present === true &&
      done.args.labelVisible === true && done.out.labelVisible === true,
      `参数标签=「${done.args.labelText}」可见=${done.args.labelVisible}（${done.args.labelW}×${done.args.labelH}px）；` +
      `结果标签=「${done.out.labelText}」可见=${done.out.labelVisible}（${done.out.labelW}×${done.out.labelH}px）`);

    P.record('labelsAssociated', done.args.labelFound === true && done.out.labelFound === true &&
      typeof done.args.labelledBy === 'string' && done.args.labelledBy.length > 0 &&
      typeof done.out.labelledBy === 'string' && done.out.labelledBy.length > 0 &&
      done.args.labelledBy !== done.out.labelledBy,
      `aria-labelledby：参数块→${JSON.stringify(done.args.labelledBy)}（标签存在=${done.args.labelFound}）、` +
      `结果块→${JSON.stringify(done.out.labelledBy)}（标签存在=${done.out.labelFound}）；两个 id 不同=${done.args.labelledBy !== done.out.labelledBy}`);

    // ---- ③ 标签**不占额外一行、不压首行**（主人明确要求「别占大量空白」） ----
    P.record('labelsNoOverlap', done.args.labelAboveFirstLine === true && done.out.labelAboveFirstLine === true &&
      done.args.bandFitsLabel === true && done.out.bandFitsLabel === true,
      `参数：标签底 ${done.args.labelBottom} ≤ 首行顶 ${done.args.firstLineTop}（上内边距带 ${done.args.padTop}px 装得下 ${done.args.labelH}px 标签）` +
      `；结果：标签底 ${done.out.labelBottom} ≤ 首行顶 ${done.out.firstLineTop}（带 ${done.out.padTop}px / 标签 ${done.out.labelH}px）` +
      ` ⇒ 不压首行、也不多占一行`);

    // ---- ④ 两块内容与夹具**逐字相等**（补标签不许动内容） ----
    const expectArgs = JSON.stringify({ command: 'echo hi' });
    P.record('contentVerbatim', done.args.text === expectArgs && done.out.text === RESULT_TEXT,
      `参数块 = ${JSON.stringify(done.args.text)}（夹具 ${JSON.stringify(expectArgs)}）；` +
      `结果块 = ${JSON.stringify(done.out.text)}（夹具 ${JSON.stringify(RESULT_TEXT)}）`);

    // ---- ⑤ 运行中的卡：**没有**「结果」标签，也没有空的结果块 ----
    const running = await ev(CARD(1));
    out.raw.runningCard = running;
    P.record('noOrphanResultLabel', running.missing === false && running.running === true &&
      running.out.present === false && running.args.present === true && running.args.labelVisible === true,
      `运行中卡（状态 pill=「${running.state}」）：结果块 present=${running.out.present}（应为 false）、` +
      `结果标签 present=${running.out.present}（同源，故也无空标签）；参数块带标签=${running.args.labelVisible}`);

    // ---- ⑥ 复制语义不许变（chat.tool.copyHint：复制参数与结果 JSON） ----
    await input.click('.toolcard-copy', { hover: false });
    await sleep(300);
    const clip = await ev(CLIP);
    out.raw.clip = { ok: clip.ok, len: clip.ok ? clip.text.length : 0, hasArgs: clip.ok ? clip.text.includes(expectArgs) : false };
    P.record('copyUnchanged', clip.ok === true && clip.text.includes(expectArgs),
      `点复制后剪贴板 ${clip.ok ? `长度 ${clip.text.length}` : '读取失败'}；` +
      `仍含参数全文=${clip.ok ? clip.text.includes(expectArgs) : false}（copyHint「复制参数与结果（JSON）」未变）`);

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
