#!/usr/bin/env node
// ============================================================================
// scripts/a11y/w2058-chat-fold-probe.mjs — W2058 真机：**聊天侧折叠必须完好**
// ----------------------------------------------------------------------------
// 任务 A 的范围是 (a) 只取消**预览**里的折叠。这条探针守反面：
//   聊天正文里一个 >30 行的代码块，**必须仍然**有「展开」按钮且默认折叠。
//   同一次运行里再开一个预览，断言那边**没有**折叠按钮 —— 两侧在同一页面、
//   同一份增强链、同一时刻对照，排除「code-extras 整个没挂」这种假绿。
//
// ★ W9340：本探针**只出证据、不出 verdict**（它是同页对照快照，不是验收门禁）——
//   脚手架（静态 fixture 服务端 / Vite 反代 / 截图落盘 / 汇总与退出码）已收进
//   scripts/a11y/lib/harness.mjs。原先那句「请求处理器里不许有同步阻塞调用」（W9323）
//   现在由 harness 结构性保证。
// ★ 同一轮顺手修掉一个**只在 Windows 上犯**的真 bug：原来自带服务端用
//   `new URL('../..', import.meta.url).pathname` 取仓库根 ⇒ `apps/web/index.html`
//   永远 404、页面其实是 404 文本 ⇒ 聊天侧读不到 .content（`contentFound: false`）。
//   harness 的 repoRoot() 一律走 fileURLToPath。
//
// 用法：W9111_CHROME=<chrome> node scripts/a11y/w2058-chat-fold-probe.mjs
// ============================================================================
import { dirname, join } from 'node:path';
import {
  repoRoot, startFixture, fsRoutes, launchProbeChrome, createProbe, sleep,
} from './lib/harness.mjs';

const REPO = repoRoot('W2058_REPO');
const TARGET = process.env.W2058_TARGET ?? join(REPO, 'docs', 'ARCHITECTURE.md');
const SHOTS = process.env.W2058_SHOTS ?? '/tmp/w2058-preview';
const PORT = Number(process.env.W2058_PORT ?? 3817);
const CDP = Number(process.env.W2058_CDP_PORT ?? 9477);

/** 聊天夹具：一条 assistant 消息，正文里一个 40 行的 fenced 代码块。 */
const CODE = Array.from({ length: 40 }, (_, i) => 'const line' + i + ' = ' + i + ';').join('\n');
const BODY = '这里是一段很长的示例：\n\n```ts\n' + CODE + '\n```\n\n上面就是全部。';

const main = async () => {
  const P = createProbe({ title: 'W2058 聊天侧折叠 · 真机取证', shots: SHOTS, pad: 20 });
  const evidence = { chat: null, preview: null, consoleErrors: [], shots: [] };
  const fixture = await startFixture({
    port: PORT,
    label: 'w',
    repo: REPO,
    session: { id: 'w/main', title: 'W2058 取证', workspace: 'w', workspacePath: dirname(TARGET) },
    routes: [
      // 会话历史夹具：一条带 40 行 fenced 代码块的助手消息
      { path: '/api/sessions/w/main/messages', handle: ({ json }) => json(200, { ok: true, session: 'w/main', messages: [{ role: 'assistant', content: BODY }] }) },
      fsRoutes({ list: 'none' }),
    ],
    spaFallback: true,
  });
  const browser = await launchProbeChrome({ port: CDP, width: 1440, height: 900 });
  const { page } = browser;
  P.out.consoleErrors = browser.consoleErrors;
  evidence.consoleErrors = browser.consoleErrors;
  try {
    await page.navigate('http://127.0.0.1:' + PORT + '/');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(2500); // 等历史恢复把聊天正文画出来
    evidence.chat = await page.eval(`(function(){
      var c = document.querySelector('#messages .content') || document.querySelector('.content');
      return {
        contentFound: c !== null,
        fold: c ? c.querySelectorAll('.code-fold').length : -1,
        foldText: c && c.querySelector('.code-fold') ? c.querySelector('.code-fold').textContent : null,
        folded: c ? c.querySelectorAll('.code-folded').length : -1,
        cl: c ? c.querySelectorAll('.cl').length : -1,
        badge: c && c.querySelector('.code-badge') ? c.querySelector('.code-badge').textContent : null,
        copy: c ? c.querySelectorAll('.code-copy').length : -1
      };
    })()`);
    evidence.shots.push(await P.shots.save(page, 'chat-fold.png'));
    // 同一页再开预览：那边必须没有折叠
    await page.eval('(async function(){ var m = await import("/src/ui/workbench/files-open.ts"); m.openFilePreview(' + JSON.stringify(TARGET) + '); return true; })()');
    await sleep(2500);
    evidence.preview = await page.eval(`(function(){
      var b = document.querySelector('.preview-body');
      return { found: b !== null, fold: b ? b.querySelectorAll('.code-fold').length : -1, badge: b && b.querySelector('.code-badge') ? b.querySelector('.code-badge').textContent : null, cl: b ? b.querySelectorAll('.cl').length : -1 };
    })()`);
    evidence.shots.push(await P.shots.save(page, 'chat-plus-preview.png'));
    console.log(JSON.stringify(evidence, null, 2));
    // 本探针不带断言：verdict 表为空 ⇒ 汇总行是「0 条 FAIL」。判读靠上面这份同页对照 JSON。
    await P.finish({
      heading: 'W2058 聊天侧折叠 · 真机取证',
      pad: 20,
      trailer: ['产物：' + SHOTS + '（本探针只出证据、不带断言）'],
    });
  } finally {
    await browser.close();
    await fixture.close();
  }
};
main().catch((e) => { console.error('probe failed:', e); process.exit(1); });
