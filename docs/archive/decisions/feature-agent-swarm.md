# feature-agent-swarm · 批量并行子代理（agent_swarm 工具）

> 📦 **历史文档**。本文件是**已决策的归档记录**（当时的依据与验收标准），
> 2026-10-04 从 `docs/` 移入 `docs/archive/decisions/`。它**不是**现行口径：
> 当前行为看 `contracts/`、[`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md)、以及各功能对应的现行文档。
> 归档**不删除正文** —— 决策的理由仍然可查。

> 状态：**历史参考**（已实现）。本文是当时的决策记录，**不再随代码更新**。

> **归档时的落地情况**：**已实现**。本文是**全范围一次性执行计划**：A→B→C→D→收口 是内部依赖顺序标签，
> 不是分批发布——一次做完，一次验收。落地前不改任何代码。
>
> 决策基线（用户已拍板，2026-10-02）：① 形态 = 内置工具（新 L1 包 `packages/swarm`）；
> ② 成员载体 = 轻量并行 turn；③ 前端面板一起做（vanilla TS 重写）；④ 一次性交付。
>
> **落地后的三处偏离**（实现与本文的差异，实现为准，本文已同步）：
>
> - **§3.3 排他约束的落点**已定（R5 关闭）：**工具内自检**（`tool.ts` 的进程级 in-flight 窗口），
>   不改 `agent-loop` 的 `dispatchToolCalls`。取舍：同一步内并发能抓到，跨 step 抓不到 —— 工具看不见
>   step 边界。宁可漏（模型已违约、契约文案已声明）也不跨轮误报。
> - **§4 的 `maxConcurrency` 默认 16 是行为变更**，不只是配置：源仓默认 `undefined`（无上限），
>   本仓没有宿主派发池兜底，这道闸门是唯一防线。搬运的「128 成员」规模用例据此改写为显式
>   `maxConcurrency: 128`（前提适配，断言未动），另补一条「缺省 16 真的生效」的新断言。
> - **§5.4 的「登记五处」实为九处**：漏任一处门禁静默失效。实跑补出 `vitest.config.ts` 的 alias、
>   `tests/contracts.test.ts` 的计数、`eslint.config.js` 的第二份 `TIER1`、`contracts/endpoints.json`
>   里写死的工具数、`packages/tools/src/exposure.test.ts` 的三处数组。
>   另有一处 fail-closed 常量：`packages/core/src/contracts/index.ts` 的 `FROZEN_COUNTS.tools`，
>   不与 `tools.json` 同步则**宿主启动即炸**。

---

## 1. 背景与来源

把「swarm 批量子代理」能力适配进本仓：一次工具调用把 N 个同形子任务展开为并行子代理，
带自适应限流调度与结构化结果汇总。

来源是开发机上的 clean-room 实现仓 **dsh-agent-swarm**（本机路径见 `docs/AGENT.local.md`，
不入库），本身是 Kimi Code swarm 功能的 clean-room 重写。适配继承其合规约束：

- 上游 v2 源码**继续封存**；实现只依据机制文档与 MIT 许可的 v1/协议层切片；
- 工具描述与提示词文案**不得照抄上游**，按本仓口径重写；
- **搬运主线修复后版本**：纯逻辑层（校验 / 调度器 / XML 渲染 / 状态机 / 安全截断）从
  dsh-agent-swarm 搬，含后期修复（`maxRateLimitRetries`、双重判死、`text-clip.ts`
  UTF-16 安全截断）；宿主集成层（DSH 的 ctx.subagents / schemastery / typert）**全部重写**。

## 2. 定位：与 worker 的分工

| | `agent_swarm`（本特性） | `spawn_worker`（既有） |
|---|---|---|
| 语义 | 一批同形子任务，one-shot 批处理 | 一个常驻协作会话 |
| 数量 | 2–128 个成员 | 单发 |
| 状态 | 无注册表行、无回执文件、无持久会话 | registry.tsv + 回执 + 邮箱 |
| 结果 | `<agent_swarm_result>` XML 一次性汇总 | 报告文件 + 邮箱回执 |
| 可见性 | 状态栏面板（§7）+ XML | `worker_status` + 会话树 |

两者并存，互不改写对方行为。编排原则：常驻协作找 worker，批量同形任务找 swarm。

## 3. 工具契约

工具名 `agent_swarm`，第 23 个工具；spec 进 `contracts/tools.json`（唯一真源，与
`workerToolSpec` 同款加载——缺条目要在启动时炸响），并**显式登记进
`EXECUTION_TOOL_NAMES`**（`packages/tools/src/exposure.ts`；编排工具，执行模式下折叠
会让它不可达——与 `load_skill` 进保留名单同一判据，ARCHITECTURE §7.1 第 3 步）。

### 3.1 参数（只带四个）

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `description` | string | ✅ | 整批任务的简短描述（trim 后非空） |
| `prompt_template` | string | 有 items 时必填 | 含精确占位符 `{{item}}` |
| `items` | string[] | ✅ | 2–128 项，每项 trim 后非空 |
| `model` | string | 否 | 批次级模型路由，按 `LlmRegistry` 名字解析；缺省继承当前会话模型 |

**刻意不带**：`subagent_type`（本仓无 agent profile 概念）、`fork`（本仓无 fork 机制）、
`resume_agent_ids`（后续视需要另行设计，本仓会话机制天然支持续跑）。

### 3.2 六道硬校验（全部在启动任何成员之前拒绝）

1. `items.length >= 2`；2. `items.length <= 128`；3. 有 `items` 必有 `prompt_template`；
4. 模板必含字面量 `{{item}}`；5. `split("{{item}}").join(item)` 展开后 prompt 互不相同；
6. 每个 item 是非空字符串。

校验失败返回结构化错误信封 `{ok:false, step:"validate", error}`（失败是结果不是异常，
ARCHITECTURE §6.2），模型可自纠正。

### 3.3 排他性约束

同一轮回复里 `agent_swarm` 必须是**唯一**工具调用：与其他工具并发、或与第二个
`agent_swarm` 并发，都拒绝并提示模型改为串行（上游 v2 veto 的同款语义，在本仓工具
执行入口前置判定；落点在 `packages/agent-loop` 的工具调用分发处或 swarm 工具自身的
批次内检测——实现时选一处，注释写明判据）。

## 4. 调度语义

调度器从 dsh-agent-swarm 的 `scheduler.ts` 搬运（801 行，按 §4.2 拆分见 §5.1）。
语义参数（全部进 `SwarmSchedulerConfig`，常量默认值照上游实测）：

| 参数 | 默认 | 说明 |
|---|---|---|
| 首波并发 | 5 | 启动瞬间最多连发 5 个 |
| 放量间隔 | 700ms | 首波后每 700ms 放 1 个 |
| 退避基数 | 3000ms × 2ⁿ | 单任务限流退避，**加 jitter**（×(0.5+random×0.5)，规避上游 D5 雷暴） |
| 容量收缩防抖 | 2000ms | 2 秒内不重复扣减 |
| 容量恢复 | 每 180s +1 | 无上界（dsh-agent-swarm 决策笔记已论证：上限会把一次抖动固化成永久锁 1） |
| `maxConcurrency` | 可配，默认 16 | **真实接线**——本仓没有宿主派发池兜底，这道闸门是唯一防线；构造期校验 ≥1 |
| 每任务超时 | 2h 可配；**0 = 禁用** | 调度器超时闸门 abort 成员信号，与用户中断级联共用取消通道（规避上游 D8 歧义） |
| 限流重试上限 | 默认 3 | per-task；配合「≥2 成员持续限流」双重判死 |

**限流信号（本仓的净收益）**：成员 `Llm.generate` 抛出的 `LlmError` 同步携带
`httpStatus` / `retryable`（`packages/llm/src/errors.ts`，429/408/425 已在
RETRYABLE_HTTP_STATUSES）。executor 捕获后按此分类，限流分支**默认开启**——
DSH 版因宿主不透传错误码只能默认关闭，本仓无此约束。

## 5. 执行器与装配

### 5.1 新包 `packages/swarm`（L1，只依赖 `@celestea/core`）

```
packages/swarm/src/
  index.ts            公开面（带 module map 注释，ARCHITECTURE §2.2 硬性要求）
  types.ts            SwarmTaskSpec / SwarmTaskResult / SwarmSchedulerConfig / 七态相位
  validate.ts         六道硬校验 + 模板展开（搬运，343 行，无需拆）
  text-clip.ts        UTF-16 安全截断唯一出口（搬运）
  scheduler/          调度器拆三块（801 行超 450 红线）：
    core.ts             主状态机（正常模式放量）
    rate-limit.ts       限流模式（收缩/退避/恢复/判死）
    index.ts            runSwarm 入口 + 类型重导出
  result-xml.ts       XML 渲染（搬运，309 行）
  roster.ts           成员七态状态机 + 100ms 合帧（由 swarm-registry.ts 裁剪搬运：
                      去掉 DSH remote 协议部分，只留状态机 + 订阅）
  executor.ts         轻量 turn 执行器（新写，§5.2）
  tool.ts             agent_swarm 工具实现：校验 → 装配调度器 → 返回 XML（新写）
  plugin.ts           Context 注册 + SwarmWiring（新写，§5.3）
```

每个模块配同级 `*.test.ts`；搬运模块的测试**从源仓随码搬**，拆完后必须原样绿
（防拆分漂移的唯一抓手）。

### 5.2 轻量 turn（成员执行单元）

每个成员 = fresh `Context`（`packages/core/src/context.ts`）+ `InMemorySessionLog`
（`packages/session/src/log/memory.ts`）+ 一次性 `AgentLoop` 跑展开的 prompt。
不落盘、不进 worker 注册表、不产生回执文件。

三条从事故里学来的铁律（dsh-agent-swarm 决策笔记实证，写进 executor 注释）：

1. **executor 契约：resolve=成功，throw=失败**——返回失败对象会让 XML 把失败谎报成 completed；
2. **成员终态只认批次信号**：`batchSignal.aborted ⇒ "aborted"`，否则 `"failed"`——
   超时闸门 abort 的正是成员信号，超时与中断同形，认成员自报必错判；
3. **取消必须清扫队列**：批次取消时遍历 pending 成员显式落定 cancelled，
   否则面板相位永久卡 queued（上游 D6）。

**成员工具集** = 宿主会话工具集**剔除编排类工具**（`agent_swarm`、`spawn_worker`），
防嵌套（等价上游 maxDepth=1 守卫）。权限继承宿主会话，guard 链自然生效。

**模型路由**：`model` 参数按 `LlmRegistry` 名字解析（last-wins，`packages/core/src/llm.ts`）；
解析不到 → 结构化报错，**不静默回退**（诚实降级）。不引入 DSH 的白名单概念。

### 5.3 装配（`packages/runtime/src/compose.ts`）

照 `WorkerWiring` 的同款模式加 `SwarmWiring`（`swarm?: SwarmWiring | false`，
宿主可关）：compose 期把 `Llm` / `ToolRegistry` / `AgentLoop` 三个 seam 注入 swarm
插件，插件把 `agent_swarm` 工具注册进工具注册表。`apps/studio` 零改动
（路由不感知工具——除了 §7 面板需要的状态栏数据源）。

### 5.4 新包登记五处（漏一处就有一道门禁静默失效）

| # | 位置 | 动作 |
|---|---|---|
| 1 | 根 `tsconfig.json` paths | +`"@celestea/swarm"`（对齐现有 9 条的写法） |
| 2 | `.dependency-cruiser.cjs` 第 15 行 `TIER1` | +`"swarm"`（自动获得 entry-only / no-relative / tier1-no-peer-deps 保护） |
| 3 | `scripts/release-check.mjs` 第 34–45 行 `PACKAGES` | +`packages/swarm` 条目；同步改「9」的计数口径注释与日志文案 |
| 4 | `packages/swarm/package.json` | 按现有 L1 包模板：`publishConfig.access=public`、`files`、版本与全仓一致 |
| 5 | `docs/ARCHITECTURE.md` | §1.1 层级表 + §2.1 包职责表各加一行 |

`pnpm-workspace.yaml` 是 `packages/*` 通配，无需改。

## 6. 结果聚合（XML 契约）

```xml
<agent_swarm_result>
<summary>completed: 2, failed: 1, aborted: 1</summary>
<subagent item="src/a.ts" state="started" outcome="completed">结果文本…</subagent>
<subagent item="src/b.ts" state="started" outcome="failed" stop_reason="rate_limited">…</subagent>
<subagent item="src/c.ts" state="not_started" outcome="aborted">…</subagent>
</agent_swarm_result>
```

- **没有 `index` 属性**（落地修正）：`<subagent>` 只渲染 `agent_id` / `item` / `state` /
  `outcome` / `stop_reason`。1-based 编号由**渲染前的对齐断言**保证
  （`findIndexAlignmentMismatch`：1 起始、连续、与数组位置一一对应），不作为属性下发。
  本节的样例曾写 `index="1"`，那是计划期的笔误 —— 真机端到端（`swarm-live.test.ts`）
  以实际渲染形状为准。
- `<summary>` 只列计数 > 0 的项；
- **属性全转义**（`&` `<` `>` `"` 加 `\r` `\n` `\t` 的字符引用——裸写这三个会被 XML 属性值规范化替换成空格，静默失真）；
- **body 是最小转义**：只转义 `&` 与 `<`，并劈开裸 `]]>`（CDATA 终结符），非法控制符按 XML 1.0 §2.2 剥离。`>` 与引号在文本节点不构成解析歧义，全转会毁掉 `a > b`、`"quoted"` 这类结果文本的可读性——而这段正文正是模型与人阅读成员产出的地方。属性侧才全转义。
- `outcome`：completed / failed / aborted；`state`：started / not_started；
- 取消文案区分 `started`（运行中被取消）与 `not_started`（未启动即取消），各自固定；
- XML 是成员状态的**唯一权威口径**，面板只是过程可见性（两端结论冲突时以 XML 为准）。

## 7. 前端面板（vanilla TS）

### 7.1 数据通道（不加 SSE 事件名——冻结线）

`packages/core/src/types.ts` 第 358 行的 `Statusline` 增**可选**字段
`swarm?: SwarmRosterView`（批次描述、模型标签、成员相位数组、done/total 计数）；
`apps/studio` 组装 statusline 时从 `SwarmRegistry` 服务读取（未挂载 swarm 插件则缺省，
字段缺省 = 前端零渲染）。`contracts/data-files/` 不动（纯内存态，不落盘）。

### 7.2 UI 落点

- **状态栏徽标**：按 `apps/web/src/statusline/goal.ts` 的既有模式（badge 元素 + 字典文案），
  有活跃批次时显示 `{done}/{total}`；
- **弹层**：点击徽标展开成员列表——按相位四组（进行中/失败/已完成/已取消）各自独立折叠
  （前两者默认展开）、批次模型标签、多批次切换；聚合阈值照上游：同一次调用 ≥2 成员才聚合成
  swarm 卡片；
- **帧纪律**：roster 更新**不进 frame-budget 队列**（高频进度帧直接派发，
  dsh-agent-swarm 审查的已知权衡）；100ms 合帧由后端 roster 做；
- **门禁合规**：文案全部走 zh/en 字典（新增 `statusline.swarm.*` 一组键，两语言对称）；
  新模块遵守 450 行红线；禁止裸写中文（check-ui-copy 会拦）。

## 8. 全范围任务清单（执行图）

接口已全部在本文冻结（参数表 §3、调度参数 §4、XML 形状 §6、SSE 字段 §7.1），
四道并行、互不写同一文件：

```
Lane A 纯逻辑搬运      Lane B 执行器+装配      Lane C 契约与登记      Lane D 前端面板
 packages/swarm 的      packages/swarm 的       contracts/tools.json    apps/web/src/statusline/
 validate/text-clip/    executor/tool/plugin    exposure.ts             swarm.ts + 弹层组件
 scheduler/result-xml  + compose.ts 接线        tsconfig/depcruise/    + 字典 + types
 + 搬运测试            + executor 测试          release-check/README/
                                              ARCHITECTURE/docs 地图
      │                      │                      │                     │
      └──────────┬───────────┴──────────┬───────────┘                     │
                 ▼                      ▼                                 │
          集成：A+B 组装成工具      C 的契约计数对齐                    D 等 B 的
          （同一包内汇合）          （tools.json count=23）            SSE 字段联调
                 └──────────────────────┬───────────────────────────────┘
                                        ▼
                          收口：全量 pnpm check 绿 + 真机验收（§10）
```

| Lane | 文件边界（只许动这些） | 完成标准 |
|---|---|---|
| A | `packages/swarm/src/{types,validate,text-clip,result-xml,roster}.ts`、`scheduler/**`、对应测试 | 搬运测试原样绿；无超线文件 |
| B | `packages/swarm/src/{executor,tool,plugin}.ts` + 测试、`packages/runtime/src/compose.ts` | executor 三铁律各有专测；compose 可装配 |
| C | `contracts/tools.json`、`packages/tools/src/exposure.ts`、根 `tsconfig.json`、`.dependency-cruiser.cjs`、`scripts/release-check.mjs`、根 `README.md` 工具表、`docs/ARCHITECTURE.md`、`docs/README.md` | 契约计数断言绿；ARCH_STRICT 例外表不新增 |
| D | `apps/web/src/statusline/swarm.ts`（新）、弹层组件、`apps/web/src/i18n/locales/{zh,en}/`、`packages/core/src/types.ts`（Statusline 可选字段）、`apps/studio` 状态栏组装处 | check:web 七关绿；字典对称 |
| 收口 | 全部 | §10 验收 |

依赖边只有两条实质的：D 的联调依赖 B 的 SSE 字段实现（但 D 的 UI 与字典可先按本文冻结的
字段形状写）；B 依赖 A 的 `types.ts`——A 先交 `types.ts`（第一步），其余并行。

## 9. 契约同步清单（逐条打勾）

| 文件 | 变更 | Lane |
|---|---|---|
| `contracts/tools.json` | +`agent_swarm`（count 22→23，参数表按 §3.1） | C |
| `packages/tools/src/exposure.ts` | `EXECUTION_TOOL_NAMES` +`agent_swarm` | C |
| 根 `tsconfig.json` / `.dependency-cruiser.cjs` / `scripts/release-check.mjs` | 新包登记三处（§5.4） | C |
| `packages/swarm/package.json` + `src/` | 新包本体 | A/B |
| `packages/runtime/src/compose.ts` | SwarmWiring 装配 + 顺序注释 | B |
| `packages/core/src/types.ts` | `Statusline.swarm?` 可选字段 | D |
| 根 `README.md` | 工具表 22→23、能力清单加一行 | C |
| `docs/ARCHITECTURE.md` | §1.1 / §2.1 加 `packages/swarm` 行 | C |
| `docs/README.md` | 本文状态随落地回写 | 收口 |

## 10. 验收（一次性收口，全过才算完）

### 10.3 的真实执行结果（2026-11，自动化）

§10.3 的三项已用**真实引擎**（生产 app + 真实 HTTP + 真实 loop 与工具，只把 provider 上游
换成脚本化 mock）跑过，证据在 `apps/studio/src/runtime/swarm-live.test.ts`：

| 项 | 结果 | 证据 |
|---|---|---|
| 3 成员批 + XML 编号 | ✅ 绿 | 三个成员按原始 item 顺序渲染、正文回来、summary `completed: 3`；上游被打 ≥4 次（证明没走离线假件） |
| 20 成员压测 | ✅ 绿 | 20 个成员全部落终态、顺序与 items 逐条对齐、无悬挂成员 |
| 人为 429 → 退避 | ✅ 绿（修过一次真缺陷） | 见下 |
| 面板截图 | ✅ 绿 | `scripts/perf/swarm-panel-shot.mjs`：徽标 60×16、弹层 360×206、像素级验证四角未被裁 |

**真机跑出来的两个真缺陷**（单元测试与变异负控制全绿时它们都存在）：

**① 工具压根没注册（致命）。** `session-compose.ts` 从没把 `swarm` 传给 `compose()`，
而 `ensureSwarmWiring` 没有 wiring 对象就什么都不挂 ⇒ 生产里是 `unknown tool: agent_swarm`。
所有单元测试都绿，因为它们直接调 `swarmTool()`，**绕过了整条装配链**。
修法：`session-compose.ts` 传 `swarm`（`compose()` 侧自行注入 loopFactory 与 agentConfig）；
`SwarmWiring.agentConfig` 改可选，并在 `ensureSwarmWiring` 加 fail-closed 守卫。

**② 限流退避在真实链路上从未触发。** provider 的失败发生在**中途**时不会成为 throw ——
`loop.ts` 把它记成 step 的终态（`out.terminal = {error:{kind:"stream",…}}`）后 `break`，
`runTurn` 是 **resolve** 的。于是 executor 找不到 assistant 消息，抛出的是一条普通 `Error`，
`isRateLimitErrorFromLlmError` 永远看不到 429，§4「退避默认开启」这条决策是空转的。
修法：executor 新增 `terminalErrorOf(log)` 读 turn 的终态状态，并抛出带 `retryable` 标志的
`SwarmMemberFailedError`；`tool.ts` 的限流判定先认这个标志。
实测退避间隔 **3022 / 3017 / 3004ms**，正是 `retryBaseMs=3000` × 抖动上界 1.0。
变异负控制：`retryBaseMs` 改成 0 ⇒ 断言红（`expected 0 to be greater than or equal to 2`），
且用例耗时从 12s 掉到 3s —— 断言有牙齿，不是空转。

**这两条合起来是本特性最重要的一条教训**：四道 Lane 全绿、240 个单元测试全绿、
每条新断言都配了变异负控制 —— 功能在真实使用中依然是坏的。
**「装配链真的通」只能由起真实引擎的那一层证明。**

两种证据形态的分工：单元测试直接调 `swarmTool()`（**绕开装配链**），
`swarm-live.test.ts` 起的是**生产 app**（真实 HTTP / 真实 loop / 真实工具，只把 provider 上游
换成脚本化 mock）。上面两个缺陷就藏在两者的差别里。

1. **门禁**：全量 `pnpm check` 绿（含 check:web 七关）；
   `ARCH_STRICT=1 pnpm lint` 的例外清单不新增；
2. **测试**：搬运测试原样绿 + 新增测试覆盖：六校验分支、排他约束、executor 三铁律、
   限流退避（fake timers）、取消清扫、XML 转义往返、1-based 编号；
   每条新断言配变异负控制（AGENT.md §2）；
3. **真机**（本机跑，注意 PATH 无 `sh` 的环境差异，见 `docs/AGENT.local.md`）：
   起服务 → 真实会话调 `agent_swarm` 跑 3 成员批 → XML 编号对齐、面板徽标与弹层正确
   （headless+CDP 截图，非零几何断言，铁律 3）→ 20 成员资源压测 →
   人为 429（mock provider）验证退避实际触发；
4. **文档**：本文回填实现状态；README 数字由 readme-claims 门禁核对。

## 11. 上游陷阱规避表（落地时逐条对照）

| # | 上游缺陷 | 本仓对策 |
|---|---|---|
| D1 | body 不转义 → 含 `</subagent>` 的输出吞掉整卡 | 写入端全转义（§6） |
| D2 | 编号 1-based/0-based 双基准错位 | 1-based 钉进契约测试（§6） |
| D3 | 模式退出提醒移除静默失效 | 不做模式状态机，缺陷无载体（§12） |
| D4 | 纯 resume 跳过模型校验 | resume 后续设计时校验上提（§3.1） |
| D5 | 退避无抖动 → 重试雷暴 | jitter（§4） |
| D6 | 取消时队列成员永久卡 queued | 取消清扫队列（§5.2） |
| D7 | 嵌套 swarm 越界 | 成员工具集剔除编排工具（§5.2） |
| D8 | 超时 `0` 的语义分叉 | 显式定义 0=禁用（§4） |

## 12. 非目标

- 不做成员持久化 / 崩溃恢复（轻量 turn 无状态；中断即整批取消，与上游一致）；
- 不做 fork 上下文；不做 `resume_agent_ids`（另行设计）；不做模式状态机与 `/swarm` 命令；
- 不动 worker 系统任何既有行为；不复刻 Kimi UI；
- 不做跨会话 swarm 状态持久化（roster 纯内存，重启即清）。

## 13. 风险与未验证假设

| ID | 项 | 状态 | 兜底 |
|---|---|---|---|
| R1 | 128 个并行 LLM 流的资源开销 | 未实测 | §10 含 20 成员压测；`maxConcurrency` 兜底 |
| R2 | scheduler 拆分引入行为漂移 | 风险 | 测试随码搬，拆完原样绿 |
| R3 | 面板重写量 | 749 行 React → vanilla | UI 按 goal.ts 既有模式从简，先可用后美化 |
| R4 | 成员并发触发 provider 429 风暴 | 未实测 | 限流退避默认开 + jitter |
| R5 | 排他约束的落点（agent-loop 分发处 vs 工具内自检） | 实现时定 | 两处二选一，注释写判据（§3.3） |
