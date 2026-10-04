// @vitest-environment node
/**
 * W9224 · CI 分片棘轮。
 *
 * 背景：CI 的 test 步骤原本一次跑全量 406 个文件。本机实测（3 workers 模拟 4 核 runner）：
 *   全量 61.8 s → 2 片各 ~32.8 s → 3 片各 ~23 s
 * 分片是**并行 job**，所以墙钟 ≈ 单片时长（不是求和）。
 *
 * 为什么需要棘轮 —— 分片有一个**静默丢测试**的陷阱：
 *   ① 片数写错（比如 `--shard=1/3` 写成 `--shard=1/2`）⇒ 有文件永远不跑，CI 仍然全绿；
 *   ② 只给 `test` 加 `if:` 忘了给别的门禁加 ⇒ 门禁被跳过（或反过来，跑 3 遍浪费 CI 分钟）；
 *   ③ 矩阵的 `shard` 维度与命令里的分母不一致 ⇒ 覆盖不全。
 * 这三条都**不会**让 CI 变红，只会让它悄悄少测。本文件按名钉住它们。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CI_RULES, describeMissing, missingRules } from "./lib/test-arch-rules.js";

const ROOT = process.cwd();
const CI = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

describe("W9224 · CI 分片覆盖完整性", () => {
  it("① ci.yml 按名满足全部分片契约", () => {
    expect(missingRules(CI_RULES, CI), describeMissing(CI_RULES, CI)).toEqual([]);
  });

  it("② 矩阵的 shard 维度与 test 命令的分母必须一致（防静默丢测试）", () => {
    // 从矩阵取出 shard 列表，从命令取出分母，两者必须相等。
    const list = /shard:\s*\[([^\]]+)\]/.exec(CI);
    const denom = /--shard=\$\{\{ matrix\.shard \}\}\/(\d+)/.exec(CI);
    expect(list, "矩阵必须有 shard 维度").not.toBeNull();
    expect(denom, "test 命令必须用 --shard=<i>/<N>").not.toBeNull();
    const count = (list?.[1] ?? "").split(",").filter((x) => x.trim() !== "").length;
    expect(count, `矩阵 shard 个数(${count}) 必须等于 --shard 分母(${denom?.[1]})`).toBe(Number(denom?.[1]));
  });

  it("③ ★ 调包用例：分母与矩阵不一致 ⇒ 必须变红", () => {
    // 真实事故形态：改了矩阵没改命令（或反之）⇒ 覆盖不全但 CI 全绿。
    const swapped = CI.replace(/--shard=\$\{\{ matrix\.shard \}\}\/3/, "--shard=${{ matrix.shard }}/4");
    expect(swapped, "前置：调包确实改了配置").not.toBe(CI);
    const list = /shard:\s*\[([^\]]+)\]/.exec(swapped);
    const denom = /--shard=\$\{\{ matrix\.shard \}\}\/(\d+)/.exec(swapped);
    const count = (list?.[1] ?? "").split(",").filter((x) => x.trim() !== "").length;
    // 这条断言必须失败（即门禁有牙）：矩阵 3 个 vs 分母 4。
    expect(count, "★ 不一致必须被这条用例本身抓到").not.toBe(Number(denom?.[1]));
  });

  it("④ 非 test 门禁必须只在 1 个分片上跑（否则同一份工作重复 3 遍）", () => {
    // 逐个门禁检查：有 `if: matrix.shard == 1` 才算合格。
    for (const name of ["typecheck", "lint", "lint:arch", "check:tmpdir", "check:sync-in-callback", "check:comment-refs", "check:web build", "check:web version", "check:web bundle ratchet"]) {
      // 取该步骤名之后的两行（步骤体内），检查紧随其后的条件。
      const idx = CI.indexOf(`- name: ${name}\n`);
      expect(idx, `必须存在步骤 ${name}`).toBeGreaterThan(-1);
      const body = CI.slice(idx, idx + 120);
      expect(body, `${name} 必须只在 shard 1 上跑`).toContain("if: ${{ matrix.shard == 1 }}");
    }
  });

  it("⑤ test 步骤必须真的分片（不得退回全量）", () => {
    expect(CI, "test 步骤必须带 --shard").toMatch(/vitest run --shard=\$\{\{ matrix\.shard \}\}\/\d+/);
    // 且不得同时存在不分片的 `pnpm test` 步骤（那会把全量又跑一遍）。
    expect(CI, "不得再有整跑 pnpm test 的步骤").not.toMatch(/run-gate\.mjs test -- pnpm test/);
  });
});