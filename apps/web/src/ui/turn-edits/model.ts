// ============================================================================
// ui/turn-edits/model.ts — 「本轮编辑」的**纯模型**（W9334）
// ----------------------------------------------------------------------------
// 本模块零 DOM / 零网络 / 零 i18n 运行时：只做「工具调用 → 行」「行 → 聚合 /
// 折叠窗口」的判定。于是阈值、双向折叠、聚合口径、可知性分级、空态、平台门控这些
// **后果**都能用真值表钉死（铁律 11：断言只许守后果，不许守机制）。
//
// 行为规格：apps/web/prototype/turn-edits.html（联调定稿的 11 条）。
//
// ★ 数字的诚实口径（W9334 返工，主会话裁定）：
//   前一轮把 `write_file` 的行数一律记成「不知道」⇒ 卡片上**一个数字都没有**。
//   那不是诚实，是**把知道的也说成不知道**（信息量归零）。现在按**可知多少**分三档：
//
//     ① **精确区间**（args 里有 `old_string` / `new_string`）⇒ `+add −del` 都给，
//        数值是**这次替换的区间**，不是整文件 diff（口径写在页脚的可见附注里）；
//     ② **只知新内容**（`write_file` 的 `content`）⇒ 「写入 N 行」：新内容的行数**是可知的**，
//        而**旧内容不可知** ⇒ 不给 `−`（定稿的 `A` 行本来就是「只有 +、没有 −」）；
//     ③ 三样都不知道（形状不认识 / 内容不是字符串）⇒ 留空，并且在页脚**如实说留空的是什么**。
//
//   行字母回到定稿的 `M` / `A` / `D`（颜色本身就是语义：M 中性、A 绿、D 红）。
//   `write_file` 是「创建或覆盖」，**分不出** A / M ⇒ 记中性的 `M`，口径写在行标记的
//   title / aria-label 上（不再自造第四种字母 —— 那是静默改掉联调定稿，已改正）。
//
// ★ 覆盖边界（方案 A 已拍板）：本模型只看得见**直接写文件**的工具调用。
//   `run_shell` / `run_code` **也可能**改了文件，它看不见 —— 所以：
//     · 标题只说「本轮改动 N 个文件」，**不**声称是全集；
//     · 一旦本轮有 shell/code 调用，就附一行「另有 N 个调用可能改动了文件」。
//   反过来：`hidden === 0` 时这份清单在**当前工具面**下就是完整的，不需要额外声明。
// ============================================================================
import type { Key } from '../../i18n';

/** 显示组件 id（服务端启用表 / descriptor 登记项 / 增强遍身份，三处同一个值）。 */
export const TURN_EDITS_ID = 'display.turnEdits';

/** 折叠阈值：**插件配置项**的键与默认值 —— 阈值不是常量（W9108 的 config）。 */
export const TURN_EDITS_THRESHOLD_KEY = 'threshold';
export const TURN_EDITS_DEFAULT_THRESHOLD = 5;

/** 行的种类（定稿的三种；字母见 [KIND_LETTER]）。 */
export type TurnEditKind = 'edit' | 'add' | 'delete';

/**
 * 一行 = 一个**文件**（同一路径被写多次仍是一行，不按调用次数重复计）。
 *
 * 三个数字字段**互斥**地表达「这一次调用能证明什么」（见文件头的三档）：
 *   · `add` / `del` 都有值 ⇒ ①精确区间；
 *   · `written` 有值       ⇒ ②只知新内容行数（`write_file` 型）；
 *   · 三者都 `null`        ⇒ ③确实一无所知（页脚会如实说）。
 */
export interface TurnEditRow {
  kind: TurnEditKind;
  path: string;
  /** 替换区间的新增行数；`null` = 算不出。 */
  add: number | null;
  /** 替换区间的删除行数；`null` = 算不出（**旧内容不可知**时不硬凑一个 0）。 */
  del: number | null;
  /** 只知道「新内容有多少行」时的行数；`null` = 不知道。 */
  written: number | null;
}

/** 行的字母标记（定稿的字形集：M 中性 / A 绿 / D 红 —— 颜色就是语义）。 */
export const KIND_LETTER: Record<TurnEditKind, string> = {
  edit: 'M',
  add: 'A',
  delete: 'D',
};

/** 行的字母 → 无障碍名（读屏念「M」没有意义，念一句话才有）。 */
export const KIND_ARIA_KEY: Record<TurnEditKind, Key> = {
  edit: 'chat.turnEdits.kindAria.edit',
  add: 'chat.turnEdits.kindAria.add',
  delete: 'chat.turnEdits.kindAria.delete',
};

/** 副标题里的构成词（只有非零项才出现）。 */
export const KIND_LABEL_KEY: Record<TurnEditKind, Key> = {
  edit: 'chat.turnEdits.kind.edit',
  add: 'chat.turnEdits.kind.add',
  delete: 'chat.turnEdits.kind.delete',
};

/** 构成的展示顺序（定稿：编辑 · 新增 · 删除）。 */
export const KIND_ORDER: readonly TurnEditKind[] = ['edit', 'add', 'delete'];

/** 本模型看得见的**唯一**直接写文件工具（创建或覆盖）。 */
export const TURN_EDIT_TOOL = 'write_file';

/** 只会**创建**的工具名（给出 `A`）。当前工具面里没有；认得出就用 —— 不猜。 */
export const CREATE_TOOLS: ReadonlySet<string> = new Set(['create_file', 'new_file']);

/** 只会**删除**的工具名（给出 `D`）。同上。 */
export const DELETE_TOOLS: ReadonlySet<string> = new Set(['delete_file', 'remove_file']);

/** 可能改了文件、但本模型看不见的工具（方案 A 的已知边界）。 */
export const BLIND_TOOLS: ReadonlySet<string> = new Set(['run_shell', 'run_code']);

/** 正文字符串 → 行数（末行没有换行也算一行；空串 = 0 行）。 */
export function linesOf(text: string): number {
  if (text === '') return 0;
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body === '' ? 1 : body.split('\n').length;
}

/** 一次工具调用的事实（调用帧给 name/args，结果帧给 ok）。 */
export interface TurnCallFact {
  name: string;
  args: unknown;
  /** 结果：`true` 成功 / `false` 失败 / `null` 结果还没到（不算已改动）。 */
  ok: boolean | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** 调用的目标路径（非字符串/空白一律 null —— 不猜）。 */
export function pathArgOf(name: string, args: unknown): string | null {
  if (args === null || typeof args !== 'object') return null;
  if (name !== TURN_EDIT_TOOL && !CREATE_TOOLS.has(name) && !DELETE_TOOLS.has(name)) return null;
  const p = (args as { path?: unknown }).path;
  return typeof p === 'string' && p.trim() !== '' ? p : null;
}

/** 一次调用能证明的「数字」：精确区间 / 只知新内容 / 不知道。 */
export interface ProvenNumbers {
  add: number | null;
  del: number | null;
  written: number | null;
}

const NOTHING: ProvenNumbers = { add: null, del: null, written: null };

/** 把若干次替换（`old_string` → `new_string`）折成区间合计；一次都没给出 ⇒ null。 */
function replaceNumbers(pairs: readonly { old: string; next: string }[]): ProvenNumbers {
  if (pairs.length === 0) return NOTHING;
  let add = 0;
  let del = 0;
  for (const p of pairs) {
    add += linesOf(p.next);
    del += linesOf(p.old);
  }
  return { add, del, written: null };
}

/** 从 `edits: [{old_string,new_string}, …]` 里取出全部替换对（形状不认识 ⇒ 空）。 */
function editPairs(list: unknown): { old: string; next: string }[] {
  if (!Array.isArray(list)) return [];
  const out: { old: string; next: string }[] = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const old = str((item as { old_string?: unknown }).old_string);
    const next = str((item as { new_string?: unknown }).new_string);
    if (old !== null && next !== null) out.push({ old, next });
  }
  return out;
}

/**
 * 一次调用能算出什么（**只认能证明的形状**，不认识的一律「不知道」）。
 *
 * 认得的形状（三种，都有真实来源）：
 *   · `path` + `content`                          ⇒ 写入 N 行（`write_file` / `create_file`）
 *   · `path` + `old_string` + `new_string`        ⇒ 精确区间（替换型工具）
 *   · `path` + `edits:[{old_string,new_string}]`  ⇒ 多段替换的区间合计
 * 注意：替换型工具的 `new_string` 只是**这次替换的新片段**，不是整文件 ⇒ 数值口径
 * 是「本次替换的区间」（页脚会写明），绝不冒充整文件 diff。
 */
export function numbersOf(name: string, args: unknown): ProvenNumbers {
  if (args === null || typeof args !== 'object') return NOTHING;
  if (DELETE_TOOLS.has(name)) return NOTHING; // 删了什么内容，调用参数里没有 ⇒ 不知道
  const rec = args as Record<string, unknown>;
  const multi = editPairs(rec['edits']);
  if (multi.length > 0) return replaceNumbers(multi);
  const old = str(rec['old_string']);
  const next = str(rec['new_string']);
  if (old !== null && next !== null) return replaceNumbers([{ old, next }]);
  const content = str(rec['content']);
  if (content !== null) return { add: null, del: null, written: linesOf(content) };
  return NOTHING;
}

/**
 * 工具调用 → 行（纯函数；同一路径只出一行，且**只有成功的结果**才算改动了文件）。
 *
 * 字母口径（定稿的三档）：
 *   · `delete` 型工具 ⇒ `D`；`create` 型工具 ⇒ `A`；
 *   · 同一轮内**第二次**写同一路径 ⇒ `edit`（第一次已把文件写出来 ⇒ 可证明是覆盖）；
 *   · 其余（`write_file` 的创建或覆盖）⇒ `edit`（中性档 M；分不出 A/M，就不假装分得出）。
 */
export function editsOf(calls: readonly TurnCallFact[]): { rows: TurnEditRow[]; hidden: number } {
  const rows: TurnEditRow[] = [];
  const seen = new Map<string, TurnEditRow>();
  let hidden = 0;
  for (const c of calls) {
    if (BLIND_TOOLS.has(c.name)) hidden += 1; // 可能改了文件：照实计数（不看成败）
    if (c.ok !== true) continue;
    const path = pathArgOf(c.name, c.args);
    if (path === null) continue;
    const n = numbersOf(c.name, c.args);
    const prev = seen.get(path);
    if (prev === undefined) {
      const kind: TurnEditKind = DELETE_TOOLS.has(c.name) ? 'delete' : CREATE_TOOLS.has(c.name) ? 'add' : 'edit';
      const row: TurnEditRow = { kind, path, ...n };
      seen.set(path, row);
      rows.push(row);
      continue;
    }
    // 同一轮内第二次落笔 ⇒ 第一次已把文件写出来 ⇒ 这次是**可证明的覆盖**（M 成立）。
    prev.kind = DELETE_TOOLS.has(c.name) ? 'delete' : 'edit';
    if (n.add !== null && n.del !== null) {
      prev.add = (prev.add ?? 0) + n.add;
      prev.del = (prev.del ?? 0) + n.del;
      prev.written = null;
    } else if (n.written !== null) {
      prev.written = (prev.written ?? 0) + n.written;
      prev.add = null;
      prev.del = null;
    }
  }
  return { rows, hidden };
}

/** 聚合（**按全量行**算 —— 不随折叠变化，否则折叠一次数字就变，无法解释）。 */
export interface TurnEditTotals {
  files: number;
  counts: Record<TurnEditKind, number>;
  /** 精确区间合计：只对**能算出**的那些行求和（一行都算不出 ⇒ null）。 */
  add: number | null;
  del: number | null;
  /** 参与上面那个合计的行数（页脚要用它写口径）。 */
  exactRows: number;
  /** 「写入 N 行」合计（只知新内容的那些行）；一行都没有 ⇒ null。 */
  written: number | null;
  writtenRows: number;
  /** 三样都不知道的行数（页脚要如实说「另有 N 行给不出行数」）。 */
  unknownRows: number;
}

export function totalsOf(rows: readonly TurnEditRow[]): TurnEditTotals {
  const counts: Record<TurnEditKind, number> = { edit: 0, add: 0, delete: 0 };
  let add = 0;
  let del = 0;
  let exactRows = 0;
  let written = 0;
  let writtenRows = 0;
  let unknownRows = 0;
  for (const r of rows) {
    counts[r.kind] += 1;
    if (r.add !== null && r.del !== null) {
      add += r.add;
      del += r.del;
      exactRows += 1;
      continue;
    }
    if (r.written !== null) {
      written += r.written;
      writtenRows += 1;
      continue;
    }
    unknownRows += 1;
  }
  return {
    files: rows.length,
    counts,
    add: exactRows > 0 ? add : null,
    del: exactRows > 0 ? del : null,
    exactRows,
    written: writtenRows > 0 ? written : null,
    writtenRows,
    unknownRows,
  };
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
