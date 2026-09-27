/**
 * W2012 — the `run_code` program FORM and the syntax-failure vocabulary.
 *
 * Two production-measured defects are pinned here:
 *
 * 1. **Form by indentation.** `assembleProgram` decided "function body" vs
 *    "complete script" from whether the first line was indented. The natural
 *    quick script is NOT indented, so 114/549 real calls (0% success) took the
 *    "script" branch, defined no `main`, and failed. A main-less program is now
 *    wrapped regardless of layout; only a program that genuinely runs at module
 *    top level keeps the script treatment.
 * 2. **Syntax errors reported as `aborted`.** A program that does not parse
 *    never reaches the SDK runner, so it emits no `__error__` line and the
 *    broker fell through to `code=aborted` ("program exited code=1 … without a
 *    final line") — the vocabulary of timeouts. The model then debugged
 *    infrastructure instead of its own missing brace.
 *
 * Every expectation below is DERIVED FROM A REAL RUN (the real broker, the real
 * userspace sandbox, the real Node/CPython), not from string assembly alone; the
 * assembly-level assertions are additional, not instead.
 */

import type { Tool, ToolExecOutcome } from "@celestea/core";
import { afterAll, describe, expect, it } from "vitest";

import {
  assembleProgram,
  classifyProgramFailure,
  definesEntryPoint,
  firstNonblankLineIndented,
  hoistLeadingImports,
  importedNames,
  programLayout,
  RUN_CODE_RUNNER_TS,
} from "./sdk.js";
import { startBrokerHarness, type BrokerHarness } from "./broker.test-util.js";

const h: BrokerHarness = await startBrokerHarness();
afterAll(async () => {
  await h.cleanup();
});

const run = (tool: Tool, callId: string, args: unknown): Promise<ToolExecOutcome> =>
  h.run(tool, callId, args) as Promise<ToolExecOutcome>;
const tool = (): Tool => h.mount(h.echoRegistry());

/**
 * The failure of a call that must NOT succeed, with its structured code.
 *
 * `ToolFailure.kind` is the pipeline's own code and the `code=` inside the
 * message is the contract rendering; they agree on every run_code failure, so
 * the kind is read first and the text is the fallback.
 */
async function failure(callId: string, args: unknown): Promise<{ code: string; message: string }> {
  try {
    const out = await run(tool(), callId, args);
    throw new Error("expected a failure, got value=" + JSON.stringify(out.value));
  } catch (error) {
    const message = (error as Error).message;
    const kind = (error as { kind?: unknown }).kind;
    const match = /code=([a-z_]+)/.exec(message);
    return { code: match?.[1] ?? (typeof kind === "string" ? kind : "(none)"), message };
  }
}

// ---- 1. the forms, executed for real -----------------------------------------

describe.skipIf(!h.nodeReady)("W2012 · every program form runs (real Node, real broker)", () => {
  it("indented body (the documented form) still works", async () => {
    const out = await run(tool(), "w2012-indented", { code: "  const a = 1;\n  return { a };\n" });
    expect(out.value).toEqual({ a: 1 });
  });

  it("★ non-indented, main-less quick script now works (was 114/114 failures)", async () => {
    // The exact shape from the production log: helpers, a result object, return.
    const code = [
      "const sh = (c: string) => tools.run_shell({ command: c });",
      "const out: Record<string, unknown> = {};",
      'out.pwd = sh("pwd");',
      "return out;",
    ].join("\n");
    const out = await run(tool(), "w2012-quick", { code });
    expect(out.value).toEqual({ pwd: { echo: "run_shell", args: { command: "pwd" } } });
  });

  it("non-indented script defining function main", async () => {
    const out = await run(tool(), "w2012-fn", { code: "function main() { return { form: 'fn' }; }\n" });
    expect(out.value).toEqual({ form: "fn" });
  });

  it("non-indented script defining const main = async () =>", async () => {
    const out = await run(tool(), "w2012-const", { code: "const main = async () => ({ form: 'const' });\n" });
    expect(out.value).toEqual({ form: "const" });
  });

  it("non-indented script defining async function main", async () => {
    const out = await run(tool(), "w2012-async", { code: "async function main() { return { form: 'async' }; }\n" });
    expect(out.value).toEqual({ form: "async" });
  });

  it("top-level await without main is still a script (not wrapped)", async () => {
    const out = await run(tool(), "w2012-await", {
      code: "const value = await Promise.resolve({ form: 'tla' });\nconst main = async () => value;\n",
    });
    expect(out.value).toEqual({ form: "tla" });
  });

  it("import + quick script: the imports are hoisted above the wrapper", async () => {
    const code = [
      'import { basename } from "node:path";',
      "",
      "const out = tools.run_shell({ command: 'echo hi' });",
      "return { base: basename('/a/b.txt'), out };",
    ].join("\n");
    const out = await run(tool(), "w2012-import", { code });
    expect(out.value).toEqual({ base: "b.txt", out: { echo: "run_shell", args: { command: "echo hi" } } });
  });

  it("import used inside a function declared in the body sees the hoisted binding", async () => {
    const code = [
      'import { basename } from "node:path";',
      "function pick(p: string) { return basename(p); }",
      "return { base: pick('/x/y.txt') };",
    ].join("\n");
    const out = await run(tool(), "w2012-import-fn", { code });
    expect(out.value).toEqual({ base: "y.txt" });
  });

  it("a script that ends the program itself (process.exit) is not a failure", async () => {
    const out = await run(tool(), "w2012-exit", { code: 'console.log("done");\nprocess.exit(0);\n' });
    expect(out.value).toBeNull();
    expect(out.render).toContain("done");
  });

  it.skipIf(!h.pythonReady)("Python: non-indented main-less body is wrapped and works (was unsupported)", async () => {
    const code = 'x = tools.read_file(path="/tmp/x")\nreturn x["echo"]\n';
    const out = await run(tool(), "w2012-py", { code, language: "python" });
    expect(out.value).toBe("read_file");
  });

  it.skipIf(!h.pythonReady)("Python: import-first body keeps its import at module scope", async () => {
    const code = 'import json\npayload = {"a": 1}\nreturn json.dumps(payload)\n';
    const out = await run(tool(), "w2012-py-import", { code, language: "python" });
    expect(out.value).toBe('{"a": 1}');
  });
});

// ---- 2. syntax failures are diagnosable, never "aborted" ---------------------

describe.skipIf(!h.nodeReady)("W2012 · a program that does not parse is code=program_syntax", () => {
  it("★ a missing closing brace names the cause and is NOT aborted", async () => {
    const { code, message } = await failure("w2012-brace", { code: "async function main() {\n  return 1;\n" });
    expect(code).toBe("program_syntax");
    expect(code).not.toBe("aborted");
    // The interpreter's own words survive into the failure (that is the fix).
    expect(message).toContain("not valid typescript");
    expect(message).toContain("Expected '}', got '<eof>'");
    expect(message).toContain("ERR_INVALID_TYPESCRIPT_SYNTAX");
  });

  it("★ a wrapped quick script with a typo is program_syntax too", async () => {
    const { code, message } = await failure("w2012-body-brace", { code: "const a = (1;\nreturn a;\n" });
    expect(code).toBe("program_syntax");
    // The interpreter names the exact token it wanted (measured: "Expected ',', got ';'").
    expect(message).toContain("Expected ");
  });

  it("a top-level return in a SCRIPT (not a body) is named as invalid, not aborted", async () => {
    // `const x = await …` is a script (module scope is where await is legal);
    // the stray top-level `return` is then the interpreter's own complaint.
    const { code, message } = await failure("w2012-toplevel-return", {
      code: "const x = await Promise.resolve(1);\nreturn x;\n",
    });
    expect(code).toBe("program_syntax");
    expect(message).toContain("Return statement is not allowed here");
  });

  it.skipIf(!h.pythonReady)("Python: a missing colon is program_syntax with the raw text", async () => {
    const { code, message } = await failure("w2012-py-colon", { code: "async def main()\n    return 1\n", language: "python" });
    expect(code).toBe("program_syntax");
    expect(code).not.toBe("aborted");
    expect(message).toContain("SyntaxError");
    expect(message).toContain("expected ':'");
  });

  it("an unexplained death with no evidence stays aborted (no over-classification)", async () => {
    // A wrapped body that kills its own process: no protocol line, empty stderr.
    const { code } = await failure("w2012-aborted", { code: "process.exit(3);\nreturn 1;\n" });
    expect(code).toBe("aborted");
  });

  it("a main-less SCRIPT names the missing entry point and is NOT aborted", async () => {
    // This one reaches the runner (a top-level await is a legal script), so the
    // child emits `__error__` and the broker reports that text verbatim — the
    // point is that it says WHAT is missing instead of `code=aborted`.
    const { code, message } = await failure("w2012-nomain", { code: "const x = await Promise.resolve(1);\n" });
    expect(code).not.toBe("aborted");
    expect(message).toContain("without defining 'main'");
  });
});

// ---- 3. the classifier itself (unit) ----------------------------------------

describe("W2012 · classifyProgramFailure keys on the interpreter's own markers", () => {
  const NODE_BRACE = "node:internal/modules/run_main:111\n\nSyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]: Expected '}', got '<eof>'\n    at parseTypeScript";
  const PY_COLON = '  File "/tmp/p.py", line 179\n    async def main()\n                    ^\nSyntaxError: expected \':\'';

  it("classifies Node's syntax markers as program_syntax with the raw line", () => {
    const failure = classifyProgramFailure("typescript", NODE_BRACE);
    expect(failure?.kind).toBe("program_syntax");
    expect(failure?.message).toContain("Expected '}', got '<eof>'");
  });

  it("classifies CPython's SyntaxError as program_syntax", () => {
    expect(classifyProgramFailure("python", PY_COLON)?.kind).toBe("program_syntax");
  });

  it("classifies the engine's no-main guard as program_error", () => {
    const text = "Error: run_code: the program finished without defining 'main' - write it as a function body";
    expect(classifyProgramFailure("typescript", text)?.kind).toBe("program_error");
  });

  it("returns null when stderr explains nothing (the caller keeps `aborted`)", () => {
    expect(classifyProgramFailure("typescript", "")).toBeNull();
    expect(classifyProgramFailure("typescript", "some log line\n")).toBeNull();
    expect(classifyProgramFailure("python", "Killed\n")).toBeNull();
  });

  it("a Python import failure is the program's bug, named as such", () => {
    const text = 'Traceback (most recent call last):\nModuleNotFoundError: No module named "requests"';
    const failure = classifyProgramFailure("python", text);
    expect(failure?.kind).toBe("program_error");
    expect(failure?.message).toContain("standard library only");
  });
});

// ---- 4. the form rule (unit) -------------------------------------------------

describe("W2012 · programLayout decides form by what the program IS", () => {
  it("a main-less, non-indented program is a BODY (the fix)", () => {
    expect(programLayout("const a = 1;\nreturn a;\n", "typescript").form).toBe("body");
    expect(programLayout("x = 1\nreturn x\n", "python").form).toBe("body");
  });

  it("an indented program is a BODY (unchanged)", () => {
    expect(programLayout("  return 1;\n", "typescript").form).toBe("body");
    expect(firstNonblankLineIndented("\n\n\tfoo()")).toBe(true);
  });

  it("every main declaration is a SCRIPT", () => {
    for (const code of [
      "function main() { return 1; }\n",
      "async function main() { return 1; }\n",
      "function* main() { return 1; }\n",
      "const main = () => 1;\n",
      "let main = () => 1;\n",
      "var main = () => 1;\n",
    ]) {
      expect(programLayout(code, "typescript").form, code).toBe("script");
      expect(definesEntryPoint(code, "typescript")).toBe(true);
    }
    for (const code of ["def main():\n    return 1\n", "async def main():\n    return 1\n"]) {
      expect(programLayout(code, "python").form, code).toBe("script");
    }
  });

  it("a top-level await / export / bare call keeps the script treatment", () => {
    expect(programLayout("const x = await f();\n", "typescript").form).toBe("script");
    expect(programLayout("export const a = 1;\n", "typescript").form).toBe("script");
    expect(programLayout("main();\n", "typescript").form).toBe("script");
  });

  it("an import-FIRST program is a body when the import block can be hoisted", () => {
    expect(programLayout('import { basename } from "node:path";\nreturn basename("/a");\n', "typescript").form).toBe("body");
    expect(programLayout('import "node:fs";\nreturn 1;\n', "typescript").form).toBe("body");
  });

  it("an import this module refuses to hoist falls back to the script treatment", () => {
    const layout = programLayout('import {\n  a,\n} from "x";\nconst b = 1;\nreturn { a, b };\n', "typescript");
    expect(layout.form).toBe("script");
    // The refusal is recorded, but NOT as a comment in the emitted program: a
    // script is emitted verbatim, and a comment there would be a lie about what
    // the engine did.
    expect(layout.hoistNote).toContain("multi-line or dynamic import");
    expect(assembleProgram(layout.code, "typescript")).not.toContain("// [run_code]");
  });

  it("a mere CALL to main() is not a definition", () => {
    expect(definesEntryPoint("const x = computeMain();\n", "typescript")).toBe(false);
    expect(definesEntryPoint("// main() is called below\nreturn 1;\n", "typescript")).toBe(false);
  });
});

describe("W2012 · import hoisting (the one hard boundary)", () => {
  it("hoists a leading import block and reports the names it binds", () => {
    const code = 'import { a, b as c } from "x";\nimport * as ns from "y";\nimport d from "z";\nreturn { a, c, ns, d };\n';
    const hoisted = hoistLeadingImports(code);
    expect(hoisted.imports).toBe('import { a, b as c } from "x";\nimport * as ns from "y";\nimport d from "z";\n');
    expect(hoisted.rest).toBe("return { a, c, ns, d };");
    expect(hoisted.names).toEqual(["a", "c", "ns", "d"]);
    expect(hoisted.note).toBeNull();
  });

  it("skips type-only specifiers (they bind nothing at runtime)", () => {
    expect(importedNames('import { type A, b } from "x";')).toEqual(["b"]);
  });

  it("hoists a single-line side-effect import (leaving it inside would be a SyntaxError)", () => {
    const hoisted = hoistLeadingImports('import "node:fs";\nconst a = 1;\nreturn a;\n');
    expect(hoisted.imports).toBe('import "node:fs";\n');
    expect(hoisted.names).toEqual([]);
    expect(hoisted.rest).toBe("const a = 1;\nreturn a;");
    expect(hoisted.note).toBeNull();
  });

  it("refuses a multi-line import block (guessing where it ends is unsafe)", () => {
    const code = 'import {\n  a,\n} from "x";\nconst b = 1;\nreturn { a, b };\n';
    const hoisted = hoistLeadingImports(code);
    expect(hoisted.imports).toBe("");
    expect(hoisted.note).toContain("multi-line or dynamic import");
    expect(hoisted.rest).toBe(code);
  });

  it("refuses to hoist when the body rebinds an imported name (TDZ/duplicate)", () => {
    const code = 'import { join } from "node:path";\nconst join = (a: string) => a;\nreturn join("x");\n';
    const hoisted = hoistLeadingImports(code);
    expect(hoisted.imports).toBe("");
    expect(hoisted.note).toContain("also binds join");
  });

  it("refuses to hoist when the body binds a name twice (shadowing)", () => {
    const code = 'import { a } from "x";\nconst b = 1;\nconst b = 2;\nreturn a + b;\n';
    expect(hoistLeadingImports(code).note).toContain("more than once");
  });

  it("hoists nothing when the program does not start with an import", () => {
    const hoisted = hoistLeadingImports("const a = 1;\nreturn a;\n");
    expect(hoisted.imports).toBe("");
    expect(hoisted.note).toBeNull();
  });

  it("a refused hoist never leaves the program looking wrapped", () => {
    // The program stays a SCRIPT: it is emitted verbatim, so nothing pretends
    // the imports moved (the interpreter reports the real problem instead).
    const program = assembleProgram('import {\n  a,\n} from "x";\nconst b = 1;\nreturn { a, b };\n', "typescript");
    expect(program).not.toContain("async function main() {\nimport {");
    expect(program).toContain('import {\n  a,\n} from "x";');
  });
});

// ---- 5. assembly layout ------------------------------------------------------

describe("W2012 · assembleProgram lays every form out correctly", () => {
  it("wraps a non-indented main-less body", () => {
    const program = assembleProgram("const a = 1;\nreturn a;\n", "typescript");
    expect(program).toContain("async function main() {\nconst a = 1;\nreturn a;\n}\n");
    expect(program.endsWith(RUN_CODE_RUNNER_TS)).toBe(true);
  });

  it("emits a script verbatim (no wrapper)", () => {
    const program = assembleProgram("function main() { return 1; }\n", "typescript");
    expect(program).not.toContain("async function main() {\nfunction main");
    expect(program).toContain("function main() { return 1; }");
  });

  it("places hoisted imports BEFORE the wrapper and the wrapper before the runner", () => {
    const program = assembleProgram('import { basename } from "node:path";\nreturn basename("/a");\n', "typescript");
    const imported = program.indexOf('import { basename } from "node:path";');
    const wrapper = program.indexOf("async function main() {");
    const runner = program.indexOf(RUN_CODE_RUNNER_TS);
    expect(imported).toBeGreaterThan(0);
    expect(imported).toBeLessThan(wrapper);
    expect(wrapper).toBeLessThan(runner);
  });

  it("Python: a non-indented body is indented into async def main()", () => {
    const program = assembleProgram("x = 1\nreturn x\n", "python");
    expect(program).toContain("async def main():\n    x = 1\n    return x\n");
  });

  it("Python: module-level def/import are lifted, body lines are indented", () => {
    const program = assembleProgram("import json\ndef helper():\n    return 1\nreturn json.dumps(helper())\n", "python");
    expect(program).toContain("import json\n");
    expect(program).toContain("def helper():\n");
    expect(program).toContain("async def main():\n");
    expect(program).toContain("    return json.dumps(helper())");
  });
});
