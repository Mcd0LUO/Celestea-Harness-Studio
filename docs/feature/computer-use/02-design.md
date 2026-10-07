# Computer Use（桌面操控）· 设计与决策史

> 状态：现行（M1+M2 已实现，2026-10-07）。用法见 [01-usage.md](01-usage.md)。
> 本文回答「为什么是这样」：决策、被否方案、供应链与沙箱立场、验证史。
> **本文显式取代** [`docs/archive/decisions/iteration-f-capabilities.md`] 的 F4 桌面路线
> （Xvfb + X11 注入工具）——那是 Linux 时代的口径；本仓现行桌面路线是 Windows 原生
> （WGC/UIA/SendInput），以本文为准。

## 0. 一句话
从参考项目 wushi2333/dsh-computer-use_codex-style（MIT）**派生**：契约对齐 OpenAI Codex
window2 的 13 方法面，执行体用其 Rust helper 源码本机自编译，按本仓 swarm 的成熟配方
接成内置能力包。**不是**安装它的 bundle，**不是**从零重写。

## 1. 用户拍板的决策（访谈两轮 + 专项裁决，2026-10-05/06）

| # | 决策 | 结论 | 被否方案与理由 |
|---|---|---|---|
| D1 | 场景 | 通用桌面 + 浏览器为主 | 浏览器面留二期：本仓已有 Chromium CDP 全套（packages/tools/src/browser），复用优先 |
| D2 | 安全姿态 | 分级闸门 | 「每步确认」太碎、「会话级一次授权」太宽 |
| D3 | 平台 | 预留跨平台抽象，Windows 先行 | platform 形参注入（write-deny-list 先例），禁止隐式读 process.platform |
| D4 | 结构路线 | **R2 派生内置**（packages/desktop） | R1 外部插件被否：本仓插件机制纯内置（definePlugin 收进程内闭包，无外部挂载通道），为它先发明挂载机制成本不对等；R3 从零重写被否：重趟参考仓已解决的坑（WGC/双光标/观察租约） |
| D5 | 首期范围 | window2 全 13 工具（只读 4 + 写 9） | 「只读先行」模型只能看不能动；「含浏览器面」重复造轮子 |
| D6 | helper 执行体 | **自编译 Rust** | 参考仓 2.5MB 预编译 exe 来路不明（sha256 f9aa7c81…）；本机 cargo 1.98 + MSVC Build Tools（用户批准安装） |
| D7 | 默认状态 | **默认开**（用户裁决，与调度方推荐「默认关」相反） | 默认开只决定工具面可见；写操作全程受 §2 闸门管控，未授权一样被拦 |
| D8 | 分支策略 | 从 main（58b4ac7）开 feat/computer-use | feat/agent-swarm 分叉于 10-02，5 个关键先例提交（默认关/插件清单/热插拔/写拒绝清单）只在 main 上 |

## 2. 分级闸门（D2 的状态机，deny 永远赢）

判定顺序：preset toolDeny → 会话 tools.json 减法（这两层在 dispatch 的 tool-deny guard，
根本到不了 gate）→ gate.ts：只读 4 放行 → 写 9 查 desktop 能力位（grants，danger:true）
→ apps scope（exe basename + win32 折叠 / title 精确；命中 deny 拒、allow 非空未命中升级确认）
→ 敏感集（type_text/set_value/launch_app）每次系统发起确认。
确认：60s 超时 = 拒绝（fail-closed）；取消单独成码；连续 3 次拒绝进 5 分钟冷却
（照 grants-tokens 反疲劳先例）；冷却计数器跨代存活（同会话新 gate 继承）。

**确认机制选型（用户裁决 B'，2026-10-06）**：确认由 gate.ts（系统代码）无条件发起，
传输复用 parked-question 链路（PendingQuestion + SSE question 帧 + POST answer），
**不**改 core 的 ToolDecision 加第三态（原规划 §4.2）。理由：原规划否掉「复用
ask_user_question」是因为那是模型主动问（确认权在模型）；B' 是系统强制拦，安全性质相同，
改动面小一个数量级（不动 core/agent-loop）。

**防自问自答（安全洞修复）**：调查中发现 POST /api/questions/{id}/answer 原只验 session
字段，question id 顺序可猜、GET /api/questions 列出全部 pending——已授权网络的会话里
模型可用 http_request 自答绕过确认。修复（W9206-03 同型）：HttpOnly nonce 经
GET /api/events（无竞态，question 帧同流）与 GET /api/questions 下发，answer 强制校验。
**教训记录**：「模型拿不到的凭据」才是硬边界；同源性/会话字段不是。

**统一超时原语（W2014 纪律的演进）**：gate 需要 60s 超时，但 desktop 是 L1 包、
依赖表只有 @celestea/core，不能 import packages/tools 的 bounded（L1↔L1 依赖红线）。
解法是**必填注入端口** DesktopDeadline：gate 里零计时器，宿主（apps/studio，依赖 tools）
注入真 bounded；漏注入 = 编译期红。比「desktop→tools 加依赖边 + 三处登记」更优，
是这类「L1 包需要另一 L1 包原语」问题的推荐范式。
已知技术债：client.ts:316-339 的手搓超时（M1 审查证明无泄漏，但棘轮 grep 看不见
「无 race 字样的自带 timer」）——同类收敛留给后续。

## 3. 供应链与沙箱立场

- **派生即接管**：参考仓是一天冲刺后停更的形态（8 commits/2026-09-15），不追上游。
  其 parity 门禁有「测错对象」前科（作者自曝 4 条作废），不当验收基线；
  其自报测试数与源码实测不符（148 vs 3）——**自报数字一律以实测为准**。
- **逐字文档剔除**：仓内 helper-rs/assets/prompts 与 skills/references 含逐字 OpenAI
  文档（tools.rs:58-60 自陈 verbatim），MIT 覆盖不到。移植只取 Rust 源码与契约形状，
  工具 description 全部自写；grep 自证 verbatim/official docs 零命中
  （唯一 openai 命中 = policy.rs 拒识表的字面量，安全规则数据，核准保留）。
- **parity 能力放弃**：参考仓的 parity/ 对照套件（144 文件）不移植，3 个依赖其夹具的
  测试随之删除（PORTING.md §7.5 有账）。
- **不进沙箱**：桌面驱动操作真实桌面，Windows 本就没有 OS 级隔离可用
  （本仓 sandbox decision 在 win32 恒 no_os_isolation）。浏览器侧的教训
  （RLIMIT_AS 豁免/netns 共享/退出码不可信/AX 树封顶/CDP 无鉴权）在
  iteration-f §4 有实测数字，桌面侧同等诚实：本段就是显式记录。
- **构建可复现性**：干净 clone → pnpm i → node scripts/build-desktop-helper.mjs 成功
  是门禁（构建脚本自找 vcvars64——winget 装的 Build Tools 不带 vswhere，这个坑
  脚本自己填）；两次构建 sha256 不一致是 Rust 生态现状，只作度量不作门禁
  （PORTING.md §7.4 有历次值）。

## 4. 过程中根治的真问题（验收时发现的既有缺陷）

1. **execution 模式工具面泄漏**（P0 级「两面不一致」）：engine-plugins 的 mode 折叠名单
   是 compose 时的快照，晚挂插件（desktop 4e / swarm 4c）逃逸——模型面 29 名 vs
   /api/tools 16 名。改 liveModeFold provider 后两路自动一致，**agent_swarm 同类泄漏
   一并根治**。教训：「快照 vs 现读」在晚注册体系里必然漂移；sidecar/插件化之后，
   一切按注册表快照做判断的代码都要重审。
2. **工具面漂移九连**：fcbd5fe 把契约 23→36 后，9 个拿冻结面/计数做断言的测试文件
   变红。修法统一为「无条件面不动 + 可选面单列 delta / 计数改派生」——
   **手抄数字必漂移，派生才长青**。
3. **helper UIA 中文截断 panic**：uia.rs 按字节硬切 32000 切在「都」字中间，
   监控线程死、accessibility 静默变空。floor_char_boundary 修复 + 全仓 34 处
   同类写法排查（仅此一处）。遗留候选（甲乙案，本期未动）：监控线程 panic 后
   永久死（OnceLock 不重启）+ 报错措辞误导——根因修复后该路径不可达。
4. **自问自答安全洞**：见 §2。

## 5. 验证史（什么证据支持「做完了」）

- **M1（57cec8e + 8413faa）**：干净重建 90s 零警告 + 握手 ping 实收 8 项 features +
  真机冒烟（9 真实窗口 / 1920×1160 截图 524KB 落盘 / value 顶层 attachments）+
  57 测试绿 + fresh-eyes 审查（0 严重/1 中/1 轻，懒启动竞态 + UTF-8 跨块，均修复
  并带变异负控制）。
- **M2（fcbd5fe + c069d84 + 4937185 + ff34d83）**：全量 pnpm test **5341 绿/0 红**；
  十态真值表逐态断言（gate 24 + order 4 + host 9）；nonce 负控制（短接校验→403 变
  200→红）；真机写操作（记事本打字 UIA 逐字读回、click 焦点位移、闸门真拦真放、
  UIA 树前后逐字相同证明未授权零动作）。
- **租约**：初版实测「永不触发」——根因是合成判定里 OR 了一个 0.3s 时间窗
  （mark_synthetic），200ms 动作节奏下窗口永不过期，真人输入全被吞（139/139 放行、
  dirty 恒 false）。修复后判定只剩 dwExtraInfo 印章一条（LLMHF_INJECTED 在 RDP/VM
  下误标真人，不可用；PORTING.md §7.7），无印章 = 真人。cargo 单测钉死（含变异负
  控制：把时间窗 OR 回去 → 3 条测试红）；真机验收由 scripts/desktop-inject-input.py
  无印章注入自动化（smoke-desktop-write §4 真断言 + lease-manual-check.mjs --auto），
  真人手动模式保留为可选项。
- **顾问层**：复核基础设施多次返回无效报告，S1 检查点由编排方独立复跑核销
  （证据落盘 .dsh-tmp/s1-evidence/）；M1 由 fresh-eyes 子代理独立审查替代。

## 6. 已知限制与后续（M2-B2 / 候选）

- 租约真机实测：自动化路径已就绪（--auto / smoke §4），真人 30 秒手动验收保留为
  可选复核；apps scope 录入 UI；系统确认写会话日志
  （生产暂不可达，语义已实现）；client.ts 手搓超时收敛；helper 监控线程重启（乙案）；
  浏览器面二期（复用 packages/tools/src/browser 评估）；macOS/Linux（协议已留 platform 注入点）。
