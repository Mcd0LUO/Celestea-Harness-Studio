# Computer Use（桌面操控）· 用法

> 状态：现行（M1+M2 已实现，2026-10-07）。设计与决策史见 [02-design.md](02-design.md)。
> 一句话：模型可以看你的屏幕（截图/窗口枚举/无障碍树），也可以在授权后动鼠标键盘（点击/输入/滚动/拖拽/启动应用）。

## 怎么开

桌面能力包默认**开**（用户裁决 D7）。它出现在工具面的前提只有两个：
1. 平台是 Windows（win32）；
2. helper 二进制已构建——在仓库根跑：
   ```sh
   node scripts/build-desktop-helper.mjs
   ```
   （需要 Rust 工具链 + MSVC Build Tools；脚本自找 vcvars，不用开 VS 开发者终端。）

两个条件缺一，桌面 13 个工具**整体不出现**（不存在「挂了但报错」的中间态）。插件面板里可以整包关掉（下一 turn 边界生效）。

## 工具面（13 个）

**只读 4 个（自动放行，不需要授权）**
`desktop_list_windows` `desktop_get_window` `desktop_list_apps` `desktop_get_window_state`
—— 列窗口/取窗口信息/列应用/取窗口状态（含截图，截图走图片附件进模型；`include_text:true` 才带无障碍树，默认关，树大）。

**写 9 个（分级闸门）**
`desktop_click` `desktop_press_key` `desktop_type_text` `desktop_scroll` `desktop_set_value` `desktop_drag` `desktop_secondary_action` `desktop_activate_window` `desktop_launch_app`

## 闸门怎么管（重要）

写工具不是给了就能用，按顺序过这几道（**deny 永远赢**）：

1. **desktop 能力位**：在授权面板（盾牌）给会话授「操作桌面」——没授，写工具一律结构化拒绝，连确认卡都不会弹。
2. **应用清单（apps scope）**：授权时可以限定应用白/黑名单（exe 按文件名比、win32 不区分大小写；窗口标题精确比）。命中黑名单直接拒；白名单非空而未列名 → 每次都要人点一次。
3. **敏感操作每次确认**：`desktop_type_text` / `desktop_set_value` / `desktop_launch_app` 即使已授权，**每次调用都要人点一次**确认卡。60 秒没点 = 拒绝；连续 3 次拒绝进 5 分钟冷却。

**模型无法绕过**：确认卡由系统代码（gate.ts）发起，不是模型自己决定问不问；回答端点要 HttpOnly nonce，模型用 http_request 伪造不了答案；helper 还有自己的应用拒识表（终端/杀软/助手自身）。

## 真人优先

你动鼠标键盘时，helper 的观察租约会立刻中止当前动作序列并返回
`"user input was detected in this window"`——你的输入永远优先，模型抢不走。

## 冒烟与验收脚本

```sh
node scripts/smoke-desktop.mjs            # 只读面：握手/列窗/截图附件（约 2s）
npx tsx scripts/smoke-desktop-write.mjs   # 写面：记事本打字读回/点击聚焦/闸门拦放（约 5s）
npx tsx scripts/lease-manual-check.mjs         # 租约：30 秒，提示出现时请你动一下鼠标
npx tsx scripts/lease-manual-check.mjs --auto  # 租约：无印章注入替代真人，并读回探针字符验证击键落地
```

## 已知限制（本期）

- 仅 Windows x64；macOS/Linux 未实现（协议与 platform 注入点已留）。
- 「取消」按钮（M2-B2c 起）：确认卡与所有提问卡上都有——取消是第三种终态（不算拒绝、不进冷却），挂起的调用立刻以 ASK_CANCELLED 解开，不用等 60 秒倒计时。
- 桌面驱动不进沙箱（Windows 本就没有 OS 级隔离可用）；它操作的就是你真实的桌面。
- 无障碍树超 32KB 会按字符边界截断（uia.rs，2026-10-07 修复过 UTF-8 截断 panic）。
- apps scope 的 exe 匹配按规范化后的文件名比较（剥离 process:/path:/registry: 等前缀与引号、折叠大小写、双端皆路径时整串相等）；**8.3 短文件名（如 EXCEL~1.EXE）不做等价识别**——清单里请写标准文件名（gate 保持无状态纯计算，不调 Win32 路径 API）。
- 配置了 titles 清单时，窗口标题一律取 helper 侧真实值判定（模型传入的 title 只作显示）；title 解析失败按 fail-closed 处理。
