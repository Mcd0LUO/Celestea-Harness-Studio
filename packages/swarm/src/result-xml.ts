/**
 * `<agent_swarm_result>` 渲染（纯函数，零依赖）。
 *
 * 与本仓刻意规避的两个上游缺陷：
 *   D1（body 未转义 → 成员列表整体丢失）：本实现对**属性与 body 一并做 XML 转义**，
 *      因此 body 里出现 `<subagent ` 字面量时，读取端仍能无损还原成员列表。
 *   D2（swarmIndex 两套编号基 → 标签错位）：本实现只承认一种编号基——1 起始、
 *      与 specs 数组位置严格对齐；渲染前强制校验，绝不静默错位。
 *      默认不一致即抛错（严格断言）；生产装配走 degradeOnIndexMismatch ——
 *      错位只说明「哪条属于谁」不可信，不说明正文不可信，抛错会把整批已跑完的正文一起赔进去，
 *      故按实际顺序降级渲染并把错位写进 <summary>。
 *
 * **文案归属**：本文件写出的正文（错误、占位、降级说明）面向**模型**，不进 i18n 字典；
 * 面向人的同类信息走 Statusline 的 `swarm?` 字段与 zh/en 字典。
 */

import { clipText } from "./text-clip.js";
import { SWARM_MAX_SUBAGENTS, type SwarmTaskResult } from "./types.js";


export const SWARM_RESULT_TAG = "agent_swarm_result";

/**
 * 剥离 XML 1.0 非法字符。
 *
 * XML 1.0 §2.2 的 Char 集合只允许：#x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]。
 * 子代理输出里混入控制符（ANSI 转义序列的 ESC=0x1B、NUL、以及工具输出里的裸控制字节）
 * 会让整个结果块无法被任何合规 XML 解析器读取——不是某一处丢内容，而是**整份文档报废**，
 * 因此必须在写出的那一刻就剥掉。
 *
 * 保留 `\t`(0x09) / `\n`(0x0A) / `\r`(0x0D)：它们是合法 Char，且是正文换行与缩进结构的一部分。
 * 其余 <0x20 的控制符、0x7F(DEL) 以及 0x80-0x9F 一律剔除。
 *
 * 注意这是**有损**的（不可能无损还原被剥掉的字节），但它换来的是"文档仍可解析"——
 * 在本仓的用途下（把结果交给模型读）这个取舍是明确划算的。
 */
function stripInvalidXmlChars(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

/**
 * 转义 CDATA 终结符 `]]>`。
 *
 * XML 规范：文本节点里**裸的** `]]>` 不被允许（解析器会把它当作 CDATA 结束）。
 * 正确写法是把它劈成 `]]&gt;`——因为 `]]` 在文本节点里本身合法且无歧义，
 * 只需断开 `]]>` 这个三连；而 `&gt;` 会被反转义还原成 `>`，往返无损。
 *
 * 必须在 `&` → `&amp;` 之后做，否则新插入的 `&gt;` 会被二次转义成 `&amp;gt;`。
 */
function escapeCdataEnd(value: string): string {
  return value.replaceAll("]]>", "]]&gt;");
}

/**
 * 属性值转义（四个字符 + 三个字符引用，顺序敏感：`&` 必须最先、字符引用必须最后）。
 *
 * 属性区比文本节点更严：`>` 已被逐个转义成 `&gt;`，所以 `]]>` 这个三连根本不会
 * 以裸形存在——不需要再调 escapeCdataEnd（加了也是空操作，反而让人误以为必要）。
 * 控制符剥离对两者同样必需。
 *
 * 为什么 `\r`/`\n`/`\t` 必须写成字符引用（依据 XML 1.0 §3.3.3 属性值规范化）：
 * 属性值里**字面**出现的这三位，任何合规解析器都会无条件替换成空格（0x20）；
 * 而写成 `&#xD;`/`&#xA;`/`&#x9;` 时，规范化只把引用还原成真字符，不做替换。
 * 也就是说裸写不会报错、只会让 `item="a\nb"` 被读取端看成 `"a b"`——静默失真
 * 比抛错更难发现（本仓原来的四个字符转义正是这个缺口）。
 *
 * 顺序不可调换：字符引用文本自带 `&`，必须在 `&` → `&amp;` **之后**插入，
 * 否则新插入的 `&#xA;` 会被二次转义成 `&amp;#xA;`（读出来是字面量，不是换行）。
 */
export function escapeXmlAttribute(value: string): string {
  return stripInvalidXmlChars(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r", "&#xD;")
    .replaceAll("\n", "&#xA;")
    .replaceAll("\t", "&#x9;");
}

/**
 * 文本节点**最小转义**：只处理 `&`、`<` 与 `]]>`，顺序敏感（`&` 必须最先）。
 *
 * 为什么不做全转义：上游缺陷 D13 的触发器是 body 里出现字面 `<subagent `，
 * 转义 `<` 即可根治；而 `>` 与引号在文本节点里不构成任何解析歧义。
 * 全转义会把子代理输出里的 `a > b`、`"quoted"` 变成 `a &gt; b`、`&quot;quoted&quot;`，
 * 白白毁掉结果文本的可读性——而这段文本正是模型与用户阅读子代理产出的地方。
 *
 * 例外一：`]]>` 必须劈开（见 escapeCdataEnd），否则整份 XML 不可解析。
 * 例外二：非法控制符必须剥离（见 stripInvalidXmlChars），同理。
 * 这两项都**不影响**其余字符的可读性，所以"最小转义"的取舍依然成立。
 */
export function escapeXmlText(value: string): string {
  return escapeCdataEnd(stripInvalidXmlChars(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;"));
}

/**
 * 属性反转义，与 {@link escapeXmlAttribute} 互逆（**逆序**替换：字符引用最先、`&amp;` 最后）。
 *
 * 字符引用必须排在 `&amp;` 之前还原：原文里字面的 `&#xA;` 转义后是 `&amp;#xA;`，
 * 若先还原 `&amp;` 就会得到 `&#xA;`，再被字符引用规则二次还原成真换行——往返就坏了
 * （与 {@link unescapeXmlText} 里 `&gt;` 必须早于 `&amp;` 是同一类顺序陷阱）。
 *
 * 只负责还原本文件写出的那一组实体：不认识的通用数字字符引用（如 `&#65;`）
 * 原样保留，交给真正的解析器处理。
 */
export function unescapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&#xD;", "\r")
    .replaceAll("&#xA;", "\n")
    .replaceAll("&#x9;", "\t")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

/**
 * 文本反转义，与 {@link escapeXmlText} 互逆（**逆序**替换，`&amp;` 必须最后）。
 *
 * `&gt;` 这条是为 `]]&gt;` 补的还原规则：escapeXmlText 里 `>` 不被转义，
 * 因此转义结果中出现的 `&gt;` 只可能来自 escapeCdataEnd 的 `]]&gt;`，
 * 把它还原成 `>` 就等于把 `]]>` 完整还原。
 *
 * 顺序不可调换：必须先 `&gt;` 后 `&amp;`，否则原文里字面的 `&gt;`
 * （转义后成 `&amp;gt;`）会先被 `&amp;` 还原成 `&gt;`，再被 `&gt;` 规则
 * 二次还原成 `>`——往返就坏了。
 */
export function unescapeXmlText(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/**
 * summary 只列非零计数；全零时为空串。计数顺序固定 completed → failed → aborted → unknown。
 *
 * 穷尽匹配（本轮改动）：原先写的是 `if completed / else if failed / else aborted`，
 * 于是**任何**第三个值之外的东西都被静默算进 aborted——外部脏数据混入、或将来把
 * SwarmOutcome 扩成四值时，一个尚未完成的成员会被报成"已中止"。summary 是读取方
 * 唯一的汇总口径，它会说谎比它少算一项严重得多。
 *
 * 未知值为什么选择"单独计数"而不是抛错：
 *   1. 渲染是这条链路的最后一环。抛错会让整份 `<agent_swarm_result>` 消失（读不到
 *      闭合标签就整块报废），把上百个已经跑完的成员正文一起赔进去，
 *      代价与收益完全不对称。编号错位（见 assertIndexAlignment）值得抛错，
 *      是因为它会让"哪条结果属于谁"整体错位、渲染出来必然误导；
 *      而一个未知 outcome 只影响汇总行的一个计数，成员正文仍然逐条准确。
 *   2. 单独计数不再说谎（未知值不再冒充 aborted），同时"unknown: N 非零"本身就是
 *      可观测信号——模型/用户能据此去查真实原因，而不是被一个假的 aborted 数字骗过。
 *
 * 编译期兜底：default 分支把收窄后的 outcome 赋给 `never`。将来给 SwarmOutcome 加
 * 第四个值时，这里会**编译失败**，逼作者显式决定它该进哪一桶（真正的中止？还是新的一行？），
 * 而不是让它悄悄落进 unknown。运行期之外，default 只承接类型层管不到的脏数据。
 */
export function renderSwarmSummary(results: readonly SwarmTaskResult[]): string {
  let completed = 0;
  let failed = 0;
  let aborted = 0;
  let unknown = 0;
  for (const result of results) {
    switch (result.outcome) {
      case "completed":
        completed += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "aborted":
        aborted += 1;
        break;
      default: {
        // 编译期穷尽守卫：SwarmOutcome 一旦扩容，这一行立刻编译失败。
        const unhandled: never = result.outcome;
        void unhandled;
        // 运行期：类型层之外的脏数据单独计数，绝不并入 aborted（那是说谎）。
        unknown += 1;
        break;
      }
    }
  }
  const parts: string[] = [];
  if (completed > 0) parts.push(`completed: ${String(completed)}`);
  if (failed > 0) parts.push(`failed: ${String(failed)}`);
  if (aborted > 0) parts.push(`aborted: ${String(aborted)}`);
  if (unknown > 0) parts.push(`unknown: ${String(unknown)}`);
  return parts.join(", ");
}

/**
 * 单个成员正文的**默认**上限（UTF-16 码元）—— W9290 B1-07。
 *
 * 为什么渲染路径必须有界：成员正文是模型给的自由文本，而一批最多 128 个成员。
 * 没有上限时，128 个各 20 万字的成员 = 25MB 直接进模型上下文——不是报错，是**静默**
 * 把上下文挤爆，且往往在模型已经开始回答之后才发作。本包早就有 `text-clip.ts` 正是为此，
 * 也有 `validate.ts` 的 `DUPLICATE_SNIPPET_MAX_CHARS` / `roster.ts` 的成员视图上限，
 * 唯独渲染这一条出口一直在漏。
 *
 * **为什么不静默截断**：截掉多少要**写在正文里**。一个被砍掉尾巴的成员结果若看不出
 * 被砍过，模型会以为那就是全部——于是它基于一个不完整的前提继续推理。那比截断本身更糟。
 * 所以截断时追加一行 `…[truncated N of M code units]`（M 是原长度）。
 */
export const SWARM_MEMBER_BODY_MAX_CHARS = 20_000;

/**
 * 按上限裁剪成员正文，并如实标注被裁掉多少。
 *
 * 用 `clipText`（本包唯一的截断出口）而不是 `slice`：它不劈开代理对，emoji 不会被
 * 截成乱码。`0` = 不限（宿主显式关闭），负数与 NaN 由 `bodyLimitChars` 归一到默认值。
 */
export function clipMemberBody(body: string, max: number): string {
  if (!(max > 0) || body.length <= max) return body;
  const dropped = body.length - max;
  return clipText(body, max) + "\n" + `[truncated ${String(dropped)} of ${String(body.length)} code units]`;
}

/**
 * 本次渲染该用的成员正文上限：显式 > 0 则用它，否则用默认值。
 *
 * **把「无效值归一到默认」而不是「让无效值变成不限」**：后者（`!(max > 0)` 对 NaN 为真）
 * 会把一次配置笔误变成「恢复成无上限」，正是本条要消灭的失效形态。
 */
export function bodyLimitChars(override: number | undefined): number {
  return override === undefined || !Number.isFinite(override) || override <= 0
    ? SWARM_MEMBER_BODY_MAX_CHARS
    : Math.floor(override);
}

/** body 取值：completed 用 result，其余用 error，缺失时给出占位文案。 */
function bodyOf(result: SwarmTaskResult): string {
  if (result.outcome === "completed") return result.result ?? "";
  return result.error ?? "unknown error";
}

/**
 * 编号全链一致性断言：index 必须是 1 起始、连续、且与数组位置一一对应。
 * 上游 D2 的根因正是"写入端与读取端各自假设了不同的编号基"，
 * 这里用一次显式断言把该不变量钉死在渲染边界上。
 */
function findIndexAlignmentMismatch(results: readonly SwarmTaskResult[]): string | undefined {
  for (let i = 0; i < results.length; i += 1) {
    const expected = i + 1;
    const actual = (results[i] as SwarmTaskResult).spec.index;
    if (actual !== expected) {
      return `Swarm result index mismatch at position ${String(i)}: expected ${String(expected)}, got ${String(actual)}.`;
    }
  }
  return undefined;
}

/**
 * 渲染单个 `<subagent>` 元素。
 *
 * 属性顺序固定：agent_id → item → state → outcome → stop_reason。
 * agent_id 排在最前与上游标准输出一致（`<subagent agent_id="xxx" item="…" state="…" …>`）；
 * 二期若加入 resume 型成员，届时还需在最前面补 `mode` 属性（本期 kind 只有 spawn）。
 *
 * agent_id / state / stop_reason 都是可选属性：undefined 时**整体省略**，不输出空属性。
 * agent_id 是二期 resume_agent_ids 的唯一取值来源，因此它同样走属性转义这一条路径。
 */
export function renderSubagentElement(result: SwarmTaskResult, bodyMax: number = SWARM_MEMBER_BODY_MAX_CHARS): string {
  const attrs: string[] = [];
  if (result.agentId !== undefined) {
    attrs.push(`agent_id="${escapeXmlAttribute(result.agentId)}"`);
  }
  attrs.push(`item="${escapeXmlAttribute(result.spec.item)}"`);
  if (result.state !== undefined) attrs.push(`state="${escapeXmlAttribute(result.state)}"`);
  attrs.push(`outcome="${escapeXmlAttribute(result.outcome)}"`);
  if (result.stopReason !== undefined) {
    attrs.push(`stop_reason="${escapeXmlAttribute(result.stopReason)}"`);
  }
  // 上限作用在**转义之前**：转义只会让文本变长（& -> &amp;），先转义再量就量不准了。
  const body = escapeXmlText(clipMemberBody(bodyOf(result), bodyMax));
  return `<subagent ${attrs.join(" ")}>${body}</subagent>`;
}

export interface RenderSwarmResultOptions {
  /**
   * 丢弃 `state === "not_started"` 的成员（这些成员从未真正启动）。
   * 批次被中断时队列里可能还压着上百个从未启动的任务，把它们渲染出来只是噪音。
   * 注意：编号一致性断言在**过滤前**的完整数组上执行——这正是为了不因为过滤
   * 而放松"编号全链一致"这一不变量（上游 D2 的成因）。
   */
  omitNotStarted?: boolean;
  /**
   * 编号错位时**降级渲染**而不是抛错（2026-10-01 审查修复）。
   *
   * 为什么要有这个开关：编号错位是内部不变量被破坏，但它只说明"哪条结果属于谁"不可信，
   * 并**不说明**结果内容不可信。抛错的代价是整份结果块（含上百个已跑完成员的正文）一起消失，
   * 收益仅是"提前失败"——收益与代价完全不对称。降级后按 results 的**实际顺序**渲染，
   * 每条 <subagent> 仍带着自己的 spec.index 与 item（可核对），
   * 并把错位说明写进 <summary> 让模型与人都能看见（不静默吞错）。
   *
   * false / 未设 = 抛错（严格断言原行为，保持向后兼容与既有测试）。
   */
  degradeOnIndexMismatch?: boolean;
  /**
   * 单个成员正文的码元上限（W9290 B1-07）。缺省 / 无效 = `SWARM_MEMBER_BODY_MAX_CHARS`。
   *
   * 为什么是可配而不是写死：宿主最清楚自己的上下文窗口与计费口径；20_000 只是本仓的
   * 保守缺省。`bodyLimitChars` 负责把无效值**归一到默认**而不是「归一到不限」。
   */
  memberBodyMaxChars?: number;
}

/** 渲染完整结果块。results 必须按 spec.index 升序且编号连续（除非开启 degradeOnIndexMismatch）。 */
export function renderSwarmResult(
  results: readonly SwarmTaskResult[],
  options: RenderSwarmResultOptions = {},
): string {
  if (results.length > SWARM_MAX_SUBAGENTS) {
    throw new Error(
      `Cannot render ${String(results.length)} swarm members; the maximum is ${String(SWARM_MAX_SUBAGENTS)}.`,
    );
  }
  const mismatch = findIndexAlignmentMismatch(results);
  if (mismatch !== undefined && options.degradeOnIndexMismatch !== true) {
    throw new Error(mismatch);
  }
  const bodyMax = bodyLimitChars(options.memberBodyMaxChars);
  const members = options.omitNotStarted === true
    ? results.filter((result) => result.state !== "not_started")
    : [...results];
  // 错位时把说明并进 summary：summary 是读取方必读的汇总行，放这里保证"降级了"这件事
  // 一定被看到，而不是只写在某条成员正文里被淹没（不静默吞错）。
  const summary = mismatch === undefined
    ? renderSwarmSummary(members)
    : renderSwarmSummary(members) + "; render degraded: " + mismatch;
  const lines = [
    `<${SWARM_RESULT_TAG}>`,
    `<summary>${escapeXmlText(summary)}</summary>`,
    ...members.map((result) => renderSubagentElement(result, bodyMax)),
    `</${SWARM_RESULT_TAG}>`,
  ];
  return lines.join("\n");
}

/**
 * 生产渲染入口：先按降级模式渲染（编号错位不抛错），再兜住**任何**其它渲染期异常。
 *
 * 为什么要有第二层 try/catch（degradeOnIndexMismatch 只挡编号错位一类）：
 * 渲染是这条链路的最后一环，它抛错的代价是**整批**结果消失——包括上百个已经跑完、
 * 已经付费、正文完好的成员。那是本仓最贵的失败模式，且与"不静默吞错"并不冲突：
 * 兜底不是把错误吃掉，而是把错误**变成模型看得见的结果内容**——
 * 逐成员按 item / outcome / 正文降级渲染，并把渲染失败的原文写进 <summary>。
 *
 * 只有二次降级也失败（连单成员渲染都做不出来）时才把错误抛出：那时连"保住结果"
 * 都已不可能，抛错反而是更诚实的信号。
 */
export function renderSwarmResultSafely(
  results: readonly SwarmTaskResult[],
  memberBodyMaxChars?: number,
): string {
  try {
    return renderSwarmResult(results, {
      omitNotStarted: false,
      degradeOnIndexMismatch: true,
      ...(memberBodyMaxChars === undefined ? {} : { memberBodyMaxChars }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const header = [
      `<${SWARM_RESULT_TAG}>`,
      `<summary>render failed: ${escapeXmlText(message)}</summary>`,
    ].join("\n");
    const body = results
      .map((result) => {
        // 单成员同样可能抛（脏数据极端形态），故逐条兜住，坏的那条只出占位而不中断整批。
        try {
          return renderSubagentElement(result, bodyLimitChars(memberBodyMaxChars));
        } catch {
          return `<subagent item="${escapeXmlAttribute(String(result.spec?.item ?? ""))}" outcome="${escapeXmlAttribute(String(result.outcome))}">member could not be rendered</subagent>`;
        }
      })
      .join("\n");
    return [header, body, `</${SWARM_RESULT_TAG}>`].filter((line) => line !== "").join("\n");
  }
}