/**
 * 截图桥：helper 的 `images` → AttachmentStore → 工具结果顶层的 `attachments`。
 *
 * 为什么走「顶层 attachments」而不是把 base64 塞进 value 文本：core 的
 * `projection.ts::toolResultOf` 已经在扫工具结果 value 的**顶层** `attachments`
 * 数组，命中就把每个 ImageRef 投影成一个 image block（W804 的既有链路，
 * browser_open/browser_act 的截图就走它）。所以这里只负责产出合规的 ImageRef[]，
 * 投影是 core 的事——本包不认识 image block，也不该认识。
 *
 * 合规由谁保证：`ImageRef` 的 `attachment_id` 必须是 64 位小写 hex、`width/height`
 * 必须是 >= 1 的整数（core/src/message.ts::isImageRef）。本包**不自己造**这些字段：
 * AttachmentStore.put() 从字节算 sha256、从图片头读宽高，所以唯一真源是那份
 * 实现。手工拼一个 `{attachment_id:"shot-0"}` 看着能过 typecheck，却会被投影
 * 静默丢掉——那正是「看起来在工作、其实没在工作」。
 *
 * 没有 store 时怎么办：**不把 base64 塞回文本**。helper/src/images.rs 已经把内联
 * data URL 从 value 里删掉了（它明确写着这条像素数据绝不能以文本形式进模型），
 * 所以宁可交一份「有截图但这次没带回来」的诚实结果 + 说明，也不违反那条规则。
 */

import type { ImageRef } from "@celestea/core";
import { DesktopError, type DesktopAttachmentStore, type HelperImage } from "./types.js";

/** base64 → 字节；helper 给的是**无前缀**的 base64（images.rs 已经切掉了 data: 头）。 */
export function helperImageBytes(image: HelperImage): Buffer {
  return Buffer.from(image.data, "base64");
}

/** 扩展名按 helper 报的 mimeType 推；AttachmentStore 自己按魔数校验内容，扩展名只是可读性。 */
function fileNameFor(image: HelperImage, index: number): string {
  const base = image.name === undefined || image.name.trim() === "" ? `desktop-shot-${index}` : image.name.trim();
  const ext = image.mimeType.includes("png") ? "png" : image.mimeType.includes("webp") ? "webp" : "jpg";
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}

export interface BridgeOutcome {
  /** 写进工具结果顶层的引用（core 的投影会把它变成 image block）。 */
  readonly attachments: readonly ImageRef[];
  /** 诚实降级时给模型看的一句话；正常路径为空数组。 */
  readonly notes: readonly string[];
}

/**
 * 把一次调用拆出来的截图存进会话附件仓库。
 *
 * 失败**逐张隔离**：一张坏图不该让整次 get_window_state 变成失败——窗口状态本身
 * （标题、可访问性树、几何）往往还是有用的。存不下的那张进 notes。
 */
export async function storeHelperImages(
  images: readonly HelperImage[],
  store: DesktopAttachmentStore | null | undefined,
): Promise<BridgeOutcome> {
  if (images.length === 0) return { attachments: [], notes: [] };
  if (store === null || store === undefined) {
    return {
      attachments: [],
      // 措辞照 packages/tools/src/browser/session.ts 的同一条降级先例：说清楚
      // 发生了什么、还剩什么可用，而不是假装截图回来了。
      notes: [
        `${images.length} screenshot(s) were captured but this session has no attachment store, so the pixels are not available to you. ` +
          "The window metadata below is still accurate; ask for it again in a session with an image-capable model if you need to see the pixels.",
      ],
    };
  }
  const attachments: ImageRef[] = [];
  const notes: string[] = [];
  for (const [index, image] of images.entries()) {
    try {
      attachments.push(await store.put({ bytes: helperImageBytes(image), name: fileNameFor(image, index) }));
    } catch (e) {
      const message = e instanceof DesktopError || e instanceof Error ? e.message : String(e);
      notes.push(`screenshot ${image.name ?? index} could not be stored: ${message}`);
    }
  }
  if (attachments.length === 0 && notes.length > 0) {
    notes.push("no screenshot could be delivered; the window metadata below is still accurate.");
  }
  return { attachments, notes };
}
