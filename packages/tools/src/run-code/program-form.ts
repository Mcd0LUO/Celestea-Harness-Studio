/**
 * The program FORM of one `run_code` call (W2012) — the fix for the highest-
 * failure-rate defect in this repo (114/549 production calls: a non-indented,
 * main-less "quick script" failed 100% of the time).
 *
 * ## What was wrong
 *
 * `assembleProgram` used to decide between two forms with ONE question: is the
 * first non-blank line INDENTED? Indented ⇒ wrap it into `async function main()`;
 * otherwise ⇒ treat it as a complete script that defines `main` itself. That
 * infers INTENT from LAYOUT, and indenting a plain script is not something anyone
 * does naturally — so the most natural quick script of all
 *
 *     const sh = (c) => tools.run_shell({ command: c });
 *     return { pwd: sh("pwd") };
 *
 * took the "complete script" branch, the runner found no `main`, and the model
 * got `code=aborted … without a final line` (see `program-failure.ts` for the
 * second half of that story).
 *
 * ## The rule now
 *
 * | the program …                                        | form     |
 * |------------------------------------------------------|----------|
 * | defines a top-level `main` (function/async/const/…)   | script   |
 * | is a BODY (indented first line, or a Python `import`) | wrap     |
 * | anything else (non-indented, no `main`)               | wrap     |
 *
 * The only two things that still select "script" are the two that can only be
 * meant as a script: a `main` definition, and (TypeScript) a top-level
 * `await`/`import`/`export` or an explicit entry call — i.e. code that is
 * ALREADY valid at module top level and would break inside a function body.
 *
 * ## The one hard boundary: `import` must stay at module top level
 *
 * An `import` statement is illegal inside a function body, so it cannot simply
 * be wrapped. Measured on the production log (the 119 main-less calls): 8 carry
 * an `import`, 0 carry an `export`. Those 8 are handled by HOISTING the leading
 * import block out of the wrapper — the imports run at module scope, the rest of
 * the program is the function body. See [hoistLeadingImports] for the exact
 * boundary of that transformation (and its one failure mode, which is recorded
 * in the run's result instead of failing the call).
 */

/** The two languages `run_code` can run. */
export type RunCodeLanguage = "typescript" | "python";

/** What `run_code` runs when the call omits `language` (W774: TypeScript). */
export const DEFAULT_RUN_CODE_LANGUAGE: RunCodeLanguage = "typescript";

/** Which of the two supported shapes the user code has. */
export type ProgramForm =
  /** A function body (TypeScript) / an `async def main():` body (Python). */
  | "body"
  /** A complete script that defines `main` (or ends the program itself). */
  | "script";

/** The classified program: its form, its code, and what was hoisted out of it. */
export interface ProgramLayout {
  form: ProgramForm;
  /** The statements to run (the whole program, minus any hoisted imports). */
  code: string;
  /** TypeScript only: `import` lines lifted above the wrapper (may be empty). */
  hoisted: string;
  /** TypeScript only: names bound by [hoisted] (skipped when hoisting is unsafe). */
  hoistedNames: readonly string[];
  /** TypeScript only: why hoisting was refused (non-null ⇒ nothing was hoisted). */
  hoistNote: string | null;
}

/**
 * True when the first non-blank line starts with whitespace.
 *
 * Kept exported because it is part of this module's published surface (and it is
 * still one of the two signals [programLayout] uses), but it is NO LONGER the
 * whole rule: a non-indented program without `main` is now wrapped too.
 */
export function firstNonblankLineIndented(code: string): boolean {
  const line = splitProgramLines(code).find((candidate) => candidate.trim() !== "");
  return line !== undefined && (line.startsWith(" ") || line.startsWith("\t"));
}

/** Split on `\n`, drop a trailing `\r`, no final empty line. */
export function splitProgramLines(code: string): string[] {
  const lines = code.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** Ensure the text ends with exactly one newline. */
export function terminate(code: string): string {
  return code.endsWith("\n") ? code : code + "\n";
}

/** The top-level binding a line introduces, or `null` when it introduces none. */
const DECLARATIONS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 1],
  [/^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 1],
  [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, 1],
  [/^(?:export\s+)?(?:const|let|var)\s*\{([^}]*)\}/, 0],
  [/^(?:export\s+)?(?:const|let|var)\s*\[([^\]]*)\]/, 0],
  [/^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/, 0],
];

/** The names a single line binds at top level (empty for a non-declaration). */
function declaredNames(line: string): string[] {
  const trimmed = line.trim();
  for (const [pattern, group] of DECLARATIONS) {
    const match = pattern.exec(trimmed);
    if (match === null) continue;
    const captured = match[group];
    if (captured === undefined || captured === "") continue;
    return group === 1
      ? [captured]
      : captured.split(",").map((part) => part.trim().split(":")[0]!.trim()).filter((name) => name !== "");
  }
  return [];
}

/**
 * Does this program define its own entry point?
 *
 * Covers `function main` / `async function main` / `function* main` /
 * `const main =` / `let main =` / `var main =` / `class main` (TypeScript) and
 * `def main` / `async def main` / `class main` (Python). Deliberately NOT
 * matched: a mere call `main();` — a program that calls a `main` it never
 * defines is broken either way, and wrapping it would only hide the
 * `ReferenceError`.
 */
export function definesEntryPoint(code: string, language: RunCodeLanguage): boolean {
  for (const line of splitProgramLines(code)) {
    const trimmed = line.trim();
    if (language === "python") {
      if (/^(?:async\s+)?def\s+main\s*\(/.test(trimmed) || /^class\s+main\b/.test(trimmed)) return true;
      continue;
    }
    if (/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*main\s*\(/.test(trimmed)) return true;
    if (/^(?:export\s+)?(?:const|let|var)\s+main\b/.test(trimmed)) return true;
    if (/^(?:export\s+)?(?:abstract\s+)?class\s+main\b/.test(trimmed)) return true;
  }
  return false;
}

/**
 * One `await` / `import` / `export` WORD found at module top level by
 * [scanModuleWords], with the two position facts the form rule needs.
 */
interface ModuleTopWord {
  word: "await" | "import" | "export";
  /** True when the word is the body of a brace-less arrow: `async () => await f()`. */
  arrowBody: boolean;
  /** The source text right after the word — where an `await` operand starts. */
  after: string;
}

/** An identifier at the scanner cursor (sticky: matches at `lastIndex`, or not at all). */
const IDENT = /[A-Za-z_$][\w$]*/y;

/**
 * Words that end in `(` without being a CALL. `for (`/`if (` are control-flow
 * headers, and the rest cannot begin a top-level statement at all — mistaking
 * one for a bare call would emit a program with a top-level `return` verbatim.
 */
const NON_CALL_HEADS = new Set([
  "for", "if", "while", "switch", "catch", "return", "typeof", "new", "do",
  "delete", "void", "with", "throw", "await", "yield", "case", "in", "of", "else",
]);

/** `await tools.<name>(…)` / `await tools[…]` — the engine's SYNCHRONOUS bridge. */
const AWAITS_BRIDGE = /^\s*tools\s*[.[]/;
/** `await import("x")` — a dynamic import is an EXPRESSION, not a module statement. */
const AWAITS_DYNAMIC_IMPORT = /^\s*import\s*\(/;

/** Past the end of a `//` comment (or the end of the program). */
function skipLineComment(code: string, at: number): number {
  const nl = code.indexOf("\n", at);
  return nl < 0 ? code.length : nl;
}

/** Past the end of a block comment (an unterminated one swallows the rest). */
function skipBlockComment(code: string, at: number): number {
  const end = code.indexOf("*/", at + 2);
  return end < 0 ? code.length : end + 2;
}

/**
 * Past the closing quote of the string/template opened at `at`.
 *
 * A template is skipped WHOLE, `${…}` included: its interpolations are code, but
 * treating them as such would need a real parser, and swallowing them only ever
 * makes the scan MISS a top-level word — the conservative direction, because the
 * program is then wrapped, and the wrapper hosts any `await`.
 */
function skipQuoted(code: string, at: number): number {
  const quote = code[at]!;
  let i = at + 1;
  while (i < code.length) {
    const ch = code[i]!;
    if (ch === "\\") { i += 2; continue; }
    if (ch === quote) return i + 1;
    if (ch === "\n" && quote !== "`") return i;
    i += 1;
  }
  return code.length;
}

/** Is the word at `at` the body of a brace-less arrow (`() => await f()`)? */
function isArrowBody(code: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0 && /\s/.test(code[i]!)) i -= 1;
  if (code[i] !== ">") return false;
  i -= 1;
  while (i >= 0 && /\s/.test(code[i]!)) i -= 1;
  return code[i] === "=";
}

/** Is the word at `at` a property name (`o.await`), i.e. not a keyword here? */
function afterDot(code: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0 && /\s/.test(code[i]!)) i -= 1;
  return code[i] === ".";
}

/**
 * Every `await` / `import` / `export` WORD at MODULE TOP LEVEL, in source order.
 *
 * Module top level means bracket depth 0 — so a loop body, a function body and an
 * object literal are all excluded — and not the body of a brace-less arrow. The
 * scan is character-based and skips strings, comments and templates, so the word
 * `await` inside `'await x'` or `// await f()` is not a token and never counts.
 *
 * Boundaries (deliberate, and pinned by tests): a regex literal is NOT modelled
 * (telling `/await/g` from a division needs a parser), so a keyword inside one
 * still counts; a template's `${…}` is skipped, so a top-level word inside one is
 * MISSED (the conservative direction).
 */
function scanModuleWords(code: string): ModuleTopWord[] {
  const found: ModuleTopWord[] = [];
  let depth = 0;
  let i = 0;
  while (i < code.length) {
    const ch = code[i]!;
    const next = code[i + 1];
    if (ch === "/" && next === "/") { i = skipLineComment(code, i); continue; }
    if (ch === "/" && next === "*") { i = skipBlockComment(code, i); continue; }
    if (ch === '"' || ch === "'" || ch === "`") { i = skipQuoted(code, i); continue; }
    if (ch === "{" || ch === "[" || ch === "(") { depth += 1; i += 1; continue; }
    if (ch === "}" || ch === "]" || ch === ")") { depth = Math.max(0, depth - 1); i += 1; continue; }
    IDENT.lastIndex = i;
    const match = IDENT.exec(code);
    const ident = match === null ? undefined : match[0];
    if (ident === undefined) { i += 1; continue; }
    if ((ident === "await" || ident === "import" || ident === "export") && depth === 0 && !afterDot(code, i)) {
      found.push({
        word: ident,
        arrowBody: isArrowBody(code, i),
        after: code.slice(i + ident.length, i + ident.length + 32),
      });
    }
    i += ident.length;
  }
  return found;
}

/** A word only a MODULE may carry: an `import`/`export` STATEMENT (`import(` is an expression). */
function isModuleOnlyWord(hit: ModuleTopWord): boolean {
  if (hit.arrowBody) return false;
  if (hit.word === "export") return true;
  return hit.word === "import" && !/^\s*\(/.test(hit.after);
}

/**
 * A top-level `await` that is EVIDENCE of module scope.
 *
 * The two exclusions are operands the wrapper hosts just as well, so awaiting
 * them says nothing about where the program must run: the engine's own
 * synchronous bridge (whose SDK text is literally "awaiting a value is free")
 * and a dynamic `import(…)` expression. Every other operand — a real promise, a
 * helper call, a timer — keeps the historical script treatment.
 */
function isModuleTopAwait(hit: ModuleTopWord): boolean {
  return (
    hit.word === "await" &&
    !hit.arrowBody &&
    !AWAITS_BRIDGE.test(hit.after) &&
    !AWAITS_DYNAMIC_IMPORT.test(hit.after)
  );
}

/**
 * Does this TypeScript program ALREADY run at module top level?
 *
 * These are the shapes that must not be wrapped, because wrapping them changes
 * their meaning or is plain illegal. A program that exports, or that carries a
 * non-leading `import` statement, is a module by construction; a genuine
 * top-level `await` is the documented module-script habit; a bare call at the
 * very first line is the documented "complete script" habit (`main();`).
 *
 * ## W2060: the decision is made on TOKENS, not on a regex over the whole text
 *
 * The previous rule was
 *
 *     if (/(?:^|[^\w$])(?:await|import|export)\b/.test(rest-of-program)) return true;
 *
 * which matched the WORD anywhere — inside a string, a comment, an object key,
 * and (the production defect) inside a loop or a function body. A bare statement
 * list that merely awaited something was therefore emitted verbatim as a
 * "script", and its top-level `return` became
 * `SyntaxError: Return statement is not allowed here` — even though the tool's
 * own contract recommends exactly that shape and the SDK preamble promises that
 * `await tools.<name>({…})` "is the same thing (awaiting a value is free)".
 * [scanModuleWords] replaces the regex; [isModuleTopAwait] keeps the one `await`
 * operand that is NOT evidence of module scope.
 */
function startsAtModuleTop(code: string): boolean {
  const lines = splitProgramLines(code);
  const start = lines.findIndex((line) => line.trim() !== "");
  if (start < 0) return false;
  const words = scanModuleWords(code);
  if (words.some(isModuleOnlyWord)) return true;
  if (words.some(isModuleTopAwait)) return true;
  // A bare CALL at the very top is the documented "complete script" habit
  // (`main();`). A control-flow HEADER also ends in `(` but is not a call, and a
  // `const`/`let`/`var` line is not one either — its initializer may CONTAIN a
  // call, which is why this test is on the LINE SHAPE, not on `includes("(")`.
  const head = /^([A-Za-z_$][\w$]*)\s*\(/.exec(lines[start]!.trim());
  return head !== null && !NON_CALL_HEADS.has(head[1]!);
}

/** The whole-program classification: see the module header for the rule table. */
export function programLayout(code: string, language: RunCodeLanguage): ProgramLayout {
  if (definesEntryPoint(code, language)) return { form: "script", code, hoisted: "", hoistedNames: [], hoistNote: null };
  // Python has one form and one only: a body. Its wrapper indents every line,
  // so a non-indented main-less program is supported the same way — including
  // the `import`-first quick script, whose imports the wrapper lifts to module
  // scope (see [wrapPythonBody]).
  if (language === "python") return plain("body", code);
  if (firstNonblankLineIndented(code)) return plain("body", code);
  const hoisted = hoistLeadingImports(code);
  if (hoisted.imports !== "") {
    return { form: "body", code: hoisted.rest, hoisted: hoisted.imports, hoistedNames: hoisted.names, hoistNote: null };
  }
  // A program that starts at module top level — or starts with an import this
  // module refused to lift — keeps the historical SCRIPT treatment: it is
  // emitted verbatim, and the SDK runner reports a missing `main` as a PROGRAM
  // error (never as an infrastructure `aborted`).
  if (startsAtModuleTop(code)) return { ...plain("script", code), hoistNote: hoisted.note };
  return plain("body", code);
}

function plain(form: ProgramForm, code: string): ProgramLayout {
  return { form, code, hoisted: "", hoistedNames: [], hoistNote: null };
}

/** The leading `import` block of a program, plus what the wrapper must know. */
export interface HoistedImports {
  /** The import lines verbatim (module scope), or `""` when none were hoisted. */
  imports: string;
  /** The rest of the program (the function body). */
  rest: string;
  /** The names those imports bind, so the body does not redeclare them. */
  names: readonly string[];
  /** Why nothing was hoisted, when that is the outcome. */
  note: string | null;
}

/**
 * Lift the LEADING `import` block out of a main-less TypeScript program.
 *
 * The boundary is deliberately narrow, because the transformation is textual:
 *
 * - only lines from the top of the program are considered; the first line that
 *   is neither an `import` nor blank ENDS the block. A line that merely
 *   CONTAINS the word `import` (a comment, a string, a `require`, a
 *   `import(...)` expression) is not one, because a real import statement
 *   always starts with `import`;
 * - a multi-line form (`import {\n  a,\n} from "x";`) or a dynamic `import(`
 *   makes the whole hoist bail out ([hoistNote] explains why) — guessing where
 *   such a statement ends could move unrelated statements to module scope;
 * - hoisting is refused outright when the body already binds one of the imported
 *   names, when it binds any name more than once, or when it declares its own
 *   `main`: any of those turns "the import is visible in the body" into a
 *   `SyntaxError` ("Identifier 'x' has already been declared"), and a refused
 *   hoist keeps the historical behaviour (the module-scope import is still
 *   visible inside the wrapper) instead of breaking a program that used to work.
 *
 * The transformation is therefore always "move the imports up", never "rewrite
 * them": the import lines are emitted verbatim, one per line.
 */
export function hoistLeadingImports(code: string): HoistedImports {
  const lines = splitProgramLines(code);
  const imports: string[] = [];
  let index = 0;
  let note: string | null = null;
  for (; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "") continue;
    if (!/^import\b/.test(line)) break;
    if (!isSingleLineImport(line)) {
      note = "a multi-line or dynamic import cannot be hoisted safely; it stays inside the wrapped body (use a top-level await, or call main(), to run this program as a script)";
      break;
    }
    imports.push(line);
  }
  if (note !== null || imports.length === 0) {
    return { imports: "", rest: code, names: [], note };
  }
  const names = imports.flatMap(importedNames);
  const rest = lines.slice(index).join("\n");
  const blocked = hoistBlocker(names, rest);
  if (blocked !== null) return { imports: "", rest: code, names: [], note: blocked };
  return { imports: terminate(imports.join("\n")), rest, names, note: null };
}

/**
 * The names an `import` line binds in the module scope.
 *
 * `import { a as b }` binds `b`; `import * as ns` binds `ns`; `import d, { x }`
 * binds `d` and `x`. A `type`-only specifier binds nothing at runtime, which is
 * why it is skipped (and why an import of only types is still safe to hoist).
 */
export function importedNames(line: string): string[] {
  const names: string[] = [];
  const braces = /\{([^}]*)\}/.exec(line);
  if (braces !== null) {
    for (const specifier of braces[1]!.split(",")) {
      const text = specifier.trim();
      if (text === "" || /^type\s/.test(text)) continue;
      const parts = text.split(/\s+as\s+/);
      const bound = (parts[1] ?? parts[0] ?? "").trim();
      if (bound !== "") names.push(bound);
    }
  }
  const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(line);
  if (namespace !== null) names.push(namespace[1]!);
  const defaultBinding = /^import\s+([A-Za-z_$][\w$]*)/.exec(line);
  if (defaultBinding !== null) names.push(defaultBinding[1]!);
  return names;
}

/**
 * A single-line import statement — the only shape this line-based hoist accepts.
 *
 * A side-effect import (\`import "node:fs";\`) IS accepted: it is single-line and
 * binds nothing, and leaving it inside the wrapper would be a SyntaxError —
 * strictly worse than running it at module scope, where it belongs. A multi-line
 * block (\`import {\` … \`} from "x";\`) or a dynamic \`import(\` is refused: guessing
 * where such a statement ends could move unrelated statements to module scope.
 */
function isSingleLineImport(line: string): boolean {
  const text = line.trim();
  if (text === "" || /^import\s*\(/.test(text)) return false;
  if (/^import\s*["'][^"']*["']\s*;?$/.test(text)) return true;
  if (!/from\s*["'][^"']*["']\s*;?$/.test(text)) return false;
  return (text.match(/[{([]/g) ?? []).length === (text.match(/[})\]]/g) ?? []).length;
}

/** Why hoisting would collide with the body, or `null` when it is safe. */
function hoistBlocker(names: readonly string[], rest: string): string | null {
  const bound = new Map<string, number>();
  const bump = (name: string): void => {
    bound.set(name, (bound.get(name) ?? 0) + 1);
  };
  for (const line of splitProgramLines(rest)) {
    for (const name of declaredNames(line)) bump(name);
  }
  const shadowed = names.filter((name) => bound.has(name));
  if (shadowed.length > 0) {
    return "the body also binds " + shadowed.join(", ") + ", so hoisting the import would declare " + (shadowed.length === 1 ? "it" : "them") + " twice; the import stays inside the wrapped body";
  }
  const duplicates = [...bound.entries()].filter(([, count]) => count > 1).map(([name]) => name);
  if (duplicates.length > 0) {
    return "the body binds " + duplicates.join(", ") + " more than once, so a hoisted import could collide with a shadowed binding; nothing was hoisted";
  }
  if (bound.has("main")) {
    return "the body declares 'main', so it is not a body at all; nothing was hoisted";
  }
  return null;
}

/**
 * A statement at column 0 that can ONLY be module level, so the Python wrapper
 * lifts it out instead of indenting it into the body: `import` / `from` / a
 * `def` or `class` (indenting one would silently NEST it) / a decorator.
 *
 * Everything else stays in the body, including `return`: that is what makes a
 * plain non-indented Python script work at all (`x = 1` / `return x` becomes
 * the body of main). Hoisting a `return` instead would put it at module scope
 * and turn a working program into `SyntaxError: 'return' outside function`.
 */
const PYTHON_TOP_LEVEL = /^(?:import|from|def|class|async\s+def|@)/;

/**
 * `async def main():` + the user body, indented one level (blank lines kept).
 *
 * Lines that are already at column 0 and can only be module-level statements
 * (`import`, `def`, `class`, a decorator, a control-flow header) are emitted
 * BEFORE the wrapper instead of being indented into it: indenting an `import`
 * is legal but surprising, and indenting a second `def` would silently nest it.
 * This is the Python analogue of the TypeScript import hoist.
 */
export function wrapPythonBody(userCode: string): { hoisted: string; body: string } {
  const hoisted: string[] = [];
  const body: string[] = [];
  for (const line of splitProgramLines(userCode)) {
    if (line.trim() === "") {
      body.push("\n");
      continue;
    }
    if (!line.startsWith(" ") && !line.startsWith("\t") && PYTHON_TOP_LEVEL.test(line)) hoisted.push(terminate(line));
    else body.push("    " + line + "\n");
  }
  return { hoisted: hoisted.join(""), body: body.join("") };
}

/**
 * `async function main() {` + the (hoisted) program + `}`.
 *
 * The hoisted imports are emitted BEFORE the wrapper — module scope, where an
 * import statement is legal. `hoistedNames` are the names the body must not
 * re-declare; the guard that enforces that lives in the injected preamble
 * (`sdk-ts.ts`), because it has to run in the CHILD, where a collision is a
 * syntax error the parent cannot see.
 */
export function wrapTypeScriptBody(code: string, hoisted: string): string {
  const head = hoisted === "" ? "" : hoisted + "\n";
  return head + "async function main() {\n" + terminate(code) + "}\n";
}

/** `async function main() {` + the user body verbatim + `}` (no imports). */
export function wrapBodyTs(userCode: string): string {
  return wrapTypeScriptBody(userCode, "");
}

/** `async def main():` + the user body, indented one level (blank lines kept). */
export function wrapBody(userCode: string): string {
  const { hoisted, body } = wrapPythonBody(userCode);
  return hoisted + "async def main():\n" + body + "\n";
}
