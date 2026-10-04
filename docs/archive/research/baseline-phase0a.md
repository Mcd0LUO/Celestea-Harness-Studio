# Phase 0a 基线报告（2026-09-30）

> 状态：**历史参考**。本文件是 Phase 0a（W7xx 记忆抽取前）的**一次性实测记录**，2026-10-04 归档到 `docs/archive/`；
> 现行口径见 [`docs/README.md`](../../README.md)。
> 📦 **历史文档**。
> 当时为什么归档：它自述"不重测时无需更新"，且引用了探针工作区 `D:\celestea-probe\ws-baseline` ——
> **本机事实不该提交进仓**。它配套的设计文档也早已归档（`docs/archive/decisions/feature-memory-extraction.md`）。

> 配套设计文档：docs/feature-memory-extraction.md（§4 Phase 0a 三问的回答）。
> 测量工件：探针工作区 D:\celestea-probe\ws-baseline；驱动/分析脚本 .probe/drive.mjs、.probe/analyze.mjs（一次性，不入仓维护）。

## 测量设置

- 引擎：apps/studio tsx 源码直跑，端口 3778，CELESTEA_HOME=D:\celestea-data。
- 模型：DeepSeek-V4-Flash 经**第三方网关 A**（OpenAI 兼容的 chat_completions；真实 base_url 见部署方本机配置，不进仓）。
- 探针工作区：2 个 skill（catalog 361B）+ MEMORY.md（368B）+ docs/src 少量文件。
- 负载：单会话 10 轮真实对话（列目录/读文件/wc/写文件/load_skill/remember/git/大文件/总结），共 47 个 LLM 步骤。
- 会话 log：158 事件，无 torn tail；usage ledger 47 条步骤行 + 10 条 turn_total。

## Q1：前缀缓存是否真在工作？——已实测：**真实工作，稳态命中率 ~92%**

**网关 A 渠道（原基线）**：47 步、累计 736,362 prompt tokens，cache_read 全为 0——网关只回 `{prompt_tokens, completion_tokens, total_tokens}`，不返回缓存计量字段（m00301 用户确认上游确实不返回）。旁证缓存存在：同前缀二次请求 705ms vs 首次 5,945ms（8.4×）。

**第三方网关 B 渠道（Q1 补测，2026-09-30）**：换用另一个第三方网关（chat_completions，模型 deepseek-v4-flash）重跑同一 9 轮负载。该网关透传 `usage.prompt_tokens_details.cached_tokens`，ledger 的 cache_read 字段端到端打通（解析点 packages/llm/src/usage.ts:74 嵌套键，流式帧同样携带 details——实测确认）。

| 轮次 | 步骤 | prompt tokens | cache_read | 命中率 |
|---|---|---|---|---|
| turn-0（冷启动） | 2 | 17,533 | 7,680 | 43.8% |
| turn-1 | 1 | 9,527 | 9,472 | 99.4% |
| turn-2 | 8 | 85,069 | 81,536 | 95.8% |
| turn-3 | 2 | 24,358 | 22,400 | 92.0% |
| turn-4 | 2 | 26,701 | 23,936 | 89.6% |
| turn-5 | 9 | 132,699 | 123,520 | 93.1% |
| turn-6 | 3 | 49,156 | 45,696 | 93.0% |
| turn-7 | 2 | 34,111 | 32,512 | 95.3% |
| turn-8 | 2 | 35,479 | 32,256 | 90.9% |
| **合计** | **31** | **414,633** | **379,008** | **91.4%** |

- 每步命中率：min 0%（会话首步）/ p50 **92.6%** / max 99.9%。除冷启动外所有轮次 89.6–95.8%。
- cache_read 以 **128 token 粒度**阶梯增长（每几步 +128），正是「每步尾部追加、前缀稳定延伸」的形状；跨轮无缝（turn_total 后下一轮首步直接 ~91%）。
- **计费含义**：按网关 B 的实际价目（in $0.14/M、cache_read $0.02/M，折价 ≈1/7）：未命中 35,625×0.14 + 命中 379,008×0.02 = 12,568 vs 全价 414,633×0.14 = 58,049（单位 $/M），等效账单 ≈ 全价的 **21.7%**。（早前按官方 1/10 折价估的 17.7% 偏低，已按渠道 /models 权威价目修正。）
- **设计回灌（实证加强版）**：append-only 重复注入不破坏前缀缓存（resident 行在 history 中段、前缀稳定），0b 去重省的是体积账单；trim/compact 的中段切除才会让缓存失效——Phase 2 触发决策必须把这个不对称性算进去。
- 注意对照组：网关 A 基线 47 步/736k tokens vs 本次 31 步/415k tokens——差距来自当时工具全灭的重试循环（见附带发现 4），不是渠道性能差异。

## 附带发现 4（渠道切换引出的引擎 bug，已修）

**网关 B 在流式 tool_call 的每个 delta chunk 重发完整 function.name**（OpenAI 规范只在首 chunk 发一次），而 packages/llm/src/stream.ts:71 的累加器对 name 做 `+=` 拼接——组合出 `"read_fileread_fileread_fileread_file"` 这样的坏名，**所有工具调用 4xx "unknown tool"**，模型陷入重试循环（首轮 53 步/248s，工作流实质未执行）。

- 复现证据：直连探针抓原始 SSE，chunk 1-4 的 `function.name` 均为完整 "read_file"。
- 修复：stream.ts name 累加改为 first-wins（`entry.name === ""` 时才赋值），附回归测试（stream.test.ts "tolerates gateways that re-send the full tool name in every chunk"，17/17 通过）。
- 修复后首轮 9s 完成（修复前 248s），工具全链路正常。
- **教训**：网关 A 合规（只发一次）所以从未暴露；换网关是最有效的兼容性测试。

## Q2：常驻上下文占每轮 token 多少？——线性堆积，第 8 轮已达 10%

每轮注入 2 行常驻上下文（skill catalog + memory），**无去重**，每轮 ~254 tokens：

| 轮次 | 常驻行累计 tokens | 当轮首步 prompt | 占比 |
|---|---|---|---|
| turn-0 | 254 | 8,457 | 3.0% |
| turn-2 | 762 | 11,936 | 6.4% |
| turn-4 | 1,270 | 17,737 | 7.2% |
| turn-6 | 1,778 | 19,725 | 9.0% |
| turn-8 | 2,286 | 23,067 | **9.9%** |

- 注入位置：每轮的 turn_start 标记**之前**（log 行序：resident 行 → turn_start → 用户输入），由 turn-runner.ts:284-290 每轮无条件 append。
- 按当前小号 catalog（254 tok/轮）外推：50 轮会话约 12.7k tokens 纯重复；真实仓的 catalog 通常大 5-10 倍，重复浪费同比放大。
- **注意最大的常驻项不是 catalog**：校准测算 system prompt（含工具 schema）约 **8,170 tokens**，占 turn-9 首步 prompt 的 34%。0b 三态机只管 turnContext 行，管不到它。
- **对 0b 设计的重要细化**：append-only 历史天然前缀稳定，重复注入的行**不破坏前缀缓存**（它们在 history 中段，每轮只在尾部追加）——去重省的是 token **体积**（有缓存时按 cache-read 折价计费），不是命中率。真正破坏前缀缓存的是 trim/compact（中段切除 → 后缀全部移位 → 缓存全失效）。这个不对称性要带进 Phase 2 触发决策。

## Q3：trimContext 触发频率？——10 轮真实负载在任何窗口下都没触发

用仓内真代码离线重放（parseSessionJsonl → deriveMessagesFrom → trimContext，threshold=0.8，keepRecent=10，systemTokens 校准值 8,170）：

| 窗口 | 阈值 | 最重轮次估算（turn-9） | 是否触发 |
|---|---|---|---|
| 65,536 | 52,429 | 20,704 | 否（31%） |
| 131,072 | 104,858 | 20,704 | 否 |
| 262,144 | 209,715 | 20,704 | 否 |
| 1,000,000（默认） | 800,000 | 20,704 | 否 |

- 增长率：首步 prompt 从 8,457（turn-0）涨到 23,792（turn-9），约 **+1,700 tokens/轮**。
- 触发点外推：64k 窗口 ≈ 第 27-30 轮；128k（DeepSeek 真实窗口）≈ 第 60-70 轮；1M 默认 ≈ 第 580 轮（事实上永不）。
- **配置缺陷（基线新发现，已修）**：原 CONTEXT_WINDOW 默认 1,000,000，真实超载时不会在 trimContext 兜底、而在 provider 硬限制处报错。已修为**元数据驱动**：provider-target 启动接线（优先级 env CELESTEA_CONTEXT_WINDOW > providers.json 模型条目 context_window > fallback），fallback 常量降到保守 131_072（wrong-low 只早 trim、可观测；wrong-high 才静默超窗）。关键细化：窗口是**渠道属性不是模型族属性**——网关 B 的 /models 实测全部标称 1,048,576（官方 DeepSeek API 为 ~128k），故 providers.json 应按各渠道 /models 的权威值填写（本部署已按两条渠道分别写 1048576 与 131072）。
- 对 Phase 2 的含义：压缩触发**不能指望** trimContext 临近触发作为前置信号——现实会话长度分布下 trim 几乎不动作。压缩的水位监测需要独立的数据面。

## 附带发现

1. **run_shell 在 Windows 上不可用**：沙箱降级（bwrap not found → userspace fallback）且 stdout 回调为空。turn-0 一个简单列目录花了 8 步，模型发现 run_shell 无输出后绕行 list_dir/read_file。Windows 用户体验与 token 浪费的双重问题，与本文档路线无关但值得单独开 issue。
2. **单轮内 prompt 也在涨**：工具循环每步把 tool_call/tool_result 追加进历史，turn-2 内从 11,936 涨到 16,028（+34%）。多步轮次的缓存前缀同样稳定（append-only），但体积账单按步累计。
3. 10 轮总计 736k prompt tokens；若缓存按 90% 命中、命中折价计费，新鲜 token 成本约 1/10——这就是"缓存存在且值钱"的数量级旁证。

## 对路线图的回灌

- Phase 0b（去重）：价值得到量化支持——重复常驻上下文 8 轮内到 10%，且随轮数线性恶化。继续做。
- Phase 1（提炼）：不受影响，按文档执行。
- Phase 2（压缩）：①触发信号需自建水位数据面，不能复用 trim；②trim/compact 破坏前缀缓存的不对称性进入触发决策；③~~窗口配置修正~~（已完成：元数据驱动接线 + fallback 131_072，见 Q3 配置缺陷条）。
- Q1 已实测闭合（第三方网关 B，91.4% 综合命中率）。前缀缓存是真实且巨大的成本杠杆：本仓的成本叙事（0b 省体积、Phase 2 压体积）都应按「缓存命中折价后的边际成本」来算账。
