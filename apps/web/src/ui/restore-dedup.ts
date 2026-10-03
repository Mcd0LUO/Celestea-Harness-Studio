// ============================================================================
// ui/restore-dedup.ts — W9229：live 增量与「已恢复历史尾部」的衔接去重（纯状态，零 DOM）
// ----------------------------------------------------------------------------
// 从 ui/restore.ts 拆出（模块体积门禁：本轮要在这里修 F-19）。**纯搬家 + 一处修复**：
//   · guardBuf 加硬上限（= 尾部长度，见 guardBufLimit）；
//   · finalAssistantDedup 在「整条被吞」时保留 tail 锚点（否则第二次重连补发会重复）。
// 调用方（chat.ts）仍从 ui/restore.ts 拿同一组名字。
// ============================================================================
import type { SessionPane } from './viewctx';

// ---- 衔接去重状态（每容器一份） ------------------------------------------------

/**
 * W9229（F-19）：重放守卫缓冲的**硬上限**。
 *
 * 守卫期间 `guardBuf` 会一路累积到「已恢复尾部」的长度 —— 一条 196K 字符的工具结果
 * 后紧跟的助手正文就是尾部长度本身（服务端重连从该助手消息开头重放）。所以上限取
 * 尾部长度即可判定发散：缓冲**超过**尾部长度时它必然已不是尾部的前缀，
 * 只差一次「不匹配」的调用把它吐出去。
 */
export function guardBufLimit(tail: string): number {
  return tail.length;
}

/** 重置去重状态（清空会话后调用）。 */
export function resetRestore(ctx: SessionPane): void {
  ctx.dedup.tail = null;
  ctx.dedup.guardActive = false;
  ctx.dedup.guardBuf = '';
  ctx.dedup.guardAll = false;
  ctx.dedup.guardTurn = null;
}

/**
 * ★ W9298（F1-02 P1）：**记下「恢复尾部属于哪一轮」** —— 去重守卫的身份约束。
 *
 * 缺陷：守卫此前只按**内容前缀**判别（`tail.startsWith(guardBuf)`），不看轮次身份，于是
 * 「新一轮的首段文本恰好与已恢复尾部开头相同」也被当成重放整段吞掉。实测：恢复尾部是
 * `"OK"`、新一轮全文也是 `"OK"` 时，新一轮的输出在界面上**完全不可见**（探针 H；
 * 对照组把新文本改成 `"OK then more"` 即正常显示）。
 *
 * 守卫要挡的只有**同一轮的重连重放**：服务端重连后从该助手消息开头重放，而那条消息
 * 属于**恢复时已经在跑的那一轮**。新一轮（turn 变了）永远不是重放。
 *
 * 取值：`null` = 恢复时该会话没有在跑的轮次（此后任何 live 增量都不是重放，守卫全程
 * 关闭）；数字 = 恢复尾部所属的轮次号，只有该轮的增量才进守卫。
 */
export function noteRestoreTurn(ctx: SessionPane, turn: number | null): void {
  ctx.dedup.guardTurn = turn;
}

/**
 * 处理一条 live 助手文本增量：若与已恢复尾部前缀匹配则吞掉（返回 null），
 * 发散后一次性吐出累积缓冲并解除守卫。
 */
export function feedAssistantDelta(ctx: SessionPane, delta: string, turn?: number | null): string | null {
  const d = ctx.dedup;
  // ★ W9298（F1-02）：身份闸门 —— 不是「恢复时在跑的那一轮」就不是重放，直接放行。
  //
  //   三种 guardTurn 语义，缺一不可：
  //   · **数字**：恢复时该会话在跑，锚定的是那一轮的轮次号 ⇒ 只有**同一轮**的增量才进守卫。
  //   · **null**：恢复时**没有**在跑的轮次（noteRestoreTurn 显式写入）⇒ 守卫全程关闭，
  //     任何 live 增量都不是重放。
  //   · **undefined**：从未被锚定（调用方没走过 noteRestoreTurn，例如直接构造容器的测试）
  //     ⇒ 身份**不可判定**，退回旧的内容前缀判别。把它与 null 混为一谈会让「显式关闭守卫」
  //     和「没锚过」变得不可区分，也让旧调用方的去重语义无声失效。
  const anchored = typeof d.guardTurn === 'number';
  if (anchored && typeof turn === 'number' && turn !== d.guardTurn) {
    // 轮次已变 ⇒ 铁定不是重放。
    d.tail = null;
    d.guardActive = false;
    d.guardAll = false;
    d.guardBuf = '';
    return delta === '' ? null : delta;
  }
  if (d.guardTurn === null) {
    // 显式「恢复时无在途轮次」⇒ 守卫关闭。
    d.tail = null;
    return delta === '' ? null : delta;
  }
  if (d.tail?.role !== 'assistant') {
    d.tail = null;
    return delta === '' ? null : delta;
  }
  if (!d.guardActive) {
    d.guardActive = true;
    d.guardBuf = '';
    d.guardAll = false;
  }
  const tc = d.tail.content ?? '';
  d.guardBuf += delta;
  // ★ W9229（F-19）实测判定：审计的「guardBuf 无上限」这一半**不成立**，我按代码本身
  //   复核后否决它 —— 缓冲恒有 `guardBuf.length ≤ guardBufLimit(尾部) + 单帧 delta`：
  //   `tc.startsWith(guardBuf)` 对「比 tc 更长」的缓冲必然为假 ⇒ 同一调用里立刻发散、
  //   立刻吐出，缓冲不可能跨帧无界累积。（上限由 [guardBufLimit] 表达，测试按它断言。）
  //   真正成立的是另一半：**整条被吞后锚点被清**（见 finalAssistantDedup）。
  if (tc.startsWith(d.guardBuf)) {
    if (d.guardBuf === tc) d.guardAll = true;
    return null;
  }
  const out = d.guardBuf;
  d.guardActive = false;
  d.guardAll = false;
  // W9229（F-19）：判定发散即**释放**缓冲。改动前它原样留着（只靠下一次进入守卫时清零），
  // 在「守卫被反复进出」的路径上会保留一份 196K 量级的字符串引用。
  d.guardBuf = '';
  d.tail = null;
  return out === '' ? null : out;
}

/**
 * done 事件钩子：若整条 live 助手消息是已恢复尾部的重放（无新增内容），
 * 返回 true 让调用方移除该重复气泡。
 */
export function finalAssistantDedup(ctx: SessionPane, text?: string): boolean {
  const d = ctx.dedup;
  if (!d.guardActive) return false;
  d.guardActive = false;
  const replay = typeof text === 'string' && text !== '' && d.tail?.role === 'assistant' && text === (d.tail.content ?? '');
  const drop = d.guardAll || replay;
  d.guardAll = false;
  // ★ W9229（F-19）：**整条被吞**时保留 tail 这个去重锚点。改动前这里无条件
  //   `d.tail = null`，于是同一次连接里**第二次**重连补发（服务端重放同一段）不再有
  //   锚点可比 ⇒ 直接产生重复气泡。锚点本身没错（被吞掉的正是已恢复的那条），
  //   只有「内容发散」才该丢弃它 —— 那条路径已经在 feedAssistantDelta 里清了。
  if (!drop) d.tail = null;
  return drop;
}
