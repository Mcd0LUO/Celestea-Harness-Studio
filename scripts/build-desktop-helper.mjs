#!/usr/bin/env node
/**
 * build-desktop-helper.mjs — 本机自编译 Celestea 桌面 helper，并把产物摆到位。
 *
 * 为什么是「自编译」而不是下载预编译 exe（总规划 D6）：参考仓里那个来路不明的
 * 预编译二进制不能进供应链。本脚本只跑 cargo，然后把产物拷到 sidecar 约定路径。
 *
 * 产物路径由 packages/desktop 的静态挂载检查消费（总规划 §5）：
 *   packages/desktop/helper/bin/win32-x64/celestea-desktop-helper.exe
 * 该目录不进 git（见仓库根 .gitignore）。
 *
 * 用法：
 *   node scripts/build-desktop-helper.mjs              # release 构建 + 拷贝
 *   node scripts/build-desktop-helper.mjs --debug      # debug 构建（调试用）
 *   node scripts/build-desktop-helper.mjs --clean      # 先删 target/ 再构建
 *   node scripts/build-desktop-helper.mjs --sha256     # 额外打印产物 sha256
 *
 * 退出码：0 成功；非 0 表示构建或拷贝失败（失败原因原样透传，不吞）。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER_DIR = join(REPO_ROOT, "packages", "desktop", "helper");
const BIN_DIR = join(HELPER_DIR, "bin", "win32-x64");
const EXE_NAME = "celestea-desktop-helper.exe";

const argv = new Set(process.argv.slice(2));
const DEBUG = argv.has("--debug");
const PROFILE = DEBUG ? "debug" : "release";
const CLEAN = argv.has("--clean");
const PRINT_SHA = argv.has("--sha256");

function fail(message) {
  console.error("[build-desktop-helper] " + message);
  process.exit(1);
}

if (process.platform !== "win32") {
  fail(
    "helper 只在 win32 上构建。当前 " + process.platform +
    "。非 Windows 上 packages/desktop 的挂载检查本就不通过（总规划 §7），" +
    "所以这里直接失败而不是假装成功。",
  );
}
if (!existsSync(join(HELPER_DIR, "Cargo.toml"))) fail("找不到 " + HELPER_DIR + "/Cargo.toml");

if (CLEAN) {
  console.log("[build-desktop-helper] 删除 target/ 后做一次干净构建");
  rmSync(join(HELPER_DIR, "target"), { recursive: true, force: true });
}

const cargoArgs = ["build"];
if (!DEBUG) cargoArgs.push("--release");
if (argv.has("--locked")) cargoArgs.push("--locked");

/**
 * 找 MSVC 的 vcvars64.bat。
 *
 * 为什么必须自己找：rustc 靠 vswhere.exe 定位 MSVC，而 winget 装的 Build Tools
 * 不带 vswhere，于是「装了 Build Tools」也仍然报 linker 'link.exe' not found。
 * 调用方（新 shell、CI）也不会预先 load 过 VS 开发环境。所以这里显式探测，
 * 找到就把 cargo 包进 vcvars 环境里跑。
 */
function findVcvars64() {
  if (process.env.VSCMD_ARG_TGT_ARCH) return null; // 已经在 VS 开发环境里，不必包
  const roots = [
    process.env["ProgramFiles(x86)"],
    process.env.ProgramFiles,
    "C:\\Program Files (x86)",
    "C:\\Program Files",
  ].filter(Boolean);
  const editions = ["2022", "2019"];
  const flavors = ["BuildTools", "Community", "Professional", "Enterprise"];
  for (const root of roots) {
    for (const edition of editions) {
      for (const flavor of flavors) {
        const candidate = join(
          root, "Microsoft Visual Studio", edition, flavor, "VC", "Auxiliary", "Build", "vcvars64.bat",
        );
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

const vcvars = findVcvars64();
let buildResult;
if (vcvars) {
  console.log("[build-desktop-helper] 用 MSVC 环境构建：" + vcvars);
  // 不用 cmd 的 /s：加了 /s 之后 cmd 会剥掉整条命令的首尾引号，
  // 而这条命令的首字符是 call 不是引号，剥完路径就裂成 'C:\Program'。
  // 直接 call（call 让 vcvars 跑完把控制权交回同一条命令行）。
  buildResult = spawnSync("cmd.exe", ["/d", "/c", 'call "' + vcvars + '" >nul && cargo ' + cargoArgs.join(" ")], {
    cwd: HELPER_DIR,
    stdio: "inherit",
    windowsVerbatimArguments: true,
  });
} else {
  console.log("[build-desktop-helper] 未找到 vcvars64.bat，直接调 cargo（若报 linker not found 请先装 MSVC Build Tools）");
  buildResult = spawnSync("cargo", cargoArgs, {
    cwd: HELPER_DIR,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}
if (buildResult.error) fail("cargo 不可用：" + buildResult.error.message);
if (buildResult.status !== 0) {
  fail(
    "cargo build 退出码 " + buildResult.status +
    (vcvars ? "" : "（未找到 vcvars64.bat：装 Visual Studio 2022 Build Tools 的 C++ 生成工具即可）"),
  );
}

const built = join(HELPER_DIR, "target", PROFILE, EXE_NAME);
if (!existsSync(built)) fail("构建成功但找不到产物：" + built);

mkdirSync(BIN_DIR, { recursive: true });
const target = join(BIN_DIR, EXE_NAME);
copyFileSync(built, target);
console.log("[build-desktop-helper] " + built + "\n  -> " + target);

// 握手自检：产物必须真的能起来并回答 ping，否则 sidecar 会在第一次工具调用时才发现。
// 这里不代替 M1 的握手验收，只是把「exe 起来了但 stdio 协议坏了」这类问题挡在构建期。
if (!DEBUG) {
  const handshake = spawnSync(target, [], {
    input: '{"id":1,"method":"ping","params":{}}\n',
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  const first = (handshake.stdout || "").split("\n").find((line) => line.trim().length > 0);
  if (!first) {
    fail(
      "握手自检失败：exe 没有回答 ping。stdout=" + JSON.stringify(handshake.stdout || "") +
      " stderr=" + JSON.stringify(handshake.stderr || ""),
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(first);
  } catch {
    fail("握手自检失败：ping 响应不是合法 JSON：" + first);
  }
  const value = parsed.value ?? parsed.result ?? {};
  for (const key of ["version", "platform", "features"]) {
    if (value[key] === undefined) fail("握手响应缺字段 " + key + "：" + first);
  }
  if (value.platform !== "win32") fail("握手 platform 不是 win32：" + first);
  console.log(
    "[build-desktop-helper] 握手 OK version=" + value.version +
    " platform=" + value.platform +
    " features=" + JSON.stringify(value.features),
  );
}

if (PRINT_SHA) {
  const sha = createHash("sha256").update(readFileSync(target)).digest("hex");
  console.log("[build-desktop-helper] sha256 " + sha + "  " + target);
  console.log("[build-desktop-helper] （度量用，不作门禁：Rust 生态 bit-reproducibility 未验证）");
}
