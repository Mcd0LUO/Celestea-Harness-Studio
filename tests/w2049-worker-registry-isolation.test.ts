// @vitest-environment node
/**
 * W2049 · 本仓 worker 台账 / 结果目录**与 DSH 集群隔离**的机械门禁。
 *
 * 背景（真实事故）：DSH 侧的工号分配器（\`celes-worker-spawn\`，住在 DSH 自身 checkout，
 * **不在本仓**）自动分配 W 号时只读它自己那一套台账，看不见另一域（MC）的台账
 * ⇒ 同一个号被两个域各发一次；而两域的报告都落进**同一个共享 results 目录**，
 * 回执文件名又只带号（\`<wid>.receipt-ok\`）⇒ 同号回执互相覆盖，"哪个 W2040"的语义丢失。
 *
 * 这个缺陷**修不到本仓**（分配器不是本仓代码）。本仓能守、也必须守住的，是**自己这一侧**：
 * 本仓的 worker 台账与结果目录必须是**本仓 data dir 下的另一套**，绝不落到 DSH 集群
 * 共用的那两个路径上 —— 那正是撞号危害链的落点。本文件把这个隔离钉成可执行断言。
 *
 * 五条断言：
 *   ① 台账默认 = \`<data dir>/worker-registry.tsv\`，文件名**不是**集群的 \`registry.tsv\`；
 *   ② 即使 data dir 就指向集群根，派生的仍是**另一个文件**（隔离靠文件名，不只靠目录）；
 *   ③ 优先级 显式 > \`CELESTEA_WORKER_REGISTRY\` > data dir；空值 = 内存表（测试/嵌入式要保留）；
 *   ④ 退役的共享表在 \`tmpdir()\` 下，名字也不是集群那个；
 *   ⑤ **生产源码里不得出现集群路径字面量** —— 本仓永不去读/写集群的台账与结果目录。
 *
 * ⑤ 是这条门禁真正有牙的一条：它拦的是"把集群路径硬编码进本仓"这类回归。
 * 前四条是行为断言，钉住已经存在的隔离，防止有人把它改回去。
 */
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { REGISTRY_TSV_PATH } from "@celestea/workers";
import {
  ENV_WORKER_REGISTRY,
  WORKER_REGISTRY_FILE,
  workerTablePath,
} from "../apps/studio/src/runtime/worker-table.js";

/**
 * 只做路径推导，不碰文件系统：这些目录都不需要真实存在。
 *
 * ★ 用 `join(tmpdir(), …)` 而不是 `"/tmp/…"` 字面量：被测的 `workerTablePath` 对
 * `CELESTEA_WORKER_REGISTRY` 与 `override` 走 `resolve()`，而 `/tmp/…` 在 Windows 上
 * 会被改写成 `D:\tmp\…` —— 断言写死字面量就只在 POSIX 上成立（本仓 CI 双平台）。
 * `join(tmpdir(), …)` 已经是**规范化的绝对路径**，`resolve()` 对它是恒等，两个平台都成立。
 */
const DATA_DIR = join(tmpdir(), "w2049-data-dir");
/** 环境变量分支的输入（会被 `resolve`）。 */
const ENV_TABLE = join(tmpdir(), "w2049-env.tsv");
/** `override` 分支的输入（会被 `resolve`）。 */
const OVERRIDE_TABLE = join(tmpdir(), "w2049-ov.tsv");
/** DSH 集群的 worker 运行根（\`workerBase\`）。本仓**只**拿它当反例，不去读写它。 */
const FLEET_ROOT = "/srv/ops/runtime/worker-exec";

/** 生产源码根（\`.test.ts\` 不算生产源码：它们只在注释里引报告出处）。 */
const PROD_ROOTS = [
  "apps/studio/src",
  "apps/web/src",
  ...readdirSync(join(process.cwd(), "packages"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join("packages", e.name, "src")),
];

/** 递归收集 \`.ts\` 生产源码（跳过 \`dist\` / \`node_modules\` 与测试文件）。 */
function sourceFiles(root: string, out: string[] = []): string[] {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "dist") sourceFiles(p, out);
    } else if (e.name.endsWith(".ts") && !e.name.includes(".test.")) {
      out.push(p);
    }
  }
  return out;
}

describe("W2049 · 本仓 worker 台账与 DSH 集群隔离", () => {
  it("① 台账默认落在本仓自己的 data dir 下，且文件名不是集群的 registry.tsv", () => {
    expect(workerTablePath({ env: {}, dataDir: DATA_DIR })).toBe(join(DATA_DIR, WORKER_REGISTRY_FILE));
    expect(WORKER_REGISTRY_FILE).toBe("worker-registry.tsv");
    // 集群那张表叫 registry.tsv。同名 + 同目录 = 同一个文件，隔离就没了。
    expect(WORKER_REGISTRY_FILE).not.toBe("registry.tsv");
  });

  it("② data dir 就是集群根时，派生的仍是另一个文件（隔离靠文件名，不只靠目录）", () => {
    const derived = workerTablePath({ env: {}, dataDir: FLEET_ROOT });
    expect(derived).toBe(join(FLEET_ROOT, "worker-registry.tsv"));
    expect(basename(derived!)).not.toBe("registry.tsv");
  });

  it("③ 优先级：显式 > 环境变量 > data dir；空值 = 内存表", () => {
    expect(workerTablePath({ env: { [ENV_WORKER_REGISTRY]: ENV_TABLE }, dataDir: DATA_DIR })).toBe(ENV_TABLE);
    expect(workerTablePath({ env: { [ENV_WORKER_REGISTRY]: "" }, dataDir: DATA_DIR })).toBeNull();
    expect(workerTablePath({ env: {}, dataDir: DATA_DIR, override: OVERRIDE_TABLE })).toBe(OVERRIDE_TABLE);
    expect(workerTablePath({ env: { [ENV_WORKER_REGISTRY]: join(tmpdir(), "x.tsv") }, dataDir: DATA_DIR, override: null })).toBeNull();
  });

  it("④ 退役的共享表在 tmpdir() 下，名字也不是集群那个", () => {
    expect(REGISTRY_TSV_PATH.startsWith(tmpdir())).toBe(true);
    expect(basename(REGISTRY_TSV_PATH)).toBe("celestea-workers-registry.tsv");
  });

  it("⑤ 生产源码不含集群路径字面量（本仓不读写集群的台账与结果目录）", () => {
    const offenders: string[] = [];
    for (const root of PROD_ROOTS) {
      for (const f of sourceFiles(join(process.cwd(), root))) {
        const text = readFileSync(f, "utf8");
        if (/worker-exec/.test(text)) offenders.push(f.slice(process.cwd().length + 1));
      }
    }
    expect(offenders, "本仓生产代码不得硬编码 DSH 集群的 worker-exec 路径").toEqual([]);
  });
});
