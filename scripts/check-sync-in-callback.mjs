#!/usr/bin/env node
/**
 * W9323 · 「事件回调 / 定时器 / 请求处理器里不许有同步阻塞调用」的门禁（棘轮）。
 *
 * 为什么需要它：W9321 修的是一**类**缺陷，不是一处 —— 同步阻塞调用出现在事件回调里。
 * `packages/tools/src/sandbox/child.ts` 的 `taskkillTree` 曾用 `execFileSync` ×3
 * （各 5s 超时）+ `sleepSync` 退避，而调用点就在 abort 监听器里（`broker.ts` 的
 * `killChildOnAbort`、`launch.ts` 的 `onAbort`）：用户按 Stop 会**同步冻结整个进程
 * 最长约 15s**。已修（commit 3c9b0f4）。**但同一类还有多少处，没人知道 —— 这就是本门禁。**
 *
 * 判据（机械，不做类型推断）：
 *   ① 同步阻塞 API（见 SYNC_APIS）：它们把调用线程冻结到 syscall 返回。
 *   ② 回调宿主（见 HOST_NAMES / ROUTE_HOSTS）：事件订阅 / 定时器 / 路由注册。
 *   两者落在**同一个回调函数体内** ⇒ 报。
 *
 * 为什么必须跨行识别：`setTimeout(() => { … execFileSync(…) … }, ms)` 里那句同步调用
 * 写在第 5 行，是最常见的形态。只看同一行等于没门禁。实现走一次**字符级扫描 +
 * 括号栈**，并跟踪块注释与字符串状态，避免「注释/字符串里写了 setTimeout」造成假宿主。
 *
 * ★ 已知局限（诚实登记，不假装更强）：
 *   · 传**具名函数**的宿主（`app.get("/x", handler)`）看不到 `handler` 体内的同步调用；
 *   · 模板串 `${…}` 内部按字符串处理，不进去；
 *   · 括号配平遇到语法错误的文件会失准（那种文件 typecheck 先红）。
 *   门禁是**护栏不是证明**。
 *
 * 豁免口径**逐字对齐** `scripts/check-sleep-debt.mjs`（W9225）：marker 写在违规行
 * **或其紧邻上一行**。为什么只能是这两行：W9225 实测过「marker 写在 3 行外不生效」——
 * 别再犯一次。
 *
 * 基线（棘轮，`scripts/baselines/sync-in-callback.json`）：登记**改门禁之前就已存在**的
 * 违规，**只许下调**。
 *   · 新增违规（不在基线里）⇒ 红；
 *   · 清掉一条基线违规 ⇒ 打印陈旧提醒（**只是提醒**，不红 —— 本仓是多 worker 共用
 *     一个工作树，别人清掉违规是好事，不该让他的成功把门禁搞红；与 eslint 的
 *     `unused-vars-stale` 同一条理由）；
 *   · `entries.length > ratchet` ⇒ 红（棘轮只许下调；要加就得显式抬 ratchet 那个数字，
 *     而那个数字在 diff 里是看得见的）。
 * 绝不允许用宽泛豁免把结果做成 0：基线里的每一条都带 `why`（为什么当初没改）。
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_REL = "scripts/baselines/sync-in-callback.json";

/** 豁免标记：违规行本身或**紧邻上一行**出现它即豁免（口径同 check:sleep / W9225）。 */
const ALLOW_MARKER = /W9323/;

/** 同步阻塞 API：立刻把线程冻结到 syscall 返回。 */
const SYNC_APIS = [
  "execFileSync",
  "spawnSync",
  "sleepSync",
  "readFileSync",
  "writeFileSync",
  "appendFileSync",
  "statSync",
  "existsSync",
  "readdirSync",
  "mkdirSync",
  "rmSync",
  "unlinkSync",
  "copyFileSync",
];

/** 回调宿主的方法名：事件订阅 / 定时器 / 进程级钩子。 */
const HOST_NAMES = new Set([
  "on",
  "once",
  "addEventListener",
  "setTimeout",
  "setInterval",
  "setImmediate",
]);

/** 路由注册 / 请求处理器也算宿主（express / hono / node:http 形状都覆盖）。 */
const ROUTE_NAMES = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "all",
  "use",
  "route",
  "handle",
  "fetch",
  "handleRequest",
  "request",
  // node:http 的请求处理器入口：`http.createServer((req, res) => …)`。
  // ★ 由交叉验证实测补上：w2058-preview-probe.mjs 的 `createServer(async (req,res)=>…)`
  //   里就有 existsSync/readFileSync，而只认 app.get/router.post 的第一版把它**整条漏掉**。
  "createServer",
]);

/**
 * 只有「像服务器/框架对象」的**接收者**才算路由宿主。
 *
 * 为什么要有这层（交叉验证实测出来的）：`Map.get` / `reads.get` / `cache.all` 也是
 * `<接收者>.<方法>(`，若只看方法名，一次无伤大雅的 `reads.get(path)` 就会把整个文件
 * 判成请求处理器。用**白名单接收者**而不是猜意图。
 */
const ROUTE_RECEIVERS = new Set([
  "app",
  "router",
  "server",
  "srv",
  "api",
  "routes",
  "route",
  "fastify",
  "hono",
  "express",
  "http",
  "https",
]);

/** 扫描范围（相对 ROOT）。刻意不扫 apps/web：它由自己的 8 道子门禁与 tsc 管。 */
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

/** 收集待扫文件（走文件系统而不是 `git ls-files`：**未跟踪的新文件也要进门禁**）。 */
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
 * 一次字符级扫描，产出两种事实：
 *   · 同步 API 调用（file, line, api, 规范化原文）
 *   · 同步 API 调用**所在的最内层回调宿主**（有 ⇒ 违规）
 *
 * 用一个 `parenStack`（记录每个未闭合 `(` 的宿主名）与一个 `braceStack`（记录每个未闭合
 * `{` 是否落在某个未闭合的宿主调用实参里）。同步调用发生的那一刻，`braceStack` 里只要有
 * 一个「宿主体」大括号，就说明它**在**回调体内。
 *
 * ★ 但那只覆盖**内联**回调。真实代码最常见的第二种形态是**具名**回调：
 *     const onAbort = (): void => { …execFileSync(…)… };
 *     signal.addEventListener("abort", onAbort, { once: true });
 *   箭头函数体执行时并没有任何宿主 `(` 打开，纯「括号栈」看不见它 —— 而这正是 W9321
 *   缺陷**原来的形状**（`broker.ts` 的 `killChildOnAbort` / `launch.ts` 的 `onAbort`）。
 *   所以这里额外记两张表：
 *     · `fnBodies`：每个 `名字 = (…) => {` / `function 名字(…) {` 的 body 区间；
 *     · `hostArgs`：`on(` / `addEventListener(` 的实参里出现过哪些标识符。
 *   两者相交 ⇒ 那个函数体是回调宿主。
 *   （由植入违规的负控制当场抓住：没有这一步，W9321 那个原址改坏了门禁都照样绿。）
 */
function scanFile(rel, text) {
  const hits = [];
  const parenStack = []; // { name, isHost }
  const braceStack = []; // { isHost, line }
  const inHostStack = []; // 与 braceStack 平行：每个大括号是否落在宿主实参内
  const fnBodies = []; // { name, startLine, endLine }
  const hostArgs = new Set(); // 作为宿主实参出现的标识符
  let line = 1;
  let inBlockComment = false;
  let quote = ""; // '' | "" | '`' 跨行保持
  let pendingName = "";
  /** 上一个被读到的标识符（用来识别 `const onAbort = (…) => {`）。 */
  let lastIdent = "";
  /** 当前正在收集的具名函数体。 */
  let openFn = null;
  /** 宿主实参里正在累积的标识符片段。 */
  let argAccum = "";
  /** 当前是否在某个宿主的实参括号内。 */
  const inHostParen = () => parenStack.some((p) => p.isHost);
  /** 把累积到一半的实参标识符落盘（分隔符处调用）。 */
  const flushArg = () => {
    if (argAccum !== "") {
      hostArgs.add(argAccum);
      argAccum = "";
    }
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "\n") {
      line += 1;
      if (quote !== "" && quote !== "`") quote = "";
      continue;
    }
    if (inBlockComment) {
      // 块注释里的换行**必须**计数，否则多行注释会让后面所有行号整体前移
      // （本门禁第三版实测抓到：报出来的行号与内容对不上）。
      if (ch === "\n") {
        line += 1;
        continue;
      }
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote !== "") {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    // 行注释：跳到本行结尾。
    // ★ 不用 `break` —— 那会**退出整个文件扫描**（本门禁第二版实测抓到：一个文件里
    //   第一行注释就让它后面所有行都不再被扫，于是报 0 命中）。
    // ★ 落在 '\n' 上时**不**提前 `i += 1`：for 循环自己会加，加两次就跳过换行、
    //   `line` 少加一次 ⇒ 报出来的行号与内容整体错位（本门禁第三版实测抓到）。
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      // ★ 关键：`i` 现在指着 '\n'，但 for 的 `i += 1` 会把它**跳过** ⇒ `line` 少加一次
      //   ⇒ 行号与内容整体错位（本门禁第三版实测抓到：`scripts/perf/lib/server.mjs` 里
      //   报出来的那一行内容与行号完全对不上）。退一格，让下一轮重新读到 '\n' 并正常计数。
      i -= 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      pendingName = "";
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      pendingName += ch;
      if (openFn === null) lastIdent = pendingName;
      // ★ 宿主实参收集：只要此刻**处在某个宿主的实参括号内**，读到的标识符就是候选回调。
      //   不能等到 `(` 才记 —— `addEventListener("abort", onAbort, {once:true})` 里的
      //   `onAbort` 后面**没有** `(`，等 `(` 就永远记不到它（第四版实测抓到的坑）。
      //   也不能在「读到第一个字符时」记 —— 那样只记得下一个字母（onAbort ⇒ "o"）。
      //   正确时机是**标识符结束**（下一个字符是分隔符）那一刻，见下面的 flushArg。
      // ★ 只能追加**当前这一个字符**（ch）—— 追加整个 pendingName 会把已累积的部分反复
      //   复制进去（"o"+"on"+"ona"… 拼成 "oononAonAboonAboronAbort"，第四版实测）。
      if (inHostParen()) argAccum += ch;
      continue;
    }
    // `.` 只有在**紧贴**标识符时才属于成员访问（`child.on`）；`foo . bar` 不是。
    // ★ 空白/运算符必须清空 pendingName，否则 `const out = execFileSync` 会累积成
    //   `constout=execFileSync`，同步 API 一个都认不出来（本门禁第一版的真 bug，
    //   由植入违规的负控制当场抓住，不是靠读代码看出来的）。
    if (ch === "." && pendingName !== "" && /[A-Za-z0-9_$]/.test(next ?? "")) {
      if (inHostParen()) argAccum += ".";
      pendingName += ch;
      continue;
    }
    if (ch === "(") {
      flushArg();
      // 到了 `(`：先判定「正在被调用的标识符」是不是同步 API —— 这是唯一可靠的时机。
      if (pendingName !== "" && SYNC_APIS.includes(pendingName)) {
        let hostLine = null;
        for (let k = braceStack.length - 1; k >= 0; k -= 1) {
          if (inHostStack[k]) {
            hostLine = braceStack[k].line;
            break;
          }
        }
        // 内联回调看不见的情形：落在「后来被当作宿主实参」的具名函数体内。
        // ★ 这里**不能**现在判定 —— `addEventListener("abort", onAbort)` 往往写在函数体
        //   **之后**（broker.ts 的 killChildOnAbort 就是），单遍扫到 execFileSync 时
        //   hostArgs 还是空的。故先把 inlineHostLine 记下，返回后由调用方用完整的
        //   hostArgs/functionBodies 复核（见 resolveHosts）。
        hits.push({ line, api: pendingName, inlineHostLine: hostLine, col: i });
      }
      // `名字 = (…) => {` / `名字 = (…) : 返回类型 => {` / `function 名字(…) {`：
      // 等它的 `{` 开启函数体（这样拿到「函数体区间」，供宿主实参反查）。
      // ★ 返回类型注解里**不能**用 `[^=]*`：`: void =>` 的 `=>` 里就有 `=`，会把匹配截断
      //   （本门禁第四版实测抓到：正是这条让 W9321 的原址改坏了门禁都不红）。
      if (openFn === null && lastIdent !== "" && lastIdent !== "function") {
        const after = text.slice(i + 1);
        const arrow = /^\s*\)\s*(?::[\s\S]*?)?=>\s*\{/.test(after);
        const plain = /^\s*\)\s*(?::\s*[\w<>\[\]{}|\s.]+)?\s*\{/.test(after);
        if (arrow || plain) openFn = { name: lastIdent };
      }
      parenStack.push({ name: pendingName, isHost: isHostName(pendingName) });
      lastIdent = "";
      pendingName = "";
      continue;
    }
    if (ch === ")" || ch === "{" || ch === "}" || ch === ";" || ch === "," || ch === "=") {
      flushArg();
      if (ch === "{") {
        // `{` 可以是宿主的回调体（`on(` 尚未闭合 ⇒ 栈里有宿主），也可以是普通块 / 函数体。
        const isHost = parenStack.some((p) => p.isHost);
        braceStack.push({ isHost, line });
        inHostStack.push(isHost);
        if (openFn !== null && fnBodies.every((f) => f.name !== openFn.name)) {
          fnBodies.push({ ...openFn, startLine: line, endLine: Number.MAX_SAFE_INTEGER, declLine: line });
        }
        openFn = null;
      } else if (ch === "}") {
        braceStack.pop();
        inHostStack.pop();
        // 刚弹出的那个大括号若是某个具名函数体的收尾，就把它的区间封口。
        const open = fnBodies.find((f) => f.endLine === Number.MAX_SAFE_INTEGER);
        if (open !== undefined) open.endLine = line;
      } else if (ch === ")") {
        parenStack.pop();
      }
      pendingName = "";
      // ★ `=` **不**清空 lastIdent：`const onAbort = (): void => {…}` 里的名字在 `=` 之前，
      //   清掉就再也认不出这个函数体（W9321 原址的形状，本门禁第四版实测抓到的坑）。
      if (ch !== "=") lastIdent = "";
      continue;
    }
    // 任何其它分隔符（空白、运算符、标点）都截断标识符。
    flushArg();
    pendingName = "";
  }
  flushArg();
  void rel;
  return { hits, hostArgs, fnBodies };
}

function isHostName(name) {
  if (name === "") return false;
  const bare = name.replace(/^.*\./, "");
  // 事件/定时器：`on(` / `emitter.once(` / `el.addEventListener(` / `setTimeout(`
  if (HOST_NAMES.has(name) || HOST_NAMES.has(bare)) return true;
  // 路由：接收者必须在白名单里（否则 `reads.get(` 这类普通 Map 访问会被误判）
  if (name.includes(".")) {
    const recv = name.slice(0, name.lastIndexOf("."));
    if (ROUTE_RECEIVERS.has(recv) && ROUTE_NAMES.has(bare)) return true;
  }
  return false;
}

function loadBaseline() {
  const p = join(ROOT, BASELINE_REL);
  if (!existsSync(p)) return { entries: [], map: new Map(), ratchet: 0, missing: true };
  const parsed = JSON.parse(readFileSync(p, "utf8"));
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  return {
    entries,
    map: new Map(entries.map((e) => [e.key, e])),
    ratchet: Number(parsed.ratchet ?? entries.length),
    missing: false,
  };
}

/** 基线 key：**不用行号** —— 行号在一次无关编辑后就全漂了，棘轮会立刻变成一堆假红。
 * 改成 `文件 + API + 规范化原文`：无关编辑不影响，代码真变了就报「基线条目已失效」。 */
function normText(text) {
  return text.trim().replace(/\s+/g, " ");
}
function keyOf(file, api, snippet) {
  return `${file}|${api}|${normText(snippet)}`;
}

const baseline = loadBaseline();
const violations = [];
const stale = [];
let syncCalls = 0;
let allowed = 0;
const seenKeys = new Set();
const fileList = collectFiles();

for (const file of fileList) {
  let text;
  try {
    text = readFileSync(join(ROOT, file), "utf8");
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);
  const { hits, hostArgs, fnBodies } = scanFile(file, text);
  for (const hit of hits) {
    syncCalls += 1;
    const lineText = lines[hit.line - 1] ?? "";
    // 补判定：内联看不见时，看它是否落在「被当作宿主实参」的具名函数体内。
    // （必须扫完整份文件之后才能判 —— 宿主注册常常写在函数体**之后**。）
    let hostLine = hit.inlineHostLine;
    if (hostLine === null) {
      for (const fn of fnBodies) {
        if (hit.line >= fn.startLine && hit.line <= fn.endLine && hostArgs.has(fn.name)) {
          hostLine = fn.declLine;
          break;
        }
      }
    }
    if (hostLine === null) continue;
    if (ALLOW_MARKER.test(lineText) || (hit.line > 1 && ALLOW_MARKER.test(lines[hit.line - 2] ?? ""))) {
      allowed += 1;
      continue;
    }
    const key = keyOf(file, hit.api, lineText);
    const v = { key, file, line: hit.line, api: hit.api, host: hostLine, snippet: normText(lineText) };
    if (baseline.map.has(key)) {
      seenKeys.add(key);
      continue;
    }
    violations.push(v);
  }
}

for (const e of baseline.entries) if (!seenKeys.has(e.key)) stale.push(e);

// 棘轮：entries 条数不得超过 ratchet（要加就必须显式抬那个数字，diff 里看得见）。
const ratchetBreak = baseline.entries.length > baseline.ratchet;

if (violations.length > 0 || ratchetBreak || baseline.missing) {
  if (baseline.missing) {
    console.error(`\n✗ 缺基线文件 ${BASELINE_REL}（W9323）。`);
    console.error(`  本门禁要求把「改门禁之前就存在」的违规**逐条**登记在基线里并写明 why，`);
    console.error(`  不允许「基线不存在 ⇒ 零违规」这种把结果做成 0 的省事路径。`);
    process.exit(1);
  }
  if (ratchetBreak) {
    console.error(
      `\n✗ 基线棘轮被抬高（W9323）：entries ${baseline.entries.length} 条 > ratchet ${baseline.ratchet} 条。`,
    );
    console.error(`  本棘轮**只许下调**。新增违规必须改代码或写 W9323 豁免，不得改基线顶账。`);
  }
  if (violations.length > 0) {
    console.error(`\n✗ 事件回调 / 定时器 / 请求处理器里出现同步阻塞调用（W9323）：${violations.length} 处未登记：\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  [${v.api}]  宿主回调起于 :${v.host}`);
      console.error(`      ${v.snippet.slice(0, 96)}`);
    }
    console.error(`\n  为什么这是错的：同步阻塞调用在**回调里**会把事件循环/主线程冻结到 syscall 返回。`);
    console.error(`  W9321 实证：abort 监听器里的 execFileSync ×3 + sleepSync 退避，让用户按 Stop 同步卡死约 15s。`);
    console.error(`  正确写法：换异步 API（execFile / spawn / fs.promises），或把它移出回调（预热 / 走队列）。`);
    console.error(`  若此处同步阻塞确属刻意且无法异步化，在**违规行或其紧邻上一行**加 W9323 注释说明理由。`);
  }
  process.exit(1);
}

console.log(
  `✓ 同步阻塞-in-回调门禁通过（扫 ${fileList.length} 文件 / ${syncCalls} 处同步 API 调用，` +
    `${allowed} 处 W9323 豁免，基线 ${baseline.entries.length} 条${stale.length > 0 ? `，陈旧 ${stale.length} 条` : ""}）`,
);
for (const s of stale) {
  console.log(`  ⚠ 基线条目已失效，请从 ${BASELINE_REL} 删除：${s.key}`);
}
