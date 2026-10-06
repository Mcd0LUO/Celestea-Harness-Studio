# PORTING.md · 参考仓 → 本仓的移植台账

> 面向 M3③a 决策笔记「逐字文档剔除清单」与「自编译供应链理由」。
> 本文件记录**已经做了什么决定**，供复核与追责，不重复描述代码本身。

## 1. 来源与去路

| 项 | 值 |
|---|---|
| 来源（只读） | `.dsh-tmp/refs/dsh-computer-use_codex-style/helper-rs/` |
| 去路 | `packages/desktop/helper/` |
| crate 名 | `celestea-desktop-helper`（原 `dsh-computer-use`） |
| 来源规模 | 23,133 行 / 21 个 `src/*.rs` + `src/overlay/{mod,motion}.rs` + `src/policy/url_policy.rs` |
| 去路规模 | 16,390 行 / 19 个 `src/*.rs`（含新增的 overlay 垫片） |

## 2. 逐模块处置

| 模块 | 行数 | 处置 | 说明 |
|---|---|---|---|
| `capture.rs` | 1419 | 移植 | WGC 抓帧 + GDI 回退；对 overlay 的引用改为调用垫片；删 1 个引用 parity 夹具的测试 |
| `input.rs` | 731 | 移植 | SendInput 注入 |
| `uia.rs` | 3177 | 移植 | IUIAutomation；**输出硬性封顶保留参考仓原值**（见 §5）；删 1 个引用 parity 夹具的测试 |
| `enum_windows.rs` | 1470 | 移植 | 窗口枚举 / 应用身份 |
| `assist.rs` | 174 | 移植 | UserAssist 应用目录 |
| `main.rs` | 1405 | 移植 + 改 | RPC 主框架与工具调度；剥离见 §3，新增 ping 见 §4 |
| `tools.rs` | 498 | 移植 + **全文重写** | 工具 schema 的形状保留，description 全部自写（见 §6） |
| `protocol.rs` | 661 | 移植 | NDJSON 信封 `{id,ok,value,images}` |
| `app_catalog.rs` | 2437 | 移植 | 已安装应用目录（list_apps 依赖）；删 1 个引用 parity 夹具的测试 |
| `state.rs` | 908 | 移植 | 跨调用状态 |
| `policy.rs` | 1070 | 移植，**删 `url_policy` 子模块** | 浏览器 URL 闸门属二期（总规划 §9） |
| `interrupt.rs` | 937 | 移植 | 输入监视器 = 总规划 §5 租约协议的检测段 |
| `notify.rs` | 627 | 移植 | turn 事件与中断标记文件 |
| `pipe.rs` | 438 | 移植 | 命名管道 IPC |
| `desktop.rs` / `dpi.rs` / `images.rs` | 176 / 53 / 120 | 移植 | 桌面锁 / DPI / 截图块 |
| `lib.rs` | 25 | 重写 | 模块清单去 audio / prompt |
| `overlay.rs` | 103 | **新增垫片** | 见 §3 |
| `src/overlay/{mod,motion}.rs` | 5887 | **不移植** | 总规划 §2/§9：本期不做 overlay |
| `audio.rs` | 346 | **不移植** | 本期不做音频；`Win32_Media_Audio` feature 一并从 Cargo.toml 删除 |
| `prompt.rs` | 84 | **不移植** | 内容是参考仓随包的提示词文档副本 |
| `policy/url_policy.rs` | 321 | **不移植** | 浏览器 URL 闸门，二期 |
| `assets/prompts/*.md` | 4 文件 | **不移植** | 参考仓随包的文档副本 |
| `parity/`、`bin/`、`_*.ps1` | — | **不移植** | 参考仓的对照基线与构建脚本 |

### overlay 垫片为什么存在

移植进来的代码里有 **46 处** `crate::overlay::*` 调用。逐处删除会让 diff 淹没在噪音里，
而保留一个 103 行的零操作垫片能把「语义真正变了」的地方单独挑出来。语义是自洽的：
没有 overlay 窗口 ⇒ 没有东西需要从截图里排除 ⇒ `capture_exclusion()` 恒 `Off`、
`display_hwnds()` 恒空、`visible()` 恒 false。

**代价（已知、不是 bug）**：`capture.rs` 的 `OVERLAY_HWNDS` 注册表恒空。
将来若决定移植 overlay，删掉本文件换回参考仓实现即可，但必须同步复核那段排除逻辑。

## 3. 从 main.rs 剥离的东西（音频 / overlay / 浏览器）

| 剥离项 | 位置 |
|---|---|
| `--system-cursor-manager` CLI 面 + `run_system_cursor_manager` / `restore_cursors` / `blank_and_set` + 对应 Win32 import | 随 overlay 一并剔除 |
| `DSH_COMPUTER_USE_CURSOR_SCALE` 环境变量旋钮 | 同上 |
| `start_audio_recording` / `stop_audio_recording` 的 dispatch 分支、审批闸门、`tools` 表条目 | 随音频一并剔除 |
| `prompt` 方法 | 随 `prompt.rs` 剔除 |
| `browser_url_gate` 方法 | 随 `policy/url_policy.rs` 剔除 |

## 4. 新增：`ping` 握手（与参考仓不同）

**参考仓没有 `ping` 方法**（只有 `health`，返回的是 overlay / 管道 / AUMID 一类内部诊断，
不含 `version`）。总规划 §5 要求握手回 `{version, platform, features}`，所以本仓**新增**了 `ping`：

- 走 `handle()` 里 `method == "ping"` 的**独立分支**，刻意绕开 `gate_and_dispatch`
  （turn 中断检查 / 桌面锁 / 托管策略）。否则「未授权」会被误报成「未启动」，
  正好破坏总规划 §5「静态检查决定挂不挂、懒启动决定跑不跑」的那条分界。
- `features` 列的是**实际存在**的能力位（`wgc` / `capture-gdi-fallback` / `input-sendinput` /
  `uia` / `enum-windows` / `app-catalog` / `assist-userassist` / `lease-input-monitor`），
  **不含 overlay、不含 audio**，并有单元测试钉死。
- `platform` 是写死的 `"win32"` 常量而非隐式读 `std::env::consts`，对齐总规划 §7 的跨平台口径。

## 5. uia.rs 输出封顶

沿用**参考仓原值**（`child_limit` / `document_child_limit` / `max_depth` 三档，
以及 `include_text` 默认 false），未自创新阈值。依据：总规划 §8 把「AX 树爆炸
（3687 节点 / 1.23MB 实测）」列为风险并要求 `uia.rs 输出硬顶`，参考仓的值是针对同一风险
实测调出来的，另起一套只会让两个仓的行为不可比。

## 6. 逐字文档剔除清单

### 已整块剔除（文件级）

- `src/overlay/`、`src/audio.rs`、`src/prompt.rs`、`src/policy/url_policy.rs`
- `assets/prompts/{api,confirmations,dsh-header,guidance}.md`

### 已重写（内容级）

- **`src/tools.rs` 全表**：13 个核心工具 + `scroll_element` 的 description 与
  **每一条参数说明**全部重写。原表逐字搬自参考仓随包的 `docs/api.md`。
- `src/main.rs`：模块头、CLI 说明、握手/能力位注释、审批闸门说明。
- `src/overlay.rs`：整份新写。

### 残留的参考仓文档**路径引用**（非逐字文案，未清）

代码注释里仍有一批 `TC-xx` / `AX-xx` / `BR-xx` / `CW-xx` 溯源标记，其中少数带
`docs/api.md:70` / `guidance.md:243` 这类**文件位置**。它们是审计线索而非文案，
本轮保留；若认为会造成「参考仓文档随代码一起流出去」的观感，下一轮可统一改成只留编号。

### 自证命令与结果

```
cd packages/desktop/helper/src
grep -rin 'verbatim' *.rs        # ZERO HITS
grep -rin 'official docs' *.rs  # ZERO HITS
grep -rin 'openai' *.rs         # 1 命中，见下
```

**唯一的 `openai` 命中是故意保留的**（`src/policy.rs` 的 `SELF_APP_AUMID_PREFIXES`）：
它是「不让 helper 驱动助手自己」这条**安全拒识规则**的数据字面量，不是文档文案。
删掉它等于静默放宽一条安全规则。为了 grep 好看而削弱安全规则是本末倒置，
所以保留，并在代码里写了理由。这是本次移植唯一一处与「零命中」口径的偏离。

## 7. 依赖与构建

- `Cargo.lock` **进 git**（二进制 crate，锁文件是可复现构建的唯一保证；总规划 §6 M1①）。
- feature 裁剪：删 `Win32_Media_Audio`；另删 overlay 专用的
  `UI_Composition*` / `Win32_Graphics_Direct2D*` / `Win32_Graphics_DirectWrite` /
  `UI_Composition_Desktop` 一组。
- `[profile.release]` 固定 `codegen-units = 1`、`incremental = false`：
  为的是让两次干净构建的 exe sha256 尽量可比（M1① 的供应链**度量**，不是门禁——
  Rust 生态的 bit-reproducibility 未验证）。

## 7.3 ⚠️ 响应信封字段与总规划 §5 写的不是同一个（**待复核决策点 #3，必须裁决**）

规划 §5 写的是：

```
{id, method, params} → {id, ok, value, images}
```

参考仓实际发出的成功响应是：

```json
{"id":1,"ok":true,"result":{"features":[...],"platform":"win32","version":"0.1.0"}}
```

字段名是 **`result`**，不是 `value`；而 `images` 在成功信封上根本不存在
（参考仓只在 `call` 方法里把截图塞进 `result` 的结构里，见 `protocol::call_result`）。

**移植时没有改动这一点**——照搬了参考仓的 `protocol::official_ok`。理由：
① 参考仓是这个协议的实际实现方，它和它自己的 sidecar 是对齐的；
② 总规划 §5 那行是**规划阶段的转述**，不是从实现里抄出来的契约；
③ 改字段名会让 sidecar（还没写）去适配一个没人验证过的形状。

但这意味着 **T1b 写 client.ts 时必须知道真相：读 `result`，不要读 `value`**。
要么 T1b 照 `result` 写，要么 T1a 改协议迁就规划。三选一，需要拍板。

### 7.4 两次干净构建的 sha256 不同（**不作门禁，实测记录**）

规划 §6 M1① 要求记录两次干净构建的 exe sha256 作供应链度量。实测：

| # | 构建方式 | sha256 |
|---|---|---|
| 1 | `node scripts/build-desktop-helper.mjs` | `d35d88e659f1a8c0e9a233a4c6a2b3d7696570f9f06d314620458e8b67244dfa` |
| 2 | `rm -rf target bin` 后 `node scripts/build-desktop-helper.mjs --sha256` | `d0fdbf45f87c6b41d4225c3c5fd7f68d1d0a9854dd2f292451a3fee88b8514fa` |

**两次不一致。** 这不是 bug，正是规划 §6 提前打过预防针的那件事：Rust 产物里带
绝对路径、时间戳等非确定性输入，bit-reproducibility 未验证。所以 sha256 **只能当度量，
绝不能当门禁**——已按规划执行，并在 `Cargo.toml` 注释与构建脚本输出里都写明了这一点。

## 7.6 真机 panic 修复（2026-10-06，M2 真机验收抓到的）

**现象**：`uia.rs:2271` 按字节硬切 document 文本，切点落进多字节字符中间就 panic：

```
thread 'computer-use-uia-monitor' panicked: end byte index 32000 is not a char boundary;
it is inside '都' (bytes 31999..32002)
```

**触发条件**：窗口文档文本是中文，且超过 32KB。真实中文 Office 应用必踩。

**为什么后果严重（不只是「少截几个字」）**：panic 发生在 UIA **监视线程**里。
那是一条常驻线程（`uia.rs:798-802`，`thread::Builder::name("computer-use-uia-monitor")`），
一旦 unwind 出去就再也不会回来——`CLIENT` 是 `OnceLock`，不重启。
于是这个进程余下的生命里 accessibility 全部失效。

**为什么症状偏「静默」**：`include_text` 默认 false，
所以 `get_window_state` 的**截图**路径完全不受影响、照样成功返回。
只有显式请求 `include_text=true` 时才撞上。模型看到的是
「这个窗口没有可访问性元素」，而不是「取可访问性信息时崩了」。

**修复**：抽出 `truncate_utf8(s, max_bytes)`，用 `str::floor_char_boundary`
把切点向下取整到字符边界。上限仍是**字节数**（32000），所以 payload 上限的承诺
没有被削弱——最坏情况少 3 个字节（最长的 UTF-8 字符）。

**全同类写法排查结论**：脚本扫了全仓 19 个 `.rs` 的 `[..N]` / `[N..]` /
`.truncate(` / `.chars().take(` / `.len() > N` 五类惯用法，共 34 处命中，
**只有本处是对 UTF-8 字符串按字节切片**。其余全部是：
- `String::from_utf16_lossy(&buf[..n])`——切的是 `u16` 缓冲，元素恒为 2 字节，
  `from_utf16_lossy` 自己处理落单代理项，天然安全；
- `from_le_bytes(blob[4..8])` 之类——切的是 `u8`，安全；
- `.len() > N` 里的 N 是**元素个数**（`rows`/`matches`/`meta` 字节数）不是字符串。

**回归测试 + 变异负控制**：3 个测试（中文跨边界 / 上限恰好是边界 / 四字节 emoji）。
变异负控制实测：把 `floor_char_boundary` 改回裸切片后，
`document_text_truncation_never_splits_a_character` **红**，panic 消息与真机同类：
`end byte index 32000 is not a char boundary; it is inside '都' (bytes 31998..32001)`。
还原后全绿。测试数字 138 → **141 passed / 0 failed**。

## 7.5 参考仓自报的测试数字与实测不符（写给 M3 决策笔记）

任务书里转述的「参考仓自报 148 个 `#[test]`」**与源码对不上**。实测：

```
# 参考仓 21 个 .rs 里的 #[test] 总数
$ grep -rho '#\[test\]' <ref>/helper-rs/src/*.rs <ref>/helper-rs/src/*/*.rs | wc -l
3
```

也就是说参考仓这个 crate 里只有 3 个单元测试，其余的「148」大概率来自整个仓库的
其它测试体系（Python 侧 / parity 之类），被误记成了 Rust 侧的数字。

这正好是总规划 §10「未验证项 3：参考仓测试数字矛盾 → 自编译后实测记录」的实证，
也是「自报数字不可信」的一个具体样本：M3 写决策笔记时，本仓的测试数字要一律以
`cargo test` 的真实输出为准，不引用任何转述值。

**本仓实测数字**（`cargo test --release`，删 target 后干净构建）：

```
running 133 tests   (lib)  → test result: ok. 133 passed; 0 failed; 0 ignored
running 5 tests     (bin)  → test result: ok.   5 passed; 0 failed; 0 ignored
Doc-tests                        → test result: ok.   0 passed; 0 failed
合计 138 passed / 0 failed / 0 ignored
```

比移植前的 144 少 3 个，少掉的正是三个引用 `parity/` 的测试
（`app_catalog::list_apps_sort_is_declared_undetermined`、
`capture::official_constants_single_source_of_truth`、
`uia::on_disk_golden_fixture_keeps_the_official_grammar`）——
它们用 `include_str!` 读参考仓的 parity 夹具，而 parity/ 本期不移植，
所以连编译都过不了，只能删。**这不是「测试红」，是「测试依赖了不移植的东西」。**
删它们等于本仓不再有 parity 对照能力，这点要如实记进 M3 的决策笔记。

## 8. 本机环境坑（写下来免得下一个人再踩一遍）

本机装 MSVC Build Tools 之前，`cargo` 完全跑不动：

```
error: linker 'link.exe' not found
note: the msvc targets depend on the msvc linker but 'link.exe' was not found
```

`rustc` 默认目标是 `x86_64-pc-windows-msvc`，但该目标不自带链接器也不自带
CRT/import lib（`lib/rustlib/x86_64-pc-windows-msvc/lib/self-contained/` 是**空目录**）。
装 Build Tools 之前连 `cargo check` 都不行——build script 本身就要链接。

装上之后还有第二层：`rustc` 靠 `vswhere.exe` 定位 MSVC，而 winget 装的
Build Tools **不带 vswhere**（实测 `C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe`
不存在）。于是「装了 Build Tools」≠ `cargo build` 能跑——仍报同一个
`linker 'link.exe' not found`。所以 `scripts/build-desktop-helper.mjs` 自己去找
`vcvars64.bat`，必要时把 cargo 包在 `cmd /c "vcvars64.bat && cargo ..."` 里跑。
**别指望调用方先把 VS 开发环境 load 好**：干净 clone 的 CI/新 shell 都不会有。
