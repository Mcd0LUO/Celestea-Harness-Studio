# 插件热插拔：引擎层进清单 + 全层可换代

> 状态：**设计（待实现）**。决定：2026-10-04。
> 起因：设置页「插件」的服务端一格只显示 8 个 host 装配 token，用户认不出的功能一个都不在里面。

---

## 1. 问题（已核实）

- `GET /api/plugins` 只返回 host 启动层的 8 个 plugin：`studio/workspaces` / `sessions` / `session-ops` /
  `providers` / `prompts` / `bus` / `runtime` / `settings`。它们是**服务注入 token**，不是功能。
- 真正的功能插件在 `packages/{agent-loop,core,session,swarm,tools,workers}/src/plugin.ts`（如 `@celestea/swarm`
  注册 `agent_swarm`），它们**每会话由引擎装配**，被 `apps/studio/src/plugins.ts:94-96` 的边界注释**刻意排除**。
  这是 W860 的有意设计，因此**没有任何测试会抓到它**。
- `apps/studio/src/handlers/plugins.ts:21-22` 把 `hot` **硬编码为 `false`**，`layer` 的类型字面量只写了 `"host"`。
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
