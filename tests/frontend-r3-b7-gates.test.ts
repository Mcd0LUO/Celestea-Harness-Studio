/**
 * R3 W838 · B7 —— 前端门禁工具（第 9 批）。
 * 来源：/srv/ops/runtime/worker-exec/results/W828-R3修复计划-C-studio-web-tests-security.md
 *   的 B7 验收探针：
 *   F6/N3：STRICT=1 时「可收紧项（tighten）」必须与陈旧项一样失败，且输出与退出码一致。
 *   （原 F7「web check 内置 CELESTEA_BUNDLE_STRICT=1」与产物体积容差三例，随**产物体积棘轮**
 *    一并移除 —— 2026-10-04 W9339。模块体积棘轮不受影响，其断言在下面。）
 * 方式：把**真实门禁脚本**复制到临时目录（同内容、不同 ROOT），用真实 node 子进程跑真实脚本；
 * 断言退出码与输出，不 mock 门禁逻辑本身。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = join(ROOT, "apps", "web", "tools");
const sandboxes: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "w838-gate-"));
  mkdirSync(join(dir, "tools"), { recursive: true });
  sandboxes.push(dir);
  return dir;
}

afterEach(() => {
  while (sandboxes.length) {
    const d = sandboxes.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function run(script: string, env: Record<string, string> = {}): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

/** 临时模块树：一个 450 行文件 + 登记上限 500 = 纯 tighten（>400 默认上限，<500 登记上限）。 */
function tightenSandbox(): string {
  const dir = sandbox();
  copyFileSync(join(TOOLS, "check-module-size.mjs"), join(dir, "tools", "check-module-size.mjs"));
  mkdirSync(join(dir, "src"), { recursive: true });
  const body = Array.from({ length: 450 }, (_, i) => "export const v" + i + " = " + i + ";").join("\n") + "\n";
  writeFileSync(join(dir, "src", "big.ts"), body);
  writeFileSync(
    join(dir, "tools", "module-size-baseline.json"),
    JSON.stringify({ kind: "frontend-module-size-baseline", defaultLimit: 400, limits: { "src/big.ts": 500 } }),
  );
  return dir;
}

describe("R3 W838-F6/N3 · module-size STRICT 拦 tighten", () => {
  it("tighten-only 时 STRICT=1 退出 1，输出与退出码一致", () => {
    const script = join(tightenSandbox(), "tools", "check-module-size.mjs");
    const plain = run(script);
    expect(plain.code).toBe(0); // 非 STRICT：只报警
    expect(plain.out).toContain("可收紧");
    const strict = run(script, { CELESTEA_MODULE_SIZE_STRICT: "1" });
    expect(strict.code).toBe(1); // F6：tighten 也进 STRICT 失败集合
    expect(strict.out).toContain("可收紧项");
    expect(strict.out).toContain("STRICT=1");
  });
});
