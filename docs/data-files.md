# Celestea Studio · 数据文件与格式

> 状态：**当前**。共享数据文件的 schema 与落点；字段真源是 `contracts/data-files/*.schema.json`（每个数据文件一份 JSON Schema）。

> 📦 **仓库形态**：前端 = `apps/web/`，后端 = `apps/studio/`，引擎与工具链 = `packages/**`；本页正文描述的就是这套现役 TS 实现。
> 运行数据根为 `/var/lib/celestea-agent/`（生产 `$CELESTEA_HOME`）。
> 索引见 [`../README.md`](../README.md) 与 [`README.md`](./README.md)。

> 🏠 **CELESTEA_HOME 数据根**。workspace 里的 celestea 产物（会话目录 / 归档 / 回收站 / prompts / run_code 临时程序）全部落在工作区之外的跨平台数据根：
> 1. `$CELESTEA_HOME`（生产 systemd 固定 `/var/lib/celestea-agent`，FHS 的 `/var/lib/<service>`）；
> 2. `$XDG_DATA_HOME/celestea`（Linux；回应 claude-code#1455 一类 XDG 诉求）；
> 3. `~/.celestea`（Linux/macOS 默认；同类 agent CLI 的事实标准）；
> 4. `%USERPROFILE%\.celestea`（Windows 默认）。
>
> 布局：`<home>/workspaces/<workspace-basename>/{sessions,archive,trash,run-code}/prompts.json`。会话 id 仍是 `<workspace-basename>/<session-dir>`。
> 旧布局 `<ws>/.celestea/sessions`、`<ws>/<session-dir>`、`<ws>/.celestea-archived`、`<ws>/.celestea-trash`、`<ws>/.celestea-prompts.json` 继续**只读兼容**（canonical 优先）。解析器 `packages/core/src/celestea-home.ts`，存储侧 `apps/studio/src/store/celestea-home.ts`。


> 权威来源：**字段真源**是 `contracts/data-files/*.schema.json`（每个数据文件一份 JSON Schema：`workspaces` / `providers` /
> `prompts` / `session` / `cli-main-jsonl` / `cli-main-jsonl-precompact` …，总索引 `contracts/data-files/index.json`）；
> **读写与语义真源**是现役 TS 代码：`apps/studio/src/store/workspaces.ts`、`apps/studio/src/store/providers.ts`、
> `apps/studio/src/store/prompts.ts`、`apps/studio/src/store/session-meta.ts`、`packages/runtime/src/compact/plan.ts`、
> `packages/runtime/src/compact/rewrite.ts`、`packages/session/src/jsonl.ts`、`packages/session/src/messages.ts`、
> `packages/core/src/session-event.ts`。
> 本页列出的字段就是这两处的真实字段：TS 接口里的可选键（`?`）就是「JSON 里可以缺席」，
> 缺席时由读写代码给出默认值（`[]` / `null` / `""`；个别字段保持缺席 —— 即落盘时省略该键，逐字段见下文）。

## 0. 总览

| 文件 | 默认路径 | 环境变量覆盖 | 权限 | 写入方 | 读取方 |
|---|---|---|---|---|---|
| `workspaces.json` | `<cwd>/workspaces.json` | `CELESTEA_WORKSPACES_FILE` | 普通（无 key） | `WorkspacesStore.persist`（`apps/studio/src/store/workspaces.ts`） | 启动 / 所有会话端点 |
| `providers.json` | `<cwd>/providers.json` | `CELESTEA_PROVIDERS_FILE` | **0600** | `ProvidersStore.save`（`apps/studio/src/store/providers.ts`） | 启动 / 所有 provider 端点 |
| `prompts.json` | `<cwd>/prompts.json` | `CELESTEA_PROMPTS_FILE` | 普通 | `PromptsStore.persist`（`apps/studio/src/store/prompts.ts`） | compose 时装配 / prompts 端点 |
| `<CELESTEA_HOME>/workspaces/<ws>/prompts.json` | 每个工作区容器 | — | 普通 | 同上（workspace scope） | compose 时装配 / prompts 端点 |
| `celestea.toml` | `<cwd>/celestea.toml` | —（引擎解析链） | 普通，**不含 key** | 人 | 启动 compose 步骤 `resolve_profile`（现役实现 `apps/studio/src/runtime/engine-profile.ts`；步骤名冻结在 `packages/runtime/src/profile.ts` 的 `COMPOSE_STEPS`） |
| 会话目录 | `<CELESTEA_HOME>/workspaces/<ws>/sessions/<session>/`（legacy `<workspace path>/<session>/`） | `CELESTEA_SESSION_DIR`（指向**会话目录**） | 普通 | 引擎 `PersistentSessionLog`（`packages/session/src/log/persistent.ts`）+ Studio | 引擎回放 / messages 端点 |
| `cli-main.jsonl` | 会话目录内 | — | 普通 | 引擎（每事件一行） | 引擎回放 / messages / compact |
| `cli-main.jsonl.<n>` | 会话目录内（`n` = 1,2,…） | — | 普通 | 引擎**轮转**（写入前 size ≥ 16 MiB） | 引擎回放 / messages（**跨段**读取） |
| `session.json` | 会话目录内（可选） | — | 普通 | `POST /api/sessions` | activate / compact / prompts 装配 |
| `cli-main.jsonl.precompact` | 会话目录内 | — | 普通 | `rewriteAtomic`（`packages/runtime/src/compact/rewrite.ts`） | 人工回滚 |

**会话日志的轮转（W1503）**：`cli-main.jsonl` 达到 16 MiB 时，**下一次写入前**把它整体改名成
`cli-main.jsonl.1`（再满则是 `.2`，**代际递增、从不覆盖旧段** —— 会话日志是模型可见历史的
来源，替换旧段会删历史，这是它与 `USAGE_LEDGER_MAX_BYTES` 那个审计日志先例的关键差别）。
所有读取路径（引擎 `events()` / `deriveMessages()` / `open()`、Studio `messages()`）都按
`[.1, .2, …, 当前段]` 顺序**跨段**拼接，因此投影与从未轮转**逐字节等价**。
`compact` 的 `.precompact` 备份与轮转**无关**（前者是压缩备份，后者是容量分段）。

`.gitignore` 排除：`providers.json`、`workspaces.json`、`sessions/`、`apps/web/dist/`、`target/`、`*.log`、`.env`。

---

## 1. `workspaces.json`（v2）

### 1.1 schema（`contracts/data-files/workspaces.schema.json`；现役实现 `apps/studio/src/store/workspaces.ts` 的 `RegistryData`）

```jsonc
{
  "workspaces": [ { "path": "/abs/registered/dir" } ],   // 缺省 -> []（`parseRegistry`）
  "active_session": "<workspace>/<session>"  // 缺省 -> null（`parseRegistry`）
}
```

- **没有 `version` 字段**。"v2" 只是命名约定（`contracts/data-files/workspaces.schema.json` 的 `title` + `apps/studio/src/store/workspaces.ts` 头注）：工作区 key = 注册路径的文件夹名 basename（`workspaceBasename`，`apps/studio/src/store/session-id.ts`），**名称从不存储**；v1 的 `name` 字段在加载时被读出用作映射后丢弃、不再写回（`parseEntry`，`apps/studio/src/store/workspaces.ts`）。
- 未知字段不报错（TS 侧 `parseRegistry` 只挑 `workspaces` / `active_session`，其余键直接忽略；对应的 JSON Schema 也没有 `additionalProperties: false`）。
- **没有归档状态字段**：归档是纯文件系统移动，registry 不记录；归档后的会话落在 `<CELESTEA_HOME>/workspaces/<ws>/archive/`（W880；legacy `.celestea-archived/` 只读兼容），默认扫描不列出 → 对 `GET /api/sessions` 完全不可见（`?archived=1` 才列）。
- 写入：`JSON.stringify(value, null, 2)` → `<path>.json.tmp` → `rename` 原子替换（`writeJsonAtomic`，`apps/studio/src/store/fs-json.ts`）。**没有 fsync**（与 `compact` 的日志写入不同级，见 §5）。

### 1.2 session id 形态

```
"<workspace-basename>/<session-dir-name>"
```
规则（`parseSessionId`，`apps/studio/src/store/session-id.ts`）：恰好一个 `/`，两侧非空，session 段不含 `/`。
解析（`SessionsStore.resolve`，`apps/studio/src/store/sessions.ts`）：workspace 段是**注册表查找**（绝不是路径拼接）；session 段经 `sanitizeComponent`（`apps/studio/src/store/session-id.ts`；分隔符/控制字符/空白 → `_`，**CJK 保留**），并拒绝空 / `.` / `..` / `.` 开头；最后校验 `dir.parent() == ws_path`（双保险防穿越）。
另有 `"worker:<sid>"` 形态，只在 `GET /api/sessions/{id}/messages` 生效（引擎内存 SessionRegistry）。

### 1.3 磁盘布局

```
<workspace path>/                     注册的任意用户目录
├── <session-dir>/                    会话 = 直接子目录且含 cli-main.jsonl
│   ├── cli-main.jsonl                引擎 PersistentSessionLog 回放文件
│   ├── session.json                  可选：{"model":"<id>","prompt":"<prompt id>"}
│   └── cli-main.jsonl.precompact     可选：/compact 的单副本备份
├── <session-dir-2>/                  （legacy 布局；新会话不再落在这里）
├── .celestea/sessions/<name>/        W877 过渡布局（只读兼容）
├── .celestea-archived/<name>/        归档（legacy；只读兼容）
└── .celestea-trash/<name>-<ts>/      回收站（legacy；只读兼容）
```

W880 之后工作区**根下不再新建任何 celestea 产物**，canonical 布局为：

```
<CELESTEA_HOME>/workspaces/<workspace-basename>/
├── sessions/<name>/                 活跃会话
├── archive/<name>/                  归档（保持原名，可 unarchive）
├── trash/<name>-<ts>/               回收站（加时间戳，**不可再按 id 寻址**）
├── prompts.json                     工作区级段注册表
└── run-code/                        run_code 临时程序（宿主机写、bwrap 只读挂载）
```
- dot 前缀目录永不扫描（`WorkspacesStore.countSessions` / `SessionsStore.list`，`apps/studio/src/store/workspaces.ts` / `apps/studio/src/store/sessions.ts`）。
- `cli-main` 只是引擎内部文件名（`SESSION_FILE`），**没有特权**；唯一限制是活动会话不能被归档/删除。
- `sessions/<workspace>/<session>/cli-main.jsonl` 这种层级只在**默认工作区**（`<cwd>/sessions`）+ legacy 迁移后出现；注册工作区的路径可以是任意目录。

### 1.4 加载 / 迁移 / 损坏处理（`loadRegistry`，`apps/studio/src/store/workspaces.ts`）

| 情况 | 行为 |
|---|---|
| 文件存在且可解析 | 归一化（见下）后加载；有变化才重写文件 |
| 文件缺失 | 触发 **legacy 迁移**：`root/*.jsonl` → `root/<stem>/cli-main.jsonl`；`root/<ws>/*.jsonl` → `root/<ws>/<stem>/cli-main.jsonl`（已叫 `cli-main.jsonl` 的跳过；dot-dir 从不迁移）。迁移前先把所有 `*.jsonl` 备份到 `root/.backup-<unix-secs>/`；每步先查目标是否存在 → **幂等**；单文件失败只打印不中断启动。然后创建 `{"workspaces":[{"path":"<cwd>/sessions"}],"active_session":"sessions/cli-main"}` |
| JSON 畸形 | **硬错误** `workspaces.json '<path>' is malformed: {e}`，启动即以 exit 1 中止（`contracts/data-files/workspaces.schema.json` 的 `hardErrors`）；**绝不覆盖**不可读的注册表 |
| 两个工作区 basename 相同 | 硬错误 `two workspaces resolve to the same folder name '{base}' (workspace keys must be unique basenames; rename one folder)` |
| 其它读错误 | 硬错误，同样以 exit 1 中止 |

v1→v2 归一化（`parseRegistry` + `assertUniqueBasenames`，`apps/studio/src/store/workspaces.ts`）：按 basename 去重；`active_session` 的 workspace 段按 v1 name→basename 映射重写；幂等。

### 1.5 `session.json`

```jsonc
{ "model": "deepseek-v4-flash-0731", "prompt": "my-prompt-id" }   // 字段可选，只写出现过的
```
- **唯一写入点**：`POST /api/sessions` 且 `model` / `prompt` 至少一个非空（`writeSessionMeta`，`apps/studio/src/store/session-meta.ts`；调用点 `SessionsStore.create`，`apps/studio/src/store/sessions.ts`）；两者都空则**不创建**该文件。
- 读取：`get_sessions` 的 `model` 字段；`activate` 时热应用（非法值 → 400 `invalid session model: {e}`）；`compact` 选摘要模型（缺省用当前代际 model）；prompts 装配选会话级 prompt 绑定。
- 缺失/损坏 → `null`（容忍），不阻断（`readSessionMeta`，`apps/studio/src/store/session-meta.ts`）。
- 随会话搬移：branch 会复制它；rename 因整目录 rename 自然跟随。
- **注意**：`POST /api/config` 改模型**不会**回写 `session.json`——会话级模型只在创建时决定（改文件是唯一后续手段）。

---

## 2. `providers.json`

### 2.1 schema（`contracts/data-files/providers.schema.json`；现役实现 `apps/studio/src/store/providers.ts` 的 `ProviderRow` / `ProviderModel`）

```jsonc
{
  "providers": [
    {
      "id": "celestea",                  // 必需；身份
      "name": "Celestea",                // 必需；仅显示名
      "note": "",                        // 缺省 -> ""
      "base_url": "http://127.0.0.1:3001/v1",  // 必需
      "request_format": "chat_completions",    // 必需；chat_completions|responses|anthropic_messages
      "api_key": "<明文密钥，仅本文件可见>",   // string | null；缺省 -> null
      "models": [
        {
          "id": "deepseek-v4-pro",       // 必需
          "name": "DeepSeek V4 Pro",     // 必需
          "reasoning_efforts": ["low","high","max"],  // 缺省 -> 省略该键（**自由字符串、无枚举校验**）
          "context_window": 1000000,     // number | null
          "max_output_tokens": 128000    // number | null
        }
      ]
    }
  ],
  "default_model": "deepseek-v4-pro"     // string | null；缺省 -> null
}
```
- **没有 `version` 字段、没有任何迁移逻辑**；`id/name/base_url/request_format` 没有默认值 → 缺字段即视为无效行。
- `ProviderModel` **故意不带可打印 key 的形态**：内部行是 `ProviderRow`（唯一允许持有 `api_key` 的类型），所有读路径返回**白名单构造**的 `ProviderPublicView`（该类型根本没有 `api_key` 这个键），不做对象展开，因此带 key 的类型不可能被打印（`apps/studio/src/store/providers.ts`）。
- `request_format`：三种协议引擎适配器均已就绪（`packages/llm` `defaultAdapterRegistry`），探测按 `request_format` 发**只读** `GET <base_url>/models`。**探测头必须与引擎实际发的一致**：引擎的共享 transport（`packages/llm/src/transport.ts:95`）对**所有**协议都发 `Authorization: Bearer <key>`（anthropic adapter 只多一个请求体），所以探测也发它 —— 探测若自行「按协议规范」改发 `x-api-key`，就会对同一行给出与真实调用相反的结论（把引擎用不了的配置判成健康，或反之）。adapter 缺协议原生鉴权这件事本身登记为 `docs/pitfalls.md` 的 **P19**。探测**不**发对话请求；没有对应探测实现的格式仍在发包前 fail-closed，并**带格式名**返回"该请求格式暂不支持自动测试：<格式>"。

### 2.2 落盘与权限（`ProvidersStore.save`，`apps/studio/src/store/providers.ts` + `writeJsonAtomic`，`apps/studio/src/store/fs-json.ts`）

pretty JSON → `providers.json.tmp` → 以 `mode: 0o600`（`PROVIDERS_MODE`）写入 → fsync（`fsync: true`）→ `rename`。
**每次 `save()` 都重设 0600**；但构造时不会给已存在的文件补 chmod（若文件权限被外部改宽，要等下一次写才恢复）。
构造契约（`load`，`apps/studio/src/store/providers.ts`）：文件不存在 → 空 store；**JSON 畸形 → 硬错误**（绝不以空 store 覆盖不可读文件）。

### 2.3 `public_view`：外发字段（`ProviderPublicView`，`apps/studio/src/store/providers.ts`）

| 字段 | 说明 |
|---|---|
| `id` / `name` / `note` / `base_url` / `request_format` | 原样 |
| `models[].id` / `name` / `reasoning_efforts` / `context_window` / `max_output_tokens` | 原样 |
| `is_default` | `default_model` 命中该 provider 的任一 model |
| `has_key` | `api_key` 存在且非空字符串（**未 trim**） |
| **`api_key`** | **键不存在**（不是置空）。测试断言响应文本既不含密钥也不含 `"api_key"` |

### 2.4 更新语义（`ProvidersStore.upsert`，`apps/studio/src/store/providers.ts`）

| 字段 | 缺省时行为 |
|---|---|
| `api_key` | **保留库中旧 key**（唯一"缺省保留"） |
| `models` | **清空为 `[]`** |
| `note` | **清空为 `""`** |
| `request_format` | **重置为 `chat_completions`**（会把已存的 `anthropic_messages` 悄悄改回） |
| `name` | 回退为 `id` |

> 现役实现的头注（`apps/studio/src/store/providers.ts`）与本表一致。前端每次都发全字段，所以日常不会撞上；用 curl 做部分更新会。

### 2.5 `default_model` 与启动覆盖（`resolveProviderTarget` / `applyProviderTarget`，`packages/runtime/src/host/provider-target.ts`）

- 启动时若 `default_model` 非空：覆盖 `celestea.toml` 的 `profile.model`；若某 provider 的 models 列出该 id 且是 `chat_completions`，还覆盖 `profile.base_url` 并把该 provider 的 key 注入 `env[profile.api_key_env]`（仅内存）。
- 即使没有 provider 列出该 id，也照样覆盖模型名（自定义模型直通）。
- 运行期改默认走 `POST /api/providers/default`（compose → 落盘 → swap，失败互不牵连）。

### 2.6 数值字段

后端 `context_window` / `max_output_tokens` 只接受 **JSON number**。前端的 `k`/`m` 后缀（`1m = 1000000`、`1.5m`、`128k`）是**前端输入糖**（`apps/web/src/ui/providers/form.ts:60-71` 的 `numOrNull`），不会出现在请求体里；用 curl 直接传 `"1k"` 会被后端的 number 校验拒绝。

---

## 3. `prompts.json`（段注册表）

### 3.1 文件与 schema（`contracts/data-files/prompts.schema.json`；现役实现 `apps/studio/src/store/prompts.ts` 的 `PromptFileData` / `PromptEntry` / `PromptSectionRow`）

两个注册表：
- **全局**：`prompts.json`（`CELESTEA_PROMPTS_FILE` 覆盖，否则相对进程 cwd）；
- **工作区**：`<CELESTEA_HOME>/workspaces/<ws>/prompts.json`（legacy `<workspace path>/.celestea/prompts.json` 与 `<workspace path>/.celestea-prompts.json` 只读兼容）。

```jsonc
{
  "sections": [
    { "id": "identity", "name": "Identity", "template": "...", "order": 100 }  // 全部必需
  ],
  "prompts": [
    { "id": "my-prompt", "name": "My Prompt",
      "section_overrides": { "identity": "新的段模板 {{model}}" },  // 缺省 -> {}
      "is_default": false }                                        // 缺省 -> false
  ],
  "default_prompt": "my-prompt"                                    // 缺省/空串 -> null
}
```
- **新文件，无迁移**（`PromptsStore.read`，`apps/studio/src/store/prompts.ts`：直接解析，不看任何版本号）。
- 读取容错：缺失/不可读 → 默认空；**畸形 → 打警告 + 默认空**（注册表绝不能拖垮 compose/UI，`PromptsStore.read`，`apps/studio/src/store/prompts.ts`）。
- 落盘：pretty JSON + `.json.tmp` + rename（`writeJsonAtomic`，`apps/studio/src/store/fs-json.ts`）；**不设 0600**（无密钥）。

### 3.2 四级层级

| 层级 | 载体 | 说明 |
|---|---|---|
| `builtin` | 代码常量 `BUILTIN_SECTIONS`（10 段：`identity` / `environment` / `tool_access` / `paths` / `shell` / `network` / `delegation` / `planning` / `output` / `context`，order 100..1000） | 只有 builtin 段有静态 `name`；`default_system_prompt()` = 按数组序 `"\n\n"` 拼接 |
| `global` | `prompts.json` 的 `sections` / `prompts` | 覆盖 builtin 同名段 |
| `workspace` | `<CELESTEA_HOME>/workspaces/<ws>/prompts.json` | 覆盖 global 同名段 |
| `session` | 会话目录 `session.json` 的 `"prompt"` 字段（**绑定一个 prompt id，不是独立的段层**） | 其 `section_overrides` 最后覆盖 |

装配顺序（`composeSections` / `assembleSystemPrompt`，`apps/studio/src/store/prompts.ts` / `apps/studio/src/store/prompts-compose.ts`）：`builtin` → `global.sections` → `ws.sections` → bound prompt 的 `section_overrides`。
- 已存在的段：**只换 template，保留原 order**；新增的段 order = `ORDER_FALLBACK = 2000`。
- 排序 `(order, id)` 升序；空/纯空白 template 丢弃；渲染失败时**已知段回退 builtin 模板**、用户新增段丢弃，绝不抛异常。
- 最后 `"\n\n"` 连接并截断到 `PROMPT_MAX_LEN = 8192` 字节（落在字符边界）。

选择链（`resolveActivePrompt`，`apps/studio/src/store/prompts-compose.ts`）：会话绑定 id（先 ws 后 global）→ 找不到就**直接返回 null、不回退任何 default**；无绑定 → `ws.default_prompt` → `global.default_prompt` → null（即 builtin base）。
注意 `is_default` 字段**不参与解析链**，只由 handler 维护并回显；真正决定默认的是 `default_prompt`。

### 3.3 `{{var}}` 插值（`renderTemplate` + `scan`，`apps/studio/src/store/prompts-template.ts`）

- 语法：`{{name}}`，名称内部 `trim()`；**无别名、无转义**（字面 `{{` 无法表达）。
- 未闭合 `{{` → `unclosed '{{' in template`；未知变量 → `undefined prompt variable '{{name}}'`。
- 可用变量（`PROMPT_VARS`，9 个；定义在 `apps/studio/src/store/prompts-template.ts`）：

| 变量 | 取值 |
|---|---|
| `model` | `profile.model` |
| `provider` | `base_url` 的 host 段（去 scheme、取首个 `/` 之前） |
| `base_url` | 当前网关 |
| `workspace` | `CELESTEA_SESSION_DIR` 的**父目录名** |
| `session` | 会话目录名 |
| `tools` | 常量工具名清单 `PROMPT_TOOLS` |
| `context_window` | `profile.context_window_tokens` |
| `max_output_tokens` | `profile.max_output_tokens`（null → 0） |
| `date` | 系统时钟 UTC 民用日期（只用系统时钟，不引第三方日期库） |

### 3.4 校验

- `validatePromptId`（`apps/studio/src/store/validate.ts`）：1-128 字符，仅 `[A-Za-z0-9._-]`。
- `validateTemplate`（`apps/studio/src/store/prompts-template.ts`）：≤8192 字节；`{{` 必须闭合；变量必须在白名单。

### 3.5 内存旁路

`POST /api/config` 的 `system_prompt`：非空 → 写入进程内的 system-prompt override 槽（`StudioSettings`，`apps/studio/src/settings.ts`），提示词装配 **完全绕过注册表**；空串 → 清空槽并回落到按注册表装配出的默认提示词。装配出来的提示词**永远不会**被误判为用户覆盖（只有这个槽算，`systemPromptOverride` / `setSystemPromptOverride`，`apps/studio/src/settings.ts`；读取点 `assembleSystemPromptFor`，`apps/studio/src/handlers/config-shape.ts`）。

---

## 4. 会话日志 `cli-main.jsonl`

### 4.1 格式

引擎 v1 持久化格式：**一行一个 `SessionEvent`**，判别键是 `"type"`，取值 snake_case（真源 [`../contracts/session-event.schema.json`](../contracts/session-event.schema.json)；类型定义 `packages/core/src/session-event.ts`，读写 `packages/session/src/jsonl.ts`）。

```jsonc
{"type":"turn_start","id":"turn-1"}
{"type":"user_message","text":"..."}
{"type":"thinking_delta","text":"..."}
{"type":"tool_call","id":"call_1","name":"read_file","args":{"path":"/tmp/x"},"parent_id":null}
{"type":"tool_result","id":"call_1","value":{"ok":true},"error":null,"parent_id":null}
{"type":"assistant_message","text":"..."}
{"type":"turn_end","id":"turn-1","outcome":"completed"}
```

解析（`parseSessionJsonl`，`packages/session/src/jsonl.ts`）：跳过空行；**遇到首个不可解析行即停止**——撕裂的尾部（写一半）永远不会被当成内容。

### 4.2 消息契约（`sessionEventToMessage`，`packages/session/src/messages.ts`）

| 事件 | 输出 JSON |
|---|---|
| `turn_start` / `turn_end` | 不输出（结构标记） |
| `user_message` | `{"role":"user","content":<text>}` |
| `assistant_message` | `{"role":"assistant","content":<text>}` |
| `thinking_delta` | `{"role":"thinking","content":<text>}` |
| `tool_call` | `{"role":"tool","kind":"call","tool_call_id":<id>,"tool_name":<name>,"tool_args":<args>}` + 可选 `"tool_parent_id"` |
| `tool_result` | `{"role":"tool","kind":"result","tool_call_id":<id>,"tool_value":<value>,"tool_error":<error>}` + 可选 `"tool_parent_id"` |

- tool 消息**没有 `content` 字段**（结构化字段是唯一真源）。
- `tool_parent_id` 用于 `run_code` 子调用分组；孤儿 `tool_result`（没有前置 `tool_call`）照常输出，映射不配对、不过滤。

### 4.3 `session.json` 与日志的关系

`cli-main.jsonl` 是引擎的**对话历史**；`session.json` 是 Studio 的**会话元数据**（模型 / 提示词绑定），引擎完全不读它。

### 4.4 `/compact` 之后的日志形态

`POST /api/sessions/{id}/compact` 成功后（`planCompaction`，`packages/runtime/src/compact/plan.ts`）：

```
turn-1: turn_start / user_message("【上下文压缩】<摘要，≤20000 字符>")
        / assistant_message("上下文已压缩，以上为历史摘要。") / turn_end(completed)
turn-2 .. turn-(K+1): 最近 K=4 个完整轮，内容原样，仅 turn_start/turn_end 的 id 重编号
```
- 轮 id 用引擎原生 `turn-<n>`（`nextTurnNumber`，`packages/core/src/turn-id.ts`，由 `packages/session/src/turn-id.ts` 转发；只认这个前缀），所以重放后新轮从 `turn-(K+2)` 起，不与磁盘撞号。
- 未闭合的尾轮与首个 `turn_start` 之前的事件**一律丢弃**。
- 阈值：完整轮数 `<= 8` 直接跳过（`COMPACT_THRESHOLD`）；即需要 ≥9 个完整轮。
- 备份：`cli-main.jsonl.precompact`（**单副本、覆盖式**），是重绑失败后唯一的人工回滚通道。

---

## 5. 落盘保证对比（重要）

| 写入 | 原子性 | fsync | 备注 |
|---|---|---|---|
| `workspaces.json` | tmp + rename | **无** | registry 变更立即持久化 |
| `providers.json` | tmp + rename + **0600** | 有（`fsync: true`） | 每次写重设权限 |
| `prompts.json`（global / 工作区 canonical） | tmp + rename | 无 | 无权限要求 |
| `cli-main.jsonl`（引擎写入） | 引擎 `PersistentSessionLog`（`packages/session/src/log/persistent.ts`）负责 | 引擎决定 | Studio 不直接写 |
| `cli-main.jsonl`（compact 重写） | 先备份 → tmp + fsync → rename（`rewriteAtomic`，`packages/runtime/src/compact/rewrite.ts`） | **有** | 失败删 tmp |
| `session.json` | 直接写入（**非原子**） | 无 | 内容极小，仅创建时写 |

---

## 6. `celestea.toml` 与引擎剖面

```toml
model = "deepseek-v4-flash-0731"
base_url = "http://127.0.0.1:3001/v1"
api_key_env = "CELESTEA_API_KEY"
```
- 解析链（compose 步骤 `resolve_profile`，步骤名冻结在 `packages/runtime/src/profile.ts` 的 `COMPOSE_STEPS`；现役实现 `apps/studio/src/runtime/engine-profile.ts`，Studio 启动时调用）：`./celestea.toml` > `./profile.json` > `~/.celestea/celestea.toml` > `~/.celestea/profile.json` > 默认值。
- **key 绝不写在这个文件里**：只写 `api_key_env`（环境变量名）；key 的来源是 env → `api_key_file` → `~/.celestea` 配置。
- 启动后 `profile.max_steps` 被抬到 `MIN_STEPS = 4096`（引擎 agent loop 的 `max_steps=0` 意味着"零步"而不是"无限"，所以"无限"只能用高上限表达）。
- `providers.json` 的 `default_model` 会在首次 compose **之前**覆盖这里的 `model`（并在日志里打印一行提示，不含 key）。

---

## 7. 相关环境变量（数据文件视角）

| 变量 | 作用 |
|---|---|
| `CELESTEA_WORKSPACES_FILE` | `workspaces.json` 路径 |
| `CELESTEA_PROVIDERS_FILE` | `providers.json` 路径 |
| `CELESTEA_PROMPTS_FILE` | 全局 `prompts.json` 路径 |
| `CELESTEA_SESSION_DIR` | 引擎要回放的**会话目录**（由 activate/rename/compact/启动恢复设置） |
| `CELESTEA_API_KEY` | 引擎 key 通道（`api_key_env` 默认指向它） |
| `DEEPSEEK_BASE_URL` | `resolve_base_url` 的 env 兜底 |
| `CELESTEA_AUTOWAKE` | `0/off/false/no` 关闭 autowake |
| `STUDIO_BIND` | HTTP 绑定地址（默认 `127.0.0.1:3777`） |
| `CELESTEA_TOOL_ROOTS` | **引擎**工具读根白名单；Studio 的 `/api/fs/browse` **不读**它 |
