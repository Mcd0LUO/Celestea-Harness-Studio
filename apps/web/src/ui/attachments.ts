// ============================================================================
// ui/attachments.ts — W805 多模态附件前端半边（P0，零新端点）：
//   三入口 / 按会话隔离的待发状态 / 能力位 / 历史只渲染元数据（§7.4）；渲染零件见 ./attachment-view。
// ============================================================================
import { t } from '../i18n';
import { activePane, onPaneChange, paneOf } from './viewctx';
// W9229（F-15/F-16/F-17/F-18）：预览 URL 的登记表拆到 ./attach-preview.ts（纯状态，零 DOM）——
// 键带会话维度、吊销按「谁还持有它」判据。本文件仍是唯一业务入口。
import {
  previewUrlOf,
  releasePreviewIf,
  releasePreviewsOf,
  rememberPreview,
  revokeUrl,
} from './attach-preview';
import { bubbleRefCount, fmtBytes, type AttachmentView } from './attachment-view';
import type { AttachmentRef, ImageMediaType, TurnAttachmentInput } from '../types/attachment';
import { TEXT_ACCEPT, notifyTextSettled, settleTextItem, textPendingItem, textRejectReason } from './text-attach';

export { renderAttachmentGrid, renderTray } from './attachment-view';
// W9229：能力位与降级文案拆到 ./attach-caps.ts（纯搬家，名字与语义一字未变）。
export {
  attachmentsEnabled,
  currentModel,
  downgradeNotice,
  imageCapableModels,
  imageEntryDisabledReason,
  invalidateAttachmentCapabilities,
  isImageDowngrade,
  loadAttachmentCapabilities,
  modelAllowsImages,
} from './attach-caps';
export type { AttachmentView } from './attachment-view';
// W869：文本附件的公开面（判定 / 上限 / 注入 / 落定通知）从本模块统一再导出，
// 入口（inputbar）与发送编排（send）只需认这一处。
export { MAX_TEXT_FILE_BYTES, TEXT_BLOCK_DELIMITER, isAttachmentCandidate, onTextSettled } from './text-attach';

/** P0 自限（设计 §5.3；前端先拦必然失败的请求）。 */
export const MAX_ATTACHMENTS = 20;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** W805 的四个图片项**原样保留**，W869 只在其后追加常见文本（选择框提示；判定仍逐文件走）。 */
export const ATTACHMENT_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,' + TEXT_ACCEPT;
const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

/** 一条待发附件（含本地预览 URL；error 非空 = 选择时就被拒绝，不会发出）。 */
export interface PendingAttachment {
  file: File;
  name: string;
  url: string;
  bytes: number;
  /** sha256(原始字节) 的十六进制；P0 不做规范化，故与 attachment_id 一致。 */
  id: string;
  error: string;
  /**
   * W869：'text' = 文本文件项（发送时读成正文、注入消息文本，不进 attachments 数组）；
   * 缺省 'image' = 既有图片项（逐字节语义不变）。
   */
  kind?: 'image' | 'text';
  /** 文本项读出的 UTF-8 正文（异步落定；undefined = 尚未读完或读取失败）。 */
  text?: string;
}

// ---- 待发状态（按会话隔离） ----------------------------------------------------

const drafts = new Map<string, PendingAttachment[]>();

function sessionKey(): string {
  return activePane()?.id ?? '';
}

/**
 * W9229（F-18）：一条 URL「还能不能吊销」的**唯一判据** —— 有没有别的地方还引用它。
 *
 * 同一条 objectURL 有两个消费者：待发条的缩略图与**已发送气泡**里的附件网格
 * （send.ts 把 pendingViews(items) 交给 addUserMessage，user.ts 再交给
 * renderAttachmentGrid）。改动前这里无差别吊销该会话全部预览，于是「清空待发区 /
 * 切会话」会把已经画进历史气泡的 <img> 打成碎图（要等下一次刷新才退化成元数据占位）。
 *
 * 判据只看**文档里还有没有引用它的 <img>**，不区分这条登记当初是被谁登记的：
 * 待发项持有的 URL 在没人引用时照旧吊销（R3 W838-F1 的语义不变），被气泡引用的 URL
 * 则留到气泡消失（容器淘汰/会话删除时再一起回收）。
 */
function revokeable(url: string): boolean {
  return !hasBubbleRef(url);
}

// 会话切换即回收上一会话的预览（不用等 GC，也不把 blob 留在长会话里）。
onPaneChange((pane, prev) => {
  if (prev && prev.id !== pane.id) releasePreviewsOf(prev.id, revokeable);
});

/**
 * W9229（F-17）：容器被淘汰 / 会话被删除时，把该会话的待发项连同 objectURL 一起释放。
 *
 * 改动前 drafts 只按会话 id 累积、**没有任何**释放路径：用户在 20 个会话里各挂一张
 * 20MB 未发送的图，容器早被 evictIfNeeded（MAX_PANES=12）淘汰、UI 上再也看不到，
 * 而 drafts 仍持有 20 ×（File + objectURL）。挂 onPaneChange 上做不到这件事 ——
 * 淘汰发生在**另一个**会话激活的过程中，回调只拿到新/旧容器。
 */
function dropDraftsOf(session: string): void {
  const list = drafts.get(session);
  if (list === undefined) return;
  drafts.delete(session);
  for (const p of list) revokeUrl(p.url);
  // 容器没了 ⇒ 该会话的气泡也随 DOM 消失；但仍按同一判据走，避免「同一张图在另一个
  // 会话的气泡里还开着」时被误吊销（同内容 ⇒ 同 attachment_id ⇒ 可能同 URL）。
  releasePreviewsOf(session, revokeable);
}

/**
 * 容器淘汰（evictIfNeeded）与会话删除（dropPane）都会把容器从注册表摘掉，但它们**不是**
 * 都发生在「上一个容器」身上：一次切换可能同时淘汰一个**更早**的容器（evictIfNeeded
 * 挑的是最久未用者）。所以判据是「drafts 里的会话还有没有容器」，在每次切换时扫一遍
 * —— 扫的是「有草稿的会话数」（个位数），不是消息节点。
 */
onPaneChange(() => {
  for (const id of Array.from(drafts.keys())) {
    if (paneOf(id) === undefined) dropDraftsOf(id);
  }
});

function objectUrl(file: File): string {
  try {
    return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : '';
  } catch {
    return '';
  }
}

function looksImage(file: File): boolean {
  if (MEDIA_TYPES.indexOf(file.type) >= 0) return true;
  if (file.type === '' || file.type.indexOf('image/') === 0) return IMAGE_EXT.test(file.name);
  return false;
}

function rejectReason(file: File, validCount: number, batch: number): string {
  if (validCount + batch > MAX_ATTACHMENTS) return t('chat.attach.maxCount', { n: MAX_ATTACHMENTS });
  if (!looksImage(file)) return textRejectReason(file);
  if (file.size > MAX_ATTACHMENT_BYTES) return t('chat.attach.maxBytes', { size: fmtBytes(MAX_ATTACHMENT_BYTES) });
  return '';
}

async function attachId(item: PendingAttachment, session: string): Promise<void> {
  try {
    const subtle = globalThis.crypto ? globalThis.crypto.subtle : undefined;
    if (!subtle) return;
    const digest = await subtle.digest('SHA-256', await item.file.arrayBuffer());
    item.id = hex(new Uint8Array(digest));
    // ★ W9229（F-15）：摘要在**异步**期间用户可能已经点了 ×。此时该条目的 URL 已被
    //   removePending 吊销，若这里照旧登记，预览表里就留下一条指向**已吊销** URL 的
    //   记录 —— 它挤占 MAX_PREVIEWS 上限、把**有效**预览挤出去（那些气泡变白）。
    //   判据是「条目还在不在本会话的待发区」（状态），不是「摘要跑完没有」（时间）。
    if (!(drafts.get(session) ?? []).includes(item)) return;
    // 登记本会话预览：历史恢复（同一次会话内）据此显示缩略图而非仅元数据。
    rememberPreview(session, item.id, item.url);
  } catch {
    /* id 缺失只影响本会话历史缩略图，不影响发送 */
  }
}

/**
 * 三入口公共落点：先校验、再**当帧**入列（异步摘要 / 文本读取都不阻塞渲染）。返回被拒条数。
 * W869：图片走既有校验、文本走新校验，**同一批上限共用**；
 *   图片项、图片项的 url/id 与异步摘要路径逐字节不变；
 *   文本项 url 留空、正文读到之前 text 为 undefined（发送前若仍读不出即中止发送）。
 */
export function addFiles(files: ArrayLike<File>): number {
  const key = sessionKey();
  const list = drafts.get(key) ?? [];
  let accepted = list.filter((p) => p.error === '').length;
  const batch = files.length;
  let rejected = 0;
  for (let i = 0; i < batch; i++) {
    const file = files[i];
    if (!file) continue;
    // R3 W838-F8：按**已接受数**逐条递推，超上限的溢出项才拒（不再整批全拒）。
    const error = rejectReason(file, accepted, 1);
    if (error !== '') rejected += 1;
    else accepted += 1;
    const text = error === '' && !looksImage(file);
    const item = text
      ? textPendingItem(file, error)
      : { file, name: file.name || t('chat.attach.imageName'), url: objectUrl(file), bytes: file.size, id: '', error };
    list.push(item);
    if (text) {
      if (error === '') void settleTextItem(item).then(notifyTextSettled);
    } else {
      void attachId(item, key);
    }
  }
  drafts.set(key, list);
  return rejected;
}

export function pendingList(): PendingAttachment[] {
  return (drafts.get(sessionKey()) ?? []).slice();
}

/** 可发送条数（被拒的红色项不计）。 */
export function pendingCount(): number {
  return (drafts.get(sessionKey()) ?? []).filter((p) => p.error === '').length;
}

export function removePending(item: PendingAttachment): void {
  const key = sessionKey();
  const list = drafts.get(key) ?? [];
  const i = list.indexOf(item);
  if (i >= 0) {
    list.splice(i, 1);
    revokeUrl(item.url); // R3 W838-F1：移除即吊销，不等 GC
    releasePreviewIf(key, item.id, item.url);
  }
  drafts.set(key, list);
}

/** 发送时取走本会话全部待发项（被拒项一并清掉），并登记本会话内预览。 */
export function takePending(key: string = sessionKey()): PendingAttachment[] {
  const list = drafts.get(key) ?? [];
  const sendable = list.filter((p) => p.error === '');
  drafts.set(key, []);
  // W9229（F-18）：这些 URL 随后会被画进**已发送气泡**的附件网格，所以登记时也保留 ——
  // 它们此后不再由「待发项持有」，切会话/清空待发区的吊销判据因此不会碰它们。
  for (const p of sendable) rememberPreview(key, p.id, p.url);
  return sendable;
}

/** 发送失败：把附件放回待发区（不丢文件，可直接重试）。 */
export function restorePending(key: string, items: readonly PendingAttachment[]): void {
  drafts.set(key, items.concat(drafts.get(key) ?? []));
}

export function clearPending(): void {
  const key = sessionKey();
  for (const p of drafts.get(key) ?? []) {
    revokeUrl(p.url); // R3 W838-F1：清空即吊销
    releasePreviewIf(key, p.id, p.url);
  }
  drafts.set(key, []);
  // ★ W9229（F-18）：只回收**没有别处引用**的登记（见 revokeable）。
  releasePreviewsOf(key, revokeable);
}

/**
 * W869：只清图片项（旧服务未声明多模态时的入口回收）—— 文本文件不需要多模态能力位，
 * 不再跟着被清掉。返回值 = 被清掉的项数（0 = 本次没有图片可清）。
 */
export function clearPendingImages(): number {
  const key = sessionKey();
  const list = drafts.get(key) ?? [];
  const kept: PendingAttachment[] = [];
  let dropped = 0;
  for (const p of list) {
    if (p.kind === 'text') {
      kept.push(p);
      continue;
    }
    dropped += 1;
    revokeUrl(p.url);
    releasePreviewIf(key, p.id, p.url);
  }
  drafts.set(key, kept);
  // 与 clearPending 同一口径：只回收已经没人引用的登记（F-18）。
  releasePreviewsOf(key, revokeable);
  return dropped;
}

/** R3 W838-F2：有附件根本没读出来 —— 抛错中止发送，绝不发一个缺内容的请求。 */
export class AttachmentReadError extends Error {
  readonly names: readonly string[];
  constructor(names: readonly string[]) {
    super(t('chat.attach.readFailed', { names: names.join(t('chat.question.answerSep')) || t('chat.attach.unknownFile') }));
    this.name = 'AttachmentReadError';
    this.names = names;
  }
}

/**
 * 待发 → 连线格式（内联 base64；与 POST /api/turn 的 attachments 同形）。
 * W869：**只收图片项**（kind 缺省即图片）；文本项不进 attachments 数组，
 * 其正文由 injectTextAttachments 注入消息文本 —— 图片路径因此逐字节不变。
 * 文本项若到发送时仍没有正文（读取失败），与读图失败同一条路径中止发送。
 */
export async function toWire(items: readonly PendingAttachment[]): Promise<TurnAttachmentInput[]> {
  const out: TurnAttachmentInput[] = [];
  const failed: string[] = [];
  for (const item of items) {
    if (item.kind === 'text') {
      if (item.text === undefined) failed.push(item.name);
      continue;
    }
    const data = await readBase64(item.file);
    if (data === '') failed.push(item.name);
    else out.push({ data, name: item.name });
  }
  if (failed.length > 0) throw new AttachmentReadError(failed);
  return out;
}


function readBase64(file: File): Promise<string> {
  return new Promise((resolve) => {
    try {
      const r = new FileReader();
      r.onload = () => {
        const s = typeof r.result === 'string' ? r.result : '';
        const i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : '');
      };
      r.onerror = () => resolve('');
      r.readAsDataURL(file);
    } catch {
      resolve('');
    }
  });
}

export function pendingViews(items: readonly PendingAttachment[]): AttachmentView[] {
  return items.map((it) => ({ name: it.name, url: it.url, bytes: it.bytes, kind: it.kind }));
}

// ---- 引用 ↔ 视图 ---------------------------------------------------------------

/**
 * 历史条目里的附件引用 → 视图（有预览就画图，没有就退化成元数据占位）。
 *
 * ★ W9229（F-16）：`session` 是**读预览的会话**，缺省 = 当前聚焦容器。attachment_id 是
 *   sha256(原始字节)，两个会话上传同一张图必然是同一个 id；不带会话读会读到**别的会话**
 *   的 URL（显示错图，且那条 URL 的生命周期归属也错了）。
 */
export function attachmentViewsOf(
  refs: readonly AttachmentRef[] | undefined,
  session: string = sessionKey(),
): AttachmentView[] {
  if (!refs) return [];
  return refs.map((ref) => ({ ref, name: ref.name, url: previewUrlOf(session, ref.attachment_id) }));
}

/**
 * W9229（F-18）：该 URL 是否仍被**文档里的**附件气泡引用（已发送气泡的 <img src>）。
 *
 * 这是「已发送气泡」这一消费者在吊销判据里的可观测面。挂载在渲染层（attachment-view）
 * 的读法住在渲染模块；本模块只做一次只读查询，不持任何 DOM 状态。
 */
function hasBubbleRef(url: string): boolean {
  return bubbleRefCount(url) > 0;
}


/** 工具结果 value 里的 attachments（read_image 的图片通道，设计 §6.3）。 */
export function refsOfValue(value: unknown): AttachmentRef[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const raw = (value as Record<string, unknown>)['attachments'];
  if (!Array.isArray(raw)) return [];
  const out: AttachmentRef[] = [];
  for (const v of raw) {
    const ref = asRef(v);
    if (ref) out.push(ref);
  }
  return out;
}

function asRef(v: unknown): AttachmentRef | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const id = r['attachment_id'];
  const media = r['media_type'];
  const w = r['width'];
  const h = r['height'];
  if (typeof id !== 'string' || typeof media !== 'string') return null;
  if (MEDIA_TYPES.indexOf(media) < 0) return null;
  if (typeof w !== 'number' || typeof h !== 'number') return null;
  const out: AttachmentRef = { attachment_id: id, media_type: media as ImageMediaType, width: w, height: h };
  if (typeof r['name'] === 'string') out.name = r['name'];
  return out;
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += (b < 16 ? '0' : '') + b.toString(16);
  return s;
}
