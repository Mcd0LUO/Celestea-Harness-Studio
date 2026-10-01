### Phase 1 实现分解（✅ 已实现，98b14d8）

> 本节是 Phase 1 落地后的实现索引：按六层列出「实际改成了什么样」，供维护者按层定位代码。**状态与裁决仍以 §2、§4 为准**；本节不新增设计决策，只把已提交的实现对齐到文档。

**六层改动一览**

| 层 | 文件 | 内容 | 关键锚点 |
|---|---|---|---|
| ① 日志 | `packages/tools/src/memory/log.ts` | `source?{session,turn}` 溯源字段 + 后向兼容解析 | `:42`、`:70-75`、`:99` |
| ② 写入 | `packages/tools/src/memory/extraction.ts` | `applyMemoryExtractionOp`（add/update/forget 与拒绝原因）+ `memoryManifest` | `:44-76`、`:79`、`:88-97` |
| ③ 调度 | `packages/runtime/src/memory-extraction.ts` | `createMemoryExtractionScheduler`：cursor、两道跳过门、`{"ops":[…]}`、drain | `:321-447`、`:198-220`、`:354-362`、`:441-446` |
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

`session-compose.ts` 的 `memoryExtraction()`（`:477-512`）按序短路：`sessionId`/目录/工作区为空 → 跳过（`:484`）；`!memoryExtractionEnabled` → 跳过（`:485`）；`resolveLlmMode(env)==="offline"` → 跳过（`:488`）。随后：`memoryStoreOf(workspace.path)`（`:489`）；effort 取 env 或默认 `"low"`（`:490`）；`liveEngineLlm({...profile, reasoning_effort:effort, max_output_tokens:2048}, env)`（`:491`）；`write` 回调包上 `{session,turn}` 溯源（`:495`）；`manifest` 回调（`:496`）；`bookExtraction` 带上 provider/model/base_url_host（`:497-507`）；cursor 指向 `join(dir,"memory-extraction.json")`（`:508`、`:78`、`:515-538`，损坏即重置）；`entryMaxBytes` 传 `MEMORY_ENTRY_MAX_BYTES`（`:509`）；stderr（`:510`）。

**env 开关与默认值**

| 变量 | 默认 | 行为 | 锚点 |
|---|---|---|---|
| `CELESTEA_MEMORY_EXTRACTION` | 开 | 取 `off`/`0`/`false`/`no` 关闭；其余开启 | `memory-extraction.ts:144-150`、`session-compose.ts:485` |
| `CELESTEA_MEMORY_EXTRACTION_EFFORT` | `"low"` | 覆盖提炼调用的 `reasoning_effort`（自由字符串，逐字透传） | `session-compose.ts:80`、`:490`；`packages/llm/src/profile.ts:107` |
| （内部）`max_transcript_bytes` | 24000 | 转录头截断上限，截断处标 `[transcript head truncated]` | `memory-extraction.ts:135`、`:250-289` |
| （内部）`min_user_words` | 3 | 跳过门 2 阈值 | `memory-extraction.ts:136` |
| （内部）`max_output_tokens` | 2048 | 请求 `max_tokens` | `memory-extraction.ts:137`、`:369-376` |

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

- **§5 接缝与当前实现的张力**：§5 把 `drain()`（接缝 2，line 226）与 cursor 悬空容忍（接缝 3，line 227）标为 ⛔「不再需要」，但当前代码**两者都实现了**（`memory-extraction.ts:441-446`、`:203-209`），且模块头（`:18-24`）以「压缩会重编号 turn id」为悬空容忍的**现行**理由。根因是 **Phase 2 视图叠层尚未落地**，`compactSession` 仍会重写/重编号日志（§4 line 212、§7 line 279）。因此 §5 的两条 ⛔ 是对 **Phase 2 落地后**的判定，而当前代码正处在 §5 自述的「回退则复活」分支上——落地 Phase 2 前，这两条接缝属于现行必需。
- **`turn_end` 硬约束**：§5 接缝 1 保留；`schedule(log)` 只在轮次关闭后触发，天然满足「不打断进行中的轮次」。
- **anti-pattern 缓解落地**：不每轮都提炼 → 两道跳过门 + cursor（`memory-extraction.ts:223-247`、`:354-362`）；不污染轮次成本 → 独立 `kind:"extraction"` 行、step 视图白名单；可审计 → `source{...}`；人工在环 → 直写门 + 全局层只写 + `entries.jsonl`/`forget` 召回（§2.1）。
- **不做自我反馈**：提炼调用不写回会话日志（`generate` 的请求不落 log，§4 line 157），不会触发下一轮提炼。
- **未验证项**：真实通道（真实模型 + 真实 memory 目录）的端到端探针仍未做，属 handoff 列出的可选剩余工作；上述测试均为 mock/单测级。

---

> **（落盘提示，不属于章节正文；交付时请删除本块）**
>
> 1. 建议插入位置：`### Phase 1：记忆提炼（E）` 的要点列表之后、`### Phase 2` 之前；标题沿用全文一致的 `###` 层级。
> 2. `docs/feature-memory-extraction.md:3` 状态行现为「设计」。按 `:3-4` 的维护约定，Phase 1 已落地，建议改「设计（P0 已实现）」（P0 = Phase 1）。**此改动须用户批准后由正式文档维护者执行，本草稿不落盘。**
> 3. 核实中发现的差异（**未擅自改代码或文档**）：
>    - `docs/feature-memory-extraction.md:158` 写 `reasoning_effort` 硬钉最低档「`off`」；源码 `session-compose.ts:490` 默认 `"low"`。`reasoning_effort` 是自由字符串（`packages/llm/src/profile.ts:107`），`"low"` 未必等价「`off`」——需确认裁决意图是「最低档」还是具体字面量 `"off"`。
>    - `docs/feature-memory-extraction.md:154` 写 manifest「渲染后 ≤2048 字节」；源码 `MEMORY_MANIFEST_MAX_BYTES=8192`（`extraction.ts:79`）。2048 是**单条条目**上限 `MEMORY_ENTRY_MAX_BYTES`（`log.ts:26`），二者被混为一谈。
>    - `docs/feature-memory-extraction.md:226-227`（§5）把 `drain()` 与 cursor 悬空容忍标 ⛔；源码两条都在且带现行理由（见正文「已知边界」）。属**时态口径**问题：文档按 Phase 2 落地后描述，代码按 Phase 2 未落地实现。
>    - `docs/feature-memory-extraction.md:151` 与 `:280` 引用 `session-compose.ts:326-328` 作为「宿主注入写回调」先例；该注释现已漂移到 `session-compose.ts:347-349`（`shutdownHooks` 在 `:352-355`）。行号失效，措辞可保留。
