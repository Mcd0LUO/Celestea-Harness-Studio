// ============================================================================
// ui/inputbar.ts — 输入栏（单一职责）：textarea 自动增高、Enter 行为、
// 发送/取消按钮状态。业务逻辑通过回调交给 chat.ts。
//
// W2028（触摸端换行）：Enter 的行为整段在 ./inputbar/newline.ts（触摸=换行 /
//   桌面=发送 / enterkeyhint），本文件只提供车道与重绘回调。
//
// W514 多会话 / 插话契约：
//   - 运行中**不再禁用发送**：Enter/发送 = 注入运行中的轮次（不新开轮）；
//   - worker 模式（W866）：worker 会话视图**可输入可发送** —— 用户的话走
//     POST /api/turn {session:'worker:<sid>'} 投进该 worker 自己的收件箱
//     （与模型 send_message 同一条投递），worker 正常继续；
//   - 发送/取消/停止按钮的显隐真源仍是 setBusy（当前聚焦会话的运行态）。
//
// W515 提交两态（对齐 DSH Agent Inbox 的两条车道）：
//   - Enter / 发送按钮 = 当前车道（默认 steer=插话，next-step 最近 step 边界送达）；
//   - Ctrl/Cmd+Enter = 另一条车道（queue=排队，next-turn 本轮结束后独立投递）；
//   - 输入栏右侧「插话/排队」小切换：只用鼠标也能选车道，文案与占位符随之变化。
// ============================================================================
import { el, need } from '../utils/dom';
import {
  addFiles,
  attachmentsEnabled,
  ATTACHMENT_ACCEPT,
  clearPendingImages,
  imageEntryDisabledReason,
  invalidateAttachmentCapabilities,
  isAttachmentCandidate,
  loadAttachmentCapabilities,
  // W869：文本项读成正文后重绘待发条。pendingList/removePending/renderTray 的消费方
  // 在 W867 拆出的 ./attach-tray.ts（本文件不再直接用）。
  onTextSettled,
} from './attachments';
// W867（追加）：展示夹的落位 / 尺寸 / 渲染接线整段在 ./attach-tray.ts，本文件只调用。
import { createAttachTray, refreshAttachmentTray } from './attach-tray';
import { initQuoteTray } from './quote/tray'; // F1：选段提及的待发引用 chip 收纳区
import { t } from '../i18n';
import { iconSvg } from './icons'; // W9324：回形针的几何真源在 ui/icons.ts
import { deviceCopy, isTouchInput, onInputCapabilityChange } from './viewport'; // W2023：设备能力分流（唯一真源）
import { paintModeButton, paintSendButton } from './inputbar/button-labels';
// W2028：Enter 行为（触摸=换行 / 桌面=发送）+ enterkeyhint，唯一判定在 ./inputbar/newline.ts。
//   §9.2 迁移之后：**判定逐字保留**在 newline.ts（enterAction），挂载点搬进 Lexical 的
//   keydown 命令（ui/composer/lexical.ts）；本文件只留 enterkeyhint 的 DOM 写入。
import { syncEnterKeyHint } from './inputbar/newline';
// §9.2：输入栏的**全部**读写（取文本/置文本/草稿/焦点/placeholder/键盘拦截）走适配缝，
//   本文件不再直接操作编辑器内容（composer-surface.md §9.2）。
import {
  canonicalText,
  clearComposer,
  mountComposer,
  setComposerPlaceholder,
  setComposerReadOnly,
  setComposerText,
} from './composer';
export { refreshAttachmentTray }; // 既有调用方（chat.ts / send.ts / 测试）不变

/**
 * 提交车道：
 *   steer —— next-step：注入运行中轮次的最近 step 边界（插话）
 *   queue —— next-turn：本轮结束后作为下一回合独立投递（排队）
 */
export type SubmitMode = 'steer' | 'queue';

export interface InputBarHandlers {
  /** 发送；text 为原始输入内容（trim/校验由调用方负责），mode = 提交车道。 */
  send(text: string, mode: SubmitMode): void;
  cancel(): void;
}

export type InputMode = 'idle' | 'interject' | 'worker';

// §9.3（W2016 退役）：textarea 的 field-sizing 自增高路径整体退役 —— field-sizing
// 不支持 div，Lexical 的 editor root 改用 max-height + overflow-y（styles/composer.css
// 是唯一真源）。退役后**输入路径上不再有任何样式读写**，也不再需要量高回调。
let inputEl: HTMLElement | null = null;

/**
 * 占位符（函数：语言切换后必须跟着变；W846 只说明输入行为，不重复状态词）。
 *
 * W2023：空闲档是**唯一**提到 Shift+Enter 的档位（插话 / 排队 / worker 三档只说
 * Enter 与 Ctrl/Cmd）。触摸设备没有 Shift 键 ⇒ 那条提示教不会用户任何东西，故按
 * 设备能力换词；分流点唯一（ui/viewport.ts 的 deviceCopy），不在这里再判一次。
 */
function placeholderIdle(): string {
  return deviceCopy('chat.input.placeholderIdle', 'chat.input.placeholderIdleTouch');
}
// W2028：运行中两档同样按设备能力分流 —— 触摸端 Enter 是**换行**，再教「Enter 插话 /
// Enter 排队」就是教错了键（与 W2023 删掉 Shift 提示同一条理由）。触摸端只指发送键
// （它是触摸端唯一的发送路径）；Ctrl/Cmd+Enter 仍可用，但不在这里广告（触摸设备没有
// Ctrl 键，说了也按不出来）。分流点仍是 deviceCopy 一处。
function placeholderSteer(): string {
  return deviceCopy('chat.input.placeholderSteer', 'chat.input.placeholderSteerTouch');
}
function placeholderQueue(): string {
  return deviceCopy('chat.input.placeholderQueue', 'chat.input.placeholderQueueTouch');
}
/** W866：worker 会话可输入，占位符说明**会送到哪里**。 */
function placeholderWorker(): string {
  return t('chat.input.placeholderWorker');
}

let bar: HTMLElement | null = null;
let sendBtn: HTMLButtonElement | null = null;
// W1512：#btnSend 是**发送/终止两态**的同一控件（照 DSH）。终止不再是 statusline 上
// 的独立 #slStop —— 那个位置在窄屏会被挤出视口（用户报障），且与 statusline 抢宽度。
let modeBtn: HTMLButtonElement | null = null;
/** 当前聚焦会话是否运行中（两态按钮的显隐真源）。 */
let busy = false;

/** 当前提交车道（运行中生效；空闲发送一律开新轮）。默认插话（= W514 行为）。 */
let submitMode: SubmitMode = 'steer';
/** 当前输入栏模式（文案/按钮重绘用）。 */
let inputMode: InputMode = 'idle';
export function getSubmitMode(): SubmitMode {
  return submitMode;
}

export function setSubmitMode(mode: SubmitMode): void {
  submitMode = mode;
  renderSubmitUi();
}

/** 两条车道互切（小切换按钮 / Ctrl+Enter 之外的入口）。 */
export function toggleSubmitMode(): void {
  setSubmitMode(submitMode === 'steer' ? 'queue' : 'steer');
}

/**
 * 当前模式该显示的占位符（**唯一**的「模式 × 车道 → 文案」映射）。
 *
 * W2023：抽出来是因为写占位符现在有两个触发源（模式/车道变化、输入能力变化）。
 * 原来这段三元表达式同时写在 renderSubmitUi 与 setInputMode 里 —— 再给能力变化加
 * 第三个副本，正是本仓复盘 §1.4「同一个判定抄三遍必漏一处」要防的事。
 */
function placeholderFor(mode: InputMode): string {
  if (mode === 'worker') return placeholderWorker();
  if (mode === 'interject') return submitMode === 'steer' ? placeholderSteer() : placeholderQueue();
  return placeholderIdle();
}

/** 按当前模式重写占位符（装配时与能力位变化后都走这里）。§9.3：原生 placeholder 体系退役。 */
function paintPlaceholder(): void {
  setComposerPlaceholder(placeholderFor(inputMode));
}

/** 车道相关 UI 重绘（切换按钮 / 占位符 / 发送按钮文案）——只改文案与 class。 */
function renderSubmitUi(): void {
  if (modeBtn) paintModeButton(modeBtn, submitMode);
  if (inputEl && inputMode === 'interject') {
    setComposerPlaceholder(submitMode === 'steer' ? placeholderSteer() : placeholderQueue());
  }
  // W1512：发送/终止是同一控件的两态，渲染统一走 paintSendButton（W866 的
  // 「按钮不禁用」语义包含在里面）。
  if (sendBtn) paintSendButton(sendBtn, busy, inputMode, submitMode);
}

export function initInputBar(h: InputBarHandlers): void {
  const input = need<HTMLElement>('#input');
  inputEl = input;
  bar = need<HTMLElement>('#inputbar');
  sendBtn = need<HTMLButtonElement>('#btnSend');
  modeBtn = document.getElementById('btnMode') as HTMLButtonElement | null;

  // §9.2（E4 直接替换）：装 Lexical 输入栏。它是编辑器的**唯一**装配点；
  //   Enter 车道（newline.ts 的 enterAction）、粘贴（纯文本 + 附件分道）、键盘总拦截口
  //   都在实现里，本文件只提供业务语义（车道 / 设备能力 / 附件车道）。
  mountComposer({
    mount: input,
    send: h.send,
    lane: () => submitMode,
    otherLane: () => (submitMode === 'steer' ? 'queue' : 'steer'),
    isTouch: isTouchInput,
    onFiles: (files) => acceptFiles(files),
  });
  // W2028：软键盘回车键上的字与 Enter 行为同源（判定在 newline.ts，能力位在 viewport.ts）。
  syncEnterKeyHint(input);

  // W1512：一个按钮，两个动作。运行中点 = 终止（沿用 #slStop 的单点语义与
  // 「点一次即禁用、防重复取消」的纪律）；空闲点 = 发送。共用 chat.ts requestCancel。
  sendBtn.addEventListener('click', () => {
    if (busy) {
      sendBtn!.disabled = true;
      h.cancel();
      return;
    }
    // 规范文本（chip 投影后）——与 Enter 车道读的是**同一个**真源（§9.2）。
    h.send(canonicalText(), submitMode);
  });
  modeBtn?.addEventListener('click', () => toggleSubmitMode());
  initAttachmentEntries(input, bar);
  // W2023：**装配时就要按设备能力写一次**。index.html 的 data-i18n-placeholder 只是
  // JS 起来之前那一帧的兜底，而它只能填一个 key（桌面版）—— 不在这里重写，触摸设备
  // 会一直显示「Shift+Enter 换行」直到第一次 setInputMode()，正是本轮要修的缺陷。
  paintPlaceholder();
  // W2023：输入能力位翻转（DevTools 设备仿真开关 / 二合一插拔鼠标）⇒ 重算占位符。
  // 只重画文案，不动 DOM、不动模式（铁律 4/5）。W2028：enterkeyhint 的同步在
  // ./inputbar/newline.ts 里（它与 Enter 行为同源，不在这里再写一遍）。
  onInputCapabilityChange(() => {
    paintPlaceholder();
    // W2028：enterkeyhint 与 Enter 行为同源（判定在 newline.ts，能力位在 viewport.ts）——
    // 能力位翻转时两样都要重算。
    if (inputEl) syncEnterKeyHint(inputEl);
  });
  renderSubmitUi();
}

/** 发送成功后清空输入框（§9.2：走适配缝，编辑器负责把内容与选区一起复位）。 */
export function clearInput(): void {
  clearComposer();
}

/** 当前输入框的**规范文本**（切换会话时保存草稿用）。 */
export function inputValue(): string {
  return canonicalText();
}

/** 写回输入框内容（切换会话恢复草稿 / 插话失败还原）。 */
export function setInputValue(v: string): void {
  setComposerText(v);
}

/**
 * 切换「停止」按钮状态（= 当前聚焦会话是否运行中）。
 * W514：**发送按钮不随 busy 禁用**（运行中发送走插话/排队路径）。
 * W846：取消按钮只剩 statusline 的 #slStop（#btnCancel 已移除）。
 */
export function setBusy(next: boolean): void {
  busy = next;
  renderSubmitUi();
}

/** 输入栏模式（空闲 / 插话·排队 / worker）——只切 class 与文案，不重建 DOM。 */
export function setInputMode(mode: InputMode): void {
  inputMode = mode;
  const input = inputEl;
  if (bar) {
    bar.classList.toggle('interject', mode === 'interject');
    bar.classList.toggle('worker', mode === 'worker');
    // W866：#inputbar 上不再有 .readonly —— 任何会话（含 worker）都可输入。
    bar.classList.remove('readonly');
  }
  if (modeBtn) modeBtn.classList.toggle('hidden', mode !== 'interject');
  if (input) {
    paintPlaceholder(); // W2023：唯一映射（见 placeholderFor）
    // W866：#inputbar 上不再有 .readonly —— 任何会话（含 worker）都可输入。
    setComposerReadOnly(false);
  }
  renderSubmitUi();
}

// ---- W805/W869：附件三入口（粘贴 / 拖拽 / 文件选择；图片 + 文本文件） ----------
//   W869：逐文件判定从「image/*」放宽到「图片或文本」，图片仍按图像能力位拦截。

let noteEl: HTMLElement | null = null;
let attachBtn: HTMLButtonElement | null = null;
let fileInput: HTMLInputElement | null = null;

/** W847：内联回形针（常量字面量、无依赖、无 emoji；沿用仓库既有内联 SVG 做法）。 */
const ATTACH_CLIP_SVG = iconSvg('attach-clip'); // W9324：几何真源在 ui/icons.ts（路径源自 lucide/paperclip）

function barEl(): HTMLElement | null {
  return bar ?? document.getElementById('inputbar');
}

/** 附件入口显隐/禁用文案（能力位就绪、切会话、切模型后重绘）。 */
export function refreshAttachmentEntry(): void {
  const allowed = attachmentsEnabled();
  const reason = imageEntryDisabledReason();
  if (attachBtn) {
    // W869：入口对「文本文件」始终可用（理由见文件头注释），图像能力位降级为按钮提示。
    attachBtn.classList.toggle('hidden', false);
    attachBtn.disabled = false;
    attachBtn.title = reason === '' ? t('chat.input.attachTitle') : reason;
  }
  // 旧服务未声明多模态：只清图片，不清本就可用的文本项（W869）。
  if (!allowed) clearPendingImages();
  refreshAttachmentTray();
}

// R3 W838-F4：保存配置 / 切换模型后能力位可能已变（input_modalities 改动、换模型）——
// 作废缓存并真重拉，再按新模型重绘入口按钮的禁用态与文案。事件由 statusline/config 派发。
window.addEventListener('studio:config-saved', () => {
  invalidateAttachmentCapabilities();
  void loadAttachmentCapabilities().then(refreshAttachmentEntry);
});

function noteAttachment(text: string): void {
  if (!noteEl) return;
  noteEl.textContent = text;
  noteEl.classList.toggle('hidden', text === '');
}

/**
 * W869：图片仍按**图像能力位**在入口拦截（W805 语义不变：不制造必然失败的请求）；
 * 文本文件与能力位无关 —— 任何模型都能读文本，同一批里文本照收、图片给出可执行原因。
 */
function acceptFiles(files: ArrayLike<File>): void {
  const reason = imageEntryDisabledReason();
  const kept: File[] = [];
  let droppedImages = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!f) continue;
    if (reason !== '' && f.type.indexOf('image/') === 0) droppedImages += 1;
    else kept.push(f);
  }
  const rejected = addFiles(kept);
  refreshAttachmentTray();
  if (droppedImages > 0) noteAttachment(reason);
  else if (rejected > 0) noteAttachment(t('chat.input.rejectedCount', { n: rejected }));
}

// W869：剪贴板附件的**逐文件判定**原本在 clipboardFiles 里；§9.2 迁移后粘贴入口由
//   Lexical 的 paste 命令统一接管（ui/composer/lexical.ts），文件逐项判定仍走
//   acceptFiles —— 能力位拦截与提示文案一个字没改，只是换了挂载点。

function dragHasFiles(e: DragEvent): boolean {
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (dt.types && Array.prototype.indexOf.call(dt.types, 'Files') >= 0) return true;
  return !!dt.files && dt.files.length > 0;
}

function acceptFileDialog(): void {
  // W869：选择框始终可点开（文本文件与图像能力位无关）；是否收下由逐文件校验决定。
  const reason = imageEntryDisabledReason();
  if (reason !== '') noteAttachment(reason);
  fileInput?.click();
}

function initAttachmentEntries(input: HTMLElement, host: HTMLElement): void {
  noteEl = el('div', 'attach-note hidden');
  const box = host.querySelector<HTMLElement>('.input-box');
  const side = host.querySelector<HTMLElement>('.input-side');
  // W867（追加）：展示夹的建立/挂载/贴位订阅整段在 ui/attach-tray.ts（出流，见该文件顶注）。
  createAttachTray(host, box);
  initQuoteTray(host, box);
  attachBtn = document.createElement('button');
  attachBtn.id = 'btnAttach';
  attachBtn.type = 'button';
  attachBtn.className = 'btn btn-soft btn-icon attach-inline';
  attachBtn.innerHTML = ATTACH_CLIP_SVG; // 内联回形针（常量字面量，无注入面）
  attachBtn.title = t('chat.input.attachTitle');
  attachBtn.setAttribute('aria-label', t('chat.input.attachAria')); // 图标按钮的无障碍名（W869：不再只收图片）
  attachBtn.addEventListener('click', () => acceptFileDialog());
  // W847：优先注入 .input-box（框内左下角、绝对定位）；旧夹具无 .input-box → 回退 .input-side。
  if (box) box.appendChild(attachBtn);
  else if (side && side.firstChild) side.insertBefore(attachBtn, side.firstChild);
  else (side ?? host).appendChild(attachBtn);

  fileInput = document.createElement('input');
  fileInput.id = 'attachInput';
  fileInput.type = 'file';
  fileInput.accept = ATTACHMENT_ACCEPT;
  fileInput.multiple = true;
  fileInput.className = 'attach-file hidden';
  fileInput.addEventListener('change', () => {
    // W869：选择框里的文件逐项判定（文本不看图像能力位，图片由 acceptFiles 按能力位拦截并说明）。
    if (fileInput && fileInput.files) {
      const picked: File[] = [];
      for (let i = 0; i < fileInput.files.length; i++) {
        const f = fileInput.files[i];
        if (f && isAttachmentCandidate(f)) picked.push(f);
      }
      if (picked.length > 0) acceptFiles(picked);
    }
    if (fileInput) fileInput.value = '';
  });

  host.insertBefore(noteEl, host.firstChild);
  host.appendChild(fileInput);

  // §9.2：粘贴**不在这里**挂了 —— Lexical 的 paste 命令是唯一入口：它强制纯文本，
  // 并把剪贴板里的文件交给 mountComposer 的 onFiles（同一个 acceptFiles）。
  // 少挂一条 ⇒ 少一条静默失效的入口（附件三入口之一）。
  void input;

  document.addEventListener('dragover', (e) => {
    // W869：拖拽入口不再按图像能力位整体关闭（文本文件照收）；逐文件校验在 addFiles。
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    barEl()?.classList.add('drop-active');
  });
  document.addEventListener('dragleave', (e) => {
    if (dragHasFiles(e)) barEl()?.classList.remove('drop-active');
  });
  document.addEventListener('drop', (e) => {
    barEl()?.classList.remove('drop-active');
    const dt = e.dataTransfer;
    if (!dt) return;
    if (!dt.files || dt.files.length === 0) return;
    e.preventDefault();
    acceptFiles(dt.files);
  });

  // W869：文本项读成正文（或判为二进制）后重绘待发条 —— 二进制伪装成 .txt 的那一项
  // 就地标红并给出可见原因，不静默丢弃；图片摘要不改外观，无需重绘。
  onTextSettled(refreshAttachmentTray);

  refreshAttachmentEntry();
  void loadAttachmentCapabilities().then(refreshAttachmentEntry);
}
