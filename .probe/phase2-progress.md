# Phase 2 收尾 · 进度快照（E2E 探针阶段）

更新时间：2026-10-01。执行者：Phase 2 收尾子代理（父 session-98fa2750-3215-4ae5-8934-311f577db62f）。

## 已完成（有证据）
1. **门禁全绿**：`pnpm typecheck` / `pnpm lint` / `pnpm lint:arch` 全部 exit 0（`✔ no dependency violations found (852 modules, 3446 dependencies cruised)`）。修红前 red：typecheck 6 错 / lint 10 错 / lint:arch 1 错（tier1-no-peer-deps-tools）。
2. **全量 vitest**（`.probe/vitest-run2.json`）：3525 tests，passed 3339，failed 21，pending 165。21 个失败**全部**为沙箱环境类（piped-stdio spawn EPERM → 子进程起不来），非 Phase 2 回归；5 个 suite 级 spawn EPERM；forks 池 3 文件起不来。命令需先清 CELESTEA_* 环境泄漏并带 shim：`$env:NODE_OPTIONS='--require <repo>\.probe\shim\no-net-use.cjs'`。
3. **夹具 CRLF 重规范化**：33 个 fixtures 文件逐字节 CRLF→LF，git 内容零差异（`git diff --exit-code --quiet -- fixtures` exit 0；hash 与 index 一致），再用 `git update-index --refresh -- <逐个文件>` 清 stat 缓存 → 工作树干净，parity.test.ts 全绿。
4. **规范符合性核对**：10 条逐条过，全部符合，无需改代码（哲学并入 AgentConfig 构造链 agent-config.ts:50-51；nudge 瞬时 loop.ts:307/311；0.8 preflight 复用 status.ts:450 contextUsage；validateRange 硬校验；kill-switch；块 schema 五字段；叠层落点在 engine-session.ts:143-150；工具面 + 契约；dedup ③ 自愈测试；Phase 1/dedup/compactSession 语义未动）。
5. **设计文档回写**：docs/feature-memory-extraction.md 的 Phase 2 小节已改写（E1 标题+导语、E2 自研清单表落点写死、E3 复用既有件、E4 新增「动工修订六条 / 压缩的触发经济学 / 水位与触发 / 压缩块 schema / 实现分解六层表 / env 开关表 / 测试矩阵表 / 已知边界」、E5 compactSession 注、E6 §5 接缝注、E7 §6 五行状态）；另修 docs/README.md 地图状态行、docs/modes-standard-vs-execution.md:54 与 docs/feature-dynamic-tool-disclosure.md:184 两处锚点漂移。`pnpm exec vitest run tests/doc-conventions.test.ts` → 13/13 passed。完整 diff 已存 **.probe/phase2-docs.diff**（25623 字节，含 docs/README.md 等 4 个文件）。

## 进行中：E2E 探针（第 4 项交付物）
目标：隔离数据根 → 真实会话 → compress → 断言视图替换 / 水位下降 / 缓存指标。

已探明的环境事实（关键，接任者必读）：
- **沙箱禁止写工作区之外**：`New-Item/Set-Content D:\celestea-probe\...` → `Access to the path ... is denied`（连已存在的 ws-baseline 也拒绝）。→ 隔离数据根改用**仓内** `D:\VSCProject\Celestea-Agent\.probe\p2-e2e-root`（已创建，未入库）。
- **tsx 不可用**：`pnpm exec tsx ...` → esbuild `ensureServiceIsRunning` → `Error: spawn EPERM`（errno -4048）。→ 不能 `pnpm start` 起真服务器；改用 **vitest 进程内起真服务器**（`createStudioApp`/`startStudioServer` 默认就是 real runtime，见 apps/studio/src/app.ts:274 `defaultRuntime`）。
- **网络与配额正常**：直连 `https://api.r4.codes/v1/chat/completions`（providers.json 第 0 条 r4codes，model deepseek-v4-flash）→ HTTP 200，usage 正常返回。模型是 reasoning 模型（返回 reasoning_content），max_tokens 要给足。
- 真实数据根 `D:\celestea-data` 里有 providers.json（r4codes 1M 窗口 / accspark 131072 窗口）、workspaces.json（ws-baseline）、usage-ledger.jsonl；**没有** prompts.json（CELESTEA_PROMPTS_FILE 指向的文件不存在，用内置默认即可）。
- 会话目录布局：`<CELESTEA_HOME>\workspaces\<wsid>\sessions\<session-id>\cli-main.jsonl`（见 .probe/drive-0b.mjs）。
- 可观测面：`GET /api/status?session=<id>` → `context_usage{used,window,ratio,method}` + `compression{enabled,blocks,ranges,last_ratio}`；`GET /api/sessions/{id}/context` → `{system,tools,messages,message_count,context{...}}`（**模型可见视图**，用于断言视图替换）；`/api/usage/ledger` 或 `usage-ledger.jsonl` → 每步 prompt_tokens/cache_read（缓存指标）。

## 下一步（按序）
1. 写 `.probe/p2-e2e/vitest.config.ts`（复制仓根 alias 8 条 + include 仅本目录 + 长 timeout）与 `.probe/p2-e2e/probe.test.ts`：起真服务器（port 0）→ 建会话（workspace p2-ws，model deepseek-v4-flash）→ 5 轮带填充文本的预热轮 → 抓 context/status 基线 → 第 6 轮让模型调 compress(1,5) → 断言 compression.json 侧车、cli-main.jsonl 原文仍在、视图被替换、水位下降、缓存指标 → 再让模型 decompress 验证可逆。
2. 若真实通道受阻：如实报告，退化为确定性进程内探针（真栈 + 直接调 compress 工具），不伪造。
3. 收尾：`git status` 复核无意外文件；回报父代理（改动清单：沿用/修复/新写 + 门禁输出尾部 + 文档 diff 全文 + E2E 结果 + 环境限制 + 遗留问题）。

## 终审收尾（父代理 R8 兜底执行，2026-10-01 收官）
1. **缺陷 #1 已修**：packages/runtime/src/compression-host.ts portOf 硬编码 `usage: () => null` → 改 `portOf(log, usage)` 把 statusUsageFactsOf 接进 port；新增 packages/runtime/src/compression-host.test.ts（4 例回归）。
2. **E2E 探针全绿**（.probe/p2-e2e/probe.test.ts，真 r4.codes/deepseek-v4-flash 通道，2/2 过）：哲学并入 system、三工具挂载、5 轮预热基线 used=10758（method=usage_prompt_tokens）→ 模型自主 compress(1,4) → compression.json 侧车块 context_ratio=0.0103（缺陷#1 修复的真实数据验证）、cli-main.jsonl 原文未动、视图替换为 `[compressed turns 1-4]`、水位 10758→10445 → 模型 decompress 恢复原文、blocks 归零；kill-switch=off 时哲学/工具/状态全隐。
3. **探针过程发现**：turn id 是 0-based（热身轮 i=1..5 → turn-0..4），in-flight 轮被 validateRange 正确拒绝（模型收到 current_turn 拒绝后能解释原因）；模型会自主收窄范围（指令 0..4 实际压 1..4）——探针断言按模型实际写入的块做。
4. **环境教训**：vitest --config 的 root 默认是 cwd 而非配置所在目录（须在配置里显式 `root: r(".")`，否则 include 匹配全仓）；会话存储层有读 process.env 的路径，探针须清壳环境泄漏的 CELESTEA_* 才能让 CELESTEA_HOME 生效；CELESTEA_PROVIDERS_FILE 可跨目录引用已暂存的 providers.json。
5. 一次误跑全量 vitest（root 未固定，421 文件 / 175 失败）全部为 spawn EPERM 环境类，非回归。

## 红线提醒（接任者）
不改 max-lines 门禁；不加依赖；不动 .gitignore 的 /AGENTS.md；`.probe/` 不入库；探针产物留在 `.probe/`。