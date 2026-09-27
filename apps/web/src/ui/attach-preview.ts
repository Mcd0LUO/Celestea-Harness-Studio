// ============================================================================
// ui/attach-preview.ts — W9229：附件预览 objectURL 的**登记表**（纯状态，零 DOM）
// ----------------------------------------------------------------------------
// 为什么单独一个模块：ui/attachments.ts 已贴在模块体积门禁（默认上限 450 行）的上沿，
// 而本轮要把「一条预览 URL 的生命周期」从「按 attachment_id 一张表」改成
// 「按 (会话, attachment_id) 记账 + 按**谁还持有它**回收」。口径与 W805/W869 把渲染
// 零件拆到 ./attachment-view.ts 相同：只搬状态与吊销判据，attachments.ts 仍是唯一
// 业务入口与唯一调用方。
//
// 三条不变式（= 本轮 P2 三条发现的修复本体，逐条都有门禁）：
//   ① 键必须带**会话维度**（F-16）：attachment_id = sha256(原始字节)，两个会话上传
//      同一张图必然得到同一个 id；只用 id 当键时后登记者会把先登记者顶掉 —— 先登记的
//      那条 URL 从此「既不归 A 管也不归 B 管」（A 的回收按 e.session 扫，而它已被换成
//      B 的会话标记），永久泄漏；反过来 A 会话还可能读到 B 的 URL（显示错图）。
//   ② 只有「仍被待发项持有」的 URL 才能被**切会话/清空待发区**回收（F-18）：同一条
//      URL 有两个消费者 —— 待发条的缩略图与**已发送气泡**里的附件网格。无差别吊销会把
//      历史气泡里的 <img> 变成碎图（下一次刷新才退化成元数据占位）。
//   ③ 异步摘要落地时条目**已被移除** ⇒ 不得登记（F-15）：否则表里留下一条指向**已吊销**
//      URL 的记录，它挤占 MAX_PREVIEWS 上限、把**有效**预览挤出去（那些气泡因此变白）。
//      「用坏记录挤掉好记录」比单纯泄漏一个 URL 更糟，所以判据必须落在**条目还在不在
//      待发区**（状态），而不是「摘要有没有跑完」（时间）。
//      ★ 上限口径如实记账：本仓把「覆盖旧登记」与「超过 MAX_PREVIEWS 挤掉最旧」都算作
//      「不再由待发项持有」的回收；而删除/淘汰**待发项**时 URL 仍会在待发区被 revoke
//      （见 attachments.ts 的 removePending / clearPending / dropDraftsOf），所以 F-15
//      真正修掉的是「坏记录挤掉好记录」，不是「URL 永不吊销」。
// ============================================================================

/** 预览 URL 的硬上限：超出即回收最旧的一条（长会话不再只增不减）。 */
export const MAX_PREVIEWS = 64;

interface PreviewEntry {
  url: string;
  /** 登记时的会话：键的一部分，也用于按会话批量回收。 */
  session: string;
}

/** 键 = `会话 + \0 + attachment_id`；Map 的插入序 = 回收顺序。 */
const previews = new Map<string, PreviewEntry>();

function keyOf(session: string, id: string): string {
  return session + '\u0000' + id;
}

/** 吊销一个 objectURL（旧环境没有 revokeObjectURL：忽略）。 */
export function revokeUrl(url: string): void {
  try {
    if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
  } catch {
    /* 旧环境：忽略 */
  }
}

function dropKey(key: string): void {
  const e = previews.get(key);
  if (!e) return;
  previews.delete(key);
  revokeUrl(e.url);
}

/**
 * 登记一条预览 URL。
 *
 * 同键覆盖时**不吊销旧值**（与改动前一致）：同键 = 同会话同内容，URL 通常就是同一条，
 * 吊销它会把刚渲染的缩略图打死。跨会话不再同键（①），所以改动前那种「覆盖即泄漏」
 * 的路径不复存在。
 */
export function rememberPreview(session: string, id: string, url: string): void {
  if (id === '' || url === '') return;
  const key = keyOf(session, id);
  previews.delete(key); // 重新插入：刷新回收顺序
  previews.set(key, { url, session });
  while (previews.size > MAX_PREVIEWS) {
    const oldest = previews.keys().next().value;
    if (oldest === undefined) break;
    dropKey(oldest);
  }
}

/** 该会话里这个 attachment_id 的预览 URL（未登记 = undefined ⇒ 调用方退化成元数据占位）。 */
export function previewUrlOf(session: string, id: string): string | undefined {
  return previews.get(keyOf(session, id))?.url;
}

/** 仅当登记的 URL 就是这一条时才回收（同 id 不同 URL 的边界）。 */
export function releasePreviewIf(session: string, id: string, url: string): void {
  const key = keyOf(session, id);
  const e = previews.get(key);
  if (e && e.url === url) dropKey(key);
}

/**
 * 按会话回收。`revoke` 是**判据**（不是「这个函数被调用过」）：
 * 返回 true 的 URL 才吊销。
 *   · 切会话：传「仍被待发项持有」—— 待发条的 URL 要吊销（R3 W838-F1），
 *     已发送气泡仍引用的 URL 必须留下（F-18）；
 *   · 容器被淘汰/删除：**不传** ⇒ 该会话的预览全部回收（气泡随容器一起没了）。
 */
export function releasePreviewsOf(session: string, revoke?: (url: string) => boolean): void {
  for (const [key, e] of Array.from(previews)) {
    if (e.session !== session) continue;
    if (revoke !== undefined && !revoke(e.url)) continue;
    dropKey(key);
  }
}
