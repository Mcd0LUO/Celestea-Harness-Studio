/**
 * `parseSlashGesture` —— 输入行首的 `/` 手势的**唯一**识别与规范化实现
 * （见 `docs/feature/composer-surface.md` §7、`docs/feature/mcp-client.md` §5.6）。
 *
 * 形状与纪律：
 *
 * - **只认行首**。句中的 `/` 会误吃路径与分数（`3/4`、`a/b`）；`@` 才是任意位置。
 * - **它不知道清单**。「这个名字是不是真技能 / 真 server」由调用方拿自己的清单判断——
 *   本函数只做语法解析，因此零依赖、零 IO、可单测。
 * - **规范形态由它产出**。补全框选中时调用方用 `canonical` 改写草稿；chip 的文本投影
 *   也必须是这个 `canonical`（§8：「两端同源」从「共用一个函数」升级为「投影就是它认的形状」）。
 * - **裸 token 的 kind 是语法默认值**：`/review` 与 `/help` 在语法上不可区分（两者的
 *   名字字符集重叠），所以裸 token 一律判为 `command`。调用方若拿着技能清单认出
 *   `review` 是技能，用 `canonicalSlash("skill", name)` 取得规范形态即可——**裁决留在
 *   调用方**，这正是「函数不知道清单」的直接推论。同理，**裸 `/name` 永不代表 MCP**
 *   （D9 字符串契约）：MCP 只有 `/mcp:<server>` 一种形态。
 */

import {
  COMMAND_NAME_PATTERN,
  MCP_SERVER_NAME_PATTERN,
  MCP_TOOL_NAME_PATTERN,
  SKILL_NAME_PATTERN,
  SLASH_PREFIXES,
} from "./name-patterns.js";

/** 手势的三种 kind（`/` 面里的三种东西，不是三种触发源）。 */
export type SlashGestureKind = "command" | "skill" | "mcp";

export interface SlashGesture {
  /** 命中的 kind。 */
  kind: SlashGestureKind;
  /** 命中的 token 原文（含前导 `/`，不含参数）：`/skill:review`。 */
  raw: string;
  /** 规范形态：`/skill:<name>` · `/mcp:<server>[/<tool>]` · `/<name>`。 */
  canonical: string;
  /** 名字（命令名 / 技能名 / server 名），已过该 kind 的字符集。 */
  name: string;
  /**
   * 第二层（MCP 专属）：`/mcp:<server>/<tool>` 里点名的那个工具，**原样**——
   * server 自己起的那个名字，不是 `mcp__<server>__<tool>` 归一化后的。
   * 缺省字段 = 这一层没有点名（§5.6「叶子级」的形状）。
   */
  readonly tool?: string;
  /** token 之后的剩余文本（原样，仅去掉行首空白）；没有则空串。 */
  rest: string;
  /** token 在原行中的**结束**下标（chip / 高亮层的区间右端）。 */
  end: number;
}

/** 每种 kind 的名字字符集——查表，不把正则散在分支里。 */
const NAME_PATTERN_BY_KIND: Record<SlashGestureKind, RegExp> = {
  command: COMMAND_NAME_PATTERN,
  skill: SKILL_NAME_PATTERN,
  mcp: MCP_SERVER_NAME_PATTERN,
};

/** 有规范前缀的两种 kind；`command` 走裸 `/<name>`。 */
const KIND_BY_PREFIX: Record<string, Exclude<SlashGestureKind, "command">> = {
  skill: "skill",
  mcp: "mcp",
};

/** `/` 之后到第一个空白之前的 token（行首已确认以 `/` 开头）。 */
function readToken(line: string): string {
  let end = 1;
  while (end < line.length && !/\s/.test(line[end]!)) end += 1;
  return line.slice(1, end);
}

/**
 * 解析一行用户输入的 `/` 手势；不是手势（非行首 `/`、只有 `/`、名字不合字符集）时返回 `null`。
 *
 * `/mcp:memory` → `{ kind: "mcp", canonical: "/mcp:memory" }`；
 * `/mcp:memory/create_entities 记住这条` → `{ kind: "mcp", name: "memory", tool: "create_entities" }`；
 * `/skill:review x` → `{ kind: "skill", name: "review", rest: "x" }`；
 * `/help` → `{ kind: "command" }`；`3/4` 与 `a/b` → `null`。
 *
 * 纯函数：不 trim、不读盘、不看清单。调用方先去掉行首空白再传进来（`end` 才是原行下标）。
 */
export function parseSlashGesture(line: string): SlashGesture | null {
  if (!line.startsWith("/")) return null;
  const token = readToken(line);
  if (token === "") return null;
  const colon = token.indexOf(":");
  if (colon < 0) return finish("command", token, line);
  const kind = KIND_BY_PREFIX[token.slice(0, colon)];
  if (kind === undefined) return null; // 未知前缀不误吃（`/foo:bar` 不是手势）
  return finish(kind, token.slice(colon + 1), line);
}

/**
 * 校验名字 + 组装结果。
 *
 * **第二层只属于 mcp**：`/mcp:<server>/<tool>`（§5.6 的叶子级）。斜杠在这里被切成
 * 「server」与「工具」两段分别校验，而不是让 server 的字符集去拒绝整串——两段各过各的
 * 表，才可能出现「server 名里有斜杠」这件事被真正挡住（server 段仍要过
 * `MCP_SERVER_NAME_PATTERN`），同时「工具名里有斜杠」也被挡住（更多一层斜杠会落进
 * `MCP_TOOL_NAME_PATTERN` 而被拒）。
 */
function finish(kind: SlashGestureKind, name: string, line: string): SlashGesture | null {
  if (kind === "mcp") {
    const slash = name.indexOf("/");
    if (slash >= 0) {
      const server = name.slice(0, slash);
      const tool = name.slice(slash + 1);
      if (!NAME_PATTERN_BY_KIND.mcp.test(server)) return null;
      if (!MCP_TOOL_NAME_PATTERN.test(tool)) return null;
      return build(kind, server, line, tool);
    }
  }
  if (!NAME_PATTERN_BY_KIND[kind].test(name)) return null;
  return build(kind, name, line, undefined);
}

/** 组装一个手势对象：`raw` 的长度同时就是 `end` 与 `rest` 的切分点。 */
function build(kind: SlashGestureKind, name: string, line: string, tool: string | undefined): SlashGesture {
  const raw = rawFor(kind, name) + (tool === undefined ? "" : "/" + tool);
  return {
    kind,
    raw,
    canonical: raw,
    name,
    ...(tool === undefined ? {} : { tool }),
    rest: restOf(line, raw.length),
    end: raw.length,
  };
}

/**
 * 命中的 token 原文：命令是 `/<name>`，带前缀的是 `/skill:<name>` / `/mcp:<server>`。
 *
 * `raw` 与 `canonical` 恒等：前缀必须精确命中 `skill` / `mcp`、名字又过了字符集，
 * 所以「用户原样写的那一截」与「规范形态」在本函数的判定下不会分叉。两个字段都留着是
 * 因为调用方要能同时回答「用户写了什么」与「补全框该写回什么」。
 */
function rawFor(kind: SlashGestureKind, name: string): string {
  return kind === "command" ? "/" + name : SLASH_PREFIXES[kind] + name;
}

/** token 之后的剩余文本：原样，仅去掉行首空白。 */
function restOf(line: string, tokenLength: number): string {
  return line.slice(tokenLength).replace(/^\s+/, "");
}

/**
 * 由 `kind` + `name` 产出规范形态。
 *
 * 存在的理由：裸 token 的 kind 由语法决定（默认 `command`），而**清单在调用方手里**。
 * 补全框选中一个技能后要改写成 `/skill:<name>`，走的就是这里——不必让解析函数
 * 认识技能清单。名字不合该 kind 的字符集时返回 `null`（宁可不改写，也不写出半截形状）。
 */
export function canonicalSlash(kind: SlashGestureKind, name: string): string | null {
  if (!NAME_PATTERN_BY_KIND[kind].test(name)) return null;
  return rawFor(kind, name);
}
