// @vitest-environment node
/**
 * W2062 · `run_code` 的失败消息必须**可操作**，且形态提示不许再把模型推向 `function main()`。
 *
 * ## 真实事故（2026-09-28，生产）
 *
 * 模型写了这样一段（结尾少一个 `}`）：
 *
 *     function main() {
 *       const out = [];
 *       for (const c of ["echo A", "echo B", "echo C"]) { ... }
 *       return { looped: out, ... };      <- main() 的 } 没了
 *
 * 因为程序以 `function main() {` 开头，`definesEntryPoint()` 判为 script ⇒
 * **原样输出、不做包裹** ⇒ 缺的 `}` 直接传播进生成文件 ⇒ Node 报
 * `Expected '}', got '<eof>'`。引擎**正确**归类为 `program_syntax`，
 * 但消息只是转述解释器原文 —— 模型看不出「缺一个 }」，也看不出
 * 「改用裸语句就根本不用配平」。它重试三次后把工具报成「不确定」。
 *
 * ## 本文件钉住三件事
 *
 * 1. **消息要数得出缺几个** —— 不平衡时报出计数，平衡时**不许**出现该提示；
 * 2. **消息要给退路** —— 明确说「去掉 function main() { 与配对的 }，改用裸语句」；
 * 3. **给模型看的四处文本不许再把人推向手写 main** —— 推荐形态必须是裸语句。
 *
 * 判据是**文本与计数**，不是「某函数被调用过」：一个把 hint 删掉的实现会让
 * ① 红；一个把推荐形态改回 main 的实现会让 ③ 红。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyProgramFailure, netBracketDepth } from "./program-failure.js";
import { runCodeSpec } from "../tools/run-code.js";

const REPO = process.cwd();
const NODE_EOF_STDERR =
  "file:///tmp/run_code_1_0.mts:268\n" +
  "SyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]: Expected '}', got '<eof>'";

/** The program from the production report, verbatim (missing the final `}`). */
const UNBALANCED = [
  "function main() {",
  "  const out = [];",
  '  for (const c of ["echo A", "echo B", "echo C"]) {',
  "    out.push(tools.run_shell({ command: c }).stdout.trim());",
  "  }",
  "  return { looped: out };",
].join("\n");

const BALANCED = UNBALANCED + "\n}";

describe("W2062 · program_syntax 的失败消息必须可操作", () => {
  it("① 不平衡的程序：消息报出缺几个括号", () => {
    const failure = classifyProgramFailure("typescript", NODE_EOF_STDERR, UNBALANCED);
    expect(failure?.kind).toBe("program_syntax");
    expect(failure?.message).toContain("1 unclosed");
    expect(failure?.message).toContain("missing a closing brace");
  });

  it("② 不平衡的程序：消息给出「改用裸语句」的退路", () => {
    const failure = classifyProgramFailure("typescript", NODE_EOF_STDERR, UNBALANCED);
    const msg = failure?.message ?? "";
    expect(msg).toContain("function main() {");
    expect(msg).toMatch(/DROP that wrapper/);
    expect(msg).toContain("the engine wraps it for you");
  });

  it("③ 平衡的程序：不许出现「缺括号」的假警报", () => {
    // ★ 这条与 ① 同等重要：一个「总是报缺括号」的实现会让每个语法错误都带上
    //   误导性的计数，模型会去数一个其实平衡的程序。
    const failure = classifyProgramFailure("typescript", NODE_EOF_STDERR, BALANCED);
    expect(failure?.message).not.toContain("unclosed");
    expect(failure?.message).toContain("Expected '}', got '<eof>'");
  });

  it("④ 没给源码时（旧调用点）：退回原消息，不崩、不编造", () => {
    const failure = classifyProgramFailure("typescript", NODE_EOF_STDERR);
    expect(failure?.kind).toBe("program_syntax");
    expect(failure?.message).not.toContain("unclosed");
  });

  it("⑤ 计数把字符串/注释/模板里的括号排除在外（不许假警报）", () => {
    expect(netBracketDepth("const a = '{';")).toBe(0);
    expect(netBracketDepth('const a = "{";')).toBe(0);
    expect(netBracketDepth("const a = `{`;")).toBe(0);
    expect(netBracketDepth("// {\nconst a = 1;")).toBe(0);
    expect(netBracketDepth("/* { */\nconst a = 1;")).toBe(0);
    // 反例：真的不平衡必须被数出来。
    expect(netBracketDepth("function f() {")).toBe(1);
    expect(netBracketDepth("const a = [1, 2;")).toBe(1);
  });

  it("⑥ 转义引号里的括号也不许误计", () => {
    // `"a\\"{"` 是「一个含引号的字符串」，其后没有真括号。
    expect(netBracketDepth('const a = "x\\"{";')).toBe(0);
  });
});

describe("W2062 · 给模型看的文本推荐的是裸语句（不是手写 main）", () => {
  it("⑦ code 参数的描述以「推荐裸语句」开头，并说明不用配平", () => {
    const spec = runCodeSpec();
    const code = (spec.parameters as { properties: Record<string, { description: string }> }).properties.code!;
    expect(code.description).toContain("RECOMMENDED");
    expect(code.description).toContain("do NOT write the wrapper");
    expect(code.description).toMatch(/no braces for you to balance/);
  });

  it("⑧ 主描述把裸语句列为第一推荐，且点明手写 main 的括号是自己的责任", () => {
    const spec = runCodeSpec();
    expect(spec.description).toContain("★PREFER a PLAIN SCRIPT");
    expect(spec.description).toMatch(/ITS braces are yours to balance/);
  });

  it("⑨ 注入进程序文件的 SDK 前言同样说「没有要配平的包裹括号」", () => {
    const sdk = readFileSync(
      join(REPO, "packages/tools/src/run-code/sdk-ts.ts"),
      "utf8",
    );
    expect(sdk).toMatch(/NO wrapper braces for you to/);
    expect(sdk).toMatch(/ITS braces are yours/);
  });
});
