# scripts/perf/ — 前端性能侦测工具包（W9111）

零依赖（只用 Node 内置 + 全局 WebSocket），**不碰被测源码**，不动共享工作树。

## 它做什么

| 文件 | 作用 |
|---|---|
| `lib/cdp.mjs` | 极简 CDP 客户端（WebSocket 上的 JSON-RPC + 事件） |
| `lib/chrome.mjs` | 启动 headless Chrome（profile 写 `$TEMP`） |
| `lib/backend.mjs` | **确定性假后端**：真 EventSource / 真 SSE 帧，帧时序由 `/__control/burst` 驱动 |
| `lib/server.mjs` | 静态服务器（早期版本，保留） |
| `lib/app.mjs` | 装配 + `waitFor` / `control` |
| `lib/cleanup.mjs` | **进程收尾登记**（W2021）：信号下同步 kill Chrome / 释放端口，再等异步收尾 |
| `lib/probe.mjs` | 注入页面的只读探针：rAF 帧节拍 + LoAF 归因 + MutationObserver |
| `lib/scenario.mjs` | 场景公共件（动态 import 应用模块、取 pane、发突发） |
| `lib/stats.mjs` | 中位数/p95/max、原始 JSON 与 markdown 表落盘 |
| `cases/q1-think.mjs` | 问题 1：大思考块阈值曲线 + 真 SSE 突发 |
| `cases/q2-virtual.mjs` | 问题 2：600/1200/3000 列滚动与回收 |
| `cases/q3-mutation.mjs` | 问题 3：四场景 DOM 增删量化 |
| `cases/q4-memory.mjs` | 问题 4：CDP 堆指标 + 持有者计数 + 分配归因 |
| `verify.mjs` | 复核既有声明（DOM 上限 / ops / oversize / cadence / think 预算） |
| `focus-*.mjs` | 焦点复现（每个对应报告里一条结论） |
| `cases/w2021-signal-stub.mjs` | **门禁专用探针**（不是测量场景）：起 app 后等着被发信号 |
| `run.mjs` | 总入口：`node scripts/perf/run.mjs q1 q2 q3 q4` |

## 前置：冻结检出 + Vite 转换服务

测量必须在**冻结版本**上做，否则并发 worker 的改动会让数字不可复现。

```bash
# 1) 导出当前 HEAD 到 $TEMP（不碰工作树）
$tmp = Join-Path $env:TEMP 'perf-w9111'
$repo = Join-Path $tmp 'repo'
New-Item -ItemType Directory -Path $repo -Force | Out-Null
git archive HEAD | tar -x -C $repo
# 2) node_modules 用 junction 指回共享工作树（不重装、不写 .pnpm）
cmd /c mklink /J "$repo\node_modules" "<本仓>\node_modules"
cmd /c mklink /J "$repo\apps\web\node_modules" "<本仓>\apps\web\node_modules"
# 3) 起 Vite（只做 TS→JS 转换与 CORS，不写共享 dist）
cd $repo\apps\web
node node_modules/vite/bin/vite.js --port 3787 --strictPort --host 127.0.0.1
```

### Linux / macOS 等价做法（W2019）

上面的 `cmd /c mklink /J` 是 Windows 专有；POSIX 上的等价物是**符号链接**：

```bash
tmp=$(mktemp -d)
git archive HEAD | tar -x -C "$tmp"
ln -s "$PWD/node_modules"            "$tmp/node_modules"
ln -s "$PWD/apps/web/node_modules"   "$tmp/apps/web/node_modules"
cd "$tmp/apps/web" && node node_modules/vite/bin/vite.js --port 3787 --strictPort --host 127.0.0.1
```

Chrome 的查找顺序（W2019）：`W9111_CHROME` 环境变量 → 各平台常见安装路径 →
Playwright 浏览器缓存（`~/.cache/ms-playwright/<browser>-<build>/…`，含
`chrome-headless-shell`）。**没有 Chrome 时不再只能靠"恰好装在默认位置"**：

```bash
export W9111_CHROME=/root/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell
node scripts/perf/smoke.mjs
```

不设 `W9111_REPO` 时，仓根**从脚本自身位置推导**（上溯到含 `package.json` 的目录），
并在 stderr 打一条警告 —— 正式测量仍应显式指向 `git archive` 导出的**冻结**检出，
否则量的是活工作树（并发改动会让数字不可复现）。

## 跑

```bash
cd <本仓>
node scripts/perf/smoke.mjs                      # 冒烟：前端起得来 + SSE 通
node scripts/perf/run.mjs q1 q2 q3 q4            # 四个必答问题
node scripts/perf/verify.mjs                     # 复核既有声明
node scripts/perf/focus-toolrate.mjs             # P0：工具卡速率 vs 冻结
node scripts/perf/focus-toolcost.mjs             # P0 归因：单次工具事件代价
node scripts/perf/focus-scroll.mjs               # 滚动退化曲线
node scripts/perf/focus-ops.mjs                  # DOM 上限与 ops
node scripts/perf/focus-think-ledger.mjs         # thinkBudget 账本漂移
```

原始数据与表格落到 `results/perf-w9111/`（gitignored）。

## 被信号杀死时不留垃圾（W2021）

**修复前的现场**：`timeout 115 node scripts/perf/run.mjs q1` 之后 backend 端口随进程消失，
但 **Chrome 是 spawn 出来的独立进程** —— 它被 init 收养后继续活着，继续占着 CDP 端口
（`ss -ltnp` 里仍是 `chrome-headless`）与 `$TEMP/w9111-chrome-*` profile 目录。下一次测量
就撞 `listen EADDRINUSE` / CDP 连不上，而报错指向 `node:net`，看不出根因。

**根因**：Node 的 SIGTERM/SIGINT 默认行为是**立即退出** —— 不跑 `finally`、不跑
`process.on('exit')`。所以每个 case 里的 `finally { await app.close(); }` 在信号下**永远不执行**。

**现在的形状**：

- `lib/cleanup.mjs` 维护一张**活跃实例**登记表。`boot()` 起来后登记、`close()` 完注销
  ⇒ 信号到达时表里恰好是「还活着」的实例（0/1/2 个都对），既不漏也不重复关。
- 信号处理器里**先同步做关键动作**（`child.kill()` / `server.close()` 都同步释放资源），
  再**有上限地**等异步部分（profile 删除），上限（2s）到了就退出。
- 退出码 = `128 + signum`（SIGTERM → 143、SIGINT → 130），与 shell 口径一致；
  **第二次信号**立即退出，不再等。
- `chrome.close()` / `backend.close()` / `app.close()` 都**幂等**：正常路径的 `finally` 与
  信号路径的 drain 拿到的是同一次收尾，重复调用不抛错。
- 登记表为空时**摘掉**信号处理器 ⇒ **正常路径（跑完自己收尾）与改动前逐字同形**，
  不多做任何工作、不影响测量口径。

回归门禁：`tests/w2021-perf-signal-cleanup.test.ts`（起真 app + 真 Chrome，发 SIGTERM，
断言端口可再 bind / 无孤儿 Chrome / profile 已删 / 退出码 143）。**不依赖 Vite**。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `W9111_REPO` | 从脚本位置上溯出的仓根（推导时打警告） | 冻结检出根（**正式测量必须显式指定**） |
| `W9111_VITE` | `http://127.0.0.1:3787` | Vite 转换服务 |
| `W9111_RESULTS` | `results/perf-w9111` | 结果目录 |
| `W9111_CHROME` | 自动查找（见上） | Chrome 可执行文件（**最高优先级**） |
| `W9111_PORT` | `3788` | fixture 后端端口（并行跑时改它，避免撞端口） |
| `W9111_CDP_PORT` | `9333` | Chrome 远程调试端口（同上） |

`W9111_PORT` / `W9111_CDP_PORT` 的形状照抄仓内既有的 `W9113_PORT` / `W9113_CDP_PORT`
范例（`w9113-p0.mjs`）：默认值不变，设了就用环境变量。

## 为什么不用 playwright / puppeteer

本仓 `node_modules` 里没有它们，装它们要跑 `pnpm install` 重写 `.pnpm` 目录 —— 那会
干扰并发中的其他 worker。Node 22+ 有全局 `WebSocket`，直接说 CDP 协议就够。
