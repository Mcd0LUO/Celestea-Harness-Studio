/**
 * The production path-whitelist guard (`crates/tools/src/guard.rs`).
 *
 * Policy:
 * - the **workspace** (`CELESTEA_TOOL_WORKDIR`, default: process cwd) is the
 *   only writable root — W768: for a composed SESSION it is that session's own
 *   workspace root (passed as a [SessionFsScope]), because a process serves many
 *   sessions and one env knob cannot be all of their workspaces;
 * - `CELESTEA_TOOL_ROOTS` is a comma-separated list of extra READ roots
 *   (whitelist roots are read-only: the workspace is the writable subset);
 * - **argument-driven, never a name whitelist (W738 P1)**: the guard inspects the
 *   ARGUMENTS of the call. Any tool whose arguments carry a path-like value (see
 *   [PATH_ARG_KEYS]) is arbitrated; [PATH_ACCESS] only declares *which* access a
 *   **known** tool needs — `read` (`read_file`, `list_dir`), `write`
 *   (`write_file`), or `self` for the tools that carry their own confinement
 *   layer (`run_shell`: the sandbox root; `spawn_worker`: the host-side session
 *   RPC). A tool that is NOT declared is checked as a **write**: it may only
 *   touch the writable roots. A newly registered tool is therefore constrained
 *   by default and can never be fail-OPEN just because nobody added it to a
 *   list;
 * - a missing/ill-typed path argument passes through: the tool's own validation
 *   reports it, the guard only arbitrates real paths.
 *
 * **Fail closed**: when `CELESTEA_TOOL_ROOTS` is set but an entry cannot be used
 * (missing, not a directory, unlistable), the policy denies every path-bearing
 * call with `code=tool_roots_invalid` instead of silently ignoring the entry —
 * an operator typo must never quietly widen or narrow access.
 *
 * `CELESTEA_TOOL_GUARD=0` skips *mounting* the chain (explicit escape hatch; it
 * never weakens the http policy or the sandbox).
 *
 * W516 (session grants): a host may pass a [PathGuardGrants] view with extra
 * read/write roots read from the session's `grants.json`. Grants are strictly
 * ADDITIVE — the workspace stays writable, env read roots stay read-only, the
 * mount decision is untouched — and a bad grant root is dropped by the host
 * (ignore-the-entry), the exact opposite of the env fail-closed rule above.
 * Both policies are deliberate: env is the operator's posture (a typo must be
 * loud), grants are a per-session widening (ignoring one falls back to least
 * privilege, and a hard failure would only push users to `CELESTEA_TOOL_GUARD=0`).
 */

import type { ToolDecision, ToolGuard, ToolInput, ToolRegistry } from "@celestea/core";

import { resolve } from "node:path";

import { envFlag, envString } from "../env.js";
import { contractError } from "../errors.js";
import { pathDelimiter } from "../platform/paths.js";
import type { SessionFsScope } from "../sandbox/config.js";
import { absolutize, isDirectory, isInside, resolveExistingTarget, resolveWriteTarget } from "./paths.js";
import { dangerousWriteDecision, denyListMatch } from "./write-deny-list.js";

/**
 * W9269: re-exported so a consumer of the path guard gets the deny-list
 * contract code from the SAME module that enforces it, instead of re-deriving
 * the string (or importing the list module purely for the constant).
 */
export { DANGEROUS_WRITE_CODE, denyListMatch, isDangerousWrite } from "./write-deny-list.js";

export const ENV_TOOL_ROOTS = "CELESTEA_TOOL_ROOTS";
export const ENV_TOOL_WORKDIR = "CELESTEA_TOOL_WORKDIR";
export const ENV_TOOL_GUARD = "CELESTEA_TOOL_GUARD";
export const GUARD_ERROR_PREFIX = "toolguard";

const ALLOW: ToolDecision = { kind: "allow" };

/** Access a tool needs to its path-like arguments. */
export type PathAccess = "read" | "write" | "self";

/**
 * Declared access per **known** tool (W738 P1). `self` = the tool confines the
 * path in its own layer, so this guard stays out of the way. Everything absent
 * from this map is treated as `write` (the fail-closed floor), NOT as `allow`.
 */
export const PATH_ACCESS: ReadonlyMap<string, PathAccess> = new Map<string, PathAccess>([
  ["read_file", "read"],
  ["list_dir", "read"],
  // W819-7: read_image(path=...) is the documented peer of read_file under
  // the same sandbox guard (docs/feature-multimodal-attachments/02-design.md 5.5);
  // leaving it undeclared made the write floor refuse a readable root.
  ["read_image", "read"],
  ["write_file", "write"],
  ["run_shell", "self"],
  ["spawn_worker", "self"],
]);

/**
 * Argument names carrying a path. Deliberately argument-based: a new tool with a
 * `path`/`dir`/`workspace` argument is arbitrated without any registration step.
 */
export const PATH_ARG_KEYS: readonly string[] = [
  "path",
  "paths",
  "file",
  "files",
  "dir",
  "dirs",
  "directory",
  "workdir",
  "cwd",
  "root",
  "roots",
  "workspace",
];

/**
 * Platform path-list separator: `:` on unix, `;` on windows — the same
 * semantics as `std::env::split_paths`. A comma is ALSO accepted (the
 * earlier TS-only documentation used commas), so `CELESTEA_TOOL_ROOTS` may be
 * written either way.
 *
 * Note the platform distinction matters: a windows drive letter (`C:\dir`)
 * must not be split on `:`.
 */
function listSeparator(platform: string): RegExp {
  return new RegExp(`[${pathDelimiter(platform)},]`);
}

/**
 * Split a root list (platform separator or comma; empty entries skipped).
 *
 * W885: the separator is resolved from the INJECTED platform (default: the
 * host), so a win32 test proves a drive letter survives the split instead of
 * being cut at its colon.
 */
export function parseToolRoots(value: string | undefined, platform: string = process.platform): string[] {
  if (value === undefined) return [];
  return value
    .split(listSeparator(platform))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * W9110 — the ALL-PATHS *spelling*: the one canonical NAME of "every path on
 * this host", as it appears inside a root LIST.
 *
 * "All paths" is a CAPABILITY, not a path. `"/"` is its name because on POSIX it
 * *is* the single filesystem root, and on Windows no real path ever
 * canonicalizes to it (`path.win32.resolve("/")` is the current drive root).
 *
 * W9205 — WHY THIS IS ONLY A SPELLING AND NEVER THE SOURCE OF TRUTH.
 *
 * A string that can also be a real path is not a safe sentinel. The W9110 shape
 * read the capability out of the COMPOSED root list, and that list always begins
 * with the workspace, so `workspace === "/"` silently manufactured the
 * capability: a policy built with `workspaceWritable: false` — an explicitly
 * READ-ONLY session — answered `checkWrite("/etc/cron.d/evil") = allow`. The
 * doc-comment above used to claim "the two readings can never collide"; that
 * claim was false, and the collision was the whole bug.
 *
 * The fix is structural:
 *   - the capability is carried by explicit BOOLEANS
 *     ([PathGuardPolicyInit.allPaths], and the split
 *     `allPathsRead` / `allPathsWrite`);
 *   - this spelling is honoured ONLY on the caller-DECLARED root lists
 *     ([PathGuardPolicyInit.readRoots] / `writeRoots`) and NEVER on the implicit
 *     workspace element, so no workspace value can imply it;
 *   - READ and WRITE are SEPARATE capabilities. A `"/"` READ root opens reads
 *     only, so a read-only baseline that happens to list `"/"` still denies
 *     every write (the second half of the same P0).
 *
 * The `"/"` spelling is kept rather than deleted because two consumers OUTSIDE
 * this package speak roots, not capabilities: the engine's composed grants
 * serialise it into both lists, and bwrap's POSIX argv maps a `"/"` WRITE root
 * onto `--bind / /`. Keeping the byte keeps those paths unchanged; the
 * capability simply no longer depends on reading it back.
 *
 * [PathGuardPolicy] consumes it as a capability (checkRead/checkWrite short
 * circuit); it is NEVER matched as a string prefix.
 */
export const ALL_PATHS_ROOT = "/";

/**
 * true when a CALLER-DECLARED root list carries the all-paths spelling.
 *
 * W9205: the caller must pass the list it DECLARED — never a composed list that
 * already contains the workspace, which is exactly how `workspace === "/"`
 * used to fabricate the capability (see [ALL_PATHS_ROOT]).
 */
function hasAllPathsRoot(declaredRoots: readonly string[]): boolean {
  return declaredRoots.includes(ALL_PATHS_ROOT);
}

export interface PathGuardPolicyInit {
  workspace: string;
  readRoots?: readonly string[];
  /**
   * Extra WRITABLE roots (session grants only, W516). The workspace is always a
   * writable root and can never be removed: grants only ADD roots.
   */
  writeRoots?: readonly string[];
  /** W9: false = a read-only permission; the workspace is NOT a write root. */
  workspaceWritable?: boolean;
  /**
   * W9110: the whole host is readable AND writable — a first-class CAPABILITY
   * (both halves at once). checkRead/checkWrite allow any target without
   * consulting the root lists.
   *
   * W9205: this is the ONLY way a caller says "both". The `"/"` spelling in a
   * DECLARED roots list is read as the matching HALF only — `readRoots: ["/"]`
   * opens reads, `writeRoots: ["/"]` opens writes — so a read-only baseline
   * that happens to list `"/"` can no longer be talked into writing.
   */
  allPaths?: boolean;
  /** Set when the declared roots were unusable → every path call is denied. */
  failClosedReason?: string | null;
  /**
   * W9269: the platform the write deny list is judged under (case + separator
   * rules). Defaults to the HOST at the call site, per the AGENT.md §8 / W885
   * "platform is a parameter" rule, so a win32 test is provable on a Linux host.
   */
  platform?: string;
}

/**
 * Session-grant view of the path policy (W516). Structural on purpose: the
 * tools package never imports the host's grants module. Both lists are already
 * validated + canonicalized by the host (`effectiveGrantsOf`), and neither can
 * *narrow* anything — they are appended to the env-derived roots.
 */
export interface PathGuardGrants {
  readRoots?: readonly string[];
  writeRoots?: readonly string[];
  /** W9: the permission baseline's write capability (false = read-only). */
  workspaceWritable?: boolean;
  /** W9110: the whole host is readable + writable (a capability, not a root). */
  allPaths?: boolean;
}

/** Canonical writable workspace + canonical read/write roots (workspace first). */
export class PathGuardPolicy {
  readonly workspace: string;
  readonly readRoots: readonly string[];
  /** Workspace first; grants may only append (never remove or demote). */
  readonly writeRoots: readonly string[];
  /**
   * W9110/W9205: the whole host is readable AND writable — a CAPABILITY, not a
   * root. Derived from [allPathsRead] && [allPathsWrite], so it stays a truthful
   * summary of the two halves; the halves themselves are what checkRead and
   * checkWrite consult, and they are NOT the same flag.
   */
  readonly allPaths: boolean;
  /**
   * W9205: the whole host is READABLE. Set by `allPaths: true` or by the
   * `"/"` spelling on the caller-DECLARED read list — never by the workspace
   * (the defect this field exists to kill) and never by the write list.
   */
  readonly allPathsRead: boolean;
  /**
   * W9205: the whole host is WRITABLE. Set by `allPaths: true` or by the
   * `"/"` spelling on the caller-DECLARED write list — never by the workspace
   * and never by the read list. A read-only baseline can therefore never acquire
   * write access by naming `"/"` as a read root.
   */
  readonly allPathsWrite: boolean;
  readonly failClosedReason: string | null;
  /** W9269: platform the deny list is judged under (defaults to the host). */
  readonly platform: string;

  constructor(init: PathGuardPolicyInit) {
    this.workspace = init.workspace;
    this.readRoots = [init.workspace, ...(init.readRoots ?? [])];
    this.writeRoots = init.workspaceWritable === false ? [...(init.writeRoots ?? [])] : [init.workspace, ...(init.writeRoots ?? [])];
    // W9205: the spelling is read off the DECLARED lists ONLY — passing
    // `this.readRoots` here is what let `workspace === "/"` fabricate the
    // capability. `allPaths` is the explicit both-halves flag, so it feeds both.
    const declaredRead = init.readRoots ?? [];
    const declaredWrite = init.writeRoots ?? [];
    const explicit = init.allPaths === true;
    this.allPathsRead = explicit || hasAllPathsRoot(declaredRead);
    this.allPathsWrite = explicit || hasAllPathsRoot(declaredWrite);
    this.allPaths = this.allPathsRead && this.allPathsWrite;
    this.failClosedReason = init.failClosedReason ?? null;
    this.platform = init.platform ?? process.platform;
  }

  /**
   * Policy from the environment (`CELESTEA_TOOL_WORKDIR` + `CELESTEA_TOOL_ROOTS`).
   *
   * W768: `scope` replaces the WORKSPACE with the session's own root. That is the
   * one thing a session may move, and it moves only the writable root plus the
   * implicit read root ([PathGuardPolicy] always lists the workspace first in
   * both) — `CELESTEA_TOOL_ROOTS` keeps contributing exactly the read roots the
   * operator declared, and grants keep appending. No env entry is dropped, so a
   * session cannot end up narrower than the posture it was composed under.
   */
  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    grants: PathGuardGrants = {},
    scope: SessionFsScope | null = null,
    platform: string = process.platform,
  ): PathGuardPolicy {
    const workspaceRaw = scope?.workspace ?? envString(env, ENV_TOOL_WORKDIR) ?? process.cwd();
    const workspace = resolveExistingTarget(workspaceRaw, process.cwd()) ?? resolve(workspaceRaw);
    const grantRead = [...(grants.readRoots ?? [])];
    const writeRoots = [...(grants.writeRoots ?? [])];
    // W9110: the all-paths capability is forwarded verbatim; it is widen-only
    // (nothing here can turn it off) and independent of the env roots below.
    const allPaths = grants.allPaths === true;
    /**
     * W9205: ONE shared base for all three exits below.
     *
     * The previous shape repeated the constructor literal three times and the
     * third copy silently dropped `workspaceWritable` — so a READ-ONLY session
     * (the `read-only` permission baseline) became writable again the moment
     * `CELESTEA_TOOL_ROOTS` listed any usable directory, which is the PRODUCTION
     * case (`scripts/run-studio-ts.sh` always sets it). Every field now travels
     * through this object, so a fourth exit cannot forget one either.
     */
    // W9269: the platform travels in the SAME shared `base` as every other
    // field, for the reason the W9205 comment above gives: fromEnv has three
    // exits and a field that is not in `base` is a field one of them silently
    // drops. Here the loss would be quieter still -- the deny list would fall
    // back to the HOST's case/separator rules, so a win32 session audited from
    // a posix host would answer "allowed" for .BASHRC.
    const base = { workspace, readRoots: grantRead, writeRoots, workspaceWritable: grants.workspaceWritable, allPaths, platform };
    const raw = envString(env, ENV_TOOL_ROOTS);
    if (raw === undefined) return new PathGuardPolicy(base);
    const entries = parseToolRoots(raw);
    if (entries.length === 0) {
      return new PathGuardPolicy({ ...base, failClosedReason: `${ENV_TOOL_ROOTS} is set but lists no directory` });
    }
    const readRoots: string[] = [];
    let failClosedReason: string | null = null;
    for (const entry of entries) {
      const canonical = resolveExistingTarget(entry, workspace);
      if (canonical === null) failClosedReason ??= `${ENV_TOOL_ROOTS} entry '${entry}' does not exist`;
      else if (!isDirectory(canonical)) failClosedReason ??= `${ENV_TOOL_ROOTS} entry '${entry}' is not a directory`;
      else readRoots.push(canonical);
    }
    return new PathGuardPolicy({ ...base, readRoots: [...readRoots, ...grantRead], failClosedReason });
  }

  /** read/list: the canonical target must resolve inside a read root. */
  checkRead(target: string): ToolDecision {
    const blocked = this.failClosed();
    if (blocked !== null) return blocked;
    // W9110: "all paths" means exactly that — there is no containment test to
    // run. Fail-closed still wins above, so a broken CELESTEA_TOOL_ROOTS denies
    // every path even under allPaths.
    //
    // W9205: the READ half, not the combined flag. A read-only policy whose
    // write side is closed must still be able to open reads.
    if (this.allPathsRead) return ALLOW;
    const canonical = resolveExistingTarget(target, this.workspace);
    if (canonical === null) return ALLOW;
    if (this.readRoots.some((root) => isInside(canonical, root))) return ALLOW;
    return deny(
      "path_forbidden",
      `read/list path '${target}' is outside the allowed roots (workspace '${this.workspace}' + ${ENV_TOOL_ROOTS})`,
    );
  }

  /**
   * write: the canonical target must land inside ONE writable root. The
   * workspace is always one (§5.6: grants can only add roots); read roots are
   * still read-only and a write root overlapping a read root is rejected by the
   * host before it ever reaches this policy.
   */
  checkWrite(target: string): ToolDecision {
    const blocked = this.failClosed();
    if (blocked !== null) return blocked;
    // The MANDATORY write deny list (W9269) is the LAST gate: every branch that
    // would otherwise ALLOW a write — the allPathsWrite short circuit, an
    // unresolvable target, and a target inside a writable root — is funnelled
    // through `allowWrite()`, which re-checks the deny list FIRST. That ordering
    // is the whole point: grants / a preset / allPaths / CELESTEA_TOOL_ROOTS can
    // only ever change the *root set* that gets here, and none of them can make
    // a deny-listed target writable because the deny is applied after all of
    // them, on the single allow path. Putting it before the root tests instead
    // would make a denied path fall through to `path_forbidden` under a narrow
    // policy (the wrong, non-actionable code) and — worse — a future allow branch
    // added after the deny would silently bypass it. One exit, deny last.
    return this.allowWrite(target);
  }

  /**
   * The single allow path for a write. Applies the deny list, then the root
   * test, so the deny wins over every widening mechanism.
   */
  private allowWrite(target: string): ToolDecision {
    // W9269: the deny list is judged on the CANONICAL write target — the place
    // the bytes would ACTUALLY land, with symlinks resolved — not on the string
    // the caller typed. The lexical form is checked too, as a second, cheaper
    // opinion: a symlink inside the workspace pointing at $HOME would otherwise
    // carry a directory-prefix denial straight past a lexical-only test
    // (`<ws>/link/.vscode/x` has no `.vscode` component of its own).
    const canonical = resolveWriteTarget(target, this.workspace);
    const judged = canonical ?? absolutize(target, this.workspace);
    const match = denyListMatch(judged, this.platform) ?? denyListMatch(target, this.platform);
    if (match !== null) return dangerousWriteDecision(judged, match, this.platform);
    // W9110: see checkRead — the capability short circuits, fail-closed does not.
    // W9205: the WRITE half. This is the line the P0 turned on: it used to read
    // the combined flag, which the workspace alone could set to true.
    if (this.allPathsWrite) return ALLOW;
    if (canonical === null) return ALLOW;
    if (this.writeRoots.some((root) => isInside(canonical, root))) return ALLOW;
    return deny("path_forbidden", this.writeDenyMessage(target));
  }

  /** Verbatim legacy message with no extra roots; explicit root list beyond it. */
  private writeDenyMessage(target: string): string {
    if (this.writeRoots.length <= 1) return `write path '${target}' is outside the workspace '${this.workspace}'`;
    return `write path '${target}' is outside every writable root (${this.writeRoots.join(", ")})`;
  }

  private failClosed(): ToolDecision | null {
    if (this.failClosedReason === null) return null;
    return deny(
      "tool_roots_invalid",
      `${this.failClosedReason} — failing closed: path tools are denied until ${ENV_TOOL_ROOTS} is fixed`,
    );
  }
}

/**
 * The guard: arbitrates every path-like argument of every tool. Only an explicit
 * `self` declaration (see [PATH_ACCESS]) hands a tool's paths back to its own
 * confinement layer; an unknown tool is checked as a write.
 */
export class PathGuard implements ToolGuard {
  private readonly policy: PathGuardPolicy;
  private readonly access: ReadonlyMap<string, PathAccess>;

  constructor(policy: PathGuardPolicy, access: ReadonlyMap<string, PathAccess> = PATH_ACCESS) {
    this.policy = policy;
    this.access = access;
  }

  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    grants: PathGuardGrants = {},
    access: ReadonlyMap<string, PathAccess> = PATH_ACCESS,
    scope: SessionFsScope | null = null,
  ): PathGuard {
    return new PathGuard(PathGuardPolicy.fromEnv(env, grants, scope), access);
  }

  async check(input: ToolInput): Promise<ToolDecision> {
    const access = this.access.get(input.name) ?? "write";
    if (access === "self") return ALLOW;
    // W824 (W812 P0-2): normalize relative path arguments against the SESSION
    // workspace BEFORE arbitrating and before the tool opens them. The fs tools
    // receive the same args object the guard inspected, so rewriting it here
    // makes the checked path and the opened path byte-identical; leaving them
    // relative let the guard check <workspace>/x while fs opened
    // <process.cwd()>/x.
    const targets = normalizePathArguments(input.args, this.policy.workspace);
    if (targets.length === 0) return ALLOW;
    return this.checkAll(targets, access);
  }

  /** Every path-like argument must pass; the first denial wins. */
  private checkAll(targets: readonly string[], access: Exclude<PathAccess, "self">): ToolDecision {
    for (const target of targets) {
      const decision = access === "read" ? this.policy.checkRead(target) : this.policy.checkWrite(target);
      if (decision.kind !== "allow") return decision;
    }
    return ALLOW;
  }
}

/**
 * Rewrite every relative path-like argument to its absolute workspace-relative
 * form (in place) and return the normalized values in [PATH_ARG_KEYS] order.
 */
function normalizePathArguments(args: unknown, workspace: string): string[] {
  if (typeof args !== "object" || args === null) return [];
  const record = args as Record<string, unknown>;
  const found: string[] = [];
  for (const key of PATH_ARG_KEYS) {
    const value = record[key];
    if (typeof value === "string") {
      const absolute = absolutize(value, workspace);
      if (absolute !== value) record[key] = absolute;
      found.push(absolute);
    } else if (Array.isArray(value)) {
      record[key] = value.map((entry) => {
        if (typeof entry !== "string") return entry;
        const absolute = absolutize(entry, workspace);
        found.push(absolute);
        return absolute;
      });
    }
  }
  return found;
}

function deny(code: string, message: string): ToolDecision {
  return { kind: "deny", reason: contractError(GUARD_ERROR_PREFIX, code, message) };
}

/**
 * Mount the production guard chain. Returns whether it was mounted;
 * `CELESTEA_TOOL_GUARD=0` explicitly opts out (documented escape hatch — the
 * caller is responsible for surfacing that in its own diagnostics).
 */
export function mountProductionGuards(
  registry: ToolRegistry,
  env: NodeJS.ProcessEnv = process.env,
  grants: PathGuardGrants = {},
  scope: SessionFsScope | null = null,
): boolean {
  if (!envFlag(envString(env, ENV_TOOL_GUARD), true)) return false;
  registry.addGuard(PathGuard.fromEnv(env, grants, PATH_ACCESS, scope));
  return true;
}
