/**
 * B5-02 · the Windows + credential half of the MANDATORY write deny list.
 *
 * The original list (W9269) was POSIX-flavoured: it named the shell startup
 * files whose real-world instance is a dotfile in $HOME. That left two whole
 * classes unwritten, on the platform this repo actually deploys on:
 *
 *   1. PowerShell profiles — the exact analogue of .bashrc (writing one plants
 *      code that runs at the NEXT session), at three documented paths;
 *   2. credential stores — .aws/ .gnupg/ .docker/config.json .kube/config .npmrc
 *      .pypirc .netrc, which are not "config the user reads" but secrets the
 *      user's own tools authenticate with.
 *
 * Platform is still a PARAMETER (W885): only the profile names branch on it, so
 * a Linux deployment is never handed a rule about a file it cannot have, and a
 * win32 judge can be proven on a Linux host.
 *
 * Load-bearing assertions here (each one is a real defect if it flips):
 *   • the three profile locations are all refused, and the entry names the FILE
 *     (`Microsoft.PowerShell_profile.ps1`), not a path that only matched once;
 *   • credential rules fire under BOTH platforms — they are cross-platform;
 *   • the win32-only rule does NOT fire on linux (no phantom refusal);
 *   • the near-miss names stay writable: `docs/aws/`, `.aws-legacy/`,
 *     `dockerfile`, `.claude/settings.json` — a deny list that blocks a repo's
 *     own content gets routed around, which is worse than the gap it closed.
 */
import { describe, expect, it } from "vitest";

import {
  DANGEROUS_WRITE_FILES_CREDENTIAL,
  DANGEROUS_WRITE_FILES_WIN32,
  DANGEROUS_WRITE_DIR_PREFIXES_CREDENTIAL,
  denyListMatch,
  isDangerousWrite,
} from "./write-deny-list.js";

const WIN = "win32";
const POSIX = "linux";

/** A Windows home under grant, written with the platform's own separator. */
const winPath = (...parts: string[]): string => "C:\\Users\\me\\" + parts.join("\\");
const posixPath = (...parts: string[]): string => "/home/me/" + parts.join("/");

describe("B5-02 · PowerShell profile is a Windows startup file", () => {
  it("refuses all three documented $PROFILE locations", () => {
    const locations = [
      ["Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"],
      ["Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"],
      ["AppData", "Roaming", "Microsoft", "Windows", "PowerShell", "Microsoft.PowerShell_profile.ps1"],
    ];
    for (const parts of locations) {
      const target = winPath(...parts);
      expect(isDangerousWrite(target, WIN), target).toBe(true);
      // The entry is the FILE NAME, which is what makes one entry cover all three.
      expect(denyListMatch(target, WIN), target).toEqual({
        entry: "Microsoft.PowerShell_profile.ps1",
        shape: "file",
      });
    }
  });

  it("refuses the ISE-style profile.ps1 too", () => {
    expect(isDangerousWrite(winPath("Documents", "PowerShell", "profile.ps1"), WIN)).toBe(true);
  });

  it("is case-insensitive on Windows (Microsoft.PowerShell_PROFILE.PS1 is the same file)", () => {
    expect(isDangerousWrite(winPath("Documents", "PowerShell", "Microsoft.PowerShell_PROFILE.PS1"), WIN)).toBe(true);
  });

  it("does NOT fire on a POSIX judge (the rule is win32-only)", () => {
    // Same file, POSIX rules: a Linux host cannot have one, and a phantom
    // refusal is a support call. The platform branch is what prevents it.
    expect(denyListMatch(posixPath("Microsoft.PowerShell_profile.ps1"), POSIX)).toBeNull();
  });
});

describe("B5-02 · credential stores are refused on BOTH platforms", () => {
  const credentialTargets: ReadonlyArray<readonly [string, string, string]> = [
    // [label, posix path, expected entry]
    [".aws/credentials", "/home/me/.aws/credentials", ".aws"],
    [".gnupg keyring", "/home/me/.gnupg/secring.gpg", ".gnupg"],
    [".npmrc", "/home/me/.npmrc", ".npmrc"],
    [".pypirc", "/home/me/.pypirc", ".pypirc"],
    [".netrc", "/home/me/.netrc", ".netrc"],
    [".docker/config.json", "/home/me/.docker/config.json", ".docker/config.json"],
    [".kube/config", "/home/me/.kube/config", ".kube/config"],
  ];

  it("under posix rules", () => {
    for (const [label, target, entry] of credentialTargets) {
      const m = denyListMatch(target, POSIX);
      expect(isDangerousWrite(target, POSIX), label).toBe(true);
      expect(m?.entry, label).toBe(entry);
    }
  });

  it("under win32 rules", () => {
    // The SAME logical paths, spelled with the win32 separator. Deriving them
    // from the posix path (not the label) keeps the two rows provably identical.
    for (const [label, posix, entry] of credentialTargets) {
      const target = "C:\\Users\\me\\" + posix.split("/").slice(2).join("\\");
      expect(isDangerousWrite(target, WIN), label).toBe(true);
      expect(denyListMatch(target, WIN)?.entry, label).toBe(entry);
    }
  });

  it("refuses a whole credential DIRECTORY (a tool that CREATES it must fail)", () => {
    expect(isDangerousWrite("/home/me/.aws", POSIX)).toBe(true);
    expect(isDangerousWrite(winPath(".aws"), WIN)).toBe(true);
  });
});

describe("B5-02 · near-miss names stay writable", () => {
  // A deny list that blocks a repository's own content gets routed around, so
  // each of these is a load-bearing "must NOT be denied".
  const innocent: ReadonlyArray<readonly [string, string]> = [
    ["a docs/ directory that merely mentions aws", "/ws/docs/aws/notes.md"],
    [".aws-legacy (a different directory)", "/ws/.aws-legacy/x.txt"],
    ["a source file named dockerfile", "/ws/src/dockerfile"],
    ["a file named npmrc without the dot", "/ws/npmrc.txt"],
    ["a project .claude/settings.json", "/ws/.claude/settings.json"],
    ["an ordinary notes file", "/ws/notes.txt"],
  ];
  it("posix", () => {
    for (const [label, target] of innocent) expect(isDangerousWrite(target, POSIX), label).toBe(false);
  });
  it("win32 (same names, backslash spelling)", () => {
    for (const [label, target] of innocent) {
      expect(isDangerousWrite(target.replace("/", "\\"), WIN), label).toBe(false);
    }
  });
});

describe("B5-02 · the lists are exported and self-consistent", () => {
  it("every exported entry is actually matched by the matcher", () => {
    // Guards against a list that is declared but never wired: each name must
    // produce a hit at the path shape it is documented for.
    for (const name of DANGEROUS_WRITE_FILES_WIN32) {
      expect(denyListMatch(winPath("Documents", "PowerShell", name), WIN), name).toEqual({ entry: name, shape: "file" });
    }
    for (const name of DANGEROUS_WRITE_FILES_CREDENTIAL) {
      expect(denyListMatch(posixPath(name), POSIX), name).toEqual({ entry: name, shape: "file" });
    }
    for (const parts of DANGEROUS_WRITE_DIR_PREFIXES_CREDENTIAL) {
      const target = posixPath(...parts);
      expect(isDangerousWrite(target, POSIX), parts.join("/")).toBe(true);
    }
  });

  it("a .. path cannot smuggle a write past a prefix rule", () => {
    // The matcher normalises first, so the target is judged where it lands.
    expect(denyListMatch("/ws/docs/../.aws/credentials", POSIX)?.entry).toBe(".aws");
    expect(denyListMatch("/ws/.aws/../notes.txt", POSIX)).toBeNull();
  });
});
