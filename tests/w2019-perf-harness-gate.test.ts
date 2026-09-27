// @vitest-environment node
/**
 * W2019 · scripts/perf 前端性能侦测工具包 —— **静态可移植性门禁**。
 *
 * 为什么需要它：这个工具包**不在任何门禁里**（改动前 `grep -rn "scripts/perf" package.json
 * scripts/check-parallel.mjs .github/` 零命中），于是它坏了很久也没人发现 —— 本次是架构师
 * 在做性能工作时才撞见：
 *   · `findChrome()` 只认 5 条写死的路径，本机一条都不存在 ⇒ `smoke.mjs` **第一行**就
 *     `Error: chrome not found`，而且**没有任何环境变量可以绕过**（README 的环境变量表里
 *     也没有 CHROME 这一项）；
 *   · `DEFAULT_REPO` 默认值是作者那台 Windows 的临时目录
 *     （`C:/Users/lenovo/AppData/Local/Temp/perf-w9111/repo`）⇒ 换机器就是"不存在的路径"；
 *   · 11 个脚本把 `{ port: 3788, cdpPort: 9333 }` 写死在调用点 ⇒ 并行跑必撞端口。
 *
 * ★ 本门禁**不启动浏览器、不跑测量**（CI 上可能根本没有 Chrome）：只做静态判定 +
 *   对**纯函数**（`findChrome` / `chromeCandidates` / `repoRootFrom` / `portFromEnv`）的调用。
 *   哪天有人把这些能力删回去，这里立刻红。
 *
 * ★ 判定方式是**跑脚本自己的模块**（动态 `import`），不是把它的实现用正则抄一遍 ——
 *   抄一遍就变成"测试测的是复刻，不是真实现"（同 tests/lib/checkout-path.ts 的教训）。
 *   `.mjs` 没有类型声明，所以按本仓既有写法（tests/copy-gate-console.test.ts）用
 *   `pathToFileURL` + 局部 `interface` 断言形状。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/** `scripts/perf/lib/chrome.mjs` 的对外形状。 */
interface ChromeMod {
  CHROME_ENV: string;
  CHROME_CANDIDATES: string[];
  playwrightCacheRoot(env?: Record<string, string | undefined>): string;
  chromeCandidates(o?: { env?: Record<string, string | undefined>; playwright?: string[] }): string[];
  findChrome(o?: {
    env?: Record<string, string | undefined>;
    playwright?: string[];
    exists?: (p: string) => boolean;
  }): string | null;
}

/** `scripts/perf/lib/repo-root.mjs` 的对外形状。 */
interface RepoRootMod {
  findRepoRoot(startDir: string): string | null;
  repoRootFrom(importMetaUrl: string): string | null;
}

/** `scripts/perf/lib/ports.mjs` 的对外形状。 */
interface PortsMod {
  portFromEnv(name: string, fallback: number): number;
  backendPort(): number;
  cdpPort(): number;
}

/** `scripts/perf/lib/app.mjs` 的对外形状（只取本门禁要断言的常量）。 */
interface AppMod {
  DEFAULT_REPO: string | null;
  DEFAULT_VITE: string;
}

const ROOT = process.cwd();
const PERF = join(ROOT, "scripts", "perf");
const LIB = join(PERF, "lib");

/** 动态 import 一个 `.mjs`（Vite 不做静态解析，路径是运行期算出来的）。 */
async function load<T>(rel: string): Promise<T> {
  return (await import(/* @vite-ignore */ pathToFileURL(join(ROOT, rel)).href)) as T;
}

let chrome: ChromeMod;
let repoRoot: RepoRootMod;
let ports: PortsMod;

beforeAll(async () => {
  chrome = await load<ChromeMod>("scripts/perf/lib/chrome.mjs");
  repoRoot = await load<RepoRootMod>("scripts/perf/lib/repo-root.mjs");
  ports = await load<PortsMod>("scripts/perf/lib/ports.mjs");
});

/** 所有会 `boot` 起后端的 perf 脚本（相对 `scripts/perf/`）。 */
const BOOT_SCRIPTS = [
  "smoke.mjs",
  "verify.mjs",
  "focus-ops.mjs",
  "focus-scroll.mjs",
  "focus-think-ledger.mjs",
  "focus-toolcost.mjs",
  "focus-toolrate.mjs",
  "cases/q1-think.mjs",
  "cases/q2-virtual.mjs",
  "cases/q3-mutation.mjs",
  "cases/q4-memory.mjs",
];

function read(rel: string): string {
  return readFileSync(join(PERF, rel), "utf8");
}

/** 递归列出目录下的**文件**（绝对路径）。 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && statSync(p).isFile()) out.push(p);
  }
  return out;
}

describe("W2019 ① · Chrome 查找：环境变量优先 + 候选不只有 Windows 路径", () => {
  it("设置了 W9111_CHROME 时 findChrome() 返回该路径（不碰文件系统）", () => {
    // 故意给一个**不存在**的路径：显式覆盖必须被无条件尊重 —— 悄悄换用另一个 Chrome
    // 会让数字来自另一个浏览器版本，口径不可复核比报错更糟。
    const fake = join(ROOT, "no", "such", "chrome");
    expect(chrome.findChrome({ env: { [chrome.CHROME_ENV]: fake }, playwright: [] })).toBe(fake);
  });

  it("W9111_CHROME 为空白时不生效（空变量不得让 findChrome 返回空串）", () => {
    expect(chrome.findChrome({ env: { [chrome.CHROME_ENV]: "   " }, playwright: [], exists: () => false })).toBeNull();
  });

  it("候选列表含**非 Windows** 的路径，不再只有盘符开头的安装位置", () => {
    const nonWindows = chrome.CHROME_CANDIDATES.filter((p: string) => !/^[A-Za-z]:[\\/]/.test(p));
    expect(nonWindows.length, "候选里必须有不依赖盘符的路径").toBeGreaterThanOrEqual(3);
  });

  it("★ Playwright 缓存进候选：有缓存时必须能找到**真实存在**的可执行文件", () => {
    if (!existsSync(chrome.playwrightCacheRoot())) return; // 没装 Playwright 的机器：跳过（不是失败）
    const hit = chrome.findChrome({ env: {}, exists: existsSync });
    expect(hit, "有 Playwright 缓存时必须能找到 Chrome 可执行文件").not.toBeNull();
    expect(existsSync(String(hit))).toBe(true);
  });

  it("候选序列 = 环境变量 → 原有候选 → Playwright（顺序即优先级）", () => {
    const seq = chrome.chromeCandidates({ env: { [chrome.CHROME_ENV]: "/x/chrome" }, playwright: ["/p/chrome"] });
    expect(seq[0]).toBe("/x/chrome");
    expect(seq.slice(1, 1 + chrome.CHROME_CANDIDATES.length)).toEqual([...chrome.CHROME_CANDIDATES]);
    expect(seq[seq.length - 1]).toBe("/p/chrome");
  });
});

describe("W2019 ② · 仓根：从脚本自身位置推导，且默认值真实可用", () => {
  it("推导出的仓根**真实存在**且含 package.json（不再是 Windows 临时目录）", () => {
    const derived = repoRoot.repoRootFrom(import.meta.url);
    expect(derived, "从 scripts/perf/lib 上溯必须能推出仓根").not.toBeNull();
    expect(existsSync(join(String(derived), "package.json")), "仓根必须有 package.json").toBe(true);
    expect(existsSync(join(String(derived), "apps", "web", "index.html")), "仓根必须有 apps/web/index.html").toBe(true);
  });

  it("★ 默认值真实可用：不设 W9111_REPO 时 DEFAULT_REPO/apps/web 存在", async () => {
    // 直接 import 真模块，拿它算出的 DEFAULT_REPO（不是复刻它的算法）。
    const app = await load<AppMod>("scripts/perf/lib/app.mjs");
    const repo = app.DEFAULT_REPO;
    expect(repo, "DEFAULT_REPO 不得为 null（推导失败应显式报错，而不是静默指向不存在的路径）").not.toBeNull();
    expect(String(repo), "不得再是 Windows 绝对路径").not.toMatch(/^[A-Za-z]:[\\/]/);
    expect(existsSync(join(String(repo), "apps", "web")), "DEFAULT_REPO/apps/web 必须存在").toBe(true);
  });

  it("findRepoRoot 是纯上溯：最近的 package.json 所在目录即答案", () => {
    // `scripts/` 下没有 package.json ⇒ 上溯到仓根；`packages/core/` 有自己的
    // package.json ⇒ 停在那一层（这正是"最近的祖先"语义）。
    expect(repoRoot.findRepoRoot(join(ROOT, "scripts", "perf", "lib"))).toBe(ROOT);
    expect(repoRoot.findRepoRoot(join(ROOT, "packages", "core", "src"))).toBe(join(ROOT, "packages", "core"));
  });

  it("找不到 package.json 时返回 null（不编造路径）", () => {
    const empty = mkdtempSync(join(tmpdir(), "w2019-norepo-"));
    expect(repoRoot.findRepoRoot(empty)).toBeNull();
  });

  it("W9111_REPO 覆盖仍然有效（README 的冻结检出工作流不许被破坏）", () => {
    expect(readFileSync(join(LIB, "app.mjs"), "utf8"), "必须保留 W9111_REPO 覆盖").toContain("W9111_REPO");
  });
});

describe("W2019 ③ · 端口：每个脚本的端口都能被环境变量覆盖", () => {
  it("portFromEnv：合法正整数生效，空/非法值回落默认（不得变成端口 0）", () => {
    const KEY = "__W2019_PORT__";
    delete process.env[KEY];
    expect(ports.portFromEnv(KEY, 3788)).toBe(3788); // 未设
    process.env[KEY] = "4567";
    expect(ports.portFromEnv(KEY, 3788)).toBe(4567);
    for (const bad of ["", "  ", "abc", "0", "-1", "1.5"]) {
      process.env[KEY] = bad;
      expect(ports.portFromEnv(KEY, 3788), `非法值 ${JSON.stringify(bad)} 必须回落默认`).toBe(3788);
    }
    delete process.env[KEY];
  });

  it("backendPort/cdpPort 默认值与改动前**逐字一致**（3788 / 9333）", () => {
    delete process.env.W9111_PORT;
    delete process.env.W9111_CDP_PORT;
    expect(ports.backendPort()).toBe(3788);
    expect(ports.cdpPort()).toBe(9333);
  });

  it("★ 环境变量真的改变端口（默认值不变、覆盖生效）", () => {
    process.env.W9111_PORT = "4711";
    process.env.W9111_CDP_PORT = "9711";
    try {
      expect(ports.backendPort()).toBe(4711);
      expect(ports.cdpPort()).toBe(9711);
    } finally {
      delete process.env.W9111_PORT;
      delete process.env.W9111_CDP_PORT;
    }
  });

  it("11 个起后端的脚本都走 ports.mjs，**没有任何一个**再写死 3788/9333", () => {
    const offenders: string[] = [];
    for (const rel of BOOT_SCRIPTS) {
      const src = read(rel);
      if (!src.includes("ports.mjs")) offenders.push(rel + " 未 import ports.mjs");
      if (/port:\s*\d/.test(src) || /cdpPort:\s*\d/.test(src)) offenders.push(rel + " 仍把端口写死在调用点");
    }
    expect(offenders, "端口必须统一走 W9111_PORT / W9111_CDP_PORT").toEqual([]);
  });

  it("w9113-p0.mjs 的既有 W9113_PORT 范例未被破坏", () => {
    const src = read("w9113-p0.mjs");
    expect(src).toContain("W9113_PORT");
    expect(src).toContain("W9113_CDP_PORT");
  });
});

describe("W2019 ④ · 防复发：README 登记 + 零依赖 + profile 不落仓库", () => {
  it("README 的环境变量**表**登记了 W9111_CHROME / W9111_PORT / W9111_CDP_PORT", () => {
    // ★ 必须落在表格行上（`| \`KEY\` | … |`），不能只要求"全文出现过这个名字" ——
    //   正文里顺口提一句也算的话，这条断言就没有牙了（变异⑤ 实测踩到：删掉表格行后
    //   Linux 小节里的 `export W9111_CHROME=…` 仍然让旧的 toContain 保持绿）。
    const readme = readFileSync(join(PERF, "README.md"), "utf8");
    for (const key of [chrome.CHROME_ENV, "W9111_PORT", "W9111_CDP_PORT"]) {
      const row = new RegExp("^\\|\\s*`" + key + "`\\s*\\|", "m");
      expect(row.test(readme), `README 的环境变量表必须有 ${key} 一行`).toBe(true);
    }
  });

  it("工具包仍然零依赖（只用 node: 内置 + 全局 WebSocket）", () => {
    const offenders: string[] = [];
    for (const file of walk(PERF).filter((p) => p.endsWith(".mjs"))) {
      for (const m of readFileSync(file, "utf8").matchAll(/from\s+'([^']+)'/g)) {
        const spec = m[1] ?? "";
        if (spec.startsWith(".") || spec.startsWith("node:")) continue;
        offenders.push(file.slice(ROOT.length + 1) + " → " + spec);
      }
    }
    expect(offenders, "不得引入第三方依赖（README：零依赖）").toEqual([]);
  });

  it("浏览器 profile 只落 $TEMP：不得把 profile 目录写进仓库", () => {
    expect(read("lib/chrome.mjs"), "profile 必须走 mkdtemp(tmpdir())").toContain("tmpdir()");
    for (const rel of ["lib/chrome.mjs", "lib/app.mjs", "smoke.mjs"]) {
      expect(read(rel), rel + " 不得把 profile 写进仓库").not.toMatch(/user-data-dir=\s*['"]?\.{0,2}\//);
    }
  });
});
