// @vitest-environment node
/**
 * W2021 · scripts/perf 的**进程收尾门禁**：被信号杀死时不许留下 Chrome 与监听端口。
 *
 * 为什么需要它（修复前实测）：`timeout 115 node scripts/perf/run.mjs q1` 之后，
 *   · backend 端口随进程消失（OS 回收监听套接字），**但**
 *   · Chrome 是 spawn 出来的独立进程，被 init 收养后继续活着，继续占着 CDP 端口与
 *     `$TEMP/w9111-chrome-*` profile 目录。
 * 于是下一次测量撞 `listen EADDRINUSE` / CDP 连不上，报错还指向 node:net，看不出根因。
 *
 * 三层断言（从便宜到贵，前两层**不需要 Chrome**，任何机器都能跑）：
 *   ① 信号路径**真的会跑收尾**，且等异步部分跑完再退出、退出码 = 128+signum（143 / 130）；
 *   ② `close()` 幂等：重复调用不抛错，且监听端口可以被**立刻重新 bind**；
 *   ③ 端到端：起**真 app**（真 backend + 真 Chrome）→ 发 SIGTERM → 端口可再 bind、
 *      没有孤儿 Chrome、profile 目录已删、进程自己退出（不是被信号打死）。没装 Chrome
 *      的机器（CI）**可见地跳过**第三层，而不是假装通过。
 *
 * ★ 第三层刻意**不依赖 Vite**：探针 case（scripts/perf/cases/w2021-signal-stub.mjs）
 *   只 boot backend + Chrome，不导航页面 ⇒ 收尾语义可独立验证（Vite 是测量的前置，不是
 *   收尾的一部分）。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { posixProcessGroups } from "./lib/platform-gates.js";

const ROOT = process.cwd();
const PERF = join(ROOT, "scripts", "perf");
const RUN = join(PERF, "run.mjs");
const CLEANUP = join(PERF, "lib", "cleanup.mjs");

interface ChromeMod {
  findChrome(): string | null;
}
const chromeMod = (await import(/* @vite-ignore */ pathToFileURL(join(PERF, "lib", "chrome.mjs")).href)) as ChromeMod;
const CHROME = chromeMod.findChrome();

/** `scripts/perf/lib/cleanup.mjs` 的对外形状（④ 直接跑真模块，不复刻它的实现）。 */
interface CleanupMod {
  registerCleanup(fn: () => unknown): () => void;
  closeAllRegistered(): Promise<void>;
  drainCleanup(): unknown[];
  activeCleanupCount(): number;
  isSignalCleanupInstalled(): boolean;
}
const cleanupMod = (await import(/* @vite-ignore */ pathToFileURL(CLEANUP).href)) as CleanupMod;

/** 本轮用过的临时目录（收尾统一删，绝不往 /tmp 累积）。 */
const tmpDirs: string[] = [];
/** 本轮起过的子进程（用例失败时也要杀干净，否则门禁自己就成了泄漏源）。 */
const children: ReturnType<typeof spawn>[] = [];

function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await cleanupMod.closeAllRegistered();
  for (const child of children.splice(0)) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** 轮询直到谓词为真；超时抛错（**不 sleep 赌时长**，见 check-sleep-debt.mjs 的 W9225）。 */
async function waitUntil(label: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("waitUntil 超时：" + label);
}

/** 监听某个端口的进程（`ss` 一行一条；空数组 = 没有人在听）。 */
function listenersOn(port: number): string[] {
  const r = spawnSync("ss", ["-ltnH", "sport = :" + port], { encoding: "utf8" });
  if (r.status !== 0) return [];
  return r.stdout.split("\n").filter((l) => l.trim() !== "");
}

/** 现在能不能在这个端口上 listen（**不泄漏**的直接判据）。 */
function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** 命令行里匹配 pattern 的进程（pid + 命令行）。`ps` 不可用（无 POSIX 工具的机器）时返回 []。 */
function processesMatching(pattern: string): string[] {
  const r = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  if (r.status !== 0) return [];
  return r.stdout.split("\n").filter((l) => l.includes(pattern));
}

/** 找一个当前空闲的端口（bind 0 拿系统分配，再让出来给被测进程用）。 */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

describe("W2021 ① · 信号路径真的收尾（不需要 Chrome）", () => {
  it("SIGTERM 下同步+异步收尾都跑完，进程以 143 自己退出（不是被信号打死）", async () => {
    const dir = makeTmp("w2021-drain-");
    const syncMark = join(dir, "sync.txt");
    const asyncMark = join(dir, "async.txt");
    // 收尾函数刻意做成「同步写一个 + 异步写一个」：正是 app.close() 的形状
    // （同步 kill/close + 异步等 profile 删除）。信号处理器不 await 的话，第二个文件不会出现。
    const script = join(dir, "probe.mjs");
    writeFileSync(script, [
      "import { writeFileSync } from 'node:fs';",
      "import { registerCleanup } from " + JSON.stringify(pathToFileURL(CLEANUP).href) + ";",
      "registerCleanup(() => {",
      "  writeFileSync(" + JSON.stringify(syncMark) + ", 'sync');",
      "  return new Promise((r) => setTimeout(() => { writeFileSync(" + JSON.stringify(asyncMark) + ", 'async'); r(); }, 150));",
      "});",
      "setInterval(() => {}, 1000);",
      "console.log('READY');",
    ].join("\n"));

    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let stdout = "";
    child.stdout.on("data", (b) => { stdout += String(b); });
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    // READY 打在 registerCleanup() **之后** ⇒ 看到它就保证收尾已登记（不靠 sleep 赌）。
    await waitUntil("探针 READY", () => stdout.includes("READY"));

    child.kill("SIGTERM");
    const result = await exit;

    expect(existsSync(syncMark), "同步收尾必须跑（信号处理器被调到了）").toBe(true);
    expect(existsSync(asyncMark), "异步收尾必须**跑完**（处理器不能只启动不等待）").toBe(true);
    expect(result.signal, "必须自己退出，而不是被 SIGTERM 打死").toBeNull();
    expect(result.code, "退出码 = 128 + SIGTERM(15) = 143").toBe(143);
  });
});

describe("W2021 ② · close() 幂等 + 端口立刻可再 bind（不需要 Chrome）", () => {
  it("重复 close() 不抛错，且监听端口同步释放", async () => {
    const port = await pickFreePort();
    const dir = makeTmp("w2021-idem-");
    const script = join(dir, "probe.mjs");
    writeFileSync(script, [
      "import { startBackend } from " + JSON.stringify(pathToFileURL(join(PERF, "lib", "backend.mjs")).href) + ";",
      "const b = await startBackend({ port: " + port + ", webRoot: " + JSON.stringify(join(ROOT, "apps", "web")) + ", viteOrigin: 'http://127.0.0.1:1' });",
      "console.log('LISTENING');",
      "setInterval(() => {}, 1000);",
      "process.on('SIGUSR2', () => {",
      "  try {",
      "    const p1 = b.close();",
      "    const p2 = b.close();",
      "    // 幂等的判据：第二次拿到的是**同一次收尾**，而不是又起一次（又起一次就可能双关/双删/抛错）",
      "    if (p1 !== p2) { console.log('NOT_IDEMPOTENT'); process.exit(4); }",
      "    Promise.all([p1, p2]).then(() => { console.log('CLOSED_TWICE_OK'); process.exit(0); },",
      "      (e) => { console.log('CLOSE_THREW ' + e); process.exit(3); });",
      "  } catch (e) { console.log('CLOSE_THREW_SYNC ' + e); process.exit(3); }",
      "});",
    ].join("\n"));

    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let stdout = "";
    child.stdout.on("data", (b) => { stdout += String(b); });
    const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));

    await waitUntil("backend 起来", () => listenersOn(port).length > 0);
    child.kill("SIGUSR2");
    const code = await exit;

    expect(stdout, "第二次 close() 必须返回同一次收尾且不得抛错（不得 NOT_IDEMPOTENT / CLOSE_THREW）").toContain("CLOSED_TWICE_OK");
    expect(code, "退出码 0 = 两次 close 都正常（4 = 非幂等，3 = 抛错）").toBe(0);
    expect(listenersOn(port), "close() 之后不得还有人在监听").toEqual([]);
    expect(await canBind(port), "close() 之后必须能立刻重新 bind 同一端口").toBe(true);
  });
});

describe("W2021 ④ · 登记表语义：不漏、不重复关、正常路径零副作用（不需要 Chrome）", () => {
  it("register 几个就关几个，各一次；注销后不再被关", async () => {
    const closed: string[] = [];
    const off1 = cleanupMod.registerCleanup(() => { closed.push("a"); });
    const off2 = cleanupMod.registerCleanup(() => { closed.push("b"); });
    expect(cleanupMod.activeCleanupCount()).toBe(2);
    await cleanupMod.closeAllRegistered();
    expect(closed.slice().sort(), "登记了 2 个就必须关 2 个，且各一次（不漏、不重复）").toEqual(["a", "b"]);
    expect(cleanupMod.activeCleanupCount(), "关完必须清空（信号到达时表里只剩活着的实例）").toBe(0);
    off1(); off2(); // 幂等注销不抛错
    await cleanupMod.closeAllRegistered();
    expect(closed.length, "已关过的实例不得被再关一次").toBe(2);
  });

  it("★ 正常路径零副作用：没有活实例时**不安装**信号处理器（不改变测量语义）", () => {
    expect(cleanupMod.activeCleanupCount(), "前置：本用例开始时登记表必须为空").toBe(0);
    expect(cleanupMod.isSignalCleanupInstalled(), "没有活实例时不得占用信号").toBe(false);
    const off = cleanupMod.registerCleanup(() => {});
    expect(cleanupMod.isSignalCleanupInstalled(), "有活实例时才安装").toBe(true);
    off();
    expect(cleanupMod.isSignalCleanupInstalled(), "最后一个实例注销后必须摘掉").toBe(false);
  });
});

describe.skipIf(CHROME === null || !posixProcessGroups)("W2021 ③ · 端到端：真 app + 真 Chrome，SIGTERM 后不留孤儿", () => {
  it("kill 之后：端口可再 bind / 没有残留 Chrome / profile 已删 / 退出码 143", async () => {
    const backend = await pickFreePort();
    let cdp = await pickFreePort();
    while (cdp === backend) cdp = await pickFreePort();
    const dir = makeTmp("w2021-e2e-");
    const readyFile = join(dir, "ready.json");

    const child = spawn(process.execPath, [RUN, "w2021-signal-stub"], {
      cwd: ROOT,
      env: {
        ...process.env,
        W9111_PORT: String(backend),
        W9111_CDP_PORT: String(cdp),
        W2021_READY_FILE: readyFile,
        W2021_WAIT_MS: "120000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (b) => { stderr += String(b); });
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });

    try {
      await waitUntil("探针就绪（backend + Chrome 都起来了）", () => existsSync(readyFile), 60000);
    } catch (error) {
      throw new Error(String(error) + "\n子进程 stderr：\n" + stderr.slice(-1500));
    }
    const ready = JSON.parse(readFileSync(readyFile, "utf8")) as { profileDir: string };
    expect(listenersOn(backend).length, "前置：backend 必须在监听").toBeGreaterThan(0);
    expect(processesMatching(ready.profileDir).length, "前置：Chrome 必须真的起来了").toBeGreaterThan(0);

    child.kill("SIGTERM");
    const result = await exit;

    expect(result.signal, "必须自己收尾后退出，而不是被 SIGTERM 打死").toBeNull();
    expect(result.code, "退出码 = 128 + SIGTERM(15) = 143").toBe(143);
    expect(await canBind(backend), "★ backend 端口必须可以被立刻重新 bind（不泄漏）").toBe(true);
    expect(listenersOn(backend), "★ 不得还有人在监听 backend 端口").toEqual([]);
    expect(await canBind(cdp), "★ CDP 端口必须可以被立刻重新 bind（Chrome 真的死了）").toBe(true);
    expect(processesMatching(ready.profileDir), "★ 不得留下任何 Chrome 进程").toEqual([]);
    expect(existsSync(ready.profileDir), "profile 目录必须被删掉").toBe(false);
  }, 90000);
});
