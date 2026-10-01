# Phase 2 讨论记录 — 裁决与代码核实结论

> 状态：Phase 2 **维持挂起**（用户裁决 Q1：仅讨论，不改设计文档、不动工）。
> 本文档是讨论记录，不是设计文档。权威设计文档仍是 `docs/feature-memory-extraction.md`。
> 本文件内容 = 启动 Phase 2 时设计定稿的直接输入；届时按 §5 修订清单回写设计文档。
> 记录日期：Phase 1 收官后、Phase 2 启动前。核实基线：本仓当前 HEAD。

## 1. 用户裁决（已拍板，四项）

| # | 问题 | 裁决 |
|---|---|---|
| Q1 | Phase 2 启动信号 | **维持挂起，仅讨论**。不改文档、不动工 |
| Q2 | 压缩状态存储 | 会话目录旁挂 `compression.json`（与 memory-extraction.json 同址同模式） |
| Q3 | decompress 形态 | **模型工具**（可逆原则升级为协议的一部分） |
| Q4 | nudge 水位 | 50% nudge + 尾部瞬时通道 + 0.8 preflight 兜底（复用现有 statusline 管线） |

## 2. 代码核实结论（六个缺口逐一对照源码）

### ① nudge 通道——矛盾坐实，外加一个计划外的坑
- `packages/agent-loop/src/loop.ts:279`：`system: this.config.system_prompt` 单一冻结串；
  `packages/core/src/memory.ts:7` 注释原文称其为 *frozen, cache-critical string*。水位数字进 system = 缓存全碎，排除。
- **瞬时通道机制先例已存在**：`packages/agent-loop/src/context-trim.ts:144` 的 `trimmedMarkerMessage`
  就是「插进派生视图、绝不进 log」的合成消息。nudge 在 `buildRequest`（loop.ts:269-285，每步唯一组装点）
  尾部照此插入即可，零新管道。
- **坑：哲学提示词的放置位置。** 若由 studio 的 prompt 组装链携带，`USER_OVERRIDE` 会整体旁路
  （`apps/studio/src/store/settings.ts:5-7`、`prompts-compose.ts:8-9`）→ 工具还在、哲学没了。
  若在 `buildRequest` 里拼接，0b dedup 的可见性模拟
  （`packages/runtime/src/turn-context-dedup.ts:97-107`，用 `config.system_prompt` 跑同款 `trimContext`）
  会与 loop 真实裁剪产生**反方向偏差**（dedup 模拟的 system 偏小 → 切得偏浅 → 以为常驻行还活着 →
  不重注入），破坏 dedup 模块头声明的「只会切得更深」单向安全（turn-context-dedup.ts:28-30）。
- **结论：哲学必须在 AgentConfig 构造时并入 `system_prompt` 本身**（engine-profile.ts 组装链），
  让 `config.system_prompt` 就是最终串——loop / dedup / statusline 三处的
  `estimateTokens(config.system_prompt)` 自动一致。

### ② 压缩的缓存代价——机制确认 + 一个待写入计划的决策
- `buildRequest` 每步从 `deriveMessages()` 重组装；叠层中段替换 → 压缩点之后 suffix 缓存全失，
  压缩点之前前缀仍命中。支持「压最老区间、摘要放原位」。
- 0a 附带发现 2 实测**单轮内也在涨**（turn-2 内 +34%）：compress 当步生效会让本 turn 后续步的
  suffix 重算。**待写入计划的决策：当步生效 vs 轮界生效**——建议当步生效（立即减压才是意义所在），
  由哲学告诫模型压冷区间。

### ③ 引用号——代码事实改变了这件原语的形态
- `packages/core/src/projection.ts`：message 无 id、event 无序数 id；唯一稳定锚是 **turn id**
  （`turn_start`/`turn_end`）；tool_call 累积合并（:53-59）使 message↔event 非 1:1。
- **结论：放弃 billion-context 的逐消息引用号渲染（每条消息常驻开销），改为 turn 区间引用：
  `compress({from_turn, to_turn})`。** turn id 引擎原生、稳定、零渲染开销。

### ④ 边界语义——turn 对齐白捡协议安全
- turn 边界内天然含完整 tool_call/tool_result 组；残缺轮由 `balanceToolCalls` 兜底
  （projection.ts:159-185）→ turn 对齐则不需要新 safe-cut 机制。
- 仍需写进计划的状态模型：嵌套再压缩（新区间覆盖旧块 → 合并，摘要的摘要）；
  hide-consumed（源事件留 log、提炼照读，视图只渲染摘要块）。

### ⑤ 与 0b dedup 的交互——比纸面预想的顺利
- dedup 可见性模拟走 `log.deriveMessages()`（turn-context-dedup.ts:98），与 loop 同一个 seam
  （loop.ts:271）。**叠层加在 `packages/core/src/session-log.ts:105-106` 的 seam 内部，
  两个消费方零改动**自动看到同一视图。
- 常驻行被压缩块吞掉 → 不可见 → ③态下轮自愈重注入（dedup 模块头 :14-15 已设计好的行为）。
  压缩只把行变不可见、绝不反向 → dedup 单向安全在叠层下保持。
- 状态注入点：`PersistentSessionLog.open(dir, …)`（`packages/runtime/src/host/engine-session.ts:118`）
  ——runtime 层、会话目录在手；compression.json 侧车损坏即重置的先例见
  `apps/studio/src/runtime/session-compose.ts:514-538`（extractionCursorStore）。
- 提炼读 `log.events()` 原始事件，不受叠层影响——Phase 1 §5 的解耦在代码层面坐实。

### ⑥ 水位数据面——0a 要的「独立数据面」已经建成
- `packages/runtime/src/status.ts`：`contextUsage`（:450-479）真实 provider prompt_tokens 优先、
  否则用**与 trim 同一个估算器**的备忘录组装（`estimatedContextTokens` :393-396）；
  `contextWindowOf`（:486-490）诚实窗口（profile/fallback/unknown）；ratio4 + ContextPressure 投影。
  `/api/status` 已暴露 `context_usage{used,window,ratio,method}`。
- **nudge 触发可直接复用这条路径**——Phase 2 自研清单实际工作量比设计文档写的小一块。

## 3. 动工须知（契约面）
- `contracts/tools.json` 是工具唯一真源（当前 19 个工具）；`compress`/`decompress`/`context_status`
  必须先加契约条目（契约外名字直接抛错，`packages/workers/src/tools.ts` 有同款校验），并同步 parity fixture。
- 存量 `compactSession`（`packages/runtime/src/compact/plan.ts`）是重写式压缩，
  COMPACT_THRESHOLD=8 / COMPACT_KEEP_TURNS=4；视图叠层上线后它退役（设计文档 §5 已定）。

## 4. 计划修订清单（启动时回写设计文档）
1. 哲学并入 `config.system_prompt` 构造链（engine-profile.ts），不是 system 层运行时拼接；
   nudge 走 `buildRequest` 尾部瞬时消息（trimmedMarkerMessage 同款机制）。
2. 消息引用号方案改为 **turn 区间引用**（`from_turn`/`to_turn`），不做逐消息引用号渲染。
3. 新增「压缩的触发经济学」一节：中段替换 → suffix 缓存失效 → 低频、大块、压冷区间；
   compress 当步生效。
4. 叠层落点写死：`SessionLog.deriveMessages` seam 内；状态注入在 engine-session.ts:118 组装点；
   状态文件 = 会话目录旁挂 compression.json（损坏即重置）。
5. 水位段更新：复用 `contextUsage` 现有数据面；50% nudge + 0.8 preflight。
6. 存储与 decompress 形态按裁决：会话目录 compression.json；decompress 为模型工具。

## 5. 启动时的剩余工作（讨论中未完全展开，供开工时补）
- 压缩块 schema 细节（事件坐标区间、summary 文本、创建 turn/时间、嵌套合并规则）。
- `context_status` 工具输出形态（水位、最近压缩历史、可压缩区间提示）。
- E2E 探针验收场景清单（建议：compressible 会话 → 调 compress → 断言视图/水位/缓存指标；
  常驻行被压缩后验证 0b ③态自愈重注入）。
- 特性开关：是否照 CELESTEA_MEMORY_EXTRACTION 先例给压缩能力加 env kill-switch。
