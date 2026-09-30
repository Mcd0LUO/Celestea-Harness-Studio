# 记忆提炼与长对话成本 · 路线设计

> 状态：**设计**。本文只定**路线与已闭合决策**，不跟踪进度 —— 按 [`README.md`](./README.md) 的维护约定，
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
  先例：`session-compose.ts:326-328` 的 run_shell 处置 hook 注释（「runtime is L2 and may not import @celestea/tools, so the hook is wired HERE」）。
- **只写 global 层**：项目层是只读契约，提炼不得写。
- **提炼 prompt 必须带现有条目清单**：ZCode 的 `buildMemoryExtractionPrompt` 注入现有记忆 manifest 并指示「update an existing file rather than creating a duplicate」。
  不带清单时去重只剩 `memoryTextHash` 精确匹配，提炼会产出大量近似重复。manifest 很便宜（渲染后 ≤2048 字节）。
- **支持 `supersedes`**：提炼天然需要「改正旧记忆」而非只新增；结构化输出应允许携带 supersedes 操作（写路径已支持该字段）。
- **条目上限**：`MEMORY_ENTRY_MAX_BYTES = 2048` 是硬上限，prompt 必须告知模型，否则超长条目会被拒。
- **防自反馈**：提炼的模型请求**不 append 到 session log**（对应 ZCode 的 `skipTranscript`）。
- **提炼模型（✅ 已裁决 2026-09-30）**：用**会话当前模型**（跟随 providers.json 的 default_model，不设独立配置项）；**reasoning_effort 硬钉最低档（off），不随会话 profile 走**——防止主对话调高 thinking 后提炼跟着贵起来（ZCode 同款：`auxiliaryModelOptions` 取公开档位最低项 + 输出压到 ≤5000）；输出预算 ≤2048 token（几条 MEMORY_ENTRY 的量级）。维持「单次结构化输出调用、无工具循环」裁决，ZCode 只借鉴模型/档位/预算这三件。
- **usage ledger（✅ 已裁决 2026-09-30）**：**记**，独立 `kind: "extraction"`，**不并入 `turn_total`**——不记是隐性成本，并入则污染 Phase 0a 基线口径；独立 kind 让提炼成本可单独核算对账。

### Phase 2：上下文压缩 —— 方向已定：模型驱动 + 视图叠层

**现状诊断**（依然成立，是 Phase 2 存在的理由）：

| 机制 | 触发 | 信息处理 |
|---|---|---|
| `trimContext` | **自动**（超 context 预算时） | **丢弃**最老的消息，只留一条 `[context-trimmed]` 标记（**有损**） |
| `compactSession` | **手动**（lifecycle 操作，HTTP/UI 触发，busy 时 409） | **摘要**（保信息），但重写 log、只有单份 `.precompact` 备份 |

> **只有「丢信息」的那条是自动的。**

**方向**（已随 §2 一并定调；**启动与否仍等 Phase 0a 数据**）：参考 billion-context（`D:\mozin\repos\billion-context`）的**插件模式**，自研「模型驱动压缩」
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

| 件 | 说明 |
|---|---|
| 压缩状态旁挂 + derive 加一级 | 压缩块列表（区间 + 摘要），会话级持久化（存储位置见 §6 待定） |
| 原生工具 `compress` / `decompress` / `context_status` | 对照 billion-context 的工具面；`search_context` 可延后 |
| **瞬时**哲学提示词 + 水位 nudge | 教模型何时压 / 压什么，并告知当前水位。**绝不走 `turnContext`**：turnContext 是持久的（append 进 log），哲学进 log = 复刻「炸锅」事故（见下）。哲学走 system 层每轮重建（字节稳定、不伤前缀缓存）；nudge 走 system 层或新增瞬时通道 |
| 消息引用号 | 模型调 `compress` 要指范围：模型视图渲染稳定引用号，锚定 log 事件 id |

**复用既有件**：`trimContext` 留作 preflight 兜底（对应 billion-context 的 `src/preflight.ts`：模型迟迟不压、输入即将超窗时硬裁）；
token 估算器（`context-trim.ts`）；`cacheHitRatio`（`runtime/src/usage.ts:67`，已在算）。

**行为参照与测试场景**：billion-context 的插件模式（pi 适配器，其文档自称 "the ONLY behavioral reference"）。其事故录直接翻译为本仓测试场景：

- **#717 伪造标记**：模型在上下文压力下伪造「已压缩」确认文本、从未真正调用 —— 以状态为准，不以转录文本为准。
- **炸锅 / 注入持久化**：哲学与工具记录必须瞬时、每轮重建，绝不沉淀进历史；已消费的压缩记录从视图隐藏（hide-consumed 卫生）；压缩循环设轮次上限，到顶**优雅完成**（绝不返回空完成）。

**验证手段（非长期形态）**：~~本仓引擎恒走 OpenAI `chat_completions`（§3），今天即可把引擎指到 billion-context 代理后做 §4 0a 末尾的零代码实验。~~ **❌ 已关闭（2026-09-30，理由见 §4 Phase 0a 末段）。** 保留以下判断备查：
注意两点：挂载走的是其**代理模式**（为「改不了的客户端」设计的妥协路径，摘要伪装成 user 消息回灌）；且代理在进程外看不见 log / 提炼 / memory，
本节的视图叠层收益在挂载形态下一条都拿不到 —— **挂载只是实验，长期形态必须是自研**。

**现 `compactSession` 的处置**：视图叠层落地后降级为「硬重置」工具或退役；其「重写 log + 单份备份」的可逆性短板随之消失。

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

### ⭐ 原核心交互已溶解

原「提炼必须早于压缩」（压缩先跑则提炼读到摘要，信息损失一轮）在视图叠层下**不成立**：压缩只改模型视图，提炼永远读原始 log，两者可任意交错。
这也是选视图叠层而非 log 重写的主要理由之一（§4 Phase 2）。

---

## 6. 挂起项（明确不现在定）

| 项 | 状态 | 理由 |
|---|---|---|
| Phase 2 启动与否 / 优先级 | ⏸ 挂起（0a 数据已到，启动信号未出现） | 0a 三问的答案：缓存折价后账单仅约 21.7%、trim 现实不触发、0b 已除常驻堆积——等真实长会话压力信号再裁决，方向不变（模型驱动 + 视图叠层） |
| nudge 水位阈值 / preflight 触发预算 | ⏸ 挂起 | 等 Phase 0a 的数字；`trimContext` 现有阈值先客串兜底 |
| 压缩状态存储位置 | ⏸ Phase 2 动工前裁决 | 建议：会话目录旁挂 `compression.json`，随 session store 生命周期 |
| `decompress` 做成模型工具还是仅调试命令 | ⏸ Phase 2 动工前裁决 | billion-context 做成了模型工具；视图叠层下两种都便宜 |
| 提炼用哪个模型 / 提炼调用是否记 usage ledger | ✅ 已裁决（2026-09-30） | 会话当前模型 + reasoning_effort 钉最低档 + 输出 ≤2048；ledger 记独立 `kind:"extraction"`、不并入 turn_total（§4 Phase 1） |
| `trimContext` 与 `compactSession` 的取舍策略 | ✅ 已部分解答 | `trimContext` 留作 preflight 兜底；`compactSession` 待视图叠层落地后降级或退役（§4 Phase 2） |
| 压缩阈值常量是否调整 | ⏸ 挂起 | 等 Phase 0a 的数字（仅当回退 log 重写方案时相关） |
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
| 引擎只走 chat_completions | `apps/studio/src/runtime/engine-profile.ts:22` |
| 非 chat_completions 被拒 | `apps/studio/src/store/provider-probe.ts:133` |
| 缓存命中率（已在算，statusline 暴露） | `packages/runtime/src/usage.ts:67` |
| trim 只动派生视图、不动 log | `packages/agent-loop/src/loop.ts:270` |
| 压缩重写 log + 单份 `.precompact` 备份 | `packages/runtime/src/compact/rewrite.ts` |
| 宿主侧注入写回调的先例（runtime 不可 import tools） | `apps/studio/src/runtime/session-compose.ts:326-328` |

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
