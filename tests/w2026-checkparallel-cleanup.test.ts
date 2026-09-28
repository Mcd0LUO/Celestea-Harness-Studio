// @vitest-environment node
/**
 * W2026 · `scripts/check-parallel.mjs` 的**中断收尾门禁**：被 SIGTERM 中断时不许留下孤儿 gate。
 *
 * 为什么需要它（修复前实测，本机）：
 *   `node scripts/check-parallel.mjs` 起门禁用的是 `spawn(cmd, { shell: true })`，
 *   而 `shell: true` 会插一层 `/bin/sh -c`。SIGTERM 之后 sh 死了，**它下面的
 *   pnpm / tsc / vitest 被 init 收养（ppid=1）后继续跑完**：
 *     · 修复前：TERM 后仍有 `/bin/sh -c 'pnpm --dir apps/web run build && …'`、
 *       `node …/typescript/bin/tsc`、`node …/eslint/bin/eslint.js` 活着；
 *     · 修复后：同一条命令后 0 个残留。
 *   孤儿是有限序列、跑完即退 —— 但在这之前重跑 `pnpm check` 就是**两批 gate 并发**，
 *   而本仓有已知的并发敏感测试（bwrap 的 /proc/self/fd、lifecycle 的 fd 计数）⇒ **假红**
 *   （「全量 check 红、单独跑绿」的一个来源）。
 *
 * 三层断言（都不需要跑真门禁：用 `--gates` 注入最小假门禁，全文件秒级）：
 *   ① **中断无孤儿**：假门禁在跑 → SIGTERM → 假门禁（及它下面的一切）必须消失；
 *      退出码必须是**中断码 2**，且进程是**自己退出**的（signal 为 null，不是被信号打死）；
 *   ② **正常路径未被改动**：退出码仍是 0/1、汇总格式逐字不变，且跑完后信号处理器已摘掉
 *      （此时 SIGTERM 必须按**默认语义**打死进程 —— 证明没有给正常路径留副作用）；
 *   ③ **防真空**：发信号前必须证明「假门禁确实是 runner 的后代且真的在跑」，
 *      否则「没有孤儿」会因为「压根没起来」而假绿。
 *
 * ★ 这三条正是变异负控制的靶子（报告里贴了红→绿原文）：
 *   ① 删掉信号处理 ⇒ ①红；② 信号处理只设标志不杀子进程 ⇒ ①红；
 *   ③ 中断退出码改成 1（= 门禁失败）⇒ ①的退出码断言红。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { posixProcessGroups } from "./lib/platform-gates.js";

const ROOT = process.cwd();
const RUNNER = join(ROOT, "scripts", "check-parallel.mjs");
/** 与 scripts/lib/gate-cleanup.mjs 的常量对齐（门禁要钉住的是**契约**，不是实现）。 */
const EXIT_OK = 0;
const EXIT_GATE_FAILURE = 1;
const EXIT_INTERRUPTED = 2;
const EXIT_CONFIG_ERROR = 3;
const POLL_MS = 50;

/** 本轮用过的临时目录 / 子进程 / 进程标记（收尾统一清，门禁自己不许成为泄漏源）。 */
const tmpDirs: string[] = [];
const children: ReturnType<typeof spawn>[] = [];
const markers: string[] = [];

function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** 每个假门禁一个**全局唯一**标记，写在命令行里 ⇒ 用 ps 就能精确定位它的整棵子树。 */
function newMarker(name: string): string {
  const marker = `w2026-gate-${name}-${process.pid}-${Date.now()}-${markers.length}`;
  markers.push(marker);
  return marker;
}

/** 写一个「活到被杀」的假门禁：起来时落一个 started 文件（前提可观察），然后挂住。 */
function writeGateScript(dir: string, name: string, marker: string): string {
  const script = join(dir, `gate-${name}.mjs`);
  writeFileSync(script, [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(join(dir, "started-" + name))}, "started");`,
    `process.title = ${JSON.stringify(marker)};`,
    "setTimeout(() => {}, 3600000);",
  ].join("\n"));
  return script;
}

/** 假门禁的命令行：`node <script> <marker>`（marker 出现在 ps 的 args 里）。 */
function gateCmd(script: string, marker: string): string {
  return `node ${script} ${marker}`;
}

interface GateSpec { name: string; cmd: string }

/** 写 --gates 用的清单文件，返回路径。 */
function writeGatesFile(dir: string, gates: GateSpec[]): string {
  const file = join(dir, "gates.json");
  writeFileSync(file, JSON.stringify({ gates }, null, 2));
  return file;
}

/** 轮询直到谓词为真；超时抛错（**不 sleep 赌时长**，见 check-sleep-debt.mjs 的 W9225）。 */
async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error("waitUntil 超时：" + label);
}

interface PsRow { pid: number; ppid: number; args: string }

/** 当前进程表。`ps` 不可用的机器返回 []（那时整个套件本就 skip）。 */
function psRows(): PsRow[] {
  const r = spawnSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" });
  if (r.status !== 0) return [];
  return r.stdout.split("\n").filter((l) => l.trim() !== "").map((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    return m === null ? null : { pid: Number(m[1]), ppid: Number(m[2]), args: m[3] ?? "" };
  }).filter((row): row is PsRow => row !== null);
}

/** 命令行里含某个标记的进程（**整棵子树**都会含它 —— 这是「孤儿」的判据）。 */
function processesWith(marker: string): PsRow[] {
  return psRows().filter((row) => row.args.includes(marker));
}

/** pid 是否（直接或间接）挂在 ancestor 下面。防真空用：证明假门禁真的是 runner 的后代。 */
function isDescendantOf(pid: number, ancestor: number, rows: PsRow[] = psRows()): boolean {
  const parent = new Map(rows.map((row) => [row.pid, row.ppid]));
  let cursor = pid;
  for (let hops = 0; hops < 32; hops += 1) {
    const up = parent.get(cursor);
    if (up === undefined || up <= 1) return false;
    if (up === ancestor) return true;
    cursor = up;
  }
  return false;
}

interface Runner {
  child: ReturnType<typeof spawn>;
  /** 目前收集到的 stdout。 */
  out: () => string;
  /** 目前收集到的 stderr。 */
  err: () => string;
  exit: Promise<{ code: number | null; signal: string | null }>;
}

/** 起一个 check-parallel（用假门禁清单）。 */
function startRunner(args: string[]): Runner {
  const child = spawn(process.execPath, [RUNNER, ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (b) => { stdout += String(b); });
  child.stderr.on("data", (b) => { stderr += String(b); });
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, out: () => stdout, err: () => stderr, exit };
}

/** 一个「1 个假门禁」的场景：返回目录、标记与就绪判据。 */
function scenario(name: string): { dir: string; marker: string; started: string; gatesFile: string } {
  const dir = makeTmp("w2026-" + name + "-");
  const marker = newMarker(name);
  const script = writeGateScript(dir, name, marker);
  const started = join(dir, "started-" + name);
  const gatesFile = writeGatesFile(dir, [{ name, cmd: gateCmd(script, marker) }]);
  return { dir, marker, started, gatesFile };
}

afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  // 门禁自己也要干净：任何还带着本轮标记的进程一律杀掉。
  for (const marker of markers.splice(0)) {
    for (const row of processesWith(marker)) {
      try { process.kill(row.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe.skipIf(!posixProcessGroups)("W2026 · check-parallel 中断不留孤儿 gate", () => {
  it("★ SIGTERM 后：假门禁整棵子树消失，且以中断码 2 自己退出（不是被信号打死）", async () => {
    const s = scenario("term");
    const runner = startRunner(["--jobs", "2", "--gates", s.gatesFile]);
    // 前提：假门禁**真的起来了**（否则「没有孤儿」会因为「压根没起来」而假绿）。
    await waitUntil("假门禁起来", () => existsSync(s.started));
    const before = processesWith(s.marker);
    expect(before.length, "前提：假门禁必须真的在跑").toBeGreaterThan(0);
    expect(
      isDescendantOf(before[0]!.pid, runner.child.pid ?? -1),
      "前提：假门禁必须是 runner 的后代（否则测的不是这条路径）",
    ).toBe(true);

    runner.child.kill("SIGTERM");
    const result = await runner.exit;

    expect(processesWith(s.marker), "★ SIGTERM 后不得留下任何 gate 子进程（含 sh 中间层 / pnpm / vitest）").toEqual([]);
    expect(result.signal, "必须自己收尾后退出，而不是被 SIGTERM 打死").toBeNull();
    expect(result.code, "★ 中断退出码必须是 2（与门禁失败 1 区分开）").toBe(EXIT_INTERRUPTED);
    // 这一条是 W2026 修到一半才发现的**第二种假红**：被我们自己 SIGTERM 掉的门禁以非零
    // close 回来，runAll() 随之结束 ⇒ 打出「✗ 门禁失败：check:web（exit 143）」+ 一行
    // 「门禁汇总：6/7 通过」。于是一次 Ctrl-C 在日志里长得跟**真的门禁红了**一模一样 ——
    // 退出码对了也没用，人看的是这几行。中断必须**不打印汇总、不打印失败块**。
    expect(runner.out(), "★ 中断不得被印成门禁失败（那正是要修的假红形态）").not.toContain("✗ 门禁失败：");
    expect(runner.out(), "★ 中断时不得打印门禁汇总（否则看起来就是「门禁红了」）").not.toContain("门禁汇总：");
    expect(runner.err(), "中断必须留下可读的收尾说明").toContain("正在回收");
  }, 30000);

  it("SIGINT（Ctrl-C）同样收干净，退出码同样是中断码 2", async () => {
    const s = scenario("int");
    const runner = startRunner(["--jobs", "2", "--gates", s.gatesFile]);
    await waitUntil("假门禁起来", () => existsSync(s.started));
    expect(processesWith(s.marker).length, "前提：假门禁必须真的在跑").toBeGreaterThan(0);

    runner.child.kill("SIGINT");
    const result = await runner.exit;

    expect(processesWith(s.marker), "★ Ctrl-C 后同样不得留下 gate 子进程").toEqual([]);
    expect(result.signal, "必须自己收尾后退出").toBeNull();
    expect(result.code, "SIGINT 与 SIGTERM 用同一个中断码（判定只看一个数）").toBe(EXIT_INTERRUPTED);
  }, 30000);

  it("多个 gate 并发时**不漏也不重**：JOBS 个在跑的 gate 全部被收掉", async () => {
    const dir = makeTmp("w2026-many-");
    const specs: GateSpec[] = [];
    const startedFiles: string[] = [];
    const localMarkers: string[] = [];
    for (const name of ["g1", "g2", "g3", "g4"]) {
      const marker = newMarker(name);
      localMarkers.push(marker);
      const script = writeGateScript(dir, name, marker);
      startedFiles.push(join(dir, "started-" + name));
      specs.push({ name, cmd: gateCmd(script, marker) });
    }
    const gatesFile = writeGatesFile(dir, specs);
    const runner = startRunner(["--jobs", "4", "--gates", gatesFile]);
    await waitUntil("4 个假门禁全部起来", () => startedFiles.every((f) => existsSync(f)));
    for (const marker of localMarkers) {
      expect(processesWith(marker).length, "前提：每个 gate 都必须在跑").toBeGreaterThan(0);
    }

    runner.child.kill("SIGTERM");
    const result = await runner.exit;

    for (const marker of localMarkers) {
      expect(processesWith(marker), "★ 并发 4 个 gate 时也不得漏掉任何一个").toEqual([]);
    }
    expect(result.code, "中断码").toBe(EXIT_INTERRUPTED);
  }, 30000);
});

describe.skipIf(!posixProcessGroups)("W2026 · 正常路径（不中断）行为未变", () => {
  it("全绿 ⇒ 退出码 0，汇总格式与改动前逐字一致", async () => {
    const dir = makeTmp("w2026-ok-");
    const gatesFile = writeGatesFile(dir, [
      { name: "alpha", cmd: "node -e \"console.log('alpha ok')\"" },
      { name: "beta", cmd: "node -e \"console.log('beta ok')\"" },
    ]);
    const runner = startRunner(["--jobs", "2", "--gates", gatesFile]);
    const result = await runner.exit;

    expect(result.code, "全部通过 ⇒ 0（既有语义）").toBe(EXIT_OK);
    expect(result.signal, "正常路径不得被信号打死").toBeNull();
    expect(runner.out(), "汇总格式未变").toContain("门禁汇总：2/2 通过，最长一段 ");
    // 逐字对齐改动前的格式：`  ✓ alpha        0.1s`（padEnd(12) 补齐 + 一个空格 + 秒）。
    expect(runner.out(), "每道门禁的耗时行未变").toMatch(/^ {2}✓ alpha +\d+\.\d+s$/m);
  }, 30000);

  it("有门禁失败 ⇒ 退出码仍是 1（**不是**中断码），并打印该门禁自己的输出尾部", async () => {
    const dir = makeTmp("w2026-fail-");
    const gatesFile = writeGatesFile(dir, [
      { name: "good", cmd: "node -e \"console.log('good ok')\"" },
      { name: "bad", cmd: "node -e \"console.log('BOOM: 这是失败门禁自己的输出'); process.exit(7)\"" },
    ]);
    const runner = startRunner(["--jobs", "2", "--gates", gatesFile]);
    const result = await runner.exit;

    expect(result.code, "★ 门禁失败必须仍是 1 —— 中断（2）与失败（1）必须可区分").toBe(EXIT_GATE_FAILURE);
    expect(runner.out(), "失败块格式未变").toContain("✗ 门禁失败：bad（exit 7）");
    expect(runner.out(), "必须打印**该门禁自己的**输出").toContain("BOOM: 这是失败门禁自己的输出");
    expect(runner.out(), "汇总未变").toContain("门禁汇总：1/2 通过");
  }, 30000);

  it("★ 正常路径零副作用：所有门禁跑完后，信号处理器必须已摘掉（SIGTERM 回到默认语义）", async () => {
    const dir = makeTmp("w2026-nosig-");
    const gatesFile = writeGatesFile(dir, [{ name: "quick", cmd: "node -e \"console.log('quick ok')\"" }]);
    // --shutdown-ms 给测试一个「门禁已跑完、进程还活着」的窗口（只有显式传才生效）。
    const runner = startRunner(["--jobs", "1", "--gates", gatesFile, "--shutdown-ms", "8000"]);
    await waitUntil("汇总已打印（门禁都跑完了）", () => runner.out().includes("门禁汇总：1/1 通过"));

    runner.child.kill("SIGTERM");
    const result = await runner.exit;

    expect(
      result.signal,
      "★ 跑完之后不得还占着信号：此时 SIGTERM 必须按默认语义打死进程（否则正常路径被改了）",
    ).toBe("SIGTERM");
    expect(result.code, "被信号打死时 code 为 null（POSIX 语义）").toBeNull();
  }, 30000);

  it("--gates 指向读不了的清单 ⇒ 退出码 3（配置错误），绝不静默回退到内置全套门禁", async () => {
    const runner = startRunner(["--gates", join(tmpdir(), "w2026-does-not-exist.json")]);
    const result = await runner.exit;

    expect(result.code, "配置错误码 3（与门禁失败 1、中断 2 区分开）").toBe(EXIT_CONFIG_ERROR);
    expect(runner.err(), "必须说清是哪个文件读不了").toContain("读不了 --gates");
    expect(runner.out(), "不得偷偷跑内置门禁").not.toContain("门禁汇总：");
  }, 30000);
});
