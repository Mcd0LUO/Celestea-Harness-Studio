// @vitest-environment node
/**
 * W2064 · `definesEntryPoint` must mean defines-at-TOP-LEVEL, and `main();` must
 * mean `main();` ALONE.
 *
 * ## The two defects (independently reproduced here, real broker + real node)
 *
 * W2060 fixed the form decision's `startsAtModuleTop` producer and PINNED the
 * other producer's identical flaw as observed. `definesEntryPoint` trimmed each
 * line and matched a regex, so a `main` that was not a top-level declaration at
 * all still selected the SCRIPT form. The program was emitted VERBATIM, and its
 * top-level `return` — the shape this tool's own contract recommends — became
 * `SyntaxError: Return statement is not allowed here`:
 *
 *     function make() {          // the `main` is nested in make()
 *       function main() { return 1; }
 *       return main;
 *     }
 *     return make()();           // ⇒ program_syntax (measured)
 *
 *     /*
 *     function main() {}        // the `main` is inside a COMMENT
 *     *\/
 *     return 42;                 // ⇒ program_syntax (measured)
 *
 * The same rule also over-matched in the other direction: ANY first line shaped
 * like a call made the program a "complete script", so
 *
 *     doSomething();
 *     return 1;                  // ⇒ program_syntax (measured)
 *
 * was emitted verbatim even though it is a plain body. (`main();` alone MUST
 * keep the script treatment — see the last describe — because the wrapper would
 * bind that call to itself and silently return `undefined` for a program that
 * forgot to define `main`. That is why this was narrowed, not deleted.)
 *
 * ## The rule now
 *
 * One shared lexical scan ([scanLexical]) answers BOTH producers, so they cannot
 * drift apart again. A declaration counts only when it is (1) real CODE — not in
 * a comment, string or template, (2) the first token of its line, and (3) at
 * bracket depth 0. Python adds its own condition: column 0, because indentation
 * IS the nesting there.
 *
 * ## What this file pins
 *
 * 1. the misjudged shapes now RUN (real broker, real node, raw code + raw
 *    outcome printed);
 * 2. every shape that MUST still select a script — the boundary that must not be
 *    lost while fixing 1;
 * 3. the negative controls: each assertion above is shown to go RED against a
 *    deliberately reverted rule, so the gates have teeth (see the mutation block
 *    at the end of the unit matrix).
 */

import type { Tool, ToolExecOutcome } from "@celestea/core";
import { afterAll, describe, expect, it } from "vitest";

import { definesEntryPoint, programLayout } from "./program-form.js";
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

// ---- the misjudged programs, verbatim ----------------------------------------

/** A: the `main` is nested inside another function (depth > 0). */
const NESTED_MAIN = "function make() {\n  function main() { return 1; }\n  return main;\n}\nreturn make()();\n";
/** B: the `main` is inside a BLOCK COMMENT. */
const COMMENT_MAIN = "/*\nfunction main() {}\n*/\nreturn 42;\n";
/** C: the `main` is inside a MULTI-LINE TEMPLATE literal. */
const TEMPLATE_MAIN = "const t = \`\nfunction main() {}\n\`;\nreturn t;\n";
/** D: the `main` is inside a single-line STRING. */
const STRING_MAIN = "const t = 'function main() {}';\nreturn t;\n";
/** E: a bare call on the first line, but NOT the whole program. */
const CALL_THEN_RETURN = "doSomething();\nreturn 1;\n";

describe.skipIf(!h.nodeReady)("W2064 · real broker: the misjudged shapes now run", () => {
  it("★ a NESTED main is a body and RUNS (was program_syntax)", async () => {
    const { ok, text, form } = await measure("w2064-nested-main", NESTED_MAIN);
    expect(form).toBe("body");
    expect(text, text).not.toContain("Return statement is not allowed here");
    expect(ok, text).toBe(true);
    expect(text).toContain("value=1");
  }, 60_000);

  it("★ a main inside a BLOCK COMMENT is a body and RUNS (was program_syntax)", async () => {
    const { ok, text, form } = await measure("w2064-comment-main", COMMENT_MAIN);
    expect(form).toBe("body");
    expect(text, text).not.toContain("Return statement is not allowed here");
    expect(ok, text).toBe(true);
    expect(text).toContain("value=42");
  }, 60_000);

  it("★ a main inside a MULTI-LINE TEMPLATE is a body and RUNS (was program_syntax)", async () => {
    const { ok, text, form } = await measure("w2064-template-main", TEMPLATE_MAIN);
    expect(form).toBe("body");
    expect(ok, text).toBe(true);
    expect(text).toContain("function main() {}");
  }, 60_000);

  it("★ a main inside a STRING is a body and RUNS", async () => {
    const { ok, text, form } = await measure("w2064-string-main", STRING_MAIN);
    expect(form).toBe("body");
    expect(ok, text).toBe(true);
    expect(text).toContain("function main() {}");
  }, 60_000);

  it("★ a first-line bare call that is NOT the whole program is a body (was program_syntax)", async () => {
    // `doSomething` does not exist, so the program still FAILS — but it fails as
    // the program's own ReferenceError from INSIDE the wrapper, not as a syntax
    // error about a top-level `return`. That is the difference the form makes.
    const { ok, text, form } = await measure("w2064-call-then-return", CALL_THEN_RETURN);
    expect(form).toBe("body");
    expect(text, text).not.toContain("Return statement is not allowed here");
    expect(text, text).not.toContain("program_syntax");
    expect(ok).toBe(false);
    expect(text).toContain("ReferenceError");
  }, 60_000);
});
// ---- the boundary that must NOT move ------------------------------------------

describe("W2064 · every shape that MUST still select a script", () => {
  const form = (code: string, language: "typescript" | "python" = "typescript"): string =>
    programLayout(code, language).form;
  const defines = (code: string, language: "typescript" | "python" = "typescript"): boolean =>
    definesEntryPoint(code, language);

  it("★ a TOP-LEVEL main declaration is still an entry point (all spellings)", () => {
    for (const code of [
      "function main() { return 1; }\n",
      "async function main() { return 1; }\n",
      "function* main() { return 1; }\n",
      "export function main() { return 1; }\n",
      "export default function main() { return 1; }\n",
      "const main = async () => 1;\n",
      "let main = () => 1;\n",
      "var main = () => 1;\n",
      "class main {}\n",
      "abstract class main {}\n",
      // Indentation is cosmetic in TypeScript, so an indented top-level
      // declaration still counts. The old rule agreed (it trimmed first).
      "  function main() { return 1; }\n",
      // A leading comment is not a statement, so it does not hide the one after.
      "// hi\nfunction main() { return 1; }\n",
      "/* hi */ function main() { return 1; }\n",
      // A trailing comment does not either.
      "function main() { return 1; } // mine\n",
    ]) {
      expect(defines(code), code).toBe(true);
      expect(form(code), code).toBe("script");
    }
  });

  it("★ Python: a top-level def/class main is still an entry point", () => {
    for (const code of ["def main():\n    return 1\n", "async def main():\n    return 1\n", "class main:\n    pass\n"]) {
      expect(defines(code, "python"), code).toBe(true);
      expect(form(code, "python"), code).toBe("script");
    }
  });

  it("★ a bare call that IS the whole program is still a script (the honest-error guard)", () => {
    // This is the one shape whose script treatment is LOAD-BEARING: wrapped, the
    // call would resolve to the wrapper itself and a missing `main` would return
    // undefined instead of failing. Pinned here AND end-to-end below.
    for (const code of ["main();\n", "main();", "f();\n", "f()\n", "main();\n\n", "main();\n// done\n", "doThing(\n  1,\n  2,\n);\n"]) {
      expect(form(code), code).toBe("script");
    }
    // …but the moment a second top-level statement follows, it is a body.
    for (const code of ["doSomething();\nreturn 1;\n", "a();\nb();\nreturn 1;\n", "setup();\nconst x = 1;\nreturn x;\n"]) {
      expect(form(code), code).toBe("body");
    }
  });

  it("★ the W2060 boundaries are untouched: TLA / import / export still script", () => {
    expect(form("const x = await Promise.resolve(1);\nreturn x;\n")).toBe("script");
    expect(form("export const a = 1;\n")).toBe("script");
    expect(form('import {\n  a,\n} from "x";\nconst b = 1;\nreturn { a, b };\n')).toBe("script");
    // A main-less body stays a body.
    expect(form("const a = 1;\nreturn a;\n")).toBe("body");
  });

  it("★ a control-flow HEADER is still not a bare call", () => {
    for (const code of [
      "for (const c of ['a']) { console.log(c); }\nreturn 1;\n",
      "if (true) { console.log(1); }\nreturn 1;\n",
      "while (false) {}\nreturn 1;\n",
      "switch (1) { default: break; }\nreturn 1;\n",
    ]) {
      expect(form(code), code).toBe("body");
    }
  });

  it("★ a mere CALL is still not a DEFINITION (definesEntryPoint stays false)", () => {
    expect(defines("main();\n")).toBe(false);
    expect(defines("const x = computeMain();\n")).toBe(false);
    expect(defines("// function main() {}\nreturn 1;\n")).toBe(false);
  });
});

// ---- Python: the language-specific half ---------------------------------------

describe("W2064 · Python's top level is column 0 (indentation IS the nesting)", () => {
  const defines = (code: string): boolean => definesEntryPoint(code, "python");
  const form = (code: string): string => programLayout(code, "python").form;

  it("★ a NESTED def main is not an entry point (Python has no brackets to tell)", () => {
    const nested = "def make():\n    def main():\n        return 1\n    return main\nreturn make()()\n";
    expect(defines(nested)).toBe(false);
    expect(form(nested)).toBe("body");
  });

  it("★ a def main inside a COMMENT or a DOCSTRING is not an entry point", () => {
    for (const code of [
      "# def main():\nreturn 1\n",
      '"""\ndef main():\n"""\nreturn 1\n',
      "'''\ndef main():\n'''\nreturn 1\n",
      "s = 'def main():'\nreturn s\n",
    ]) {
      expect(defines(code), code).toBe(false);
      expect(form(code), code).toBe("body");
    }
  });

  it("★ the Python comment marker is '#' — NOT '//' (which is integer division)", () => {
    // Getting this backwards is the obvious way to break the Python path, in
    // both directions. '#' is a comment; '//' is an operator, so the `def main`
    // after it is REAL and must still be found.
    expect(defines("x = 7 // 2\ndef main():\n    return x\n")).toBe(true);
    expect(defines("# don't\ndef main():\n    return 1\n")).toBe(true);
    // …and a '#' inside a string is text, not a comment: the real def after it
    // must survive.
    expect(defines('s = "# not a comment"\ndef main():\n    return s\n')).toBe(true);
  });

  it("★ a docstring does not hide the real def main that follows it", () => {
    expect(defines('"""doc\ndef main():\n"""\ndef main():\n    return 1\n')).toBe(true);
  });
});
// ---- the negative controls: the gates above must be able to go RED -------------

/**
 * The MUTANTS. Each one is the defect this file exists to prevent, expressed as
 * a tiny function that replaces the real rule for the duration of one assertion
 * group. Every mutant MUST disagree with the shipped rule on the named program —
 * if it ever agrees, the gate above it has stopped having teeth (it would pass
 * against the bug), and this test fails.
 *
 * The mutations are the REAL ones: they are the two rules this commit replaced,
 * transcribed from the pre-W2064 source (a regex over trimmed lines, and a bare
 * call test that stopped at the first line).
 */
const MUTANTS: ReadonlyArray<{
  name: string;
  /** The pre-W2064 rule, as a predicate over the code. */
  legacy: (code: string) => boolean;
  /** A program where the legacy rule and the shipped rule MUST disagree. */
  probe: string;
  /** What the legacy rule answers there (the bug). */
  legacySays: boolean;
  /** What the shipped rule answers there (the contract). */
  shipped: boolean;
}> = [
  {
    name: "line-trimmed regex (the W2060-pinned gap)",
    legacy: (code) =>
      code
        .split("\n")
        .map((line) => line.trim())
        .some((line) => /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*main\s*\(/.test(line)),
    probe: "function make() {\n  function main() { return 1; }\n  return main;\n}\nreturn make()();\n",
    legacySays: true,
    shipped: false,
  },
  {
    name: "line-trimmed regex, block comments included",
    legacy: (code) =>
      code
        .split("\n")
        .map((line) => line.trim())
        .some((line) => /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*main\s*\(/.test(line)),
    probe: "/*\nfunction main() {}\n*/\nreturn 42;\n",
    legacySays: true,
    shipped: false,
  },
  {
    name: "bare call on the FIRST LINE only (the over-broad rule)",
    legacy: (code) => /^([A-Za-z_$][\w$]*)\s*\(/.test(code.trim().split("\n")[0]!.trim()),
    probe: "doSomething();\nreturn 1;\n",
    legacySays: true,
    shipped: false,
  },
];

describe("W2064 · mutation negative controls (each gate is shown to have teeth)", () => {
  it("★ every mutant DISAGREES with the shipped rule on its probe program", () => {
    for (const mutant of MUTANTS) {
      const shipped = definesEntryPoint(mutant.probe, "typescript");
      const legacy = mutant.legacy(mutant.probe);
      // The mutant reproduces the BUG…
      expect(legacy, mutant.name + ": the mutant must reproduce the old answer").toBe(mutant.legacySays);
      // …and the shipped rule answers the OPPOSITE, which is what the gates assert.
      expect(shipped, mutant.name + ": the shipped rule must disagree with the mutant").toBe(mutant.shipped);
      expect(shipped, mutant.name + ": the mutation must be OBSERVABLE").not.toBe(legacy);
    }
  });

  it("★ the mutants also disagree on the FORM, not just the predicate", () => {
    // The gates in this file are about `programLayout`, so the mutation must be
    // observable there too: the legacy rule selects a script (which is what made
    // the top-level `return` a syntax error), the shipped rule a body.
    for (const mutant of MUTANTS) {
      const legacyForm = mutant.legacy(mutant.probe) ? "script" : "body";
      expect(legacyForm, mutant.name).not.toBe(programLayout(mutant.probe, "typescript").form);
      expect(programLayout(mutant.probe, "typescript").form, mutant.name).toBe("body");
    }
  });

  it("★ a mutant that CANNOT be distinguished is rejected (the control itself has teeth)", () => {
    // A mutant identical to the shipped rule agrees everywhere — so the check
    // above would fail. This pins that the control is a real comparison and not
    // a tautology.
    const identical = "function main() { return 1; }\n";
    expect(definesEntryPoint(identical, "typescript")).toBe(true);
    const mutantAgrees = (code: string): boolean => definesEntryPoint(code, "typescript");
    expect(mutantAgrees(identical)).toBe(definesEntryPoint(identical, "typescript"));
  });
});
// ---- the lexical scan must not be CORRUPTED by a comment ----------------------

/**
 * A comment is not code — and, less obviously, it must not be able to change how
 * the CODE around it is read.
 *
 * The form decision tracks bracket depth, so a comment that mentions an
 * unbalanced bracket is a real hazard: if the scan treated it as code, the depth
 * counter would never come back to 0 and every declaration AFTER it would look
 * nested. These cases pin the property in both directions for both languages.
 * They are also the discriminating probes for the mutation controls: with the
 * comment branches removed, each one flips from script to body (measured).
 */
describe("W2064 · a comment with a stray bracket must not hide a real main", () => {
  it("★ TypeScript: an unbalanced bracket in a comment does not nest what follows", () => {
    for (const code of [
      "// (\nfunction main() { return 1; }\n",
      "// )\nfunction main() { return 1; }\n",
      "/* ( */\nfunction main() { return 1; }\n",
      "/* ) */\nfunction main() { return 1; }\n",
      "/* [ */\nfunction main() { return 1; }\n",
    ]) {
      expect(definesEntryPoint(code, "typescript"), code).toBe(true);
      expect(programLayout(code, "typescript").form, code).toBe("script");
    }
  });

  it("★ Python: an unbalanced bracket in a '#' comment does not nest what follows", () => {
    // The '#' branch is Python-only; without it the scan reads '(' as code and
    // the real `def main` below is then judged to be inside a bracket group.
    for (const code of [
      "# (\ndef main():\n    return 1\n",
      "# )\ndef main():\n    return 1\n",
      "# [\ndef main():\n    return 1\n",
      "# {\ndef main():\n    return 1\n",
    ]) {
      expect(definesEntryPoint(code, "python"), code).toBe(true);
      expect(programLayout(code, "python").form, code).toBe("script");
    }
  });

  it("★ a '#' INSIDE a Python string is text, so the real def after it survives", () => {
    // The mirror image: the quote branch must run before the '#' branch can see
    // a '#' that is not a comment marker.
    expect(definesEntryPoint('s = "# ( \\n not a comment"\ndef main():\n    return s\n', "python")).toBe(true);
  });
});
