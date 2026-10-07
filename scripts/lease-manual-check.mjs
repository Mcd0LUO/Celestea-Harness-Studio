#!/usr/bin/env node
/**
 * scripts/lease-manual-check.mjs — 租约的真机验收（手动 + --auto 两态）。
 *
 * 为什么曾经只能手动：旧实现把「0.3s 时间窗」OR 进合成判定，200ms 点击节奏下窗口
 * 永不过期，真人输入全被吞；且当时对 SendInput 的分类缠在 INJECTED 标志上。
 * Fix A（PORTING.md §7.7）之后判定只剩 dwExtraInfo 印章一条：不盖章的 SendInput
 * 对 helper 与真人不可区分，于是 --auto 用 scripts/desktop-inject-input.py 注入
 * 无印章击键替代「真人的手」，租约可以自动化验收；不带 --auto 仍是真人手动模式。
 *
 * --auto 同时是「击键落地」对照实验：注入的字符会在租约触发后从 UIA 树读回，
 * 打得出来 = 快速点击节奏下外部击键能落地（焦点抢夺推断不成立），
 * 打不出来 = 复现了手动实测的「打不出字」，回去议方案 C。
 *
 * 它做四件事：
 *   1. 只认**自己**开的那个记事本窗口（先快照已有窗口，再排除它们）——绝不碰用户的文档；
 *   2. activate 之后按 ~200ms 的节奏持续 desktop_click（点文本区中心）占着窗口——
 *      用 click 不用 type_text：打字走剪贴板粘贴路径，会被「verify clipboard text
 *      before paste」这道防线抢先拦截，命中不到键鼠钩子的租约检查；click 直达。
 *   3. 第 2 秒在 stdout 打一行醒目提示，请人此刻动一下鼠标或按任意键；
 *   4. 断言人动过之后的**下一次**调用返回 user input was detected in this window。
 *
 * 租约检查点在**每次动作开始前**（helper state.rs::require_fresh -> interrupt::require_clean_for），
 * 所以人一动，**下一个** click 就会被拒——不需要等当前这次点完。
 *
 * 退出码：0 = PASSED；2 = TIMEOUT（人没动，**不算通过**）；1 = 夹具/环境出错。
 *
 * 用法：node scripts/lease-manual-check.mjs [--seconds 30]
 *   --seconds 只给干跑/自检用（人不去动的话它必然 TIMEOUT，这是对的）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttachmentStore } from '../packages/tools/dist/attachments/store.js';
import { DesktopHelperClient, desktopTools, helperBinPath } from '../packages/desktop/dist/index.js';
import { createDesktopGateHost, DESKTOP_CONFIRM_APPROVE } from '../apps/studio/src/runtime/desktop-gate-host.ts';
import { createQuestionRegistry } from '../apps/studio/src/question-registry.ts';
import { writeGrantsFile, newGrantId } from '../apps/studio/src/store/grants.ts';
import { effectiveGrantsOf } from '../apps/studio/src/runtime/engine-grants.ts';

const argv = process.argv.slice(2);
const secondsArg = argv.indexOf('--seconds');
const TOTAL_S = secondsArg >= 0 ? Number(argv[secondsArg + 1]) : 30;
const PROMPT_AT_S = 2;
// --auto：无印章注入替代真人（见文件头）。注入的探针文本稍后要从 UIA 树读回。
const AUTO = argv.includes('--auto');
const AUTO_PROBE = 'ZQ-LEASE-PROBE';
const CHUNK = 'abc';
const INTERVAL_MS = 200;

// interrupt.rs:35 的真实串（helper/src/interrupt.rs::USER_INPUT_MESSAGE）。
const LEASE_LITERAL = 'user input was detected in this window';

let notepad = null;
/** 我们自己开的那个窗口的句柄（list_windows 的 id 就是 hwnd），清理时按它定位进程。 */
let ourWindowId = null;
function check(label, ok, detail) {
  console.log('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + label + (detail === undefined ? '' : ' :: ' + detail));
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const workDir = await mkdtemp(join(tmpdir(), 'celestea-lease-manual-'));
const attachments = createAttachmentStore(join(workDir, 'attachments'));
const client = new DesktopHelperClient({ helperPath: helperBinPath() });

// 确认卡：type_text 属敏感集，每次都要人点一次。这里脚本代按「允许这一次」——
// 真人在这一项上参与的是**鼠标/键盘干扰**，不是确认卡。
const registry = createQuestionRegistry();
let autoApproved = 0;
const publish = (question) => {
  autoApproved += 1;
  question.answer([{ questionId: question.requestId, selected: [DESKTOP_CONFIRM_APPROVE] }]);
};

// 真实授权：临时 grants.json + 生产派生链（desktop 能力位 + notepad 应用范围）。
const now = Math.floor(Date.now() / 1000);
const session = 'lease-manual';
await writeGrantsFile(join(workDir, 'grants'), {
  version: 1, session, updated_at: now,
  grants: [{
    id: newGrantId(), cap: 'desktop', scope: { apps: { allow: { exes: ['notepad.exe'] } } },
    granted_at: now, granted_by: 'lease-manual', expires_at: now + 3600, uses_left: null,
    note: 'lease manual check: a temporary desktop capability bit for the notepad window this script opens.',
  }],
}, { now });
const eff = effectiveGrantsOf(join(workDir, 'grants'), session, {}, now);
console.log('desktop grant effective =', eff.grants.desktop, '| apps =', JSON.stringify(eff.grants.apps ?? {}));

const gate = createDesktopGateHost({
  sessionId: session,
  grants: () => ({ desktop: eff.grants.desktop, apps: eff.grants.apps ?? {} }),
  registry, publish, platform: 'win32',
});
const tools = Object.fromEntries(desktopTools({ client, attachments, gate }).map((t) => [t.spec().name, t]));
const call = async (name, args) => tools[name].execute(args);

function cleanup() {
  try { client.stop(); } catch { /* 清理不该掩盖失败 */ }
  if (notepad === null) return;
  // 只杀自己 spawn 的那一个：没有 --keep 开关，因为留着就等于把半截字留在人桌上。
  //
  // 干跑实测：单纯的 process.kill(pid) **杀不掉** Win11 的 Store 版记事本——它是多进程的，
  // 启动器进程退出后窗口由另一个进程持有，于是窗口一次次留在桌面上（干跑三��后累积到 3 个）。
  // 所以追加 taskkill /T /F 打**自己那棵进程树**：/T 只连带子进程，不会波及用户自己的记事本
  // （它不在我们的树里）。两条都失败就算了，但那时窗口会留着，日志里能看出来。
  try { process.kill(notepad.pid); } catch { /* 已经没了就算了 */ }
  try {
    spawnSync('taskkill', ['/PID', String(notepad.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch { /* taskkill 不可用就算了 */ }
  // 仍然会漏：Win11 的记事本是 Store 应用，spawn 出来的启动器进程与真正持有窗口的进程不是
  // 同一个（干跑实测连杀四轮，每次都多留一个「无标题」窗口）。最后一招按**我们自己的窗口句柄**
  // 找到持有它的进程并结束它 —— 只按句柄定位，所以用户自己的记事本不在射程内。
  if (ourWindowId !== null) {
    // Get-Process 的 MainWindowHandle 只认「主窗口」，实测对多窗口的记事本无效（连挂四轮都漏）。
    // 用 EnumWindows + GetWindowThreadProcessId 精确定位持有**我们那个句柄**的进程再结束它——
    // 按句柄定位，所以用户自己的记事本不在射程内。
    const py = process.env.CELESTEA_SMOKE_PYTHON ?? 'python';
    const code = [
      'import ctypes',
      'from ctypes import wintypes',
      'u=ctypes.windll.user32',
      'target=int(' + ourWindowId + ')',
      'pids=set()',
      '@ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)',
      'def cb(h,l):',
      '    pid=wintypes.DWORD()',
      '    u.GetWindowThreadProcessId(h, ctypes.byref(pid))',
      '    if u.GetAncestor(h, 2) == target or h == target:',
      '        pids.add(pid.value)',
      '    return True',
      'u.EnumWindows(ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)(cb), 0)',
      'k=ctypes.windll.kernel32',
      'for p in pids:',
      '    h=k.OpenProcess(1, False, p)',
      '    if h: k.TerminateProcess(h, 0); k.CloseHandle(h)',
      'print(len(pids))',
    ].join('\n');
    try {
      spawnSync(py, ['-c', code], { stdio: 'ignore', windowsHide: true, timeout: 20000 });
    } catch { /* 兜底失败就留着：窗口是「无标题」，用户一眼认得出 */ }
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

console.log('helper  =', helperBinPath());
console.log('budget  =', TOTAL_S, 'seconds (at', PROMPT_AT_S, 's the script asks you to move the mouse)');

// ── 1. 只认自己开的那个记事本 ────────────────────────────────────────────
console.log('');
console.log('(1) open a notepad that is OURS');
const preExisting = new Set(
  ((await call('desktop_list_windows', {})).windows ?? [])
    .filter((w) => /notepad\.exe$/i.test(String(w.app ?? '')))
    .map((w) => w.id),
);
console.log('      pre-existing notepad windows (will NOT be touched):', [...preExisting].join(', ') || '(none)');
notepad = spawn('notepad.exe', [], { detached: false, stdio: 'ignore', windowsHide: false });

let target = null;
for (let i = 0; i < 40 && target === null; i += 1) {
  const res = await call('desktop_list_windows', {});
  const fresh = (res.windows ?? []).filter(
    (w) => /notepad\.exe$/i.test(String(w.app ?? '')) && !preExisting.has(w.id),
  );
  if (fresh.length > 0) { target = fresh[0]; ourWindowId = target.id; }
  else await sleep(250);
}
if (target === null) {
  check('our own notepad window appeared', false, 'none after 10s');
  cleanup();
  await rm(workDir, { recursive: true, force: true });
  process.exit(1);
}
check('our own notepad window appeared', true, JSON.stringify({ id: target.id, title: target.title }));
const WIN = { app: target.app, id: target.id };
await call('desktop_activate_window', { window: WIN });

// 干跑实测出来的第一条硬约束：helper 要求**先观测后使用**——没做过 get_window_state，
// 写工具一律回 "call get_window_state before using this window"。所以循环前必须先观测一次。
//
// 而且**不能**在每次打字前都重新观测：helper 的 remember_capture（截图观测路径）末尾会调
// `interrupt::clear()`，那会把 dirty 标志**擦掉**。每轮都刷新 = 租约证据每轮被抹 = 租约永远
// 测不出来。所以：循环内只写不观测，只在「新鲜度确实失效」时补一次观测（那是恢复，不是观测节奏）。
const firstLook = await call('desktop_get_window_state', { window: WIN, include_screenshot: true });
check('the window was observed once before writing', firstLook.ok === true, JSON.stringify(firstLook).slice(0, 120));

// 点击点：窗口客户区中心。click 的 x/y 是【窗口相对】坐标（实测：传屏幕绝对坐标被 helper
// 以 outside viewport 拒），所以中心 = width/2, height/2，不要加 originX/originY。
const shot0 = firstLook?.screenshots?.[0];
if (!shot0 || !(shot0.width > 0) || !(shot0.height > 0)) {
  check('client-rect available for click point', false, JSON.stringify(firstLook?.screenshots ?? null));
  cleanup();
  await rm(workDir, { recursive: true, force: true });
  process.exit(1);
}
const CX = Math.round(shot0.width / 2);
const CY = Math.round(shot0.height / 2);
console.log('      click point =', CX + ',' + CY, '(client-area center)');

// ── 2/3/4. 打字循环 + 第 2 秒提示 + 断言租约 ────────────────────────────────
console.log('');
console.log('(2) type in a loop for', TOTAL_S, 'seconds');
const started = Date.now();
let prompted = false;
let calls = 0;
let typed = 0;
let refreshes = 0;
let leaseHit = null;
let lastError = null;
let firstRejection = null;
let interferences = 0;

while (Date.now() - started < TOTAL_S * 1000) {
  const elapsed = (Date.now() - started) / 1000;
  if (!prompted && elapsed >= PROMPT_AT_S) {
    prompted = true;
    if (AUTO) {
      // 无印章注入：对 helper 而言与真人击键/点击不可区分（dwExtraInfo=0）。
      // 文本探针 + 一次点击：文本是「击键是否落地」的探针（收尾从 UIA 读回），
      // 点击保证钩子里有一次可观测事件，租约触发不依赖文本是否落地。
      const py = process.env.CELESTEA_SMOKE_PYTHON ?? 'python';
      const ax = Math.round(Number(shot0.originX ?? 0) + CX);
      const ay = Math.round(Number(shot0.originY ?? 0) + CY);
      const r = spawnSync(py, [
        join(import.meta.dirname ?? '.', 'desktop-inject-input.py'), 'text', AUTO_PROBE,
      ], { encoding: 'utf8', timeout: 30000 });
      console.log('      [auto] injected unstamped keystrokes:', (r.stdout || '').trim(), '| exit', r.status);
      const r2 = spawnSync(py, [
        join(import.meta.dirname ?? '.', 'desktop-inject-input.py'), 'mouse', String(ax), String(ay),
      ], { encoding: 'utf8', timeout: 30000 });
      console.log('      [auto] injected unstamped click at ' + ax + ',' + ay + ':', (r2.stdout || '').trim(), '| exit', r2.status);
    } else {
      console.log('');
      console.log('  ============================================================');
      console.log('  >>>  move your mouse or press any key NOW (in this notepad) <<<');
      console.log('  ============================================================');
      console.log('');
    }
  }
  calls += 1;
  const res = await call('desktop_click', { window: WIN, x: CX, y: CY });
  if (res && res.ok === false) {
    lastError = res;
    if (firstRejection === null) firstRejection = { at: elapsed.toFixed(1), res };
    const text = JSON.stringify(res);
    if (text.includes(LEASE_LITERAL)) {
      if (AUTO && !prompted) {
        // 注入点之前的命中只可能是真人在场——租约在正常工作，但它不是
        // 本次探针的结果。重新观测清掉 dirty 继续等注入点（有界，防死循环）。
        interferences += 1;
        if (interferences > 20) {
          leaseHit = null;
          lastError = res;
          break;
        }
        console.log('      [auto] real-user lease trip before the probe (it works!) - re-observing, probe still pending');
        await call('desktop_get_window_state', { window: WIN, include_screenshot: true });
        await sleep(INTERVAL_MS);
        continue;
      }
      leaseHit = { at: elapsed.toFixed(1), res };
      break;
    }
    // 新鲜度失效（窗口变过/没观测过）——补一次观测再继续。这是恢复路径，不是观测节奏：
    // 真人的干扰会命中上面的租约分支，不会落到这里。
    if (text.includes('call get_window_state')) {
      refreshes += 1;
      await call('desktop_get_window_state', { window: WIN, include_screenshot: true });
    }
  } else {
    typed += 1;
  }
  await sleep(INTERVAL_MS);
}

const elapsedS = ((Date.now() - started) / 1000).toFixed(1);
console.log('');
console.log('(3) result');
console.log('      elapsed =', elapsedS, 's | click calls =', calls, '| actually clicked =', typed, '| freshness refreshes =', refreshes, '| confirm cards =', autoApproved);
if (firstRejection !== null) {
  console.log('      first rejection at', firstRejection.at, 's ::', JSON.stringify(firstRejection.res).slice(0, 240));
}

// --auto 对照实验：租约触发后重新观测并读 UIA 文本，验证注入的击键**真的落了地**。
// 落了 = 200ms 点击节奏下外部击键可落地，「焦点抢夺」推断不成立；
// 没落 = 复现了手动实测的「打不出字」，是方案 C（焦点节流）的真机证据。
// 探针落地是**对照实验数据**，不是通过/失败判据：落地与否直接判读焦点抢夺推断。
let probeLanded = null;
if (AUTO && prompted) {
  const relook = await call('desktop_get_window_state', { window: WIN, include_text: true });
  const tree = JSON.stringify(relook.accessibility ?? '');
  probeLanded = tree.includes(AUTO_PROBE);
  console.log('      [auto] probe readback: ' + (probeLanded
    ? AUTO_PROBE + ' FOUND in the UIA tree — keystrokes LAND during the 200ms click cadence'
    : 'NOT FOUND in ' + tree.length + ' chars — keystrokes did NOT land'));
} else if (AUTO) {
  console.log('      [auto] probe was never injected (interference overflow) — focus experiment INCONCLUSIVE');
}

cleanup();
await rm(workDir, { recursive: true, force: true });

if (leaseHit !== null) {
  console.log('      lease tripped at', leaseHit.at, 's ::', JSON.stringify(leaseHit.res).slice(0, 240));
  check('helper refused the write with the real lease literal', true, LEASE_LITERAL);
  check('it arrived as a structured result (the turn survived)', leaseHit.res !== null && typeof leaseHit.res === 'object');
  if (AUTO) {
    console.log(probeLanded === null
      ? '      [auto] focus experiment inconclusive this run.'
      : probeLanded
        ? '      [auto] keystrokes landed => focus-yanking theory REFUTED for this cadence.'
        : '      [auto] keystrokes did NOT land => focus-yanking theory CONFIRMED, discuss option C.');
    if (interferences > 0) console.log('      [auto] real-user interferences before the probe: ' + interferences + ' (lease works on real hands too)');
  }
  console.log('');
  console.log(AUTO ? 'LEASE AUTO CHECK PASSED' : 'LEASE MANUAL CHECK PASSED');
  process.exit(0);
}
console.log('      no lease refusal was seen. Last rejection:',
  lastError === null ? '(none - every call was allowed)' : JSON.stringify(lastError).slice(0, 200));
console.log('');
console.log('LEASE MANUAL CHECK TIMEOUT - the lease was never tripped within ' + TOTAL_S + ' seconds.');
if (lastError === null) {
  console.log('(Nothing was rejected at all, so the typing path itself is clean. If you were asked to move the mouse and did, the interference did not reach the helper.)');
} else {
  console.log('(The calls WERE rejected, but never with the lease literal - that is a different failure and the message above says which.)');
}
console.log('This is NOT a pass. Move the mouse during the run and try again.');
process.exit(2);
