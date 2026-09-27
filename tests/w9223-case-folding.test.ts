/**
 * W9223 (W9210-F8) — containment follows the PLATFORM's case rules.
 *
 * The bug: `isInside` compared canonical strings with a plain `startsWith`.
 * `realpathSync` collapses separators, `..` and symlinks but does NOT fold case
 * on Windows (`realpathSync("C:\\USERS\\LENOVO") === "C:\\USERS\\LENOVO"`), so the
 * SAME file spelled with different capitalisation was judged a different path.
 * In the guard that is a functional failure: a legitimate `write_file` under the
 * workspace came back `code=path_forbidden`.
 *
 * `platform` is injectable (the W885 seam), so the win32 branch is proven on a
 * Linux host. POSIX is case-SENSITIVE and must stay byte-for-byte unchanged:
 * `~/.ssh` and `~/.SSH` really are two directories there.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// The public entry only (see the `entry-only-tools` rule in .dependency-cruiser.cjs).
import { isInside, PathGuardPolicy } from "@celestea/tools";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temp workspace with one existing file inside it. */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "w9223-case-"));
  dirs.push(dir);
  writeFileSync(join(dir, "a.txt"), "x");
  return dir;
}

describe("W9223 isInside — win32 is case-insensitive", () => {
  it("treats a case-varied path as inside the same root", () => {
    expect(isInside("C:\\Users\\Me\\proj\\a.txt", "C:\\Users\\Me\\proj", "win32")).toBe(true);
    expect(isInside("C:\\USERS\\ME\\PROJ\\a.txt", "c:\\users\\me\\proj", "win32")).toBe(true);
    // ...and the equality case (the root itself) is still inside.
    expect(isInside("C:\\USERS\\ME\\PROJ", "c:\\users\\me\\proj", "win32")).toBe(true);
  });

  it("normalises / to \\ on win32 so a mixed spelling still matches", () => {
    expect(isInside("C:/Users/Me/proj/a.txt", "c:\\users\\me\\proj", "win32")).toBe(true);
  });

  it("still refuses a sibling whose name only PREFIXES the root", () => {
    // The case fold must not degrade the segment-aware test into a string prefix.
    expect(isInside("C:\\users\\ab", "c:\\users\\a", "win32")).toBe(false);
    expect(isInside("C:\\users\\a-other\\x", "c:\\users\\a", "win32")).toBe(false);
  });
});

describe("W9223 isInside — POSIX stays case-SENSITIVE", () => {
  it("does not fold case, because ~/.ssh and ~/.SSH are different directories", () => {
    expect(isInside("/home/a/b", "/home/a", "linux")).toBe(true);
    expect(isInside("/HOME/A/b", "/home/a", "linux")).toBe(false);
    expect(isInside("/home/A", "/home/a", "linux")).toBe(false);
    expect(isInside("/home/ab", "/home/a", "linux")).toBe(false);
  });

  it("is byte-for-byte the historical answer on darwin too", () => {
    expect(isInside("/Users/me/p/x", "/Users/me/p", "darwin")).toBe(true);
    expect(isInside("/Users/ME/p/x", "/Users/me/p", "darwin")).toBe(false);
  });
});

describe("W9223 the guard accepts the same file spelled with other case (win32 host)", () => {
  it("allows a read/write whose capitalisation differs from the workspace", (ctx) => {
    // The injected-platform assertions above prove the rule everywhere; this one
    // proves the GUARD actually consults it on a real Windows host (on POSIX the
    // upper-cased spelling is a genuinely different directory, so it is skipped).
    if (process.platform !== "win32") {
      ctx.skip("case-insensitive filesystems only exist on Windows; the injected-platform cases cover the rule");
      return;
    }
    const dir = workspace();
    const policy = new PathGuardPolicy({ workspace: dir });
    expect(policy.checkRead(join(dir, "a.txt"))).toEqual({ kind: "allow" });
    expect(policy.checkRead(join(dir.toUpperCase(), "a.txt"))).toEqual({ kind: "allow" });
    expect(policy.checkWrite(join(dir.toUpperCase(), "b.txt"))).toEqual({ kind: "allow" });
    // The control: a directory that really is outside stays refused.
    const other = workspace();
    expect(policy.checkWrite(join(other, "b.txt")).kind).toBe("deny");
  });
});
