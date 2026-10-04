#!/usr/bin/env node
/**
 * check-json-dup-keys.mjs — 重复键门禁（判据与来历见 scripts/lib/json-dup-keys.mjs 的文件头）。
 *
 * 口径：
 *  - 枚举带 --others（**含未跟踪**）：只扫 git ls-files 会看不见新写的文件，而
 *    「新写的文件里撞了旧键」正是本门禁最该抓的形态（W9225 的教训）。
 *  - 只查合法 JSON（解析不过的文件不由本门禁负责）。
 *  - **不扫** results/ tmp/ node_modules/ 等草稿与产物树：它们不是本仓源码，
 *    而且里面大多是抓来的第三方 JSON。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { scanDuplicateKeys } from "./lib/json-dup-keys.mjs";

/** 只看这些前缀下的 JSON（以及仓库根的单个 JSON）。 */
const ROOTS = ["packages/", "apps/", "contracts/", "scripts/", "tests/", "benchmarks/"];

function files() {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.json"], { encoding: "utf8" });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .filter((l) => !l.includes("/") || ROOTS.some((r) => l.startsWith(r)));
}

/**
 * 位置参数 = **显式文件清单**（测试 seam）。不传就走 git 枚举。
 * 有它测试才能对着**临时 fixture** 端到端跑真命令，而不是 import 一个内部函数 ——
 * 后者需要为 .mjs 补 .d.mts，而且测的不是门禁真正执行的那条路径。
 */
const explicit = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const list = explicit.length > 0 ? explicit : files();

const failures = [];
let scanned = 0;
for (const file of list) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  scanned += 1;
  try { JSON.parse(text); } catch { continue; }
  let dups;
  try { dups = scanDuplicateKeys(text); } catch { continue; }
  for (const d of dups) failures.push({ file: file, path: d.path, key: d.key, first: d.first, again: d.again });
}

if (failures.length > 0) {
  console.error("");
  console.error("✗ JSON 里有重复键：JSON.parse 不报错、取**最后一条**，被遮蔽的那条会静默消失。");
  console.error("");
  for (const f of failures) {
    console.error("  " + f.file);
    console.error("      键 " + JSON.stringify(f.key) + "（路径 " + f.path + "）：第一次偏移 " + f.first + "，又出现在 " + f.again);
  }
  console.error("");
  console.error("  为什么这是错的：重复键既没有类型错误、也没有 lint 规则、也没有别的门禁会红 ——");
  console.error("  它是纯静默的数据丢失，而写那两条键的人**都以为自己的内容在文件里**。");
  console.error("  修法：给其中一条换一个键名（本项目 note 类键按最大号 +1 递增）。");
  process.exit(1);
}
console.log("✓ JSON 重复键门禁通过（扫 " + scanned + " 个 JSON，0 处重复键）");
