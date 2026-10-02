/**
 * W9269 (docs/feature-sandbox-comparison.md §3.2 / §4 P0) — the MANDATORY
 * WRITE DENY LIST ("DANGEROUS_FILES" equivalent).
 *
 * The gap this suite closes: before it, the only question the path guard asked
 * about a write was "is the target inside a writable root?", and EVERY widening
 * mechanism in the system could answer that "yes" — session grants
 * (`write_roots`), a permission preset, `allPaths`, `CELESTEA_TOOL_ROOTS`.
 * There was no floor, so a granted home directory meant an agent could rewrite
 * `.bashrc` and the user would run it the next time they opened a shell.
 *
 * The four things asserted here, in the order the brief lists them:
 *   ① the list itself: deny-listed writes are refused with a NAMED contract
 *      code, an ordinary write still lands, and READING a deny-listed file is
 *      still allowed (a guard that blocked the read would break diagnosis
 *      without protecting anything);
 *   ② no widening mechanism can reopen the list — grants, `allPaths` and
 *      `CELESTEA_TOOL_ROOTS` are each exercised against the SAME `.bashrc`;
 *   ③ platform is a parameter: under an injected `win32`, `.BASHRC` is the
 *      same file as `.bashrc` and is refused, while the POSIX answer stays
 *      byte-different (on POSIX they really are two files);
 *   ④ the negative control lives in `w9269-write-deny-mutation.test.ts`.
 */
import { existsSync } from "node:fs";
import { join, parse } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, makeDir, makeTempDir, writeFixture } from "../testing/tmp.test-util.js";
import { DANGEROUS_WRITE_CODE, ALL_PATHS_ROOT, PathGuard, PathGuardPolicy } from "./path-guard.js";
import { DANGEROUS_WRITE_DIRS, DANGEROUS_WRITE_DIR_PREFIXES, DANGEROUS_WRITE_FILES, denyListMatch, isDangerousWrite } from "./write-deny-list.js";

afterAll(() => cleanupTempDirs());

/** A stand-in for the user's home; nothing here is ever actually written. */
const home = makeTempDir("w9269-home");
const workspace = makeDir(makeTempDir("w9269-ws"), "ws");
const granted = makeDir(makeTempDir("w9269-grant"), "granted");

/** The canonical proof path: $HOME/.bashrc, the one the brief names. */
const HOME_BASHRC = join(home, ".bashrc");

/** A policy whose workspace is the session root and whose only grant is `home`. */
function policy(overrides: Parameters<typeof PathGuardPolicy.fromEnv>[1] = {}, env: Record<string, string | undefined> = {}): PathGuardPolicy {
  return PathGuardPolicy.fromEnv({ CELESTEA_TOOL_WORKDIR: workspace, ...env }, { writeRoots: [home], ...overrides });
}

/** The contract code carried by a denial, or null when the call was allowed. */
function codeOf(decision: { kind: string; reason?: string }): string | null {
  if (decision.kind !== "deny") return null;
  return /code=([a-z_]+)/.exec(decision.reason ?? "")?.[1] ?? null;
}

describe("W9269 ① the write deny list denies, with a named code", () => {
  it("refuses every deny-listed FILE name inside the workspace", () => {
    const p = new PathGuardPolicy({ workspace });
    for (const name of DANGEROUS_WRITE_FILES) {
      const decision = p.checkWrite(join(workspace, name));
      expect(decision.kind, name).toBe("deny");
      // A NAMED failure, not a bare string and not a silent skip: the caller
      // must be able to tell "never writable" from "outside your roots".
      expect(codeOf(decision), name).toBe(DANGEROUS_WRITE_CODE);
    }
  });

  it("refuses the four targets the brief names, inside the workspace", () => {
    const p = new PathGuardPolicy({ workspace });
    for (const target of [
      join(workspace, ".bashrc"),
      join(workspace, ".gitconfig"),
      join(workspace, ".mcp.json"),
      join(workspace, ".vscode", "x"),
    ]) {
      const decision = p.checkWrite(target);
      expect(decision.kind, target).toBe("deny");
      expect(codeOf(decision), target).toBe(DANGEROUS_WRITE_CODE);
    }
  });

  it("refuses a DIRECTORY PREFIX at any depth, and the directory itself", () => {
    const p = new PathGuardPolicy({ workspace });
    for (const dir of DANGEROUS_WRITE_DIRS) {
      // nested, and the bare directory (a tool that CREATES the dir must fail)
      expect(p.checkWrite(join(workspace, "deep", "nest", dir, "x")).kind, dir).toBe("deny");
      expect(p.checkWrite(join(workspace, dir)).kind, dir).toBe("deny");
    }
    // The multi-component prefix: .claude/commands at any depth, but NOT
    // .claude itself (a project's .claude/ settings are ordinary repo content).
    const prefix = DANGEROUS_WRITE_DIR_PREFIXES[0] as readonly string[];
    expect(p.checkWrite(join(workspace, ...prefix, "deploy.md")).kind).toBe("deny");
    expect(p.checkWrite(join(workspace, "pkg", ...prefix, "nested", "deploy.md")).kind).toBe("deny");
    expect(p.checkWrite(join(workspace, ".claude", "settings.json")).kind).toBe("allow");
  });

  it("still writes an ordinary file (the list is a floor, not a wall)", () => {
    const p = new PathGuardPolicy({ workspace });
    expect(p.checkWrite(join(workspace, "src", "index.ts"))).toEqual({ kind: "allow" });
    expect(p.checkWrite(join(workspace, "my.vscode-notes.md"))).toEqual({ kind: "allow" });
    // …and the component test, not a string prefix: near-miss names stay legal.
    expect(p.checkWrite(join(workspace, ".vscode-legacy", "x"))).toEqual({ kind: "allow" });
    expect(p.checkWrite(join(workspace, "bashrc"))).toEqual({ kind: "allow" });
    expect(p.checkWrite(join(workspace, "notgitconfig.json"))).toEqual({ kind: "allow" });
  });

  it("actually blocks the write through the registry, touching no file", async () => {
    const { createToolRegistry } = await import("../registry.js");
    const { writeFileTool } = await import("../tools/write-file.js");
    const target = join(workspace, ".bashrc");
    const registry = createToolRegistry([writeFileTool()], [new PathGuard(new PathGuardPolicy({ workspace }))]);
    const out = await registry.dispatch({ call_id: "w9269", name: "write_file", args: { path: target, content: "evil" } });
    expect(out.value).toBeNull();
    expect(out.error).toContain("code=" + DANGEROUS_WRITE_CODE);
    expect(existsSync(target)).toBe(false);
  });

  it("READS a deny-listed file are still allowed (diagnosis must keep working)", () => {
    // A blanket "forbidden paths" rule would break "show me my git config" and
    // protect nothing: reading a file does not execute it. The brief requires
    // read-not-blocked, so it is asserted for BOTH halves of the capability.
    const p = PathGuardPolicy.fromEnv({ CELESTEA_TOOL_WORKDIR: workspace }, { readRoots: [home] });
    writeFixture(home, ".gitconfig", "[user]\n");
    expect(p.checkRead(join(home, ".gitconfig"))).toEqual({ kind: "allow" });
    expect(p.checkRead(join(home, ".bashrc"))).toEqual({ kind: "allow" });
    expect(p.checkRead(join(home, ".mcp.json"))).toEqual({ kind: "allow" });
    expect(p.checkRead(join(home, ".vscode", "settings.json"))).toEqual({ kind: "allow" });
    // …while the WRITE of the very same paths stays refused under the same policy.
    const w = PathGuardPolicy.fromEnv({ CELESTEA_TOOL_WORKDIR: workspace }, { readRoots: [home], writeRoots: [home] });
    expect(w.checkWrite(join(home, ".bashrc")).kind).toBe("deny");
    expect(codeOf(w.checkWrite(join(home, ".bashrc")))).toBe(DANGEROUS_WRITE_CODE);
  });
});

/**
 * ② THE HARD REQUIREMENT: the list is not relaxable.
 *
 * Each block below re-uses the SAME target ($HOME/.bashrc) through one
 * widening mechanism and asserts it is still refused — and, crucially, that the
 * mechanism really did widen (an allPaths policy can write $HOME/notes.txt, a
 * grant covers $HOME), so the deny cannot be passing merely because the path
 * was unreachable.
 */
describe("W9269 ② no widening mechanism reopens the list", () => {
  it("session grants: write_roots = $HOME still refuses $HOME/.bashrc", () => {
    const p = policy({ writeRoots: [home] });
    // The grant is genuinely in force ...
    expect(p.writeRoots).toContain(home);
    expect(p.checkWrite(join(home, "notes.txt"))).toEqual({ kind: "allow" });
    // ... and still the floor holds for the deny-listed file.
    const decision = p.checkWrite(HOME_BASHRC);
    expect(decision.kind).toBe("deny");
    expect(codeOf(decision)).toBe(DANGEROUS_WRITE_CODE);
  });

  it("allPaths: the whole-host capability still refuses $HOME/.bashrc", () => {
    const p = PathGuardPolicy.fromEnv({ CELESTEA_TOOL_WORKDIR: workspace }, { allPaths: true });
    expect(p.allPathsWrite).toBe(true);
    // The capability is real: it can write anywhere that is not on the list.
    expect(p.checkWrite(join(home, "notes.txt"))).toEqual({ kind: "allow" });
    expect(p.checkWrite(join(parse(workspace).root, "anywhere", "x.txt"))).toEqual({ kind: "allow" });
    // ... and the deny list is the one thing it does not open.
    const decision = p.checkWrite(HOME_BASHRC);
    expect(decision.kind).toBe("deny");
    expect(codeOf(decision)).toBe(DANGEROUS_WRITE_CODE);
  });

  it("allPaths via the '/' spelling in a declared write root (W9110 route)", () => {
    // The capability can also be spelled "/" in a caller-declared write list.
    // Same target, same refusal: the deny is evaluated before the capability.
    const p = PathGuardPolicy.fromEnv({ CELESTEA_TOOL_WORKDIR: workspace }, { writeRoots: [ALL_PATHS_ROOT] });
    expect(p.allPathsWrite).toBe(true);
    expect(p.checkWrite(HOME_BASHRC).kind).toBe("deny");
    expect(codeOf(p.checkWrite(HOME_BASHRC))).toBe(DANGEROUS_WRITE_CODE);
  });

  it("CELESTEA_TOOL_ROOTS: naming $HOME as a root still refuses $HOME/.bashrc", () => {
    // The env knob declares READ roots, and a read root is not a write root --
    // but a production session that ALSO grants $HOME gets both, which is the
    // real widening path and the one the brief asks about.
    const p = PathGuardPolicy.fromEnv(
      { CELESTEA_TOOL_WORKDIR: workspace, CELESTEA_TOOL_ROOTS: home },
      { writeRoots: [home] },
    );
    expect(p.failClosedReason).toBeNull();
    expect(p.readRoots).toContain(home);
    expect(p.writeRoots).toContain(home);
    expect(p.checkWrite(join(home, "notes.txt"))).toEqual({ kind: "allow" });
    const decision = p.checkWrite(HOME_BASHRC);
    expect(decision.kind).toBe("deny");
    expect(codeOf(decision)).toBe(DANGEROUS_WRITE_CODE);
  });

  it("the workspace being $HOME itself does not re-open it", () => {
    // The sharpest form: the deny-listed file is INSIDE the writable workspace,
    // so no grant is even needed. (A project-local .gitconfig is the common
    // false-positive here; it is intentionally refused -- see the report.)
    const p = new PathGuardPolicy({ workspace: home });
    expect(p.checkWrite(join(home, "notes.txt"))).toEqual({ kind: "allow" });
    expect(p.checkWrite(HOME_BASHRC).kind).toBe("deny");
  });

  it("the union of every widening mechanism at once is still refused", () => {
    const p = PathGuardPolicy.fromEnv(
      { CELESTEA_TOOL_WORKDIR: home, CELESTEA_TOOL_ROOTS: workspace },
      { writeRoots: [home, granted], readRoots: [ALL_PATHS_ROOT], allPaths: true },
    );
    expect(p.allPathsWrite).toBe(true);
    expect(p.checkWrite(HOME_BASHRC).kind).toBe("deny");
    expect(codeOf(p.checkWrite(HOME_BASHRC))).toBe(DANGEROUS_WRITE_CODE);
    // A sibling deny-listed name in a GRANTED root, too.
    expect(p.checkWrite(join(granted, ".mcp.json")).kind).toBe("deny");
  });
});

/** ③ platform is a parameter: the win32 case is provable on any host. */
describe("W9269 ③ platform parameterisation", () => {
  it("win32: .BASHRC is the SAME FILE as .bashrc and is refused", () => {
    // Windows file names are case-insensitive: these two spellings are one
    // file, so a matcher that only knows the lowercase bytes protects nothing
    // on the platform where the file actually lives.
    const win = new PathGuardPolicy({ workspace: home, platform: "win32" });
    expect(win.checkWrite(join(home, ".BASHRC")).kind).toBe("deny");
    expect(codeOf(win.checkWrite(join(home, ".BASHRC")))).toBe(DANGEROUS_WRITE_CODE);
    expect(denyListMatch("C:" + String.fromCharCode(92,92) + "Users" + String.fromCharCode(92,92) + "me" + String.fromCharCode(92,92) + ".BASHRC", "win32")).toEqual({ entry: ".bashrc", shape: "file" });
    // Mixed separators and mixed case, the two ways a caller spells it.
    expect(denyListMatch("C:/Users/me/.GitConfig", "win32")).toEqual({ entry: ".gitconfig", shape: "file" });
    expect(denyListMatch("C:" + String.fromCharCode(92,92) + "Users" + String.fromCharCode(92,92) + "me" + String.fromCharCode(92,92) + ".VSCODE" + String.fromCharCode(92,92) + "x.json", "win32")).toEqual({ entry: ".vscode", shape: "dir" });
  });

  it("POSIX: .BASHRC and .bashrc are two different files, and only the listed one is denied", () => {
    // Folding case on POSIX would deny a file the user never considered
    // dangerous, so the POSIX answer must stay byte-different.
    //
    // W891-style platform honesty: this host is Windows, so the paths below are
    // written in POSIX spelling and the policy is told `linux` explicitly. A
    // win32 path run through `posix.normalize` would be mangled, and the test
    // would be asserting a mangled path instead of the case rule.
    //
    // The two verdicts are compared BY CODE, not by kind: `/home/me` does not
    // exist on this host, so the un-listed twin falls through to the ROOT test
    // and is refused there instead. The property under test is which refusal
    // fires — `path_dangerous_write` (the deny list) for the listed name, and
    // never that code for the twin. Comparing kinds would be asserting this
    // host's filesystem layout, which is exactly what W891 warns against.
    const p = new PathGuardPolicy({ workspace: "/home/me", platform: "linux" });
    expect(codeOf(p.checkWrite("/home/me/.bashrc"))).toBe(DANGEROUS_WRITE_CODE);
    expect(codeOf(p.checkWrite("/home/me/.BASHRC"))).not.toBe(DANGEROUS_WRITE_CODE);
    // The matcher itself is the sharp statement of the case rule, and it needs
    // no filesystem at all.
    expect(denyListMatch("/home/me/.BASHRC", "linux")).toBeNull();
    expect(denyListMatch("/home/me/.bashrc", "linux")).toEqual({ entry: ".bashrc", shape: "file" });
  });

  it("the injected platform reaches the policy fromEnv (no silent host fallback)", () => {
    // W9205's lesson: a field that is not on the shared base is a field one exit
    // drops. Under win32 injection, .BASHRC must be refused HERE on a posix
    // host -- which is only true if the platform really travelled.
    const p = PathGuardPolicy.fromEnv({ CELESTEA_TOOL_WORKDIR: home }, { writeRoots: [home] }, null, "win32");
    expect(p.platform).toBe("win32");
    expect(p.checkWrite(join(home, ".BASHRC")).kind).toBe("deny");
    const posix = PathGuardPolicy.fromEnv({ CELESTEA_TOOL_WORKDIR: home }, { writeRoots: [home] }, null, "linux");
    // Compared BY CODE again: under a `linux` rule the win32 temp path is not a
    // path the root test can resolve, so the twin can be refused by the ROOT
    // rule here. What must not happen is the deny-list code firing for it — that
    // is the host-fallback leak this case exists to catch.
    expect(codeOf(posix.checkWrite(join(home, ".BASHRC")))).not.toBe(DANGEROUS_WRITE_CODE);
    // The default is the HOST, unchanged.
    expect(new PathGuardPolicy({ workspace: home }).platform).toBe(process.platform);
  });

  it("the matcher normalises a dirty path before judging it", () => {
    // .. must not smuggle a write past a list that reads the final component.
    expect(denyListMatch("/ws/.vscode/../ok.txt", "linux")).toBeNull();
    expect(denyListMatch("/ws/ok/../.bashrc", "linux")).toEqual({ entry: ".bashrc", shape: "file" });
    expect(isDangerousWrite("/ws/.idea/x", "linux")).toBe(true);
  });
});

describe("W9269 the deny list is the doc's list", () => {
  it("matches docs/feature-sandbox-comparison.md §4 P0 exactly", () => {
    // If the doc and this array drift, the doc is the SPEC: this suite fails and
    // somebody has to decide which side moved.
    expect(DANGEROUS_WRITE_FILES).toEqual([".bashrc", ".bash_profile", ".zshrc", ".profile", ".gitconfig", ".gitmodules", ".mcp.json", ".ripgreprc"]);
    expect(DANGEROUS_WRITE_DIRS).toEqual([".vscode", ".idea"]);
    expect(DANGEROUS_WRITE_DIR_PREFIXES).toEqual([[".claude", "commands"]]);
  });

  it("the denial text names the matched entry and the code is stable", () => {
    const p = new PathGuardPolicy({ workspace });
    const decision = p.checkWrite(join(workspace, ".bashrc"));
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") expect.unreachable("must deny");
    expect(decision.reason.startsWith("toolguard: code=" + DANGEROUS_WRITE_CODE)).toBe(true);
    // The message must say WHICH rule fired, or the refusal is unactionable.
    expect(decision.reason).toContain(".bashrc");
    expect(decision.reason).toContain("mandatory deny list");
  });
});
