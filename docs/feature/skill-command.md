# 技能显式调用（`/{技能名}`）

> 状态：设计（未实现）。
> **依赖**：[`composer-surface.md`](./composer-surface.md)（输入栏与命令面）。本设计**消费**它的补全框分组能力与发送前变换缝，不重复描述那两处引擎改动。

## 0. 目标与边界

**目标**：让人在对话框里**显式**要求加载某个技能，且加载是**确定的**——不依赖模型"记得看目录、愿意调工具"。

今天技能只有一条到达路径：模型读每轮注入的技能目录（`name + description`），自己决定要不要调 `load_skill`。人无法主动要求。本设计补上人这一侧。

**边界**：

- 触发形态是 `/{技能名}` 直呼（理由见 §1.2）。
- 只做"加载技能正文"，不做技能参数替换、不做技能编排、不做 MCP。
- 不改技能目录的注入方式（仍是每轮 `turnContext` 的常驻行）。
- **不描述引擎与宿主的改动**：补全框如何分组、发送入口如何放行，都归方案一。

**实施分两段**：方案一先把分组能力与放行缝做好并**独立验收**（既有四条命令与 `@` 零回归），本设计再在其上加技能语义。这样"改了所有命令公共路径"的风险与"技能链路对不对"的风险分开暴露。

**前置更新**：方案一已扩入富文本迁移（composer-surface §9：`#input` 换成 Lexical）。切片 1–3 与编辑器无关、可并行；切片 4 依赖迁移完成。

## 1. 形态决策

### 1.1 两个参考实现在这一点上分歧

| | deepseek-harness（DSH） | ZCode |
|---|---|---|
| 用户调用 | `/{技能名}` 直呼 | `/skill <name> [task]` |
| 命名空间 | 技能与命令共用 `/` 菜单（两个分组） | **彻底分离**，技能名不进 `/` 清单 |
| 解析点 | **host** 的 pre-step（确定性注入） | **客户端**，把输入改写成"强制模型调 Skill 工具" |
| 正文进上下文的方式 | host 注入 `<skill_content>`（user 消息，排最后） | 模型发起的 tool call 的 **tool result** |
| 同名冲突 | 命令优先 | 不存在（命名空间分离） |

### 1.2 决策 D1：直呼，不用 `/skill <name>`

**本仓的补全引擎决定了这件事。** `apps/web/src/ui/commands/index.ts` 的 `refresh()` 里：

```ts
if (line.startsWith('/') && !/\s/.test(line.slice(1))) { /* 弹补全 */ }
```

**第一段出现空格就不再补全**。于是：

- `/{技能名}`：技能名是第一个 token，补全路径全通。
- `/skill <name>`：选中 `/skill` 后输入框变成 `/skill `（`applyCommand` 会补一个空格）→ 下一次 `refresh` 见空格即 `hideCompletion()` → **参数位根本没有补全，用户必须手打技能名**。

要用 `/skill <name>` 就得**扩展引擎支持"参数位补全"**（识别某个命令的参数位、切换提供者）。那是为命名空间分离付的实价。

而命名空间分离在本仓的收益很小：内建命令只有四条（`run` / `goal` / `model` / `compact`），技能名撞上它们的概率极低；真撞上了，补全框的分组（方案一 §1）也会把两个同名项**都显示出来**，用户看得见，不会静默。

**所以：直呼为主形态，不提供 `/skill` 逃逸口。** 撞名时命令优先、技能不可直呼——这与 DSH 一致。

### 1.3 决策 D2：确定性放 host

`/{技能名}` 之后由 **host** 识别这一行、读 SKILL.md、把正文作为注入行写进会话日志。不采用 ZCode 的"改写成 prompt 让模型自己调 `load_skill`"——那条路确定性依赖模型配合，而 `load_skill` 工具已经在手，没有理由不直接注入。

### 1.4 决策 D3：命中确认，以及"两端必须同源"

用户需要**看得见命中**。承担它的是两件事：补全框分组（方案一 §1，发送前）与 chip 化命中确认（本设计切片 4，打字时）。

**贯穿两者的硬约束**：识别 `/{技能名}` 的**纯函数只能有一份**，前端与服务端共用。理由不是洁癖——若前端自己写一份宽松解析（比如接受大写、或扫描句中任意位置），就会出现**高亮亮了、host 却不认**的情形，用户以为技能已加载。这比不做高亮更坏。

ZCode 在这个形状上踩过两次：`disable-model-invocation` 在目录构建与加载两处语义不一致成了装饰品；桌面端与 CLI 各扫一遍磁盘导致"界面看得见、会话调不到"。本仓 `styles/tokens.css` 里的 W895-C 是同一形状的第三种：**"生效了但看不见 / 看得见但没生效"，两头都是事故。**

### 1.5 决策 D4：规范形态 `/skill:<name>`（选中即改写）

**问题**：`/{名字}` 直呼时，用户**看不出**这一行最终是「命令」还是「技能」——两者共用一个 `/` 面。（历史上本仓输入框是纯文本 `<textarea>`，没有参考实现那种富文本 chip 可看；该限制已由 composer-surface §9 的 Lexical 迁移解除，chip 成为命中确认的最终形态。但「选中即改写规范形态」**仍然保留**——它同时是 chip 的文本投影与手打入口。）

**做法**：从补全框**选中技能行**时，把草稿改写成**规范形态** `/skill:<name>`。用户一眼就知道自己选的是技能命名空间。

- **不推翻 D1**：D1 拒绝的是 `/skill <name>`（**空格**形态）——它会让 `refresh()` 在第一个空格处关掉补全，参数位没有补全（§1.2）。`/skill:<name>` **没有空格**，`line.startsWith('/') && !/\s/.test(line.slice(1))` 仍成立，补全路径全通。
- **字符串契约**：`/skill:<name>` 是**规范形态**，由 [`composer-surface.md`](./composer-surface.md) §7 那个函数产出与接受；**裸 `/{名字}` 仍然等价可用**（既有习惯，且 §1.2 已拍板撞名时命令优先）。与之相对，MCP 的 `/mcp:<server>` 是**唯一**形态（裸名永不代表 MCP，见 [`mcp-client.md`](./mcp-client.md) §5.6）——差别在于 MCP 是第三个命名空间、名字由用户配置，撞上四条内建命令的概率远高于技能。
- **代价与归属**：文字改写便宜，落在既有的 `onPick` 缝上（`choose()` 只调 `onPick(item)`，`apps/web/src/ui/commands/popup.ts:99`；Lexical 迁移后「写回草稿」改由 composer-surface §9.2 的适配缝承担，缝的语义不变）。**chip 化**按 [`composer-surface.md`](./composer-surface.md) §8/§9 属于**输入栏整体能力**——本设计的切片 4 是**第一个 chip 消费者**（技能先上），规则归 §8，本设计不单独实现编辑器机制。
- **顺带解决的问题**：撞名时技能不再「不可直呼」（见 §5 与 §6）。

## 2. 技能侧现状与障碍

技能侧已经齐了：发现（`packages/core/src/skills.ts`，两层来源，project 覆盖 global）、常驻目录（`packages/core/src/skill-catalog.ts`，由 `apps/studio/src/runtime/goal-wiring.ts` 的 `turnContextFor` 每轮注入）、按需正文（`packages/tools/src/tools/load-skill.ts` 的 `load_skill` 工具）。

缺的是人这一侧的入口，有两个真实障碍。

**障碍 1：前端不知道有哪些技能。** `apps/studio/src/handlers/` 下没有任何技能端点（只有 `session-tools.ts` 对应 `/api/sessions/{id}/tools`）。补全分组、名字校验、高亮都要它。→ 切片 1。

**障碍 2：没有"输入之后"的注入口。** 用户输入行的 append 在 `packages/agent-loop/src/loop.ts` 的 `runTurnOutcome` 内部，host 插不进去。唯一现成口子是 `afterInput`，但它**只返回一条**，且 origin 被写死成常量 `"goal"`。→ 切片 3。

**第三个障碍已由方案一解决**：`/xxx` 发不到 host（`send.ts` 丢弃 `dispatchCommand` 的返回值）。本设计直接消费方案一做完的放行缝。

### 2.1 一个必须避开的陷阱：不要复用 `origin: "skill"`

技能正文**不能**复用 `turnContext` 里 catalog 用的 `origin: "skill"`。`packages/runtime/src/turn-context-dedup.ts` 的去重是**按 origin 比的**：

```ts
if (lastInjectedText(events, row.origin) !== row.text) { selected.push(row); continue; }
```

技能正文与技能目录共用 `"skill"` 会让两者互相顶掉——目录会**每隔一轮被重复注入一次**，正好打穿 Phase 0a 那条 3.0%→9.9% 的成本纪律。

**结论：显式加载必须有独立的 origin。**

## 3. 设计

### 3.1 端到端流程

```
用户：/review 帮我看看这个 PR
  ↓ 前端 commandProvider（技能组，消费方案一的分组能力）
  ↓ 打字时 chip 化命中的 /review（切片 4）
  ↓ 发送时 dispatchCommand：查命令表没有 → 查技能清单命中 → return false
  ↓ （方案一的发送前变换缝把它放行给正常发送路径）
  ↓ POST /api/turn { text: "/review 帮我看看这个 PR" }
  ↓ host：turn 组装时用同一个 matchSkillGesture 解析行首
  ↓ loadSkillBody(readLayers(workspace, {env}), "review")
  ↓ 注入行：<skill_content name="review">…正文…</skill_content>
  ↓ 排在用户输入行之后
```

**发给 host 的是原文**（含 `/` 前缀），host 解析它。前端不改写文本——改写会让会话日志里留下一条用户没打过的话。

**命令与技能的分工是干净的**：命令在前端就被消费、根本不发 `/api/turn`；因此**能到达 host 的 `/xxx` 只可能是技能**（或未命中）。host 不需要裁决命令与技能谁优先。

### 3.2 触发解析：一份纯函数，两端共用

手势解析函数已建在 `packages/gesture`（`@celestea/gesture`，composer-surface §7 的最终落点：core 顶层引用 node API，前端依赖会炸）：

- **只认行首**的 `/{名字}`。与 `commands/index.ts` 的 `isCommand`（`line.startsWith('/')`）语义一致。**不采用 DSH 的"词边界可命中句中任意位置"**——那个正则在聊天文本里会误吃路径与分数（`3/4`、`a/b`），而本仓 `/` 的既有语义就是行首（`@` 才是任意位置）。
- 名字按本仓既有的 `SKILL_NAME_PATTERN` 校验（`packages/core/src/skills.ts` 已导出）。
- 剩余文本即 task，原样留在用户输入行里，**不单独提取、不注入**——模型看得到用户的原话。
- 返回 `{ name, task, end } | null`，纯函数，零 IO。`end` 供高亮层定位区间。
- **接受两种形态**：规范形态 `/skill:<name>`（§1.5）与裸 `/{名字}` **等价接受**，并产出 `canonical` 供调用方改写草稿。
- **函数要通用化**：识别归 [`composer-surface.md`](./composer-surface.md) §7 那份**带 `kind`** 的实现（`kind ∈ { "command" | "skill" | "mcp" }`），本设计只消费 `kind === "skill"` 那一支——避免同端出现第二、第三份 `/` 解析。函数名与落地文件由那一节定，本文其余处仍称 `matchSkillGesture`（技能侧视角）。

**它不知道清单**（只做语法解析）；"这个名字是不是真技能"由两端各自用清单判断。这样函数零依赖、可单测。

放 `core` 的理由：前后端都要用，而 `core` 是两者唯一的共同下层（`apps/web` 不经过 `runtime`，见 `ARCHITECTURE.md` 的分层）。

**为什么不用 `parseLine`**：`commands/index.ts` 已有的 `parseLine` 能从 `/review 看看` 提出 `{name, args}`，但它**不校验字符集**（`name = body.slice(0, sp)`）。两份判定会分叉——正是 §1.4 要避免的形状。

**未命中**：前端已用技能清单校验过，正常路径不会走到这里；但清单缓存会过期（新装的技能）。host 侧未命中时**注入一条可见的失败行**（同一 origin），而不是静默——用户明确要求了加载，假装成功是最坏的选项。

### 3.3 注入行的渲染

照 ZCode 的格式，含 base directory 声明——让模型能解析技能正文里的相对路径：

```
<skill_content name="review">
# Skill: review

<SKILL.md 正文，frontmatter 已剥离>

Base directory for this skill: <技能目录绝对路径>
Relative paths in this skill are relative to this base directory.
</skill_content>
```

### 3.4 车道：afterInput 泛化为多行多 origin

`afterInput` 目前是"goal notice 专用、单条、origin 写死"。它与技能注入是**同一类东西**：都属于"本轮输入之后的一次性行"。把它泛化比新开一条平行车道更合理——否则两条同位置的车道会各自演化。

改动：

- `packages/agent-loop/src/loop.ts`：`AfterInputRow` 加 `origin` 字段；`afterInput` 的签名从「返回单条」改为「返回数组」，并接收本轮 `userInput`；`appendAfterInput` 遍历数组，每行各自 append、各自调 `delivered()`；常量 `AFTER_INPUT_ORIGIN` 退役。
- `packages/runtime/src/turn-runner.ts`：`afterInput` 类型两处跟随；`peekAfterInput` 从"非空吗"改为"有没有 `origin === "goal"` 的行"（goal 的 suppression 规则依赖它）；`resolveLoop` 传递。
- `packages/runtime/src/compose.ts`：类型跟随。
- `apps/studio/src/runtime/goal-wiring.ts`：`goalNotice` 返回单元素数组，带 `origin: "goal"`。

**为什么 provider 需要 `userInput`**：loop 里输入行的 append 就在 `appendAfterInput` 之前，而 `userInput` 是 `runTurnOutcome` 的形参——顺手传下去即可，不需要让 provider 从日志里反查。

**为什么不用 turnContext**：它在输入行**之前**注入（`turn-runner.ts` 的 `drive` 里先 `injectTurnContext` 再 `loop.runTurn`），而技能正文应当最靠近模型的回答；且 `turn-context-dedup.ts` 的设计前提写死为 state is a pure function of (log, config)，"常驻行依赖本轮输入"会把一次性语义塞进常驻车道。

### 3.5 独立 origin

新增 `"skill-invocation"`：

- `packages/core/src/types.ts` 的 `SESSION_EVENT_ORIGINS`（闭集，加值 = 契约变更）。
- `contracts/session-event.schema.json` 的 origin 枚举。
- `packages/session/src/messages.ts` 的 `originLabel`（现有 `skill: "技能目录"`，新增一条区分开）。

## 4. 实施工单

**前置**：方案一已落地并验收（分组能力 + 发送前变换缝）。三个切片的顺序是 **1 → 2 → 3**。

### 切片 1：技能清单端点

**形态**：`GET /api/sessions/{id}/skills`——与既有 `GET /api/sessions/{id}/tools` 的**会话级路径参数**形态对齐（不是 query 参数）。

**加端点在本仓要动冻结数字。** `docs/AGENT.md` 必读第 5 条：契约数字**三处一致**，只改一处会静默漂移。完整清单：

| # | 处 | 改什么 |
|---|---|---|
| 1 | `packages/core/src/contracts/index.ts` | `FROZEN_COUNTS.endpoints` 72 → 73（**冻结锚点**；`API_ENDPOINT_COUNT` 从它派生，自动跟随） |
| 2 | `contracts/endpoints.json` | `title` 里的 `(72 endpoints)`、`count`、`endpoints[]` 加一条 |
| 3 | 同上，`source.routeTable` | **追加**一句变更说明——该字段是追加式的变更史，格式照现有条目（"W<n> added <METHOD path> (N -> N+1; <为什么>)"） |
| 4 | `contracts/route-table.snapshot.json` | 再生成；`pnpm contracts:verify` 必须绿 |
| 5 | `docs/README.md` | 契约段里的「72 端点」 |
| 6 | `tests/w9348-goal-get.test.ts` | 硬编码的 `expect(FROZEN_COUNTS.endpoints).toBe(72)` |

**为什么不搭已有端点的车**：`docs/feature/mcp-client.md` 特意选择"给已有端点加字段、不加端点"来绕开这份清单。本设计不走那条路——技能不是工具（`/tools` 语义不合），也不属于 `/context` 的诊断面（后者返回整个 `messages`，为一份清单拉它太重）。这份清单是可枚举的一次性成本，写全了就不算风险。

| 步骤 | 文件 |
|---|---|
| 1. 契约六处 | 见上表 |
| 2. HTTP 面 | 新增 `apps/studio/src/handlers/skills.ts`——只做 HTTP，数据来自 runtime（形态照 `apps/studio/src/handlers/session-tools.ts`） |
| 3. runtime 面 | `apps/studio/src/runtime-adapter.ts` + `real-runtime-adapter.ts` 加 `sessionSkills(session)` |
| 4. 共享解析 | 抽一个函数，让端点与 `goal-wiring.ts` 的目录注入**用同一份 `readLayers` 入参**（同一 workspace 路径 + 同一 `env`） |

回体形状：`{ ok, session, skills: [{ name, description, source, dir }], rejected: [] }`。

**数据源纪律**：`readLayers` 的入参必须与 `turnContextFor` 完全一致，抽共享函数是唯一保险。ZCode 在这上面踩过坑——它的 UI 曾独立扫盘，导致"界面看得见、会话调不到"。

**本仓的一个优势**：技能是**每轮 turn 起点重读**的（`turnContextFor` 每轮调 `listSkills`），没有"会话快照"概念，端点直接实时读即可，天然不漂移。这一点与 ZCode 的"每会话只发现一次"不同，不要照搬它的快照缓存。

**测试**：
- `tests/contracts.test.ts` 的契约对拍（端点数是单一真源）。
- 端点单测：有技能 / 无技能（回空数组而非报错）/ 无 workspace（detached）/ `{id}` 指向不存在的会话。
- 变异负控制：把 workspace 路径换成硬编码常量 → 测试必须红。

### 切片 2：技能侧接入

只做技能语义，引擎能力全部消费方案一。

| 步骤 | 文件 |
|---|---|
| 1. 手势解析 | **已由 composer-surface §7 先行交付**：`packages/gesture` 的 `parseSlashGesture` / `canonicalSlash`（切片 3、4 都消费它） |
| 2. 技能清单缓存 | 新增 `apps/web/src/ui/commands/skills.ts`（按 session 拉取 + 缓存，形态照 `commands/files.ts`） |
| 3. 技能组接入 | `apps/web/src/ui/commands/index.ts` 的 `commandProvider`——把技能数组并入，带 `group` 标记（分组能力见方案一 §1） |
| 4. 放行判断 | `apps/web/src/ui/commands/index.ts` 的 `dispatchCommand` 未知分支改成"先查技能清单"（放行缝见方案一 §2） |
| 5. 文案 | `apps/web/src/i18n/locales/{zh,en}/chat.ts` |

**第 4 步的判定表**：

```
命令表命中        → cmd.run(...)          → 消费
技能清单命中      → return false           → 放行给 host
两者都没有        → renderInfoBlock 报错   → 消费（保持现有行为）
```

放行判断用**切片 2 第 1 步建的 `matchSkillGesture`**（= `parseSlashGesture` + 技能清单裁决；裸 token 的语法 kind 一律是 `command`，`/review` 与 `/help` 语法不可区分，清单裁决在调用方——这是 gesture 包的既定语义），不用 `parseLine`（理由见 §3.2）。

**同步性纪律（审计发现）**：放行判定**只读同步缓存**，缓存 miss 按「未命中」处理——`clearInput` 在 `dispatchCommand` resolve 之前执行，若放行判定等网络拉清单，会出现「输入框已清空、消息还没发出去」的可见间隙。清单的新近性由 host 侧再校验兜底（§3.2 未命中注入失败行），技能的识别可靠性不依赖前端这一次判断。

**清单缓存时效**：`commandProvider` 是同步函数会读到过期清单。做法是**在 `onPaneChange`（会话切换）时失效重拉**，并在补全首次打开且缓存为空时异步补拉一次；`PopupProvider` 本来就允许返回 Promise，`showCompletion` 已经 `await`，popup 引擎自带 seq 竞态守卫，不需要为异步额外改造。

**测试**：
- `parseSlashGesture` 解析矩阵已在 `packages/gesture/src/slash-gesture.test.ts` 交付（正常 / 无参 / 名字非法 / 多行 / 非行首）；本切片只补「技能清单裁决」一侧的用例。
- 命令矩阵：`/run`（命令，消费）/ `/review`（技能，放行）/ `/ghost`（都不是，报错）/ 既有四条命令不回归。
- 技能组渲染：技能项出现在"技能"组下、带描述（渲染本身的断言在方案一 §1.5）。
- 变异负控制：把放行改成 `return true` → 端到端测试必须红（技能正文永远进不了日志）。

### 切片 3：afterInput 泛化 + host 注入

| 步骤 | 文件 |
|---|---|
| 1. origin 闭集 | `packages/core/src/types.ts` + `contracts/session-event.schema.json` + `packages/session/src/messages.ts` |
| 2. afterInput 泛化 | `packages/agent-loop/src/loop.ts`、`packages/runtime/src/turn-runner.ts`、`packages/runtime/src/compose.ts` |
| 3. goal 跟随 | `apps/studio/src/runtime/goal-wiring.ts`——`goalNotice` 返回数组 |
| 4. 注入装配 | 新增 `apps/studio/src/runtime/skill-wiring.ts`（消费切片 2 的 `matchSkillGesture`）；`apps/studio/src/runtime/session-compose.ts` 只加**装配一行** |
| 5. 工具描述加固 | `packages/tools/src/tools/load-skill.ts` 的 `LOAD_SKILL_DESCRIPTION` |

**第 4 步的行数约束**：`session-compose.ts` 的有效行正好卡在 450 行硬线上（`goal-wiring.ts` 的头注记录了这件事，ratchet 只降不升）。所以解析、加载、渲染全进新文件，`session-compose.ts` 只增加把两个 provider 合成的调用。

**第 5 步借 ZCode 的四条纪律**（它写在工具描述里，成本几乎为零，直接提升模型自主调用时的可靠性）：

- 只调用目录里出现过的、或用户显式打出的技能名，**绝不凭训练数据猜**；
- 命中时是 **blocking requirement**：先调用再回答；
- **绝不在嘴上提技能而不调用工具**；
- 看到已加载标记就**不要重复调用**。

**测试**：
- 端到端（真引擎）：跑一轮 `/review …`，断言日志里出现 `<skill_content name="review">`，且**位置在用户输入行之后**。
- 端到端：`/ghost`（绕过前端校验直接打到 host）→ 注入失败行，不静默。
- goal 回归：现有 goal notice 测试全绿（这是本次改造的主要回归面）。
- **三条变异负控制**（AGENTS.md 铁律 2）：
  1. 去掉解析正则的行首锚点 → 手势测试必须红；
  2. 把注入行的 origin 换成 `"skill"` → 目录去重测试必须红（这条正好钉住 §2.1 的陷阱）；
  3. 破坏 goal 的 suppression（`peekAfterInput` 不看 origin）→ goal 测试必须红。

### 切片 4：命中确认 = chip（消费 Lexical 迁移）

**归属更新（二次）**：本切片原为「草稿期高亮（镜像层）」。composer-surface §9 决定输入栏整体迁移到 Lexical 后，镜像层路线**作废**——本切片改为**第一个 chip 消费者**：技能 token 的 chip 化。编辑器机制（decorator node、适配缝、原子删除、草稿序列化）全部由 composer-surface §9 交付，这里只接技能语义。

**目标**：打字时，命中的 `/{技能名}`（含规范形态 `/skill:<name>`）在输入框内渲染为 chip——与参考实现同形态。

**技能侧只做三件事**：

- **chip 化触发**：行首 token 命中技能清单（切片 2 的缓存）→ 调适配缝把文本节点替换为 chip 节点；失配（技能被卸载）→ chip 退化为普通文本。判定仍是同一个解析函数（composer-surface §7），前端**不许另写一份**（§1.4）。
- **chip 的文本投影**：`/skill:<name>`——发送时编辑器导出即规范形态，host 注入路径零改动。
- **草稿**：按 composer-surface §9.1 E3 存编辑器序列化状态；恢复失败时**回退纯文本**（宁可丢 chip，不丢字）。

**测试**（走 `@lexical/headless`，node 里跑、不依赖 jsdom）：
- chip 化：输入 `/review` 且清单命中 → 断言出现 skill chip 节点；未命中 → 纯文本。
- 文本投影：含 chip 的编辑器状态导出 → 断言等于 `/skill:review …` 规范字符串。
- 原子删除：Backspace 触及 chip → 整体删除，无 `skill:rev` 残肢。
- 退化：清单移除该技能后重解析 → chip 变回文本。
- 草稿 round-trip：序列化 → 恢复 → chip 仍在；损坏的序列化 → 回退纯文本。
- **结构断言（同源防线）**：`apps/web/src/**` 里不得出现第二份解析 `/{name}` 的正则字面量（除 import 那份函数外）。这条不是形式主义——它钉的正是 §1.4 那个"两端分叉"的失效形状。

### 验收标准

1. `/` 补全框里技能项出现在"技能"组下、带描述（分组本身的行为由方案一验收）。
2. `/review 帮我看看` 一轮后，会话日志里的 `<skill_content>` 紧跟用户输入行。
3. `/ghost` 有可见反馈，不静默、不假装加载。
4. 打字时命中的 `/{技能名}` 在输入框内呈现为 chip，未命中无 chip；chip 化的判定与 host 注入的判定**是同一个函数**，且 chip 的文本投影等于规范形态 `/skill:<name>`。
5. goal 行为零变化（现有测试全绿）。
6. 全量 `pnpm check` 通过。
7. 从补全框选中技能行后，草稿变为规范形态 `/skill:<name>`；`/skill:review` 与裸 `/review` 走**同一条**注入路径（判定与注入仍是同一个函数）。

## 5. 明确不做

- **`/skill <name>` 逃逸口**：见 §1.2。撞名时命令优先、裸名直呼不可达（与 DSH 一致）。**规范形态 `/skill:<name>`（§1.5）不是这条路**：它没有空格、不受补全引擎限制，而且**顺带把撞名解掉了**——撞名时技能仍可通过规范形态被显式调用。
- **句子中间的 `/{名字}`**：见 §3.2。只认行首；句中命中会误吃路径与分数，且与 `isCommand` 的既有语义冲突。
- **MCP**：本仓没有 MCP 实现（设计见 `docs/feature/mcp-client.md`，代码尚未开始），且那份设计明确不做 prompts 模板——所以"MCP prompt 变斜杠命令"不在任何计划里。这是独立工程，不进本设计。
- **技能调用策略**（`disable-model-invocation` 这类）：本仓 frontmatter 白名单目前没有这个字段。ZCode 有字段但**没有消费点**——它只把一个展示用的布尔值改掉，标了"仅用户可调用"的技能照样进模型目录、照样能被加载。若将来要做，必须在**目录构建**与**加载**两处同时过滤，只过滤一处必然产生"看得见调不动"或"调得动看不见"的错配。
- **技能参数替换**（`$ARGUMENTS` 之类）：ZCode 的 `Skill` 工具 schema 声明了 `args` 却从不读，是死参数。本设计不重复这个错误——task 就是用户输入行的原文，不另做占位符替换。
- **补全框引擎与发送入口的改动**：见 [`composer-surface.md`](./composer-surface.md)。

## 6. 已知风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 清单缓存过期 | 新装的技能在旧缓存里不存在，直呼会被判"未知命令" | 会话切换时失效重拉；报错文案提示可切换会话刷新 |
| 撞名 | 技能名与内建命令相同 ⇒ 裸名直呼不可达 | 补全框分组把两个同名项**都显示出来**（不静默消失）；要显式指定技能就用规范形态 `/skill:<name>`（§1.5） |
| 两端判定分叉 | 前端高亮认了、host 不认（或反之） | 只此一份 `matchSkillGesture`；切片 4 的结构断言钉住 |
| Lexical 迁移回归面 | 输入栏 8 处耦合（值读写 / Enter / IME / 粘贴 / 草稿 / 补全锚点 / 增高 / 假光标）同时改道 | composer-surface §9.2 适配缝收口 + headless 测试矩阵 + 中文 IME 真机回归（W2033 面） |
| `afterInput` 泛化 | 动 `@celestea/agent-loop` 的公开接口，且 goal 是唯一现有生产者 | goal 回归测试是主要防线；`peekAfterInput` 的 suppression 语义要有专门断言 |
| 契约变更两处 | origin 闭集与端点表都要对拍 | `pnpm contracts:verify` + `tests/contracts.test.ts` |
| 技能目录的成本纪律 | 新 origin 若与目录共用会打穿去重 | §2.1 的陷阱 + 变异负控制 2 |

## 7. 与参考实现的关系

本设计 = **DSH 的触发形态与确定性机制**（直呼 + host 侧识别并注入正文 + 草稿期命中确认）+ **ZCode 的分组呈现**（分组能力本身见方案一）。

不照搬 ZCode 的两点：它的触发形态 `/skill <name>` 在本仓会让参数位补全失效（§1.2）；它的"改写 prompt 让模型自己调工具"确定性地依赖模型配合，而本仓 `load_skill` 工具已在手，没有理由不直接注入。

不照搬 DSH 的一点：它的技能手势正则可命中**句子中间**的 `/{名字}`，本仓只认行首（§3.2）。

另外记下两个 ZCode 的低成本改进（不在本次范围，可另行排期）：

- **技能目录超预算时降级而非丢弃**：本仓 `skill-catalog.ts` 现在超出上限会直接丢弃并报 `+N more`，ZCode 的做法是降级成"只列名字"（预算 20k 字符），保证每个技能**仍可见可加载**。
- **目录里带技能目录绝对路径**：`load_skill` 不可用时模型能退化成 `read_file` 读那份 SKILL.md。
