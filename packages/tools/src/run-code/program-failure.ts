/**
 * Why a `run_code` program produced NO protocol line (W2012) — the second half
 * of the repo's highest-failure-rate defect.
 *
 * ## The defect
 *
 * `broker.ts` sets `programError` only when the CHILD emits an `__error__`
 * protocol line. A program that is not syntactically valid never reaches that
 * code: the interpreter rejects the file before the SDK runner exists, prints
 * the reason on stderr, exits 1 — and the broker falls through to
 * `abortedMessage`:
 *
 *     run_code: code=aborted msg="program exited code=1 (killed=false) without a final line"
 *
 * `aborted` is the vocabulary of timeouts and infrastructure. The model reads
 * "the run was aborted" and hunts for the tool combination that truncated its
 * program, while the real cause is its own missing closing brace. The error
 * told it the opposite of the truth, so it could not learn from it.
 *
 * ## The classification (evidence, not guessing)
 *
 * Measured against the two real interpreters on this host (Node 26 native type
 * stripping, CPython 3):
 *
 * | program                      | stderr (first line)                                                |
 * |------------------------------|--------------------------------------------------------------------|
 * | TS, missing `}`              | `SyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]: Expected '}', got '<eof>'` |
 * | TS, `return` at top level    | `SyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]: Return statement is not allowed here` |
 * | TS, `const a = ;`            | `SyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]: Expression expected` |
 * | PY, missing `:`              | `SyntaxError: expected ':'`                                        |
 * | PY, `return` at top level    | `SyntaxError: 'return' outside function`                           |
 *
 * So: the interpreter NAMES ITSELF in stderr, and the marker is stable across
 * the whole syntax family. That is what this module keys on — no spawn-time
 * pre-check (which would need a second interpreter run, and would have to
 * re-implement type stripping to be exact), no regex on the user's source.
 *
 * Two of the messages are the engine's OWN, from the SDK runner and therefore
 * protocol-invisible in exactly the same way (`__error__` is only reachable
 * once `main` is defined): the no-main guard and the Python `RuntimeError`
 * for a main-less program. Both are classified here as `program_error` — the
 * model's program is what is wrong, and calling that "aborted" is the same lie.
 */

import type { RunCodeLanguage } from "./program-form.js";

/** The structured codes this module can produce. */
export const PROGRAM_SYNTAX_CODE = "program_syntax";
export const PROGRAM_ERROR_CODE = "program_error";

/** A classified program failure: which code, and the text the model must see. */
export interface ProgramFailure {
  kind: typeof PROGRAM_SYNTAX_CODE | typeof PROGRAM_ERROR_CODE;
  message: string;
}

/** Markers Node prints for a file it refused to parse. */
const NODE_SYNTAX_MARKERS = ["ERR_INVALID_TYPESCRIPT_SYNTAX", "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX", "SyntaxError"];
/** Markers CPython prints for a file it refused to parse. */
const PYTHON_SYNTAX_MARKERS = ["SyntaxError", "IndentationError", "TabError"];
/**
 * The engine's own "this program has no entry point" guards. BOTH phrasings are
 * listed because they come from two different producers: the Python SDK runner
 * raises \`no 'main' defined\`, while the TypeScript runner (W2012) says \`the
 * program finished without defining 'main'\`. A marker that knew only one of them
 * would silently send the other back to \`aborted\`.
 */
const NO_MAIN_MARKERS = ["no 'main' defined", "without defining 'main'"];
/** The engine's own "main is not callable" guard (SDK runner). */
const BAD_MAIN_MARKER = "'main' is not a function";
/** A Python program that imported something the sandbox does not have. */
const PYTHON_IMPORT_MARKERS = ["ModuleNotFoundError", "ImportError"];

/** The first stderr line that carries `marker` (the interpreter's own words). */
export function firstErrorLine(stderrText: string, marker: string): string | null {
  for (const raw of stderrText.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.includes(marker)) return line.length > 400 ? line.slice(0, 400) + "…" : line;
  }
  return null;
}

/** The first marker that appears in stderr, with the line that carries it. */
function findMarker(stderrText: string, markers: readonly string[]): string | null {
  for (const marker of markers) {
    const line = firstErrorLine(stderrText, marker);
    if (line !== null) return line;
  }
  return null;
}

/**
 * The `program_syntax` failure: the interpreter rejected the program itself.
 *
 * The message carries the interpreter's OWN text (`Expected '}', got '<eof>'`)
 * because that is the part that says WHAT is missing; the full stderr follows in
 * the run's render, so nothing is swallowed.
 */
function syntaxFailure(language: RunCodeLanguage, evidence: string): ProgramFailure {
  return {
    kind: PROGRAM_SYNTAX_CODE,
    message:
      "the program is not valid " + language + " — the interpreter rejected it before main() ran: " +
      evidence + " (a missing closing brace/bracket or an unterminated block is the usual cause; " +
      "the full interpreter output is below)",
  };
}

/** The `program_error` failure for the engine's own entry-point guards. */
function entryFailure(evidence: string): ProgramFailure {
  return {
    kind: PROGRAM_ERROR_CODE,
    message:
      "the program ran to its end without a usable entry point: " + evidence + " " +
      "(write the program as a function body — plain statements ending in 'return <value>' — " +
      "or as a complete script that defines main)",
  };
}

/** A Python program whose import failed: its own bug, named as such. */
function importFailure(evidence: string): ProgramFailure {
  return {
    kind: PROGRAM_ERROR_CODE,
    message:
      "the program failed while importing a module (" + evidence + "); the run_code sandbox has " +
      "the standard library only — no third-party packages and no network",
  };
}

/**
 * Classify a finished run that produced no final line, or `null` when nothing
 * in stderr explains it (the caller keeps the historical `aborted` verdict).
 *
 * Order matters: a syntax marker wins over everything (a file that never parsed
 * cannot have failed for any other reason), then the engine's own guards, then
 * Python's import errors. `null` is a real answer — a bare death with no
 * evidence stays `aborted` instead of being blamed on the model.
 */
export function classifyProgramFailure(language: RunCodeLanguage, stderrText: string): ProgramFailure | null {
  if (stderrText.trim() === "") return null;
  const syntax = findMarker(stderrText, language === "python" ? PYTHON_SYNTAX_MARKERS : NODE_SYNTAX_MARKERS);
  if (syntax !== null) return syntaxFailure(language, syntax);
  const noMain = findMarker(stderrText, [...NO_MAIN_MARKERS, BAD_MAIN_MARKER]);
  if (noMain !== null) return entryFailure(noMain);
  if (language === "python") {
    const imported = findMarker(stderrText, PYTHON_IMPORT_MARKERS);
    if (imported !== null) return importFailure(imported);
  }
  return null;
}
