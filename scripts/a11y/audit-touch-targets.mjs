#!/usr/bin/env node
// ============================================================================
// scripts/a11y/audit-touch-targets.mjs — WCAG 2.5.8 (AA) 触摸目标审计（真机）
// ----------------------------------------------------------------------------
// 用法：
//   node scripts/a11y/audit-touch-targets.mjs                    # 390x844 手机 + 触摸仿真
//   node scripts/a11y/audit-touch-targets.mjs --width 1440 --height 900
//   node scripts/a11y/audit-touch-targets.mjs --json             # 机器可读
//   node scripts/a11y/audit-touch-targets.mjs --fail-on-violation # 有**违规**则退出码 1
//
// 前置：Vite 在 :3787 提供 /src/**（perf 夹具后端只做 /src/** 反代 + 静态托管）。
//   没起 Vite 时脚本**明说**这一点再退出，而不是丢一个 502 让人猜。
//
// ★ 为什么保留这个脚本（本轮最有价值的产出）：它把「新增组件偷偷带进一个 17px 的
//   触摸目标」变成**可机械发现**的事。将来任何人加组件，跑一次就知道。
//
// ★ 输出分三层，避免假警报：
//   ① 总数 / undersized 数 / **violation** 数（违反 = 尺寸不足 **且** 不满足 Spacing 例外）
//   ② undersized 明细表：尺寸 + Spacing 余量 + 判定（例外 / 违反）
//   ③ 结论行：只有 violation 才叫「需要修」
// ============================================================================
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { boot } from '../perf/lib/app.mjs';
import { backendPort, cdpPort } from '../perf/lib/ports.mjs';
import {
  auditTouchTargets, annotateSpacing, findUndersized, findViolations,
  formatTable, sortWorstFirst, MIN_TAP_TARGET_PX,
} from './lib/touch-targets.mjs';
import { applyScenario, inboxHistory } from './lib/scenarios.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 可用场景（--scenario）；unknown 一律报错，不静默回落成 empty（会假装审计过了）。 */
const SCENARIOS = ['empty', 'inbox', 'drawer', 'settings', 'full'];

/** 极简参数解析（零依赖）：--k v / --flag。 */
function parseArgs(argv) {
  const out = { width: 390, height: 844, json: false, failOnViolation: false, touch: true, waitMs: 1500, scenario: 'full', shot: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--fail-on-violation') out.failOnViolation = true;
    else if (a === '--no-touch') out.touch = false;
    else if (a === '--width') out.width = Number(argv[++i]);
    else if (a === '--height') out.height = Number(argv[++i]);
    else if (a === '--wait') out.waitMs = Number(argv[++i]);
    else if (a === '--scenario') out.scenario = String(argv[++i]);
    else if (a === '--shot') out.shot = String(argv[++i]);
    else if (a === '--shot') out.shot = String(argv[++i]);
  }
  return out;
}

/** 页面里跑审计 + Spacing 判定：把 lib 的两个纯函数序列化后注入。 */
function auditExpression(minPx) {
  return '(' + auditTouchTargets.toString() + ')(' + minPx + ')';
}

const args = parseArgs(process.argv.slice(2));
if (!SCENARIOS.includes(args.scenario)) {
  console.error('✗ 未知场景：' + args.scenario + '（可用：' + SCENARIOS.join(' / ') + '）');
  process.exit(1);
}
const app = await boot({ port: backendPort(), cdpPort: cdpPort(), width: args.width, height: args.height });
try {
  // 历史夹具必须在 boot() 导航**之前**放好：页面加载时会 GET messages。
  if (args.scenario !== 'empty') app.backend.state.history = inboxHistory();
  await app.boot();
  // 触摸仿真：让 @media (hover:none) 等触摸分支真的生效（只设 deviceMetrics 不够）。
  if (args.touch) {
    await app.page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await app.page.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
  }
  await app.page.send('Emulation.setDeviceMetricsOverride', {
    width: args.width, height: args.height, deviceScaleFactor: 1, mobile: args.width <= 640,
  });
  await new Promise((r) => setTimeout(r, args.waitMs));
  const scenario = await applyScenario(app.page, args.scenario);
  await new Promise((r) => setTimeout(r, 400));

  // 截图（可选）：证明「改动后页面仍正常渲染」，而不只是一堆数字。
  if (args.shot !== null) {
    const { writeFileSync } = await import('node:fs');
    const shot = await app.page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(args.shot, Buffer.from(shot.data, 'base64'));
    // ★ 走 stderr：--json 的 stdout 必须是**纯 JSON**，否则管道消费方会解析失败
    //（实测踩到：截图那一行混进了 JSON 流）。
    console.error('screenshot -> ' + args.shot);
  }

  const raw = await app.page.eval(auditExpression(MIN_TAP_TARGET_PX));
  const rows = annotateSpacing(raw, MIN_TAP_TARGET_PX);
  const undersized = sortWorstFirst(findUndersized(rows, MIN_TAP_TARGET_PX));
  const violations = findViolations(rows, MIN_TAP_TARGET_PX);
  const vw = await app.page.eval('window.innerWidth');
  const vh = await app.page.eval('window.innerHeight');

  if (args.json) {
    console.log(JSON.stringify({
      viewport: { width: vw, height: vh, requested: { width: args.width, height: args.height }, touch: args.touch },
      scenario: { name: args.scenario, ...scenario },
      total: rows.length, undersized: undersized.length, violations: violations.length,
      targets: rows,
    }, null, 2));
  } else {
    console.log('viewport ' + vw + 'x' + vh + '  touch=' + args.touch + '  scenario=' + args.scenario
      + '  min=' + MIN_TAP_TARGET_PX + 'px (WCAG 2.5.8 AA)');
    console.log('total=' + rows.length + '  undersized=' + undersized.length + '  violations=' + violations.length);
    console.log('');
    console.log(formatTable(undersized, MIN_TAP_TARGET_PX));
    console.log('');
    if (violations.length === 0) {
      console.log('✓ 无违规：' + undersized.length + ' 个 undersized 目标全部满足 Spacing 例外'
        + '（24px 圆互不相交，也不与其它目标相交）。');
    } else {
      console.log('✗ ' + violations.length + ' 个目标**违反** SC 2.5.8：');
      for (const v of violations) {
        console.log('  · ' + v.selector + '  ' + v.w + 'x' + v.h
          + '  与 ' + v.nearest + ' 的圆相交（余量 ' + v.spacingMargin + 'px）');
      }
    }
  }
  const errs = app.consoleErrors.filter((e) => !/favicon/i.test(e));
  if (errs.length > 0) {
    console.error('\nconsole 错误 ' + errs.length + ' 条：');
    for (const e of errs.slice(0, 10)) console.error('  · ' + e);
  }
  if (args.failOnViolation && violations.length > 0) process.exitCode = 1;
} catch (err) {
  const msg = String(err && err.message ? err.message : err);
  if (/502|vite proxy|sess-pane/i.test(msg)) {
    console.error('✗ 页面没起来。最常见原因：**Vite 没跑**。先起：');
    console.error('    pnpm --dir apps/web exec vite --port 3787 --strictPort');
    console.error('  原始错误：' + msg);
  } else {
    console.error('✗ ' + msg);
  }
  process.exitCode = 1;
} finally {
  await app.close();
}
