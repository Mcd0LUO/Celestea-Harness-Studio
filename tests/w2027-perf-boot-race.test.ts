// @vitest-environment node
/**
 * W2027 · `scripts/perf` 的**启动窗口**门禁：Chrome 一诞生就必须在收尾表里。
 *
 * 缺陷（W2021 修完之后仍然存在的那一半）：W2021 让「boot **完成之后**收到信号」不再留
 * 孤儿 —— 登记发生在 `launchChrome()` **返回之后**（app.mjs:85）。可 Chrome 进程在
 * `launchChrome` 内部 `spawn()` 的那一刻就存在了，而 `launchChrome` 返回前还要轮询
 * `/json/version`（每 150ms 一次，上限 25s）并跑若干 CDP 命令 —— 这【数百 ms ~ 数秒】里
 * 收到 SIGTERM，Node 直接退出，登记表里没有它，Chrome 被 init 收养。
 *
 * ★ 本门禁**不靠 sleep 赌时长**（本仓 W9225 明令禁止那种写法，而且它必然 flake：机器快/慢
 *   都会让信号落在窗口外）。做法是给启动序列加一个**测试专用检查点**
 *   （scripts/perf/lib/boot-race-seam.mjs）：门禁在自己的子进程里 `armBootRaceSeam()`，
 *   让检查点写一个标记文件、再给自己发 SIGTERM ⇒ 信号**必然**落在窗口内，与机器快慢无关。
 *   标记文件存在 ⇒「登记已经发生」这件事已被证明（检查点在登记之后）。
 *
 * 四层断言（前两层**不需要 Chrome**，任何机器都能跑）：
 *   ① 结构：spawn → adoptCleanup → 检查点 → **第一个 await** 的源码顺序；登记的是
 *      「会 kill child」的那个 close；scripts/ 下不得有人武装检查点；
 *   ② 登记表语义：登记一条、跑完自动注销、手动注销幂等；
 *   ③ 端到端（需要 Chrome）：**窗口内** SIGTERM ⇒ 无孤儿 / 端口可再 bind / profile 已删 /
 *      退出码 143；
 *   ④ 端到端：boot 完成后 SIGTERM（W2021 的行为不许被破坏）与正常 close() 路径。
 *   没装 Chrome 的机器**可见地跳过** ③④，而不是假装通过。
 */
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { posixProcessGroups } from "./lib/platform-gates.js";

const ROOT = process.cwd();
const PERF = join(ROOT, "scripts", "perf");
const CHROME_MJS = join(PERF, "lib", "chrome.mjs");
const SEAM_MJS = join(PERF, "lib", "boot-race-seam.mjs");
const APP_MJS = join(PERF, "lib", "app.mjs");
const CLEANUP_MJS = join(PERF, "lib", "cleanup.mjs");

interface ChromeMod {
  findChrome(): string | null;
}
const chromeMod = (await import(/* @vite-ignore */ pathToFileURL(CHROME_MJS).href)) as ChromeMod;
/** 候选路径存在**且可执行**才算「这台机器能跑端到端层」。 */
const CHROME: string | null = (() => {
  const found = chromeMod.findChrome();
  if (found === null) return null;
  try {
    accessSync(found, constants.X_OK);
    return found;
  } catch {
    return null;
  }
})();

interface CleanupMod {
  adoptCleanup(fn: () => unknown): () => void;
  closeAllRegistered(): Promise<void>;
  activeCleanupCount(): number;
  isSignalCleanupInstalled(): boolean;
}
const cleanupMod = (await import(/* @vite-ignore */ pathToFileURL(CLEANUP_MJS).href)) as CleanupMod;

interface SeamMod {
  isBootRaceSeamArmed(): boolean;
}
const seamMod = (await import(/* @vite-ignore */ pathToFileURL(SEAM_MJS).href)) as SeamMod;

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

/** 监听某个端口的进程（ss 一行一条；空数组 = 没有人在听）。 */
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

/** 命令行里匹配 pattern 的进程（pid + 命令行）。ps 不可用时返回 []。 */
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
// ---------------------------------------------------------------------------
// ① 结构：登记必须在 spawn 之后、第一个 await 之前（不需要 Chrome）
// ---------------------------------------------------------------------------
describe("W2027 ① · 结构：登记卡在 spawn 与第一个 await 之间（不需要 Chrome）", () => {
  // ★ 找结构位置前先**去掉注释**：本文件的注释里就有「await」「spawn」这些词，
  //   直接对原文 indexOf 会把注释当成代码（我第一版就是这么假红的）。
  //   去注释只改变字符偏移、不改变标记之间的**先后顺序**，而本用例断言的就是顺序。
  const source = readFileSync(CHROME_MJS, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const spawnAt = source.indexOf("const child = spawn(exe, args,");
  const adoptAt = source.indexOf("const unregister = adoptCleanup(close);");
  const seamAt = source.indexOf("bootRaceSeam('chrome:spawned');");
  // ★ 判据取「**登记之后**遇到的第一个 await**」：close() 自己那个 async IIFE 里的
  //   await（等 300ms 再删 profile）在登记**之前**，属于收尾内部，不是启动序列上的等待。
  //   所以从 adoptAt 往后数：下一个 await 就是 /json/version 轮询 —— 那才是窗口的终点。
  const firstSuspendAt = adoptAt + source.slice(adoptAt).search(/\bawait\b/);

  it("★ 顺序：spawn → adoptCleanup(close) → 检查点 → 第一个 await", () => {
    expect(spawnAt, "chrome.mjs 里必须有 spawn(exe, args, …)").toBeGreaterThan(-1);
    expect(adoptAt, "chrome.mjs 里必须登记收尾（adoptCleanup(close)）").toBeGreaterThan(-1);
    expect(seamAt, "chrome.mjs 里必须有测试检查点（门禁的确定性锚点）").toBeGreaterThan(-1);
    expect(firstSuspendAt, "launchChrome 里必须至少有一个 await（否则这个缺陷根本不存在）").toBeGreaterThan(-1);
    expect(adoptAt, "★ 登记必须在 spawn **之后**（那时 child 才存在）").toBeGreaterThan(spawnAt);
    expect(seamAt, "检查点必须在登记**之后**（标记文件 = 登记已完成的证明）").toBeGreaterThan(adoptAt);
    expect(firstSuspendAt, "★★ 登记必须在**启动序列的第一个 await 之前** —— 否则窗口没关严（本任务的核心）").toBeGreaterThan(seamAt);
    // 双重保险：**同步段**（spawn → close 定义）里不得出现 await。
    //   （不能拿 spawn→登记 整段来查：close() 自己的 async IIFE 里那个「等 300ms 再删
    //     profile」的 await 就落在这一段里，它是收尾内部，不是启动序列上的挂起。）
    const closeAt = source.indexOf("const close = () => {");
    const syncSpan = source.slice(spawnAt, closeAt);
    expect(/\bawait\b/.test(syncSpan), "spawn 与 close 定义之间不得有任何 await").toBe(false);
    // close() 的 kill 必须是**同步**的（信号处理器不 await 它的前半段）：
    // 第一个 await 之前就得有 child.kill()。
    const closeBody = source.slice(closeAt, adoptAt);
    expect(closeBody.indexOf("child.kill()"), "★ close() 里 child.kill() 必须在第一个 await 之前（同步 kill 才是保证）")
      .toBeLessThan(closeBody.search(/\bawait\b/));
  });

  it("★ 登记进表的就是「会 kill child」的那个 close（不是只删 profile 的空壳）", () => {
    const closeAt = source.indexOf("const close = () => {");
    const closeBody = source.slice(closeAt, adoptAt);
    expect(closeBody, "close() 里必须 kill child —— 只删 profile 会留下活着的孤儿").toContain("child.kill()");
    expect(closeBody, "close() 必须删 profile 目录").toContain("rmSync(profileDir");
    expect(source.slice(adoptAt, adoptAt + 39), "登记的就是那个 close 标识符").toBe("const unregister = adoptCleanup(close);");
  });

  it("★ 登记表里只能有一条指向这个 Chrome 的收尾（幂等 ≠ 可以重复登记）", () => {
    expect(source.split("adoptCleanup(close)").length - 1, "chrome.mjs 里 adoptCleanup(close) 只允许出现一次").toBe(1);
    const appSource = readFileSync(APP_MJS, "utf8");
    expect(appSource, "app.mjs 必须用 chrome.unregister() **接管**（而不是再登记一条）").toContain("chrome.unregister();");
    expect(appSource, "app.mjs 不得再登记一条指向同一个 Chrome 的收尾").not.toContain("registerCleanup");
  });

  it("★ 生产路径不可能武装检查点：除定义处外 scripts/ 零引用 + 默认未武装", () => {
    // 定义处（boot-race-seam.mjs）当然会提到这两个名字 —— 要证明的是**没有别人调用**。
    const r = spawnSync("git", ["grep", "-n", "-e", "armBootRaceSeam", "-e", "disarmBootRaceSeam", "--", "scripts"], { cwd: ROOT, encoding: "utf8" });
    const callers = r.stdout
      .split("\n")
      .filter((l) => l.trim() !== "")
      .filter((l) => !l.startsWith("scripts/perf/lib/boot-race-seam.mjs:"));
    expect(callers, "★ scripts/ 下（除定义处）不得有任何武装检查点的代码（否则它就不是测试专用的了）").toEqual([]);
    // 定义处只能有**定义**，不能顺手调用一次（否则生产路径一加载就被武装）。
    const seamSource = readFileSync(SEAM_MJS, "utf8");
    expect(seamSource, "定义处不得自己调用 armBootRaceSeam()").not.toMatch(/^\s*armBootRaceSeam\s*\(/m);
    expect(seamMod.isBootRaceSeamArmed(), "本进程没武装过 ⇒ 生产路径下 bootRaceSeam() 第一行就返回 null").toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ② 登记表语义（不需要 Chrome）
// ---------------------------------------------------------------------------
describe("W2027 ② · adoptCleanup：登记一条、跑完自动注销、不重复", () => {
  it("登记 → 跑一次 → 自动注销（表清空、信号处理器摘掉）", async () => {
    expect(cleanupMod.activeCleanupCount(), "前置：本用例开始时登记表必须为空").toBe(0);
    const runs: string[] = [];
    cleanupMod.adoptCleanup(() => { runs.push("closed"); });
    expect(cleanupMod.activeCleanupCount(), "登记后表里恰好一条").toBe(1);
    expect(cleanupMod.isSignalCleanupInstalled(), "有活实例时才安装信号处理器").toBe(true);
    await cleanupMod.closeAllRegistered();
    expect(runs, "收尾必须被跑一次").toEqual(["closed"]);
    expect(cleanupMod.activeCleanupCount(), "★ 跑完必须自动注销（否则信号到达会再关一次已关的东西）").toBe(0);
    expect(cleanupMod.isSignalCleanupInstalled(), "最后一个实例注销后必须摘掉（正常路径不被改动）").toBe(false);
  });

  it("注销幂等：重复调用不抛错、也不会把别人从表里删掉", async () => {
    const runs: string[] = [];
    const off = cleanupMod.adoptCleanup(() => { runs.push("a"); });
    cleanupMod.adoptCleanup(() => { runs.push("b"); });
    expect(cleanupMod.activeCleanupCount()).toBe(2);
    off(); off();
    expect(cleanupMod.activeCleanupCount(), "只删掉自己那一条").toBe(1);
    await cleanupMod.closeAllRegistered();
    expect(runs, "被注销的那条不得再跑").toEqual(["b"]);
  });
});

// ---------------------------------------------------------------------------
// ③④ 端到端（需要 Chrome；没有就**可见地跳过**）
// ---------------------------------------------------------------------------
/**
 * 探针：真的 boot（真 backend + 真 Chrome），按 W2027_MODE 在指定时机被信号打死。
 * 写成文件而不是内联 -e：子进程里需要 import 真模块（与 W2021 的探针同一形状）。
 */
function writeProbe(dir: string): string {
  const script = join(dir, "probe.mjs");
  const lines = [
    "import { execSync } from 'node:child_process';",
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import { boot } from " + JSON.stringify(pathToFileURL(APP_MJS).href) + ";",
    "import { armBootRaceSeam } from " + JSON.stringify(pathToFileURL(SEAM_MJS).href) + ";",
    "import { activeCleanupCount } from " + JSON.stringify(pathToFileURL(CLEANUP_MJS).href) + ";",
    "const mode = process.env.W2027_MODE;",
    "if (mode === 'in-window') {",
    "  // ★ 信号在**窗口内**发出：检查点位于「登记已完成、launchChrome 还没返回」之间。",
    "  armBootRaceSeam(() => {",
    "    // ★ 取证：此刻 Chrome 进程确实存在，把它的 profile 目录写进标记文件。",
    "    //   用 ps 读命令行，不依赖被测代码的任何字段（boot 还没返回）。",
    "    const line = execSync('ps -eo args=', { encoding: 'utf8' })",
    "      .split('\\n')",
    "      .find((l) => l.includes('--user-data-dir=') && l.includes('--remote-debugging-port=' + process.env.W2027_CDP));",
    "    const found = line === undefined ? null : /--user-data-dir=(\\S+)/.exec(line)[1];",
    "    writeFileSync(process.env.W2027_MARK, JSON.stringify({ profileDir: found }));",
    "    process.kill(process.pid, 'SIGTERM');",
    "  });",
    "}",
    "const app = await boot({ port: Number(process.env.W2027_PORT), cdpPort: Number(process.env.W2027_CDP) });",
    "console.log('BOOTED ' + JSON.stringify({ profileDir: app.profileDir, cleanupCount: activeCleanupCount() }));",
    "if (mode === 'after-boot') {",
    "  const timer = setInterval(() => {",
    "    if (!existsSync(process.env.W2027_TRIGGER)) return;",
    "    clearInterval(timer);",
    "    process.kill(process.pid, 'SIGTERM');",
    "  }, 50);",
    "}",
    "if (mode === 'normal') {",
    "  await app.close();",
    "  console.log('CLOSED');",
    "  process.exit(0);",
    "}",
    "setInterval(() => {}, 1000);",
  ];
  writeFileSync(script, lines.join("\n") + "\n");
  return script;
}

interface Probe {
  stdout: () => string;
  stderr: () => string;
  exit: Promise<{ code: number | null; signal: string | null }>;
}

function startProbe(script: string, env: Record<string, string>): Probe {
  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: { ...process.env, W9111_CHROME: CHROME ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  let err = "";
  child.stdout.on("data", (b) => { out += String(b); });
  child.stderr.on("data", (b) => { err += String(b); });
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  return { stdout: () => out, stderr: () => err, exit };
}

/** 探针打印的那一行（含 profileDir 与登记表条目数）。 */
interface Booted { profileDir: string; cleanupCount: number }
function bootedOf(probe: Probe): Booted {
  const m = /BOOTED (\{.*\})/.exec(probe.stdout());
  if (m === null) throw new Error("探针没有打印 BOOTED：\n" + probe.stdout() + "\n" + probe.stderr().slice(-1500));
  return JSON.parse(m[1]!) as Booted;
}

describe.skipIf(CHROME === null || !posixProcessGroups)("W2027 ③ · 端到端：窗口内 SIGTERM 不留孤儿", () => {
  it("★ Chrome 刚 spawn 出来就 SIGTERM：无孤儿 / 端口可再 bind / profile 已删 / 退出码 143", async () => {
    const backend = await pickFreePort();
    let cdp = await pickFreePort();
    while (cdp === backend) cdp = await pickFreePort();
    const dir = makeTmp("w2027-window-");
    const mark = join(dir, "in-window.marker");
    const probe = startProbe(writeProbe(dir), {
      W2027_MODE: "in-window",
      W2027_MARK: mark,
      W2027_PORT: String(backend),
      W2027_CDP: String(cdp),
    });

    // 标记文件 = 检查点跑过 = **登记已经发生**且 launchChrome 还没返回。不是 sleep 赌时长。
    try {
      await waitUntil("窗口内检查点被命中（登记已完成、launchChrome 未返回）", () => existsSync(mark), 30000);
    } catch (error) {
      throw new Error(String(error) + "\n子进程 stderr：\n" + probe.stderr().slice(-1500));
    }
    expect(probe.stdout(), "前置：此刻 boot **还没**返回（否则信号落在窗口外，本用例就不算数）").not.toContain("BOOTED");
    // ★ 取证（**不是 sleep 赌时长**）：标记文件是探针在检查点上写的，里面带着它**当时**
    //   用 ps 抓到的 profile 目录 ⇒「窗口内 Chrome 进程确实存在」这件事已被证明。
    const profileDir = JSON.parse(readFileSync(mark, "utf8")).profileDir as string | null;
    expect(profileDir, "★ 窗口内 Chrome 进程必须真的存在（否则本用例是空转）").not.toBeNull();

    const result = await probe.exit;
    expect(result.signal, "★ 必须自己收尾后退出，而不是被 SIGTERM 打死（被打死 = 登记表里没有它）").toBeNull();
    expect(result.code, "退出码 = 128 + SIGTERM(15) = 143").toBe(143);
    await waitUntil("CDP 端口被释放", () => listenersOn(cdp).length === 0);
    expect(await canBind(cdp), "★ CDP 端口必须可以被立刻重新 bind（Chrome 真的死了）").toBe(true);
    expect(listenersOn(backend), "★ backend 端口也不得还有人监听").toEqual([]);
    // ★★ 本任务的核心断言：窗口内收到信号之后，**不许留下孤儿 Chrome**。
    //     变红时能看出根因：信号路径没跑到登记表里的那一条。
    await waitUntil("窗口内的那个 Chrome 进程消失", () => processesMatching(profileDir!).length === 0, 5000);
    expect(processesMatching(profileDir!), "★★ 窗口内 SIGTERM 之后不得留下任何 Chrome 进程（孤儿）").toEqual([]);
    expect(existsSync(profileDir!), "★ profile 目录必须被删掉（只杀进程不删目录 = 半拉子收尾）").toBe(false);
  }, 90000);
});

describe.skipIf(CHROME === null || !posixProcessGroups)("W2027 ④ · 端到端：boot 完成后仍然干净（W2021 不许被破坏）", () => {
  it("boot 完成 → SIGTERM：无孤儿 / profile 已删 / 143；且登记表里**恰好一条**", async () => {
    const backend = await pickFreePort();
    let cdp = await pickFreePort();
    while (cdp === backend) cdp = await pickFreePort();
    const dir = makeTmp("w2027-after-");
    const trigger = join(dir, "trigger");
    const probe = startProbe(writeProbe(dir), {
      W2027_MODE: "after-boot",
      W2027_TRIGGER: trigger,
      W2027_PORT: String(backend),
      W2027_CDP: String(cdp),
    });

    try {
      await waitUntil("boot 完成（探针打印 BOOTED）", () => probe.stdout().includes("BOOTED"), 60000);
    } catch (error) {
      throw new Error(String(error) + "\n子进程 stderr：\n" + probe.stderr().slice(-1500));
    }
    const booted = bootedOf(probe);
    // ★ 若 chrome.mjs 与 app.mjs **都**登记了，这里会是 2 ⇒ 信号到达时会跑两遍、各等一次 300ms。
    expect(booted.cleanupCount, "★ 登记表里必须**恰好一条**（不重复登记）").toBe(1);
    expect(processesMatching(booted.profileDir).length, "前置：Chrome 必须真的起来了").toBeGreaterThan(0);

    writeFileSync(trigger, "go");
    const result = await probe.exit;

    expect(result.signal, "必须自己收尾后退出").toBeNull();
    expect(result.code, "退出码 = 143").toBe(143);
    await waitUntil("Chrome 进程消失", () => processesMatching(booted.profileDir).length === 0);
    expect(processesMatching(booted.profileDir), "★ 不得留下任何 Chrome 进程").toEqual([]);
    expect(existsSync(booted.profileDir), "profile 目录必须被删掉").toBe(false);
    expect(listenersOn(backend), "★ backend 端口不得还有人监听").toEqual([]);
  }, 90000);

  it("正常路径：boot 完成 → app.close() ⇒ 干净退出（无信号、无额外延迟）", async () => {
    const backend = await pickFreePort();
    let cdp = await pickFreePort();
    while (cdp === backend) cdp = await pickFreePort();
    const dir = makeTmp("w2027-normal-");
    const probe = startProbe(writeProbe(dir), {
      W2027_MODE: "normal",
      W2027_PORT: String(backend),
      W2027_CDP: String(cdp),
    });

    try {
      await waitUntil("boot 完成 → close() 完成", () => probe.stdout().includes("CLOSED"), 60000);
    } catch (error) {
      throw new Error(String(error) + "\n子进程 stderr：\n" + probe.stderr().slice(-1500));
    }
    const booted = bootedOf(probe);
    expect(booted.cleanupCount, "正常路径下登记表里同样恰好一条").toBe(1);
    const result = await probe.exit;
    expect(result.code, "正常路径必须退出码 0").toBe(0);
    expect(processesMatching(booted.profileDir), "★ 正常路径不得留下 Chrome").toEqual([]);
    expect(existsSync(booted.profileDir), "★ 正常路径 profile 必须被删").toBe(false);
    expect(listenersOn(backend), "★ 正常路径不得留下监听端口").toEqual([]);
    expect(await canBind(cdp), "CDP 端口可再 bind").toBe(true);
  }, 90000);
});

