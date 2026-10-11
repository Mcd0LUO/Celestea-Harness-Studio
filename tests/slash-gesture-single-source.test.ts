// @vitest-environment node
/**
 * `/` 触发的解析必须是**一份**（docs/feature/composer-surface.md §7 的结构断言）。
 *
 * 为什么需要这条门禁：`parseSlashGesture` 上线前，`isCommand` / `parseLine`（前端）
 * 与技能侧计划的 `matchSkillGesture` 各自判「什么算 `/` 触发」，字符集已经开始不一致。
 * 两份判定分叉出来的正是「补全框亮了、host 却没注入」那种失效形状。
 *
 * **为什么是读源码文本而不是运行时行为**：没有任何运行时行为能暴露「全仓只许有一份解析」
 * ——这属于铁律 11 说的「策略」类约束，唯一机械的落点就是扫源码。
 *
 * **口径**（越宽越容易误报，越窄越漏）：
 * - 扫 `packages`、`apps`、`scripts` 下的非测试 .ts（不含 `*.test.ts`：断言本身要写这些字面量）；
 * - 命中形态 = 「行首 `/` 判定」的 `startsWith('/')` 两种引号写法。
 *   本仓当前**没有** `charAt(0) === '/'` 或正则 `^/` 的等价写法，所以不设这两个形态；
 *   真出现时按同一口径补进 `MARKERS`，而不是让它们悄悄绕过本门禁。
 * - 双向对账：命中而未登记 ⇒ 红；登记而不再命中 ⇒ 红（过期豁免，棘轮只许收紧）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { SKILL_NAME_PATTERN as CORE_SKILL_NAME_PATTERN } from "@celestea/core";
import { SKILL_NAME_PATTERN as GESTURE_SKILL_NAME_PATTERN, parseSlashGesture } from "@celestea/gesture";

const ROOT = process.cwd();

/** 本仓唯一的 `/` 触发解析实现。 */
const GESTURE_PARSER = "packages/gesture/src/slash-gesture.ts";

/** 「行首 `/` 判定」的字面形态（见文件头口径说明）。 */
const MARKERS: RegExp[] = [/startsWith\('\/'\)/, /startsWith\("\/"\)/];

/**
 * 逐条记账的豁免：**原因必填**。
 * 前两条是 §7 点名的既有解析（命令分发内部实现），其余是同名形态的**路径判定**，
 * 与输入行的 `/` 手势无关——删掉豁免之前请先确认它不是真的在解析手势。
 */
const EXEMPT: Record<string, string> = {
  [GESTURE_PARSER]: "本仓唯一的 / 触发解析实现（parseSlashGesture）—— 这一条不是豁免，是真源",
  "apps/web/src/ui/commands/index.ts":
    "命令分发的内部实现（isCommand / refresh 的补全分支 / applyCommand 回写）：它按注册表派发，canonical 与名字都不由它产出；§7 要求逐条登记而不是假装它不存在",
  "apps/web/src/ui/commands/registry.ts":
    "命令补全的前缀判定（completionPrefix / isCommandLine）：判的是「还没敲到空白」的补全态，不是手势的规范形态",
  "apps/web/src/ui/commands/files.ts": "工作区绝对路径判定（POSIX 绝对路径），与输入行的 / 手势无关",
  "apps/web/src/ui/enhance/file-link.ts": "文件链接的绝对路径判定，与输入行的 / 手势无关",
  "apps/studio/src/store/workspaces.ts": "工作区路径的平台判定（win32 / POSIX），与输入行的 / 手势无关",
  "apps/studio/src/handlers/fs.ts": "同上（注释里记着 W885 那条 startsWith('/') 的历史坑）",
  "apps/studio/src/runtime/mcp-wiring.ts":
    "parseSlashGesture 的消费方（D1 的 /mcp:<server> host 注入车道）；命中的那段文本是注释里对 isCommand 形态的引用，不是第二份解析",
  "apps/studio/src/runtime/skill-wiring.ts":
    "parseSlashGesture 的消费方（切片 3 的 host 注入）；命中的那段文本是注释里对 isCommand 形态的引用，不是第二份解析",
};

/** 扫描范围：产品源码。不含 tests/（断言自己会写这些字面量）与 *.test.ts。 */
const SCAN_ROOTS = ["packages", "apps", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "webdist", "coverage", ".worktrees", "tmp", "results"]);

function isTestFile(rel: string): boolean {
  return /\.test\.ts$/.test(rel) || /\.test-util\.ts$/.test(rel) || /\.spec\.ts$/.test(rel);
}

function collect(relDir: string, out: string[]): void {
  for (const entry of readdirSync(join(ROOT, relDir), { withFileTypes: true })) {
    const rel = relDir + "/" + entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collect(rel, out);
    } else if (entry.name.endsWith(".ts") && !isTestFile(rel)) {
      out.push(rel);
    }
  }
}

/** 全仓所有命中「行首 `/` 判定」形态的非测试源码（posix 相对路径）。 */
function gestureMarkerHits(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) collect(root, files);
  const hits: string[] = [];
  for (const rel of files.sort()) {
    const text = readFileSync(resolve(ROOT, rel), "utf8");
    if (MARKERS.some((re) => re.test(text))) hits.push(rel);
  }
  return hits;
}

describe("§7 / 触发解析只有一份", () => {
  const hits = gestureMarkerHits();

  it("命中行首 / 判定的文件全部已登记（未登记即第二份解析，红）", () => {
    const unregistered = hits.filter((rel) => EXEMPT[rel] === undefined);
    expect(unregistered, "出现未登记的 / 触发解析：把它并入 parseSlashGesture，或逐条登记豁免").toEqual([]);
  });

  it("真源仍然存在、仍然命中（豁免表不能顶替真源）", () => {
    expect(hits).toContain(GESTURE_PARSER);
    expect(readFileSync(resolve(ROOT, GESTURE_PARSER), "utf8")).toContain("export function parseSlashGesture");
  });

  it("登记的豁免逐条写明理由（空理由 = 没记账）", () => {
    for (const [rel, why] of Object.entries(EXEMPT)) {
      expect(why.trim().length, rel + " 的豁免理由为空").toBeGreaterThan(10);
    }
  });

  it("豁免清单与现状双向对账：登记了却不再命中的 = 过期豁免", () => {
    const stale = Object.keys(EXEMPT).filter((rel) => !hits.includes(rel));
    expect(stale, "这些豁免已不再命中形态，删掉它们（棘轮只许收紧）").toEqual([]);
  });
});

describe("§7 字符集只有一份定义", () => {
  it("core 导出的 SKILL_NAME_PATTERN 就是 gesture 那个对象（唯一定义处）", () => {
    expect(CORE_SKILL_NAME_PATTERN).toBe(GESTURE_SKILL_NAME_PATTERN);
  });

  it("字符集与解析函数同源：core 那份字符集认出来的名字，手势解析也认", () => {
    for (const name of ["review", "code-review", "a1"]) {
      expect(parseSlashGesture("/skill:" + name)?.name, name).toBe(name);
    }
    expect(parseSlashGesture("/skill:Review")).toBeNull();
  });
});

describe("gesture 是零 Node API 的纯函数叶子", () => {
  it("packages/gesture/src 不引任何 node: 内建模块（前端要打包它）", () => {
    const files: string[] = [];
    collect("packages/gesture", files);
    const offenders = files.filter((rel) => /from\s+["']node:/.test(readFileSync(resolve(ROOT, rel), "utf8")));
    expect(offenders, "gesture 引入 node: 会把 node:fs 拖进 apps/web 的浏览器产物").toEqual([]);
  });

  it("apps/web 只依赖 gesture 一个 @celestea 包（core 等带 node:fs，绝不能进来）", () => {
    const manifest = JSON.parse(readFileSync(resolve(ROOT, "apps/web/package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const celestea = Object.keys(manifest.dependencies ?? {}).filter((dep) => dep.startsWith("@celestea/"));
    expect(celestea.sort()).toEqual(["@celestea/gesture"]);
  });
});
