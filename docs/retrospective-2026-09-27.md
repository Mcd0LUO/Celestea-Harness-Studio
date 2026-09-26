# 复盘 · 2026-09-27 —— 审计驱动的一轮（12 路审计 + 10 路修复 → v2.8.0）

> 状态：**当前** —— 描述本仓现存的门禁与失效模式，不是一次性的过程留痕。
>
> 写给未来的贡献者：这一轮暴露了哪些**本仓的失效模式**，哪些已经变成**机械门禁**，哪些**仍未解决**。
>
> 原始材料（12 份审计报告、10 份修复报告、派工者的复核记录）都在 `results/`，
> 而 `results/` 被 `.gitignore` 忽略、**不入库**。所以本文**不把它们写成 Markdown 链接**——
> 在干净检出里那些链接必然打不开，`tests/doc-conventions.test.ts` 的断言 ③ 会抓。
> 需要原文时按文件名在本机的 `results/` 下找。

---

## 0. 这一轮是什么

- **12 路并行审计**：`results/W9201-*.md` … `results/W9212-*.md`，共 12 份。
- **10 路并行修复**：`results/W9201-修复.md` … `results/W9210-修复.md`，共 10 份。
- **发布**：`v2.8.0` 是一个 annotated tag，其 `object` 指向 `df85bbe`（= 写作时的 `HEAD`）。

各审计报告**自述**的严重度分布（我逐份读表格抄下来的，不是估算）：

| 报告 | P0 | P1 | P2 | P3 | 小计 |
| --- | --- | --- | --- | --- | --- |
| W9201 消息渲染管线 | 1 | 11 | 10 | 5 | 27 |
| W9202 配置与提供商页 | 0 | 5 | 13 | 15 | 33 |
| W9203 样式与 i18n | 0 | 9 | 13 | 8 | 30 |
| W9204 交互层 | 0 | 4 | 21 | 13 | 38 |
| W9205 tools 包 | 2 | 5 | 26 | 23 | 56 |
| W9206 studio 后端 | 6 | 24 | 18 | 1 | 49 ★ |
| W9207 runtime / workers | 1 | 7 | 14 | 6 | 28 |
| W9208 core / llm / agent-loop | 0 | 6 | 12 | 11 | 29 |
| W9209 契约与数据流 | 0 | 2 | 12 | 10 | 24 |
| W9210 权限与沙箱链 | 3 | 8 | 6 | 3 | 20 ★ |
| **合计（W9201–W9210）** | **13** | **81** | **145** | **95** | **334 条带严重度的发现** |

W9211 / W9212 是**功能提案**（各 13 条候选），不是缺陷，不计入上表。

★ **这两格的数字来自回执消息，不是报告文件**（详见 §4.1）：
`results/W9206-studio后端.md` 与 `results/W9210-权限沙箱链.md` **都没有自述总数**——
W9206 的结论表只列到 34 条（`3/18/10/1 = 32` + 2 条判「无缺陷」），而它的正文编号与
`results/VERIFIED.md` 引用的 `W9206-35/36/37/43` 都超出那张表，说明表不是全集。
所以「49」这一格**无法只从报告文件复算**；它是**逐份报告 + 回执消息**一起加出来的。
**这是那两份报告的一个缺口，见 §4.1。**

「14 个提交」的取数口径：`561d1a1`（CI 拆步）到 `df85bbe` 之间共 19 个提交，
其中 `fix`/`perf`/`feat` **恰好 14 个**（另有 3 个 `ci:` + 1 个 `chore(release): 2.8.0` + 1 个 `chore:`）。

---

## 1. 失效模式（每条都有真实例子与 `文件:行`）

### 1.1 测试把错误行为固化成期望（本轮确证 4 处）

这是本轮最贵的一类缺陷：**它让「把错改成对」这件事本身变红**，于是错误被锁死。

| # | 测试 | 它固化了什么 | 真值 | 处置 |
| --- | --- | --- | --- | --- |
| 1 | `tests/contracts.test.ts`（修复前 :448） | `toContain("14 tools")` | `contracts/tools.json` 的 `count` = 19，`EXECUTION_TOOL_NAMES` = 13 | 提交 `5a2723e`：断言改为**从两个真源派生**，见 `tests/contracts.test.ts:460` |
| 2 | `tests/a3-commands.test.ts`（修复前 :49） | 对任何以 `/goal` 结尾的 URL 回**捏造的 200** | 后端整族不存在（永久 404） | 提交 `5a2723e`：换成契约忠实的 stub，见 `tests/a3-commands.test.ts:49` |
| 3 | `packages/llm/src/retry.test.ts`（修复前 :181） | `Retry-After` 超上限时 `toBe(0)` | 应**夹紧**到 `maxDelayMs` | 提交 `f113a84`：改为 `toBe(60_000)`，见 `packages/llm/src/retry.test.ts:183` |
| 4 | `packages/tools/src/run-code/w9112-python-utf8.test.ts`（修复前 :219） | 「截断的多字节尾**不算**损坏」`toBe(false)` | 子进程已用 `\n` 终止该行 ⇒ 不完整尾**就是**损坏 | 提交 `9e723a8`：反转期望为 `toBe(true)`，见 `packages/tools/src/run-code/w9112-python-utf8.test.ts:233` |

**#2 的机制值得单独记住**：stub 只匹配 URL 的**尾部**，于是「前端渲染正确」永远能通过，
而「后端端点不存在」永远测不出来——`pnpm check` 全绿，用户敲 `/goal` 得到永久 404。
**一个什么都答「成功」的 mock，比没有 mock 更危险**，因为它把「缺功能」伪装成「有功能」。

**判据（以后遇到就这么判）**：修复让某条既有断言变红时，先问「这条断言描述的是**规格**还是**当时的实现**」。
本轮的 4 处全部是后者——**测试错，不是代码错**，因此改测试（并把判断写进报告），
而不是把实现改回错误形态。反例也要记住：**不要为了让测试变绿而改坏正确行为**，
也不要为了「变异表全绿」去补一个假测试（见 §2.4）。

### 1.2 注释描述了一个不存在的状态

派工简报点名 2 处，各修复报告里**自己登记**的还有更多。这类注释的代价是：
它会把下一个实现者（以及测试）引向一个 API 永不产生的形状。

**① `apps/web/src/ui/providers/form.ts` 的「undefined = 三片全选」**
旧注释声称「缺省（undefined）与显式空数组是两件事：undefined = 未配置 ⇒ 乐观默认三片全选」。
事实：后端 `ProviderModel.reasoning_efforts` 是**必填** `string[]`，
`apps/studio/src/store/providers.ts:93` 对 providers.json 里缺失该键的行归一成 `[]`——
**前端拿到的永远是数组**，那个「乐观默认」分支**不可达**。
处置（提交 `965d552`）：注释改成事实，并**行为零改动**；新增的回归测试喂**真实 API 形状**（`[]`），
任何按旧注释实现的人会立刻变红。当前注释见 `apps/web/src/ui/providers/form.ts:152`。

**② `apps/web/src/chat.ts` 的「status 不碰消息容器」**
旧注释声称「status/compact/question 不走帧预算——前两者不碰消息容器」。
事实：`onStatus` 调 `finalizeTurn`/`renderInfoBlock`，`onStatusInbox` 追加整条 `.mcol`——
**status 是唯一同时写「消息容器 + 状态栏 + 会话条」的事件**。
处置（提交 `65b6398`）：status 也走帧预算，注释改写为事实 + 证据，见 `apps/web/src/chat.ts:317`。

**③ 各修复报告自己登记的同类项（本轮至少还有这些）**

| 位置 | 旧注释（假） | 新注释（真） |
| --- | --- | --- |
| `packages/tools/src/guard/path-guard.ts` | 「the two readings can never collide」（哨兵与真实根） | 「哨兵只是**拼写**，能力由布尔字段承载」；旧句作为历史保留说明它错在哪 |
| `packages/tools/src/guard/path-guard.ts` | 「decoder 与 validator 共用，所以边界不可能不一致」 | 「共享**就是** bug；宽容度是显式参数」 |
| `packages/session/src/log/persistent.ts` | 「内存视图是 derive_messages 的事实源」（当时是假的） | 与实现对齐（`events()` 真的从镜像读，见 `:163`） |
| `packages/llm/src/retry.ts` | 头部 ASCII 图把 retry 画在 fallback **外层** | 改成实际的**内层**，并注明是更正 |
| `apps/studio/src/store/grants-tokens.ts` | 「工具调用不带浏览器的 Sec-Fetch-* 头」（可伪造） | 头可伪造；真正的边界是 HttpOnly nonce cookie |
| `apps/web/src/styles/statusline.css` | 「mono 主题把 color-scheme 钉在 light，这一支今天不会命中」 | `prefers-color-scheme` 描述**操作系统**偏好，与页面 `color-scheme` 无关 |

**判据**：注释只能描述**代码现在真的做什么**。要写「为什么」可以，要写「未来的意图」不行——
意图会漂，漂了没人会去改注释。

### 1.3 本地绿、CI 红（跨平台）：根因同一类——**把宿主事实当成平台事实**

本机是 Windows，CI 有 ubuntu + windows 两套。本轮 CI 第一次真正跑 Linux，
于是抓到了本机**永远抓不到**的东西。四个同源案例：

| # | 提交 | 症状 | 根因 |
| --- | --- | --- | --- |
| 1 | `df1b120` | ubuntu 的 `test` 双 job 红，windows 双绿 | 断言 `sys.flags.utf8_mode === 1`——那是**本仓在 Windows 上主动注入 `PYTHONUTF8=1` 的结果**，不是跨平台不变量 |
| 2 | `1a0717d` | ubuntu 的 `test` 红 | `tests/w9210-grant-root-case.test.ts` 的 POSIX 分支**断言不可满足**（`else` 分支期望「接受」，而该平台上正确行为是「拒绝」） |
| 3 | `667e332` | ubuntu 的 `test` 红 | `packages/tools/src/guard/paths.ts:46` 的 `isInside` 用**宿主**的 `sep` 拼前缀：在 Linux 上给 win32 路径拼出 `c:\\users\\a/`，与 `c:\\users\\a\\b` 永不匹配 ⇒ **注入 platform 的整条缝在非 Windows 宿主上是坏的** |
| 4 | `c8d62b2` | ubuntu 的 `check:web` bundle 棘轮红 | 同一提交两侧 **raw 字节完全相同**，只有 gzip 差 2 字节——压缩链路本身平台相关（esbuild 原生二进制按平台分发、zlib 实现有差）。**把平台噪声当回归报，等于让门禁的结论取决于跑它的机器** |

**#2 与 #3 的教训最值钱**：#2 是**测试**写错，#3 是**产品的跨平台缝本身断了**——
后者只是恰好被测试暴露。两者的根因都是「宿主事实 = 平台事实」这个默认假设。

**本仓已有的缝，优先复用它**（不要手写平台判断）：

- `packages/tools/src/platform/paths.ts` 的 `isWindows(platform)` / `pathApi(platform)` / `execSuffixes(platform, env)`；
- `packages/tools/src/guard/paths.ts:46` 的 `isInside(child, root, platform)`；
- `apps/studio/src/runtime/engine-grants.ts:374` 的 `samePath` 与 `:386` 的 `insidePath`（三处比较统一走它们）；
- 测试侧的注入先例：`tests/w9210-grant-root-case.test.ts:81` 与 `:85` 在**任意宿主**上分别跑 win32 / POSIX 两支。

**硬要求**：任何涉及路径分隔符 / 大小写 / 绝对路径 / 执行位 / 换行的改动，
必须在报告里写明**验证的平台**，并优先把平台做成**可注入参数**——这样 win32 分支能在 Linux 上被测到，
不必等 CI。CI 是最后一道，不是第一道。

### 1.4 验证了机制，却没验证**输入面**

上一轮（W9110）把 `allPaths` 从「路径」升为一等能力，验证了 Windows 跨卷、也验证了 fail-closed 优先——
**但没验证哨兵会不会与合法数据撞车**：

- `packages/tools/src/guard/path-guard.ts:164` 的 `ALL_PATHS_ROOT = "/"` 是一个**可能等于真实数据的字符串**；
- `readRoots` 恒含 `workspace`（`workspace` 永远是第一个元素），而 POSIX 上 `workspace` 可以是 `/`；
- 于是 `hasAllPathsRoot(readRoots)` 被**推断**出来 ⇒ `allPaths = true` ⇒
  一个显式 `workspaceWritable: false`（只读）的会话，`checkWrite("/etc/cron.d/evil")` = **allow**。

**这是安全回归，且是上一轮自己引入的。** 修复（提交 `9e723a8`）是结构性的，不是补丁：

1. 能力改由布尔字段承载——`allPathsRead` / `allPathsWrite` 分离（`packages/tools/src/guard/path-guard.ts:255`），
   `allPaths` 退化为派生摘要 `read && write`，包外所有读者零改动；
2. 哨兵只在**调用方声明的**列表上解释（传 `init.readRoots`，不传组合后的 `this.readRoots`）；
3. `checkRead` 读 `allPathsRead`（`:317`）、`checkWrite` 读 `allPathsWrite`（`:339`）——读的声明不再打开写的能力。

**另一条同源缺陷**（`fromEnv` 漏传 `workspaceWritable`）的根因是**同一个构造字面量被抄了三遍**，
第三份（唯一的生产出口）漏了一个字段。修法同样是结构性的：抽一个 `base` 对象承载全部字段，
三条出口都从它派生（`packages/tools/src/guard/path-guard.ts:289`）——「第四条出口」也不可能再漏。

**教训**：**「机制验证过了」不等于「输入面验证过了」**。哨兵、默认值、枚举、边界值——
这些「看起来不会出事」的输入恰恰是提权的入口。给每个哨兵加一条「它与合法数据相等时会怎样」的测试。

### 1.5 声称做了但没做：叙事会漂，diff 不会

**先说清这条的归属**：`results/VERIFIED.md` 记录 `git show --stat dc018e5` 显示
那一轮**从未修改 `rail.ts`**。把这笔算作「已修」的**是派工者的转述**，
**不是 W9113 的自述**——派工者已确认这是他那边的错。
W9113 自己的报告 §9 把 rail 的 P1-1 明确列为**仍未修**，并写明
「本轮未动（在 `rail.ts`，棘轮 492 且不在必要范围）」。**它的自述是诚实的。**

**能核实的事实**：`dc018e5` 的 `--stat` 里没有 `rail.ts`；该 P1-1 当时确实开放，
最后由 W9204 在提交 `6c1976b` 修掉（`apps/web/src/ui/rail.ts:326` 改走 `queueSync()`）。

**可迁移的教训（这是本节的价值，与谁犯错无关）**：
**结论层的叙述会与底层的报告漂移，而且漂移发生在「转述」这一步，不在「写报告」那一步。**
派工者/复核者的摘要不是证据，`git show --stat` 与 `git log --grep` 才是。
**写「谁修了 X」之前，先跑一次 diff**；**读「谁修了 X」时，先假设那是转述**。
写「某某修了 X」之前，先跑一次 diff。

---

## 2. 已变成机械门禁的教训

本仓的取向写在 [`AGENT.md`](./AGENT.md) §8：**机械门禁优先于人的记性**——
任何「别忘了」都应该变成一条断言。本轮新落成的门禁如下。

### 2.1 门禁失败必须**自己说出自己是谁、为什么红**

- `scripts/run-gate.mjs`：跑命令并透传输出；非零退出时把**失败行**（`FAIL` / `✗` / `×` / `AssertionError` …）
  打成 GitHub annotation（`scripts/run-gate.mjs:44`），而不是尾巴——尾巴全是汇总，
  **失败用例名会被切掉**。
- **顺序是硬约束**：annotation 必须**先写**、且**另起一行**（`scripts/run-gate.mjs:58`）。
  workflow command 只在**行首**被识别；先 dump 子进程输出、再追加 annotation，
  若输出不以换行结尾，annotation 就被粘在半行末尾 ⇒ GitHub **静默忽略**，退回「exit code 1」。
  **「我写了正确的匹配逻辑」与「注解真的被看见了」是两件事。**
- 背景：job 日志需要 admin 权限才能下载（公开 API 403），annotation 走公开 API 可读。
  一个门禁如果红了却指不出自己是谁，它就没起到门禁的作用。

### 2.2 `pnpm check` 的 `&&` 链拆成逐门禁步骤

- 提交 `561d1a1` + `cdc62e1`：`.github/workflows/ci.yml` 里每一步单独成 step
  （`.github/workflows/ci.yml:66`），`check:web` 自己的子链也拆开。
- **聚合口径不变**：逐 step 等于原来 `pnpm check` 的 `&&` 链，本地 `pnpm check` 未动。
- 效果是真实的：拆分后立刻定位到 ubuntu 上红的是 `check:web`（`test` 已经好了）。

### 2.3 产物体积门禁的**跨平台容差**与它的边界

- `apps/web/tools/check-bundle-size.mjs:54`：`TOLERANCE_BYTES = 128`。
- 边界写死得很清楚：**超出超过 128 才失败**（`:102`）；**超出但在容差内通过，但如实打印 ⚠**（`:104`），
  **绝不静默**——容差不能变成「随便超都不红」。
- 取 128 的依据：**远大于**实测平台噪声（个位数），又**远小于**任何值得报警的回归
  （本仓真实增量是数百到数千字节）。
- **它为什么可以有不精确比较**：理由写在文件头（压缩链路平台相关），
  「本门禁量的是量级，不是逐字节指纹」。**任何一处「不精确比较」都必须写明理由**，否则它就是一次无声的放松。

### 2.4 跨平台发布路径：四条 Windows 缺陷，一条断言钉住

提交 `df85bbe` 修了四条**同源**缺陷（都是「把 POSIX 事实当跨平台事实」），
并扩了 `tests/cross-platform-scripts.test.ts` 的一条断言（`tests/cross-platform-scripts.test.ts:112`）：

1. `package.json` 的 build 用**单引号**——cmd.exe 不把 `'` 当引号，`--filter` 带着引号传给 pnpm，
   报 `No projects matched the filters`，**整个构建被跳过**；
2. `scripts/{build-webdist,release-check,publish}.mjs` 用 `execFileSync("pnpm", …)`——
   Windows 上 pnpm 是 `pnpm.cmd`，`execFileSync` **不走 PATHEXT** ⇒ ENOENT；
3. `release-check` 用 `line.startsWith("/")` 判「是否绝对路径」——`pnpm pack` 在 Windows 打印 `C:\\…`，
   于是被 join 两次，路径翻倍（断言见 `:133`：**必须用 `path.isAbsolute`**）；
4. `release-check` 检查 bin 的 **POSIX 执行位**——NTFS 没有这个概念，该断言在 Windows 上**永远不可能通过**
   （断言见 `:137`：执行位检查必须在 win32 上短路；tarball 里的 member mode 才是「用户实际拿到什么」）。

**CI 不跑 `release`，所以这四条一直没被发现**——直到按发布流程真的跑了一次 `pnpm run release`。
**门禁的覆盖面本身也是要检查的**：没被任何门禁跑到的那条路径，等于没有门禁。

### 2.5 变异负控制：不要求全绿，要求诚实

[`AGENT.md`](./AGENT.md) §2 要求「把实现改坏一次，确认测试真的变红」。
本轮最有价值的几条记录恰恰**不是**全红：

- **W9204 的 M9 是绿的，它如实标注「未覆盖」**：删掉 mode 弹层的同一性守卫后测试仍全绿，
  因为**通过公开 API 构造不出「迟到的旧层 close」这个场景**。它的原话是
  「我没有为了让变异表全绿而去补一个假测试」。**这是正确理解**——变异负控制的目的是**暴露覆盖缺口**，
  不是把表刷绿。
- **W9207 的 M3 用变异**反驳了派工简报的一半：简报要求「给滚动段加数量上限」，
  它把朴素上限加上去 ⇒ **7 条红**，因为那会删历史，直接违反 `docs/data-files.md` 的
  「代际递增、从不覆盖旧段」。**它拒绝照字面执行，并顶了回来——这是对的。**
- **W9205 的变异 5 是「过度修复的负控制」**：证明新参数不是死代码
  （不加参数、直接不修剪，会把超长日志行的合法切痕误报成损坏）。
- **W9203 的 M4 第一次是绿的，它没有放过**——查下去发现是**自己的断言恒真**
  （`includes('重新')` 被同 fixture 的 `'重新载入'` 子串命中），换成互不为子串的词后如期变红。
  **一个恒真的断言看起来和好断言一模一样**——这就是变异负控制存在的理由。

### 2.6 其它本轮落成的机械门禁

| 门禁 | 钉住什么 | 位置 |
| --- | --- | --- |
| 契约里的数字必须**从真源派生** | 散文里的计数不得手写 | `tests/contracts.test.ts:460` |
| 终态集合必须是**可断言面** | 契约里的 phase 集合改动时测试必红 | `apps/web/src/chat.ts:83` |
| 文档不变量 | 登记 / 状态闭集 / 链接与锚点（含**区间端点与逗号列表**）/ ≤700 行 / 无本机事实 / 归档横幅 / 分册可达 / 仓内路径必须存在 / 散文里的计数必须派生 | `tests/doc-conventions.test.ts` |
| `docs/README.md` 的端点数字 | 第四处契约数字（根 README 早有门禁） | `tests/readme-claims.test.ts:38` |
| 哨兵不得从数据推断能力 | 能力是布尔字段，不是字符串匹配 | `packages/tools/src/guard/path-guard.ts:255` |

### 2.7 「门禁红，但红在别人的在飞改动里」——怎么自证

**这是 10 路并行修复的常态，不是意外**：本轮 10 份修复报告里，
**8 份**都记录过「`pnpm check:fast` 红，但红的是别的 worker 的在飞文件」
（W9201 / W9202 / W9204 / W9205 / W9206 / W9207 / W9208 / W9209 都有这一节）。
典型的形态是：`pnpm typecheck` 报 5–12 条错误，逐条核对后**全部**落在
`apps/studio/src/runtime/fallback-host.ts`、`apps/studio/src/app.ts`、
`apps/studio/src/server.ts` 这类**别人正在改**的文件里。

**共同根因**：所有 worker 共享**同一个工作树**。任何人的未提交改动都会立刻成为
别人的门禁输入——包括「删掉一行未使用的导入」这种**看起来零影响**的改动，
它会**位移后续所有行号**，从而让别人的文档锚点（`file:line`）落到空行上。

**判据（可机械执行，不需要读懂别人的代码）**：

1. **按自己的文件名过滤**：`pnpm typecheck 2>&1 | Select-String '<我的文件>'` ⇒ 空；
   W9202 把它写成了 `MY_FILE_ERRORS_COUNT = 0` / `MY_ESLINT_HITS = 0` 两个可复述的动作。
   **这是唯一稳定的动作**——错误总数会随同伴的每次保存浮动
   （W9202 实测同一轮里先后看到 8 条 → 5 条 → 0 条，派工者同时实测 7 条）。
2. **HEAD vs 工作树**：`git show HEAD:<file>` 与工作树逐行比对。
   本轮真实一例：`scripts/export-golden.ts` 被删掉一行导入（`projectMessages,`），
   于是该文件**从第 30 行起整体上移一行**，而 `docs/feature-multimodal-attachments/02-design.md`
   里那条指向它的锚点当场落到了空行上（`tests/doc-conventions.test.ts` 的 ③b 报的正是它）——
   **该锚点在 HEAD 上是对的，只在未提交的工作树上不成立**。
   （这里**刻意不写出具体的 `file:line`**：那个行号此刻正在漂，写死会让本文自己也过不了 ③b。）
3. **隔离复现**：把红的那一条判据**只对自己的文件**跑一遍。
   上面那例里，把 `anchorProblems()` 只对本文跑 ⇒ 0 条问题。
4. **决定性隔离（最强）**：把自己的改动**临时还原**再跑同一个文件。
   W9205 用这招证明 `composition-root.test.ts` 的失败在它改动**之前**就存在。

**正确的处置**：

- **不去改别人的文件**——哪怕只是「顺手对齐一个行号」。那会与正在跑的人直接冲突，
  而且锚点漂移是**他们的改动**造成的，应当由**改那个文件的人**一起修（「改引用路径」的纪律）；
- **不把红说成绿**，也不把绿说成红——附上判据与命令，让派工者一眼看出该派给谁；
- **收口由派工者做**：按 [`AGENT.md`](./AGENT.md) 铁律 7，全量 `pnpm check` 在**所有 worker 停写之后**跑，
  那才是真正的基线。

**可迁移的教训**：**「门禁红」不等于「我错了」；但「我说它绿」也不等于证据。**
自证清白靠**隔离 + 指出位移来源**，而不是靠「我这边没问题」这句自述
——那正是本轮 §1.5 那个失效模式的另一种形态。

---

## 3. 仍未解决的（诚实清单，不是待办粉饰）

### 3.1 P2 / P3 基本原样留着

上表里 **P2 147 条 + P3 95 条 = 232 条**（自述相加）**没有被本轮修复**——
修复轮只领了各格 P0/P1 的一个子集。这不是遗漏，是范围纪律：
一次修 232 条会变成无法审查的大提交。**但也不要以为「审计过了 = 修过了」**。

### 3.2 端点数仍有多处手工同步（进行中）

同一个「端点总数」散在至少四处，改一个端点要同时改它们：

- `contracts/endpoints.json` 的 `count`（现 70）；
- `contracts/route-table.snapshot.json:404` 的 `tsApiEndpoints`（现 70）；
- `packages/core/src/contracts/index.ts:178` 的 `FROZEN_COUNTS.endpoints`（现 70）；
- `apps/studio/src/routes.ts:64` 的 `API_ENDPOINT_COUNT`（现 70）。

`docs/README.md:35` 的「70 端点」已被 `tests/readme-claims.test.ts:38` 机械钉住（那是第五处，但有门禁）。
**W9301 正在处理这件事**（把它收敛成一个真源），**进行中**——写作时工作树与 `results/` 里
还没有它的产出，因为它**尚未落盘**。**在它落地之前，改端点请把四处一起改。**

### 3.3 `apps/web/src/styles/theme-claude.css` 的深色块 **不是**缺陷——不要「顺手统一」

这条要写清楚，免得后人误改：

- 本仓主题的机制是 **`<html data-theme>` 单属性**（`apps/web/src/theme.ts:2` 明写）。
- **claude 主题自带深浅两套**：它只有一个 `data-theme="claude"` id，
  深色由**系统** `prefers-color-scheme` 选择（`apps/web/src/theme.ts:22` 明写）。
- 所以 `apps/web/src/styles/theme-claude.css:98` 的 `@media (prefers-color-scheme: dark)`
  是 **claude 主题自己的**深浅开关，**不是**「用错钥匙」。

**真正的同类缺陷在别处**：`--mi-*` 模型图标色曾挂在同一把钥匙上，
于是「系统深色 + 默认 mono 主题」会拿亮色图标画在白底上（12/12 个家族低于 3:1）。
那条已修（`apps/web/src/styles/statusline.css:315` 的注释记录了更正与理由）。

**判据**：图标必须跟**主题**同一把钥匙。claude 的钥匙**就是** `prefers-color-scheme`——
把它的深浅也改成 `[data-theme]` 等于改掉 claude 主题的配色语义（那是设计变更，不是修 bug）。

### 3.4 其它已登记、未修的具体项

- `contracts/endpoints.json:268` 的 `get_events` note 仍写「Event names (8)」，
  而 `contracts/sse-events.json` 有 **10** 个（`count` 与 `events[]` 都是 10，多出 `question` / `terminal`）。
  W9209 的报告把它标为 F-03 并建议由持有 `sse-events.json` 的同伴一并修，**本轮未修**。
- `apps/studio/src/store/workspaces.ts:15` 有一个未使用的导入 `renameSync`。
  **这条比「一个没用的导入」值钱**：它证明本仓的 lint 原先**没有**启用 `no-unused-vars`——
  `renameSync` 能一直通过 `pnpm lint`，不是「规则被破坏」，而是「根本没有这条规则」。

  **写作时的在飞状态（未提交，我无法确认最终口径）**：工作树里有一份未提交的 `eslint.config.js`
  新增了 `@typescript-eslint/no-unused-vars`（注释自称「W9214」），并配了一份未提交的
  `eslint-suppressions.json`——用 ESLint 的**批量抑制**把**存量**违规全部基线化，
  `apps/studio/src/store/workspaces.ts` 的 `renameSync` 正在其中（`count: 1`）。

  **这正是本文 §2 那类判断的一个活例子**：新增门禁若把存量一次性 suppress 掉，
  门禁就是**真的**在守新代码，而存量债务被如实记账（而不是被「顺手修掉」掩盖成「本来就没问题」）。
  但它也意味着**抑制不是修复**：被 suppress 的那条 `renameSync` 仍在源码里。
  写作时 `pnpm check:fast` 是绿的，且 `npx eslint apps/studio/src/store/workspaces.ts`
  退出码 0、`errorCount: 0`，只在 `suppressedMessages` 里报它。
  另有一批 `.w9214-*` 探测产物未清理（未跟踪）。**这些都不是本轮的产物，未核实其最终去向。**
- 上一轮引入、本轮才被独立发现并修掉的三条（哨兵碰撞 / `fromEnv` 漏传 / retry 死旋钮）
  说明这个节奏是结构性的：**同一批人同一轮里既写又审，上一轮的改动要等下一轮才被真正检验。**

## 4. 数字与说法的核实状态

写作本文时，以下条目**我找不到可核实的出处**，或**没有独立复现**。
**能核实的已核实（第 1 条），核实不了的如实留下（第 2 条起）**——这个「留下」的形式本身有价值。

### 4.1 ✅ 已核实：「334 条发现」—— 逐份推导表

**结论：334 正确。** 我最初的 317 是**一处加总疏漏**（见下），现已改正。

| 报告 | P0 | P1 | P2 | P3 | 小计 |
| --- | --- | --- | --- | --- | --- |
| W9201 消息渲染管线 | 1 | 11 | 10 | 5 | 27 |
| W9202 配置与提供商页 | 0 | 5 | 13 | 15 | 33 |
| W9203 样式与 i18n | 0 | 9 | 13 | 8 | 30 |
| W9204 交互层 | 0 | 4 | 21 | 13 | 38 |
| W9205 tools 包 | 2 | 5 | 26 | 23 | 56 |
| W9206 studio 后端 | 6 | 24 | 18 | 1 | 49 |
| W9207 runtime / workers | 1 | 7 | 14 | 6 | 28 |
| W9208 core / llm / agent-loop | 0 | 6 | 12 | 11 | 29 |
| W9209 契约与数据流 | 0 | 2 | 12 | 10 | 24 |
| W9210 权限与沙箱链 | 3 | 8 | 6 | 3 | 20 |
| **合计** | **13** | **81** | **145** | **95** | **334** |

**我最初的 317 错在哪**：我把 **W9206 记成了 `3/18/10/1 = 32`**（那是它结论表里能直接读到的那一段），
而真实值是 **`6/24/18/1 = 49`**。差额 17 条。**我当时的「差额 21 条无法核实」是一个错误的自我怀疑**——
问题不是总数对不上，而是我读的**那一份报告的表不是全集**。

**为什么我读不到 49（这才是真正的缺口）**：
`results/W9206-studio后端.md` 与 `results/W9210-权限沙箱链.md` **都没有自述总数**。
W9206 的结论表只列到 `W9206-34`，但它的正文与 `results/VERIFIED.md` 还引用了
`W9206-35 / 36 / 37 / 43`——**编号超出那张表**，说明表是「第一轮 + 部分第二轮」，不是全集。
W9210 同理（报告按 F1…F20 逐条写，没有合计行）。
**这两个数字（49 与 20）只出现在它们发给派工者的回执消息里，不在仓内。**

**⇒ 给未来审计者的要求（这是本节的产出，不是抱怨）**：
**每份审计报告都必须在正文里写出自己的严重度合计**，否则外部复核者只能读到「表格里那一段」，
并把它误当成全集——**我的 317 就是这么来的**。
没有合计行的报告，对复核者是一个**陷阱**，而不是一个缺口。

### 4.2 仍未核实（保留这一节的形式）

1. **「CI 四绿」**：我无法从这里读取 CI 结论（本机没有可用的 CI 查询通道），
   因此「四个 job 全绿」我**未核实**。派工者确认他那边能看到（分支与 tag 各一轮、四 job 全绿），
   但**我的保守标注是对的**——复核者不能把「别人说他看到了」当成自己核实过。
2. **各修复报告里的实测数字**（如 `events()` 的 ~331× / ~490× 提升、模型图标对比度 1.64:1、
   最长帧 83ms、`rail` 建列 200 列的计数 stub）——我**只转述，未独立复现**。
3. **W9206 的三条安全 P0**（跨站 RCE / 进程崩溃 / 授权自授）：复核记录写明是**代码级确证**，
   端到端 exploit **没有重跑**。
4. **「10 路并行修复」**：`results/` 里有 10 份 `W92xx-修复.md`（W9201–W9210），
   但这只能证明**有 10 份报告**，不能证明它们真的并行。

---

## 5. 给未来贡献者的一页速查

| 失效模式 | 一句话判据 | 已落成的门禁 |
| --- | --- | --- |
| 测试固化错误行为 | 修复让断言变红时，先问它描述的是**规格**还是**当时的实现** | 契约数字必须从真源派生（`tests/contracts.test.ts:460`）；mock 不得「什么都说成功」 |
| 注释描述不存在的状态 | 注释只能写「代码现在真的做什么」 | 靠 review；报告里逐条核对 |
| 本地绿、CI 红 | 涉及路径/大小写/执行位/换行时，**平台是参数** | `packages/tools/src/platform/paths.ts` 的 `isWindows`/`pathApi`；CI ubuntu + windows 双跑 |
| 验证了机制没验证输入面 | 每个哨兵都要有一条「它与合法数据相等时会怎样」的测试 | 能力是布尔字段、哨兵只看声明列表（`packages/tools/src/guard/path-guard.ts:255`） |
| 声称做了但没做 | 写「谁修了 X」之前先跑 `git show --stat`；读到时先假设那是**转述** | 无（只能靠复核纪律） |
| 门禁红了但说不出为什么 | 失败原因必须进 annotation，且**先写、另起一行** | `scripts/run-gate.mjs`；`.github/workflows/ci.yml:66` |
| 平台噪声被当成回归 | 容差必须**写明理由**，且超限要**如实打印** | `apps/web/tools/check-bundle-size.mjs:54` |

**本文刻意没做什么**（范围纪律）：

- **没有**把 `results/` 里的报告写成 Markdown 链接——那在干净检出里是死链（断言 ③ 会红）；
- **没有**动 `apps/web/src/styles/theme-claude.css` 的深色块（它不是缺陷，见 §3.3）；
- **没有**在发现「334 vs 我的 317」后草率地改写总数——先做了逐份推导表（§4.1），
  确认**是我读的表不是全集**，才把 334 写成事实；
- **没有**把「W9113 声称修了 rail」照抄成 W9113 的问题——核实后发现那是**派工者的转述有误**（§1.5）；
- **没有**把「P2/P3 未修」写成「已排期」——它只是**未修**。
