# 特性设计 · 可选显示组件（display components）

> 状态：**设计**（**P0 已实现**，W895；**C1：启用表真源搬到服务端已实现**，W895-C1；**C2：可选组件已实现**，W895-C2（**JSON 树已按用户要求移除**），TOC/alerts 已按用户决定砍掉；渲染缝（P1）不再做；**插件库管理面已实现**，W895-L）。本文是目标契约与验收标准的记录；落地见 `apps/web/src/ui/enhance/`、`apps/web/src/plugins/`、`apps/studio/src/store/display-plugins.ts`。
> 依赖：[ARCHITECTURE.md](./ARCHITECTURE.md) 的分层与 seam 纪律、[DEPENDENCY-POLICY.md](./DEPENDENCY-POLICY.md) §7。

## 1. 一句话目标

把「消息渲染后的增强」与「markdown 渲染扩展」从**写死的两处调用**变成**可注册的缝**，
让显示类能力可以做成**可选组件**（设置页可关、关了就真注销），且**不动净化器、不加依赖、不拖慢首屏**。

## 2. 为什么是「缝」而不是「插件系统」

W790 已就客户端插件做过同一取舍，并在 `ui/hint/registry.ts` 头部留了结论：DSH 的客户端插件是
**真包**（`package.json` 的 `dsh.client` 清单 + tsdown 产物 `lib/client.js` + 宿主 `/plugins` 分发
+ cordis fiber + HMR 换纤），本仓是**单 Vite 产物、无 cordis、无 React**，装不下那条管线。

W895 复测了 DSH 的部署产物，量化印证了那个结论（也解释了它为什么慢）：

| | 本仓 | DSH（部署产物实测） |
|---|---|---|
| 客户端 bundle | **1** 个主包（517K）+ 2 懒 chunk | **51** 个 `client.js`，合计 **3.9M** |
| 渲染 | vanilla TS 同步建 DOM | React，**等全部插件激活后 hydrate** |
| 启动 | 1 段 | 2 段（boot page → React） |

DSH 的 `boot.ts` 里 `await loader.await()` 是**激活屏障**：任一插件没就绪，React 一帧都不挂。
本仓**不采用**这个形状——它用「启动即完整」换了「启动慢」。

## 3. 缝的形状（本仓已有先例）

消息渲染后其实**已经有两个增强遍**，只是写死的：

```
renderTextView():
  parts = stream.updateParts(text)     // marked -> stableHtml / tailHtml
  nodes = htmlToNodes(html)            // sanitize -> Node[]（进 DOM 的唯一通道）
  view.content.replaceChildren(...)    // 或增量插入
  highlightCode(view.content)          // <- 增强遍 1（hljs，幂等：dataset.hlDone）
  upgradeMath(view.content)            // <- 增强遍 2（占位 -> MathML，幂等）
```

两者都是**容器级、幂等、可重复调用**的遍。P0 只做一件事：把这两处调用换成注册表。

### 3.1 增强缝（P0）

```ts
// ui/enhance/registry.ts
interface Enhancer {
  id: string;                        // 身份；同名重复注册 = 替换（重挂载语义）
  enhance(container: Element): void; // 必须幂等（同一个容器会被反复传入）
}
registerEnhancer(e): () => void      // 返回注销器（对齐 DSH register -> dispose）
runEnhancers(container): void        // 渲染后调用；按注册顺序执行
```

**幂等是硬要求**：流式渲染每个节拍都会重跑整条链，实现方必须自己打标记
（现有 `dataset.hlDone` 就是范例）。缝**不**替实现方去重——去重需要理解 DOM 语义，
那属于实现方。

### 3.3 启用表真源（C1，已实现）

P0 把开关偏好存在**浏览器** localStorage（键 `celestea-studio.client-plugins-disabled`），换设备/换浏览器就丢。
C1 把真源搬到**服务端装配**（代码仍打包，**不做运行时下载**）：

```
GET  /api/display-plugins  -> { ok:true, disabled:[...] }   # 被关闭的 id
PUT  /api/display-plugins    body { disabled:[...] }        # 整表替换
```

- 落盘 `<data dir>/display-plugins.json`（与 workspaces.json 同目录，原子写）。存的是 **disabled 集合**，
  与旧 localStorage 值**同形**，迁移是恒等映射；新增组件不在表里 ⇒ 默认开。
- 服务端只存/回 **id**；label/hint 是前端 i18n，服务端不下发文案。
- 前端 `plugins/store.ts` 只保留服务端表的**内存镜像**：读失败 ⇒ 如实降级为「全开」（不伪造、不崩）；
  PUT 失败 ⇒ 回滚真挂载状态且**不改镜像**；首次读到空表且 localStorage 有旧值 ⇒ 一次 PUT 迁移。
- 时序：`startClientPlugins()` 仍是同步入口 —— 先乐观挂载「全开」，服务端表到达后对齐（真注销/真重挂）；
  设置页在渲染开关初值前 `await whenClientPluginsReady()`。**首屏不阻塞、不写加载态**。

### 3.2 渲染缝（P1，P0 不做）

markdown 管线已有扩展先例（`utils/markdown-math.ts` 走 `marked.use`）。
P1 把 `renderMarkdown` 的扩展点变成注册表，供 alerts / 脚注 / 定义列表 / TOC 使用。

## 4. 分期

### P0 —— 增强缝可注册 + 第一项可选组件

| # | 内容 | 落点 |
|---|---|---|
| 1 | `Enhancer` 注册表（注册/注销/按序执行） | `apps/web/src/ui/enhance/registry.ts`（新） |
| 2 | 内置两遍迁到缝上：hljs、math（**行为逐字节不变**） | `apps/web/src/ui/enhance/builtin.ts`（新） |
| 3 | 渲染后调用点改为 `runEnhancers(...)` | `ui/messages/assistant.ts` |
| 4 | 插件登记表支持 `kind`（`hint` / `enhancer`），现有两项标 `hint` | `plugins/descriptor.ts`、`register.ts`、`apply.ts` |
| 5 | 第一项可选组件：**代码块复制按钮**（事件委托 + 剪贴板回退） | `ui/enhance/code-copy.ts`（新） |
| 6 | 设置页开关复用现有机制（真注册/注销 + 偏好持久化 + 失败回滚） | 现有 `plugins/*`，零新机制 |

**P0 不变量**（可机械检验）：

- 首屏 bundle 数与关键路径**不增**（可选组件在同一 bundle 内，不是新请求）；
- 内置两遍的行为不变（现有渲染测试全绿，逐字节断言）；
- 净化器、`DROP_WITH_CONTENT`、URL scheme 过滤**一字不改**；
- 新增依赖 **0**。

### P1 —— 渲染缝（**已砍**）

TOC 与 alerts 经用户明确决定**不做**，因此**不新建渲染缝**，也不做 `marked` 扩展那条线。

### P2 —— 数据类与媒体（C2 实现，全部挂**已有**增强缝）

| # | 组件 | 触发 | 降级边界 |
|---|---|---|---|
| 1 | 代码块增强（`ui/enhance/code-extras.ts`） | 任意 `pre > code` | 语言徽标（无 `language-xxx` 不显示，不写 plaintext）；>30 行默认折叠；行号 + 悬停整行高亮；按行切分**保留 hljs span** |
| 2 | CSV/TSV 表格（`ui/enhance/csv-table.ts`） | `language-csv/tsv`；无语言只认 TSV | 引号/引号内换行/转义/CRLF/字段不齐/空文件；首行作表头；点表头升/降/无三态排序；sticky 表头；原文 `<details>` |
| 3 | 图片灯箱（`ui/enhance/image-zoom.ts`） | 正文 `<img>` | 点遮罩/按钮/Esc 关闭；**Esc 走既有 overlays 栈**；滚动锁与还原；可聚焦 + `aria-label`；幂等不重复绑监听 |

三项都在 `plugins/descriptor.ts` 登记 `kind:'enhancer'`，开关复用既有机制（真注册/注销 + 服务端启用表 + 失败回滚）。
**图表 / Mermaid / 任意 HTML 预览仍不在本设计范围内**：它们需要放宽 `DROP_WITH_CONTENT`（`svg`/`canvas`/`iframe`），
那是**安全模型变更**，必须单独评审。

## 5. 验收标准

| # | 标准 | 怎么验 |
|---|---|---|
| A1 | 内置两遍迁移后行为不变 | 现有渲染/高亮/数学测试全绿，不改断言 |
| A2 | 缝可注册且幂等 | 新测试：重复 `runEnhancers` 同一容器，增强不重复施加 |
| A3 | 可选组件真注册/真注销 | 开关关闭后 `runEnhancers` 不再施加该增强（DOM 上无残留） |
| A4 | 失败回滚不留半挂载 | 变异：注入抛错的 enhancer -> 开关报失败且状态不变 |
| A5 | 首屏不退化 | 产物体积与 chunk 数与改动前对比（只允许在同一 bundle 内增长） |
| A6 | 零新依赖 | `apps/web/package.json` 依赖集不变 |

### P3 —— 插件库管理面（W895-L，已实现）

用户裁决：**选 B（管理面）而不是 A（运行时下载）** —— 不动加载方式，零安全代价。

| 内容 | 说明 |
|---|---|
| `category` 分类轴 | `reading` / `structure` / `media` / `interaction`，与 `kind`（挂哪条缝）**正交**：`kind` 是实现事实，`category` 是用户语言 |
| 库视图 | 工具条（搜索 + 计数 + 全部开/关）+ 按分类分组 + 空态；搜索是**纯视图**，只过滤已建好的行 |
| 批量开关 | `setClientPlugins` + `store.persistDisabledMany` —— **一次 PUT**（不是 N 次），失败**整批**回滚 |

**为什么批量必须是一次 PUT**：N 次单开关调用每次都可能部分失败，状态会停在「一半成一半败」
而没有任何人能解释它。服务端本来就是整表替换语义，所以整批一次落库 = 要么全成、要么全不动。

### P4 —— 「本轮编辑」卡片（W9334，已实现）

形态规格：`apps/web/prototype/turn-edits.html`（联调定稿）。落点：
`apps/web/src/ui/turn-edits/`（`model.ts` 纯模型 / `card.ts` DOM 与增强遍 / `wire.ts` 接线）
+ `apps/web/src/styles/turn-edits.css`，在 `plugins/descriptor.ts` 登记为 `display.turnEdits`。

| 内容 | 说明 |
|---|---|
| 身份 | 一个**显示组件**：启用表（`GET/PUT /api/display-plugins`）+ 每插件 `config`。关掉 ⇒ 卡片整体不出现（连空列都不留） |
| 折叠阈值 | `config.threshold`，**默认 5**（不是常量）；0 = 不限（全部展开） |
| 卡片 | 表头（图标 / 标题给总数 / 副标题给构成 / 聚合 / 折叠按钮）+ 文件行 + 页脚 |
| 双向折叠 | 超过阈值 ⇒「还有 N 个文件…」；展开 ⇒ 全部 +「收起」；**两个方向都闭合** |
| 聚合口径 | 按**全量**行算（不随折叠变化），**删除的文件也算** |
| 行动作 | 主按钮「打开」+ 下拉箭头；菜单 `打开` / `在文件管理器中显示`（**仅 win/macOS，且宿主真的提供了这个动作**）/ `复制路径`（失败如实显示「复制失败」） |
| 空态 | 保留卡片：静音同形图标 +「本轮无文件改动」+「没有文件被新增、修改或删除」；**去掉折叠按钮与聚合** |

**数据源（方案 A，诚实收窄）**：来源是**本轮的工具调用**，只看得见 `write_file`
（模型直接可用的唯一写文件工具）。`run_shell` / `run_code` **也可能**改了文件而它看不见 ——
所以：标题只说「本轮改动 N 个文件」、不声称是全集；本轮一旦有这类调用，页脚附
「另有 N 个调用可能改动了文件」。

**数字的如实分级（W9334 返工后）**：来源能证明多少就说多少 —— **能算的算出来、算不出的才留空**：

1. **精确区间**（参数里有 `old_string` / `new_string`，含 `edits[]` 多段）⇒ 每行 `+X −Y`；
   口径是「这次替换的区间」，**不是**整文件 diff（页脚写明）；
2. **只知新内容**（`write_file` 的 `content`）⇒ 「写入 N 行」：新内容的行数是**可知的**，
   旧内容不可知 ⇒ **不给 `−`**（定稿的 `A` 行本来就只有 `+`、没有 `−`）；
3. **确实一无所知**（形状不认识 / 内容不是字符串）⇒ 该行数字留空，且页脚**可见地**说
   「另有 N 个文件给不出行数」。

表头聚合**已知多少聚多少**（精确区间合计 + 「写入 N 行」合计，各自带口径与 `title`），
按**全量**行算、不随折叠变化、**删除的文件也算**。

行字母是定稿的 `M` / `A` / `D`（**颜色就是语义**：M 中性 / A 绿 / D 红）。具体色值由主题决定
—— 与原型**逐字同色**的是 `claude` 族（原型浅色的 `--s-green-500: #3f7d4e` 与
`theme-claude.css` 相同）；应用默认的 `mono` 主题自己把 ok/err 定义成灰阶，组件**不**绕过主题
写死颜色。`write_file` 是「创建或覆盖」，**分不出** A / M ⇒ 记中性 `M`，口径写在该标记的
`title` / `aria-label` 上。

## 6. 刻意没做什么

- **不建插件市场 / 不做运行时下载**（用户已裁决不做 A 路线）：那需要在用户浏览器里执行下载来的代码，是安全模型变更。
  本仓的「可选」= **同一产物内的模块 + 开关控制是否挂载**（构建期装配）。
- **不抄 DSH 的规模**：不引入 cordis / React / slot 声明合并 / 每插件一 bundle。
  只抄它的**形状**（具名提供者 + `register -> dispose` + 单一挂载点），与 W790 同一判断。
- **不碰净化器**：P0 全部能力都在现有白名单内完成。
- **W9334 不做方案 B**（覆盖 `run_shell` / `run_code` 改动的数据源）：那需要新的服务端事实源
  （工作树快照 / 落盘 diff），是另一个条目；现在这条边界在卡片页脚**如实**呈现，不假装覆盖。
- **W9334 起步时的两个偏离已在返工中改正**（记在这里防复发）：① 自造第四种行字母 `W` ——
  那是**静默改掉联调定稿的视觉决定**；② 把「可知的行数」也说成不知道（`add/del/written`
  全 `null`）⇒ 卡片上一个数字都没有 —— 那不是诚实降级，是**信息量归零**。现在按上面的三档
  如实分级，字母回到 `M`/`A`/`D`。
- **W9334 的真机证据**：`scripts/a11y/w9334-turn-edits-probe.mjs` 把**真模块 + 真 CSS** 与
  **原型本体**（同源 iframe）并排渲染，深/浅两套主题各出一组截图（`tmp/w9334-probe/`），
  并在真机上量四条后果：并排逐项相等（行高 / 卡片宽 / 标题 / 副标题 / 聚合 / 每行数字）、
  三档颜色在真机上可辨、`rtl` 头部截断真的保住文件名、胶囊**有效命中区** ≥ `--tap-hit`。
