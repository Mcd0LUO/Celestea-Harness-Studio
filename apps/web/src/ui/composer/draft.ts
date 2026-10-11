// ============================================================================
// ui/composer/draft.ts — 草稿持久化的**编解码**（composer-surface §9.1 E3 三条纪律）
// ----------------------------------------------------------------------------
// E3 选了「序列化编辑器状态」而不是「纯文本重解析」，代价是三条纪律，全部在这里落地：
//
//   ① **载荷带 v 版本字段**。没有它，一次读取失败与一次跨版本读取长得一模一样，
//      都会静默变成「空草稿」—— 用户丢了字却看不到任何解释。
//   ② **node 注册表冻结**。序列化状态里存的是 node 类型名；A4b 加一种 chip 节点后，
//      旧草稿里的老状态可能含已不存在的类型。把注册表的指纹写进载荷，读的时候对不上
//      就走降级路径 —— 这让「新增 node 类型」成为**契约变更**（要改指纹）而不是
//      一次「用户草稿静默变空」的发布事故。
//   ③ **读取失败 / 未知 node ⇒ 回退纯文本**（宁可丢 chip，不丢字）。载荷里始终带一份
//      规范文本的明文副本，所以任何一步失败都还有字可捞。
//
// 纯函数、无 DOM、无 Lexical import ⇒ 纪律①②③可以在 node 里逐条钉死。
// ============================================================================

/** 载荷版本。任何不兼容的形状变更都必须 +1（并在 decode 里显式处理旧版）。 */
export const DRAFT_VERSION = 1;

/** 落盘的载荷形状（**冻结**的契约：字段名与含义都不许随手改）。 */
export interface DraftPayload {
  /** 纪律①：载荷版本。 */
  readonly v: number;
  /** 纪律②：冻结 node 注册表的指纹。 */
  readonly nodes: string;
  /** 纪律③：规范文本明文副本（任何降级路径的最后兜底）。 */
  readonly text: string;
  /** 序列化编辑器状态；null = 没有可用状态（只有字）。 */
  readonly state: string | null;
}

/** 解码结果：state = 照状态恢复；text = 降级纯文本；empty = 本来就没有草稿。 */
export type DecodedDraft =
  | { readonly kind: 'state'; readonly v: number; readonly text: string; readonly state: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'empty' };

/** node 注册表指纹：注册表变了（新增/删除 node 类型）⇒ 指纹变 ⇒ 旧草稿走降级。 */
export function nodeFingerprint(nodes: readonly string[]): string {
  return nodes.join(',');
}

/** 编码：把「规范文本 + 序列化状态」打成可落盘的字符串。 */
export function encodeDraft(text: string, state: string | null, nodes: readonly string[]): string {
  const payload: DraftPayload = { v: DRAFT_VERSION, nodes: nodeFingerprint(nodes), text, state };
  return JSON.stringify(payload);
}

/**
 * 解码：把落盘字符串还原成「照状态恢复」或「降级纯文本」或「空」。
 *
 * 降级（返回 { kind:'text' }）的**全部**触发条件，刻意列全 —— 少一条就是一条静默丢字：
 *   · 版本字段缺失或 ≠ DRAFT_VERSION（旧版载荷 / 别的格式写进来了）
 *   · node 注册表指纹对不上（A4b 加了 chip 节点后的旧草稿）
 *   · state 不是非空字符串
 * 一律退回载荷里的 text 明文副本。
 */
export function decodeDraft(raw: string | null | undefined, nodes: readonly string[]): DecodedDraft {
  if (typeof raw !== 'string' || raw === '') return { kind: 'empty' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 不是 JSON：可能是早期版本的裸文本草稿 —— 那本身就是要的字，降级读出来。
    return { kind: 'text', text: raw };
  }
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'text', text: raw };
  const p = parsed as Partial<DraftPayload>;
  const text = typeof p.text === 'string' ? p.text : '';
  if (p.v !== DRAFT_VERSION) return { kind: 'text', text };
  if (p.nodes !== nodeFingerprint(nodes)) return { kind: 'text', text };
  if (typeof p.state !== 'string' || p.state === '') return { kind: 'text', text };
  return { kind: 'state', v: p.v, text, state: p.state };
}

// ---- 刷新后恢复：按会话分键存本地（草稿在**页面刷新**后也要回来） ------------------

const STORAGE_PREFIX = 'celestea.composer.draft.';

/** 存储键（按会话 id 分；无会话 = 本地单会话）。 */
export function draftKey(sessionId: string): string {
  return STORAGE_PREFIX + (sessionId === '' ? 'local' : sessionId);
}

/** 读一份落盘草稿（storage 不可用 / 没有 ⇒ null，绝不抛）。 */
export function readStoredDraft(sessionId: string): string | null {
  try {
    return window.localStorage.getItem(draftKey(sessionId));
  } catch {
    return null; // 隐私模式 / 配额满：草稿降级为「不跨刷新」，不假装成功
  }
}

/** 写一份落盘草稿；空载荷 ⇒ **删掉键**（不留一份空草稿冒充「有草稿」）。 */
export function writeStoredDraft(sessionId: string, payload: string): void {
  try {
    if (payload === '' || payload === '{}') {
      window.localStorage.removeItem(draftKey(sessionId));
      return;
    }
    window.localStorage.setItem(draftKey(sessionId), payload);
  } catch {
    /* 同上：写不进去就只影响跨刷新恢复，不影响本次会话 */
  }
}
