// @vitest-environment node
/**
 * W2063 · a top-level `await` is NOT evidence of module scope — the wrapper is ASYNC.
 *
 * ## The rule removed here (W2060, one commit old)
 *
 * `startsAtModuleTop` treated a top-level `await` whose operand is a REAL promise
 * (not the engine's synchronous bridge, not a dynamic `import(…)`) as proof that
 * the program must run at module top level, so it was emitted VERBATIM as a
 * "script". The justification was a comment claiming the wrapper is a "plain
 * function", where a top-level `await` would be a syntax error.
 *
 * **That justification was false.** `wrapTypeScriptBody` emits
 * `async function main() {` — an ASYNC function. A top-level `await` inside it is
 * ordinary, legal code. The rule rejected working programs for a reason that
 * never existed.
 *
 * ## What this file pins
 *
 * 1. the four-group matrix, re-measured on the REAL broker (real userspace
 *    sandbox, real `node` child, real line protocol): the unindented genuine TLA
 *    used to die with `Return statement is not allowed here` and now returns its
 *    value; the indented control (forced through the wrapper) always worked;
 * 2. the two shapes that genuinely CANNOT be wrapped are still scripts — an
 *    `export` statement and a non-leading `import` statement. Removing the await
 *    rule must not remove these;
 * 3. the first-line bare call (`main();`) keeps the documented "complete script"
 *    habit;
 * 4. the assembly-level consequence: the TLA is now wrapped, and the wrapper is
 *    `async`, which is exactly WHY the await is legal there.
 *
 * Every e2e expectation below is DERIVED FROM A REAL RUN and the raw code and the
 * raw outcome are printed, so a reader can see what the engine actually did.
 */

import type { Tool, ToolExecOutcome } from "@celestea/core";
import { afterAll, describe, expect, it } from "vitest";

import { assembleProgram, programLayout, wrapTypeScriptBody } from "./sdk.js";
import { startBrokerHarness, type BrokerHarness } from "./broker.test-util.js";

const h: BrokerHarness = await startBrokerHarness();
afterAll(async () => {
  await h.cleanup();
});

const run = (tool: Tool, callId: string, args: unknown): Promise<ToolExecOutcome> =>
  h.run(tool, callId, args) as Promise<ToolExecOutcome>;
const shellTool = (): Tool => h.mount(h.shellRegistry());

/** Run a program and return the RAW outcome (value, or the full failure text). */
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

// ---- the programs, verbatim ---------------------------------------------------

/** P1: the genuine TLA the architect measured — a real promise, and a stray return. */
const P1 = "const x = await Promise.resolve(7);\nreturn x;\n";
/** P2: the same await, but the program prints instead of returning. */
const P2 = "const x = await Promise.resolve(7);\nconsole.log(x);\n";
/** P3: an await of an ordinary helper — a real promise in every sense. */
const P3 = "async function helper() { return 7; }\nconst x = await helper();\nreturn x;\n";
/** The indent trick: the SAME text, indented, which forces the body form. */
const indented = (code: string): string =>
  code.split("\n").filter((line) => line !== "").map((line) => "  " + line).join("\n") + "\n";

describe.skipIf(!h.nodeReady)("W2063 · real broker: a genuine top-level await now RUNS", () => {
  it("★ P1: genuine TLA + return ⇒ SUCCESS value=7 (was program_syntax)", async () => {
    const { ok, text, form } = await measure("w2063-p1", P1);
    expect(form).toBe("body");
    expect(text, text).not.toContain("Return statement is not allowed here");
    expect(ok, text).toBe(true);
    expect(text).toContain("value=7");
  }, 60_000);

  it("★ P1-indented control: the SAME program through the wrapper always returned 7", async () => {
    const { ok, text } = await measure("w2063-p1-indented", indented(P1));
    expect(ok, text).toBe(true);
    expect(text).toContain("value=7");
  }, 60_000);

  it("★ P2: genuine TLA with no return ⇒ SUCCESS, and the program actually ran", async () => {
    const { ok, text, form } = await measure("w2063-p2", P2);
    expect(form).toBe("body");
    expect(ok, text).toBe(true);
    expect(text).toContain("value=null");
    expect(text).toContain('render="7"'); // console.log(x) printed 7 — the await resolved
  }, 60_000);

  it("★ P2-unindented no longer reports the missing-entry-point error", async () => {
    const { ok, text } = await measure("w2063-p2b", P2);
    expect(ok, text).toBe(true);
    expect(text).not.toContain("without defining 'main'");
  }, 60_000);

  it("P3: awaiting an ordinary async helper is a body too", async () => {
    const { ok, text, form } = await measure("w2063-p3", P3);
    expect(form).toBe("body");
    expect(ok, text).toBe(true);
    expect(text).toContain("value=7");
  }, 60_000);

  it("★ KNOWN SEMANTIC DELTA: `arguments` at top level becomes the wrapper's (empty) arguments object", async () => {
    // Measured on the real broker (the W2063 enumeration). In a module SCRIPT,
    // `arguments` at top level is `undefined`; inside `async function main()` it is
    // that function's arguments object (an empty one). This is the ONLY behavioural
    // difference the enumeration found between the two forms. It is inherent to
    // WRAPPING, not to this fix — the same delta has applied to every non-await
    // main-less program since W2012 — and it is pinned here so it is a documented
    // consequence rather than a surprise. (`this` is `undefined` in both forms,
    // because both are modules; `var` and function declarations behave the same.)
    const { text } = await measure(
      "w2063-arguments",
      "const x = await Promise.resolve(7);\nreturn { x, t: typeof arguments };\n",
    );
    expect(text).toContain('"t":"object"');
  }, 60_000);

  it("the await inside the wrapper really awaited (a rejection is catchable)", async () => {
    const { text } = await measure(
      "w2063-p4",
      "const x = await Promise.reject(new Error('tla-rejected'));\nreturn x;\n",
    );
    expect(text).toContain("tla-rejected");
  }, 60_000);
});

describe.skipIf(!h.nodeReady)("W2063 · real broker: what genuinely cannot be wrapped still is not", () => {
  it("★ export + return ⇒ STILL program_syntax with the interpreter's own words", async () => {
    const code = "export const x = 1;\nreturn x;\n";
    const { ok, text, form } = await measure("w2063-export", code);
    expect(form).toBe("script");
    expect(ok, text).toBe(false);
    expect(text).toContain("program_syntax");
    expect(text).toContain("Return statement is not allowed here");
  }, 60_000);

  it("★ a non-leading import statement is STILL a script (it cannot live in a function)", async () => {
    const code = "const a = 1;\nimport { basename } from \"node:path\";\nreturn a;\n";
    const { ok, text, form } = await measure("w2063-import", code);
    expect(form).toBe("script");
    expect(ok, text).toBe(false);
    expect(text).toContain("program_syntax");
    // Emitted VERBATIM is what makes it work at all: the import stays at module
    // top level, where it is legal — wrapping it would be a SyntaxError.
    expect(assembleProgram(code, "typescript")).toContain("import { basename } from \"node:path\";");
    expect(assembleProgram(code, "typescript")).not.toContain("async function main() {\nconst a = 1;\nimport");
  }, 60_000);

  it("★ a first-line bare call (main();) is STILL a script — the complete-script habit", async () => {
    const code = "main();\n";
    const { ok, text, form } = await measure("w2063-barecall", code);
    expect(form).toBe("script");
    expect(ok, text).toBe(false);
    expect(text).not.toContain("Return statement is not allowed here");
  }, 60_000);
});

// ---- the form rule itself (unit) ----------------------------------------------

describe("W2063 · await never selects the script form", () => {
  const form = (code: string): string => programLayout(code, "typescript").form;

  it("★ every top-level await operand is a BODY now, bridge or not", () => {
    for (const code of [
      P1,
      P2,
      P3,
      "const x = await new Promise((r) => r(1));\nreturn x;\n",
      "const x = await fetch('http://127.0.0.1/');\nreturn x;\n",
      "await f();\nreturn 1;\n",
      "const r = await tools.run_shell({ command: 'echo hi' });\nreturn r;\n",
      'const m = await import("node:path");\nreturn m;\n',
      // NOTE: a program that also DEFINES main is a script for that reason alone
      // (definesEntryPoint) — an unrelated, still-correct rule. Pinned below.
      "const x = await Promise.resolve(1);\nconst main = async () => x;\n",
    ]) {
      if (code.includes("const main")) {
        expect(form(code), code).toBe("script");
        continue;
      }
      expect(form(code), code).toBe("body");
    }
  });

  it("★ the two genuine module-only STATEMENTS still select script", () => {
    expect(form("export const a = 1;\n")).toBe("script");
    expect(form("export default function () {}\n")).toBe("script");
    expect(form('const a = 1;\nimport { basename } from "node:path";\nreturn a;\n')).toBe("script");
    expect(form('import {\n  a,\n} from "x";\nconst b = 1;\nreturn { a, b };\n')).toBe("script");
  });

  it("★ the first-line bare call still selects script, and a control-flow header does not", () => {
    expect(form("main();\n")).toBe("script");
    for (const code of [
      "for (const c of ['a']) { console.log(c); }\nreturn 1;\n",
      "if (true) { console.log(1); }\nreturn 1;\n",
      "while (false) {}\nreturn 1;\n",
      "await f();\nreturn 1;\n",
    ]) {
      expect(form(code), code).toBe("body");
    }
  });

  it("★ an awaited DYNAMIC import is an expression, so the hoist must not see a statement", () => {
    // `await import("x")` is an EXPRESSION. It is a body now (it always was), and
    // the import hoist must leave it alone — nothing may be lifted out of it.
    const layout = programLayout('const m = await import("node:path");\nreturn m;\n', "typescript");
    expect(layout.form).toBe("body");
    expect(layout.hoisted).toBe("");
    expect(layout.hoistNote).toBeNull();
  });

  it("★ a LEADING import is still hoisted, not turned into a script", () => {
    const layout = programLayout('import { basename } from "node:path";\nreturn basename("/a");\n', "typescript");
    expect(layout.form).toBe("body");
    expect(layout.hoisted).toBe('import { basename } from "node:path";\n');
  });

  it("★ a regex literal still counts (the scanner's documented approximation)", () => {
    // Unchanged by W2063, but pinned here because the scanner's word set narrowed:
    // `/import/g` still reads as an import word, so this stays a script.
    expect(form("const re = /import/g;\nreturn re;\n")).toBe("script");
    // …and the conservative direction is still the safe one.
    expect(form("const s = `${await f()}`;\nreturn s;\n")).toBe("body");
  });
});

// ---- assembly: WHY the await is legal ------------------------------------------

describe("W2063 · the wrapper hosts the await because it is ASYNC", () => {
  it("★ the wrapper this module emits is `async function main()` — not a plain function", () => {
    expect(wrapTypeScriptBody("return 1;\n", "")).toBe("async function main() {\nreturn 1;\n}\n");
    expect(wrapTypeScriptBody("return 1;\n", "")).toMatch(/^async function main\(\) \{$/m);
  });

  it("★ the genuine TLA is now wrapped (it used to be emitted verbatim)", () => {
    const program = assembleProgram(P1, "typescript");
    expect(program).toContain("async function main() {\n" + P1 + "}\n");
    expect(program).not.toContain("\nconst x = await Promise.resolve(7);\nreturn x;\n\n// ======================= harness");
  });

  it("★ the export program is still emitted verbatim (no wrapper pretends otherwise)", () => {
    const program = assembleProgram("export const x = 1;\nreturn x;\n", "typescript");
    expect(program).not.toContain("async function main() {\nexport const x = 1;");
    expect(program).toContain("export const x = 1;\nreturn x;\n");
  });
});
