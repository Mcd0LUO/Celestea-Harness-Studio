# 桌面端打包：已评估 PR #5，暂缓

> 状态：**当前**（2026-10-04 决定：暂缓桌面端打包）。本文是「为什么不做桌面端打包」的唯一权威记录。
> 参考实现：外部贡献者 Yinxe 的 PR #5（**已关闭，未合并**）—— <https://github.com/Mcd0LUO/Celestea-Harness-Studio/pull/5>
> 评估方式：在**独立 worktree** 里只摘该 PR 的桌面提交（`23dedc1`），丢掉已被 2.8.3 取代的 `fix(deps)`；主工作区全程未受影响。

---

## 1. 结论

**暂不引入桌面端打包。** 本仓的工具链是刻意收窄的（一个运行时 Node、一个包管理器 pnpm、一种语言 TypeScript），
而 `deno desktop` 要求引入第二个运行时，且它自身标记为 experimental。当前阶段不接受这个长期维护承诺。

## 2. 我们实测过什么（不是纸面评审）

| 步骤 | 结果 |
|---|---|
| `pnpm install --frozen-lockfile` | 3.5s |
| `pnpm run build` | 10.8s |
| `build.mjs --skip-repo-build --target windows-x64 --no-release` | 18.9s，出 msi（**无需 WiX**）|
| `CelesteaStudio.exe --self-test` | exit 0，10 项必需检查全 PASS（70 端点 / SPA 文档 / 静态资源 / BrowserWindow+Tray / 版本 v2.8.3）|
| 到窗口出现 | 177 ms |
| 服务端就绪 | 146 ms |
| `--exit-after-ms 9000` | exit 0 / 11.3s，无残留进程 |
| 产物（Windows x64） | exe 0.3 MiB + dll 79.9 MiB；**installer msi 31.5 MiB** |
| 空闲私有工作集 | 268.2 MiB / 7 进程（Deno 侧 35.0，Chromium 渲染侧 233.2）|

## 3. 为什么暂缓（按重要性）

1. **第二个运行时 = 长期维护承诺。** 全仓 1277 个 `.ts`、1 个 `.sh`、零 `.py`/`.ps1`/`.rs` —— 刻意同质。
   桌面端还会顺手引入 Python（`gen-icons.py`，可选）与 bash（`quit-instances.sh`）。
2. **`deno desktop` 是实验形态。** Deno 构建时自己打印 `experimental and subject to change`；
   webview 后端是独立的 `laufey` 0.7.0 二进制；`deno types` 打不出桌面 API 声明（PR 手写了 141 行 `.d.ts`）。
3. **新表面会落在现有机械门禁之外。** `tsconfig` 的 include、eslint 的 `SOURCE_GLOBS`、depcruise 的目标
   都不含 `desktop/`；新的 `desktop-release.yml` 不监听 `pull_request`。按本仓规范，若要收必须先补门禁
   或在文档登记为接受的例外。
4. **一颗新的供给链盲区**：桌面二进制把 7 个 npm 依赖打进产物，而 `pnpm check` 与 `release-check` 都**不看**
   这个二进制 —— 现有供给链政策管的是 lockfile。

## 4. 替代方案的代价（对比后再决定）

| 方案 | 新增工具链 | 每个产物的代价 |
|---|---|---|
| Deno desktop | +1 运行时 + Deno CI | 无额外体积，但押 `deno desktop` |
| Electron | 0（复用 Node）| 每平台多带一份 Chromium（+150–250 MiB）+ 更新/签名栈自建 |
| Tauri | +Rust 工具链 | 体积最小 |
| 不做（现状）| 0 | npm 5.63 MiB + 浏览器 |

## 5. 如果以后要做

- 参考实现就是 PR #5（已关闭；代码在作者 fork 与我们的 PR 视图上仍在）—— **第一参考**。
- 退出成本有界：`desktop/src/` 约 2600 行中，绑死 Deno API 的约 **800–1400 行**
  （`updater.ts` / `single-instance.ts` / `tray.ts` / `app-menu.ts` + `main.ts` 一部分）；
  其余约 1200 行（i18n / log / notify / paths / window-state / open-target / studio-api / self-test）与平台无关。
  其 `main.ts` 头注释即声明「the desktop shell **owns nothing of the product**」。
- 若要收，先做三件事：① 边界写进 [`DEPENDENCY-POLICY.md`](./DEPENDENCY-POLICY.md)；② 给 `desktop/` 补门禁
  （至少 `deno check` + 「不得出现非 `node:` 导入」的断言）；③ 在 [`README.md`](./README.md) 文档地图登记。

## 6. 诚实声明（未验证的部分）

- 只在 **Windows x64** 上实测；Linux（WebKitGTK）与 macOS（WKWebView）未测。
- 268.2 MiB 是**空闲**状态（无长会话、无消息流）。
- **未做与 Electron 的等价对照实验**，故「Electron 用多少内存」无实测数字。
- `--backend cef`（自带 Chromium）与 `--engine quickjs` 未实测。

## 7. 顺带产出的两条独立结论

- 贡献者的 `fix(deps)` 与 2.8.3 修的是**同一个 P0**（`@celestea/runtime` / `@celestea/studio` 未声明
  `@celestea/swarm`）—— 两条独立路径同时命中，已修复并发布。
- `deno desktop --backend webview` 在 **Windows 上是 WebView2（Chromium）**，macOS 是 WKWebView，
  Linux 是 WebKitGTK；要三平台同引擎可用 `--backend cef`。

## 8. 附：本次试跑的产物与清理

- 试跑用的 worktree、免安装产物目录与 Deno 2.9.7 均已删除；`git worktree list` 只剩 main。
- 若要复现：需自行安装 Deno ≥2.9，再 `pnpm install --frozen-lockfile && pnpm run build`，
  然后 `node desktop/scripts/build.mjs --skip-repo-build --target <t>`。
