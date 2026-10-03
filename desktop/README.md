# Celestea Studio — 桌面应用（deno desktop）

把整个 Celestea Studio 打包成**一个标准桌面应用**：内嵌窗口显示同一套 Web UI，系统托盘常驻后台，
内置基于 bsdiff 补丁的自动更新，全平台产物统一产出到一个可直接上传的 `release/`。
**注意**：官方文档描述的「失败自愈回滚」在实测的 Deno 2.9.7 上并未触发（见 §4.1），本仓附了手动恢复脚本。

外壳不实现任何产品逻辑。会话、工作区、工具、权限、HTTP API 全部来自 `@celestea/studio`——
外壳只负责服务器没有的那部分：窗口、托盘、更新状态。

技术栈是 **Deno 2.9 的 `deno desktop`**（官方文档 [Desktop apps](https://docs.deno.com/runtime/desktop/)）：
每个平台一个自包含二进制，Linux 默认用系统 webview（webkit2gtk），可选 CEF 后端。

---

## 1. 最快路径

```bash
pnpm run desktop:build          # 当前平台 → release/<os-arch>/
pnpm run desktop:build:all      # 五个平台全部（交叉编译），失败不中断
./release/linux-x64/CelesteaStudio.AppImage --self-test   # 逐项自检（无头环境要 Xvfb，见 §5.9）
```

产物布局（**`release/` 整目录就是一次上传的内容**）：

```
release/
  linux-x64/   CelesteaStudio.AppImage  CelesteaStudio.deb  latest.json
  linux-arm64/ CelesteaStudio.AppImage  CelesteaStudio.deb  latest.json
  macos-x64/   Celestea Studio.app  CelesteaStudio-2.8.1-macos-x64.zip  latest.json
  macos-arm64/ …（同上）
  windows-x64/ CelesteaStudio.msi  CelesteaStudio-2.8.1-windows-x64.zip  latest.json
  SHA256SUMS.txt   index.json   README.md      ← 校验和 + 机器可读索引 + 上传说明
```

中间产物（**下一次做补丁要用的未打包目录**）留在 `desktop/dist/<os-arch>/<format>/`。

## 2. 运行方式

| 命令 | 结果 |
|---|---|
| `CelesteaStudio` | 桌面应用：窗口 + 托盘 + 自动更新 |
| `CelesteaStudio --self-test` | 启动真实服务并逐项 HTTP 自检，输出 JSON，失败非零退出 |
| `CelesteaStudio --check-updates` | 立即检查一次更新，打印 JSON 结果并退出（运维/CI 诊断） |
| `CelesteaStudio --exit-after-ms N` | N 毫秒后走正常退出路径（冒烟测试；见 §7 的 SIGTERM 说明） |
| `CelesteaStudio --port 4000` | 无界面服务器模式（`deno run` 下同样生效） |
| `deno task dev`（在 `desktop/`） | 源码态无界面运行，改代码即时生效 |

环境变量与设置文件（都可选）：

| 位置 | 作用 |
|---|---|
| `CELESTEA_HOME` | 数据目录（默认走平台应用数据目录） |
| `CELESTEA_DESKTOP_LANG` | 托盘/通知语言：`zh` / `en`（默认跟随系统 locale） |
| `CELESTEA_DESKTOP_UPDATE_URL` | 更新源基址，**优先级最高**（见 §4 的地址规则） |
| `CELESTEA_DESKTOP_UPDATE_PUBKEY` | 更新清单签名公钥（base64 Ed25519） |
| `<数据目录>/desktop-settings.json` | `{ "updateBaseUrl": "https://你的域名/celestea-studio" }` —— **自建源不用重新编译** |
| `CELESTEA_DESKTOP_APP` / `STUDIO_STATIC_ROOT` | 调试打包问题时覆盖资源根 / 前端产物 |

## 3. 托盘与窗口行为

- **关闭窗口 ≠ 退出**：关窗只是隐藏，会话/worker/进行中的 turn 继续跑；退出在托盘菜单里。
  （系统没有托盘时关窗即退出——不把用户困在没有入口的状态里。）
- 托盘菜单：显示/隐藏窗口、在浏览器中打开、检查更新、打开数据目录、版本号、退出。
  每个动作都会写日志（`window hidden from the tray` 等），点完不用猜。
- 托盘图标按明暗背景各一份（`setIcon` / `setIconDark`）；Windows 任务栏默认深色，故直接用深色版。
- 窗口大小/位置记在 `<数据目录>/desktop-window.json`，下次启动恢复。
- macOS 额外装一个原生应用菜单（App/Edit/View 的系统 role）；Linux/Windows 不装（托盘已够，多一条菜单栏是噪声）。
- 日志：`[celestea-desktop]` 是外壳，`[celestea-studio-ts]` 是服务端；同时镜像到 `<数据目录>/desktop.log`。

### 「在浏览器中打开」为什么要自己实现一套

CLI 里的 `openBrowser()` 是**发射后不管**的：它只检查 `xdg-open` / `open` / `cmd` 在不在 PATH 上，
然后把进程 detach 掉并返回 `{opened:true}` —— 那是对「这个程序存在」的判断，不是对「浏览器起来了」的判断。
桌面应用不能这样：用户点了托盘，应用唯一的反馈就是它自己那句话。

实测踩到的正是这个坑：`xdg-open` 拉起了 Microsoft Edge，Edge 在一个只读 profile 的会话里立刻崩溃，
窗口从未出现，而旧实现照样写「已打开」。所以 `src/open-target.ts` 现在：

1. 依次尝试一组打开器（`xdg-open` → `gio open` → `kde-open5` → `kde-open` → `$BROWSER`；macOS `open`；Windows `cmd /c start`），
2. **等待真实的退出码**（给会把浏览器放前台的打开器留 6 秒宽限期），
3. 把退出码与 stderr 首行如实回报；全都失败时弹一个**可复制的原生对话框**（`prompt` 预填地址），
   再发一条通知，而不是沉默。

已验证/未验证：Linux 的 `xdg-open` 全流程（含失败路径）在本机验证过；macOS/Windows 用的是各平台文档写明的打开器，
**没有在真机 Mac/Windows 上验证过**——但因为判定依据是真实退出码，行为不同只会表现成「如实报失败 + 给出可复制地址」，
不会继续假装成功。

## 4. 自动更新

运行时流程（由 `Deno.autoUpdate()` 实现，外壳只做状态与交互）：

```
启动 → GET <baseUrl>/<os-arch>/latest.json → 版本比对 → GET <baseUrl>/<os-arch>/<patch>
     → 校验 sha256 → 应用 bsdiff 到运行时库 → 落盘为 <dylib>.update
     → 启动时 launcher 换入新库；启动失败则自动回滚到 <dylib>.backup
```

### 地址规则：**每个平台一份，不是一份通用补丁**

补丁是**运行时库**的二进制差分（Linux `<名字>.so`、macOS `.app` 内 dylib、Windows `denort.dll`），
所以它天然按 OS + 架构分开——**不存在全平台共用的一份补丁**。官方文档给的两种做法里，本项目用「按架构分目录」：

```
<baseUrl>/<os-arch>/latest.json      os-arch ∈ linux-x64 | linux-arm64 | macos-x64 | macos-arm64 | windows-x64
```

`baseUrl` 的解析优先级（`src/paths.ts` 的 `resolveUpdateBaseUrl`）：

1. `CELESTEA_DESKTOP_UPDATE_URL`（临时覆盖 / 测试）
2. `<数据目录>/desktop-settings.json` 的 `updateBaseUrl`（自建源，不必重编译）
3. 编译期烧入的 `desktop.release.baseUrl`（`build.mjs --update-url`）

**默认不带任何更新源**：不填就是「未配置更新源」，托盘菜单如实这么写，而不是去连一个永远连不上的占位域名。
（第一版曾内置 `https://releases.celestea.dev/…`，于是每次「检查更新」都变成一条 DNS 失败的假故障。）

其余行为：

- 轮询间隔 1 小时；托盘「检查更新」是**自己读 `latest.json` 比对版本**，因此「已是最新」不是猜的；
  命令行等价物是 `--check-updates`。
- 就绪 / 回滚分别弹通知，并写进托盘菜单行（通知可能被系统拒绝，菜单行不会）；
  「回滚」与「检查失败」是两种状态，不再混成一句「检查失败」。
- Windows 目前**只下载不生效**（launcher 不能替换已加载的 DLL），通知里明说。
- 签名：`gen-update-key.mjs` 生成 Ed25519 密钥，`make-release.mjs --sign-key` 签清单，公钥放进
  `desktop/update-pubkey.txt`（会随构建进应用）或用 `CELESTEA_DESKTOP_UPDATE_PUBKEY`。

### 4.1 回滚：文档说会自愈，实测**没有**触发（重要）

官方文档的规则是：launcher 在启动时看运行时库旁边两个文件——
`<dylib>.backup` 有 + `<dylib>.update-ok` 有 → 认为「该更新已确认」；
`<dylib>.backup` 有 + `<dylib>.update-ok` 无 → 回滚，把 backup 还原回去（"This makes broken updates self-healing"）。

本机用「**必然加载失败**的库」（保留 ELF 魔数，清掉 program header：`e_phnum=0`，dlopen 直接报
`目标文件没有可加载的段`）逐步实测，状态如下：

| 启动 | 动作 | `.so` | `.backup` | `.update-ok` | 结果 |
|---|---|---|---|---|---|
| ① `--check-updates` | 暂存补丁 | 完好 | 无 | 无 | `kind: ready` |
| ② 普通启动 | 换入 | **坏** | 有 | **有** ← 哨兵在这里就被写了 | exit 0（本次仍跑旧库） |
| ③ 普通启动 | 跑坏库 | 坏 | 有 | 有 | exit 1（`Failed to load runtime`） |
| ④ 普通启动 | — | 坏 | 有 | 有 | exit 1，**未回滚** |
| ⑤ 普通启动 | — | 坏 | 有 | 有 | exit 1，**未回滚** |

原因很清楚：`.update-ok` 是**执行换入的那一次启动**写下的，而那时新库根本还没被加载过。
于是 launcher 看到「哨兵存在」就判定更新已被确认，`.backup` 永远不会被用来还原 ——
**回滚这条路径在它本该生效的失败模式上不会触发，应用会一直启动不了**，`onRollback` 也就从未被调用。

因此本仓补了一个恢复命令（跨平台，会保留失败的那个库为 `<dylib>.broken` 供上报）：

```bash
node desktop/scripts/repair-rollback.mjs --app "/path/to/CelesteaStudio"   # 先 --dry-run 看状态
```

实测：上面那张表里连续 5 次启动失败的目录，跑一次本脚本后立刻正常启动（`exit 0`）。

发布方仍然要做文档里的那条最佳实践：**补丁先在真实安装上跑一遍再发清单**（本仓的 `verify-patch.mjs` 只能验字节，
验不了「能不能启动」；§5.3 的本地 HTTPS 流程可以验真机链路）。

### 实测到的换入时序（本机验证）

| 启动 | 观察到的事实 |
|---|---|
| 第 N 次（首次带 `.update` 启动） | launcher 生成 `<dylib>.backup`、把 `.update` 换到 `<dylib>`、写 `<dylib>.update-ok`；**本次进程仍跑旧库**（`Deno.desktopVersion` 仍是旧号），但载荷（`webdist`/`release.json`/健康接口）已是新版本 |
| 第 N+1 次 | 运行新库：`Deno.desktopVersion` = 新版本，`.backup` 与 `.update-ok` 被清理（换入确认成功） |

因此外壳**显示与比较用的是载荷版本**（`app/release.json`，随补丁一起更新），通知文案也写成「重启时换入」而不是
「下次启动即是新版本」，避免第 N 次启动误报旧版或反复重下同一个补丁。

## 5. 发布与打包

### 5.1 一次构建，全部平台

```bash
# 全平台（5 个目标，默认格式）+ 设置自建更新源
node desktop/scripts/build.mjs --all-targets --update-url https://dl.example.com/celestea-studio
node desktop/scripts/build.mjs --target windows --formats msi,zip
node desktop/scripts/build.mjs --target linux-arm64 --formats AppImage
node desktop/scripts/build.mjs --no-release            # 只出二进制，不整理 release/
```

| flag | 说明 |
|---|---|
| `--all-targets` | `linux-x64 linux-arm64 macos-x64 macos-arm64 windows-x64` |
| `--format/--formats` | 逗号分隔；可用：linux `AppImage/deb/rpm/dir`，macos `app/dmg/dir`，windows `msi/dir`，另加 `zip`/`tar.gz` 归档包装 |
| `--update-url` | 写进 `desktop/deno.json` 的 `desktop.release.baseUrl`（编译期烧入的默认源） |
| `--continue-on-error` | 某个平台失败不影响其它平台（多平台发布不该全军覆没），失败原因记进 `index.json` |
| `--index-only` | 不构建：重新扫描 `release/<os-arch>/` 并重写 `SHA256SUMS.txt` / `index.json` / `README.md`（CI 合并各 runner 产物时用的就是它） |
| `--macos-unsigned` | 在非 macOS 宿主上也产出 `.app`（用 Node 写的 `iconutil`/`codesign` 替身）。产物**未签名**，见 §5.4 |
| `CELESTEA_DESKTOP_DIST` | 环境变量：换个中间产物目录（做补丁时用它并行构建下一个版本，不覆盖上一版基线） |
| `--no-release` | 只在 `desktop/dist/` 出中间产物，不整理 `release/` |
| `--deno-flag` | 透传给 `deno desktop`（例如 `--deno-flag "--cert=ca.pem"` 信任自建更新源的私有 CA） |

默认格式：linux `AppImage + deb`、macos `app + zip`、windows `msi + zip(便携目录)`。
Windows 的 `dir` 只作为 zip 的源与补丁基线，不复制进 `release/`（`distribute: false`）。

**macOS 必须在 macOS 上打**：`.app` 要 ad-hoc 签名，用的是 `codesign(1)`。
Deno 自己的报错字符串就是这么写的（`strings $(which deno) | grep codesign` 可见）：

```
codesigning requires a macOS build host (uses `codesign(1)`).
Run `deno desktop` on macOS, or drop `macos.codesignIdentity` from your deno.json when cross-building.
```

实测：在 Linux 上给 `--target x86_64-apple-darwin` 会把 dylib 编译出来，然后在组装 `.app` 时以
`error: No such file or directory (os error 2)` 失败（`codesign` 不存在）。所以 `--all-targets`
在非 macOS 宿主上会**显式跳过** macOS 并写进日志与 `index.json` 的 `notBuilt`（而不是安静少一个平台）；
显式 `--target macos-arm64` 则直接报这条原因。要拿到 macOS 产物有两条路：在 Mac 上跑同一条命令，
或用仓库里的 `.github/workflows/desktop-release.yml`（三个 runner 各建自己的平台，最后一个 job 用
`--index-only` 合并成一棵 `release/` 树 + 校验和）。该 workflow 在本机无法执行验证，逻辑是照 CI 约定写的。

`.dmg` 需要 `hdiutil`（同样是 macOS 主机），所以 macOS 默认给 `.app` + 保留执行位的 zip；
`.deb`/`.rpm`/`.msi`/`.AppImage` 都是纯 Rust 组装，可跨平台产出（本机实测：linux-x64 / linux-arm64 的
AppImage+deb、windows-x64 的 msi+zip 全部产出成功）。

### 5.2 发布下一个版本：升级文件是怎么来的

升级文件（`patch-<旧>-to-<新>.bin` + `latest.json`）不是「打包时顺手生成」的，它需要**两个版本的运行时库**做差分。
完整链路：

```bash
# ① 留住旧版本的「未打包应用目录」——补丁就是拿它当基线
#    默认在 desktop/dist/<os-arch>/<format>/<AppName>/；建议按版本另存一份
cp -r desktop/dist/linux-x64/AppImage/CelesteaStudio  ~/releases/2.8.1/linux-x64/CelesteaStudio

# ② 构建新版本（版本号写进 deno.json → 烧进二进制，成为 Deno.desktopVersion）
#    用 CELESTEA_DESKTOP_DIST 换一个中间产物目录，避免覆盖 ① 的基线
CELESTEA_DESKTOP_VERSION=2.8.2 CELESTEA_DESKTOP_DIST=dist-2.8.2 \
  node desktop/scripts/build.mjs --skip-repo-build --no-release --target linux-x64 --formats AppImage

# ③ 差分 → 补丁 + 合并清单（每个平台各跑一次）
BSDIFF=$(command -v bsdiff) node desktop/scripts/make-release.mjs \
  --from ~/releases/2.8.1/linux-x64/CelesteaStudio \
  --to   desktop/dist-2.8.2/linux-x64/AppImage/CelesteaStudio \
  --version 2.8.2 --from-version 2.8.1
# → release/linux-x64/patch-2.8.1-to-2.8.2.bin + 该目录 latest.json 里新增 2.8.1 条目

# ④ 发布前双重复核（本仓独立读取器 + 可选第三方 bspatch）
node desktop/scripts/verify-patch.mjs --old ~/releases/2.8.1/linux-x64/CelesteaStudio/CelesteaStudio.so \
  --patch release/linux-x64/patch-2.8.1-to-2.8.2.bin \
  --expect desktop/dist-2.8.2/linux-x64/AppImage/CelesteaStudio/CelesteaStudio.so
```

`make-release.mjs` 的输入是「运行时库」——它按固定名单找（`libdenort.so` / `denort.dll` / `libdenort.dylib`），
找不到时退化为「目录里唯一一个 ≥8 MiB 的 `.so`/`.dylib`/`.dll`」，本仓产物里即 `CelesteaStudio.so`（Linux 目录）、
`CelesteaStudio.dll`（Windows 目录）、`…/Contents/MacOS/libruntime.dylib`（macOS `.app`）。

`make-release.mjs` 会**合并**已有 `latest.json`：每个「起始版本」一个条目，落后两三个版本的用户也有对应补丁；
`--platform <os-arch>` 可显式指定平台（否则从 `--to` 路径里的 `<os-arch>` 推断）。
没有 `bsdiff` 命令时用 `--full`：写出一个**合法但整库大小**的补丁，只适合本地验证更新链路。

本机实测（真 `bsdiff`，`pip install bsdiff4`，Linux x64 / Windows x64 各跑一次）：

| 项 | 实测值 |
|---|---|
| 旧运行时库 | 84,485,128 B（80.57 MiB） |
| 新运行时库 | 84,485,128 B（80.57 MiB） |
| 两库差异 | **只有 308 字节**（99.999635% 逐字节相同）——这次演示两版之间只差了版本号本身 |
| **随包补丁** | **linux 310 B / windows 320 B** |
| 复核（本仓） | `verify-patch.mjs` 独立读取器还原后与新库 sha256 相同 |
| 复核（第三方） | `bspatch4` 还原后与新库 `cmp` 逐字节相同 |
| 清单 | `latest.json` 的 `version` 升到 2.8.2，并新增 `"2.8.1": { name, sha256 }` |

这两个数字是**机制的上下界**，真实发布的补丁落在中间，大致与「改了多少嵌入代码」成正比：

- **下界 310 B**：只动了版本号（本次演示）。bsdiff 把「大部分字节相同」这件事利用到极致——
  差异流几乎是全零，bzip2 之后只剩几百字节。
- **上界 28 MiB**：`--full` 写出的全量补丁（库有多大、补丁就差不多多大），只在没有 `bsdiff` 时用于本地验证。
- 真实版本（改了功能代码、前端产物、契约文件）会是几百 KiB～几 MiB 量级；
  官方文档因此建议**把补丁先在真实安装上跑一遍**再发布——本仓的 `verify-patch.mjs` 是发前的字节级复核，
  真机验证则用 §5.3 的本地 HTTPS 流程。

### 5.3 本地验证更新链路（不需要真发布源）

```bash
# 生成「测试 CA + 由它签发的叶证书」（自签证书当叶证书会被 rustls 以 CaUsedAsEndEntity 拒绝）
node desktop/scripts/serve-release.mjs --dir release/linux-x64 \
     --generate-cert tmp/release-tls --port 8443

# 用 CA 编译一个测试版本，让它信任这台测试服务器
node desktop/scripts/build.mjs --skip-repo-build --out tmp/e2e \
     --formats AppImage --deno-flag "--cert=tmp/release-tls/ca.pem"

# 立刻检查一次（确定性的，不用等 1 小时轮询）
CELESTEA_DESKTOP_UPDATE_URL=https://127.0.0.1:8443 \
  ./tmp/e2e/linux-x64/AppImage/CelesteaStudio/CelesteaStudio --check-updates
```

本机跑通的完整链路（v2.8.1 → v2.8.2，28 MiB 全量补丁）：

```
[release-server] GET /latest.json ua=Deno/2.9.7
[release-server] GET /patch-2.8.1-to-2.8.2.bin ua=Deno/2.9.7
"updateCheck": { "kind": "ready", "version": "2.8.2" }
# 换入后：sha256(旧 .so) == sha256(新 .so)、健康接口 version=2.8.2、PASS version: v2.8.2、.backup/.update-ok 已清理
```

### 5.4 macOS 交叉编译：一台机器到底能不能出全平台

能，但要说清代价。实测（Linux 宿主 → `--target x86_64-apple-darwin`）：

| 阶段 | 结果 |
|---|---|
| 编译 dylib | ✅ 成功（`file` 显示 `Mach-O 64-bit x86_64`） |
| 组装 `.app` | ❌ `error: No such file or directory (os error 2)` —— 它要调两个 macOS 专有工具 |
| 其中 `codesign` | Deno 二进制里的原话：`codesigning requires a macOS build host (uses codesign(1))` |
| 其中 `iconutil` | 把 `Contents/Resources/AppIcon.iconset/*.png` 打成 `AppIcon.icns`；即使 `deno.json` 里给的是预生成的 `.icns`，它**仍会**先展开成 iconset 再调 `iconutil`（实测），所以躲不开 |

所以本仓补了两个**纯 Node 替身**（`scripts/macos-unsigned-tools.mjs`）：
`iconutil` 只做容器转换（`.icns` = 头 + `(类型,长度,PNG)` 条目，iconset 里已经是 PNG，不需要任何图像处理），
`codesign` 直接返回成功。`--macos-unsigned` 打开它，产物实测：

```
Celestea Studio.app/Contents/
  Info.plist                     CFBundleIdentifier=com.celestea.studio, CFBundleIconFile=AppIcon
  MacOS/laufey_webview           Mach-O 64-bit x86_64 executable (0755)
  MacOS/libruntime.dylib         Mach-O 64-bit x86_64 dylib (0755)
  Resources/AppIcon.icns         "Mac OS X icon, ic165502 bytes, ic07 type"
```

**代价必须讲明**：这个 `.app` 没有代码签名，macOS 首次打开会被 Gatekeeper 拦下。用户需要一次性清掉隔离标记：

```bash
xattr -dr com.apple.quarantine "Celestea Studio.app"      # 或右键 → 打开
```

顺带一个反而有利的点：自动更新会替换 `.app` 里的 dylib，而**任何真实的代码签名都会被这次替换作废**；
未签名的包没有签名可作废。要签名/公证（面向外部用户），仍然得在 Mac 上或用
`.github/workflows/desktop-release.yml` 的 macOS runner 跑同一条命令。

### 5.5 上传前检查清单

`release/` 是「一次上传」的形态，但「能上传」不等于「已经适合对外发布」。逐条对照：

| 检查项 | 现在这一版（2.8.1 首次发布） |
|---|---|
| 目录结构 | ✅ 每个 `<os-arch>/` 一个更新源；顶层 `SHA256SUMS.txt` / `index.json` / `README.md` |
| 校验和 | ✅ 在 `release/` 里跑 `sha256sum -c SHA256SUMS.txt` 全过（本次 5 平台 8 个文件；`.app` 目录本身不可哈希，由其 zip 代表） |
| 更新清单 | ⚠️ 每个 `<os-arch>/latest.json` 存在，但 `patches: {}` ——**首次发布天然没有补丁**，升级能力从第二个版本开始 |
| 更新源地址 | ⚠️ 默认没配（`updateUrl: null`）：上传前用 `--update-url https://你的域名/celestea-studio` 重编，或让客户端读 `desktop-settings.json` |
| 清单签名 | ⚠️ 未签名（没跑 `gen-update-key.mjs`）。内网可接受；公开分发建议签 |
| macOS | ⚠️ 未签名：`release/macos-*/` 里是 `.app` 的 zip（`index.json` 标了 `unsigned: true`）。用户首次打开要清隔离标记；要对外发就得在 Mac/CI 上签 |
| Linux ARM64 / Windows | ⚠️ 产物结构已验（deb 布局、zip 内含 exe/dll/ico），但**没在真 ARM64 机器 / 真 Windows 上跑过** |
| Linux x64 | ✅ 打包产物 `--self-test` 11 项全 PASS（含资源解包、契约、静态资源、70 个端点） |
| 版本号 | ✅ `deno.json` / 二进制 / 清单三处一致（2.8.1） |

结论：**结构上可以直接上传**（一个目录、按平台分好、有校验和），
但首次发布的 `patches` 是空的，且 macOS 未签名 —— 这两点要在发布说明里对用户讲清，别让用户以为「装完就能自动升级」。

### 5.6 与官方 auto_update 文档的逐条对照

| 文档要求 | 本仓实现 | 验证方式 |
|---|---|---|
| `deno.json` 的 `version` | ✅ 2.8.1，构建时从根 `package.json` 同步（只改那一行） | `--self-test` 报 `version: v2.8.1` |
| `deno.json` 的 `desktop.release.baseUrl` | ⚠️ 默认不写（本仓没有真实发布域名；写占位域名会让「检查更新」每次都是 DNS 假故障） | 外壳**始终显式传 `url`**；见下方说明 |
| `Deno.desktopVersion` 为 null 时是空操作 | ✅ 先判空并如实报「没有烧入版本」 | `deno run` 下 `--check-updates` → `unsupported` |
| `url` 无 baseUrl 时必填 | ✅ 优先级：环境变量 → `desktop-settings.json` → 编译期默认 | 日志 `update source: … [env]` |
| `interval` 省略=只查一次 | ✅ 常驻 1 小时轮询；`--check-updates` 是单次 | 日志 `polling … every 60min` |
| `onUpdateReady` / `onRollback` | ✅ 都接（通知 + 托盘行 + 日志） | A1 实测 `ready`；`onRollback` 见 §4.1（运行时不会触发） |
| `publicKey`（base64 Ed25519） | ✅ 从 `app/update-pubkey.txt` 或环境变量读入 | **A1 正确公钥→`ready`+暂存；A2 错误公钥→不暂存** |
| 清单 `{version, patches:{from:{name,sha256}}}` | ✅ 完全一致（`--sign-key` 时外层为 `{signed,signature}` 信封） | `make-release` 产物 + 运行时接受 |
| `sha256` 小写 hex、必需 | ✅ `node:crypto` 的 hex | 校验不过就不会暂存 |
| `name` 相对清单 URL | ✅ 补丁与 `latest.json` 同目录 | 服务器日志 `GET /linux-x64/patch-…bin` |
| 更新 URL 必须 `https://` | ✅ 外壳前置校验并立刻给出原因 | 代码路径 + 文档规则 |
| 签名信封 | ✅ `make-release --sign-key` / `gen-update-key.mjs` | A1/A2 |
| 更新流程七步（获取→比对→查补丁→下载→验+应用→`.update`→回调） | ✅ | 早前 E2E：下载→sha256→`.update`→换入→版本变化→`.backup/.update-ok` 清理 |
| 回滚三文件语义 | ⚠️ **按文档实现，但实测运行时不按它回滚** | §4.1 + `repair-rollback.mjs` |
| bsdiff 4.x 生成补丁 | ✅ 真 `bsdiff`（bsdiff4） | 补丁 310 B；双读取器逐字节还原 |
| 多架构分开 | ✅ `<baseUrl>/<os-arch>/latest.json` | 日志 URL 带 `/linux-x64` |
| Windows 只下载不生效 | ✅ 通知里明说 | — |
| 最佳实践（签名 / 真机试补丁 / 合理间隔） | ✅ / ⚠️ / ✅（1 小时） | 见 §5.3、§4.1 |

两处刻意的偏差，理由都在上面：`baseUrl` 默认不写（用显式 `url` 传，功能等价），
目录 slug 用规范化后的 `linux-x64`/`macos-arm64` 而不是文档示例里的 `Deno.build.os + "-" + Deno.build.arch`
（`linux-x86_64`）——文档明确允许自定义方案（"在架构特定的键下包含所有补丁并在客户端上进行选择"），
关键是客户端与工具端一致：两边都由 `platformSlug()` 定义（`desktop/src/paths.ts` 与 `desktop/scripts/platforms.mjs`，必须同步）。

### 5.7 单实例（一个应用 = 一个托盘图标 = 一个服务）

安装版上「**托盘按钮完全没反应**」+「**应用可以被重复启动**」是同一个根因。实测（两个 deb 启动器同时跑）：

| 现象 | 实测值 |
|---|---|
| 两个实例各起服务 | 端口 43015 与 36921，两套会话引擎、同一份数据目录 |
| 两个实例注册托盘项 | 都在**同一个 D-Bus 对象路径** `/org/ayatana/NotificationItem/laufey_tray_1`（序号按进程从 1 开始，必然撞车） |
| 点击落到哪 | 面板按它缓存的「路径 → 总线名」投递，于是点击落到**另一个实例**（或已退出的那个）→ 表现就是按钮全死 |

所以修单实例就是修托盘。`desktop/src/single-instance.ts`：

- 数据目录下 `desktop-instance.json`（`{pid, startedAt, socket, version}`）+ `desktop-instance.sock`；
- 第二个实例连上 socket 发 `show`，把已有窗口抬到前台后**自己退出**（实测 **466ms** 退出）；
- 正常退出时清理锁与 socket（实测：清理后立刻可再启动）；
- 发现锁里的 pid 已死 → 判定为崩溃残留，**接管**（实测：伪造 pid 999999 的残留锁被正确清理并接管）——崩溃绝不会让应用永久「已在运行」；
- 诊断模式（`--self-test` / `--check-updates`）不抢锁、也不建窗口/托盘，随时可跑（但仍需显示服务器，见 §5.9）；
- 逃生门 `CELESTEA_DESKTOP_ALLOW_MULTI=1` 绕过守卫（本仓明确支持「在生产实例旁边起一个一次性实例」的用法）。

另外两个环境开关：

| 变量 | 作用 |
|---|---|
| `CELESTEA_DESKTOP_NO_TRAY=1` | 不建托盘图标（有些桌面没有状态区 / 用户不想要）；此时关窗即退出 |
| `CELESTEA_DESKTOP_ALLOW_MULTI=1` | 允许多实例（调试用；**共用数据目录会死锁**，见 §5.7.1） |
| `CELESTEA_DESKTOP_FORCE=1` | 上一个实例卡住时强行接管（会打印警告：两个实例共享数据目录） |

### 5.7.1 为什么必须修重复启动（实测到的死锁）

不是「多开一个窗口」这么轻。**两个实例共用同一数据目录时，退出会死锁**，实测（`ALLOW_MULTI=1` 故意放开守卫后）：

```
A/B 两份日志的最后两行完全相同：
  quitting (tray) — draining the studio server
  studio server drained          ← 然后两个进程都卡在 futex_wait，10 秒内进程数始终是 2
```

留下的状态就是用户看到的现象：**进程不死（但不是活着的服务）→ 面板图标还在 → 点它的菜单毫无响应**。
用户以为「托盘坏了」，于是再点启动 → 更多实例 → 更多僵尸图标。

所以单实例守卫修的不是洁癖，而是这条：「重复启动 → 共享数据目录 → 退出死锁 → 僵尸进程 + 死图标」。
加了守卫后，单实例的四种退出路径实测均为 **3 秒内干净退出**（IPC 退出、带/不带托盘、直接点托盘「退出」项）。

遇到「有实例活着但不应答」时（万一是别的死锁），新实例不会再无解地卡住，而是打出 PID 与两条出路：

```
another instance is running (pid 692945) but does not answer on …/desktop-instance.sock.
  It is most likely hung. End it with:  kill 692945   (or kill -9 692945 if that does nothing)
  To start anyway, knowing that two instances would share this data directory: CELESTEA_DESKTOP_FORCE=1
```

### 5.8 排障：面板上有个点不动的旧图标

AppIndicator 是「面板缓存 + 进程注册」两层，进程异常退出后**图标可能残留**，点它当然没反应。按顺序做：

```bash
# 1) 先确认到底还有没有活着的实例（按 /api/health 指纹扫环回端口；3777/3778 是你的开发服务，别杀）
for p in $(ss -ltn | awk '$4 ~ /^127\.0\.0\.1:/ {split($4,a,":"); print a[2]}' | sort -un); do
  [ "$p" = 3777 ] || [ "$p" = 3778 ] && continue
  curl -s -m 1 "http://127.0.0.1:$p/api/health" | grep -q celestea-studio && echo "活实例: $p"
done

# 2) 若确实有僵住/残留的进程，按名字杀掉（不会误伤开发服务：它的进程名里有连字符）
pkill -if celesteastudio        # 不行再 -9

# 3) 刷新面板里的残留图标（AppIndicator 扩展重载，不用重启整个桌面）
gnome-extensions disable ubuntu-appindicators@ubuntu.com
gnome-extensions enable  ubuntu-appindicators@ubuntu.com
```

装的是旧版（没有单实例守卫）时，第 2 步会是常态；重装带守卫的新版后，重复启动会被正确拒绝并把已有窗口抬起来。

### 5.9 跑在无显示器的地方（CI / 容器 / systemd）

`deno desktop` 生成的**启动器本身是 GTK/WebKitGTK 程序**，进程一起来就找显示服务器，找不到就死在负载之前：

```
$ env -i PATH=/usr/bin:/bin HOME=$HOME ./release/linux-x64/CelesteaStudio.AppImage --self-test
(CelesteaStudio:713886): Gtk-WARNING **: cannot open display:
$ echo $?
1
```

三点都实测过，别按直觉猜：

- **与托盘无关**：加 `CELESTEA_DESKTOP_NO_TRAY=1` 结果不变（同一二进制、同一参数，一样 exit 1）。
- **一行日志都不会有**：启动器自己的 `Runtime loaded successfully` 都打不出来 —— 它死在我们的代码之前。所以「`--self-test` 不建窗口/托盘」（§5.2、§5.7）**不等于**「不需要显示服务器」。
- **要的是显示服务器，不是某个环境变量**：X11（`DISPLAY` + `/tmp/.X11-unix/X<n>`）或 Wayland（`XDG_RUNTIME_DIR` 下有 `wayland-0`）二者之一即可。只设 `DISPLAY` 而那个 X socket 已不存在时，照样失败（实测：`DISPLAY=:0` + 空的 `XDG_RUNTIME_DIR` → exit 1）。

无头环境给它一个虚拟显示即可。装 Xvfb 与启动器的系统依赖（**AppImage 里只有我们的负载，没有 WebKitGTK**：`ldd` 显示 `libwebkit2gtk-4.1.so.0` / `libgtk-3.so.0` 直接来自系统）：

```bash
sudo apt-get install -y --no-install-recommends xvfb libwebkit2gtk-4.1-0
xvfb-run -a ./release/linux-x64/CelesteaStudio.AppImage --self-test   # 实测 exit 0，11 项全 PASS
```

`.github/workflows/desktop-release.yml` 就是这么跑自检的。它的覆盖边界（**别把「CI 绿」读成「五个平台都真机跑过」**）：

| runner | 构建 | 自检（只有 runner 自己的架构跑得起来） |
|---|---|---|
| ubuntu-latest | linux-x64 + linux-arm64 | ✅ `linux-x64` 的 AppImage（Xvfb 下）；arm64 只验结构 |
| macos-14（Apple Silicon） | macos-arm64 + macos-x64 | ✅ `macos-arm64` 的 `.app`；x64 只验结构 |
| windows-latest | windows-x64 | ✅ `CelesteaStudio.exe`（`release/` 里只有 msi/zip，跑不了 → 取 `desktop/dist/` 里解包的那份） |
| merge（ubuntu） | — | 汇总成一棵 `release/` 树并重算 `SHA256SUMS.txt` / `index.json` |

自检找不到可执行文件时**直接失败**（早期版本的 `find` 在两个 runner 上落空却静默通过 —— 那种绿是假的）。

## 6. 构建流水线

```
pnpm run build                 # ① 仓库产物：packages/*/dist、apps/studio/dist、apps/web/dist
desktop/scripts/bundle-server  # ② esbuild → app/celestea-server.mjs（只依赖 node: 内建）
desktop/scripts/stage.mjs      # ③ app/ = bundle + webdist + contracts + icons + package.json + release.json
deno desktop --include app     # ④ 打包成二进制（Deno 运行时 + webview 后端 + 上面的 app/）
```

`app/` 的布局不是随意的：三处运行期解析会从模块自身位置向上找文件——
`packages/core/src/repo.ts` 找 `contracts/endpoints.json`，`apps/studio/src/deployment.ts` 与
`version.ts` 找最近的 `package.json` 再找 `webdist/`——只有把 bundle 放在同时含这四者的目录里，三者才一致。
详见 `scripts/stage.mjs` 的注释。

另外两个刻意的选择：`tsconfigRaw: {}` 关掉 tsconfig `paths`（否则 esbuild 会去解析 TS 源码而不是随包发布的
`dist/`）；workspace 包按**路径**解析而不走 pnpm 的 `node_modules` 软链（原因见 §8）。

`desktop/` 不在 pnpm workspace 内，也不进仓库任何门禁（tsconfig include / eslint 源集 / dependency-cruiser 目录）；
`desktop/deno.json` 的 `version` 由构建脚本从根 `package.json` 同步——它会被烧进二进制并与更新清单比对。

## 7. 已知事实与边界

- **端口由运行时决定**：桌面模式下 `deno desktop` 先分配一个环回端口（`DENO_SERVE_ADDRESS`）并把
  webview 指向它，所以服务必须绑这个端口——`--port` 在此模式无效（无界面模式才生效）。
- **webview 后端用系统库**：Linux 需要 `libwebkit2gtk-4.1` 与 GTK3；托盘需要 AppIndicator
  （`libayatana-appindicator3`）。都没有时窗口仍可用、托盘降级。要完全自包含用 `--backend cef`。
- **自动更新的回滚不可依赖**：见 §4.1 的实测。发布前务必真机试补丁；万一用户装完打不开，
  用 `desktop/scripts/repair-rollback.mjs` 还原（旧库仍在 `<dylib>.backup`）。
- **SIGTERM 不一定走到优雅退出**：`deno desktop` 的启动器是独立进程，外部 `SIGTERM` 可能先结束它。
  托盘「退出」与（无托盘时）关闭窗口都会走完整退出路径；要可复现地验证这条路径请用 `--exit-after-ms`。
- **权限**：桌面二进制以 `-A`（全部权限）编译。agent 要读写工作区、执行命令、跑沙箱（bwrap/prlimit）、
  访问模型 API，权限集本身就是产品能力。只想要界面就用 `--port` 的无界面模式并自行收紧权限。
- **数据不出本机**：会话/工作区/密钥全在 `CELESTEA_HOME`，外壳不新增遥测；唯一外呼是模型 API 与你配置的更新源。
- **AppImage 需要 FUSE**：没有 FUSE 的环境（容器、部分沙箱）用 `--appimage-extract-and-run`，
  或直接用同一次构建产出的未打包目录。

## 8. 顺带发现（与本仓有关，建议跟进）

`packages/runtime` 在运行期 `import "@celestea/swarm"`，但 `packages/runtime/package.json` **没有声明**这个依赖：

```
$ cd apps/studio && node -e "import('@celestea/runtime')"
FAILED: Cannot find package '@celestea/swarm' imported from packages/runtime/dist/swarm-wiring.js
```

开发态用 tsx + tsconfig `paths` 不会暴露它，但**构建产物**（`celestea web` 的真实运行路径）会。
桌面打包器因此改为按路径解析 workspace 包，绕开了这个洞；正解还是补上依赖并重生成 lockfile。
