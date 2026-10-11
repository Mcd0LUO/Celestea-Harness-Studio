# 输入栏与命令面（composer surface）

> 状态：设计（未实现）。

## 0. 目标与边界

**目标**：把「输入栏 + `/` 命令补全 + 发送入口」这一层整理清楚，让技能的显式调用（见 [`skill-command.md`](./skill-command.md)）只需要写技能语义，引擎与宿主的改动在这一份里解决。

**一个诚实的前提**：本设计里的两项代码改动（补全框分组、发送前变换缝）**当前都由技能显式调用这一个需求驱动**。它们不是"通用框架的第一块砖"，也不该被当成"以后什么都能挂上来"的底座。

拆出来做，图的是两件事：

1. **风险隔离**——发送前变换缝改的是**所有**命令的公共路径，单独实施、单独跑全量门禁，比混在技能改动里更容易定位问题；
2. **将来复用**——`#` 引用、`+` 附件菜单若要进补全框，分组能力与触发源都在这一层。

**准入判据**：任何新内容要进本设计，必须回答"技能与（将来那）第二个消费者是否都需要它"。§5 用这条挡掉了两项。

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

## 3. 输入栏的扩展点（现状盘点，本次无改动）

写在这里是为了让技能的草稿期高亮（见 [`skill-command.md`](./skill-command.md) 的切片 4）知道该接在哪，以及**哪些路已经堵死**。

| 区域 | 现有实现 | 说明 |
|---|---|---|
| 待发附件条 | `apps/web/src/ui/attach-tray.ts` | 图片与文本文件的待发展示夹（W867 / W869） |
| 引用托盘 | `apps/web/src/ui/quote-tray.ts` | 引用待发 |
| 提示行 | `apps/web/src/ui/inputbar.ts` 的 `noteEl` | 入口拒收、校验失败的可见说明 |
| 补全框 | `apps/web/src/ui/commands/popup.ts` | 挂在 `#input` 上，fixed 定位贴输入框上沿 |
| 草稿跨会话 | `apps/web/src/ui/inputbar.ts` 的 `inputValue` / `setInputValue` | 文本 + 待发附件随会话保存/恢复 |

**一个必须记住的结论（留给将来）**：`#input` 是 `<textarea>`，**里面插不了 DOM**。若将来要让 `/{名字}` 或 `@文件` 在输入框**内部**有视觉标记，只能上**镜像高亮层**（透明 textarea + 背后同步渲染的高亮层，字体/换行/滚动逐像素对齐）。DSH 能在草稿期渲染 chip，是因为它的输入框是 Lexical 富文本编辑器。

**注意**：本章的分组能力（§1）**不依赖**镜像层——一个是补全框（独立 DOM），一个是 textarea 内部，两者是不同的东西。

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

- **触发源注册表**：曾考虑把 `refresh()` 的 if/else 整理成 `[{trigger, provider}]` 表。**不做**——技能走 `/` 分组，**不新增触发源**，这张表没有第二个需求。等真有第三个触发源（`#` 引用之类）再抽。
- **镜像高亮层**：见 §3 的结论。它是输入栏未来的能力，但**当前唯一消费者是 `/{名字}` 命中确认**，所以归技能那份设计，不在这里预建。
- **命令注册开给插件**：`apps/web/src/ui/plugins/register.ts` 目前只暴露 `registerHintPlugin` / `registerEnhancerPlugin`，命令注册面没开。本设计不动它。
- **附件入口的任何改动**：图片/文本附件的三入口（粘贴 / 拖拽 / 左下角按钮）与待发条**已实现**（P0 + W869）。本设计不重做、不重构它们。

## 6. 已知风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| `send.ts` 公共路径 | 改的是**所有**命令，不只是技能 | `sendNormal` 逐字搬运不改语义；既有测试兜底；变异负控制钉住 |
| 分组能力的"过早通用" | 它当前只有一个消费者（技能） | 准入判据写在 §0；§5 已挡掉触发源表与镜像层 |
