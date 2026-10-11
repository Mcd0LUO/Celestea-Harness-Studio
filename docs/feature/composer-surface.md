# 输入栏与命令面（composer surface）

> 状态：**已实现**（放行缝 + 补全框分组 + 统一 `/` 解析（`@celestea/gesture`）+ Lexical 富文本迁移与 chip 命中确认；切片与偏差见 §7/§9）。

## 0. 目标与边界

**目标**：把「输入栏 + `/` 命令补全 + 发送入口」这一层整理清楚，让技能的显式调用（见 [`skill-command.md`](./skill-command.md)）只需要写技能语义，引擎与宿主的改动在这一份里解决。

**一个诚实的前提**：本设计里的两项代码改动（补全框分组、发送前变换缝）**当前都由技能显式调用这一个需求驱动**。它们不是"通用框架的第一块砖"，也不该被当成"以后什么都能挂上来"的底座。

拆出来做，图的是两件事：

1. **风险隔离**——发送前变换缝改的是**所有**命令的公共路径，单独实施、单独跑全量门禁，比混在技能改动里更容易定位问题；
2. **将来复用**——`#` 引用、`+` 附件菜单若要进补全框，分组能力与触发源都在这一层。

**准入判据**：任何新内容要进本设计，必须回答"技能与（将来那）第二个消费者是否都需要它"。§5 用这条挡掉了两项。

**判据更新：第二个消费者已经出现。** MCP 客户端要进同一个 `/` 面（见 [`mcp-client.md`](./mcp-client.md) §5.6：`/mcp:<server>` 直呼注入）。条件成立，原被挡掉的两项因此在 §7 / §8 重新上桌；**仍被挡住的是「任意触发源的注册表」**——MCP 不是第三个**触发源**（它也走 `/`），它是 `/` 里的第三种 **kind**（§7）。

**形态升级（已定）**：输入栏整体从 `<textarea>` 迁移到 Lexical 富文本（§9），命中的 token 以 chip 呈现（§8）。§3 的「textarea 插不了 DOM」结论随之作废，仅作历史记录保留。

## 1. 补全框的分组能力

### 1.1 现状

- `apps/web/src/ui/commands/popup.ts` 是**单一补全框引擎**（`/` 命令与 `@` 文件共用），头注写明"不另写第二个补全框"。
- 渲染是**扁平列表**：`items` 数组逐项渲染成 `.cmd-row`，`active` 是它的索引。
- 提供者是**单值**：`setProvider(commandProvider | fileProvider)`，由 `apps/web/src/ui/commands/index.ts` 的 `refresh()` 按输入行分支选择。

### 1.2 需求

命令与技能要在同一个框里混排，并且要能一眼分清哪一行是命令、哪一行是技能。

### 1.3 设计：分组头是渲染装饰，不进 `items`

`PopupItem` 加一个可选 `group?: string`；`renderList()` 遍历时，若当前项的 `group` 与上一项不同，先插入一个 `.cmd-group`。

**这条设计决定了成本**：分组头**不进 `items` 数组**。因此

- `active` 索引、`(active ± 1) % items.length`、`choose(active)`、`.cmd-row.active` 查询**全都不用动**；
- `@` 文件模式不传 `group` ⇒ 不出现组头 ⇒ **零影响**。

这是本仓能做到"约 6 行渲染 + 一条 CSS"的原因。若把组头当成一个可选项加进 `items`，就要额外处理"不可选中"与"键盘跳过"，成本翻几倍。

### 1.4 为什么不用颜色区分种类

本仓是唯一 `mono` 主题：`--c-accent` 是 `#1a1a1a`、`--c-text-1` 是 `#111`，差 3%，**肉眼不可辨**。`styles/tokens.css` 里躺着一条同款事故记录：

> `--hl-title` 与正文 `--c-text-1` 同为 `#111` ⇒ 完全不可辨，实测「高亮生效了但看不见」

现有的 `.cmd-row.dir` 用 accent 色区分目录项，在同一个主题下同样是弱区分——不要沿用这条路。

### 1.5 测试

- 命令组在前、技能组在后。
- 只有一个分组有内容时，另一组的组头**不出现**。
- `@` 文件模式**不出现任何组头**。
- `↑`/`↓` 在混排列表里逐项移动，**不跳组**（这是"组头不进 items"的直接断言）。

## 2. 发送前变换缝

### 2.1 现状

`apps/web/src/ui/commands/index.ts` 的 `dispatchCommand` **已经返回** `Promise<boolean>`（true = 已消费），但 `apps/web/src/ui/send.ts` 的 `dispatchSend` **丢弃这个返回值**：

```ts
if (isCommandLike(t)) {
  clearInput();
  ctx.draft = '';
  void dispatchCommand(t, ctx);   // 返回值被丢掉
  return;                          // 无条件 return
}
```

接口设计了返回值却没人用——这是个既有的半成品，不是新需求凭空引入的复杂度。

本仓**已有**"发送前改写输入"的先例：`normalizeBang` 把 `!xxx` 改写成 `/run xxx`。

### 2.2 需求

命令要能表达"这一行我不管，放行给 host 正常发送"。

### 2.3 设计

把 `isCommandLike` 分支**之后**的"正常发送"逻辑抽成一个函数，让命令的异步结果决定走哪条：

```ts
if (isCommandLike(t)) {
  clearInput();
  ctx.draft = '';
  void dispatchCommand(t, ctx).then((consumed) => { if (!consumed) sendNormal(ctx, t, mode); });
  return;
}
```

`sendNormal` 承接原本分支之后的**全部**逻辑（worker 专线、streaming 插话/排队、`startTurn`），**逐字搬运，不改语义**——那部分有既有测试覆盖。

### 2.4 风险

这是全设计**风险最集中**的一处：它改的是所有命令的公共路径，不只是技能。缓解见 §6。

## 3. 输入栏的扩展点（textarea 时代盘点；迁移见 §9）

写在这里是为了让技能的 chip 命中确认（见 [`skill-command.md`](./skill-command.md) 的切片 4）知道该接在哪；textarea 时代的「堵死」结论已被 §9 推翻，仅作历史记录。

| 区域 | 现有实现 | 说明 |
|---|---|---|
| 待发附件条 | `apps/web/src/ui/attach-tray.ts` | 图片与文本文件的待发展示夹（W867 / W869） |
| 引用托盘 | `apps/web/src/ui/quote-tray.ts` | 引用待发 |
| 提示行 | `apps/web/src/ui/inputbar.ts` 的 `noteEl` | 入口拒收、校验失败的可见说明 |
| 补全框 | `apps/web/src/ui/commands/popup.ts` | 挂在 `#input` 上，fixed 定位贴输入框上沿 |
| 草稿跨会话 | `apps/web/src/ui/inputbar.ts` 的 `inputValue` / `setInputValue` | 文本 + 待发附件随会话保存/恢复 |

**历史结论（已被 §9 推翻）**：`#input` 曾是 `<textarea>`，**里面插不了 DOM**——DSH 能渲染 chip 是因为它的输入框是 Lexical 富文本编辑器。该结论直接促成了 §9 的迁移决定：本仓输入栏同样换成 Lexical，本节表格中 textarea 的全部耦合点（值读写 / 自动增高 / Enter 行为 / 粘贴 / 补全锚点 / 假光标）改道 §9.2 的适配缝。

**注意**：本章的分组能力（§1）**不依赖**编辑器形态——补全框是独立 DOM，无论底层是 textarea 还是 Lexical 都一样挂。

## 4. 工单

**顺序：先 2 后 1。** 发送前变换缝风险更高、且是分组能力被技能消费的前提（技能要先能被"放行"，才谈得上在补全框里出现），所以先做先暴露。

| 步骤 | 文件 |
|---|---|
| 1. 抽取 `sendNormal` | `apps/web/src/ui/send.ts`（逐字搬运，不改语义） |
| 2. 让返回值参与决策 | `apps/web/src/ui/send.ts` |
| 3. 分组字段与渲染 | `apps/web/src/ui/commands/popup.ts`——`PopupItem.group` + `renderList()` 插组头 |
| 4. 分组样式 | `apps/web/src/styles/commands.css`——`.cmd-group` |

**验收标准**：

1. 既有四条命令（`/run` `/goal` `/model` `/compact`）**零回归**，包括 worker 专线、streaming 插话/排队、附件随发。
2. `@` 文件提及**零回归**，且不出现任何组头。
3. 一个"只消费"与一个"放行"的命令都能被正确分派（后者走完整正常发送路径）。
4. §1.5 的四条渲染断言通过。
5. 全量 `pnpm check` 通过。

**变异负控制**：

- 把放行改回无条件 `return` → 端到端测试必须红。
- 让 `@` 模式也传 `group` → 文件补全的断言必须红。

## 5. 明确不做

- **触发源注册表**：曾考虑把 `refresh()` 的 if/else 整理成 `[{trigger, provider}]` 表。**不做**——技能走 `/` 分组，**不新增触发源**，这张表没有第二个需求。等真有第三个触发源（`#` 引用之类）再抽。**注意 MCP 不构成这个需求**：它也走 `/`，要做的是识别函数的 kind 表（§7），不是触发源注册表。
- ~~**镜像高亮层**~~ → **彻底作废**：§9 决定输入栏整体迁移到 Lexical，命中确认由 chip 直接承担（§8），「透明 textarea + 镜像层」这条中间路线不再需要。
- **命令注册开给插件**：`apps/web/src/ui/plugins/register.ts` 目前只暴露 `registerHintPlugin` / `registerEnhancerPlugin`，命令注册面没开。本设计不动它。
- **附件入口的任何改动**：图片/文本附件的三入口（粘贴 / 拖拽 / 左下角按钮）与待发条**已实现**（P0 + W869）。本设计不重做、不重构它们。

## 6. 已知风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| `send.ts` 公共路径 | 改的是**所有**命令，不只是技能 | `sendNormal` 逐字搬运不改语义；既有测试兜底；变异负控制钉住 |
| 分组能力的"过早通用" | 它当前只有一个消费者（技能） | 准入判据写在 §0；§5 仍挡掉触发源表；命中确认（chip）见 §8/§9（判据条件已成立） |

## 7. `/` 触发的识别与规范化（一份带 kind 的纯函数）

**为什么现在做**：§0 的判据条件成立了——`/` 面从「命令 + 技能」变成「命令 + 技能 + MCP」。

**现状是两份解析，而且定义已经开始不一致**：

| 解析者 | 位置 | 对「什么算 `/` 触发」的定义 |
|---|---|---|
| `isCommand` / `parseLine` | `apps/web/src/ui/commands/index.ts` | 补全条件 `line.startsWith('/') && !/\s/.test(line.slice(1))`；`parseLine` **不校验字符集**（`name = body.slice(0, sp)`） |
| 技能侧计划的 `matchSkillGesture` | 并入本节的 `parseSlashGesture`（[`skill-command.md`](./skill-command.md) §3.2 只消费 `kind === "skill"` 那一支） | 行首 `/{名字}` + `SKILL_NAME_PATTERN` |

再加 MCP 就是第三份。**这不是洁癖**：规范形态（`/skill:<name>`、`/mcp:<server>`）必须由**同一个函数**产出，否则补全框写出的形状与 host 认的形状会分叉——就是「亮了却没注入」那种失效形状（[skill-command.md](./skill-command.md) §1.4）。

**设计**：

- **一份纯函数，放 `packages/gesture`（`@celestea/gesture`）**——零依赖的共享叶子包，**不是 core**（落地原因见本节末「落地」）。签名 `parseSlashGesture(line) → { kind, raw, canonical, name, rest, end } | null`，`kind ∈ { "command" | "skill" | "mcp" }`。
- **只认行首**：句中 `/` 会误吃路径与分数（`3/4`、`a/b`）；`@` 才是任意位置。
- **它不知道清单**：「这个名字是不是真技能 / 真 server」仍由调用方用各自清单判断——函数零依赖、可单测。这条性质来自技能侧的设计，保留。
- **字符集按 kind 查表**：命令名 / `SKILL_NAME_PATTERN` / server 名（`^[a-z0-9][a-z0-9_-]{0,31}$`，见 [mcp-client.md](./mcp-client.md) §4.1）。**一张表 + 一份实现**。
- **规范形态由它产出**：补全框选中时调用方用 `canonical` 改写草稿（技能 `/skill:<name>`、MCP `/mcp:<server>`、命令保持 `/name`）。
- **迁移与记账**：既有 `isCommand` / `parseLine` 要么并入、要么显式登记豁免（照 `ARCH_EXCEPTIONS` 的记账风格逐个写明理由）。结构断言从「不得有第二份 `/{name}` 正则」升级为「**不得有第二份 `/` 触发解析**（豁免清单除外）」。
- **落地（已定，不再是备选）**：这份纯函数住在 **`packages/gesture`（`@celestea/gesture`）**——一个**零 `@celestea/*` 依赖、零 Node API 的共享叶子包**，而不是 `core`。
  - **为什么不能放 core**：`packages/core` 顶层 import `node:fs` / `node:path`（`celestea-sources.ts`、`skills.ts` 等），而 `apps/web` 不经过 `runtime`、由 Vite 打包成浏览器产物——前端一旦依赖 core，`node:fs` 就跟着进了浏览器包，**打包即炸**。
  - **连带迁移**：`SKILL_NAME_PATTERN` 的唯一定义从 `packages/core/src/skills.ts` 迁到 `gesture`；`skills.ts` 从 `gesture` 导入后再原样导出，`@celestea/core` 的公开面与既有 `import { SKILL_NAME_PATTERN } from "@celestea/core"` 的写法一字不变（否则「技能名长什么样」会有两份正则，正是本节要消灭的分叉）。
  - **登记三处**（与 `ARCHITECTURE.md` §1.4 的「三处缺一视为未登记」同纪律）：`eslint.config.js` 的 `SHARED_LEAVES`、`.dependency-cruiser.cjs` 的 `SHARED_LEAVES`、`ARCHITECTURE.md` §1.1 层级表 + §2.1 职责。
  - **结构性后果**：新增 `apps/web → @celestea/gesture` 这一条边（此前 `apps/web` 对 `@celestea/*` 零依赖）。它的合法性由 `tests/slash-gesture-single-source.test.ts` 兜底——该门禁同时断言「apps/web 只依赖 gesture 一个 `@celestea` 包」与「全仓只许有一份 `/` 触发解析（豁免逐条记账）」。

**验收**：

- `/mcp:memory` → `{ kind: "mcp", canonical: "/mcp:memory" }`；`/skill:review x` → `{ kind: "skill", name: "review", rest: "x" }`；`/help` → command；`3/4` 与 `a/b` → `null`。
- 结构断言：全仓不得出现第二份 `/` 触发解析（豁免逐个记账）。
- 变异负控制：把 server 名字符集放宽成任意字符 → 断言必须红。

**不做**：句中命中、参数位补全（理由见 §5 与 skill-command §3.2）。

## 8. 命中确认 = chip（富文本 decorator node），不再是高亮

> **本节已随 §9 的富文本迁移整体改写。** 旧版「镜像高亮层 vs 提示行」的二选一作废——那个选择题的前提是「`#input` 是 `<textarea>`」，该前提已被 §9 推翻。原型对比实测过镜像层形态：它的天花板是「底色 + 下划线」，给不了 chip（chip 的宽度与底层字符不同，而镜像层必须与 textarea 逐像素对齐，原理上做不到）。

命中确认的最终形态是 **chip**：命中的 `/skill:<name>`、`/mcp:<server>`、命令名在输入框内渲染成 decorator node 药丸。注意 mono 主题下 chip 是**深色底块而非蓝色**——DSH 的蓝是它家主题色，本仓 accent 是 `#1a1a1a`。

- **文本投影 = 规范形态**：chip 节点覆写文本导出，输出 `/skill:<name>` / `/mcp:<server>`——发送时编辑器全文导出的就是 canonical 字符串，host 侧 §7 的解析函数**一行不改**。「两端同源」从「共用一个解析函数」升级为「chip 的投影就是解析函数认的形状」。
- **手打与选中等价**：行首 token 命中清单时把文本节点替换为 chip 节点；chip 失配（技能被卸载等）退化为普通文本。
- **chip 是原子的**：Backspace 触及 chip 边界 = 整体删除；不允许留下 `skill:rev` 半个残肢（残肢就是「亮了却没注入」的富文本版）。
- **提示行保留**：`noteEl` 不再承担命中确认，仍承担**失败原因**（未连接的 server、未知命令）——chip 化不了「不存在的东西」。

**归属不变，结论加强**：三种 kind 都要命中确认，而这是**同一笔投入**——decorator node 体系里加一种 kind 的边际成本≈0（多一个 kind 值 + 一条清单谓词）。**不接受「技能先有、MCP 以后再说」**——那会把同一笔投入付两遍。

**硬约束**：chip 化区间与提示内容必须由 §7 那个函数的输出决定，前端**不得另写一份判定**（理由同 [skill-command.md](./skill-command.md) §1.4：chip 亮了却没注入，比不做 chip 更坏）。

**验收**：

- 命中 → 输入框内出现 chip 节点（`@lexical/headless` 断言 node 类型与文本投影）；未命中 → 纯文本。
- 三种 kind + `@文件` 各一例 chip 化断言；失配退化断言各一。
- Backspace 触及 chip = 整体删除，无残肢。
- IME 组合输入真机回归（W2033 的回归面）。
- 变异负控制：chip 的文本投影与 §7 解析函数的 canonical 不一致 → 同源断言必须红。

---

## 9. 富文本迁移：`#input` 从 `<textarea>` 换成 Lexical（已定）

**背景**：chip 要求 token 的宽度可以不同于底层字符（药丸有 padding、比原文本紧凑），镜像层原理上做不到（必须与 textarea 逐像素对齐）。要 chip 就必须换富文本编辑器——没有中间档。原型对比后拍板：一步到位。

### 9.1 决策记录（逐项拍板）

| # | 决策 | 选择 | 否决项与理由 / 连带纪律 |
|---|---|---|---|
| E1 | 编辑器 | **Lexical** | CodeMirror 6 是代码编辑器心智；ProseMirror 概念过重；手写 contenteditable 要自己扛 beforeinput/IME/选区（本仓有 W2033 的 IME 伤疤）。Lexical 是参考实现同款，decorator node 为 chip 设计，IME 组合态由引擎接管 |
| E2 | chip 范围 | **`/` 三类 + `@文件` 一次做完**（用户拍板） | 推荐项是只做 `/`——`@文件` 带「目录逐级进入」既有交互，范围约放大一倍；用户接受这个代价 |
| E3 | 草稿持久化 | **编辑器序列化状态**（用户拍板） | 推荐项是纯文本重解析。选序列化状态 ⇒ 连带三条纪律：① 持久化载荷带 `v` 版本字段；② node 注册表冻结（新增 node 类型 = 契约变更）；③ 读取失败 / 未知 node → **回退纯文本**（宁可丢 chip，不丢字） |
| E4 | 切换策略 | **直接替换 + 适配缝** | 不养 textarea 回退路径（本仓不养平行实现） |

### 9.2 适配缝 `ComposerAdapter`

所有消费方不再碰 DOM 元素，改走 `apps/web/src/ui/composer/` 的适配缝：

- `getCanonicalText(): string`——chip 投影后的规范文本（发送与草稿落盘都走它）；
- `setText(s)` / `setState(json)` / `clear()` / `focus()`；
- `onChange` 与「光标前文本」读取（补全引擎的 `refresh` / `mentionToken` 改从这里读）；
- **粘贴**：Lexical paste command 强制纯文本；含文件时转附件车道（`acceptFiles` 逻辑不变，只换挂载点）；
- **Enter 车道**：newline.ts 的判定（触摸=换行 / 桌面=发送 + IME 守卫）搬进 Lexical keydown command，语义逐字保留；
- 性质说明：Lexical 是纯前端 JS 库（与 marked / highlight.js 同性质），打包进产物，**无任何基础设施成分**——没有服务、进程、端口或数据目录。

### 9.3 退役清单（删代码要记账）

| 退役物 | 原存在的理由 | 退役理由 |
|---|---|---|
| `inputbar/caret-mirror.ts`（W1525 假光标） | textarea 无法装饰 | Lexical 有真光标 |
| `inputbar/grow.ts` 的 `field-sizing` 路径（W2016） | textarea 自增高 | `field-sizing` 不支持 div；editor root 用 `max-height + overflow-y` |
| textarea 的 `placeholder` 属性系统 | 原生属性 | 改 `:empty::before` / Lexical placeholder；设备分流文案逻辑（W2023）保留 |

### 9.4 依赖与门禁

- `lexical` 进 apps/web **出货依赖**（现为 highlight.js / katex / marked 三个）；`@lexical/headless` 进 devDependencies（node 里单测编辑器核心，不进产物）。
- 登记：`DEPENDENCY-POLICY.md` §7 清单 + §4 验证协议（独立 checkout、`pnpm outdated -r` 前后对比）；**bundle 棘轮按实测更新并写归因**（预估 +60–90KB min+gz，实施时实测后写实数）。
- 真机验收加一条：中文 IME 组合输入全流程（W2033 的回归面）；宣布 UI 改动前跑 `node scripts/build-webdist.mjs`（FRONTEND-RULES 验收口径）。

### 9.5 与既有工单的关系

§4 工单（放行缝 → 分组）与编辑器无关，**照原顺序先做**；§7 解析函数先行（chip 化与手打识别都消费它）；富文本迁移插在其后、技能切片之前。技能切片 4（见 skill-command.md）不再是「镜像层」，而是「消费本节迁移产物的第一个 chip 消费者」。**E2 的 `@文件` chip 化**与逐级进入（applyMention 的目录续列）一并落在迁移波次内。

## 10. 落地记录（实现期偏差与延后项）

> §5 是**设计层**的「明确不做」；本节记**落地层**的两件事：与设计不同的地方（每条都有实测理由），以及落地后才看得见的延后项。波次：W1（§1/§2/§7）→ W3（§9 迁移）→ W4（§8 chip）。

### 10.1 交付落点

| 设计节 | 落点 |
|---|---|
| §1 分组 | `apps/web/src/ui/commands/popup.ts`（`PopupItem.group` + `.cmd-group` 头）+ `apps/web/src/styles/commands.css` |
| §2 放行缝 | `apps/web/src/ui/send.ts` 的 `sendNormal()`；`ui/commands/index.ts` 的 `dispatchCommand` 返回 `false` 即放行 |
| §7 解析 | `packages/gesture`（`parseSlashGesture` / `canonicalSlash`），全仓唯一 `SKILL_NAME_PATTERN`；两端不分叉由 `tests/slash-gesture-single-source.test.ts` 的结构断言钉住 |
| §8 chip | `ui/composer/chip.ts`（`ComposerChipNode`，kind = command / skill / mcp / mention）+ `ui/composer/tree.ts`（区间手术、原子 Backspace、光标前文本、E5 重判） |
| §9 迁移 | `ui/composer/{adapter,draft,lexical,index}.ts`；`index.html` 的 `#input` 由 `<textarea>` 改 `<div>` |

### 10.2 与设计不同的地方

1. **chip 进 `COMPOSER_NODES` ⇒ 旧草稿按 E3 降级为纯文本**：指纹变化是注册表变化的必然结果，没有另写迁移器。
2. **chip 的投影是唯一真源**：`getTextContent()` 覆写为规范形态、`isTextContent()` 返回 `false`（原子）。变异负控制：投影改成裸 name → 9 条断言红；对 skill 自拼 `/skills:` 绕开 `canonicalSlash` → 5 条红。
3. **失配 chip 只改外观、不改投影**（E5）：基类恒在、`-stale` 只管样式——否则「是不是 chip」会出现两个判据。
4. **Backspace 挂在 `KEY_DOWN`，不是 `KEY_BACKSPACE_COMMAND`**：后者由 Lexical 内部快捷键表派发，本仓不依赖 `@lexical/rich-text`，挂上去按了没反应（实测）。
5. **IME 组合期 Enter 的 `defaultPrevented` 由 `false` 变 `true`**（W2036 断言语义随之改）：有意变更，不是回归。
6. **`@lexical/headless` 未引入**：草稿编解码是纯函数，不需要 headless 环境；§9.4 那条 devDependency 未落地。
7. **placeholder 走 `data-empty::before`**：Lexical root 永远有一个空段落，`:empty` 永不匹配。
8. **退役物比 §9.3 多两项**：`styles/caret.css`、`styles/field-sizing.css` 与对应两份测试（W1525 / W2016）一并删除。
9. **bundle 实测 670.07 → 849.67 kB min（207.21 → 264.09 kB gzip）**：登记在 `DEPENDENCY-POLICY.md` §7.2；本仓无棘轮机制，只记实数与归因。

### 10.3 落地后才看得见的延后项

- **补全框第二层工具行**未做：MCP `/mcp:<server>/<tool>` 的补全行提供者（P0 只到 server 级）。因此 `canonicalSlash` **没有** `tool` 参数——加一个没人调用的参数等于新开一条未验证形状。
- **真机 CDP 探针未做**：输入栏与 MCP 设置页的验收停在 jsdom 状态断言 + 变异负控制 + `check:web` 七门；几何 / 可见性 / 截图建议收口时补一次。
