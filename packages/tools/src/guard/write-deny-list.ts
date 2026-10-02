/**
 * W9269 (docs/feature-sandbox-comparison.md §3.2 gap / §4 P0) — the MANDATORY
 * WRITE DENY LIST (the `DANGEROUS_FILES` equivalent).
 *
 * ## The gap this closes
 *
 * Before this module, the path guard answered ONE question about a write: "is
 * the target inside a writable root?" Every widening mechanism in the system
 * (session grants, a preset, `allPaths`, `CELESTEA_TOOL_ROOTS`) can enlarge the
 * set of writable roots — and none of them had a floor. So a single
 * `write_file(join(home, ".bashrc"))` that had been granted the home directory
 * silently rewrote the user's shell startup file: the agent writes it once, the
 * USER executes it later. That is an execution surface, not a data file, and it
 * is the exact "意外防护" (accident protection) floor this repo was missing.
 *
 * ## Why the list is NOT a root list
 *
 * A root list is a *whitelist*: it says where you MAY write, and every
 * widening knob is a way to make it bigger. This list is a *floor*: it says
 * where you may NEVER write, and no widening knob may shrink it. The two
 * compose, they are not alternatives — which is precisely why this list is
 * evaluated LAST inside `PathGuardPolicy.checkWrite`, after (and therefore
 * regardless of) every allow decision. See the wiring comment there.
 *
 * ## WRITE only, by construction
 *
 * The list is consulted from `checkWrite` and from nowhere else. `checkRead`
 * cannot reach it, so reading `.gitconfig` or `~/.ripgreprc` stays a legal
 * diagnostic — that is the whole reason the list is a write-deny list and not a
 * blanket "forbidden paths" list. Denying the reads would break the "look at
 * my git config" task to protect nothing: reading a file does not execute it.
 *
 * ## The three shapes
 *
 * - exact FILE NAMES (`.bashrc`, `.gitconfig`, …): the FINAL component of the
 *   write target, compared by the platform's basename rules;
 * - single-component DIRECTORY prefixes (`.vscode`, `.idea`): any path
 *   component equal to the prefix, plus everything below it. The component test
 *   (not a string prefix) is what keeps `.vscode-legacy/` and `my.vscode/`
 *   writable;
 * - a MULTI-component directory prefix (`.claude/commands`): the consecutive
 *   components `.claude` then `commands` at any depth, plus everything below.
 *   A project's `.claude/` settings are ordinary repo content, so the deny is
 *   deliberately narrower than "`.claude`".
 *
 * ## Platform is a PARAMETER
 *
 * `platform` is injectable (AGENT.md §8 / W885 / W9110 precedent) so the win32
 * case is provable on a Linux CI runner and the POSIX case on Windows. The two
 * differ in exactly the way that makes this module a security control at all:
 *
 * - **case**: Windows file names are case-INSENSITIVE, so `.BASHRC` and
 *   `.bashrc` are THE SAME FILE there; on POSIX they are two different files
 *   and folding case would deny writes the user never considered dangerous.
 *   Therefore win32 folds, POSIX does not.
 * - **separator**: win32 accepts `/` and `\\` interchangeably, so the
 *   comparison normalises to `\\`; POSIX segments on `/` only.
 *
 * A test that ran only on the host platform would pass everywhere and protect
 * nothing, so `denyListMatch` takes the platform explicitly.
 */
import { GUARD_ERROR_PREFIX, contractError } from "../errors.js";
import { isWindows, pathApi } from "../platform/paths.js";
import type { ToolDecision } from "@celestea/core";

/**
 * Stable contract code for a write-deny-list refusal.
 *
 * A NAMED code, not a bare string and not a silent skip: a caller can branch on
 * `code=path_dangerous_write` and tell "this path is never writable, whatever
 * your grants say" apart from `code=path_forbidden` ("this path is outside your
 * roots right now") — two decisions a caller genuinely needs to tell apart, and
 * the first one is not fixed by widening anything.
 */
export const DANGEROUS_WRITE_CODE = "path_dangerous_write";

/**
 * Exact FILE NAMES that may never be the target of a write.
 *
 * Ordered as the doc lists them (§4 P0) so the contract error and this list
 * read the same way in a diff. The whole set is dotfiles: shell startup files
 * (`.bashrc`, `.bash_profile`, `.zshrc`, `.profile`) plus the config
 * surfaces that change what the user's own tools execute or resolve
 * (`.gitconfig`, `.gitmodules`, `.mcp.json`, `.ripgreprc`).
 */
export const DANGEROUS_WRITE_FILES: readonly string[] = Object.freeze([
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".profile",
  ".gitconfig",
  ".gitmodules",
  ".mcp.json",
  ".ripgreprc",
]);

/**
 * Single-component DIRECTORY prefixes (matched on a whole path component, at
 * any depth, together with everything below them).
 */
export const DANGEROUS_WRITE_DIRS: readonly string[] = Object.freeze([".vscode", ".idea"]);

/**
 * Multi-component DIRECTORY prefixes, relative and matched at any depth: the
 * write is refused when these components appear consecutively in the path. The
 * doc's §4 P0 lists exactly one of these: `.claude/commands`.
 */
export const DANGEROUS_WRITE_DIR_PREFIXES: readonly (readonly string[])[] = Object.freeze([
  Object.freeze([".claude", "commands"]),
]);

/** What a write target matched, and under which rule. */
export interface DenyListMatch {
  /** The deny-list entry that matched, in its documented spelling. */
  readonly entry: string;
  /** Which rule matched. */
  readonly shape: "file" | "dir" | "dir-prefix";
}

/**
 * The win32 spelling used for COMPARISON only: lowercase + `\\` separators.
 *
 * Same reasoning as `foldWin32` in `paths.ts` — and the same rule about never
 * building a path from it: only the two sides of a comparison see this.
 */
function foldForCompare(segment: string, platform: string): string {
  if (!isWindows(platform)) return segment;
  return segment.toLowerCase().replace(/\//g, "\\");
}

/** Split an absolute path into its components under the platform's separator rules. */
function splitSegments(normalized: string, platform: string): string[] {
  return normalized
    .split(isWindows(platform) ? /[\\/]+/ : "/")
    .filter((segment) => segment !== "");
}

/** The documented spellings, joined for the denial message. */
const LIST_TEXT = [
  DANGEROUS_WRITE_FILES.join(", "),
  DANGEROUS_WRITE_DIRS.join(", "),
  ...DANGEROUS_WRITE_DIR_PREFIXES.map((parts) => parts.join("/")),
].join(", ");

/**
 * Which deny-list entry (if any) a write target hits.
 *
 * `target` must already be ABSOLUTE and normalized (the guard hands it the
 * canonical write target); this function does no fs access and is therefore
 * safe to call on a path that does not exist yet — a write is judged by where
 * the bytes WOULD land.
 *
 * Returns `null` when the target is not on the list, so a caller can use it
 * directly as an "is this dangerous?" test.
 */
export function denyListMatch(target: string, platform: string = process.platform): DenyListMatch | null {
  const api = pathApi(platform);
  // `normalize` first so `a/.vscode/../ok.txt` is judged on where the write
  // actually lands. (The guard also canonicalizes through realpath, but the
  // deny must not depend on that: a path inside a symlink-free but lexically
  // dirty argument has to be judged the same way on every host.)
  const segments = splitSegments(api.normalize(target), platform);
  if (segments.length === 0) return null;
  const folded = segments.map((segment) => foldForCompare(segment, platform));

  // ① the final component as an exact file name.
  const lastFolded = folded[folded.length - 1] as string;
  for (const file of DANGEROUS_WRITE_FILES) {
    if (lastFolded === foldForCompare(file, platform)) return { entry: file, shape: "file" };
  }

  // ② a single-component directory prefix anywhere in the path (the target may
  //    BE the directory: a tool that creates `<ws>/.vscode` is refused too).
  for (const dir of DANGEROUS_WRITE_DIRS) {
    const dirFolded = foldForCompare(dir, platform);
    if (folded.includes(dirFolded)) return { entry: dir, shape: "dir" };
  }

  // ③ a multi-component directory prefix appearing consecutively at any depth.
  for (const parts of DANGEROUS_WRITE_DIR_PREFIXES) {
    const partsFolded = parts.map((part) => foldForCompare(part, platform));
    for (let start = 0; start + partsFolded.length <= folded.length; start += 1) {
      let hit = true;
      for (let offset = 0; offset < partsFolded.length; offset += 1) {
        if (folded[start + offset] !== partsFolded[offset]) {
          hit = false;
          break;
        }
      }
      if (hit) return { entry: parts.join("/"), shape: "dir-prefix" };
    }
  }
  return null;
}

/**
 * The structured refusal for a deny-listed write target.
 *
 * Rendered through [contractError] with the guard family prefix, exactly like
 * `path-guard.ts`'s own denials — so the one-line contract stays
 * `toolguard: code=<code> msg="…"` and a consumer can still classify it with
 * `denialFamily()` / `errorCode()` (errors.ts, W1483).
 */
export function dangerousWriteDecision(target: string, match: DenyListMatch, platform: string = process.platform): ToolDecision {
  const rule =
    match.shape === "file"
      ? `file name '${match.entry}'`
      : match.shape === "dir"
        ? `directory prefix '${match.entry}'`
        : `directory prefix '${match.entry}'`;
  const reason = contractError(
    GUARD_ERROR_PREFIX,
    DANGEROUS_WRITE_CODE,
    `write path '${target}' is on the mandatory deny list (${rule}); no grant, preset, allPaths or CELESTEA_TOOL_ROOTS can make it writable. Deny list: ${LIST_TEXT}. Reads are not affected. (platform=${platform})`,
  );
  return { kind: "deny", reason };
}

/**
 * true when `target` may not be written, under the deny list alone.
 *
 * A tiny convenience over `denyListMatch` for callers that only need the
 * predicate (tests, diagnostics).
 */
export function isDangerousWrite(target: string, platform: string = process.platform): boolean {
  return denyListMatch(target, platform) !== null;
}
