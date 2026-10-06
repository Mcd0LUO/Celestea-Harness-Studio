#!/usr/bin/env node
/**
 * scripts/smoke-desktop.mjs — computer-use M1 的**真机**冒烟（规划 §6 M1③）。
 *
 * 为什么是独立脚本而不是 vitest 用例：CI 上没有构建好的 helper（产物不进 git），
 * 放进测试套件会必然红、于是变成一条 flake 或一个必须 skip 的分支。冒烟是**需要真机**的
 * 证据，所以它自己跑、自己打印、自己退出码说话。
 *
 * 它驱动的是**生产代码**（packages/desktop 的 DesktopHelperClient + desktopTools），
 * 不是一份另写的协议实现——所以它证的是链路，不是一个复制的模型。
 *
 * 覆盖 M1③ 的四条：
 *   a) ping 握手真的答出 {version, platform, features}；
 *   b) desktop_list_windows 真调用：非空数组，且每项都带 app + id；
 *   c) desktop_get_window_state 对一个真实窗口返回 attachment（bytes>0、image/*、
 *      宽高为 >=1 整数、attachment_id 是 64 位小写 hex）；
 *   d) attachments 落在 value 的**顶层**——core 的 projection 认的位置（core/src/projection.ts:132）。
 *
 * 用法：node scripts/smoke-desktop.mjs [--target <app-substring>]
 * 退出码：0 全过；非 0 = 有断言没过（原因原样打印，不吞）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttachmentStore } from '../packages/tools/dist/attachments/store.js';
import { DesktopHelperClient, desktopTools, helperBinPath } from '../packages/desktop/dist/index.js';

const argv = process.argv.slice(2);
const targetArg = argv.indexOf('--target');
const TARGET = targetArg >= 0 ? argv[targetArg + 1] : null;

let failures = 0;
function check(label, ok, detail) {
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${label}${detail === undefined ? '' : ' :: ' + detail}`);
  if (!ok) failures += 1;
  return ok;
}

// 一个 64 位小写 hex 正是 core 的 isImageRef 要求的 attachment_id 形状。
const HEX64 = /^[0-9a-f]{64}$/;

console.log('helper =', helperBinPath());

const workDir = await mkdtemp(join(tmpdir(), 'celestea-desktop-smoke-'));
// 真实的 AttachmentStore（内容寻址 + 魔数校验 + 从图片头读宽高）——不是假的，
// 因为 c) 要验的就是「真仓库产出的 ImageRef 合不合 core 的 isImageRef」。
const attachments = createAttachmentStore(join(workDir, 'attachments'));
const client = new DesktopHelperClient({ helperPath: helperBinPath() });
const tools = Object.fromEntries(desktopTools({ client, attachments }).map((t) => [t.spec().name, t]));

const call = async (name, args) => {
  const tool = tools[name];
  if (tool === undefined) throw new Error('no such tool: ' + name);
  const value = await tool.execute(args);
  return value;
};

console.log('\n(a) handshake ping');
try {
  const hs = await client.handshake();
  check('handshake answered', true);
  console.log('      version =', hs.version);
  console.log('      platform =', hs.platform);
  console.log('      features =', JSON.stringify(hs.features));
  check('platform is win32', hs.platform === 'win32', hs.platform);
  check('features is a non-empty array', Array.isArray(hs.features) && hs.features.length > 0, String(hs.features?.length));
} catch (e) {
  check('handshake answered', false, String(e && e.message ? e.message : e));
}

console.log('\n(b) desktop_list_windows');
let windows = [];
try {
  const res = await call('desktop_list_windows', {});
  check('result is ok', res.ok === true, JSON.stringify(res).slice(0, 200));
  windows = Array.isArray(res.windows) ? res.windows : [];
  check('window list is non-empty', windows.length > 0, String(windows.length) + ' windows');
  const missing = windows.filter((x) => !x || x.app === undefined || x.id === undefined);
  check('every window carries app + id', missing.length === 0, missing.length + ' missing');
  console.log('      first 8 windows:');
  for (const win of windows.slice(0, 8)) console.log('        ', JSON.stringify(win));
} catch (e) {
  check('desktop_list_windows returned a result', false, String(e && e.message ? e.message : e));
}

console.log('\n(c) desktop_get_window_state on a real window');
// 优先挑 TARGET 指定的窗口；否则挑第一个「看起来像个正常应用窗口」的（有标题、
// 不是自己这个终端/外壳），因为对不可见/零尺寸窗口截图会得到一个没有意义的图。
const candidate =
  (TARGET ? windows.find((x) => String(x.app ?? '').toLowerCase().includes(TARGET.toLowerCase())) : undefined) ??
  windows.find((x) => typeof x.title === 'string' && x.title.trim() !== '') ??
  windows[0];
if (candidate === undefined) {
  check('a target window was found', false, 'no window to screenshot');
} else {
  console.log('      target =', JSON.stringify({ app: candidate.app, id: candidate.id, title: candidate.title }));
  try {
    const res = await call('desktop_get_window_state', { window: { app: candidate.app, id: candidate.id } });
    check('result is ok', res.ok === true, JSON.stringify(res).slice(0, 240));
    // (d) 顶层 attachments —— core 的投影只认这里。
    check('attachments are on the value TOP level', Array.isArray(res.attachments), JSON.stringify(Object.keys(res)));
    const refs = Array.isArray(res.attachments) ? res.attachments : [];
    check('at least one attachment', refs.length > 0, String(refs.length));
    for (const [i, ref] of refs.entries()) {
      check(`ref[${i}].attachment_id is 64 lowercase hex`, typeof ref.attachment_id === 'string' && HEX64.test(ref.attachment_id), String(ref.attachment_id));
      check(`ref[${i}].media_type is image/*`, typeof ref.media_type === 'string' && ref.media_type.startsWith('image/'), String(ref.media_type));
      check(`ref[${i}].width/height are integers >= 1`, Number.isInteger(ref.width) && ref.width >= 1 && Number.isInteger(ref.height) && ref.height >= 1, `${ref.width}x${ref.height}`);
      // bytes 只存在于附件文件里，所以「bytes>0」要真的回读一次才算验过。
      const dataUrl = await attachments.readDataUrl(ref.attachment_id);
      check(`ref[${i}] has bytes on disk (>0)`, typeof dataUrl === 'string' && dataUrl.length > 64, dataUrl === null ? 'null' : String(dataUrl.length) + ' chars of data URL');
    }
    console.log('      window =', JSON.stringify(res.window));
    console.log('      screenshots =', JSON.stringify(res.screenshots));
    console.log('      accessibility is', res.accessibility === null ? 'null (include_text defaulted to false)' : 'present');
  } catch (e) {
    check('desktop_get_window_state returned a result', false, String(e && e.message ? e.message : e));
  }
}

client.stop();
await rm(workDir, { recursive: true, force: true });
console.log('\n' + (failures === 0 ? 'SMOKE PASSED' : 'SMOKE FAILED: ' + failures + ' assertion(s)'));
process.exit(failures === 0 ? 0 : 1);
