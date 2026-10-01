# 记忆提炼/长对话成本 — 交接（Phase 1 已收官，待 Phase 2）

> 恢复口令：「继续 Phase 2」或「继续记忆提炼 Phase 2」。
> 唯一权威设计文档：docs/feature-memory-extraction.md（§4 方向、§5 接缝、§6 挂起项、§7 证据索引）。

## 进度全景

| 分期 | 状态 | 证据 |
|---|---|---|
| Phase 0a 基线 | ✅ | docs/baseline-phase0a.md（9 轮 91.4% 缓存命中；缓存折价后账单仅 ~21.7%；trim 现实不触发） |
| Phase 0b 常驻去重 | ✅ | ff4e812（selectTurnContextRows 三态机）+ 97abfbd 文档 |
| Phase 1 后台记忆提炼 | ✅ **已收官 2026-10-01** | 代码 98b14d8（15 文件 +1676/−19）+ 文档 d284187；runtime 52/52、tools 12/12、studio 8/8；**真通道 E2E 全 PASS**（r4.codes / deepseek-v4-flash：独立 extraction 账本行、cursor sidecar、记忆条目带 source 溯源、输出纯 JSON 归类准确） |
| Phase 2 模型驱动压缩 | ⏸ **唯一剩余分期** | 方向已定（模型驱动 + 视图叠层），**启动信号等用户裁决**（§6 第一行：0a 数据削弱了紧迫性） |

Phase 1 实现索引已写入 docs/feature-memory-extraction.md 的「Phase 1 实现分解（✅ 已实现，98b14d8）」节——六层改动、env 开关、测试矩阵、已知边界都在那里，本文件不再复述。

## 给 Phase 2 执行者的指引

### 开工前必须先做的两件事

1. **向用户确认启动信号**——§6 明确「Phase 2 启动与否 ⏸ 挂起，等真实长会话压力信号」。不要默认开工。
2. **动工前有两项裁决待用户拍板**（§6）：压缩状态存储位置（建议：会话目录旁挂 compression.json，随 session store 生命周期）；decompress 做成模型工具还是仅调试命令。nudge 水位阈值/preflight 预算也挂着（0a 数字已到，可提议用 0a 数据裁决）。

### 设计要点（docs/feature-memory-extraction.md §4 Phase 2，:256-303）

- **视图叠层，不是 log 重写**：session log 保持 append-only 原文；压缩块列表（区间+摘要）旁挂为会话级持久状态；deriveMessages() 加一级变换：log 事件 → 应用压缩块 → 模型视图。四收益：提炼/压缩解耦、天然可逆（decompress=摘块）、cursor 不悬空、摘要零额外调用（模型当轮正常输出）。
- **自研四件新原语**：①压缩状态旁挂 + derive 加一级；②原生工具 compress / decompress / context_status（search_context 可延后）；③**瞬时**哲学提示词 + 水位 nudge（**绝不走 turnContext**——turnContext 持久进 log = 复刻 billion-context「炸锅」事故；哲学走 system 层每轮重建，字节稳定不伤前缀缓存）；④消息引用号（模型视图渲染稳定引用号，锚定 log 事件 id）。
- **复用既有件**：trimContext 留作 preflight 兜底；token 估算器 context-trim.ts；cacheHitRatio（runtime/src/usage.ts:67）。
- **自研、不引 acp-kernel 依赖**：迁移概念不迁移代码。

### 行为参照与测试场景

billion-context（D:\mozin\repos\billion-context）插件模式是唯一行为参照。事故录 → 本仓测试场景：

- **#717 伪造标记**：模型在上下文压力下伪造「已压缩」确认文本而从未真调用——以状态为准，不以转录文本为准。
- **炸锅/注入持久化**：哲学与工具记录必须瞬时、每轮重建，绝不沉淀进历史；已消费的压缩记录从视图隐藏（hide-consumed 卫生）；压缩循环设轮次上限，到顶优雅完成（绝不返回空完成）。
- **防过度压缩**：稀疏记忆比略大的记忆更糟（§3 反模式 6）——哲学提示词与测试必须防住这一侧。

### 与 Phase 1 的耦合点

- 提炼永远读原始 log，两者可任意交错（§5「原核心交互已溶解」）——Phase 2 不需要为提炼让路。
- §5 的 ⛔ 两行（drain、cursor 悬空容忍）在视图叠层落地后才真正「不再需要」；落地后把 §5 注记（2026-10-01 那条）与 runtime/memory-extraction.ts:18-24 模块头一起复核，可简化则简化。
- 现 compactSession（手动 lifecycle，重写 log + 单份 .precompact 备份）在视图叠层落地后**降级为硬重置工具或退役**（§4 末段）。
- 文档收尾：Phase 2 落地后按 :3-4 维护约定更新状态行（无剩余分期则整篇归档）。

## 流程纪律（跨会话保持）

- 文档改动前先讨论，措辞给用户过目再提交；精确 pathspec add + commit -F 消息文件于 .probe/
- 不碰工作树残留：.celestea/skills/ts-development/SKILL.md、.gitignore、eslint.config.js、.codegraph/、.probe/
- vitest 从仓根跑；编辑前先 read（锚点会漂移）；run_code 裸调（不要传 sandbox_permissions）
- 通道：r4.codes，chat_completions 强制，providers.json 在 D:\celestea-data，deepseek-v4-flash 默认
- E2E 探针手法（Phase 1 实证可复用）：pnpm --dir apps/studio start 起 studio（tsx 源码直跑，packages 改动免构建），隔离数据根 D:\celestea-probe\<name>（只读复制 providers.json，绝不写真实数据根），HTTP API 建 workspace/session/turn 验证
