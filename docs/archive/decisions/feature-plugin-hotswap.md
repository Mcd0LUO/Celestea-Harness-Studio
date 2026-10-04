# 插件热插拔：引擎层进清单 + 全层可换代

> 📦 **历史文档**。本文件是**已决策的归档记录**（当时的依据与验收标准），
> 2026-10-04 从 `docs/` 移入 `docs/archive/decisions/`。它**不是**现行口径：
> 当前行为看 `contracts/`、[`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md)、以及各功能对应的现行文档。
> 归档**不删除正文** —— 决策的理由仍然可查。

> 状态：**历史参考**（已实现）。本文是当时的决策记录，**不再随代码更新**。

> **归档时的落地情况**：**已实现（W9322）**。决定：2026-10-04；实现：见 §8。
> 起因：设置页「插件」的服务端一格只显示 8 个 host 装配 token，用户认不出的功能一个都不在里面。

---

## 1. 问题（已核实）

- `GET /api/plugins` 只返回 host 启动层的 8 个 plugin：`studio/workspaces` / `sessions` / `session-ops` /
  `providers` / `prompts` / `bus` / `runtime` / `settings`。它们是**服务注入 token**，不是功能。
- 真正的功能插件在 `packages/{agent-loop,core,session,swarm,tools,workers}/src/plugin.ts`（如 `@celestea/swarm`
  注册 `agent_swarm`），它们**每会话由引擎装配**，被 `apps/studio/src/plugins.ts:119-124` 的边界注释**刻意排除**。
  这是 W860 的有意设计，因此**没有任何测试会抓到它**。
- `apps/studio/src/handlers/plugins.ts:20-23`（W860 原文）把 `hot` **硬编码为 `false`**，`layer` 的类型字面量只写了 `"host"`。
  接口形状早已预留，只是从未填充。

## 2. 目标

1. 服务端 section 如实列出**引擎层插件**，并给出真实的 `hot`。
2. 三层插件都可**换代**（不是"卸载"），开关持久化、可回滚。
3. 换代**绝不原地修改活跃 Context**。

## 3. 语义（本次已拍板）

### 3.1 生效时机：**turn 边界**

开关变更后**不打断正在跑的 turn**；该会话的**下一个 turn 开始**时换代。

**为什么不能插在 turn 中间**（硬约束，来自 `packages/swarm/src/plugin.ts:8-11` 的原注释）：

> The contract (contracts/tools.json) is the single source for `GET /api/tools` and the model prompt;
> a tool that is not in the registry is not in either. A lazy registration would let the contract and the
> prompt disagree.

即：工具注册表与模型 prompt 必须在**同一个原子步**里一起换。turn 中途换代 = 模型看到一个它没有的工具。

### 3.2 三层的 `hot` 定义

| 层 | `hot` | 生效条件 | 换代代价 |
|---|---|---|---|
| 引擎层（tools / disclosure / loop / swarm / workers / watchdog）| `true` | 下一 turn 边界 | 低——本来就是每会话一代 |
| host store 层（workspaces / sessions / session-ops / providers / prompts）| `true` | 经 `applyQueue` 串行；无 in-flight 写 | 中——重开文件存储 |
| `studio/bus` / `studio/runtime` | `true` | **仅当无活跃会话** | 高——bus 是所有 SSE 的连接点 |

`hot: false` 保留给**真正不可换**的项（当前为空；将来若有硬绑定则用它表达，而不是硬编码）。

## 4. 机制：换代，不是卸载

`Context` **没有移除原语**，`Plugin` 接口**没有 unmount**。这不是阻碍，因为：

- `packages/runtime/src/compose.ts:160-162`：`compose()` 是「**一代一 compose**」，每次 `Context.root()`；
- `apps/studio/src/runtime/session-compose.ts:2`：「`compose()` for **ONE session**」（W513）；
- `packages/runtime/src/swarm-wiring.ts:157`：「compose() builds **one Runtime per session generation**」；
- `packages/runtime/src/gen.ts:46`：已有「下一代」概念；`shutdown`/`release` 已存在。

**为什么不能只换单个服务**：插件在 `mount()` 里 `ctx.require(dep)` 并把结果**捕获**进自己内部
（例如 `studio/sessions` 把 workspaces store 传给 `new SessionsStore(...)`）。
只替换 `WORKSPACES_SERVICE` 不会改变 `SessionsStore` 里的引用 → **两个 store 指向不同的世界**。
唯一安全做法：**按 mount 顺序在新 Context 里重建整代，再原子替换引用**。

## 5. 接口

仿 `GET/PUT /api/display-plugins`（W895-C1 / W9108）的既有形状，不另造轮子：

- `GET /api/plugins` → `{ ok, plugins: [{ name, layer, hot, enabled }] }`（**扩展**，`layer` 取值 `"host"`/`"engine"`）
- `PUT /api/plugins` → 替换启用表；body 与 GET 同形（`disabled: string[]`）；向后兼容：老客户端不发则保留原值
- 写入经**专用 `SerialQueue`**（与 display-plugins 同样的理由：两个并发 PUT 不能交错 tmp+rename）
- 存储层独立（对齐 `store/display-plugins.ts`）；标签与提示是前端 i18n，不走这个端点

**契约影响（必须与实现同一个 commit）**：新增 `PUT /api/plugins` 使端点计数 **70 → 71**，触发铁律 5 的
三处一致（`API_ENDPOINT_COUNT` == `contracts/endpoints.json` == `FROZEN_COUNTS`）与 route snapshot 门禁。

## 6. 验收标准

1. `GET /api/plugins` 同时含 host 层与引擎层的行，且 `hot` 逐行真实（host 层不再硬编码 `false`）。
2. 关掉一个引擎层插件后：**下一 turn** 起该工具从 `GET /api/tools` **与** 模型 prompt 同时消失；
   **正在跑的 turn 不受影响**。这条要有测试，且**改坏必须红**（变异负控制）。
3. 有活跃会话时 `PUT` 试图换 `studio/bus`/`studio/runtime` → **被拒绝并给出原因**，不是静默忽略。
4. 两个并发 `PUT` 不丢更新（对齐 display-plugins 的串行队列测试）。
5. 契约三处一致 + route snapshot 绿。

## 7. 明确不做

- 不做运行时**下载/加载外部**插件（与 `feature-display-components.md` 的"构建期装配"口径一致）。
- 不改 `Context` 的 API（不加 remove）；换代取代卸载。
- 不做插件间依赖的自动求解；mount 顺序仍是语义，沿用 `mountPlugins` 的顺序表。

## 8. 实现记录（W9322）——三处设计文档没写、但实现时必须决定的事

写在这里，因为它们**改变了本节的字面含义**，后来读文档的人不该以为它们不存在。

### 8.1 工具插件是唯一「关掉≠不 mount」的引擎插件

`resolveSeams()`（`packages/agent-loop/src/seams.ts`）把 `TOOL_REGISTRY_SERVICE` 当作
**必需 seam**，缺失时抛 `missing ToolRegistryService in context`。所以 §4 的
「按 mount 顺序重建整代」对**工具插件**不成立：不 provide 它，下一代根本跑不了第一个 turn。

落地语义因此是：注册表**照旧 provide 但里面一个工具都没有**（连 `run_code` 也没有），
并且由 `compose({ emptyTools: true })` 统一压掉三个会往注册表塞工具的地方
（tools 插件 / workers 插件 / swarm wiring）——一个布尔量，而不是三个开关
（三个开关就有三种漏一个的写法，漏掉的那个会把刚关掉的工具从后门放回来）。
`GET /api/tools` 与 prompt 的 `{{tools}}` 因此仍在**同一个 `compose()`** 里一起变空，
§3.1 的原子性约束没有被牺牲。

其余引擎插件（workers / swarm / watchdog）走 §4 的原语义：真的不 mount。

### 8.2 `Runtime.pluginNames` 曾经漏掉 swarm 插件（已修）

`compose()` 的第 4c 步真的 mount 了 swarm 插件（所以 `agent_swarm` 在注册表和 prompt 里），
但 `pluginNamesOf()` 从未把它写进 `Runtime.pluginNames`。于是「本代 mount 了哪些插件」
这份记录对**恰好是热插拔必须能关掉的那个插件**是错的。W9322 把 `swarmHost` 传进
`pluginNamesOf()`（与 `workerHost` 同形），顺序为 host → workers → swarm → watchdog。

这是清单反漂移测试（装配一个真实会话，逐名对比）当场抓出来的——手写清单的第一版
把工具插件写成 `celestea.tools`（真名是 `studio.engine.tools`），也是同一条断言抓的。

### 8.3 `invalidateAll()` 必须 bump epoch

`SessionRuntimeRegistry.invalidateAll()` 只做「标记」；真正决定要不要重组的是
`settleEpoch()`，而它的第一道门是 `entry.profileEpoch >= this.epoch()` → 直接返回。
epoch 不动时，一个空闲实例的下一次 `ensure()` 会认为「没什么要换的」并**原样返回旧代**：
开关写进去了、`engineSwitches()` 也对了，可引擎那一代根本没换。

所以 `RealRuntimeAdapter.invalidateAll()` 同时推进 `baseEpoch`——语义与一次 `configure()`
完全相同（空闲实例立即重组、在飞的 turn 只被标记），而 `ensure` / `settleDeferred` /
`sweep` 三条路都会因此重组。

### 8.4 `studio/bus` / `studio/runtime` 的「允许更换」落到了哪一步

§3.2 说这两行只在**无活跃会话**时才能换。落地实现：
- 有活跃会话（`busySessions()` 非空）时 `PUT` **被拒 409 + 原因 + `busy_sessions[]`**；
- 无活跃会话时写入被接受，并按 §3.1 的 turn 边界语义生效（同一条 `invalidateAll` 通道）。

**没有做**的是「重建 host Context 本身」：`StudioServices`（含 `bus`/`runtime` 两个字段与
已注册的全部路由闭包）是**进程启动时一次性**装配的，换掉它的实例需要重建整个
`composeStudio` 并重新注册 71 条路由——那是另一个量级的工作，且 §3.2 的验收点
（有活跃会话时必须拒绝）不依赖它。这一点在 W9322 的报告里作为「刻意没做」明列。
