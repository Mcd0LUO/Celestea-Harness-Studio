#!/usr/bin/env node
// ============================================================================
// scripts/a11y/w9399-lexical-probe.mjs — W9399：Lexical 输入层 + Enter/IME 车道 **真机取证**
// ----------------------------------------------------------------------------
// 要证明的两件事**同时**成立（缺一即失败）：
//   A. 打字真的能进模型：真键盘事件（Input.insertText / Input.dispatchKeyEvent）敲进去的字
//      必须出现在 #input 的可见文本与适配缝的规范文本里（W9394 接的 registerRichText 输入层）。
//   B. 本仓的 Enter / IME 车道不被输入层打红：Shift+Enter 与组合中的按键**不** preventDefault
//      （交回浏览器），而 Enter 发送 / 触摸换行 / 桌面组合 swallow 逐字不变。
//
// 为什么必须真机：jsdom 的 InputEvent 没有 getTargetRanges（core 的 beforeinput 层不启用），
//   组合（compositionstart/update/end）与浏览器默认动作在 jsdom 里都造不出来 —— 单测只能钉
//   「命令有处理器」，钉不了「字真的进了 DOM / keydown 的 defaultPrevented 真的是 false」。
//
// 前置：Vite dev server 在 3787（apps/web 的 /src/** 由 harness 反代过去）。
//   pnpm --dir apps/web dev --port 3787 --strictPort
// 用法：node scripts/a11y/w9399-lexical-probe.mjs
// ============================================================================
import { join } from 'node:path';
import {
  createInput, createProbe, launchProbeChrome, repoRoot, sleep, startFixture,
} from './lib/harness.mjs';

const REPO = repoRoot('W9399_REPO');
const SHOTS = join(REPO, 'tmp', 'w9399-lexical-probe');
const PORT = Number(process.env.W9399_PORT ?? 3899);
const CDP_PORT = Number(process.env.W9399_CDP_PORT ?? 9399);

// ---- 夹具：记录 POST /api/turn 的请求体（「Enter 发送」读的是**请求本身**）---------
const turns = [];
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += String(c); });
    req.on('end', () => resolve(b));
  });
}

const fixture = await startFixture({
  port: PORT,
  label: 'w9399',
  routes: {
    '/api/__w9399/reset': ({ json }) => { turns.length = 0; return json(200, { ok: true }); },
    '/api/__w9399/turns': ({ json }) => json(200, { turns }),
    '/api/turn': async ({ req, json }) => {
      if (req.method !== 'POST') return false;
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw === '' ? '{}' : raw); } catch { body = { __unparsed: raw }; }
      turns.push(body);
      return json(200, { ok: true, session: 'w9399/main', turn: 1, status: 'RUNNING', injected: false, placement: 'context' });
    },
  },
});

const chrome = await launchProbeChrome({ port: CDP_PORT, width: 1440, height: 900 });
const page = chrome.page;
const P = createProbe({ title: 'W9399 · Lexical 输入层 + Enter/IME 车道（真机 1440x900）', shots: SHOTS });
const input = createInput(page);

const js = (body) => page.eval('(function(){ ' + body + ' })()');
const jsAsync = (body) => page.evalAsync(body);
const composer = (expr) => jsAsync("const m = await import('/src/ui/composer/index.ts'); " + expr);
const popup = (expr) => jsAsync("const m = await import('/src/ui/commands/popup.ts'); " + expr);
const visibleText = () => js("var el=document.getElementById('input'); return el ? el.textContent : null;");
const canonical = () => composer('return m.canonicalText();');

async function waitFor(body, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await js(body)) return true;
    await sleep(80);
  }
  throw new Error('waitFor timeout: ' + label);
}

async function focusInput() {
  await input.click('#input');
  await sleep(120);
  return js("return document.activeElement === document.getElementById('input');");
}

async function clearInput() {
  await composer("m.clearComposer(); return true;");
  await sleep(80);
}

const MODS = { shift: 8, ctrl: 2, meta: 4 };
async function keyEvent(key, code, vk, opts = {}) {
  const mods = opts.modifiers ?? 0;
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods };
  const withText = opts.text === undefined ? {} : { text: opts.text };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...withText });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
const pressEnter = (opts = {}) => keyEvent('Enter', 'Enter', 13, { text: '\r', ...opts });
const pressArrowDown = () => keyEvent('ArrowDown', 'ArrowDown', 40, { modifiers: 0 });
const lastKey = () => js("var k=window.__w9399.keys; return k.length ? k[k.length-1] : null;");
const resetKeys = () => js("window.__w9399.keys.length = 0; return true;");

let step = 0;
const shot = async (name) => {
  step += 1;
  return P.shots.save(page, String(step).padStart(2, '0') + '-' + name + '.png');
};

try {
  // ---- 启动 ------------------------------------------------------------------
  await page.navigate(fixture.origin + '/');
  await waitFor("return document.querySelector('.sess-pane:not([hidden])') !== null;", 'pane ready', 25000);
  await waitFor("var el=document.getElementById('input'); return !!el && !!el.__lexicalEditor && el.getAttribute('contenteditable')==='true';", 'composer mounted', 15000);
  await js("window.__w9399 = { keys: [] };"
    + " window.addEventListener('keydown', function(e){ window.__w9399.keys.push({"
    + " key: e.key, shiftKey: e.shiftKey, composing: e.isComposing === true, prevented: e.defaultPrevented }); }); return true;");
  const focused = await focusInput();
  P.record('editor-focusable', focused, 'document.activeElement === #input: ' + focused);

  // ---- ① 打字：真键盘事件 → 可见文本就是 hello ---------------------------------
  await clearInput();
  await focusInput();
  await page.send('Input.insertText', { text: 'hello' });
  await sleep(250);
  const typedVisible = await visibleText();
  const typedCanonical = await canonical();
  P.record('type-hello-visible', typedVisible === 'hello',
    '#input.textContent=' + JSON.stringify(typedVisible) + ' canonical=' + JSON.stringify(typedCanonical));
  await shot('type-hello');

  // ---- ② 中文 IME：组合提交后文本出现、组合期按键不被抢 --------------------------
  await clearInput();
  await focusInput();
  await page.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 });
  await sleep(300);
  const composingDom = await visibleText();
  await resetKeys();
  await pressArrowDown(); // 组合中的候选翻页键：不许被本仓/编辑器抢
  await sleep(150);
  const composeKey = await lastKey();
  P.record('ime-composing-key-not-stolen', composeKey !== null && composeKey.prevented === false,
    '组合中 ArrowDown: ' + JSON.stringify(composeKey) + ' DOM=' + JSON.stringify(composingDom));
  // 组合中的 Enter：不得发送（桌面组合的旧伤疤 = 半截拼音被发出）
  const turnsBeforeIme = turns.length;
  await resetKeys();
  await pressEnter();
  await sleep(350);
  const enterKey = await lastKey();
  const sentDuringCompose = turns.length !== turnsBeforeIme;
  P.record('ime-composing-enter-not-sent', sentDuringCompose === false,
    '组合中 Enter: ' + JSON.stringify(enterKey) + ' turnsDelta=' + (turns.length - turnsBeforeIme));
  // 提交组合：insertText 走 insertFromComposition/insertText
  await page.send('Input.insertText', { text: '你好' });
  await sleep(350);
  const imeText = await visibleText();
  const imeCanonical = await canonical();
  P.record('ime-commit-text-present', (imeText ?? '').includes('你好'),
    '#input.textContent=' + JSON.stringify(imeText) + ' canonical=' + JSON.stringify(imeCanonical));
  await shot('ime-composition');

  // ---- ③ Enter 发送 / Shift+Enter 换行（defaultPrevented === false）-------------
  await clearInput();
  await focusInput();
  await page.send('Input.insertText', { text: 'hello-send' });
  await sleep(200);
  await js("fetch('/api/__w9399/reset'); return true;");
  await sleep(100);
  await resetKeys();
  await pressEnter();
  await sleep(500);
  const sentBody = turns.length === 1 ? turns[0] : null;
  P.record('enter-sends', sentBody !== null && String(sentBody.input ?? '').includes('hello-send'),
    'POST /api/turn body=' + JSON.stringify(sentBody));
  await shot('enter-send');

  await clearInput();
  await focusInput();
  await page.send('Input.insertText', { text: 'line1' });
  await sleep(200);
  await js("fetch('/api/__w9399/reset'); return true;");
  await sleep(100);
  await resetKeys();
  await pressEnter({ modifiers: MODS.shift });
  await sleep(400);
  const shiftKey = await lastKey();
  const shiftText = await canonical();
  P.record('shift-enter-native', shiftKey !== null && shiftKey.prevented === false && turns.length === 0,
    'keydown=' + JSON.stringify(shiftKey) + ' turns=' + turns.length + ' canonical=' + JSON.stringify(shiftText));
  P.record('shift-enter-inserts-newline', (shiftText ?? '').includes('\n'),
    'canonical=' + JSON.stringify(shiftText));
  await shot('shift-enter-newline');

  // ---- ④ 补全框：'/' 弹出，按一次 ↓ 只走一格 -----------------------------------
  await clearInput();
  await focusInput();
  await page.send('Input.insertText', { text: '/' });
  await sleep(150);
  await waitFor("var p=document.getElementById('cmdPopup'); return !!p && !p.classList.contains('hidden') && p.querySelectorAll('.cmd-row').length >= 3;", 'popup visible', 8000);
  const labels = await js("return Array.prototype.map.call(document.querySelectorAll('#cmdPopup .cmd-row .cmd-name'), function(n){ return n.textContent; });");
  const active0 = await popup('return m.activeItemLabel();');
  await resetKeys();
  await pressArrowDown();
  await sleep(200);
  const active1 = await popup('return m.activeItemLabel();');
  const downKey = await lastKey();
  const idx0 = labels.indexOf(active0);
  const idx1 = labels.indexOf(active1);
  P.record('popup-arrow-one-step', idx0 >= 0 && idx1 === idx0 + 1,
    'labels=' + JSON.stringify(labels) + ' active0=' + JSON.stringify(active0) + ' active1=' + JSON.stringify(active1) + ' keydown=' + JSON.stringify(downKey));
  await shot('popup-arrowdown');

  // ---- ⑤ chip 投影 = 规范形态 ---------------------------------------------------
  // 真路径：补全框里 Enter 选中当前项 ⇒ 插入 chip（applyGesture）。
  await resetKeys();
  await pressEnter();
  await sleep(300);
  const chipCanonical = await canonical();
  const chipDom = await js("return Array.prototype.map.call(document.querySelectorAll('#input .composer-chip'), function(n){ return { kind: n.getAttribute('data-chip-kind'), name: n.getAttribute('data-chip-name'), text: n.textContent }; });");
  const expectedChip = active1 + ' ';
  P.record('chip-popup-projection', chipCanonical === expectedChip && chipDom.length >= 1,
    'canonical=' + JSON.stringify(chipCanonical) + ' expected=' + JSON.stringify(expectedChip) + ' dom=' + JSON.stringify(chipDom));
  await shot('chip-command');

  // API 路径：/skill: /mcp: @mention 三种 kind 的投影（适配缝的公开插入口）。
  await clearInput();
  const inserts = await composer(
    "var out={};"
    + " out.skill = m.insertComposerChip({ kind:'skill', name:'review', start:0, end:0, trailing:' ' });"
    + " out.afterSkill = m.canonicalText();"
    + " m.clearComposer();"
    + " out.mcp = m.insertComposerChip({ kind:'mcp', name:'memory', start:0, end:0, trailing:' ' });"
    + " out.afterMcp = m.canonicalText();"
    + " m.clearComposer();"
    + " out.mention = m.insertComposerChip({ kind:'mention', name:'src/ui/send.ts', start:0, end:0, trailing:'' });"
    + " out.afterMention = m.canonicalText();"
    + " return out;",
  );
  const kindsOk = inserts.skill === true && inserts.mcp === true && inserts.mention === true
    && inserts.afterSkill === '/skill:review ' && inserts.afterMcp === '/mcp:memory ' && inserts.afterMention === '@src/ui/send.ts';
  P.record('chip-kinds-projection', kindsOk, JSON.stringify(inserts));
  await shot('chip-kinds');

  P.out.consoleErrors = chrome.consoleErrors;
} catch (err) {
  P.record('scenario-error', false, String((err && err.stack) || err));
  try { await shot('error-state'); } catch { /* 截图失败不掩盖原始错误 */ }
} finally {
  await chrome.close();
  await fixture.close();
}

await P.finish({ heading: 'W9399 真机取证', pad: 34, exitCodeOnFail: 1 });
