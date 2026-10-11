# MCP 客户端（设计）

> 状态：**设计**（目标设计与验收标准；P0 的代码尚未开始）。
> 本文是「把 Model Context Protocol 接进本仓」的决策依据与落地口径；
> 生效的分层规则见 [`ARCHITECTURE.md`](../ARCHITECTURE.md)，配置面见 [`configuration.md`](../configuration.md)，
> 数据文件 schema 见 [`data-files.md`](../data-files.md)，依赖申报见 [`DEPENDENCY-POLICY.md`](../DEPENDENCY-POLICY.md)。
> 参考实现来自两个外部仓（deepseek-harness / ZCode），本文只引述它们的**设计结论**，不引述它们的代码路径事实。

## 0. 结论速览

| # | 议题 | 裁决 |
|---|---|---|
| D1 | 边界 | **只做 MCP 客户端**（连外部 server）。服务端（把本仓工具以 MCP 形态暴露）P0/P1 都不做 |
| D2 | 协议实现 | 引入官方 SDK（`@modelcontextprotocol/client`），关在一个 `McpTransport` 缝后面；按 `DEPENDENCY-POLICY.md` §7 登记新的外部运行时依赖 |
| D3 | 配置面 | `<CELESTEA_HOME>/mcp.json`（全局）+ `<CELESTEA_HOME>/workspaces/<ws>/mcp.json`（每工作区覆盖）；schema 进 `contracts/data-files/` |
| D4 | 契约 | MCP 工具名 `mcp__<server>__<tool>`，**不进** `contracts/tools.json`、**不动** `FROZEN_COUNTS`；豁免本身由一条新断言守住 |
| D5 | 模型可见面 | 常驻（enabled 即披露）+ 走 `DisclosurePolicy` 的 turn 边界/只增/尾部追加；`execution` 模式**不折叠** |
| D6 | 权限 | 与内置工具**同一条 guard 链**（`PathGuard` / `toolDeny` / 权限档位一律生效）；配置即信任，不额外加审批——**与参考实现的方向性分歧**，理由与代价见 §7.1 / §11 |
| D7 | 运行模型 | 每会话一代独立连接，随会话 release 回收；配置热更在**换代**时生效 |
| D8 | P0 切法 | tools 面 + `stdio` 与 Streamable HTTP；P1：resources 与 server instructions；明确不做：prompts 模板、elicitation、tasks、resource 订阅、OAuth |
| D9 | 交付 | 本文 + 分期 + 改动面 + 验收标准；代码留给后续波次 |

P0 的契约数字**一处不动**：`contracts/endpoints.json` 的 `count` 保持 72（`contracts/endpoints.json:31`）、
`FROZEN_COUNTS.endpoints` 72 / `sseEvents` 10 / `tools` 23（`packages/core/src/contracts/index.ts:175`）。
这不是巧合：MCP 的开关复用已有的插件与工具端点（§8），MCP 的工具是**动态工具**而不是契约工具（§5）。

---

## 1. 为什么是「只做客户端」

三种可能的边界，裁决如下：

| 边界 | 裁决 | 理由 |
|---|---|---|
| 客户端（消费外部 server 的工具） | **做** | 生态里的能力（记忆、浏览器、第三方 SaaS）都长在 MCP 上；自己重写一遍不现实 |
| 服务端（本仓工具以 MCP 形态暴露） | **不做** | 要新增监听面、鉴权模型与多租户口径，而本仓的宿主已经有 HTTP 契约（72 端点）作为唯一对外面；再开一个协议面 = 第二套对外契约与第二套安全模型 |
| MCP 的 prompts / elicitation / tasks / 订阅 / OAuth | **P2 及以后，默认不做** | 前三者与「提示词库 / `ask_user_question` / worker 编排」在本仓各有更强的主人；订阅与 OAuth 是独立的安全面。诚实登记为「不做」，而不是「待定」 |

---

## 2. 参考实现（外部仓的结论，以及我们借什么）

### 2.1 deepseek-harness（DSH）

- **分包**：一个 `mcp-client` 包 = **单个 server 的一条连接插件**，另有一个独立的 `mcp-resources` 包提供**共享**的资源工具与 provider 选择（第一个 provider 启用共享工具，最后一个移除）。
- **不发布共享服务**：client 不提供 `ctx.mcp` 之类的中心服务，它是工具注册表的使用者。
- **命名**：公开工具名**包含所配的 server 名**，因此两个 server 的同名工具天然不冲突。
- **传输与协议**：`stdio` 与 Streamable HTTP 都走官方 SDK（`@modelcontextprotocol/client`）负责协商、发现、协议校验与取消；产品侧**没有**强制协议版本的设置。
- **失败语义**：工具列表刷新失败**保留上一代**；`tools/list_changed`（旧通知或新式订阅）触发重新发现。
- **instructions**：server 的 instructions 作为**带 server 署名的一节**进 system prompt，发布前过 `maxInstructionBytes`；没有 instructions 就**不加节**。
- **结果适配**：保留 canonical MCP JSON；图片走附件系统；**不支持的富内容产出显式文本诊断**（不静默丢弃）。
- **明确不支持**：prompts 模板、elicitation、task 型执行、resource 订阅。
- **配置归属**：server 身份/进程或端点/凭据/环境、以及超时、启动失败策略、重连，全部是 client 配置；resources 服务本身**没有配置字段**。

**可迁移的细节（本段行号属于外部仓；已抽验源码后并入）**

- **命名归一化**：非法字符 → `_`；若归一化或长度截断**改变了名字**，追加 12 位 sha256（`mcp-client/src/tools.ts:81-87`）。命名空间取自**本地配置**，刻意不用远端 `serverInfo.name`（不可信 / 跨部署不唯一 / 升级会变）。
- **配置字段与默认值**：`serverName`（`^[A-Za-z0-9_-]{1,32}$`）、`command/args/env/cwd`、`toolCallTimeoutMs` 默认 60s、`failOnStartupError` 默认 false、`maxInstructionBytes` 默认 32 KiB、`reconnect` 默认 `{enabled:true, initialDelayMs:500, maxDelayMs:30000, maxAttempts:10}`（`mcp-client/src/index.ts:119-142`）；同作用域重名 `serverName` **启动即错**。
- **两阶段 swap 的边界**：fetch 失败**不动注册表**（上一代原样保留）；swap 时先 dispose 上一代再注册；注册撞名（外部工具占了本 server 的命名空间）**整代回滚**；server 返回重复 raw name → 整表拒绝（`mcp-client/src/tools.ts:89-113`）。
- **退避与预算**：`min(maxDelay, initial * 2^(n-1))`；一次故障共享预算；连上并**活过稳定窗口（= maxDelay）**才重置预算（`mcp-client/src/connection.ts:211-245`）。
- **短暂断连不动模型面**：只在**最终放弃**时才注销工具——每次崩溃抖一次 schema 前缀是净亏，失败的调用本身就说明了问题。
- **HTTP ≠ stdio 的重连语义**：HTTP 的逐请求失败**不进**监督器（传输自带 SSE 恢复，且没有子进程可拉起）。
- **关闭**：5 秒有界等待 + fail-closed（宁可停止重连，也不让两个进程重叠）；重连定时器 `unref`。
- **子进程环境**：`{...scrubbedParentEnv(), ...config.env}` —— 先清洗父环境（`/KEY|PASSWORD|SECRET|TOKEN/i` 与 `DSH_` 前缀），再合显式配置（`mcp-client/src/transport.ts:21-23`）；**真正的 spawn 由 SDK 拥有**。
- **instructions 超限 = 拒绝连接**（不是截断）（`mcp-client/src/connection.ts:318-322`）。
- **无并发上限**：隔离来自「一 server 一插件实例 + 一监督器」的结构，不来自限流。
- **服务端延后**：DSH 已有 ACP 桥把 harness 当 agent server 暴露，再加 MCP server 是「用另一协议重复同一件事」。

### 2.2 ZCode

- **配置作用域三层**：`common` / `user` / `workspace`，并带一份 `projects`（工作区路径 → server 表）映射；每条 server 有 `enabled` 开关与 `status` 枚举（`connected` / `disconnected` / `error` / `connecting` / `unknown`）。
- **单行配置字段面**：`type` / `url` / `command` / `args` / `env` / `headers`（含一个历史兼容键）/ `oauth`，并允许厂商特有字段。
- **传输**：`stdio` / `http` / `sse` / `streamableHttp` 都用 `@modelcontextprotocol/sdk`（1.29.0，peer `zod`）。
- **同步**：独立的 `mcp-sync` 服务负责把配置同步到运行时，并把「工作区作用域」单独做成一个模块。
- **子代理借用**：子代理通过一个 `borrowed-mcp-port` 复用父会话的 MCP 端口（而不是自己再连一遍）。
- **UI 面**：设置页 + 状态列表 + 工具调用卡片渲染 + 「MCP 不可用」横幅，四件事分开做。

**可迁移的细节（本段行号属于外部仓；已抽验源码后并入）**

- **分层与本仓同构**：`McpPort`（端口，在 contracts 层）→ 唯一的实现（adapters）→ 装配点（bootstrap）——对应本仓的「seam 在 core、实现在 L1 包、装配在 runtime/studio」。
- **连接池 + lease + `isolation`**：默认**按会话隔离**（连接 key 含 leaseId）；只有**显式声明** `isolation:"workspace"` 的无状态 server 才按 workspaceKey 跨会话复用（`adapters/src/mcp/pool.ts:441-453`）。→ 这正是我们 D7 的参考依据；P1 若要跨会话复用，旋钮就叫这个名字。
- **失败分类**：18 值的 `failureKind` 枚举 + **禁止按错误文本分流**（协议协商失败按 SDK 的错误 code 判定，不匹配文案）。→ 我们的状态面照此设计。
- **断连后的调用**：stdio 子进程死亡后，**调用前对已断连的 server 重连一次**（进程内状态不可恢复，但工具重新可用），而不是直接失败。
- **配置写入**：原子写（临时文件 + rename）+ `0600`；JSON 损坏**抛错、绝不覆盖**——与本仓 `providers.json` 同款纪律。
- **名字与 schema**：`mcp__<sanitize(server)>__<sanitize(tool)>`；**inputSchema 强制归一成 object**（缺 `properties` 补空）；annotations 归一为 risk 等级；**deny 同时匹配新名与原 descriptor 名**（防升级后 denylist 静默失效）。
- **子代理借用**：child 借用父端口时拿到的是**只读视图**——`connect/disconnect` 直接抛错、`close` 是 no-op，并可传 `deniedServerNames` 收口。
- **测试现状（反面教材）**：全仓**没有** MCP 专属测试文件，回归靠 schema 与手工验证。这正是我们 §10 的 A1–A12 要避免的形态。

### 2.3 借用与不借用

| 维度 | 借用 | 不借用（本仓有别的承载物） |
|---|---|---|
| 单 server 一连接、无中心服务 | ✅ | — |
| 工具名带 server 名 | ✅（换成 `mcp__<server>__<tool>`） | DSH 的 `server.tool` 形态 |
| 失败刷新保留上一代 | ✅ | — |
| instructions 进提示词、带字节上限 | ✅（P1） | 进 system prompt 的方式（本仓的 system 在 tools 之前，改它会从 token 0 打断缓存——见 §5.4） |
| 图片走附件系统 | ✅（P1） | — |
| 富内容降级为显式文本诊断 | ✅ | — |
| 配置作用域 | ✅（全局 + 工作区两层） | 三层的 `common` 层（本仓没有第三个承载物） |
| 命名归一化 + sha256 后缀（防名字坍缩） | ✅ P0 照做 | — |
| 短暂断连不动模型面、只在最终放弃时注销 | ✅ P0 照做 | — |
| 退避 + 稳定窗口重置预算；HTTP 不进重连监督器 | ✅ P0 照做 | — |
| 子进程 env 清洗（凭据形状变量不进子进程） | ✅ P0 照做 | — |
| 失败分类枚举 + 禁止按错误文本分流 | ✅ P0 照做 | — |
| 断连后调用前先重连一次 | ✅ P0 照做 | — |
| inputSchema 强制归一为 object | ✅ P0 照做 | 但不采纳「静默补空对象就算合法」——本仓对**不受支持的关键字**仍拒绝注册（§5.3） |
| 连接池 `isolation`（session 默认 / workspace 复用） | P1 旋钮 | P0 只做会话隔离（§6.2） |
| 每个 MCP 工具 `needsApproval = true` | ❌ **有意偏离**（D6 配置即信任） | 这是本方案与两个参考实现**唯一的方向性分歧**，代价见 §7.1 与 §11 |
| 子代理借用父连接 | P1 再定 | 本仓 worker/swarm 的工具面是**显式装配**的，不能默认继承 |
| 插件/作用域框架（cordis、loader、profile） | ❌ | 本仓的对应物是 `Context` + `Plugin.mount` + `compose`、以及 plugin-hotswap 的「换代」 |
| 桌面端 store / TUI / 自有协议 | ❌ | 本仓的前端是 `apps/web`，宿主是 `apps/studio` |

---

## 3. 本仓的落点（seam 映射）

| 需求 | 现有缝 | 结论 |
|---|---|---|
| 连接与协议 | 无 | **新增 L1 包 `packages/mcp`（`@celestea/mcp`）**，只依赖 `@celestea/core` 与官方 SDK |
| 工具进入注册表 | `ToolRegistry`（`packages/core/src/tool.ts:88`） | 复用；注册时机与「换代」纪律见 §4.3 |
| 模型可见面 | `exposedRegistry` / `ExposureOptions`（`packages/tools/src/exposure.ts:125`） | 复用 `hidden` / `order` 两个**活取值**选项（`:131`、`:146`） |
| 运行期披露 | `DisclosurePolicy`（`packages/tools/src/disclosure.ts`） | 复用；三条不变量（只增 / 尾部追加 / turn 边界）**不得放宽** |
| 模式折叠 | `EXECUTION_TOOL_NAMES`（`packages/tools/src/exposure.ts:60`） | MCP 工具**加入 keep 列表**的判定规则见 §6.4 |
| 系统提示词 | `faceForMode`（`packages/tools/src/exposure.ts:204`） | 静态面**不随** MCP 运行时变化 |
| 权限 | guard 链（`ARCHITECTURE.md:156`）、`PermissionBaseline.toolDeny`（`apps/studio/src/runtime/engine-permissions.ts:27`） | 复用，不加第二套 |
| 装配 | `compose`（`packages/runtime/src/compose.ts:5`）、`engine-plugins.ts`（`apps/studio/src/runtime/engine-plugins.ts:322`） | 复用；MCP 插件与 `celestea.tools` 同层装配 |
| 插件开关 | `ENGINE_POLICY`（`apps/studio/src/plugin-catalog.ts:210`）+ `plugins.json` | MCP 作为**一行引擎插件**，开关复用 `PUT /api/plugins` |
| 会话级工具子集 | `apps/studio/src/store/session-tools.ts:28` | 复用 `GET|PUT /api/sessions/{id}/tools` |
| 配置数据文件 | `contracts/data-files/` + `docs/data-files.md` | 新增 `mcp.schema.json` 与对应一节 |
| 出站 HTTP 策略 | `packages/tools/src/http/ssrf.ts` | **不引用**（L1 包之间禁止互相依赖，`ARCHITECTURE.md:54`）；理由见 §7.3 |

### 3.1 新增 L1 包要同时动的三处

`ARCHITECTURE.md:66` 已经写明「三处缺一视为未登记」：

1. `eslint.config.js:51` 的 `TIER1` 数组；
2. `.dependency-cruiser.cjs:15` 的 `TIER1` 数组（逐包生成的 `tier1-no-peer-deps-<pkg>` 规则随之生成）；
3. `docs/ARCHITECTURE.md` §1.1 层级表与 §2.1 每包一句话职责表。

外加两条本仓的**反漂移**机械断言，新增插件/provide 必须同步：

- `tests/lib/builtin-plugins.ts:49` 的 `BUILTIN_MOUNTS`（`tests/builtin-plugins.test.ts` 用 TS 解析器双向核对，多一行少一行都红）；
- `apps/studio/src/plugin-catalog.ts` 的引擎层清单（`apps/studio/src/plugins-inventory.test.ts:12` 装一个真实会话逐名对比）。

---

## 4. 配置模型（`mcp.json`）

### 4.1 形状（草案，正式 schema 进 `contracts/data-files/mcp.schema.json`）

```json
{
  "servers": {
    "memory": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "env": { "MEMORY_DIR": "~/.celestea/memory" },
      "enabled": true,
      "timeout_ms": 20000
    },
    "remote": {
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer $EXAMPLE_TOKEN" },
      "enabled": false
    }
  }
}
```

- **server 名**：`^[a-z0-9][a-z0-9_-]{0,31}$`（它要进工具名前缀，字符集必须比工具名更严）。
- **server 名只来自本地配置**，绝不取远端 `serverInfo.name`（不可信 / 跨部署不唯一 / 升级会变——工具标识与权限规则不得静默跟着远端改名）；同一作用域内重名 = **启动即错**，不是「后者覆盖」。
- **`transport`**：P0 只有 `"stdio"` 与 `"http"`（Streamable HTTP）；`command`/`args`/`env` 只在 stdio 下合法，`url`/`headers` 只在 http 下合法（交叉出现 = 配置错误，不是忽略）。
- **`enabled`**：默认 `true`。关掉的 server **不连**，也不出现在模型面。
- **工具级过滤** `tool_allow` / `tool_deny`（可选数组）：server 粒度之外的收窄；两者同时给出时先 allow 后 deny。
- **`timeout_ms`**：单次调用与 discovery 各自的上限，默认值写在 schema 的 `default` 里（不在散文里重复数字）。
- **凭据**：`env` / `headers` 的值写 `$VAR` 引用进程环境——**默认 MCP 配置里没有明文凭据**，凭据住在环境里。任何响应/日志**永不回显** `env`/`headers`（日志只留 server 名与工具名）。
- 需要明文时（例如某 server 的 token 不便进环境变量）：在条目上显式标 `"secret": true`，该文件才落 `0600` 并按密钥文件对待。**这条会动一条现成不变量**：`tests/contracts.test.ts` 断言「`providers.json` 是唯一含密钥的数据文件」（`tests/contracts.test.ts:280`）——新增含密钥文件必须同时改那条断言与 `docs/data-files.md`。**推荐默认走 `$VAR`，让不变量原样成立。**
- **复杂度对照**（按项目契约的引用式是**更少**的机制，不是更多）：引用式只需要「解析 + 缺引用就响亮失败」两件事，`mcp.json` 保持 0644，而且**不需要对外投影**——里面本来就没有要藏的东西。明文式则要把 `providers.json` 的四件机制复制一份：`0600`、原子写（tmp → 0600 → fsync → rename）、畸形 JSON 硬错误、**白名单构造的对外视图**（`ProviderPublicView` 连 `api_key` 这个键都不存在，见 `docs/data-files.md:170`），外加「日志与响应永不回显」的纪律和那条「唯一含密钥文件」断言的改动。
- 本仓的引用式先例已经存在：`Profile` 用 `api_key_env` / `api_key_file` 两个字段表达凭据，启动时把 key **只注入内存**（`packages/runtime/src/profile.ts:11`、`docs/data-files.md:194`）。
- 引用式的代价不在代码而在**产品**：应用内没有地方存一个新的 token，得由用户自己在环境变量或密钥文件里放——这是一个可陈述的限制，不是一个隐藏的坑。

### 4.2 作用域与合并

- 全局 `<CELESTEA_HOME>/mcp.json`；工作区 `<CELESTEA_HOME>/workspaces/<ws>/mcp.json`。
- 合并语义：**按 server 名整体覆盖**（工作区同名条目**整体替换**全局条目，不做字段级 merge——字段级 merge 会让「我以为我关了它」变成真事故）。
- 不设第三层：本仓只有「全局 + 工作区」两个真实承载物。
- **不进 `Profile` / `celestea.toml`**：那是冻结的组合契约（`packages/runtime/src/profile.ts:8` 的 12 个键，注释写明「P3 cannot invent new ones」），为一个可选能力扩它，代价是每次组合步骤都要跟着动。MCP 是**独立数据文件**，与 `providers.json` 同层。

### 4.3 加载、失败与热更

- **文件不存在** → 空集合（零成本，与 `providers.json` 的 `open()` 语义一致）。
- **JSON 损坏** → **硬失败**（提示语指向文件路径），绝不把我的空集合写回去覆盖它。
- **单条 server 非法**（交叉字段、名字越界、command 不存在）→ 跳过该条 + 在状态面列出原因；**不静默**。
- **热更**：P0 只在**换代**时读取（会话重装配 / 服务重启）；P1 再评估 watcher。理由：本仓「注册只有一个时机：compose」（`ARCHITECTURE.md:131`），配置热更就等于换代，先别为它发明第三套时机。

---

## 5. 工具面契约

### 5.1 命名

- 模型可见名：`mcp__<server>__<tool>`（双下划线分隔）。
- **归一化**：非法字符 → `_`；若归一化或长度截断**改变了名字**，追加 12 位 sha256（`sha256("<server>\0<tool>")`）并截到长度上限——保证两个不同的 MCP 标识**永远不会**坍缩成同一个模型可见名。
- 原名 `<server>.<tool>` 只出现在**人类可读渲染**（`render`）与状态面里，不出现在模型面。
- 与内置工具冲突：**不可能**（前缀保留给 MCP；同时新增一条断言禁止任何契约工具使用 `mcp__` 前缀）。

### 5.2 与冻结契约的关系（D4）

现状是两道硬门禁：

1. `contracts/tools.json` 与 `FROZEN_COUNTS.tools`（23）必须一致（`tests/readme-claims.test.ts`）；
2. `tests/lib/tool-parity.ts:20` 把**注册表里每个工具**的 name/description/parameters 与 `contracts/tools.json` 全量对拍——注册表里多一个工具就是一条 finding。

因此 MCP 工具**不进契约**，并且豁免必须**受机械检查**，而不是白名单：

> **新断言（P0 必须有）**：注册表里出现的所有**非契约工具名**，必须全部满足 ① 匹配 `mcp__<server>__<tool>`；② `<server>` 在本次装配的「已启用 server 集合」里；③ 其 spec 携带 MCP 来源元数据（server 名 + 原始工具名）。
> 任何一条不满足 → 红。**变异负控制**：手工往注册表塞一个 `evil__tool` → 必须红。

这条断言把「MCP 不进契约」从**豁免**变成**规则**——豁免一旦无人看守，下一次就会有人拿它加第五个内置工具。

### 5.3 参数 schema 与描述

- `parameters` **直接采用** MCP 的 `inputSchema`（不再翻译一层，翻译层是漂移源头）。
- server 列出**重复的原始工具名** → **整张工具列表拒绝**，上一代保留（不做「取第一个」这种静默选择）。
- MCP 允许而本仓校验器不支持的关键字（外部 `$ref`、部分组合关键字等）：**该工具不注册**，并在状态面记一行「schema 不受支持」+ 原因。不做「尽量凑合」，也不静默丢。
- `description` 前缀加上 server 出处（例如 `[mcp:memory] `），让模型与用户都能看出它从哪来。
- **形状兜底**：`inputSchema` 必须归一成 `{type:"object", properties:{...}}`（两个参考实现都做这一步）；非法形状的 server 不能把非对象参数塞进模型面。但这不等于「非法就凑合」——见上一条。

### 5.4 模型面、顺序与提示词（D5）

- **披露集合**：配置里 `enabled` 且 schema 可用、且未被 `tool_deny` 排除的工具，从**初始面**起就在（不是「先藏起来等模型撞墙」）。
- **顺序**：`ExposureOptions.order` 提供**稳定披露序**——先契约工具（沿用注册表的既有顺序），再 MCP 工具（按 server 名字典序 → 工具名字典序）。注意 `ToolRegistryImpl.schemas()` 自己**按名字升序排序**（`packages/tools/src/registry.ts:61`），所以「插入中段」是默认行为、必须由 `order` 显式纠正。
- **运行期新增**（server 连上得晚、`tools/list_changed` 带来新工具）：只在**turn 边界**、**只增**、**尾部追加**——`DisclosurePolicy` 的三条不变量（`packages/tools/src/disclosure.ts:13` 起）不得放宽。代价如实登记：一次尾部追加 = 该点之后的缓存重热（本仓已实测的相对序见归档的调研文档）。
- **工具消失**分两种：**短暂断连不动面**（每次崩溃抖一次 schema 前缀没有任何信息增益，失败的调用本身就说明了故障）；只有**最终放弃**（重连预算耗尽）或 server **明确删除**了工具，才从下一个 turn 的面上移除，代价是一次缓存重热。正确性优先于缓存——留着一个**确定**不存在的工具名是提示词在撒谎。
- **系统提示词不动**：`{{tools}}` 渲染的是**模式的静态可披露全集**（`faceForMode`，`packages/tools/src/exposure.ts:204`），不是每 turn 的实际披露集。system 在 tools 之前序列化，让它跟随 MCP 变化会从 token 0 打断缓存——这是本仓已拍板的口径，MCP 不改它。

---

## 6. 运行时语义

### 6.1 连接时机与就绪前行为

- 会话**换代**时创建 MCP 插件实例并发起连接（异步，**不阻塞**首轮）。这不是绕开纪律，而是**遵守**它：[`ARCHITECTURE.md:141`](../ARCHITECTURE.md) 明令「插件不得在运行期自我注册；运行期只允许**替换**」，而本仓已有的换代级先例就是插件热插拔（`apps/studio/src/plugin-hotswap.ts:140` 的 `PluginSwitch`——切换在**下一次 compose** 生效）。MCP 走同一条路：运行期只**替换**被 provide 的注册表句柄，不新增第二套注册时机。
- 连接/discovery 未完成期间的调用：结构化拒绝 `mcp_not_ready: server=<name>`（不是 unknown tool，也不是静默挂起）。
- discovery 完成后，工具集合在**下一个 turn 边界**进入模型面。

### 6.2 生命周期与失败隔离

- **每会话一代独立连接**，随会话 release 回收；会话之间不共享连接（权限档位与凭据不串）。这不是保守：参考实现的默认值就是会话隔离，跨会话复用只留给**显式声明的无状态** server（§2.2）。
- **断连后的调用**：先尝试**重连一次**（有界），成功则照常执行，失败才返回结构化错误——不要把一个可自愈的断连直接变成模型看到的一次失败。
- **单 server 失败隔离**：一个 server 连不上/崩溃/超时，只影响它自己提供的工具；其余 server 与内置工具不受影响，状态面逐 server 展示。
- **重连**：指数退避 `min(maxDelay, initial * 2^(n-1))` + 预算上限；**活过稳定窗口才重置预算**（否则「连上就崩」的循环 server 会永远重启——那正是预算要防的）。**HTTP 与 stdio 语义不同**：stdio 的子进程退出才算故障、进重连；HTTP 的逐请求错误**不进**重连（传输自带恢复，且没有子进程可拉起）。数字进 schema 的 `default`，不在散文里重复。
- **取消**：把 `ToolInput.signal`（`packages/core/src/tool.ts:41`）传进 MCP 请求；取消后**不得**留下半完成的副作用，进程级失败要能说清「可能已执行」。
- **回收**：关闭 transport → 等待子进程退出 → 超时兜底杀**进程树**（跨平台先例见 `packages/tools/src/sandbox/child.ts` 的杀树实现；Windows 与 POSIX 的差异要在 CI 两平台都测）。关闭必须**有界等待**：栅栏超时就 fail-closed 停止重连——宁可停着，也不让新旧两个进程重叠。重连定时器一律 `unref`（不替用户把进程钉住）。

### 6.3 状态面（为什么 P0 不加端点）

用户要能看见「连上了没有 / 有哪些工具 / 为什么失败」，但这**不需要新端点**：

| 读者 | 承载物 | 形态 |
|---|---|---|
| 设置页的插件格 | 已有的 `GET /api/plugins` 引擎层那一行（`apps/studio/src/plugin-catalog.ts:210`） | **加字段**：连接态、server 数、工具数、最近一次失败原因（前端对该数组本来就是逐项容错渲染，加字段是纯增量） |
| 会话的工具面 | 已有的 `GET /api/sessions/{id}/tools` | MCP 工具名照常列在里面（名字自带 server 出处） |
| 逐 server 明细 | 同上插件行的一个子字段 | server 名 / 传输 / 状态 / **失败分类枚举** / 工具数 / 失败原因；**不含** `env` / `headers` |

失败原因必须是**枚举化的分类**（连不上 / 协议不兼容 / 鉴权被拒 / 超时 / server 内部错误 / schema 不受支持 …），**不得用错误文本做分流**——参考实现在这一条上踩过坑，明确禁止按文案判定。

「加字段」而不是「加端点」是本仓已有的先例：端点数被 `FROZEN_COUNTS.endpoints`（72）冻结，而**纯增量的字段**不算新端点。

### 6.4 execution 模式（D5 的第二半）

MCP 工具**不折叠**：`execution` 模式只折叠「`run_code` 程序里够得着」的工具，而 `run_code` 的 SDK 面只有四个文件工具，
被折叠的 MCP 工具在执行模式下**完全不可达**，但 turn 起的目录/提示词仍在宣传它们——那是一条会撒谎的提示词。
这与 `load_skill` / `update_tasks` / 浏览器工具的先例同规则（`packages/tools/src/exposure.ts:60` 上方的注释即此裁决）。

---

## 7. 权限与安全（D6）

### 7.1 与内置工具同一条 guard 链

- 模型发起的 MCP 调用走 `ToolRegistryImpl.dispatch` 的四段管线：schema 校验 → guard 链 → execute → 结构化结果（`packages/tools/src/registry.ts:65`）。
- **PathGuard 对 MCP 工具的真实行为**（这条我按源码复核后改过口径）：`PATH_ACCESS` 只声明**已知工具**的访问级别，**不在表里的一律按 `write` 处理**——那是 fail-closed 地板，不是放行（`packages/tools/src/guard/path-guard.ts:75` 的注释原文）；而路径仲裁是**按参数名**做的（`PATH_ARG_KEYS` = `path`/`paths`/`dir`/`workspace`…，`packages/tools/src/guard/path-guard.ts:91`），**新工具不需要任何注册步骤就会被仲裁**。所以 MCP 工具默认落 `write` 地板：在 `read-only` 档位下，一个**只读**的 MCP 工具只要参数叫 `path` 就会被拒。
- 这需要一个**声明口**，而且不需要新机制：`PathGuard` 的构造函数本来就收一个 `access` map（`packages/tools/src/guard/path-guard.ts:426`），装配时把它换成「内置表 + 配置声明的 MCP 条目」即可。配置里逐 server/逐工具允许写 `path_access: read | write | self`。
- `PathGuard`、`toolDeny`（`apps/studio/src/runtime/engine-permissions.ts:27` 的 `toolDeny` 字段）、`run_code` 子调用放行语义**全部照旧**。
- MCP 工具名可以被 `toolDeny` 禁用（配置面与权限档位两条路都能关它）。
- 不新增审批流：配置即信任。**这是与参考实现的方向性分歧**，理由是本仓的 `ask` **今天没有应答者**：`ToolDecision` 确实有 `ask` 这一档（`packages/core/src/types.ts:535`），但 `dispatch` 一遇到非 allow 就把它变成失败结果（`packages/tools/src/registry.ts:74`，`error: "ask: <reason>"`），**仓内没有任何组件会去回答它**（生产代码里没有一个 guard 返回 `ask`，只有测试在用）。参考实现那边是一整套子系统：权限服务按模式与 risk 决定 allow/ask（build 模式先放行 `readOnly && !destructive && !needsApproval`，critical 与 high risk 一律 ask），`alwaysAsk` 还能穿透 yolo 与 plan 模式的放行，并且「记住这个决定」分**持久规则**与**会话内规则**两档。
- 真要引入审批，形状只有两个，都不是小改：**guard 级**要新建「谁在等 / 等到什么时候 / 超时算拒绝还是算通过」一整条链（`ask` 目前是终端决策，不是待办）；**工具级**可以复用本仓已有的挂起机制——`ask_user_question` 的请求与应答走 `USER_QUESTION_REQUEST_EVENT` 与 `POST /api/questions/{id}/answer` 直接 resolve 被挂起的 promise（`packages/core/src/question.ts:122`、`packages/session/src/replay.ts:158`），但代价是**每次调用都挂起**。
- 折中方案（P0 就做，成本近零）：**把 risk 等级与 side-effect scope 显示在工具卡片与状态面上**，把「审批」换成「可见」。真要收紧时，`toolDeny` 与权限档位已经在链上，不需要新增机制。

### 7.2 凭据

- 只从 `mcp.json` 或进程环境读；**绝不**写入会话日志（日志里只出现 server 名与工具名）。
- 状态面（`GET /api/plugins` 的那一行、以及任何 health 输出）不返回 `env` / `headers`。
- 与 `providers.json` 同一条纪律：含密钥文件 `0600`、永不进仓（`docs/configuration.md:81` 的先例）。

### 7.3 HTTP transport 与 SSRF

`packages/tools` 的 SSRF 策略**不能被 `packages/mcp` 引用**（L1 ↔ L1 横向依赖被 `ARCHITECTURE.md:54` 禁止）。本设计的处理是**范围收窄**而不是复制一份策略：

- MCP 的 URL **只来自操作者配置**，模型无法影响它（MCP 协议本身不允许模型提供 endpoint）；
- 因此它和 `providers.json` 的 `base_url` 同类：配置事实，不是模型输入；
- **硬约束**：实现里不得从工具参数/模型输出派生 URL 或 header；HTTP 客户端**不跟随重定向**（跟随会把「配置的固定目标」变成「任意目标」）。
- 若 P1 真要放宽（例如 server 返回的资源链接），必须先把 SSRF 策略**上提为 core seam**，而不是在两个 L1 包里各写一份。

### 7.4 stdio 子进程的诚实声明

- **子进程环境先清洗再合配置**：以「清洗后的父环境」为底（丢掉 `KEY|PASSWORD|SECRET|TOKEN` 形状的变量、以及本项目 `CELESTEA_` 前缀的变量），再合配置里**显式**给出的值。否则任何一个第三方 server 都能顺走你环境里的全部凭据。

stdio server 由 SDK 的传输层直接 spawn，**不经过会话沙箱**。理由：它由操作者配置（等价于「本机装了一个命令并让它跑」），不是模型的动作。
代价必须说清：**第三方 MCP server 以你的用户权限运行**。可用的收紧旋钮（P1，登记在 schema 里）：按权限档位禁用 MCP、只允许显式 allowlist 的 command。

---

## 8. 改动面清单

| 文件 / 目录 | 性质 |
|---|---|
| `packages/mcp/**` | **新增 L1 包**：配置解析、连接管理、工具适配、结果适配、状态面 |
| `contracts/data-files/mcp.schema.json` + `contracts/data-files/index.json` | 新增 schema **并登记进 `files[]`**（现 13 条）；连带 `tests/contracts.test.ts` 的「13 个 schema」断言（`tests/contracts.test.ts:274`）与 round-trip 要求（`tests/contracts.test.ts:285`），以及 `docs/data-files.md` 总览表 |
| `eslint.config.js` | `TIER1` 加 `"mcp"` |
| `.dependency-cruiser.cjs` | `TIER1` 加 `"mcp"` |
| `docs/ARCHITECTURE.md` | §1.1 层级表 + §2.1 每包一句话职责 |
| `tsconfig.json` | 根 `paths` 加 `@celestea/mcp` → `./packages/mcp/src/index.ts`（\`packages/*\` 的 workspace glob 已覆盖新包，无需改 `pnpm-workspace.yaml`；`tests/tsconfig-paths.test.ts` 是这条的机械兜底） |
| `package.json` / `packages/mcp/package.json` | 新工作区包 + 官方 SDK 依赖 |
| `docs/DEPENDENCY-POLICY.md` | §7 运行时依赖清点新增一条（SDK），附升级验证协议 |
| `docs/configuration.md` | 环境变量/数据根一节补 `mcp.json` 的位置与权限 |
| `docs/data-files.md` | 新增 `mcp.json` 一节 |
| `apps/studio/src/runtime/engine-plugins.ts` | 装配 MCP 插件（与工具插件同层，顺序即语义） |
| `apps/studio/src/plugin-catalog.ts` | 引擎层清单加一行（`disable` 策略与理由） |
| `tests/lib/builtin-plugins.ts` | `BUILTIN_MOUNTS` 加对应的 plugin/provide 行 |
| `apps/studio/src/store/session-tools.ts` | 无需改（复用已有的会话工具子集端点）；只在工具名空间里出现 MCP 名字 |
| `docs/README.md` | 登记本文（新增文档必须登记） |
| `docs/feature/README.md` | 本目录索引加一行 |
| `contracts/tools.json` / `FROZEN_COUNTS` / `contracts/endpoints.json` | **不动**（这是本设计的要点之一） |

---

## 9. 分期

| 期 | 内容 | 不包含 |
|---|---|---|
| **P0** | `mcp.json` + schema；`stdio` 与 Streamable HTTP；initialize / `tools/list`（含分页）/ `tools/call` / `tools/list_changed`；命名与来源元数据；guard 链接入；模式面与披露层接入；状态面（连接态/工具数/失败原因）；重连与进程回收；插件开关与清单登记 | resources、instructions、图片、子代理继承、热更 watcher |
| **P1** | `resources/list` / `resources/read` 的共享工具（provider 语义）；server instructions 的注入位置（见下）；结果里的图片走附件系统；按权限档位收紧的旋钮 | prompts 模板、elicitation、tasks、订阅、OAuth |
| **P2（默认不做，需单独立项）** | OAuth、resource 订阅、elicitation、prompts | — |

P1 的 instructions 位置**不能**抄 DSH（它进 system prompt 的一节）：本仓 system 在 tools 之前，改它会从 token 0 打断缓存。
候选落点是 turn 起点的 durable user-role 上下文（技能目录用的那条通道的邻居）——**P1 再定，P0 不埋这个雷**。

---

## 10. 验收标准与门禁

**每条都要有变异负控制**（改坏实现 → 必须真红 → 还原 → 绿）：

| # | 验收标准 | 判据 |
|---|---|---|
| A1 | 非契约工具必须可解析为 MCP 来源 | §5.2 的新断言；变异：塞一个 `evil__tool` → 红 |
| A2 | 名字空间隔离 | 契约工具名不得以 `mcp__` 开头；变异：改一个内置工具名 → 红 |
| A3 | 顺序稳定且追加 | 披露序 = 契约工具 ++ MCP 工具（server→tool）；变异：把 MCP 工具插到中段 → 红 |
| A4 | 追加只在 turn 边界 | 单测：turn 中途连上 server，本 turn 的面不变，下一 turn 才出现 |
| A5 | `execution` 模式不折叠 MCP | 断言执行模式的面里 MCP 名字仍在；变异：把它加进折叠集 → 红 |
| A6 | 失败隔离 | 一个 server 连不上：其余工具面完整、状态面显示该 server 的失败原因 |
| A7 | 刷新失败保留上一代 | discovery 失败后模型面与上一代逐字节一致 |
| A8 | 凭据不外泄 | 遍历所有响应与日志行，断言不含 `headers`/`env` 的值；变异：把 headers 回显 → 红 |
| A9 | 进程回收 | 会话 release 后子进程在预算内消失（POSIX 与 Windows 各一条；Windows 见杀树先例） |
| A10 | 坏配置不静默 | 损坏 JSON → 硬失败；单条非法 → 跳过并出现在状态面 |
| A11 | 不支持 schema 的工具不注册且被记录 | fixture 提供外部 `$ref` 的工具 → 不在面里，状态面有原因 |
| A12 | 取消可传递 | 取消后 MCP 请求中止，且结果如实报告「可能已执行」 |

**门禁影响（全量 10 道，见 `docs/AGENT.md` §3）**：

- `max-lines` 450/文件、`max-lines-per-function` 100：`packages/mcp` 必须一开始就按职责拆目录（连接/传输/工具适配/结果适配/状态各一）。
- `check:comment-refs`：新代码里的注释**不得**写 `file.ts:NN` 行号引用，用 `[symbol]` 形式。
- `check:sync-in-callback`：子进程与 transport 的回调里不得出现同步阻塞调用。
- `check:tmpdir` / `check:sleep`：fixture 的临时目录与退避等待照旧纪律。
- 依赖门禁：新 SDK 进仓后必须附 `pnpm outdated -r` 前后对比（`docs/DEPENDENCY-POLICY.md` §4）。

---

## 11. 已知代价（诚实清单）

1. **缓存重热**：工具集任何变化（尾部追加或工具消失）都会让该点之后的缓存失效一次。本仓已实测的相对序是「稳定态 ≫ 尾部追加 > 中段删 > 首工具移尾」，所以设计只允许尾部追加。
2. **stdio server 不在沙箱内**：第三方 MCP server 以本机用户权限运行（§7.4）。
3. **配置即信任**：装了 server 就等于把它当本机命令执行。没有二次审批，只有「关掉它 / 用 `toolDeny` 禁用它」两条路。**这是与参考实现唯一的方向性分歧**（ZCode 默认每个 MCP 工具都要审批），我们换来的东西是「无人值守也能跑」，代价是「配错了就等于授权了」——所以配置面要 fail-loud（§4.3），状态面要显示 risk 与 side-effect。
4. **不做的四类**（prompts / elicitation / tasks / 订阅）：有 server 依赖它们时**明确报不可用**，不假装降级成功。
5. **未验证项**：跨平台子进程回收、真实远端 Streamable HTTP server 的端到端行为——P0 的 fixture 用本地 stub server 覆盖协议面，真机对远端 server 的验证单列为一项，不写成「已支持」。

---

## 12. 待定（P1 才拍板，P0 不埋雷）

| # | 待定项 | 为什么现在不定 |
|---|---|---|
| U1 | server instructions 的注入位置与**超限语义** | 位置：唯一不打断缓存的地方要单独设计（§9）；超限：参考实现是「超限即拒绝连接」，也可以考虑「截断 + 明说截了多少」——两者都诚实，后果不同，P1 一起定 |
| U2 | resources 的工具面（共享工具 vs 每 server 一对） | 取决于 P0 的 provider 语义实证 |
| U3 | 子代理/worker 是否继承父会话的 MCP 连接 | 本仓 worker 面是显式装配的，继承=安全与缓存的复合决定 |
| U4 | 配置 watcher（真热更） | 现在「换代即生效」，先看实际需求 |
| U5 | 跨会话复用连接（`isolation: workspace` 那类旋钮） | P0 只做会话隔离；复用要先把「权限档位/凭据不串」说清楚 |
| U6 | 官方 SDK 的替换/降级缝（`McpTransport`）的边界 | 先按 SDK 落地，把替换点留在一个文件里，用够一轮再定形状 |
