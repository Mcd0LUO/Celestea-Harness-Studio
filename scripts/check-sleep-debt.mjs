#!/usr/bin/env node
/**
 * W9225 · 「测试里不许用 sleep 赌时长」的门禁（棘轮）。
 *
 * 为什么需要它：本仓 CI（ubuntu + windows）两次变红，根因都是
 * **测试用真实定时器时长造前提**，而定时器粒度随平台变：
 *   · w833-adapter-payload：睡 60ms 后断言「仍忙」。忙窗口 = 帧数 × deltaMs，
 *     Windows setTimeout(3) ≈ 17ms（窗口 275ms）、Linux 精确 3ms（窗口 48ms）⇒ Linux 必红。
 *   · w9206-security-fixes：循环 60 次赌 EPIPE 先于 exit(0)。Windows 60×15ms 够，
 *     Linux 60×1ms 抢跑 ⇒ 退出码 0 ⇒ 必红。
 * Martin Fowler 原话：however long you sleep, sometimes it won't be enough。
 *
 * 本门禁**不是**禁止所有 sleep —— 那是错的，会逼人写假测试。它只禁一种：
 * **sleep 之后紧跟一个「断言某物存在/为真」的 expect**。
 * 那种写法表达的是「等它发生」，应当写成 until(() => 条件, '描述')。
 *
 * 而「sleep 后断言某物**不存在**」（例如 expect(frames).toEqual([])）是**合法**的：
 * 要证明「什么都没发生」，必须有界地等一段真实时间，没有可轮询的条件。
 * 这类必须在上一行写 W9225 注释说明理由。
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** 「断言不存在」的形态：这些**不算**债务（有界地证明什么都没发生）。 */
const ABSENCE_ASSERTIONS = [
  /toEqual\(\[\]\)/,
  /toHaveLength\(0\)/,
  /toBe\(0\)/,
  /toBe\(false\)/,
  /toBe\(null\)/,
  /toBeUndefined\(\)/,
  /not\.toBe\(true\)/,
  /not\.toHaveLength\(/,
  /not\.toContain\(/,
];

/** sleep 行的形状（只认真实时长 > 0；setTimeout(r, 0) 是排空微任务，不算）。 */
const SLEEP_RE = /await new Promise\(\(r\) => setTimeout\(r, ([1-9][0-9]*)\)\)/;
/** 豁免标记：同一行或上一行出现它，即视为已说明「为何必须等时长」。 */
const ALLOW_MARKER = /W9225/;

function files() {
  const out = execFileSync("git", ["ls-files", "*.test.ts"], { encoding: "utf8" });
  return out.split("\n").filter((l) => l.trim() !== "");
}

const failures = [];
let scanned = 0;
let allowed = 0;

for (const file of files()) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!SLEEP_RE.test(line)) continue;
    scanned += 1;
    if (ALLOW_MARKER.test(line) || (i > 0 && ALLOW_MARKER.test(lines[i - 1]))) {
      allowed += 1;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && /^\s*(\/\/|\*|\/\*|$)/.test(lines[j])) j += 1;
    const next = lines[j] ?? "";
    const isExpect = /\bexpect\(/.test(next);
    const isAbsence = ABSENCE_ASSERTIONS.some((re) => re.test(next));
    if (isExpect && !isAbsence) {
      failures.push({ file, line: i + 1, next: next.trim(), kind: "sleep→assert-exists" });
      continue;
    }
    // W9225 补充规则（我第一版漏掉的形态）：sleep 之后紧跟**文件系统读取**，
    // 而下一句是断言。这是「等某个东西被写出来」的另一种写法，同样是赌时长。
    // 真实案例：recovery-view.test.ts:113 —— 睡 50ms 后 readFileSync(checkpoint.json) // W9323 豁免：刻意的出处
    // 再断言，门禁第一版只看向下一行，所以漏了它。
    const READ_RE = /\b(readFileSync|existsSync|readdirSync|statSync)\s*\(/;
    if (READ_RE.test(next)) {
      for (let k = j + 1; k <= j + 2 && k < lines.length; k += 1) {
        const after = lines[k] ?? "";
        if (/\bexpect\(/.test(after)) {
          failures.push({ file, line: i + 1, next: next.trim(), kind: "sleep→read→assert" });
          break;
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error("\n✗ 测试用 sleep 赌时长（W9225）：sleep 之后紧跟着「断言存在」的 expect。\n");
  for (const f of failures) {
    console.error("  " + f.file + ":" + f.line);
    console.error("      [" + f.kind + "] 后紧跟：" + f.next.slice(0, 90));
  }
  console.error("\n  为什么这是错的：sleep 表达「大概够了吧」，而真实定时器粒度随平台变");
  console.error("  （Windows ~15ms、Linux 精确）—— 本仓已有两个 ubuntu CI 事故由此而来。");
  console.error("  正确写法：await until(() => 条件, '描述')   // 等条件，不等时间");
  console.error("  若确需有界地等一段真实时间（例如断言「什么都没发生」），");
  console.error("  在上一行加 W9225 注释说明理由即可豁免。");
  process.exit(1);
}

console.log("✓ sleep 债务门禁通过（扫描 " + scanned + " 处真实 sleep，" + allowed + " 处有 W9225 豁免说明）");
