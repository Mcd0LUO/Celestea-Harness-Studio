// ============================================================================
// ui/grants/panel/active.ts — 生效集的只读视图（W760 从 ../panel.ts 拆出）。
//
//   纯读取：把服务端的 grants / effective 折算成「哪些能力正在生效、范围是什么」。
//   shield / body / rows / quick 四个渲染模块都要问同一个问题，所以单独成一层 ——
//   否则它们得互相 import 才能共用，必然成环（W748 拆分时用 state.ts 消环的同一条理由）。
//   W760 只搬家：判定语义、过期口径、返回结构逐字与拆分前一致。
// ============================================================================
import type { EffectiveGrants, GrantCap, GrantEntry } from '../../../types';
import { isExpired } from '../caps';
import { getData, optimisticView } from '../state';

/**
 * 生效中的放宽项（已过期的不计；§3.2）。
 *
 * W795：把**乐观层**并进来 —— 用户刚点的授予/撤销在请求落定前就画成终态，
 * 因此面板（徽标/明细/结果预览）与盾牌在同一帧内就是用户期望的样子。
 * 服务端快照本身不动（state.data）；新鲜快照一到，ui/grants.ts 就清掉乐观层。
 */
export function activeGrants(): GrantEntry[] {
  const optimistic = optimisticView();
  if (optimistic.revokeAll) return []; // 全部撤销在飞：先按「一项都不剩」画
  const base = (getData()?.grants ?? []).filter(
    (g) => typeof g.cap === 'string' && !isExpired(g) && !optimistic.revoked.has(g.cap as GrantCap),
  );
  // 乐观项排在最后：activeFor 取「最后一条」，于是刚点的那一项就是生效的那一项。
  for (const g of optimistic.granted) {
    if (typeof g.cap === 'string' && !optimistic.revoked.has(g.cap as GrantCap)) base.push(g);
  }
  return base;
}

export function activeFor(cap: GrantCap): GrantEntry | null {
  const list = activeGrants().filter((g) => g.cap === cap);
  return list.length ? list[list.length - 1]! : null;
}

export function expiredFor(cap: GrantCap): GrantEntry[] {
  return (getData()?.grants ?? []).filter((g) => g.cap === cap && isExpired(g));
}


/**
 * 生效快照（GET /grants 的 `effective`）。**null = 这次没拿到**（老服务 / 读失败）。
 *
 * PX1-2：面板此前**从不**读它，于是四个位置各自写死「只能读写工作区，不能访问网络」
 * —— 而默认档位（full-access）在真机上就是 `network:true, read_roots:["/"],
 * write_roots:["/"]`。用户据此放心让 agent 跑命令，实际是整机可写：这是**安全
 * 透明度缺陷**，不是文案瑕疵。所有对外描述必须由这里驱动。
 */
export function effectiveOf(): EffectiveGrants | null {
  const e = getData()?.effective;
  return e !== undefined && e !== null ? e : null;
}

/**
 * 基线是否已经「整机可读写 + 可联网」—— 也就是旧文案反着说的那两种状态。
 *
 * 判据取自服务端的 effective，**不猜**：network 为真、或读写根命中 `/`（整机）。
 * `null`（没拿到 effective）时返回 false：此时**不得**断言「整机可读写」，
 * 但也别再说死「仅工作区」—— 调用方据此改用 unknown 文案。
 */
export function baselineIsFullAccess(): boolean {
  const e = effectiveOf();
  if (e === null) return false;
  if (e.network === true) return true;
  const whole = (roots: string[] | undefined): boolean =>
    Array.isArray(roots) && roots.includes('/');
  return whole(e.read_roots) || whole(e.write_roots);
}
/** 即将失效阈值（秒）：盾牌上的小圆点（设计 §3.1）。 */
export const EXPIRING_SEC = 120;
