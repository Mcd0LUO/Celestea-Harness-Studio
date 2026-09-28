// @vitest-environment node
/**
 * W2060 · the program FORM must be decided by TOKENS, not by a word in the text.
 *
 * ## The defect (independently reproduced here, real broker + real node child)
 *
 * `startsAtModuleTop` used to ask
 *
 *     /(?:^|[^\w$])(?:await|import|export)\b/.test(rest-of-program)
 *
 * i.e. "does the word appear ANYWHERE in the remaining text". A bare statement
 * list that merely awaited something — in a loop body, in a function body, in a
 * string, in a comment — was therefore emitted VERBATIM as a "script", and its
 * top-level `return` became `SyntaxError: Return statement is not allowed here`.
 *
 * That is the shape the tool's own contract RECOMMENDS ("★PREFER a PLAIN SCRIPT:
 * a bare sequence of statements ending in `return <value>`") and the SDK
 * preamble explicitly blesses ("`await tools.<name>({...})` is the same thing
 * (awaiting a value is free)"). The engine contradicted its own documentation.
 *
 * ## The rule now
 *
 * A word counts only when it is a real token AT MODULE TOP LEVEL: bracket depth 0
 * and not the body of a brace-less arrow. Strings, comments and templates are
 * skipped.
 *
 * ## W2063 superseded the `await` half of that rule
 *
 * W2060 also kept ONE `await` operand as evidence of module scope: a genuine
 * top-level await (as opposed to `await tools.<name>(…)`, the engine's
 * synchronous bridge). **W2063 removed that**, because its justification was
 * false: the wrapper is `async function main()`, so a top-level `await` is legal
 * inside it. A genuine top-level await is now a BODY, like every other await —
 * see `w2063-await-not-script.test.ts`, which measures the real broker. The
 * cases below were re-pointed accordingly; the module-only STATEMENTS (`export`,
 * non-leading `import`) and the first-line bare call are untouched and still
 * select the script form.
 *
 * ## What this file pins
 *
 * 1. the two shapes that were broken now RUN (A: first-line await assignment,
 *    B: await inside a loop body) — and the control C, which never broke;
 * 2. the genuine module-top-level await is a BODY too (W2063), and the forms
 *    that CANNOT be wrapped still select the script form;
 * 3. the unit matrix of the boundary, including the approximations this scanner
 *    deliberately makes (a regex literal is not modelled — pinned as a test).
 *
 * Every e2e expectation is DERIVED FROM A REAL RUN: real broker, real userspace
 * sandbox, real Node subprocess, real line protocol. The raw code and the raw
 * outcome are printed, so a reader can see what the engine actually did.
 */

import type { Tool, ToolExecOutcome } from "@celestea/core";
import { afterAll, describe, expect, it } from "vitest";

import { assembleProgram, definesEntryPoint, programLayout } from "./sdk.js";
import { startBrokerHarness, type BrokerHarness } from "./broker.test-util.js";

const h: BrokerHarness = await startBrokerHarness();
afterAll(async () => {
  await h.cleanup();
});

const run = (tool: Tool, callId: string, args: unknown): Promise<ToolExecOutcome> =>
  h.run(tool, callId, args) as Promise<ToolExecOutcome>;
/** `run_shell` answers the run_shell result dict; the other three echo their args. */
const shellTool = (): Tool => h.mount(h.shellRegistry());

/** Run a program and return the RAW outcome (value or the full failure text). */
async function outcome(callId: string, args: unknown): Promise<{ ok: boolean; text: string }> {
  try {
    const out = await run(shellTool(), callId, args);
    return { ok: true, text: "value=" + JSON.stringify(out.value) + " render=" + JSON.stringify(out.render) };
  } catch (error) {
    const failure = error as Error & { kind?: unknown };
    return { ok: false, text: "kind=" + String(failure.kind) + " message=" + failure.message };
  }
}

/** Print the program and what the real engine did with it (the evidence). */
async function measure(callId: string, code: string): Promise<{ ok: boolean; text: string; form: string }> {
  const form = programLayout(code, "typescript").form;
  const result = await outcome(callId, { code });
  console.log("\n### " + callId + "  form=" + form + "\n--- code ---\n" + code + "--- outcome ---\n" + result.text);
  return { ...result, form };
}

// ---- the four programs, verbatim ---------------------------------------------

/** A: bare statement list whose FIRST LINE awaits the engine's synchronous bridge. */
const PROGRAM_A = "const r = await tools.run_shell({ command: 'echo hi' });\nreturn r.stdout.trim();\n";
/** B: bare statement list whose `await` sits inside a LOOP BODY (depth > 0). */
const PROGRAM_B =
  "const out = [];\nfor (const c of ['a', 'b']) { out.push(await tools.run_shell({ command: 'echo ' + c })); }\nreturn out.length;\n";
/** C: the control — the same program as A without `await` (never broke). */
const PROGRAM_C = "const r = tools.run_shell({ command: 'echo hi' });\nreturn r.stdout.trim();\n";
/** TLA: a GENUINE module-top-level await (a real promise) + a stray top-level return. */
const PROGRAM_TLA = "const x = await Promise.resolve(1);\nreturn x;\n";
/** TLA2: the same, awaiting an ordinary helper — the brief's "真正的 TLA" shape. */
const PROGRAM_TLA2 = "const x = await helper();\nreturn x;\n";
/** W2063: an `export` statement — module-only, so genuinely NOT wrappable. */
const PROGRAM_EXPORT = "export const x = 1;\nreturn x;\n";
/** W2063: an export whose initializer awaits — still module-only. */
const PROGRAM_EXPORT_AWAIT = "export const x = await Promise.resolve(1);\nreturn x;\n";

describe.skipIf(!h.nodeReady)("W2060 · real broker: the forms that were misjudged now run", () => {
  it("A: bare + await (first-line assignment) + return ⇒ SUCCESS (was program_syntax)", async () => {
    const { ok, text, form } = await measure("w2060-a", PROGRAM_A);
    expect(form).toBe("body");
    expect(text, text).not.toContain("Return statement is not allowed here");
    expect(ok, text).toBe(true);
    expect(text).toContain('"hi"');
  }, 60_000);

  it("B: bare + await (inside a loop body) + return ⇒ SUCCESS (was program_syntax)", async () => {
    const { ok, text, form } = await measure("w2060-b", PROGRAM_B);
    expect(form).toBe("body");
    expect(text, text).not.toContain("Return statement is not allowed here");
    expect(ok, text).toBe(true);
    expect(text).toContain("value=2");
  }, 60_000);

  it("C: the control (no await) still runs — the fix did not need to touch it", async () => {
    const { ok, text, form } = await measure("w2060-c", PROGRAM_C);
    expect(form).toBe("body");
    expect(ok, text).toBe(true);
    expect(text).toContain('"hi"');
  }, 60_000);

  // W2063: these three cases used a genuine top-level await as the script fixture.
  // That premise is gone (the wrapper is ASYNC, so an await is a body). The
  // INTENT — "the forms that cannot be wrapped still are not" — is preserved with
  // the fixture that really cannot be wrapped: an `export` statement. The
  // assertions are unchanged. PROGRAM_TLA/PROGRAM_TLA2 are still exercised, as
  // bodies, in w2063-await-not-script.test.ts.
  it("★ a module-only STATEMENT + top-level return is STILL a script (the boundary is not lost)", async () => {
    const { ok, text, form } = await measure("w2060-tla", PROGRAM_EXPORT);
    expect(form).toBe("script");
    expect(ok, text).toBe(false);
    expect(text).toContain("program_syntax");
    expect(text).toContain("Return statement is not allowed here");
  }, 60_000);

  it("★ an export whose initializer awaits is STILL a script (not wrappable at all)", async () => {
    const { ok, text, form } = await measure("w2060-tla2", PROGRAM_EXPORT_AWAIT);
    expect(form).toBe("script");
    expect(ok, text).toBe(false);
    expect(text).toContain("Return statement is not allowed here");
  }, 60_000);

  it("an export-only program with NO return is still reported as a missing entry point", async () => {
    const { text, form } = await measure("w2060-tla-nomain", "export const x = await Promise.resolve(1);\n");
    expect(form).toBe("script");
    expect(text).toContain("without defining 'main'");
    expect(text).not.toContain("code=aborted");
  }, 60_000);
});

// ---- the boundary matrix (unit) ----------------------------------------------

describe("W2060 · what counts as module top level", () => {
  const form = (code: string): string => programLayout(code, "typescript").form;

  it("a word inside a LOOP / FUNCTION / TRY / ARROW body is not module top level", () => {
    for (const code of [
      PROGRAM_B,
      "async function go() { return await f(); }\nreturn go();\n",
      "const go = async () => { return await f(); };\nreturn go();\n",
      "try { await f(); } catch (error) {}\nreturn 1;\n",
      "class A { async m() { return await f(); } }\nreturn new A().m();\n",
      "const go = async () => await f();\nreturn go();\n",
    ]) {
      expect(form(code), code).toBe("body");
    }
  });

  it("a word inside a STRING / COMMENT / TEMPLATE is not a token at all", () => {
    for (const code of [
      "const a = 1;\nconst s = 'await x';\nreturn s;\n",
      'const a = 1;\nconst s = "import x";\nreturn s;\n',
      "const a = 1;\nconst s = `export const x`;\nreturn s;\n",
      "const a = 1;\n// await f()\nreturn a;\n",
      "const a = 1;\n/* import x */\nreturn a;\n",
      "const a = 1;\nconst o = { await: 1, import: 2 };\nreturn o;\n",
      "const a = 1;\nconst v = o.await;\nreturn v;\n",
    ]) {
      expect(form(code), code).toBe("body");
    }
  });

  it("★ an awaited SYNCHRONOUS bridge is not evidence of module scope (the documented free await)", () => {
    expect(form(PROGRAM_A)).toBe("body");
    expect(form("const r = await tools['run_shell']({ command: 'x' });\nreturn r;\n")).toBe("body");
    // A dynamic import is an EXPRESSION, not an import statement: the wrapper hosts it.
    expect(form('const m = await import("node:path");\nreturn m;\n')).toBe("body");
    // The same program without `await` is a body too — the await must not change the form.
    expect(form(PROGRAM_C)).toBe("body");
  });

  it("★ W2063: a GENUINE top-level await is a BODY now — the wrapper is async", () => {
    // This case used to assert "script" for every entry below. Its premise was
    // that a real top-level await proves module scope; W2063 measured that the
    // wrapper is `async function main()`, where an await is ordinary code, so
    // the await is not evidence of anything. Assertion INVERTED, fixture set kept.
    for (const code of [
      PROGRAM_TLA,
      PROGRAM_TLA2,
      "const x = await new Promise((r) => r(1));\n",
      "await f();\nreturn 1;\n",
      "const x = await Promise.resolve(1);\nconst main = async () => x;\n",
    ]) {
      // The last entry ALSO declares main, which is an independent (still correct)
      // reason to select script — it is pinned there, not here.
      expect(form(code), code).toBe(code.includes("const main") ? "script" : "body");
    }
  });

  it("★ the preserved script signals: export statement / import statement / bare call", () => {
    expect(form("export const a = 1;\n")).toBe("script");
    expect(form('import {\n  a,\n} from "x";\nconst b = 1;\nreturn { a, b };\n')).toBe("script");
    expect(form("main();\n")).toBe("script");
    expect(form("function main() { return 1; }\n")).toBe("script");
    expect(definesEntryPoint("function main() { return 1; }\n", "typescript")).toBe(true);
  });

  it("★ a control-flow HEADER on the first line is not a bare CALL", () => {
    // `for (`/`if (` end in `(` but are not calls: mistaking one for a call used
    // to emit a top-level `return` verbatim (the same failure as the await bug).
    for (const code of [
      "for (const c of ['a']) { console.log(c); }\nreturn 1;\n",
      "if (true) { console.log(1); }\nreturn 1;\n",
      "while (false) {}\nreturn 1;\n",
      "switch (1) { default: break; }\nreturn 1;\n",
    ]) {
      expect(form(code), code).toBe("body");
    }
    // …while a real bare call keeps the historical script treatment.
    expect(form("main();\n")).toBe("script");
  });

  it("★ a module-only STATEMENT (import/export) keeps the script treatment — isolated", () => {
    // The multi-line import is the case that MUST stay a script: the hoist refuses
    // it, and emitting it verbatim is the only honest option (see hoistNote).
    expect(form('import {\n  a,\n} from "x";\nconst b = 1;\nreturn { a, b };\n')).toBe("script");
    expect(form('import x from "y";\nreturn x;\n')).toBe("body"); // single-line: hoisted, not a script
    expect(form("export const a = 1;\n")).toBe("script");
    expect(form("export default function () {}\n")).toBe("script");
    // An IMPORT EXPRESSION is not a statement, so it is not module-only.
    expect(form('const m = await import("node:path");\nreturn m;\n')).toBe("body");
    // A brace-less arrow whose body is the keyword is not a statement either.
    expect(form("export const f = async () => await g();\nreturn f();\n")).toBe("script");
  });

  // W2064 CLOSED THE GAP THIS CASE USED TO PIN. The two `toBe(true)` assertions
  // below are the ONLY lines of this file W2064 touched; they were inverted
  // because the behaviour they described was the defect, not a contract.
  //
  // W2060 scope note, kept as history: the form decision has TWO producers.
  // W2060 fixed `startsAtModuleTop` (the reported defect) and left
  // `definesEntryPoint` with the same CLASS of flaw — it trimmed each line and
  // matched a declaration pattern, so a `main` that is NOT at module scope still
  // selected the script form:
  //
  //   · nested inside another function  (`function make() { function main() … }`)
  //   · inside a block comment or a multi-line template
  //
  // Both made a program that the WRAPPER would have hosted be emitted verbatim,
  // where its top-level `return` is a syntax error. W2060 deliberately pinned
  // that AS OBSERVED ("a future fix has a target") instead of silently changing
  // which programs get wrapped. W2064 is that fix: `definesEntryPoint` now reads
  // its declarations off the SAME lexical scan as `startsAtModuleTop`, so a
  // declaration must be real code, the first token of its line, and at bracket
  // depth 0. The guard against over-fixing it (every shape that MUST stay a
  // script) lives in `w2064-defines-entry-point.test.ts`.
  it("★ the W2060 gap: a `main` outside module scope is NOT an entry point (fixed by W2064)", () => {
    expect(definesEntryPoint("function make() {\n  function main() { return 1; }\n  return main;\n}\nreturn make()();\n", "typescript")).toBe(false);
    expect(definesEntryPoint("/*\nfunction main() {}\n*/\nreturn 1;\n", "typescript")).toBe(false);
    // What it does get right today: a mention inside a `//` comment or a single-line
    // string is not a declaration, and a mere CALL is not a definition.
    expect(definesEntryPoint("// function main() {}\nreturn 1;\n", "typescript")).toBe(false);
    expect(definesEntryPoint("const t = 'function main() {}';\nreturn t;\n", "typescript")).toBe(false);
    expect(definesEntryPoint("const x = computeMain();\n", "typescript")).toBe(false);
  });

  it("a plain statement list without any such word is a body (unchanged)", () => {
    expect(form("const a = 1;\nreturn a;\n")).toBe("body");
    expect(form("x = 1\nreturn x\n")).toBe("body");
  });

  it("★ DOCUMENTED APPROXIMATION: a regex literal is not modelled, so it still counts", () => {
    // Telling `/import/g` from a division needs a parser. The scanner is
    // deliberately character-based, so this stays a script. Pinned so the
    // boundary is visible and a future parser-backed fix has a target.
    // (W2063: the `await` form of this approximation is gone with the await
    // rule; the `import` form is what the scanner still has an opinion about.)
    expect(form("const re = /import/g;\nreturn re;\n")).toBe("script");
    // The conservative direction (a word MISSED) is the safe one: the program is
    // wrapped, and the wrapper hosts the await.
    expect(form("const s = `${await f()}`;\nreturn s;\n")).toBe("body");
  });
});

// ---- the wrapper actually receives the program ---------------------------------

describe("W2060 · assembly follows the form", () => {
  it("A and B are wrapped into async function main() (that is WHY the return is legal)", () => {
    for (const code of [PROGRAM_A, PROGRAM_B]) {
      expect(assembleProgram(code, "typescript")).toContain("async function main() {\n" + code + "}\n");
    }
  });

  it("W2063: the genuine TLA is now WRAPPED (it used to be emitted verbatim)", () => {
    const program = assembleProgram(PROGRAM_TLA, "typescript");
    expect(program).toContain("async function main() {\nconst x = await Promise.resolve(1);");
  });

  it("the module-only STATEMENT is still emitted verbatim (no wrapper pretends otherwise)", () => {
    const program = assembleProgram(PROGRAM_EXPORT, "typescript");
    expect(program).not.toContain("async function main() {\nexport const");
    expect(program).toContain("export const x = 1;");
  });
});

// ---- the two re-worded messages -------------------------------------------------

describe("W2060 · the entry-point messages recommend the plain script", () => {
  it("the SDK runner's no-main message leads with the plain script, not with main()", () => {
    expect(assembleProgram("const a = 1;\n", "typescript")).toContain("★PREFER a plain script");
  });

  it("the classifier's entryFailure recommends the plain script", async () => {
    const { classifyProgramFailure } = await import("./program-failure.js");
    const failure = classifyProgramFailure(
      "typescript",
      "Error: run_code: the program finished without defining 'main' - x",
    );
    expect(failure?.message).toContain("★PREFER a plain script");
    expect(failure?.message).toContain("no wrapper to define or to brace-balance");
  });
});
