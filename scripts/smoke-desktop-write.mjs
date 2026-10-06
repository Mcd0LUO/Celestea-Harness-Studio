#!/usr/bin/env node
/**
 * scripts/smoke-desktop-write.mjs — computer-use M2 的**真机**验收（规划 §6 M2③）。
 *
 * 与 smoke-desktop.mjs（只读）的分工：那份证「能看」，这份证「能动」——写操作真产生效果、
 * 闸门真拦真放、租约真生效。四项都走**生产代码**（packages/desktop 的 client + tool + 闸门，
 * apps/studio 的真实闸门宿主与授权派生），不是一份复制的协议实现。
 *
 * 为什么是独立脚本而不是 vitest：它要真发键鼠、要 spawn 记事本、要在别的进程注入外部输入。
 * CI 上没有 helper（产物不进 git）、也不该有人的桌面，所以它自己跑、自己退出码说话。
 *
 * 四项实证：
 *   1. type_text 真的把字打进了记事本，include_text 的 UIA 树里能逐字读到（M1 遗留项）；
 *   2. click 真的改了焦点：点完再打，字串**接在后面**而不是落到别处；
 *   3. 闸门真拦真放：同一调用在无授权时被拒（helper 零动作）、授权后放行；
 *   4. 租约真生效：外部进程注入真实输入后，helper 中止动作序列并返回真实字面量。
 *
 * 用法：node scripts/smoke-desktop-write.mjs [--keep-notepad]
 * 退出码：0 全过；非 0 有断言没过（原因原样打印）。
 *
 * ⚠️ 它会**真的**在你的桌面上打字和点击。跑之前请关掉你正在输入的东西。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttachmentStore } from '../packages/tools/dist/attachments/store.js';
import { DesktopHelperClient, desktopTools, helperBinPath } from '../packages/desktop/dist/index.js';
import { createDesktopGateHost } from '../apps/studio/src/runtime/desktop-gate-host.ts';
import { createQuestionRegistry } from '../apps/studio/src/question-registry.ts';
import { DESKTOP_CONFIRM_APPROVE } from '../apps/studio/src/runtime/desktop-gate-host.ts';
import { writeGrantsFile, newGrantId } from '../apps/studio/src/store/grants.ts';
import { effectiveGrantsOf } from '../apps/studio/src/runtime/engine-grants.ts';

const KEEP = process.argv.includes('--keep-notepad');
const PYTHON = process.env.CELESTEA_SMOKE_PYTHON ?? 'python';

let failures = 0;
let notepad = null;
const spawned = [];
function check(label, ok, detail) {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ' :: ' + detail}`);
  if (!ok) failures += 1;
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 夹具环境 ────────────────────────────────────────────────────────────
const workDir = await mkdtemp(join(tmpdir(), 'celestea-m2-smoke-'));
const attachments = createAttachmentStore(join(workDir, 'attachments'));
const client = new DesktopHelperClient({ helperPath: helperBinPath() });

// 确认通道：type_text / set_value / launch_app 是敏感集，每次调用都要人点一次。
// 这里用**真实的** QuestionRegistry + publish 回调，回调里自动点「允许这一次」——
// 即：真人那一侧被脚本代按了。卡片文案、走表、计时都是生产代码的路径。
const registry = createQuestionRegistry();
let autoApproved = 0;
let autoDenied = 0;
let autoDecision = 'approve';
const publish = (question) => {
  if (autoDecision === 'approve') {
    autoApproved += 1;
    question.answer([{ questionId: question.requestId, selected: [DESKTOP_CONFIRM_APPROVE] }]);
  } else {
    autoDenied += 1;
    question.answer([{ questionId: question.requestId, selected: ['拒绝'] }]);
  }
};

/** 用临时目录里的**真实 grants.json** 派生有效授权（与生产同一条派生链）。 */
async function grantsProvider(desktop, apps) {
  const dir = join(workDir, 'grants-' + (desktop ? 'granted' : 'empty'));
  const session = 'm2-smoke';
  const now = Math.floor(Date.now() / 1000);
  const file = {
    version: 1,
    session,
    updated_at: now,
    grants: desktop
      ? [{
          id: newGrantId(),
          cap: 'desktop',
          scope: { apps },
          granted_at: now,
          granted_by: 'm2-smoke',
          expires_at: now + 3600,
          uses_left: null,
          note: 'M2 write smoke: a temporary desktop capability bit for one notepad window.',
        }]
      : [],
  };
  // 单位是**秒**（生产 handlers/grants.ts 传的就是 seconds）。传毫秒会让这条授权在
  // writeGrantsFile 的惰性 GC 里被判成已过期而**静默丢掉** —— 写进去的是空文件。
  await writeGrantsFile(dir, file, { now });
  const effective = effectiveGrantsOf(dir, session, {}, now);
  return { desktop: effective.grants.desktop, apps: effective.grants.apps ?? {} };
}

const toolsFor = (gate) => Object.fromEntries(desktopTools({ client, attachments, gate }).map((t) => [t.spec().name, t]));
const call = async (tools, name, args) => tools[name].execute(args);

function cleanup() {
  try { client.stop(); } catch { /* 忽略：清理不该掩盖真正的失败 */ }
  if (notepad !== null && !KEEP) {
    try { process.kill(notepad.pid); } catch { /* 已经没了就算了 */ }
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

console.log('helper  =', helperBinPath());
console.log('workdir =', workDir);

// ── 夹具窗口：一个**我们自己开的**记事本 ───────────────────────────────────
console.log('\n(0) spawn notepad and wait for ITS window');
const roGate = { check: () => Promise.resolve({ kind: 'allow' }) };
const ro = toolsFor(roGate);

// ⚠️ 先拍下**打开之前**就存在的记事本窗口，之后只认新出现的那一个。
// 事故记录：第一版直接取「第一个记事本窗口」，而这台机器上本来就开着用户自己的
// 「万界放映厅异闻录开启.txt」，于是验收的字被打进了**用户的文档**里。
// 夹具只许碰自己造出来的窗口——这不是洁癖，是不毁别人的东西。
const preExisting = new Set(
  ((await call(ro, 'desktop_list_windows', {})).windows ?? [])
    .filter((x) => /notepad\.exe$/i.test(String(x.app ?? '')))
    .map((x) => x.id),
);
console.log('      pre-existing notepad windows (will NOT be touched):', [...preExisting].join(', ') || '(none)');

notepad = spawn('notepad.exe', [], { detached: false, stdio: 'ignore', windowsHide: false });
spawned.push(notepad);

let target = null;
for (let i = 0; i < 40 && target === null; i += 1) {
  const res = await call(ro, 'desktop_list_windows', {});
  // 只认**新出现**的记事本窗口：预先存在的那些是别人的，本夹具一个都不碰。
  const wins = (res.windows ?? []).filter(
    (w) => /notepad\.exe$/i.test(String(w.app ?? '')) && !preExisting.has(w.id),
  );
  if (wins.length > 0) target = wins[0];
  else await sleep(250);
}
if (target === null) {
  check('a notepad window appeared', false, 'no notepad window in list_windows after 10s');
  cleanup();
  await rm(workDir, { recursive: true, force: true });
  process.exit(1);
}
check('a notepad window appeared', true, JSON.stringify({ app: target.app, id: target.id }));

const WIN = { app: target.app, id: target.id };
const stamp = new Date().toISOString();

// 闸门（真实宿主，授权为空 → 写工具应当被拦）。
const deniedGrants = await grantsProvider(false, {});
const gateDenied = createDesktopGateHost({ sessionId: 'm2-smoke', grants: () => deniedGrants, registry, publish, platform: 'win32' });
const denied = toolsFor(gateDenied);

const allowedGrants = await grantsProvider(true, { allow: { exes: ['notepad.exe'] } });
const gateAllowed = createDesktopGateHost({ sessionId: 'm2-smoke', grants: () => allowedGrants, registry, publish, platform: 'win32' });
const allowed = toolsFor(gateAllowed);

// ── 3a. 闸门真拦（先做：必须在任何写动作之前）───────────────────────────
console.log('\n(3a) gate REFUSES without a desktop grant');
const before = (await call(ro, 'desktop_get_window_state', { window: WIN })).accessibility;
const refused = await call(denied, 'desktop_type_text', { window: WIN, text: 'SHOULD-NEVER-BE-TYPED' });
check('the call is refused, not executed', refused.ok === false, JSON.stringify(refused));
check('code is desktop_cap_not_granted', refused.code === 'desktop_cap_not_granted', String(refused.code));
check('the refusal names the gate as its source', refused.source === 'desktop_gate', String(refused.source));
const after = (await call(ro, 'desktop_get_window_state', { window: WIN })).accessibility;
check('the helper took no action (UIA tree unchanged)', JSON.stringify(before) === JSON.stringify(after), before === after ? 'identical' : 'tree changed');
check('no confirmation card was raised (it never got that far)', autoApproved === 0 && autoDenied === 0, `approved=${autoApproved} denied=${autoDenied}`);

// ── 1. type_text + include_text ─────────────────────────────────────────
console.log('\n(1) type_text into notepad, then read it back through UIA');
const MARK1 = 'Celestea-M2-A-' + stamp.replace(/[^0-9]/g, '').slice(0, 14);
await call(allowed, 'desktop_activate_window', { window: WIN });
const typed1 = await call(allowed, 'desktop_type_text', { window: WIN, text: MARK1 });
check('activate_window + type_text both succeeded', typed1.ok === true, JSON.stringify(typed1).slice(0, 160));
check('the confirm card was actually raised and approved', autoApproved >= 1, `autoApproved=${autoApproved}`);
const state1 = await call(ro, 'desktop_get_window_state', { window: WIN, include_text: true });
check('accessibility tree is present (include_text works)', state1.accessibility !== null, typeof state1.accessibility);
const tree1 = JSON.stringify(state1.accessibility ?? '');
check('the typed text appears verbatim in the UIA tree', tree1.includes(MARK1), tree1.includes(MARK1) ? MARK1 : 'NOT FOUND in ' + tree1.length + ' chars');

// ── 2. click 真的改变焦点 ───────────────────────────────────────────────
console.log('\n(2) click in the text area, then type again');
const geom = state1.window ?? {};
const cx = Math.round(Number(geom.x ?? 100) + Number(geom.width ?? 400) / 2);
const cy = Math.round(Number(geom.y ?? 100) + Number(geom.height ?? 300) / 2);
console.log('      window rect =', JSON.stringify(geom), '-> click at', cx, cy);
const MARK2 = '|AFTER-CLICK';
const clicked = await call(allowed, 'desktop_click', { window: WIN, x: cx, y: cy });
check('click succeeded', clicked.ok === true, JSON.stringify(clicked).slice(0, 160));
const typed2 = await call(allowed, 'desktop_type_text', { window: WIN, text: MARK2 });
check('the second type_text succeeded', typed2.ok === true, JSON.stringify(typed2).slice(0, 160));
const state2 = await call(ro, 'desktop_get_window_state', { window: WIN, include_text: true });
const tree2 = JSON.stringify(state2.accessibility ?? '');
const at1 = tree2.indexOf(MARK1);
const at2 = tree2.indexOf(MARK2);
check('both marks are in the UIA tree', at1 >= 0 && at2 >= 0, `first@${at1} second@${at2}`);
check('the second text landed AFTER the first (click focused the text area)', at2 > at1, `first@${at1} second@${at2}`);

// ── 3b. 闸门真放 ────────────────────────────────────────────────────────
console.log('\n(3b) the same call is ALLOWED once the desktop cap is granted');
// 无害按键：End。落到记事本文本区只会把光标移到行尾。
const key = await call(allowed, 'desktop_press_key', { window: WIN, key: 'End' });
check('press_key(End) went through the gate to the helper', key.ok === true, JSON.stringify(key).slice(0, 160));
const stillDenied = await call(denied, 'desktop_press_key', { window: WIN, key: 'End' });
check('the un-granted gate still refuses the same tool', stillDenied.ok === false && stillDenied.code === 'desktop_cap_not_granted', JSON.stringify(stillDenied).slice(0, 120));

// ── 4. 租约：**为什么这条无法自动化**（实测结论，不是推测）────────────────
// 任务书设想「从另一个进程用 SendInput 注入 = 外部非合成输入」。实测证明这个设想**不成立**：
// SendInput 注入的事件一律带 INJECTED 标志，无论调用者是哪个进程。helper 恰恰是靠这个
// 标志区分自己与外人的（规划 §5），所以 SendInput 注入会被判成「helper 自己动的」，
// 永远不把窗口弄脏。实测的租约快照（helper diagnostic_state -> inputMonitor）：
//     {"armed":false,"dirty":false,"keyEvents":4,"mouseDowns":1,"mouseDownsInjected":1,"mouseEvents":2}
// 看到了那次点击（mouseDowns:1），但它是 **injected**（mouseDownsInjected:1），所以 dirty 保持 false。
//
// 结论：租约的真实验收需要**真人动鼠标**，或者驱动级注入（拦截驱动 / VHID），这两者都不是
// 一个 Node 脚本能造出来的。所以下面这段只**探测并如实报告**，不假装它通过。
console.log('\n(4) lease: probing whether an automated external input can trip the lease');
const LONG = 'celestea-lease-' + 'x'.repeat(2000);
const warm = await call(allowed, 'desktop_type_text', { window: WIN, text: LONG });
check('the warm-up write succeeded (the window identity is now known)', warm.ok === true, JSON.stringify(warm).slice(0, 120));

// 点在记事本窗口**内**（截图记录带屏幕坐标 originX/originY/width/height）。
const shot = (state1.screenshots ?? [])[0] ?? {};
const insideX = Math.round(Number(shot.originX ?? 0) + Number(shot.width ?? 400) / 2);
const insideY = Math.round(Number(shot.originY ?? 0) + Number(shot.height ?? 300) / 2);
console.log('      injecting a click at', insideX, insideY, '(inside our own notepad window)');
const injector = spawnSync(PYTHON, [
  join(import.meta.dirname ?? '.', 'tmp-external-input.py'),
  '0', 'mouse', String(insideX), String(insideY),
], { encoding: 'utf8', timeout: 30000 });
console.log('      injector said:', (injector.stdout || '').trim() || '(nothing)', '| stderr:', (injector.stderr || '').trim() || '(none)');
await sleep(500);

const monitor = (await client.callTool('diagnostic_state', {})).value?.inputMonitor ?? {};
console.log('      helper inputMonitor after the click:', JSON.stringify(monitor));
const syntheticOnly = (monitor['mouseDownsInjected'] ?? 0) > 0 && monitor['dirty'] !== true;
console.log('      => the click was recorded but flagged INJECTED, so the lease did not trip:',
  syntheticOnly ? 'CONFIRMED (SendInput cannot simulate non-injected input)' : 'n/a');
const leased = await call(allowed, 'desktop_type_text', { window: WIN, text: 'after-external-input' });
console.log('      type_text result:', JSON.stringify(leased).slice(0, 200));
const leaseText = JSON.stringify(leased);
const leaseTripped = leaseText.includes('user input was detected');
if (leaseTripped) {
  check('helper refused the write with the real user-input literal', true, 'literal found');
} else {
  console.log('  [SKIP] lease trip is NOT automatable: SendInput events carry the INJECTED flag, so the');
  console.log('         helper correctly treats them as its own. Verifying this needs a HUMAN moving the');
  console.log('         mouse (or a driver-level injector). Reported as an open item, not as a pass.');
  console.log('         (This is a deliberate SKIP, not a pass — do not read it as coverage.)');
}
cleanup();
await rm(workDir, { recursive: true, force: true });
console.log('\n' + (failures === 0 ? 'WRITE SMOKE PASSED' : 'WRITE SMOKE FAILED: ' + failures + ' assertion(s)'));
process.exit(failures === 0 ? 0 : 1);
