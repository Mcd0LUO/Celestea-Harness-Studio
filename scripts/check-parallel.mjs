#!/usr/bin/env node
/**
 * W9222 · 并行跑 `pnpm check` 的各道门禁（本地提速），CI 不受影响。
 *
 * 为什么需要：`pnpm check` 原本是 `a && b && c && …` **串行**，本机实测 46 s；
 * 而各门禁之间**没有依赖**（除 check:web 内部的 build→check）。实测各段：
 *   test 20 s · lint 9.3 s · typecheck 6.4 s · web build 3.1 s · web tsc 2.4 s
 *   · web 8 个子门禁 2.1 s · lint:arch 2.1 s · check:tmpdir 0.6 s
 * 串行 = 把它们加起来；并行 = 取最慢那一段。
 *
 * 为什么是安全的（两条都实测过）：
 *   ① 各门禁**不写同一份产物**。唯一写盘的是 check:web（apps/web/dist），
 *      而全仓没有任何测试读 dist —— 实测 `grep -rn 'webdist|apps/web/dist' tests/`
 *      只命中 3 处，全是**注释/源码字符串**，没有 readFileSync。
 *   ② 缓存不会掩盖错误（这是我采纳缓存的前提，已逐条变异验证）：
 *      · eslint --cache：改一个文件加一条 `no-unused-vars` ⇒ 暖缓存下**仍然报错**；
 *        改 eslint.config.js（MAX_LINES 450→1）⇒ 暖缓存下**仍然报 766 个错**。
 *      · tsc --incremental：改一个文件加一条类型错误 ⇒ 暖缓存下**仍然报 TS2322**。
 *
 * 缓存落在 node_modules/.cache/ 下（已在 .gitignore 的 node_modules/ 内），不进版本库。
 *
 * ----------------------------------------------------------------------------
 * W2026 · 中断时**不留孤儿 gate**（本文件唯一的语义改动，其余逐字未动）
 * ----------------------------------------------------------------------------
 * 缺陷（修复前实测）：本文件用 `spawn(cmd, { shell: true })` 起门禁，而 `shell: true`
 * 插入一层 `/bin/sh -c` —— **杀 sh 不杀它的子进程**。SIGTERM 之后 sh 死了，它下面的
 * pnpm / tsc / vitest 被 init 收养（ppid=1）后继续跑完。孤儿是有限序列、跑完即退，
 * 但在这之前重跑 `pnpm check` 就是**两批 gate 并发**，而本仓有并发敏感测试
 * （bwrap 的 /proc/self/fd、lifecycle 的 fd 计数）⇒ **假红**。
 *
 * 修法：门禁起来时登记进 scripts/lib/gate-cleanup.mjs 的收尾表，信号到达时**同步**
 * 给每个门禁的**进程组**发 SIGTERM（gate 以 detached 自成一组），宽限期后升级
 * SIGKILL，然后以 INTERRUPTED_EXIT_CODE(2) 自己退出。
 *
 * 退出码（★门禁的退出码会被 pnpm/CI 解读，三者必须互相可区分）：
 *   0 = 全部通过          1 = **有门禁失败**（既有语义，未改动）
 *   2 = **被中断**（SIGTERM/SIGINT）   3 = 用法/配置错误（--gates 读不了）
 * 为什么中断不用 cleanup.mjs 的 `128 + signum`(143/130)：见 gate-cleanup.mjs 的
 * INTERRUPTED_EXIT_CODE 注释（简言之：128+n 记的是「被信号打死」，而本修复的全部
 * 意义就是**不被打死**；且 Ctrl-C 不得被读成「门禁红了」=1）。
 *
 * 用法：node scripts/check-parallel.mjs [--jobs N] [--only a,b] [--gates <json>]
 *   --gates <json>  用一份门禁清单文件替换内置 GATES（**门禁测试用的 seam**：
 *                   让「中断后无孤儿」这条断言在几秒内跑完，而不是几分钟）。
 *                   文件形状：{ "gates": [ { "name": "…", "cmd": "…" } ] }
 * 失败时：打印该门禁的名字 + 它自己的输出尾部，退出码非零。
 */
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_ERROR_EXIT_CODE,
  GATE_FAILURE_EXIT_CODE,
  OK_EXIT_CODE,
  closeAllRegistered,
  setSignalHooks,
  spawnRegistered,
  uninstallSignalCleanup,
} from "./lib/gate-cleanup.mjs";

/**
 * 收到的中断信号（null = 没被中断）。
 *
 * ★ 它必须在**第一个门禁起来之前**就登记好：信号到达时 gate-cleanup 会**同步**
 * 回调 onSignal，这里立刻置位；此后主流程不再打印汇总、不再落门禁退出码 ——
 * 退出码与收尾完全交给信号处理器（INTERRUPTED_EXIT_CODE = 2）。
 * 少了这一步就会出现「中断被印成门禁失败」：我们自己 SIGTERM 掉的门禁以非零 close
 * 回来，runAll() 随之结束，于是打印出 `✗ 门禁失败：check:web（exit 143）`。
 */
let interruptedBy = null;
setSignalHooks({ onSignal: (signal) => { interruptedBy = signal; } });

const CACHE = join("node_modules", ".cache");
mkdirSync(join(CACHE, "tsc"), { recursive: true });
mkdirSync(join(CACHE, "eslint"), { recursive: true });

/** 每道门禁：name + 命令 + 说明。命令里的缓存路径都指向 node_modules/.cache。 */
const GATES = [
  {
    name: "typecheck",
    cmd: `pnpm exec tsc --noEmit -p tsconfig.json --incremental --tsBuildInfoFile ${join(CACHE, "tsc", "root.tsbuildinfo")}`,
  },
  {
    name: "lint",
    cmd: `pnpm exec eslint . --cache --cache-location ${join(CACHE, "eslint", ".eslintcache")}`,
  },
  {
    name: "lint:arch",
    cmd: "pnpm exec depcruise --config .dependency-cruiser.cjs packages apps/studio apps/cli scripts tests",
  },
  {
    name: "check:tmpdir",
    cmd: "node scripts/check-test-tmpdir.mjs",
  },
  {
    name: "check:sleep",
    cmd: "node scripts/check-sleep-debt.mjs",
  },
  {
    name: "test",
    cmd: "pnpm exec vitest run",
  },
  {
    name: "check:web",
    // 内部必须串行：build 先于 tsc / 8 个子门禁（check-version 读刚构建的 dist）。
    cmd:
      'pnpm --dir apps/web run build && pnpm --dir apps/web exec tsc --noEmit --incremental --tsBuildInfoFile ../../' +
      join(CACHE, "tsc", "web.tsbuildinfo") +
      ' && node apps/web/tools/check-ui-copy.mjs && node apps/web/tools/check-scope-hash.mjs && node apps/web/tools/check-sse-events.mjs && node apps/web/tools/check-fold-default.mjs && node apps/web/tools/check-grants-permanent.mjs && node apps/web/tools/check-module-size.mjs && node apps/web/tools/check-version.mjs && node scripts/run-with-env.mjs CELESTEA_BUNDLE_STRICT=1 -- node apps/web/tools/check-bundle-size.mjs',
  },
];

const argv = process.argv.slice(2);
const jobsArg = argv.indexOf("--jobs");
const onlyArg = argv.indexOf("--only");
const gatesArg = argv.indexOf("--gates");
const shutdownArg = argv.indexOf("--shutdown-ms");
const JOBS = jobsArg >= 0 ? Number(argv[jobsArg + 1]) : 6;
const ONLY = onlyArg >= 0 ? new Set(String(argv[onlyArg + 1]).split(",")) : null;
/**
 * 测试 seam：打印完汇总后多活这么久，给测试一个「门禁全绿但还活着」的窗口去发信号。
 * 只在显式传 --shutdown-ms 时生效（正常用法**不传** ⇒ 正常路径逐字未变）。
 */
const SHUTDOWN_MS = shutdownArg >= 0 ? Number(argv[shutdownArg + 1]) : 0;

/**
 * 读 --gates 指定的门禁清单（测试 seam）。读不了就**以配置错误码退出**，
 * 绝不静默回退到内置 GATES —— 那会让「门禁测试其实跑了全套」这种假绿无法察觉。
 */
function loadGates() {
  if (gatesArg < 0) return { gates: GATES };
  const file = argv[gatesArg + 1];
  try {
    const parsed = JSON.parse(readFileSync(String(file), "utf8"));
    const gates = parsed && parsed.gates;
    if (!Array.isArray(gates) || gates.length === 0) throw new Error("gates 必须是非空数组");
    for (const g of gates) {
      if (typeof g?.name !== "string" || typeof g?.cmd !== "string") throw new Error("每项必须有 name 与 cmd 字符串");
    }
    return { gates };
  } catch (error) {
    process.stderr.write(`✗ 读不了 --gates ${file}：${error instanceof Error ? error.message : String(error)}\n`);
    return { error: CONFIG_ERROR_EXIT_CODE };
  }
}

const loaded = loadGates();
if (loaded.error !== undefined) process.exit(loaded.error);
const allGates = loaded.gates;
const selected = ONLY === null ? allGates : allGates.filter((g) => ONLY.has(g.name));

/**
 * 跑一个门禁。★ W2026：用 spawnRegistered 起来（登记进收尾表 + 自成进程组），
 * 门禁自己结束（正常或失败）时**注销** —— 于是信号到达时登记表里恰好是还活着的那些。
 */
function run(gate) {
  return new Promise((resolve) => {
    const started = Date.now();
    const { child, unregister } = spawnRegistered(gate.cmd);
    let out = "";
    child.stdout.on("data", (b) => { out += String(b); });
    child.stderr.on("data", (b) => { out += String(b); });
    child.on("close", (code) => { unregister(); resolve({ ...gate, code, out, ms: Date.now() - started }); });
  });
}

/** 跑完选中的门禁（JOBS 个并发）。 */
async function runAll() {
  const results = [];
  const queue = [...selected];
  let running = 0;
  await new Promise((resolve) => {
    const pump = () => {
      while (running < JOBS && queue.length > 0) {
        const gate = queue.shift();
        running += 1;
        process.stdout.write(`▶ ${gate.name}\n`);
        run(gate).then((r) => {
          running -= 1;
          results.push(r);
          process.stdout.write(`  ${r.code === 0 ? "✓" : "✗"} ${r.name} (${(r.ms / 1000).toFixed(1)}s)\n`);
          if (queue.length === 0 && running === 0) resolve();
          else pump();
        });
      }
    };
    pump();
  });
  return results;
}

/** 打印汇总（失败门禁的**自己的**输出尾部 + 每道门禁的耗时）。与改动前逐字一致。 */
function printSummary(results, failed, wall) {
  for (const f of failed) {
    process.stdout.write(`\n${'='.repeat(70)}\n✗ 门禁失败：${f.name}（exit ${f.code}）\n${'='.repeat(70)}\n`);
    const lines = f.out.split(/\r?\n/).filter((l) => l.trim() !== "");
    process.stdout.write(lines.slice(-60).join("\n") + "\n");
  }
  process.stdout.write(`\n门禁汇总：${results.length - failed.length}/${results.length} 通过，最长一段 ${(wall / 1000).toFixed(1)}s\n`);
  for (const r of [...results].sort((a, b) => b.ms - a.ms)) {
    process.stdout.write(`  ${r.code === 0 ? "✓" : "✗"} ${r.name.padEnd(12)} ${(r.ms / 1000).toFixed(1)}s\n`);
  }
}

const results = await runAll();

/**
 * ★ 中断路径优先于一切：一旦收到信号就**不再往下走** —— 不打印汇总、不落 0/1 退出码。
 * 否则被我们自己 SIGTERM 掉的门禁会以非零 close 回来，把一次 Ctrl-C 印成
 * 「✗ 门禁失败：check:web（exit 143）」，正好复现「中断被误读成门禁红了」。
 * 这里的 await 是**有界**的：handleSignal 的 FORCE_EXIT_MS 到点必定 process.exit(2)。
 */
if (interruptedBy !== null) await new Promise(() => {});

const failed = results.filter((r) => r.code !== 0);
const wall = Math.max(...results.map((r) => r.ms));

// 失败时把**该门禁自己的**输出打出来：并行会让输出交错，所以按门禁分开缓存再打印。
printSummary(results, failed, wall);

// ★ W2026：所有门禁都已结束 ⇒ 登记表空、信号处理器已随最后一次注销摘掉。
// 这里再显式收一次尾（防「某个门禁 close 前我们已到这里」的边界），然后才落退出码。
await closeAllRegistered();
uninstallSignalCleanup();
// 测试 seam：只在 --shutdown-ms 时生效，正常用法立刻走完（与改动前同形）。
if (SHUTDOWN_MS > 0) await new Promise((r) => setTimeout(r, SHUTDOWN_MS));

// ★ W2026：用 exitCode 而不是 process.exit() —— 后者会**截断 stdout 管道**里还没冲出去的
// 数据（本脚本的输出动辄数千行）。改为自然退出，退出码语义完全不变（0 / 1）。
process.exitCode = failed.length === 0 ? OK_EXIT_CODE : GATE_FAILURE_EXIT_CODE;
