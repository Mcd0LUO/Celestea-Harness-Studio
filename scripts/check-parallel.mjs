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
 * 用法：node scripts/check-parallel.mjs [--jobs N] [--only a,b]
 * 失败时：打印该门禁的名字 + 它自己的输出尾部，退出码非零。
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

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
const JOBS = jobsArg >= 0 ? Number(argv[jobsArg + 1]) : 6;
const ONLY = onlyArg >= 0 ? new Set(String(argv[onlyArg + 1]).split(",")) : null;
const selected = ONLY === null ? GATES : GATES.filter((g) => ONLY.has(g.name));

function run(gate) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(gate.cmd, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b) => { out += String(b); });
    child.stderr.on("data", (b) => { out += String(b); });
    child.on("close", (code) => resolve({ ...gate, code, out, ms: Date.now() - started }));
  });
}

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

const failed = results.filter((r) => r.code !== 0);
const wall = Math.max(...results.map((r) => r.ms));

// 失败时把**该门禁自己的**输出打出来：并行会让输出交错，所以按门禁分开缓存再打印。
for (const f of failed) {
  process.stdout.write(`\n${'='.repeat(70)}\n✗ 门禁失败：${f.name}（exit ${f.code}）\n${'='.repeat(70)}\n`);
  const lines = f.out.split(/\r?\n/).filter((l) => l.trim() !== "");
  process.stdout.write(lines.slice(-60).join("\n") + "\n");
}

process.stdout.write(`\n门禁汇总：${results.length - failed.length}/${results.length} 通过，最长一段 ${(wall / 1000).toFixed(1)}s\n`);
for (const r of [...results].sort((a, b) => b.ms - a.ms)) {
  process.stdout.write(`  ${r.code === 0 ? "✓" : "✗"} ${r.name.padEnd(12)} ${(r.ms / 1000).toFixed(1)}s\n`);
}
process.exit(failed.length === 0 ? 0 : 1);