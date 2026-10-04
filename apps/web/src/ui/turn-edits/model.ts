// ============================================================================
// ui/turn-edits/model.ts — 「本轮编辑」的**纯模型**（W9334）
// ----------------------------------------------------------------------------
// 本模块零 DOM / 零网络 / 零 i18n 运行时：只做「工具调用 → 行」「行 → 聚合 /
// 折叠窗口」的判定。于是阈值、双向折叠、聚合口径、空态、平台门控这些**后果**
// 都能用真值表钉死（铁律 11：断言只许守后果，不许守机制），而不必去钉某个 `56px`
// 或 `position: fixed`。
//
// 行为规格：apps/web/prototype/turn-edits.html（联调定稿的 11 条）。
//
// ★ 数字的诚实边界（本组件最容易被「为了让数字好看而假装」的地方）：
//   来源是**本轮的工具调用**（方案 A）。`write_file` 的参数是「整份新内容」，
//   它**给不出**旧内容 ⇒ 给不出 diffstat：
//     · 文件原来存不存在：不知道 ⇒ 因此**不**敢把一行写成 `M`（修改）或 `A`（新增）；
//     · 新增/删除行数：不知道 ⇒ `add` / `del` 一律 `null`（= 本来源不知道），
//       渲染层对 `null` 的处理是**整块不出现**（宁可不说，也不说一个偏小的数）——
//       与插件页「没有可调项就不伪造控件」同一条纪律。
//   行的 `+X −Y` 与标题右侧的聚合**有完整实现**（合成行下可断言），只是在当前来源
//   下确实拿不到数字时才沉默。唯一的例外是可证明的一类：同一轮内**第二次**写同一个
//   路径 ⇒ 该文件一定已存在（前一次写的）⇒ 那一行是**可证明的覆盖**，记 `edit`(M)。
//
// ★ 覆盖边界（方案 A 已拍板）：本模型只看得见 `write_file`（模型直接可用的**唯一**
//   写文件工具）。`run_shell` / `run_code` **也可能**改了文件，它看不见 —— 所以：
//     · 标题只说「本轮改动 N 个文件」，**不**声称是全集；
//     · 一旦本轮有 shell/code 调用，就附一行「另有 N 个调用可能改动了文件」。
//   反过来：`hidden === 0` 时这份清单在**当前工具面**下就是完整的（没有别的直接
//   写文件工具），这一点由 [editsOf] 的返回值如实表达，不需要额外声明。
// ============================================================================
import type { Key } from '../../i18n';

/** 显示组件 id（服务端启用表 / descriptor 登记项 / 增强遍身份，三处同一个值）。 */
export const TURN_EDITS_ID = 'display.turnEdits';

/** 折叠阈值：**插件配置项**的键与默认值 —— 阈值不是常量（W9108 的 config）。 */
export const TURN_EDITS_THRESHOLD_KEY = 'threshold';
export const TURN_EDITS_DEFAULT_THRESHOLD = 5;

/**
 * 行的种类。
 *   · `write`  —— 写入了该文件，但**新增还是覆盖不可知**（来源只给整份内容）；
 *   · `edit`   —— **可证明**的覆盖（同一轮内该路径已被写过一次）；
 *   · `add` / `delete` —— 需要来源能分辨「原来有没有这份文件」；当前来源给不出，
 *                 但渲染层必须支持（聚合口径里删除的文件也算进去）。
 */
export type TurnEditKind = 'write' | 'edit' | 'add' | 'delete';

/** 一行 = 一个**文件**（同一路径被写多次仍是一行，不按调用次数重复计）。 */
export interface TurnEditRow {
  kind: TurnEditKind;
  path: string;
  /** 新增行数；`null` = 本来源不知道（**不猜**，见文件头）。 */
  add: number | null;
  /** 删除行数；`null` = 本来源不知道。 */
  del: number | null;
}

/** 行的字母标记（定稿的字形集：M/A/D；`write` 补一个诚实的 W，见文件头）。 */
export const KIND_LETTER: Record<TurnEditKind, string> = {
  write: 'W',
  edit: 'M',
  add: 'A',
  delete: 'D',
};

/** 行的字母 → 无障碍名（读屏念「W」没有意义，念「写入」才有）。 */
export const KIND_ARIA_KEY: Record<TurnEditKind, Key> = {
  write: 'chat.turnEdits.kindAria.write',
  edit: 'chat.turnEdits.kindAria.edit',
  add: 'chat.turnEdits.kindAria.add',
  delete: 'chat.turnEdits.kindAria.delete',
};

/** 副标题里的构成词（只有非零项才出现）。 */
export const KIND_LABEL_KEY: Record<TurnEditKind, Key> = {
  write: 'chat.turnEdits.kind.write',
  edit: 'chat.turnEdits.kind.edit',
  add: 'chat.turnEdits.kind.add',
  delete: 'chat.turnEdits.kind.delete',
};

/** 构成的展示顺序（定稿：编辑 · 新增 · 删除；`write` 排在最前，它是「写入」这一大类）。 */
export const KIND_ORDER: readonly TurnEditKind[] = ['write', 'edit', 'add', 'delete'];

/** 本模型看得见的**唯一**写文件工具。 */
export const TURN_EDIT_TOOL = 'write_file';

/** 可能改了文件、但本模型看不见的工具（方案 A 的已知边界）。 */
export const BLIND_TOOLS: ReadonlySet<string> = new Set(['run_shell', 'run_code']);

/** 一次工具调用的事实（调用帧给 name/args，结果帧给 ok）。 */
export interface TurnCallFact {
  name: string;
  /** `write_file` 的目标路径（取不到 = null：没有路径就无从统计）。 */
  path: string | null;
  /** 结果：`true` 成功 / `false` 失败 / `null` 结果还没到（不算已改动）。 */
  ok: boolean | null;
}

/** 取 `write_file` 类调用的目标路径（非字符串/空白一律 null —— 不猜）。 */
export function pathArgOf(name: string, args: unknown): string | null {
  if (name !== TURN_EDIT_TOOL) return null;
  if (args === null || typeof args !== 'object') return null;
  const p = (args as { path?: unknown }).path;
  return typeof p === 'string' && p.trim() !== '' ? p : null;
}

/** 工具调用 → 行（纯函数；同一路径只出一行，且**只有成功的结果**才算改动了文件）。 */
export function editsOf(calls: readonly TurnCallFact[]): { rows: TurnEditRow[]; hidden: number } {
  const rows: TurnEditRow[] = [];
  const seen = new Map<string, TurnEditRow>();
  let hidden = 0;
  for (const c of calls) {
    if (BLIND_TOOLS.has(c.name)) hidden += 1; // 可能改了文件：照实计数（不看成败）
    if (c.ok !== true || c.path === null) continue;
    const prev = seen.get(c.path);
    if (prev === undefined) {
      const row: TurnEditRow = { kind: 'write', path: c.path, add: null, del: null };
      seen.set(c.path, row);
      rows.push(row);
      continue;
    }
    // 同一轮内第二次落笔 ⇒ 第一次已把文件写出来 ⇒ 这次是**可证明的覆盖**（M 成立）。
    prev.kind = 'edit';
  }
  return { rows, hidden };
}

/** 聚合（**按全量行**算 —— 不随折叠变化，否则折叠一次数字就变，无法解释）。 */
export interface TurnEditTotals {
  files: number;
  counts: Record<TurnEditKind, number>;
  /** 行数合计；`null` = 有行给不出数字 ⇒ 整块聚合不出现（不显示一个偏小的数）。 */
  add: number | null;
  del: number | null;
}

export function totalsOf(rows: readonly TurnEditRow[]): TurnEditTotals {
  const counts: Record<TurnEditKind, number> = { write: 0, edit: 0, add: 0, delete: 0 };
  let add = 0;
  let del = 0;
  let known = rows.length > 0;
  for (const r of rows) {
    counts[r.kind] += 1;
    if (r.add === null || r.del === null) known = false;
    else {
      add += r.add;
      del += r.del;
    }
  }
  return { files: rows.length, counts, add: known ? add : null, del: known ? del : null };
}

/** 副标题的构成项（非零才列；顺序见 [KIND_ORDER]）。 */
export function breakdownOf(totals: TurnEditTotals): { kind: TurnEditKind; n: number }[] {
  return KIND_ORDER.filter((k) => totals.counts[k] > 0).map((k) => ({ kind: k, n: totals.counts[k] }));
}

/**
 * 二次展开/折叠的窗口（纯函数）。
 * 阈值 `<= 0` = 不限（全部展开）；`expanded` = 用户已经点开「还有 N 个文件…」。
 * 双向：点开 ⇒ hidden 归零 + 出现「收起」；收起 ⇒ 回到阈值内的那一小段。
 */
export interface FoldWindow {
  /** 阈值内实际显示的行数。 */
  shown: number;
  /** 「还有 N 个文件…」的 N（0 = 不出现）。 */
  hidden: number;
  /** 是否出现「收起 ▴」（= 现在显示的是全部、且本来被阈值挡过）。 */
  canCollapse: boolean;
}

export function foldWindow(total: number, threshold: number, expanded: boolean): FoldWindow {
  const limited = threshold > 0 && total > threshold;
  if (!limited) return { shown: total, hidden: 0, canCollapse: false };
  if (expanded) return { shown: total, hidden: 0, canCollapse: true };
  return { shown: threshold, hidden: total - threshold, canCollapse: false };
}

/** 窗口内的行（渲染用）。 */
export function visibleRows(rows: readonly TurnEditRow[], w: FoldWindow): TurnEditRow[] {
  return rows.slice(0, w.shown);
}

/**
 * 路径拆成「目录 + 文件名」：目录淡显、文件名保持不透明。
 *
 * ★ 长路径**从头部截断**（保住文件名）—— 由 CSS 的 `direction: rtl` + `<bdi>` 实现
 *   （见 styles/turn-edits.css）。拆分的意义是让目录与文件名**各自成节点**，
 *   这样淡显的只是目录、被省略号吃掉的也只会是目录那一段。
 */
export function splitPath(path: string): { dir: string; file: string } {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i < 0 ? { dir: '', file: path } : { dir: path.slice(0, i + 1), file: path.slice(i + 1) };
}

/** 宿主平台（由宿主能力声明给出；前端**不**去嗅探 navigator 的平台字段，见 win32 审计门禁）。 */
export type HostPlatform = 'windows' | 'macos' | 'linux' | 'other';

/** 宿主能力：能在系统文件管理器里定位一个文件。 */
export interface RevealCapability {
  platform: HostPlatform;
  reveal(path: string): void;
}

/**
 * 只有 **win/macOS** 有「在文件管理器中显示」—— Linux 上这一项**不出现**（不是禁用）。
 * 纯函数：平台是唯一入参，所以门控的真值表可以逐档断言（变异负控制打的就是它）。
 */
export function revealSupported(platform: HostPlatform): boolean {
  return platform === 'windows' || platform === 'macos';
}

/** 插件配置推过来的折叠阈值（模块镜像，与 code-extras 的 foldLines 同一做法）。 */
let threshold = TURN_EDITS_DEFAULT_THRESHOLD;

/** 写入生效阈值（`<0` / 非有限值回落默认值 —— 坏配置不许让卡片消失）。 */
export function setTurnEditsThreshold(n: number): void {
  threshold = Number.isFinite(n) && n >= 0 ? Math.floor(n) : TURN_EDITS_DEFAULT_THRESHOLD;
}

export function turnEditsThreshold(): number {
  return threshold;
}

/** 宿主能力镜像（没有宿主声明 = 没有这个动作 ⇒ 菜单里不出现，绝不假装能开）。 */
let capability: RevealCapability | null = null;

export function setRevealCapability(cap: RevealCapability | null): void {
  capability = cap;
}

/** 此刻菜单里该不该有「在文件管理器中显示」（平台支持 **且** 宿主真的提供了动作）。 */
export function canReveal(): boolean {
  return capability !== null && revealSupported(capability.platform);
}

/** 执行定位（返回 false = 没有可用能力，调用方据此如实提示，不假装成功）。 */
export function revealPath(path: string): boolean {
  if (!canReveal()) return false;
  capability?.reveal(path);
  return true;
}

/**
 * 这张卡该不该出现：**本轮有过工具调用**才出现。
 *
 * 纯聊天轮（没有任何工具调用）没有「改动」这个问题可言，挂一张空卡是噪声；
 * 有工具调用但没写文件 ⇒ **保留卡片**显示空态（定稿第 7 条：空态保留卡片、
 * 去掉折叠按钮与聚合）。
 */
export function shouldShowCard(callCount: number): boolean {
  return callCount > 0;
}
