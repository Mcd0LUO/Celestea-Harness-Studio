# celestea_studio-ts · `docs/` 索引

> 本页是 `/srv/celestea/studio/docs/` 的**全量索引**：每份文档的状态、一句话定位与权威入口。
> 状态：**当前** = 与代码/生产同步；**设计** = 目标设计与契约（未必已实现）；
> **决定** = 已拍板但未必落地（例如「评估后暂缓」）—— 它不是「当前」，也不是「设计」。
> 历史文档（调研 / 迁移 / 退役）在 [`archive/`](./archive/)，顶部有 `📦 历史文档` 横幅；上表只登记**当前与设计**。

## 索引

| 文件 | 状态 | 一句话 | 权威入口 |
| --- | --- | --- | --- |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 当前 | 本仓**架构契约（规则正文）**：分包层级与依赖方向、seam 纪律、例外登记表；`eslint.config.js` + `.dependency-cruiser.cjs` 是它的机械实现，违反会在 `pnpm check` 被拦下 | 本文（`docs/ARCHITECTURE.md` 即唯一权威） |
| [`data-files.md`](./data-files.md) | 当前 | **共享数据文件 schema**：`workspaces.json` / `providers.json` / `prompts.json` / 会话目录与 `cli-main.jsonl` / `session.json`；数据现位于 `/var/lib/celestea-agent/` | 本文；字段变更以 `../contracts/data-files/` 为准 |
| [`pitfalls.md`](./pitfalls.md) | 当前 | **踩坑档案（已清零）**：2026-10-04 主人裁定整篇无用，21 条全删、正文见 git 历史；新坑先问能否变成一条断言（`AGENT.md` §9） | 本文 |
| [`feature/multimodal-attachments/`](./feature/multimodal-attachments/README.md) | 设计（已实现 P0） | **多模态附件**设计（分册）：图片/文本附件的三入口、能力位探测、降级提示、objectURL 生命周期 | [`README.md`](./feature/multimodal-attachments/README.md)；`apps/web/src/ui/attachments.ts` |
| [`feature/display-components.md`](./feature/display-components.md) | 设计（**P0 已实现**，W895） | **可选显示组件**：把「渲染后增强」与「markdown 扩展」变成可注册的缝，显示能力做成可开关组件（构建期装配，不做运行时下载） | 本文；缝的现有先例见 `apps/web/src/ui/hint/registry.ts` 的取舍注释 |
| [`feature/`](./feature/README.md) | 当前 | **特性文档索引**（分册）：本目录放特性级文档，文件名即主题名 | [`README.md`](./feature/README.md) |
| [`feature/desktop-packaging.md`](./feature/desktop-packaging.md) | 决定（2026-10-04：暂缓） | **桌面端打包**：评估外部 PR #5（已关闭）后暂缓——实测数据、4 条理由、替代方案代价、将来要做的三件前置工作，含未验证部分的诚实声明 | 本文 |
| [`deployment.md`](./deployment.md) | 当前 | **部署与安全模型**：生产 systemd + nginx、隧道访问、安全模型（含 Windows 差异表） | 本文；登录门见 [`archive/decisions/feature-studio-auth.md`](./archive/decisions/feature-studio-auth.md) |
| [`configuration.md`](./configuration.md) | 当前 | **配置**：`CELESTEA_HOME` 解析顺序与目录布局、环境变量全表、模型接入、权限档位 | 本文；数据文件 schema 见 [`data-files.md`](./data-files.md) |
| [`AGENT.md`](./AGENT.md) | 当前 | **开发与提交规范**：完成定义（Definition of Done）、提交消息格式与粒度、发布流程（先 tag 再 build）、派工协议、文档规范、写代码取向 | 本文；门禁清单见根 `package.json` 的 `check` |
| [`DEPENDENCY-POLICY.md`](./DEPENDENCY-POLICY.md) | 当前（W847 W0） | **依赖与工具链策略**：Node 版本带 + 启动守卫、冻结安装（pnpm-workspace.yaml）、升级验证协议与回滚、为什么 audit 不进门禁、外部运行时依赖清点 | 本文 |
| [`failure-modes.md`](./failure-modes.md) | 当前 | **失效模式 → 判据 → 门禁**：五类失效模式（测试固化错误行为 / 注释描述不存在的状态 / 把宿主事实当平台事实 / 验证了机制没验证输入面 / 声称做了但没做）与守它们的机械门禁；末页是速查表 | 本文 |

上表覆盖 `docs/` 的全部**现行文档**（根文档 + 分册索引，本索引除外）；**新增文档必须在上表登记**。
（这里刻意不写篇数：那个数字漂过 —— 迭代 F/G/H 三篇都漏登记了。`tests/readme-claims.test.ts` 只钉根 `README.md` 的硬数字，不覆盖本文件。）
另有子目录不逐篇登记：[`archive/`](./archive/)（**历史文档**：调研、迁移留痕、退役文档；每篇顶部有 `📦 历史文档` 横幅）。
本机文件 `docs/AGENT.local.md`（由 `AGENT.local.md.example` 复制而来）**不入库、不需登记**：那里放机器相关的事实。
契约类真源不在 `docs/`，而在
[`../contracts/`](../contracts/)（`endpoints.json` 72 端点、`sse-events.json`、`tools.json`、`data-files/`）——
端点数只有**一个真源**（`endpoints.json` 的 `endpoints[]`，其 `count` 是它的校验镜像）；
本文件与根 `README.md` 里的引用由 `tests/readme-claims.test.ts` 机械核对，改契约忘改这里会红。
退役后端的归档 HTTP 契约已于 W881 清理出公开仓，相关端点的 `docRef` 现指向
`contracts/endpoints.json` 自身的冻结条目。

## 归档（历史文档）

| 文件 | 状态 | 一句话 |
| --- | --- | --- |
| [`archive/research/`](./archive/research/) | 历史参考 | 调研报告：memory-store / selection-and-preview / computer-use / **baseline-phase0a**（Phase 0a 一次性实测记录）等 |
| [`archive/decisions/`](./archive/decisions/) | 历史参考 | **已实现决策与已执行完的过程记录**（23 篇 markdown：18 篇单篇 + 退役分册 [`iteration-e/`](./archive/decisions/iteration-e/README.md) 的 5 篇 —— 特性设计 + 迭代方向的决策依据与验收标准；能力 4/3/1 的 P0 已实现、能力 2 与各 P1/P2 未落地并随该分册一并退役；现行口径见 `contracts/` 与 `ARCHITECTURE.md`） |
| [`archive/migration/`](./archive/migration/) | 历史参考 | 迁移留痕：W781 两仓合并对照表 |

> **W1518 清理**：原先归档在 `archive/DEVELOPMENT.md`（旧 Rust 后端的开发者入口）与
> `archive/README-frontend.md`（并入前前端仓的 docs 索引）的两篇**已删除** —— 它们整篇只描述
> 已退役的 Rust 后端与并入前的旧两仓布局，属「退役后端的历史文档」，与 W881 已清理的那批同类。
> 正文可从 git 历史取回。`archive/decisions/`（已实现决策）与 `archive/research/`（调研留痕）
> **保留**：它们记录的是「为什么这样定」，仍被现役文档引用。

## 仓库角色与互链

| 仓库 / 路径 | 角色 | 文档入口 |
| --- | --- | --- |
| **本仓**（Studio 后端 TypeScript + 线上前端 `apps/web/` + 模型同步脚本） | 生产 | 本页 / [`../README.md`](../README.md) |
| 运行数据目录（`$CELESTEA_HOME`，见 [`configuration.md`](./configuration.md)） | `workspaces.json` / `providers.json` / `prompts.json` / `sessions/` / 账本 | [`../scripts/run-studio-ts.sh`](../scripts/run-studio-ts.sh) |
| 引擎原址（已删除） | 历史文档已于 W881 清理出公开仓 | — |

## 维护约定

- 新增文档 → 在本页登记（文件 / 状态 / 一句话 / 权威入口），并在 [`../README.md`](../README.md) 的「文档与仓库角色」段可见。
- **决策一旦落地 → 归档**：`git mv` 进 [`archive/decisions/`](./archive/decisions/)，状态改 `历史参考`，
  从本页的现行表移到「归档」表。理由：决策文档记的是「当时为什么这样定 + 当时怎么验收」，
  落地后它就不再描述现状；**现行口径以 `contracts/`（线格式）、`ARCHITECTURE.md`（架构规则）为准**。
  归档后仍要回到代码里改**引用路径**（代码注释与契约的 `docRef`/`sourceRef`）。
  （W893 一次归档 10 篇：7 篇 `feature-*` + 3 篇已实现的 `iteration-*`。）
- 设计落地后若**仍有未落地的分期（P1/P2）**，留在 `docs/` 并把状态写成 `设计（P0 已实现）`，
  **不要**整篇归档 —— 它还在描述一部分当前行为。
- 单篇 **≤ 700 行**（硬上限）→ 超了按章节拆进同名子目录（`docs/<名字>/README.md` 作索引并登记，分册不登记）。
- 文档过时 → `git mv` 进 [`archive/`](./archive/)（**指定归档目录**）+ 顶部 `📦 历史文档` 横幅 + `历史参考` 状态 + 更新全仓引用路径；**不删除正文**。
  公开仓不再保留退役后端/引擎的历史文档（W881 已清理）。
- **会话接续手册不放 `docs/`**：那种「每完成一个可提交单元就更新」的活文档（原先的 `docs/HANDOVER.md`）
  属于**过程留痕**，不是描述现状的现行文档 —— 它既没有稳定的「现状」可写，又会随每次更新让
  `tests/doc-conventions.test.ts` 的 ①（未登记）/②（无状态行）/⑤（本机路径）变红。
  按「一个事实一个家」放在**仓外**（系统 `/tmp`）或 `results/`（已被 `.gitignore` 忽略，
  不入库、不受文档门禁约束）。**不要再往 `docs/` 放接续手册。**
