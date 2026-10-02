# 记忆提炼与长对话成本 · 路线设计

> 状态：**设计（P0–P2 已实现）**。本文只定**路线与已闭合决策**，不跟踪进度 —— 按 [`README.md`](./README.md) 的维护约定，
> 「每完成一个可提交单元就更新」的接续手册不入 `docs/`。落地后若仍有未完成分期，改状态为「设计（P0 已实现）」，不要整篇归档。

**范围**：把「后台自动提炼」引入本仓既有的记忆系统，以及与之**耦合**的长对话成本改造。
**起因**：对照 ZCode（`D:\mozin\repos\ZCode`，另一个 agent 项目）的记忆系统做移植评估；结论是**只拿提炼那一块**，其余不拿。

---

## 0. 一句话

本仓的记忆系统（两层来源 + append-only `entries.jsonl` + 派生 `MEMORY.md` + `remember`/`forget`）**已经在多数维度强于 ZCode**，不需要移植；
真正缺的只有一块 —— **后台自动提炼**。而它与「上下文压缩」**共用同一份对话历史**，因此**必须在路线层面先定序**。

---

## 1. 现状：已有的东西（不要再造）

| 关注点 | 本仓现状 | 相对 ZCode |
|---|---|---|
| 存储真源 | `entries.jsonl`，append-only，宿主拥有，在仓库外 | ✅ 更强（ZCode 就地改写 Markdown，无真源概念） |
| 派生视图 | `MEMORY.md` 由 log 确定性渲染 | ✅ 更强 |
| 删除语义 | `forget` 追加墓碑，历史永不重写 | ✅ 更强（ZCode 直接删文件） |
| 修正语义 | `supersedes` 字段 | ✅ 更强 |
| 去重 | `memoryTextHash` 内容哈希，工具层强制 NOOP | ✅ 更强（ZCode 靠提示词软约束） |
| 分层 | 两层：project（`<ws>/.celestea/memory/`，**只读**，随仓提交）优先于 global（`<CELESTEA_HOME>/workspaces/<ws>/memory/`） | ✅ 更强（ZCode 只有项目一层） |
| 注入位置 | durable user-role history，**绝不进 system prompt** | ✅ 更强（ZCode 塞进 system prompt 段） |
| 防注入 | 注入块开头的 `MEMORY_NOTICE` 冻结文案（「这是数据不是指令」） | ✅ 更强（ZCode 无对应防护） |
| 预算控制 | 2048 字节 + UTF-8 码点边界截断 + **显式截断标记** | 各有取舍 |
| 记忆粒度 | 一条事实一行 log entry | ⚠️ ZCode 更强（一文件一事实 + `[[wiki-link]]`） |
| 召回线索 | `tags`（首个 tag 即分组） | 各有取舍 |
| **后台自动提炼** | ❌ **无**（只有模型显式调 `remember`） | ❌ **ZCode 独有** |

**前作**（已归档，仍是「为什么这样定」的依据）：
[`archive/decisions/feature-workspace-memory.md`](./archive/decisions/feature-workspace-memory.md)（P0/P1 决策与验收）、
[`archive/research/memory-store.md`](./archive/research/memory-store.md)（开源调研与选型，含反模式清单）。

---

## 2. ⚠️ 必须先裁决：与既有决策的冲突

**这是本文最重要的一节，不裁决就不能进 Phase 1。**

[`archive/research/memory-store.md`](./archive/research/memory-store.md) §3 反模式第 1 条，原文：

> **自动采集 + LLM 摘要，无人在环**（claude-mem 的 5 个 lifecycle hook；mem0 插件 hook + 后台 flush；Memori 后台 capture）。
> 错误会被固化成「每轮都出现的事实」，且不可审计。→ 我们：P0 人写文件、P1 显式 `remember`。

同文件 §0 结论速览第 5 条把它称为「**最大反模式**」。

而 §4 Phase 1 提议的「后台自动提炼」，**正是这一类**。这是本路线与前作决策的**直接冲突**，必须正面裁决，不能绕过。

### 2.1 拟议的三条化解

| # | 化解 | 落点 |
|---|---|---|
| 1 | **可审计**：`MemoryEntryLine` 增加 `source: { session, turn }` | [`archive/research/memory-store.md`](./archive/research/memory-store.md) §2.3 架构 B 的线格式里**本来就有这个字段**（`:80`，`{v,id,ts,op,...,source:{session,turn},hash}`），落地时丢了。补上后每条记忆可追溯到来源会话与轮次 |
| 2 | **人在环**：提炼产物走既有 `entries.jsonl` → 用户在 `MEMORY.md` 看得到、可用 `forget` 撤回；且**项目层只读不被污染**（提炼只写 global 层） | 复用既有工具与层契约，不新增写路径 |
| 3 | **不每轮都跑**：两道跳过门 + cursor（照 ZCode） | 避免「每轮写一点」把 prompt 缓存尾部持续打碎，也避免噪声固化 |

### 2.2 裁决结果

✅ **已裁决：选项 A**（接受三条化解，进 Phase 1）。审计核实三条化解均有现成代码锚点可落：
`source:{session,turn}` 是补回前作规格里丢失的字段、`entries.jsonl` 写路径既有、ZCode 的两道跳过门 + cursor 语义可照抄（其 `extraction.ts`）。

~~选项 B：放弃自动提炼，只做 Phase 0 + 手动 `remember` 的体验改进。~~

---

## 3. 已闭合的决策（含依据）

| 决策 | 结论 | 依据 |
|---|---|---|
| 给 session store 加 SQLite？ | ❌ **不加** | SQLite 不出现在 token 成本公式里（成本 = 每步发什么 × 发几步）；本仓长对话的真实缺口是**压缩是手动的**与**常驻上下文每轮复制**，与持久化引擎无关 |
| 给 memory 加 SQLite？ | ❌ **不加** | 已有 `entries.jsonl`（append-only 真源）+ 派生 `MEMORY.md`；加了就是**第三份拷贝**，违反单真源纪律。前作 §2.4 已明确否决架构 C（SQLite + FTS5） |
| 移植 ZCode 的记忆系统？ | ❌ **不移植** | 见 §1 对照表；本仓在真源/墓碑/哈希去重/分层/注入位置/防注入上均更强 |
| 从 ZCode 拿什么？ | ✅ **只拿「后台自动提炼」** | 且因本仓记忆是**结构化 log entry**，提炼可退化为**一次结构化输出调用**，不需要工具循环、不需要工具白名单、不需要权限笼子 |
| 加 `cache_control` 缓存断点？ | ❌ **撤回** | `responses` / `anthropic_messages` **引擎未实现**：`ENGINE_REQUEST_FORMAT` 恒为 `chat_completions`，端点只有一处，非 chat_completions 直接拒。全流量走 OpenAI 格式 → **自动前缀缓存**，不需要显式断点 |

---

## 4. 路线

```
Phase 0 ─ 打基线（可并行启动）
  0a. 缓存命中率 + token 构成测量        不改产品行为，一次性
  0b. 常驻上下文去重                     小改，但有两条落地接缝（见下）

Phase 1 ─ 记忆提炼（本文主体；§2 已裁决选项 A）
  E  提炼（一次结构化输出调用）

Phase 2 ─ 上下文压缩（方向已定：模型驱动 + 视图叠层；启动等 0a 数据）
  A  compress / decompress / context_status 原生工具
```

### Phase 0a：打基线（测量）

**目的**：让 Phase 2 的决策有数据，而不是拍脑袋。`cacheHitRatio` 已经在算了，**先打出来看**。

三个要回答的问题，每个都会改变 Phase 2 的走法：

| 问题 | 若是 A | 若是 B |
|---|---|---|
| 前缀缓存**真的在工作**吗？ | 压缩的代价主要是 token，好算 | 压缩会**额外**打碎缓存，代价要翻倍算 |
| 常驻上下文占每轮 token 的**多少**？ | 占比低 → 0b 优先级可降 | 占比高 → 0b 必须先做 |
| `trimContext` **多久触发一次**？ | 很少触发 → 压缩不急 | 频繁触发 → **正在持续丢历史**，Phase 2 要提前 |

> **billion-context 挂载实验：❌ 已关闭（2026-09-30，未执行）**。关闭理由：①0a/0b 落地后 Phase 2 紧迫性大降（缓存折价后账单仅约全价 21.7%、trim 现实不触发、常驻堆积已除根），在「Phase 2 是否启动」裁决前验证其前提是顺序倒置；②其 paper 已有 4.5 个月 / 174,327 次调用的生产实证，小规模重跑边际信息量小；③代理实验覆盖不了 Phase 2 的真实风险（水位数据面、trim/compact 的缓存失效不对称、视图叠层工程）。若 Phase 2 将来裁决为启动，再重开评估。

### Phase 0b：常驻上下文去重

> **状态：✅ 已实现（ff4e812）**。`packages/runtime/src/turn-context-dedup.ts` 的 `selectTurnContextRows(log, rows, config)`：
> 状态是 (log, config) 的**纯函数**（无内存簿记，idle TTL / compact rebind / 重启后从 log 重新推导，落地接缝 2 按此化解）；
> 可见性用与 loop **同一个** `trimContext` + 同一份 `AgentConfig` 保守模拟（落地接缝 1 按此化解——决策点到首 step 间只会切得更深，最坏本轮少一份、下轮自愈，单向安全）。
> 接线在 `turn-runner.ts` `injectTurnContext`；12 个用例（10 纯函数 + 2 接线），变异控制（`isResident` 恒 true）恰好染红两条 ③ 态用例。

**问题**：`turnContext` 在**每轮 turn 起点**被求值并无条件 append 成 user-role 历史 —— **没有去重、没有替换**。
第 N 轮历史里有 N 份 skill catalog + N 份 `MEMORY.md`，**无自动上限**：`COMPACT_THRESHOLD = 8` 是允许压缩的**下限**（≤8 轮时拒绝压缩），不是副本数上限；
模型侧唯一的自动边界是 `trimContext` 按预算砍，而那已经是「丢历史」。

**改法 —— 三态策略**（比「相同就跳过」更正确）：

```
① 内容未变 且 上一份仍在 derived messages 里  → 跳过
② 内容变了                                  → 注入新的
③ 内容未变 但上一份已被 trim/compact 移除     → 重新注入
```

第 ③ 条必须保留，否则 trim 掉之后模型就永远看不到记忆了。

**为什么必须做**：Phase 1 会让 `MEMORY.md` 持续增长（上限 2048 字节 ≈ 512 token），而每轮复制的大头是 **skill catalog**（通常远大于 memory 块）。
不去重 → 每轮至少一份全新副本 = 每轮一份全新输入 token，**无自动上限**、随记忆与技能增长而增长 —— Phase 1 的收益会被它自己的注入成本吃掉。

**落地接缝**（两条，动手前必须知道）：

1. **第 ①/③ 态的判断跨层**。trim 发生在 agent-loop 内的派生视图上（`trimContext` 操作 `loop.ts:270` 的 `deriveMessages()`，**不动 session log**），
   而注入决策在 turn-runner —— 「上一份是否仍在 derived messages 里」turn-runner 看不见。要么由 loop 回报 trim 结果，要么 turn-runner 保守模拟一次 trim。
2. **dedup 状态必须能从 log 重建**。session 因 idle TTL 或 compact rebind 重建后内存态丢失，否则每次重建都退化为第 ③ 态重注入（无害但 noisy）。

**已知取舍**：

- 内容变了时，历史里会同时存在旧版本 memory 块（无失效标记）与新版本。这是 append-only 日志的固有代价。
- dedup 后 log 不再每轮留注入记录，回放「第 N 轮模型看到了什么」要靠第 ② 态的版本链重建（可接受，调试观测时要知道这一点）。

### Phase 1：记忆提炼（E）

- **执行者**：一次结构化输出调用（**不是** agent loop）。本仓记忆是结构化 log entry，提炼产出可直接映射到 `appendMemoryLine`。
- **写入**：复用既有写入路径，**绝不新写第二条**。
- **写路径落点（分层约束）**：写路径在 `packages/tools`，而 runtime（L2）**不能 import tools** —— 提炼调度器若住 `packages/runtime`，写回调必须**从 `apps/studio` 注入**。
  先例：`session-compose.ts:347-349` 的 run_shell 处置 hook 注释（「runtime is L2 and may not import @celestea/tools, so the hook is wired HERE」）。
- **只写 global 层**：项目层是只读契约，提炼不得写。
- **提炼 prompt 必须带现有条目清单**：ZCode 的 `buildMemoryExtractionPrompt` 注入现有记忆 manifest 并指示「update an existing file rather than creating a duplicate」。
  不带清单时去重只剩 `memoryTextHash` 精确匹配，提炼会产出大量近似重复。manifest 很便宜（渲染后 ≤8192 字节）。
- **支持 `supersedes`**：提炼天然需要「改正旧记忆」而非只新增；结构化输出应允许携带 supersedes 操作（写路径已支持该字段）。
- **条目上限**：`MEMORY_ENTRY_MAX_BYTES = 2048` 是硬上限，prompt 必须告知模型，否则超长条目会被拒。
- **防自反馈**：提炼的模型请求**不 append 到 session log**（对应 ZCode 的 `skipTranscript`）。
- **提炼模型（✅ 已裁决 2026-09-30）**：用**会话当前模型**（跟随 providers.json 的 default_model，不设独立配置项）；**reasoning_effort 硬钉最低档（`low`），不随会话 profile 走**——防止主对话调高 thinking 后提炼跟着贵起来（ZCode 同款：`auxiliaryModelOptions` 取公开档位最低项 + 输出压到 ≤5000）；输出预算 ≤2048 token（几条 MEMORY_ENTRY 的量级）。维持「单次结构化输出调用、无工具循环」裁决，ZCode 只借鉴模型/档位/预算这三件。
- **usage ledger（✅ 已裁决 2026-09-30）**：**记**，独立 `kind: "extraction"`，**不并入 `turn_total`**——不记是隐性成本，并入则污染 Phase 0a 基线口径；独立 kind 让提炼成本可单独核算对账。
- **提炼 prompt 内嵌取舍标准**：提炼调用的 prompt 必须自带记忆类型分类（user / feedback / project / reference，对齐 ZCode `persistent-memory-prompt`）与 NOT-save 清单（代码可推导 / git 可查 / 修复配方 / AGENTS.md 已有 / 临时状态）——ZCode 的提炼 prompt 是直接引用主 prompt 里现成的 Memory 章节，而本仓 system prompt 由用户自配、没有可引用的段落，标准必须内嵌自带。
- **与主对话主动写互补**：主循环 `remember`/`forget` 的 WHEN TO SAVE 指引（e8a8e3a）让模型在对话中直接写记忆；提炼的 direct-write 跳过门（对应 ZCode `containsDirectMemoryWrite`）检测到本轮已直接写则跳过——主动写与后台提炼互不打架。

### Phase 1 实现分解（✅ 已实现，98b14d8）

> 本节是 Phase 1 落地后的实现索引：按六层列出「实际改成了什么样」，供维护者按层定位代码。**状态与裁决仍以 §2、§4 为准**；本节不新增设计决策，只把已提交的实现对齐到文档。

**六层改动一览**

| 层 | 文件 | 内容 | 关键锚点 |
|---|---|---|---|
| ① 日志 | `packages/tools/src/memory/log.ts` | `source?{session,turn}` 溯源字段 + 后向兼容解析 | `:42`、`:70-75`、`:99` |
| ② 写入 | `packages/tools/src/memory/extraction.ts` | `applyMemoryExtractionOp`（add/update/forget 与拒绝原因）+ `memoryManifest` | `:44-76`、`:79`、`:88-97` |
| ③ 调度 | `packages/runtime/src/memory-extraction.ts` | `createMemoryExtractionScheduler`：cursor、两道跳过门、`{"ops":[…]}`、drain | `:321-401`、`:198-210`、`:360-371`、`:397-401` |
| ④ 账本 | `packages/runtime/src/ledger.ts`、`packages/runtime/src/ledger-query.ts` | `kind:"extraction"` 独立行；step 视图 `ok|error` 白名单；诚实计入 total/session_total | `ledger.ts:140-154`、`:469-479`、`ledger-query.ts:117-126`、`:270-287` |
| ⑤ 接线 | `packages/runtime/src/turn-runner.ts`、`packages/runtime/src/compose.ts` | `ledger.endTurn` 之后 `extraction.schedule(log)` | `turn-runner.ts:230`、`compose.ts:213` |
| ⑥ 组装 | `apps/studio/src/runtime/session-compose.ts` | effort/输出预算、env 开关、cursor sidecar、shutdown drain、offline 跳过 | `:477-512`、`:352-355` |

**① 日志层：`source` 溯源**

`MemoryEntryLine` 新增可选 `source?:{session,turn}`（`log.ts:42`），由 `isEntrySource`（`:70-75`）校验并在 `parseMemoryLog`（`:99`）中应用；旧行没有该字段也能正常解析。这是 §2.1 缓解（1）「可审计溯源」的落地——每条后台写入都能回答「哪次会话、哪一轮产生」。缺省为 `null`：宿主注入的 `write` 回调在 `turnId===null` 时显式传 `null`（`session-compose.ts:495`）。

**② 写入层：三种 op 与拒绝语义**

`applyMemoryExtractionOp(store,op,source)`（`extraction.ts:44-76`）只写**全局层**（`store.ts:68-70` 返回全局路径；项目层是只读契约，见 `store.ts:10-11`）：

- `add`：文本超 `MEMORY_ENTRY_MAX_BYTES`（2048，`log.ts:26`）→ 拒绝（`:53`）；与既有条目文本重复（`findEntryByText`）→ 拒绝（`:54`）；否则追加（`:57`）。
- `update`：目标 id 不存在 → 拒绝（`:61`）；命中则**追加新 id 并携带 `supersedes`**，旧条目保留（`:62-70`）——维持 append-only 日志语义。
- `forget`：id 不存在 → 拒绝（`:73`）；否则追加墓碑（`:74`）。

`memoryManifest`（`:88-97`）渲染 `- m7 [tags] text`，按 `MEMORY_MANIFEST_MAX_BYTES`（8192，`:79`）**从尾部截断、保留最旧**，作为提炼提示词里的「现有记忆」清单（§4 line 153）。

**③ 调度层：cursor 与两道跳过门**

`createMemoryExtractionScheduler`（`memory-extraction.ts:321-447`）在每轮结束后 fire-and-forget：

- **cursor**：`ExtractionCursor{turn_id,event_count}`（`:74-79`），由 `ExtractionCursorStore`（`:82-85`）持久化为 JSON sidecar。`sliceUnprocessedTurns`（`:198-220`）只在遇到完整 `turn_end` 时切片，尾部不完整轮次留待下次（`:212-218`）。
- **悬空/越界即全扫**：`event_count` 越界（`>len` 或 `<0`）→ 重置为 `{turn_id:"",event_count:0}`（`:203-204`）；存储的 `turn_id` 在前缀中找不到对应 `turn_end` → 同样重置（`:205-209`）。模块头（`:18-24`）明确：**压缩会重编号 turn id，因此 cursor 允许悬空**。重置后从头重扫是安全的——重复 `add` 被文本哈希挡掉（见 ②）。
- **跳过门 1（直写）**：本轮含 `remember`/`forget` 直写（`containsDirectMemoryWrite`，`:223-225`）→ 跳过提炼，避免与主循环主动写打架（§4 line 161）。
- **跳过门 2（用户散文）**：`userProseOf`（`:228-236`）只看 `origin` 为 `undefined|"user"` 的文本；`hasEligibleUserProse`（`:243-247`）要求空白分词词数或 CJK 字数达到 `DEFAULT_MIN_USER_WORDS=3`（`:136`，CJK 按 `minWords*3` 折算）→ 不达标跳过。
- **契约**：`extractionSystemPrompt`（`:153-178`）要求严格 JSON `{"ops":[…]}`；`parseExtractionOps`（`:292-315`）对散文/垃圾返回 `[]`（记 `no-op`，cursor 前进）；`normalizeOp`（`:492-512`）对超长 op **拒绝而非截断**。
- **失败不前进**：传输失败 → stderr、账本记 `status:"error"`、cursor **不前进**（`:387-391`），下轮重试；成功且 `applied>0` 记 `ok`，否则记 `no-op`，两者都保存 cursor（`:403-409`）。
- **drain**：`drain()`（`:441-446`）等待在飞/排队任务，接在 `shutdownHooks`（`session-compose.ts:352-355`）上，覆盖进程退出与 idle 驱逐（`:350-351` 注释）。

**④ 账本层：独立 kind 与诚实口径（§4 line 159 裁决的落地）**

`UsageExtractionRecord`（`ledger.ts:140-154`）以 `kind:"extraction"` 独立成行，字段含 `session`、`turn_id`、`usage`、`price`、`cost`、`priced_by`、`entries`、`status:"ok"|"no-op"|"error"`；`bookExtraction`（`:412-431`）追加写入、**无幂等键**。口径落地：

- `total()`/`totals()` 走 `billableRows()`（`:477-479`，仅排除 `turn_total`）→ **提炼成本诚实计入总额**；`ledgerCostBlock`（`ledger-query.ts:270-287`）的 `session_total` 同样含提炼。
- step 视图走 `ok|error` 白名单：`ledger.ts:469-474` 与 `ledger-query.ts:117-126`，排除 `turn_total` 与 `extraction`；`attempts`/`records` 均为 `steps.length`（step-only），`latest()`（`ledger.ts:451-456`）亦然。
- `aggregateUsage` 跳过 `turn_total`（`ledger.ts:597`）。

**⑤ 接线层：`endTurn` 之后**

`turn-runner.ts` 注入可选 `extraction?: MemoryExtractionScheduler`（`:98-102`），在轮次收尾 `ledger.endTurn(outcome)`（`:226`）**之后**调用 `this.deps.extraction?.schedule(log)`（`:230`）——注释强调「在轮次关闭之后、fire-and-forget」。`compose.ts` 声明依赖（`:106-110`）并透传（`:213`）。

**⑥ 组装层：studio 侧**

`session-compose.ts` 的 `memoryExtraction()`（`:598-633`）按序短路：`sessionId`/目录/工作区为空 → 跳过（`:605`）；`!memoryExtractionEnabled`（**默认关**，见下表）→ 跳过（`:606`）；`resolveLlmMode(env)==="offline"` → 跳过（`:609`）。随后：`memoryStoreOf(workspace.path)`（`:610`）；effort 取 env 或默认 `"low"`（`:611`）；`liveEngineLlm({...profile, reasoning_effort:effort, max_output_tokens:2048}, env)`（`:612`）；`write` 回调包上 `{session,turn}` 溯源（`:616`）；`manifest` 回调（`:617`）；`bookExtraction` 带上 provider/model/base_url_host（`:621-627`）；cursor 指向 `join(dir,"memory-extraction.json")`（`:629`、`:79`、`:636-659`，损坏即重置）；`entryMaxBytes` 传 `MEMORY_ENTRY_MAX_BYTES`（`:630`）；stderr（`:631`）。

**env 开关与默认值**

| 变量 | 默认 | 行为 | 锚点 |
|---|---|---|---|
| `CELESTEA_MEMORY_EXTRACTION` | **关**（只有 `on` / `1` / `true` / `yes` 开） | **opt-in**。默认不开，因为它换来的不是「同一请求换个形状」而是**每个合格轮次多一次计费调用**：没要求它的部署不该花钱，也不该有哪个部署的请求数悄悄变化。（W1900 曾默认开，落地后第一件事就是打红一条数请求数的回归用例。） | `memory-extraction.ts:155-161`、`session-compose.ts:606` |
| `CELESTEA_MEMORY_EXTRACTION_EFFORT` | `"low"` | 覆盖提炼调用的 `reasoning_effort`（自由字符串，逐字透传） | `session-compose.ts:81`、`:611`；`packages/llm/src/profile.ts:107` |
| （内部）`max_transcript_bytes` | 24000 | 转录头截断上限，截断处标 `[transcript head truncated]` | `memory-extraction.ts:135`、`:261-300` |
| （内部）`min_user_words` | 3 | 跳过门 2 阈值 | `memory-extraction.ts:136` |
| （内部）`max_output_tokens` | 2048 | 请求 `max_tokens` | `memory-extraction.ts:137`、`:466-474` |

**测试矩阵（本地全绿）**

| 套件 | 计数 | 覆盖点 |
|---|---|---|
| `packages/runtime/src/memory-extraction.test.ts` | 18 | cursor 新/续/悬空/越界/尾残；两道跳过门；转录渲染；`{"ops"}` 解析；调度器（提炼+记账+前进、门 1、门 2、失败不前进、不可解析记 no-op、合并）；turn 接线 |
| `packages/runtime/src/ledger-extraction.test.ts` | 7 | 价格快照+成本；`total` vs `latest`；未定价；`error`/`no-op` 行；`queryLedger` step-only；`ledgerCostBlock` 的 `session_total` vs `attempts`；重启 |
| `packages/runtime/src/ledger.test.ts` + `ledger-query.test.ts` | 14 + 13 | 既有账本/查询回归 |
| `packages/tools/src/memory/extraction.test.ts` | 12 | add+溯源；哈希去重；超长拒绝；update 取代；未知 id；forget 墓碑+重复；无溯源；id 单调；manifest（渲染/墓碑/预算）；序列化往返 |
| `apps/studio/src/runtime/usage-ledger.test.ts` | 8 | 3 条生产 step + 3 条聚合视图 + 1 条后台提炼 E2E（`:374-436`：mock `{"ops":[{"op":"add","text":"user prefers CNY cost reports","tags":["feedback"]}]}`，断言提取行 `session:"ws/s1"`/`turn_id:"turn-0"`/`status:"ok"`/`entries:1`/`cost{in:0.0003,out:0.00008,cache:0,total:0.00038}`、请求体 `max_tokens=2048`、条目 `source{...}`、`/api/usage/ledger records=1`、`/api/status cost session_total=0.00178`、`turn_total=0.0014`、`attempts=1`、`records=1`）+ 1 条轮转 |

合计：runtime **52/52**、tools **12/12**、studio **8/8**（从仓库根 `pnpm exec vitest run` 验证，exit 0）。

**已知边界**

- **§5 接缝与当前实现的张力**：§5 把 `drain()`（接缝 2，line 226）与 cursor 悬空容忍（接缝 3，line 227）标为 ⛔「不再需要」，但当前代码**两者都实现了**（`memory-extraction.ts:397-401`、`:203-209`），且模块头（`:18-24`）以「压缩会重编号 turn id」为悬空容忍的**现行**理由。根因是 **Phase 2 视图叠层尚未落地**，`compactSession` 仍会重写/重编号日志（§4 line 212、§7 line 279）。因此 §5 的两条 ⛔ 是对 **Phase 2 落地后**的判定，而当前代码正处在 §5 自述的「回退则复活」分支上——落地 Phase 2 前，这两条接缝属于现行必需。
- **`turn_end` 硬约束**：§5 接缝 1 保留；`schedule(log)` 只在轮次关闭后触发，天然满足「不打断进行中的轮次」。
- **anti-pattern 缓解落地**：不每轮都提炼 → 两道跳过门 + cursor（`memory-extraction.ts:217-247`、`:360-371`）；不污染轮次成本 → 独立 `kind:"extraction"` 行、step 视图白名单；可审计 → `source{...}`；人工在环 → 直写门 + 全局层只写 + `entries.jsonl`/`forget` 召回（§2.1）。
- **不做自我反馈**：提炼调用不写回会话日志（`generate` 的请求不落 log，§4 line 157），不会触发下一轮提炼。
- **真实通道探针（✅ 已验证 2026-10-01）**：第三方网关 / deepseek-v4-flash 真通道 E2E 全 PASS——账本出现独立 `kind:"extraction"` 行（status ok、entries 1、323 in / 134 out）、cursor sidecar `memory-extraction.json` 正常推进、`entries.jsonl` 新条目带 `source:{session,turn}` 且事实归类准确（未把临时任务状态写成持久事实）。环境事实：数据根无 `pricing.json` 时成本恒 `unpriced`（按设计，非 bug）。

### Phase 2：上下文压缩 —— ✅ 已实现（模型驱动 + 视图叠层）

> 本节是 Phase 2 落地后的实现索引，格式同 Phase 1。**状态与裁决仍以 §2、§4 为准**；本节只把工作树里的实现对齐到文档。
> 动工前的四项裁决与六条代码核实见 `.probe/phase2-discussion.md`（不入库的讨论记录），下面「动工修订」即该记录 §4 的清单。

**现状诊断**（依然成立，是 Phase 2 存在的理由）：

| 机制 | 触发 | 信息处理 |
|---|---|---|
| `trimContext` | **自动**（超 context 预算时） | **丢弃**最老的消息，只留一条 `[context-trimmed]` 标记（**有损**） |
| `compactSession` | **手动**（lifecycle 操作，HTTP/UI 触发，busy 时 409） | **摘要**（保信息），但重写 log、只有单份 `.precompact` 备份 |

> **只有「丢信息」的那条是自动的。**

**方向**（已随 §2 一并定调；实现已落地于工作树，见下）：参考 billion-context（`D:\mozin\repos\billion-context`）的**插件模式**，自研「模型驱动压缩」
—— 模型自己持有压缩工具、自己决定何时压 / 压什么并自己写摘要，引擎只执行。
**自研、不引 acp-kernel 依赖**：其 `CoreMessage` 数据模型与本仓 log 事件模型阻抗失配，适配层的量与自写相当；
它真正值钱的是行为语义与事故录 —— **迁移概念，不迁移代码**。

**为什么是视图叠层，而不是现 `compactSession` 的 log 重写**：

> session log 保持 append-only 原文不动；压缩状态（哪些区间折成了哪个摘要）旁挂为会话级持久状态；
> `deriveMessages()` 加一级变换：log 事件 → 应用压缩块 → 模型视图。

四个结构性收益：

1. **提炼与压缩彻底解耦**：提炼永远读原始 log，原「提炼必须早于压缩」的核心交互**溶解**（§5）。
2. **天然可逆**：`decompress` = 摘掉叠层块，原文就在 log 里（billion-context 还需单独存原文；本仓 log 即原文）。
3. **cursor 不悬空**：log 永不重写、turn id 永不重编号。
4. **摘要零额外调用**：摘要就是模型当轮的正常输出，正常记 usage（billion-context 实证压缩开销 ≤2%）。

**自研清单**（四件新原语；其余复用既有件）：

| 件 | 说明（落点已按动工裁决写死） |
|---|---|
| 压缩状态旁挂 + derive 加一级 | 压缩块列表（区间 + 摘要），会话级持久化在**会话目录旁挂的 `compression.json`**（与 `memory-extraction.json` 同址同模式，损坏即重置）；叠层加在 `SessionLog.deriveMessages` 之外，视图变、log 不变 |
| 原生工具 `compress` / `decompress` / `context_status` | 对照 billion-context 的工具面；`search_context` 可延后。`decompress` 是**模型工具**（可逆原则升级为协议的一部分） |
| **瞬时**哲学提示词 + 水位 nudge | 教模型何时压 / 压什么，并告知当前水位。**绝不走 `turnContext`**：turnContext 是持久的（append 进 log），哲学进 log = 复刻「炸锅」事故（见下）。哲学**并入 `config.system_prompt` 的构造链**（不是 system 层运行时拼接，也不是 studio 的 prompt 链）；nudge 走 `buildRequest` 尾部的瞬时消息（`trimmedMarkerMessage` 同款机制） |
| ~~消息引用号~~ → **turn 区间引用** | 模型调 `compress` 要指范围：改为 `compress({from_turn,to_turn})`。message 无 id、event 无序数 id，唯一稳定锚是 turn id；逐消息引用号既贵又锚不住（`tool_call` 累积合并使 message↔event 非 1:1） |

**复用既有件**：`trimContext` 留作 preflight 兜底（对应 billion-context 的 `src/preflight.ts`：模型迟迟不压、输入即将超窗时硬裁）；
token 估算器（`context-trim.ts`，仍是唯一估算器）；`cacheHitRatio`（`runtime/src/usage.ts:67`，已在算）；
水位数据面 `contextUsage`（`packages/runtime/src/status.ts:450`）——Phase 2 **不新建第二套水位计算**，nudge 与 preflight 都读这条路径。

**动工修订（六条，来自动工前的裁决；均已落地）**

1. **哲学并入 `config.system_prompt` 的构造链**，不是 system 层运行时拼接：`agentConfigFromProfile`（`packages/runtime/src/agent-config.ts:36-53`）在返回前用 `withCompressionPhilosophy`（`packages/core/src/compression.ts:262`）把 `COMPRESSION_PHILOSOPHY`（`:229`）接到 profile 串尾——`config.system_prompt` 因此**就是最终串**，loop 的裁剪预算（`packages/agent-loop/src/loop.ts:300-306`）、0b 去重的可见性模拟（`packages/runtime/src/turn-context-dedup.ts:97-107`）与 statusline 的组装估算（`packages/runtime/src/runtime.ts:254-260`）三处 `estimateTokens` 自动看到同一串。放进 studio 的 prompt 链会被 `USER_OVERRIDE` 整体旁路；放进 `buildRequest` 会让去重模拟的 system 偏小、切得偏浅，破坏 `turn-context-dedup.ts:28-30` 声明的「只会切得更深」单向安全。
2. **消息引用号 → turn 区间引用**：模型调 `compress({from_turn,to_turn})`，不渲染逐消息引用号（message 无 id、event 无序数 id，唯一稳定锚是 turn id；`tool_call` 累积合并使 message↔event 非 1:1）。区间合法性是**引擎硬校验**（`packages/core/src/compression-range.ts:100`）：未对齐 / 未知轮 / 端点在飞轮 / 倒置 / 空区间五种拒绝码。
3. **压缩的触发经济学**（新增小节，正文见下）。
4. **叠层落点写死**：`compressedLog`（`packages/session/src/compression-log.ts:30`）包住 `SessionLog`，只替换 `deriveMessages` 的派生视图；状态在 `openSessionLog` 的组装点注入（`packages/runtime/src/host/engine-session.ts:143-150`），文件是会话目录旁挂的 `compression.json`（`packages/session/src/compression.ts:29`），损坏 / 版本不符即重置为空（`:64`）。提炼读原始事件，不受叠层影响。
5. **水位与触发**（新增小节，正文见下）。
6. **存储与 `decompress` 形态**：`compression.json` 随会话目录（与 `memory-extraction.json` 同址同模式）；`decompress` 是模型工具（`packages/tools/src/tools/compression.ts:173`），可逆性升级为协议的一部分。

**压缩的触发经济学**（修订 3 的正文）

`buildRequest` 每步从 `deriveMessages()` 重组装（`packages/agent-loop/src/loop.ts:299-316`），所以叠层在**中段**替换消息时，压缩点之后的 suffix 缓存全失、之前的前缀仍命中。三条纪律由此推出：**低频**（每轮压一小块 = 每轮烧一次 suffix）、**大块**（一次压足够老的一大段）、**压冷区间**（越靠近当前轮越贵）；**compress 当步生效**（立即减压才是意义所在，代价是本 turn 后续步的 suffix 重算）。缓存收益由既有 `cacheHitRatio`（`packages/runtime/src/usage.ts:67`）观测，不新增指标。

**水位与触发**（修订 5 的正文）

水位只有一个数据面：`packages/runtime/src/status.ts` 的 `contextUsage`（`:450`，真实 provider prompt_tokens 优先，否则用与 trim 同一个估算器的备忘录组装）。runtime 投影成 `ContextUsageFacts`（`packages/runtime/src/runtime.ts:138-140`）并作为 `contextUsage` 绑定交给 loop（`packages/runtime/src/compose.ts:223`、`packages/runtime/src/turn-runner.ts:298`）。两级触发读同一个 ratio：

- **50% nudge**（`COMPRESSION_NUDGE_RATIO`，`packages/core/src/compression.ts:155`）：`buildRequest` 尾部追加一条**瞬时** system 消息（`packages/agent-loop/src/loop.ts:307`、`packages/agent-loop/src/compression-nudge.ts:91`），进视图、绝不进 log、绝不进 system prompt、每步重建。
- **0.8 preflight**（`COMPRESSION_PREFLIGHT_RATIO`，`:165`）：措辞从「可以压」升级为「现在压」，并说明引擎即将开始有损裁剪（`packages/agent-loop/src/compression-nudge.ts:63`）。真正的兜底仍是既有 `trimContext` —— `CONTEXT_TRIM_THRESHOLD`（`packages/runtime/src/agent-config.ts:17`）就是同一个 0.8，它不依赖模型是否调用 compress。
- **协议适配（W2068 `anthropic_messages`）**：该协议没有会话内的 system 角色，所以 `packages/llm/src/anthropic/wire.ts` 把 messages 里的 system 消息**提升**进顶层 `system`（拼在 profile 串之后，遇到顺序）。**不是丢弃** —— 丢的话这条路由上动态水位完全消失，而第三方端点（MiniMax 那类行）走的正是这条。代价是位置：它和系统提示一起被读，而不是作为「下一步之前最后读到的东西」。

**压缩块 schema**（原 §5 遗留项，已定）

`CompressionBlock { from_turn, to_turn, summary, created_turn, context_ratio }`（`packages/core/src/compression.ts:50`）—— 事件坐标区间 + 摘要 + 创建轮 + 压缩时水位，四项俱全；渲染进视图时由 `blockText`（`:95`）加上 `[compressed turns A-B]` 头部，模型据此知道「这里有一段被折叠的历史」。侧车 schema 版本 `COMPRESSION_SCHEMA_VERSION = 1`（`:44`）。

**实现分解（六层）**

| 层 | 文件 | 内容 | 关键锚点 |
|---|---|---|---|
| ① 纯函数 | `packages/core/src/compression.ts`、`compression-range.ts` | 块 schema、区间数学（校验 / 归一化合并 / turn 索引）、叠层投影、哲学常量、水位事实投影 | `compression.ts:50`、`:95`、`:117`、`:177`；`compression-range.ts:100`、`:142`、`:172` |
| ② 会话状态 | `packages/session/src/compression.ts`、`compression-log.ts` | `compression.json` 侧车（损坏即重置）、`deriveMessages` 叠层装饰器 | `compression.ts:29`、`:64`、`:102`；`compression-log.ts:27`、`:30` |
| ③ 运行时接线 | `packages/runtime/src/host/engine-session.ts`、`compression-host.ts`、`compression-switch.ts`、`agent-config.ts`、`compose.ts`、`runtime.ts` | 组装点注入、宿主端口、env kill-switch、哲学并入、水位绑定 | `engine-session.ts:147-150`、`compression-host.ts:116`、`compression-switch.ts:27`、`agent-config.ts:50-51`、`compose.ts:223`、`runtime.ts:138` |
| ④ 循环 | `packages/agent-loop/src/compression-nudge.ts`、`loop.ts` | nudge 文本 / 阈值 / 瞬时消息；`buildRequest` 尾部注入 | `compression-nudge.ts:62`、`:91`；`loop.ts:299-316` |
| ⑤ 工具 | `packages/tools/src/tools/compression.ts`、`contracts/tools.json` | `compress` / `decompress` / `context_status` 三工具 + 契约 | `compression.ts:144`、`:173`、`:198`、`:228`；`tools.json:797`、`:831`、`:860` |
| ⑥ 观测 | `apps/studio/src/runtime/compression-view.ts`、`apps/studio/src/handlers/health.ts`、`contracts/endpoints.json` | `/api/status.compression` 只报告不计算 | `health.ts:102`、`:144`；`endpoints.json:179` |

**env 开关与默认值**

| 变量 | 默认 | 作用 |
|---|---|---|
| `CELESTEA_MEMORY_COMPRESSION` | **开**（`off` / `0` / `false` / `no` 关） | 关掉哲学段、nudge 与三个工具（`packages/runtime/src/compression-switch.ts:27`；消费点 `agent-config.ts:50`、`engine-session.ts:143`、`compression-host.ts:116`）。关掉后 loop 与 Phase 2 之前的字节一致 |

> 两个开关的默认**相反**，而且是有意的：压缩改变的是「既有请求带什么」，提炼是「每个合格轮次多花一次计费调用」——`memoryExtractionEnabled` 因此是 opt-in（`packages/runtime/src/memory-extraction.ts:155-161`）。拼写（`on`/`off` 那一套）两边一致，操作者只需记一套词。

**测试矩阵**

| 层 | 测试 | 覆盖 |
|---|---|---|
| 纯函数 | `packages/core/src/compression.test.ts` | schema、区间校验、归一化合并、叠层与 hide-consumed、哲学幂等、水位投影、两个阈值 |
| 会话状态 | `packages/session/src/compression.test.ts` | 侧车读写、损坏即重置、版本不符、装饰器透明性 |
| 循环 | `packages/agent-loop/src/compression-nudge.test.ts` | 阈值上下、措辞分级、system 角色、尾部、绝不进 log / system prompt、每步重建、无绑定字节一致（`:84`、`:108`、`:123`、`:144`） |
| 工具 | `packages/tools/src/tools/compression.test.ts` | 写入 / 合并、五种拒绝码、精确匹配还原、只读 status、`no_session` |
| 与 0b 交互 | `packages/runtime/src/compression-dedup.test.ts` | 常驻行被吞 → ③态下轮自愈重注入且仅一次（`:86`、`:111`）、绝不吞在飞轮（`:134`）、单向安全（`:149`） |
| 组装与观测 | `packages/runtime/src/compose.test.ts`、`apps/studio/src/runtime/real-runtime.test.ts`、`tests/contract-parity.test.ts` | 哲学并入最终串、`/api/status` 新增 `compression` 块、三工具契约 parity |

**已知边界**

- `search_context` 未做（设计上可延后）；`decompress` 只接受与块**完全一致**的区间，不做区间裁剪式部分还原。
- 侧车损坏 / 版本不符 → 静默重置为空并 warn（与 `memory-extraction.json` 同模式），**不做备份**。
- 嵌套再压缩 = 区间覆盖合并（`normalizeBlocks`，`compression-range.ts:142`），摘要是「摘要的摘要」；`mergedBlockCount`（`:172`）回报被吞掉的块数。
- `compactSession` **尚未退役**，今天两条路径并存（§5 的注）——**但压缩视图不再受它影响**：重写日志会作废 `<session dir>/compression.json`（`packages/runtime/src/compact/run.ts` 的 `clearCompressionSidecar`，落在原子重写之后、调用方重绑之前；清理失败即抛，于是 `compaction_start` 保持未配对，交给 P12 的既有判定）。侧车是「**旧编号上的闭区间**」，留着就等于把旧区间套到重编号后的新日志上；而 overlay 对「找不到 `to_turn`」的读法又只能往前盖 —— 两条一起，正是当初必须把「重写日志」和「作废派生状态」绑成一步的原因。
- 本节对应的实现已随 PR#2 **并入 main**（本次吸纳，状态行同步为「设计（P0–P2 已实现）」）。
**行为参照与测试场景**：billion-context 的插件模式（pi 适配器，其文档自称 "the ONLY behavioral reference"）。其事故录直接翻译为本仓测试场景：

- **#717 伪造标记**：模型在上下文压力下伪造「已压缩」确认文本、从未真正调用 —— 以状态为准，不以转录文本为准。
- **炸锅 / 注入持久化**：哲学与工具记录必须瞬时、每轮重建，绝不沉淀进历史；已消费的压缩记录从视图隐藏（hide-consumed 卫生）；压缩循环设轮次上限，到顶**优雅完成**（绝不返回空完成）。

**验证手段（非长期形态）**：~~本仓引擎恒走 OpenAI `chat_completions`（§3），今天即可把引擎指到 billion-context 代理后做 §4 0a 末尾的零代码实验。~~ **❌ 已关闭（2026-09-30，理由见 §4 Phase 0a 末段）。** 保留以下判断备查：
注意两点：挂载走的是其**代理模式**（为「改不了的客户端」设计的妥协路径，摘要伪装成 user 消息回灌）；且代理在进程外看不见 log / 提炼 / memory，
本节的视图叠层收益在挂载形态下一条都拿不到 —— **挂载只是实验，长期形态必须是自研**。

**现 `compactSession` 的处置**：视图叠层落地后降级为「硬重置」工具或退役；其「重写 log + 单份备份」的可逆性短板随之消失。
（**注**：Phase 2 已落地但 `compactSession` **尚未退役**，两条路径并存，`compactSession` 仍会重写 / 重编号日志 —— §5 的注因此仍然成立。**压缩侧车不在此列**：重写会作废 `compression.json`，所以「旧区间套到新日志上」这条已经堵住。）

**仍有效的约束**：前作 §3 反模式第 6 条（过度剪枝；丢失特异性很难恢复，**稀疏记忆比略大的记忆更糟**）。
模型驱动把「压什么」交给模型，哲学提示词与测试场景必须防住「过度压缩」这一侧。

---

## 5. Phase 1 的接缝（已按 Phase 2 定调收缩）

Phase 2 定调为**视图叠层**（§4）后，原三条接缝只剩一条硬约束：

| # | 接缝 | 状态 | 说明 |
|---|---|---|---|
| **1** | 提炼的挂载点 = **`turn_end`**（同步调度、异步执行） | ✅ **保留（硬约束）** | 视图叠层下挂载位置不再牵涉定序，但 turn_end 仍是正确的低噪声调度点 |
| 2 | 提炼队列 `drain()` 语义 | ⛔ 不再需要 | 视图叠层下压缩不必等提炼（提炼读原始 log，与模型视图无关）。**若 Phase 2 回退到 log 重写方案则复活** |
| 3 | cursor 容忍「指向的消息已不存在」 | ⛔ 不再需要 | 视图叠层下 log 永不重写、turn id 永不重编号，cursor 不悬空。**回退则复活且是必然踩到**：重写会重编号 turn id（否则 `PersistentSessionLog` 恢复计数器撞号） |

> **注（2026-10-01，Phase 2 落地后修订）**：Phase 2 视图叠层已在工作树落地（§4 Phase 2），但 `compactSession` **尚未退役**、仍会重写/重编号日志——当前实现仍处在上表「回退则复活」分支，`drain()` 与 cursor 悬空容忍**仍为现行必需**（已实现并测试）；待 `compactSession` 退役后再按本表收缩。

### ⭐ 原核心交互已溶解

原「提炼必须早于压缩」（压缩先跑则提炼读到摘要，信息损失一轮）在视图叠层下**不成立**：压缩只改模型视图，提炼永远读原始 log，两者可任意交错。
这也是选视图叠层而非 log 重写的主要理由之一（§4 Phase 2）。

---

## 6. 挂起项（明确不现在定）

| 项 | 状态 | 理由 |
|---|---|---|
| Phase 2 启动与否 / 优先级 | ✅ 已启动（2026-10-01；实现在工作树，未提交） | 0a 三问的答案（缓存折价后账单仅约 21.7%、trim 现实不触发、0b 已除常驻堆积）未改变方向：模型驱动 + 视图叠层，实现分解见 §4 Phase 2 |
| nudge 水位阈值 / preflight 触发预算 | ✅ 已裁决（2026-10-01） | 50% nudge + 0.8 preflight，复用 statusline `contextUsage` 数据面；`trimContext` 的 `CONTEXT_TRIM_THRESHOLD` 同值兜底（§4 Phase 2） |
| 压缩状态存储位置 | ✅ 已裁决（2026-10-01） | 会话目录旁挂 `compression.json`（与 `memory-extraction.json` 同址同模式），随 session store 生命周期，损坏即重置（§4 Phase 2） |
| `decompress` 做成模型工具还是仅调试命令 | ✅ 已裁决（2026-10-01） | 做成模型工具（`packages/tools/src/tools/compression.ts:173`）：视图叠层下可逆性便宜，把它升级为协议的一部分 |
| 提炼用哪个模型 / 提炼调用是否记 usage ledger | ✅ 已裁决（2026-09-30） | 会话当前模型 + reasoning_effort 钉最低档 + 输出 ≤2048；ledger 记独立 `kind:"extraction"`、不并入 turn_total（§4 Phase 1） |
| `trimContext` 与 `compactSession` 的取舍策略 | ✅ 已部分解答 | `trimContext` 留作 preflight 兜底；`compactSession` 待视图叠层落地后降级或退役（§4 Phase 2） |
| 压缩阈值常量是否调整 | ✅ 已裁决（2026-10-01） | `COMPRESSION_NUDGE_RATIO = 0.5` / `COMPRESSION_PREFLIGHT_RATIO = 0.8`（`packages/core/src/compression.ts:155`、`:165`）；与 `CONTEXT_TRIM_THRESHOLD` 同值，兜底与提示同一条线。**保持常量、不做 env 可配**：哲学正文里写着「roughly half the window」，一个能被配置移动的数字就是一句会说谎的提示词。将来若真要扫参，必须**同一个改动里**把哲学正文改成按同一来源渲染（`withCompressionPhilosophy` 在 `agentConfigFromProfile` 里合并，一个 generation 内仍是冻结串，所以技术上可行）——只改阈值不改正文，就是让提示词与行为分叉 |
| 是否引入显式缓存断点 | ❌ 已撤回 | 见 §3 |
| `[[wiki-link]]` 式记忆间链接 | ⏸ 挂起 | 与 append-only log 模型有张力，未评估 |

---

## 7. 证据索引

**记忆系统（现状）**

| 关注点 | 位置 |
|---|---|
| 读侧：注入渲染 + 防投毒声明 + 截断 | `packages/core/src/memory.ts` |
| 两层来源发现 | `packages/core/src/celestea-sources.ts` |
| 写侧：log 解析 / fold / 渲染 | `packages/tools/src/memory/log.ts` |
| 写侧：store IO | `packages/tools/src/memory/store.ts` |
| `remember` / `forget` 工具 | `packages/tools/src/tools/memory.ts` |
| 注入车道（每轮 turn 起点） | `apps/studio/src/runtime/session-compose.ts` |

**对话成本（现状）**

| 关注点 | 位置 |
|---|---|
| 每轮无条件注入常驻上下文 | `packages/runtime/src/turn-runner.ts:205`、`:284` |
| 裁剪（O(n) 后缀和 + 安全切割边界） | `packages/agent-loop/src/context-trim.ts:10` |
| 压缩计划（阈值 / 保留轮数） | `packages/runtime/src/compact/plan.ts:22`、`:24` |
| 压缩是手动 lifecycle 操作 | `apps/studio/src/runtime/session-lifecycle.ts:56`、`:92` |
| 缓存命中解析（三种 key 形态） | `packages/llm/src/usage.ts:25` |
| 请求体构造（无 cache 字段） | `packages/llm/src/wire.ts:231` |
| 协议由 provider 行决定，未声明时回落 chat_completions | `apps/studio/src/runtime/engine-profile.ts:28` |
| 未知 request_format 被拒（带名 fail-closed） | `apps/studio/src/store/provider-probe.ts:186` |
| 缓存命中率（已在算，statusline 暴露） | `packages/runtime/src/usage.ts:67` |
| trim 只动派生视图、不动 log | `packages/agent-loop/src/loop.ts:270` |
| 压缩重写 log + 单份 `.precompact` 备份 | `packages/runtime/src/compact/rewrite.ts` |
| 宿主侧注入写回调的先例（runtime 不可 import tools） | `apps/studio/src/runtime/session-compose.ts:347-349` |

**前作决策**

| 文档 | 用途 |
|---|---|
| [`archive/decisions/feature-workspace-memory.md`](./archive/decisions/feature-workspace-memory.md) | P0/P1 的决策依据与验收标准 |
| [`archive/research/memory-store.md`](./archive/research/memory-store.md) | 开源调研与选型；**§3 反模式清单（本文 §2 的冲突来源）**；§2.3 架构 B 线格式（`source:{session,turn}` 字段出处） |

**外部参照**（不进仓，仅行为参照）

| 参照 | 用途 |
|---|---|
| ZCode（`D:\mozin\repos\ZCode`） | 提炼机制：两道跳过门、cursor、`drain()`、`skipTranscript`、提炼 prompt 带 manifest |
| billion-context（`D:\mozin\repos\billion-context`） | 模型驱动压缩：插件模式为行为参照；事故录（#717 伪造标记、炸锅注入持久化）翻译为本仓测试场景；**不引 acp-kernel 依赖** |

---

## 8. 移交须知

1. **§2 已裁决（选项 A）**，无需再裁决；但要读它以理解 `source:{session,turn}`、只写 global 层、两道跳过门这些约束的来历。
2. **Phase 0a 先行**，它零风险且决定 Phase 2 是否启动；可并行做 billion-context 挂载实验（§4 Phase 2「验证手段」）。
3. **§5 只剩一条硬约束**（提炼挂 `turn_end`）；若 Phase 2 回退到 log 重写方案，先回 §5 复活接缝 2/3 —— 回退场景下 cursor 悬空是**必然**踩到的。
4. **Phase 2 动手前重读 §4 的自研清单**：瞬时哲学（绝不进 `turnContext`/log）、消息引用号、hide-consumed 卫生、轮次上限优雅完成 —— 都来自 billion-context 的事故录，不是品味问题。
5. 改动落 `packages/` 前先读 [`ARCHITECTURE.md`](./ARCHITECTURE.md) §0 红线与 §1 分层；改完跑**全量** `pnpm check`。
