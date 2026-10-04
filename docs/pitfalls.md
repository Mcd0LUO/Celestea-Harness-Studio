# Celestea Studio · 踩坑档案

> 状态：**当前**。格式：症状 → 根因 → 正确做法 → 代码位置 → 怎么验证；每条来自真实修复，改相关代码之前先读对应条目。
> 条目均已逐条复核于现役 TypeScript 实现（`apps/studio/src/**`、`apps/web/src/**`、`packages/**`），`file:line` 一律指向 TS 真源；退役 Rust 后端条目的判定口径见归档的 [`archive/decisions/feature-docs-drift-cleanup.md`](./archive/decisions/feature-docs-drift-cleanup.md) §3。

## 索引

| # | 主题 | 关键结论 |
|---|---|---|
| P1 | 提供商身份 | `id` 是身份，`name` 只是显示名 |
| P1b | provider 部分更新 | 只有 `api_key` 缺省保留，`models`/`note`/`request_format` 缺省会清空 |
| P2 | keyless 同源借用引擎 key | 请求级、不落盘、不回显 |
| P3 | 获取模型流程 | 先保存 → 拉上游 → 二级勾选（默认不勾） |
| P4 | 数值字段 `k`/`m` | 前端输入糖；后端只收 number |
| P5 | `reasoning_effort` | 自由字符串，不得折叠/重命名 |
| P6 | `/compact` | 409 守卫 + K=4 重编号 + 原子写 + 重绑 |
| P7 | SSE 信封 `turn` | 只发 payload 会丢 `turn` |
| P8 | 主题与版本号 | 主题是 `mono` + `dark`；版本号由 git tag 构建期派生 |
| P9 | 前端渲染铁律 | 见 `apps/web/FRONTEND-RULES.md` |
| P10 | session id 编码 | 路径参数必须 `%2F` |
| P11 | `/api/clear` | 有 409 守卫、**无**备份 |
| P12 | 重绑失败的回滚边界 | compact 不回滚日志；rename 会回滚目录移动 |
| P13 | W 号跨域撞号 | DSH 分配器看不见 MC 域台账；回执文件名只带号 ⇒ 同号互相覆盖 |
| P14 | 切模型不同步切端点 | `base_url` 不该由 `request_format` 决定；会话级端点也得与模型成对落库 |
| P15 | `request_format` 只写不读 | 字段有 UI、有 schema、有回显，但协议是**路由的属性**，变化单元是 adapter |
| P16 | responses 端点的两个静默陷阱 | 打满 token 上限时**终帧改名**（`response.incomplete`）；`max_tokens` 被 200 接受但不生效 |
| P17 | usage 藏在哪个帧 / 它该**发出来** | responses 只在终帧带 usage；anthropic 拆成两帧要合并。两者都**曾完全不发出** usage 事件 |
| P18 | 流式 usage 的 `prompt_tokens` 可能是 0 | 那是「**没测**」不是「没花」：账本记 `billed_unknown`，绝不替上游猜数（同一请求非流式给 10、流式给 0） |
| P19 | adapter 声称协议却不拥有它的鉴权 | 探测必须**镜像引擎**，不能按协议规范「纠正」—— 否则它两个方向都会说谎 |
| P20 | 旧结论的时效 | 复用前先核它在**当前 HEAD** 上还在不在；带基线的结论要连着基线引用 |

---

## P1 · 提供商身份：`id` 是身份，`name` 只是显示名

- **症状**：在设置页改了一个已有提供商的名称后保存，列表里出现**两条同名网关**（一条旧 id、一条按新名称派生的新 id），模型也重复。
- **根因**：后端 `POST /api/providers` 按 `id` upsert（`apps/studio/src/store/providers.ts:241`）——编辑器如果拿**名称**当 id 提交，就等于新建了一条记录，这正是"同名两条网关"的根因。
- **正确做法**：编辑既有记录时必须沿用原始 `id`。前端在编辑器里保存了 `originalId`，只在新建时才由名称派生：

```ts
// apps/web/src/ui/providers/form.ts:36, 130；类型见 apps/web/src/ui/providers/types.ts:53
id: e.originalId ?? e.name.value.trim(),   // 提交时优先用原 id
originalId: p?.id                          // 打开编辑器时记录
```

- **代码位置**：前端 `apps/web/src/ui/providers/form.ts`；后端 upsert 在 `apps/studio/src/store/providers.ts:241`，它只保证"`name` 缺省/空 → 回退为 `id`"（`apps/studio/src/store/providers.ts:246`），**不**做名称去重。
- **怎么验证**：`apps/web/src/ui/providers/form.ts` 里改名的路径必须命中 `originalId`；后端测试见 `apps/studio/src/store/providers.test.ts`。

---

## P1b · provider 部分更新会清空字段（真陷阱）

- **症状**：只发 `{"id":"x","base_url":"...","api_key":"..."}` 更新一个已有 provider，结果它的 `models` 全没了、`note` 被清空、`request_format` 从 `anthropic_messages` 变回 `chat_completions`。
- **根因**：`api_key` 是**唯一**的"缺省保留"字段，其余可选字段缺省时是**重置**语义（`apps/studio/src/store/providers.ts:12-15` 的注释即契约正文；实现在同文件 `upsert()`）。
- **正确做法**：做部分更新时**带上所有要保留的字段**；前端编辑器本来每次都发全字段，所以只有手写部分更新 / 新客户端会踩。
- **另一面（W815-7）**：`models` **存在但类型不对**（不是数组）必须是 400，不能当成 `undefined`——后者会被 store 读成"缺省"从而**清空**列表。
- **代码位置**：`apps/studio/src/store/providers.ts:12-15`（契约注释）与同文件 `upsert()`；类型校验在 `apps/studio/src/handlers/providers.ts:58-63`。
- **怎么验证**：`apps/studio/src/store/providers.test.ts` 的 upsert 用例。

---

## P2 · 无 key 的同源 provider 借用引擎 key

- **症状**：`providers.json` 里有一条指向**引擎自己网关**的记录（比如 `http://127.0.0.1:3001/v1`）但没填 key，点"测试"报"未配置 api_key"，可引擎明明能用。
- **根因**：探测上游 `/models` 需要 Authorization，而该记录没有 key。
- **正确做法（已实现）**：若 `base_url` 归一化后**等于当前代际的 `base_url`**，则借用引擎自己的 key。**借用是请求级的**：绝不写入 `providers.json`；绝不出现在任何响应体；绝不打日志。非同源无 key → 仍然报 `该提供商未配置 api_key` 且**不发请求**。
- **代码位置**：`apps/studio/src/store/provider-probe.ts:105-112`（`resolveProbeKey`：先用 provider 自己的 key，同源且引擎 key 非空才借用）；引擎 key 的读取口在 `apps/studio/src/handlers/providers.ts:22`。
- **怎么验证**：`apps/studio/src/provider-probe-ssrf.test.ts` 与 `apps/studio/src/store/providers.test.ts`。

---

## P3 · 获取模型流程：先保存 → 拉上游 → 二级勾选

- **症状**：点"获取模型"直接 400 `each model needs a non-empty id`；或者获取回来的模型被自动勾上、把用户原有配置冲掉。
- **根因**：`models/fetch` 是按 `{id}` 读**已落盘**的记录，不落盘就查不到 provider（404 `unknown provider`）。
- **正确做法**：先保存表单再拉上游，上游结果进二级勾选，空白行由前端跳过：
  - ① **先保存表单**再拉上游（`apps/studio/src/handlers/providers.ts:110-113`）；
  - ② 上游返回的模型 id 列表进**二级勾选窗**，**默认一个都不勾**，用户确认后才写进表单的模型行；
  - ③ 前端 `buildPayload` **跳过完全空白的模型行**（点了「+ 添加模型」但没填 id/名称的行），否则保存/获取模型会被后端 400 拒绝（`apps/web/src/ui/providers/form.ts:23-24`）；
  - ④ **后端不跳过**空行——它整请求失败，所以"跳过"是前端责任。
- **代码位置**：handler `apps/studio/src/handlers/providers.ts:110-113`；前端 `apps/web/src/ui/providers/form.ts:23-24`（空白行）与 `apps/web/src/ui/providers/form.ts:196-246`（`fetchSeq` 竞态守卫，铁律 3）——连点「获取模型」时晚到的旧响应必须丢弃。
- **怎么验证**：未落盘的 `{id}` 必须 404 `unknown provider`；二级勾选窗默认零勾选；整请求里混入空白模型行必须 400。

---

## P4 · 数值字段支持 `k`/`m` 后缀（前端糖）

- **症状**：填 `1m` 保存上下文窗口，后端 400 或值变成 1。
- **根因**：后端 `context_window` / `max_output_tokens` 只接受 JSON number。
- **正确做法**：后缀解析在**前端** `numOrNull`——小写化 + 去空白，正则 `^(\d+(?:\.\d+)?)([km])?$`，`k = ×1000`、`m = ×1_000_000`，`Math.round`；非法/负数 → `null`（即"留空 = 不限制"）。
- **代码位置**：`apps/web/src/ui/providers/form.ts:60-71` 的 `numOrNull`，调用点在同文件 `:30-31`。
- **怎么验证**：`numOrNull` 是纯函数，直接喂它即可——`1k` → 1000、`1m` → 1000000、非法/负数 → `null`。

---

## P5 · `reasoning_effort` 是自由字符串，不得折叠或重命名

- **症状**：用户选 `max`，实际发出去变成 `high`；自定义档位（比如 `xhigh`）被吞掉。
- **根因**：把 `max` 映射成固定档位、只认固定枚举，就会折叠掉自定义档位。
- **正确做法**：现在是**原样透传**——只有空串 / `"off"`（大小写不敏感）表示清除，其他值 verbatim 送给上游；前端「+」内联输入可以新增任意自定义档位。
- **代码位置**：透传在 `apps/studio/src/handlers/config.ts:37-42`；另有一条**推理能力**校验在 `apps/studio/src/handlers/config.ts:95-96`（判定见同文件 `:147`：`reasoning_efforts` 非空才算可推理；未知 id 视为可推理）——给已知的**非推理模型**配 effort 会 400。
- **怎么验证**：`POST /api/config {"reasoning_effort":"max"}` 后 `GET /api/config` 必须回 `"max"`。

---

## P6 · `/compact` 上下文压缩

- **正确做法 · 契约**：真源是常量 `packages/runtime/src/compact/plan.ts` 与重写 `packages/runtime/src/compact/rewrite.ts`。
  - ① **409 守卫**：turn 进行中时 `POST /api/sessions/{id}/compact` 返回 409（与 `/api/turn` / activate / rename 共用 busy 槽；`contracts/endpoints.json` 的 `post_session_compact` 记有 `singleConcurrency`）；
  - ② **阈值**：完整 assistant 轮数 `<= COMPACT_THRESHOLD`（`packages/runtime/src/compact/plan.ts:22`，= 8）→ 200 `{"ok":true,"compacted":false,...}`（无 `kept_turns`）；
  - ③ **摘要轮**：四段式摘要（正在进行的任务 / 已做的决策 / 关键事实与文件改动 / 待办），输入是截断后的 transcript（保留尾部），**所有错误串经 `redact` 抹掉 api key**；
  - ④ **重编号**：新日志 = 合成压缩轮 + 最近 **K = 4** 个完整轮（`packages/runtime/src/compact/plan.ts:24` 的 `COMPACT_KEEP_TURNS`），只改 `turn_start`/`turn_end` 的 id，其余事件与 `outcome` 原样；
  - ⑤ **原子写 + 备份**：旧文件先复制成 `cli-main.jsonl.precompact`（单副本、覆盖式，`packages/runtime/src/compact/rewrite.ts:21` 的 `COMPACT_BACKUP_FILE`）→ 写同目录临时文件 → `rename` 原子替换（同目录，避免跨设备）；
  - ⑥ **引擎重绑**：压缩的是活动会话时，实例先被**驱逐**、压缩后再重新 compose（`apps/studio/src/runtime/session-lifecycle.ts:10-13`）；非活动会话不重绑，下次激活/启动自然重放；
  - ⑦ **SSE**：广播 `event: compact`（`contracts/sse-events.json`）。
- **症状 / 根因（踩坑点）**：
  - **重绑失败不回滚日志**（重写成功之后才做重绑，之后的失败会保留已压缩的日志；回滚边界见 **P12**）；
  - `.precompact` **从不自动清理**；
  - 摘要失败时**不要**把 api key 带进错误串（已有 `redact`，别绕过它）；
  - **有活跃 worker 工作的会话会被 pin，压缩直接跳过**（`apps/studio/src/runtime/session-lifecycle.ts:40-48` 的 `PINNED_NOTE`）。
- **代码位置**：`packages/runtime/src/compact/`（`plan.ts` / `rewrite.ts` / `run.ts`）、`apps/studio/src/runtime/session-lifecycle.ts:10-13`、`:40-48`、`contracts/endpoints.json`、`contracts/sse-events.json`。
- **怎么验证**：`packages/runtime/src/compact/plan.test.ts`（阈值跳过 / 最近 K 轮重编号 / `rewriteAtomic` 备份 + 原地替换 + 不留临时文件）与 `packages/runtime/src/compact/w2020-end-ownership.test.ts`（配对标记 `end` 的归属）。

---

## P7 · SSE 信封的 `turn` 字段必须一起传

- **症状**：前端拿到的 SSE 事件里 `turn` 一直是 `undefined`，多轮并发时事件串轮。
- **根因**：服务端事件 `data` 是信封 `{v:2, session, turn, seq, payload}`（`apps/studio/src/sse.ts:5-9`）；如果前端（或某个转发层）只把 `payload` 发出去，`turn` 就丢了。
- **正确做法**：`apps/web/src/sse.ts:39-53` 解析时保留信封，把 `payload` 派发给业务处理器、把 `turn`/`seq` **合并进** payload（`withEnvelope`）而不丢任何 payload 字段；新增任何转发/封装都不得只透传 `payload`。
- **代码位置**：服务端信封 `apps/studio/src/sse.ts:5-9`；前端 `apps/web/src/sse.ts:39-53` 的 `withEnvelope`。
- **怎么验证**：`curl -N /api/events` 看每个事件都带 `"turn"`。

---

## P8 · 主题与版本号

- **症状 / 根因**：两件事都是"两处共同定义、只改一处就静默不生效"——主题由 `apps/web/src/theme.ts:15-22` 的 `themes()` **加** CSS `[data-theme]` 块共同定义；版本号的真源是 git tag，不是代码里的字面量。
- **正确做法**：
  - **主题**：`themes()` 是**两个**主题——`mono`（黑白）与 `dark`（深色，只覆盖 static/alias token，见 `apps/web/src/styles/tokens.css`，组件零改动）；新增主题要同时改 `themes()` 与 CSS `[data-theme]` 块；`localStorage` 里的未知主题 id 会回落。
  - **版本号（W887 起自动派生）**：构建期由 `scripts/version.mjs` 派生后经 vite 注入 `window.__CELESTEA_BUILD__`，由 `apps/web/src/version.ts` 读取（读不到一律回落 `'dev'/0/''/false`）；`pnpm version:sync` 同步 `package.json`。
- **代码位置**：`apps/web/src/theme.ts:15-22`、`apps/web/src/styles/tokens.css`、`scripts/version.mjs`、`apps/web/src/version.ts`。
- **怎么验证**：`tests/w9301-theme-nodom.test.ts`（`themes()` 是纯函数、无 DOM 也能取到全部主题）与 `tests/w887-version.test.ts`（版本经 `__CELESTEA_BUILD__` 派生；往 `apps/web/src/version.ts` 写硬编码 semver 字面量会被机械拒绝）。

---

## P9 · 前端渲染铁律（验收硬性标准）

权威正文：[`apps/web/FRONTEND-RULES.md`](../apps/web/FRONTEND-RULES.md)——8 条铁律与验收口径都在那里，本条只留指针，不重述（重述必然分叉）。

- **症状**：出现「空白帧 / 整树闪动 / 旧结果覆盖新状态」任一现象即不合格。
- **根因 / 正确做法 / 代码位置 / 怎么验证**：逐条见权威正文（禁"先清空后加载"、禁整树 `innerHTML` 重建、切换类操作防竞态、折叠只切 class、弹窗不重渲染背景、轮询只做局部更新、设置页 pane 零重建、新增 UI 沿用本套纪律）。

---

## P10 · session id 里的 `/` 必须 `%2F` 编码

- **症状**：`GET /api/sessions/srv/ops/my-session/messages` → 404 / 路由不匹配。
- **根因**：session id 是 `"<workspace>/<session>"`，而路由的 `{id}` 是**单段**路径参数；未编码的 `/` 会被当成路径分隔符。
- **正确做法**：路径里 `encodeURIComponent(id)`，路由层会自动解码回带斜杠的值；`curl` 里同样要写 `%2F`。
- **代码位置**：`apps/web/src/api.ts:191`、`:197`、`:241` 等。
- **怎么验证**：带斜杠的 id 必须路由到同一条会话——编码后 200、未编码 404；`tests/contracts.test.ts` 另钉住 `apps/web/src/api.ts` 的 `/goal` 路径必须用 `encodeURIComponent(id)`。

---

## P11 · `/api/clear` 无备份（但有 409 守卫）

- **症状 / 根因**：把它当"有备份的操作"，或以为它会波及 worker 会话——两者都不成立。
- **正确做法**：把它当"破坏性操作"——前端已有二次确认；API 使用者（脚本、e2e）在生产实例上**不要**调它。要清空历史又保留回滚，先手工 `cp cli-main.jsonl cli-main.jsonl.bak`。
- **代码位置**：`POST /api/clear` 清空目标会话日志 + 轮号归零；busy 409 守卫在 `apps/studio/src/handlers/dialog.ts:272-289`，且**不会**截断在飞轮次的日志。**没有**备份；**不**动 `session.json`；**不**影响 worker 会话（`apps/studio/src/runtime/session-lifecycle.ts:58-66` 只清目标那一个实例）。
- **怎么验证**：turn 进行中调用必须 409 `a turn is already running`（`apps/studio/src/runtime/turnbusy-identity.test.ts`）。

---

## P12 · 重绑失败的回滚边界

| 路径 | 顺序 | 失败后 |
|---|---|---|
| `POST /api/sessions/{id}/compact` | 先原子重写日志 → 再重绑引擎 | 重绑失败**日志保持压缩后状态**，只有 `.precompact` 能回滚（`packages/runtime/src/compact/rewrite.ts:21`） |
| session / workspace rename | 先移目录 → 再写 `session.json` 的 title | 写 title 失败会**回滚目录移动**（`apps/studio/src/store/session-ops.ts:78-89`）；回滚本身再失败才报 `rollback failed` |

- **症状 / 根因**：两条路径都是「先做 A → 再做 B」，B 失败时 A 已生效——半途状态可能是"日志已压缩但引擎还是旧的"，也可能是"目录已移但 title 还是旧的"。
- **正确做法**：**重绑失败现在可检测**——压缩的配对标记 `compaction_start` / `compaction_end` 由**两步**写下：`start` 随原子重写落盘（`packages/runtime/src/compact/run.ts`），`end` 则由**调用方**在重绑成功之后才写（`installCompactionEnd`，见 `apps/studio/src/runtime/session-lifecycle.ts`）。所以"重写成功但重绑失败"会在日志里留下**未配对的 start**——`hasUnpairedCompactionStart` 为真，半途状态与正常会话可区分。
- **另一条同源纪律**：跳过分支（历史不足）**不写任何标记**：它没有开过配对，写 `end` 只会产生孤儿 `end`。新增任何"换绑"路径时，明确写出失败回滚语义，并加测试。
- **代码位置**：`packages/runtime/src/compact/rewrite.ts:21`、`packages/runtime/src/compact/run.ts`、`apps/studio/src/runtime/session-lifecycle.ts`、`apps/studio/src/store/session-ops.ts:78-89`。
- **怎么验证**：`packages/runtime/src/compact/w2018-markers.test.ts`（★ 未配对的 start 可检测；成功压缩留下成对且有序的标记）与 `packages/runtime/src/compact/w2020-end-ownership.test.ts`（重写后盘上没有 `end`；跳过分支一个标记都不写）。

---

## P13 · W 号跨域撞号：两套台账、一个共享 results

- **症状**：同一个 W 号被两个域各发一次。实例：自动分配拿到 `W2040`，而共享结果目录里早已躺着另一域（MC）同号的报告 `W2040-粒子伪动画先例调研.md`（比自动分配早约 3 小时）。
- **根因（两套账，分配器只读一套）**：DSH 侧分配器（`celes-worker-spawn`，**住在 DSH 自身 checkout，不在本仓**）只读它自己那张表 `<workerBase>/registry.tsv`；MC 域另有一张 `W号注册表.tsv`（`reserve-w`），**分配器看不见**；两侧**不同源**，且两域的报告都落进**同一个共享 results 目录**。分配器自己的注释已承认第 3 点，并靠 `max+1` 缩小撞面——但 `max+1` 只在**两侧顶端同步**时不撞；一侧跑到前面，另一侧就会追上已占号段。
- **危害链（按实际可发生性排序）**：
  - ① **回执文件名只带号**：`<wid>.receipt-ok` 两域同名 ⇒ 互相覆盖。内容都是 `ok`，覆盖本身无害，但"这个回执属于哪个域"的语义丢了。**★已实测发生**：MC 域的 `W2040.receipt-ok` 被本仓 W2040 收尾时覆盖。
  - ② **报告文件名同号不同名**（`<wid>-<任务名>.md`）⇒ 通常不覆盖；但**两域都写同名报告**时会静默覆盖。
  - ③ **看门狗按各自 registry 判"在途 worker"** ⇒ 只看得见自己那套账，跨域不可见。
  - ④ **★任何用 `results/` 目录做跨域核对的人都会误判**：实测架构师巡检脚本 `ls results/<wid>-*.md` 对 `W2040` 匹配到 MC 域的同号报告 ⇒ 误判"已交付"，而本仓的 W2040 当时还在跑。**核对 `wid` 必须带域**——只查一张账 / 只做一次 glob，会把"别人的同号产物"当成"我的已交付"；**巡检脚本是这类误判的放大器**（一次巡检多个号）。
- **正确做法**：
  - **本仓（Studio）这一侧**：台账与结果目录必须是**本仓 data dir 下的另一套**——`<data dir>/worker-registry.tsv` 与 `<data dir>/worker-results`，**永不**落到集群共用的 `<workerBase>/registry.tsv` 与 `<workerBase>/results`（`contracts/data-files/index.json` 的 R2-1）。
  - **分配器那个缺陷本身修不到本仓**：它在 DSH 的 checkout 里，本仓改不到，**登记，不假装修**；真正修法（合并两张账 / 给回执加域前缀）会改既有命名约定，属 DSH 侧决策。
  - **收到 wid 时把它当 `(wid, 域)` 而不是 `wid`**：跨域核对要**同时**看两张账，只查一张就会得出"这个号没人用"的错误结论。
- **代码位置**：隔离真源 `apps/studio/src/runtime/worker-table.ts:29`（`WORKER_REGISTRY_FILE`）、结果目录 `apps/studio/src/app.ts:131`（`<data dir>/worker-results`）。
- **怎么验证**：`tests/w2049-worker-registry-isolation.test.ts` 把隔离钉成五条断言（含"生产源码不得出现集群路径字面量"）；跨域核对则要**实读两张账**再比号，别只看一张。

---

## P14 · 切模型不同步切端点：`base_url` 不该由 `request_format` 决定

- **症状**：从一个惯用默认提供商的模型，切到另一个 provider（如 MiniMax）的模型，**模型切成功了，`base_url` 却还是旧提供商的**——于是新模型的 id 被发到旧 host。切回 chat_completions 的网关就正常，所以看起来像偶发。
- **根因（三层，缺一不可）**：
  - ① `POST /api/providers/default` 的 compose patch 曾带 `owner.request_format === "chat_completions"` 条件，于是 `responses` / `anthropic_messages` 的 provider **只写 model、不写 base_url**（`apps/studio/src/handlers/providers.ts` `registerDefault`）；
  - ② 同一守卫在 runtime 里还有一份逐字拷贝（`packages/runtime/src/host/provider-target.ts` `resolveBaseUrl`）——只修前端/handler 那份，症状会从"切了没生效"变成"切了下次重启又回退"；
  - ③ **会话级切换压根没有端点这个概念**（`PUT /api/sessions/{id}/model`）：`session.json` 只有 `model`，`profileFor` 也只读 model，于是会话实例始终继承全局 `base_url`（手输模型名、`provider_id` 判定为空时都不经过全局那一步）。这条与 1/2 正交：修好 1/2 也补不上它。
- **正确做法**：`base_url` 是**「这个 provider 的地址」**，`request_format` 是**「请求体长什么样」**——后者永远不决定前者。两处解析都改成「owner 的 `base_url` 非空就采用」；会话级则让**端点与模型成对落库、成对清除**（`session.json.base_url`，由 `profileFor` 按会话应用），并回声 `base_url` / `effective.base_url_source`。
- **代码位置**：`apps/studio/src/handlers/providers.ts`（`registerDefault`）、`packages/runtime/src/host/provider-target.ts`（`resolveBaseUrl`）、`apps/studio/src/runtime/session-compose.ts`、`apps/studio/src/runtime/engine-profile.ts:28`。
- **协议归属（见 P15 / P19）**：`ENGINE_REQUEST_FORMAT` 已降级为「没有任何 provider 行认领该模型时的默认值」（`apps/studio/src/runtime/engine-profile.ts:28` 的注释即契约），协议跟着 `ProviderRow` 走，`packages/llm/src/factory.ts` 的 `defaultAdapterRegistry()` 注册了三个 adapter（chat_completions / responses / anthropic_messages），未知格式按名 fail-closed 抛 `NO_ADAPTER`。**缺口换了位置、没有消失**：adapter 缺协议原生鉴权——见 P19。
- **怎么验证**：变异负控制是这条的关键证据——把 `apps/studio/src/runtime/session-compose.ts` 的 `out.base_url = baseUrl` 停掉后，`apps/studio/src/runtime/session-model.test.ts` 的 5 条离线用例**仍然全绿**（它们只查写入值与回声），而 `apps/studio/src/runtime/w2065-session-base-url.test.ts` 的双上游实机用例转红（请求落回网关那台）。只有后者能证明"请求真的发去了新端点"。

---

## P15 · `request_format` 只写不读：字段存在不等于行为存在

- **症状**：设置页能选 `anthropic_messages`，`providers.json` 里存着，列表里显示着——然后它对实际请求**毫无影响**。切到那个 provider 的模型，请求照旧用 OpenAI 方言发出去，失败形态是上游一个没有线索的 400。
- **根因（三个边界各丢一次）**：`apps/studio/src/runtime/engine-profile.ts` 的 `ENGINE_REQUEST_FORMAT` 硬编码 `chat_completions`；`llm-assembly.ts` 的 `llmProfileOf` 在**进 llm 包的边界**上把格式裁掉（宿主视图里连字段都没有）；`packages/llm` 全包零引用。
- **正确做法（W2066）**：
  - ① **协议是路由的属性，不是调用的属性**：它跟着 `ProviderRow` 走，由 `ProviderTarget` 承接（与 P14 的 `base_url` 同一个 `ownerFor`），写进 profile 只是为了让 llm 工厂看得见——不是因为它属于 profile；
  - ② **变化单元是 adapter，不是方言开关**：`RouteAdapter` 拥有一个协议及其路由，`AdapterRegistry` 按 `request_format` 解析；**不要**给客户端加 `if (format === ...)` 分支（`ARCHITECTURE.md` §3.3 的反模式）；
  - ③ **不支持是带名字的 fail-closed 失败**（`NO_ADAPTER`，`retryable: false`），在**客户端构造期**抛出——此时 socket 还不存在，所以「一个字节都没发」由构造顺序保证，不是一个事后检查。
- **为什么不用现成的库**：DSH 走的是接 `pi-ai`（`openAICompletionsApi` / `anthropicMessagesApi` 等协议对象现成）的路；本仓的零依赖取向（`README`：core 零依赖、浏览器自己写 CDP 而不拖 Playwright）与之冲突，而该库传递闭包实测是 **89 个包 / 11005 个文件 / 60 MB**（`@google/genai` 13.7 MB、`openai` 9.3 MB、`@anthropic-ai/sdk` 8.3 MB）。所以取 DSH 的**结构**（adapter 注册 + 按名拒绝 + 能力由 adapter 回答），不取它的**依赖**。
- **代码位置**：`apps/studio/src/runtime/engine-profile.ts`、`apps/studio/src/runtime/llm-assembly.ts`、`packages/llm/src/factory.ts`、`packages/llm/src/adapter.ts`。
- **怎么验证**：`packages/llm/src/adapter.test.ts`（注册表语义 + 拒绝 + 退役）与 `apps/studio/src/runtime/w2066-request-format.test.ts`（真 socket：拒绝时上游零请求，对照行照常发）；变异负控制两处——target 不取 owner 的格式 → 路由化用例红；工厂绕过注册表 → 拒绝用例红。`responses` 已作为第二个 adapter 落地（W2067），见 P16。

---

## P16 — responses 端点：两个**静默**陷阱（录制帧才有真相）

- **症状**：接上 `responses` 协议后，工具调用正常、文本正常，但有两种情况静默出错，且**都不报错**：
  - ① 设了输出上限的轮次，引擎判成 `interrupted`（一个成功返回的调用报传输失败）；
  - ② 设了输出上限但完全没生效，模型一路写满预算。
- **根因（都是实机测出来的，规范里查不到）**：
  - ① **终帧的名字会变**：正常收尾是 `response.completed`；一旦输出打满，终帧换成 **`response.incomplete`**，并带 `incomplete_details.reason: "length"`。录制证据：`max_output_tokens: 5` 的那一份里 `response.completed` 出现 **0 次**、`response.incomplete` 出现 1 次，`output_tokens` 正好 5。只认 `completed` 的解码器会把「跑完预算」当成「流断在中途」。
  - ② **上限字段叫 `max_output_tokens`，而 `max_tokens` 被 200 接受但不生效**。对照探针：发 `max_output_tokens: 5` → `output_tokens: 5`；发 `max_tokens: 5` → `output_tokens: 34`（等于不限），**没有 400**。比拒绝更危险：调用方以为限流了。
  - ③ 附带一条：**`reasoning: {effort}` 被明确 400 拒绝**，所以 responses 协议的 effort 无处可去，adapter 的 `describe()` 如实声明 `reasoningEfforts: []`，让 UI 停止提供一个点了没反应的旋钮。
- **正确做法**：`response.incomplete` 与 `response.completed` 同为**终态**，都带 usage；前者额外把「被上限截断」映射成 W2017 的 `done.truncated: true`（截断的答案仍是答案，所以终态仍是 `done`）。请求侧只发 `max_output_tokens` 这一个名字。
- **代码位置**：`packages/llm/src/responses/`（`wire.ts` / `decode.ts`）与 `fixtures/responses/recorded-*.sse`。
- **怎么验证**：`packages/llm/src/responses/{wire,decode}.test.ts` 跑的是 `fixtures/responses/recorded-*.sse` **真实录制帧**（脱敏：id / trace_id / 上游 IP / 提问内容全部抹掉，密钥零残留）；变异负控制两处——把上限字段改回 `max_tokens` → wire 用例红；删掉 `response.incomplete` 分支 → 截断用例红。**只有把字节录下来、跑解码器、比对计数才会暴露**：第一条在事件直方图里完全看不出来（事件类型齐全，只是少了一种），第二条探针**返回 200**，不看 `output_tokens` 就会以为成功了。

---

## P17 — usage 藏在哪个帧，以及它**必须发出来**

- **症状（两类）**：① 状态栏 token 数一直是 0 / 成本账本没有这一行，但模型答得好好的；② 轮次显示「花了 39 prompt token、0 completion」或反过来——两个数都非零，但没一个是真实配对。
- **根因（两个协议各一半）**：
  - ① **usage 藏在哪一帧，协议各不相同**，都不在「顺手能拿到」的地方：
    - `chat_completions`：`stream_options:{include_usage}` 的 usage-only 尾帧；
    - `responses`：**只有终帧**（`response.completed` 或 `response.incomplete`）带，流式过程中一律拿不到；
    - `anthropic_messages`：**拆成两帧**——`message_start` 给 `input_tokens`（`output_tokens` 是 0），`message_delta` 给真正的 `output_tokens`。
  - ② **两个解码器都曾把 usage 折进内部累加器却不发出事件**，于是轮次正常完成、账本与状态栏什么也没收到。`stream.ts:263` 的约定是「usage 事件紧挨在终态事件之前」，新写的两个解码器都漏了这一条。
- **正确做法**：
  - 归一化到**同一个扁平契约**（`prompt_tokens` / `completion_tokens` / `total_tokens` / `cache_read`），`total_tokens` 在缺失时**推导**（anthropic 不发它）；
  - anthropic 的两帧**必须合并**：只取一帧会得到「有 input 没 output」或反之，任何一帧单独看都是合法的，所以这条错得非常安静；
  - 合并逻辑抽成**导出纯函数**并直接测它。否则「两帧都解析对了但没人合并」这种变异**测不出来**——本条就是这么被发现的：第一次变异负控制跑完是**绿的**。
- **代码位置**：`packages/llm/src/responses/decode.ts`、`packages/llm/src/anthropic/decode.ts`、`packages/llm/src/stream.ts:263`。
- **怎么验证**：`packages/llm/src/responses/decode.test.ts` 与 `packages/llm/src/anthropic/decode.test.ts` 各有一条「usage 事件出现在终态之前且两半都非零」的端到端断言，跑的是真实录制帧；变异负控制把 emit 停掉 → 两条都红。

---

## P18 · 流式 usage 的 `prompt_tokens` 可能是 0：那是「没测」，不是「没花」

- **症状**：同一网关、同一模型、同一条请求——**非流式**回 `prompt_tokens:10`，**流式**回 `prompt_tokens:0`（`completion_tokens` 照常有值）。于是整条用量账本的输入侧全是 0：`/api/status.usage.total.prompt_tokens=0`、`/api/usage/ledger` 的 `totals.prompt_tokens=0`。只要该模型进了价格表，输入侧成本就会被算成 0——**静默偏低**，正是账本 `billed_unknown` 这个字段存在的理由。
- **根因**：网关只在流式路径上统计 completion，输入侧直接给 0（直连不经引擎、`stream_options.include_usage` 加不加都一样）。**不是本仓解析器的 bug**——`packages/llm/src/usage.ts` 的 `usageFromObject` 是 Rust 端 `extract_usage` 的 1:1 移植，如实记录上游给的值；改它等于让「忠实解析」变成「替上游猜数」，那是更糟的错。
- **正确做法**：把「**没测**」与「**测出来是 0**」分开。
  - 账本行仍按上游原值记录计数（`usage` 一字不改）；
  - 但「输入侧为 0 而输出侧非 0」的行，`billed_unknown` 记 `true` ⇒ `cost_complete:false`、聚合总量是「**下限**而非全部」，而不是一个看起来完整的 0；
  - `aggregateUsage()` 按**行自己的** `billed_unknown` 计数，不再从 `usage === null` 反推（否则行上的标记与聚合口径会分叉）。
- **同一类还有一处**：后台提炼调用失败时 `extractSlice` 记的是 `zeroUsage()`，而 extraction 记录**没有** `billed_unknown` 字段（磁盘格式冻结）。于是「一次失败的提炼」在账本上表现为「0 token 的花费」，同样是静默偏低。修法与上面同源、且**不动磁盘格式**：`aggregateUsage()` 把「`status === "error"` 且 `usageIsEmpty`」的 extraction 行也算进 `billed_unknown_records` ⇒ `cost_complete:false`。只算「什么都没测到」的那种——失败前已经收到 usage 帧的，其观测到的成本仍然计价。
- **代码位置**：`packages/runtime/src/ledger.ts` 的 `book()`（`inputUnknown`）与 `aggregateUsage()`（`unknownCost`，两个分支）；契约描述在 `contracts/data-files/usage-ledger.schema.json` 的 `kinds.ok` 与 `billed_unknown`。
- **怎么验证**：`packages/runtime/src/ledger.test.ts` 的「W9261: a zero INPUT side is unknown, not a measurement」两条——`okStep(0, 12)` 必须 `billed_unknown:true` 且 `cost_complete:false`；`okStep(10, 12)` 必须 `false`。变异负控制：把 `inputUnknown` 改回 `usage === null` ⇒ 第一条红。提炼那一半在 `packages/runtime/src/ledger-extraction.test.ts`：「a FAILED extraction that measured nothing is UNKNOWN, not free」与「an extraction error that DID observe usage stays priced」两条。

---

## P19 · adapter 声称一个协议，却不拥有它的鉴权：探测必须**镜像引擎**

- **症状**：给一条声明 `anthropic_messages` 的 provider 点「测试」。若探测**按协议规范**发 `x-api-key` + `anthropic-version`，它会说「这个提供商很好」；而引擎真正发出去的是 `Authorization: Bearer`，到真实 Anthropic 端点上是 401。反过来，在一个只认 Bearer 的网关上，探测报「坏了」而引擎其实跑得通。**两个方向都是谎话**——而探测按钮唯一的承诺就是「这一行能不能用」。
- **根因（实读）**：`packages/llm` 的三个 adapter（chat_completions / responses / anthropic_messages）共用同一个 transport，而那个 transport 的请求头构造（`packages/llm/src/transport.ts:95`）对**所有**协议一律发 `authorization: Bearer`；`packages/llm/src/anthropic/wire.ts` 只拥有请求**体**。于是「协议」在实现里并不包含它的原生鉴权。
- **正确做法**：
  - ① **探测镜像引擎，不替引擎「按规范纠正」**：探测的真源是引擎的 transport，不是协议文档。`apps/studio/src/store/provider-probe.ts` 的 `probeAuth` 对三种格式都发引擎实际会发的头，并在注释里**写死了这条耦合**：adapter 长出协议原生鉴权时，它必须同步改。
  - ② **没有对应适配器的格式仍带名 fail-closed**（`该请求格式暂不支持自动测试：<格式>`），在 SSRF 解析之前、一个字节出去之前就拒绝。
- **仍未修的那一半（诚实边界）**：adapter 缺协议原生鉴权这件事本身**没有被修**——修它需要一个**真实的 anthropic 端点**来验证，而当前部署里没有（网关是 OpenAI 兼容的）；所以一条 `anthropic_messages` 行今天仍可能 401。登记在此，**不假装修好**。
- **代码位置**：`apps/studio/src/store/provider-probe.ts`（`probeAuth` / `PROBE_PROTOCOLS`）、`packages/llm/src/transport.ts:95`（引擎侧的真源）、`packages/llm/src/anthropic/adapter.ts`。
- **怎么验证**：`apps/studio/src/provider-probe-ssrf.test.ts` 的 W9271 用例组断言三种格式**实际发出的 URL 与鉴权头**（不联网，注入 recorder），并断言未知格式时上游零请求。变异负控制：把 anthropic 的头改成 `x-api-key`（= 按协议规范而不镜像引擎）⇒ 对应用例必须红——这条正是把「镜像 vs 规范」的差异暴露出来的那次。

---

## P20 · 复用一条旧结论前，先核它在**当前 HEAD** 上还在不在

**症状**：一次派工整轮白做。任务前提是"`terminal-pty.b4-01` 有 1/6 概率失败的 flake"，
worker 连跑 44 次单跑 + 3 次全量并行（5188 用例）**复现 0 次**——因为那个 flake 早已被
更晚的提交修掉了。

**根因**：那条"1/6 复现"是**在旧基线 `f8c2c15` 上**测的（报告里写明了基线，**没说错**）；
而派工者把它当成了**当前**状态复用。差值：`391d0ba`（在该基线之后 9 笔）已把那条用例
改成注入时钟——原写法用两次 `Date.now()` 读数落在毫秒格上的位置决定结果，是 ~1/6 硬币。
**报告没错，前提过时。**

**正确做法**：派工/复述任何"某某坏了/某某慢了"的结论前，先在当前工作区**核一次**它还在不在；
结论里凡是带基线或日期的，都要**连着那个基线一起引用**（"在 `f8c2c15` 上是 1/6"），
而不是剥掉时间说成"它是 1/6"。

**代码位置**：不适用（流程）。相关的两条现成门禁：`check:comment-refs`（行号会静默腐烂，同理）
与 `doc-conventions` ③b/③c（文档锚点会漂）。**这次是同一类病长在了人的脑子里。**

**怎么验证**：复述旧结论时写清它的测点（commit / 日期 / 机器）；派工前跑一次针对性命令
（这次只需 `npx vitest run <file>` ×5）。
## 附：容易误记的几件事

| 误记 | 事实 |
|---|---|
| `GET /api/health` 的 `bind` 是常量 | 是**实际监听地址**：服务起监听后回写，跟随 `--bind`/`--port`（`--port 0` 报真实端口）；仅在无服务器的组合（测试）里才停留在 `DEFAULT_BIND`（`apps/studio/src/handlers/health.ts:4-8`） |
| `POST /api/clear` 会清空 worker 会话 | 不会，只清目标那一个实例（`apps/studio/src/runtime/session-lifecycle.ts:58-66`） |
| `GET /api/fs/browse` 受 `CELESTEA_TOOL_ROOTS` 限制 | **不受**；`roots` 字段只是建议起点（`apps/studio/src/handlers/fs.ts:19`） |
| 改 `apps/web/src/**` 要重启后端 | **不用**，`pnpm build` 即可（静态资源每次读磁盘，`apps/studio/src/static.ts:99`） |
