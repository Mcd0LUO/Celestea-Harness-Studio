#!/usr/bin/env node
/**
 * W9323 · 「注释里不许写 `<文件>.<扩展名>:<行号>` 行号引用」的门禁。
 *
 * 为什么需要它：**注释里的行号会静默腐烂**。W9321 报告实测过 —— 它自己刚改完
 * `child.ts`，`b3-run-shell-cancel.test.ts` 与 `b3-abort-kills-child.test.ts` 里那句
 * 指向 `child.ts` 里 `taskkillTree` 的行号就已经失真了（整体位移），而**没有任何门禁
 * 会报**：类型、lint、架构、测试全绿，注释就在那里悄悄说了一句假话。
 *
 * 本仓已有的正确替代（本门禁的「正例」）：`[symbol]` 符号引用。见
 * `packages/tools/src/sandbox/child.ts`：`See [taskkillTree] for why…`、
 * `Windows half of [signalTree]`。行号会漂，符号名不会。
 *
 * 判据：注释文本里出现「文件名 + 冒号 + 数字」的形状即报（形状的正则见 LINE_REF_RE，
 * 支持单行号、行号区间、行号逗号列表三种）。
 *   · **只扫注释**：字符串字面量里的行号形状（比如错误消息、URL、fixture 路径）
 *     是**数据**，不是会腐烂的指引，误报它们就是在逼人改测试数据 —— 所以必须先把
 *     字符串内容排除掉。模板串的插值部分按代码处理（它就是代码）。
 *   · 允许 `[symbol]` 形式（本门禁不检查被引用符号是否存在 —— 那是另一道题，
 *     本仓的 doc-conventions 门禁已经覆盖「锚点落在空行」这一类）。
 *
 * 豁免口径**逐字对齐** `scripts/check-sleep-debt.mjs`（W9225）：marker 写在违规行
 * **或其紧邻上一行**。W9225 实测过「marker 写在 3 行外不生效」—— 别再犯一次。
 * marker = `W9323`。
 *
 * 本文件自己会扫到自己（它就在 scripts/ 下），所以这里的注释**刻意不写**任何行号形状
 * —— 否则门禁第一版上线就是红的，而那正是它该有的行为。
 *
 * 范围：与 check-sync-in-callback.mjs 同（各 packages 的 src、apps/studio/src、
 * apps/cli/src、scripts、tests），刻意不含 apps/web（它归自己的 8 道子门禁管）。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 豁免标记：违规行本身或**紧邻上一行**出现它即豁免（口径同 check:sleep / W9225）。 */
const ALLOW_MARKER = /W9323/;

/**
 * 行号引用的形状：文件名（含路径与点）+ 冒号 + 数字；数字可以是单个、区间 `N-M`，
 * 或逗号列表 `N,M-M`。扩展名覆盖本仓真实出现的几种（ts/tsx/mjs/js/json/css/md）。
 * 前置名允许目录分隔符，所以整仓路径写法也一并命中。
 */
const LINE_REF_RE =
  /[A-Za-z0-9_./\\-]+\.(?:ts|tsx|mjs|js|json|css|md):\d+(?:[-,]\d+)*/g;

/** 扫描范围（相对 ROOT）。与 A 同口径。 */
const SCAN_ROOTS = ["packages", "apps/studio/src", "apps/cli/src", "scripts", "tests"];
const SCAN_EXT = new Set([".ts", ".tsx", ".mjs", ".js"]);
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".worktrees",
  "fixtures",
  "reports",
  "contracts",
  ".git",
]);

function collectFiles() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(join(ROOT, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(join(dir, e.name));
      } else if (SCAN_EXT.has(extname(e.name))) {
        out.push(relative(ROOT, join(dir, e.name)).split(sep).join("/"));
      }
    }
  };
  for (const r of SCAN_ROOTS) walk(r);
  return out.sort();
}

function extname(name) {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i);
}

/**
 * 逐行切出**注释片段**（排除字符串字面量内容）。
 *
 * 实现：一次字符级扫描，跟踪 `//`、`/* *\/`、单双引号、模板串。模板串里 `${…}` 内部
 * 重新回到「代码」状态（插值里可能有真注释），其余部分算字符串。
 * ★ 已知局限：正则字面量里的 `//` 会被误认成行注释（本仓有 `/^\/api\/…/` 这类路由
 *   正则）。后果是**漏报**（那段后面的注释没被看见），不是误报 —— 方向是安全的。
 */
function commentFragmentsOfLine(line, state) {
  const frags = [];
  let buf = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (state.inBlockComment) {
      if (ch === "*" && next === "/") {
        state.inBlockComment = false;
        i += 1;
        continue;
      }
      buf += ch;
      continue;
    }
    if (state.quote !== "") {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === state.quote) state.quote = "";
      else if (state.quote === "`" && ch === "$" && next === "{") {
        // 模板插值：回到代码状态（插值内可能有真注释）
        state.quote = "";
        state.templateDepth = (state.templateDepth ?? 0) + 1;
        i += 1;
        continue;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      frags.push(line.slice(i + 2));
      return frags;
    }
    if (ch === "/" && next === "*") {
      state.inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      state.quote = ch;
      continue;
    }
    if (ch === "}" && (state.templateDepth ?? 0) > 0) {
      // 插值结束 ⇒ 回到模板串
      state.templateDepth -= 1;
      state.quote = "`";
      continue;
    }
  }
  if (buf !== "") frags.push(buf);
  return frags;
}

const violations = [];
let commentLines = 0;
let allowed = 0;
const fileList = collectFiles();

for (const file of fileList) {
  let text;
  try {
    text = readFileSync(join(ROOT, file), "utf8");
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);
  const state = { inBlockComment: false, quote: "", templateDepth: 0 };
  for (let i = 0; i < lines.length; i += 1) {
    const lineText = lines[i];
    const wasInBlock = state.inBlockComment;
    const frags = commentFragmentsOfLine(lineText, state);
    if (frags.length === 0) continue;
    commentLines += 1;
    for (const frag of frags) {
      LINE_REF_RE.lastIndex = 0;
      let m;
      while ((m = LINE_REF_RE.exec(frag)) !== null) {
        if (ALLOW_MARKER.test(lineText) || (i > 0 && ALLOW_MARKER.test(lines[i - 1]))) {
          allowed += 1;
          continue;
        }
        violations.push({
          file,
          line: i + 1,
          ref: m[0],
          inBlock: wasInBlock || true,
          snippet: lineText.trim().slice(0, 96),
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`\n✗ 注释里出现行号引用（W9323）：${violations.length} 处。改成 [symbol] 符号引用：\n`);
  const byFile = new Map();
  for (const v of violations) {
    if (!byFile.has(v.file)) byFile.set(v.file, []);
    byFile.get(v.file).push(v);
  }
  for (const [file, vs] of byFile) {
    console.error(`  ${file}（${vs.length} 处）`);
    for (const v of vs) {
      console.error(`    :${v.line}  ${v.ref}`);
      console.error(`        ${v.snippet}`);
    }
  }
  console.error(`\n  为什么这是错的：注释里的行号会**静默腐烂** —— W9321 刚改完 child.ts，`);
  console.error(`  两处测试注释里的「child.ts:97-119」就已经失真，而类型/lint/架构/测试全绿。`);
  console.error(`  正确写法：用符号引用（[taskkillTree]），或写成不含行号的文字描述。`);
  console.error(`  例外（确实需要行号，例如机械门禁的示例）: 在**违规行或其紧邻上一行**加 W9323 注释说明。`);
  process.exit(1);
}

console.log(
  `✓ 注释行号引用门禁通过（扫 ${fileList.length} 文件 / ${commentLines} 行注释，` +
    `${allowed} 处 W9323 豁免，0 处行号引用）`,
);
void existsSync;
