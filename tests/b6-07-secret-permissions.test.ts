/**
 * B6-07 — the contract claims providers.json is mode 0600; on Windows chmod cannot
 * deliver that (it only toggles a read-only attribute), so the file kept the
 * inherited ACL and reported 0666. The old code called chmodSync and returned
 * void, so the gap was invisible except as a stat that disagreed with the
 * contract. The fix makes the outcome REPORTED rather than assumed.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FILE_MODES_ENFORCED,
  protectSecretFile,
  writeTextAtomic,
  type ProtectOps,
} from "../apps/studio/src/store/fs-json.js";
import { ProvidersStore, PROVIDERS_MODE } from "../apps/studio/src/store/providers.js";

describe("B6-07: a secret file reports what protection it actually got", () => {
  it("the platform flag matches the documented escape hatch in the test suite", () => {
  // packages/tools/src/testing/platform-gates.ts uses the same definition; the two
  // must not disagree about where mode bits are meaningless.
  expect(FILE_MODES_ENFORCED).toBe(process.platform !== "win32");
  });

  it("protectSecretFile never throws and always returns a known verdict", () => {
  const dir = join(process.cwd(), "results", "audit3-r2", "B6", "prot");
  const file = join(dir, "providers.json");
  writeTextAtomic(file, "{}", { mode: PROVIDERS_MODE });
  const verdict = protectSecretFile(file, PROVIDERS_MODE);
  expect(["posix-mode", "windows-acl", "not-enforced"]).toContain(verdict);
  });

  it("a missing file is reported, not thrown on (a save must not fail here)", () => {
  const verdict = protectSecretFile(join(process.cwd(), "no", "such", "dir", "f.json"));
  expect(verdict).toBe("not-enforced");
  });
});

/** Ops that model a POSIX host whose chmod really works. */
function posixOps(readBack: () => number): ProtectOps {
  return { modesEnforced: true, chmod: () => undefined, readMode: readBack, restrictAcl: () => false };
}
/** Ops that model a Windows host (the mode bits mean nothing there). */
function windowsOps(aclWorks: boolean): ProtectOps {
  return { modesEnforced: false, chmod: () => undefined, readMode: () => 0o666, restrictAcl: () => aclWorks };
}

describe("B6-07: the verdict is DERIVED, not assumed (platform-independent)", () => {
  it("reports posix-mode only when the mode reads back as requested", () => {
    // This is the assertion a "verified" chmod earns: it compares what it asked for
    // with what the filesystem reports. MUTANT: returning "posix-mode" unconditionally
    // must fail here, on EVERY platform -- that is why the ops are injected.
    expect(protectSecretFile("f", 0o600, posixOps(() => 0o600))).toBe("posix-mode");
  });

  it("reports not-enforced when chmod is accepted but ignored", () => {
    // A container overlay that takes chmod and drops it: the honest answer is that
    // the restriction did not happen, NOT a false guarantee.
    expect(protectSecretFile("f", 0o600, posixOps(() => 0o666))).toBe("not-enforced");
  });

  it("reports not-enforced when chmod throws (a refused platform)", () => {
    const throwing: ProtectOps = { ...posixOps(() => 0o600), chmod: () => { throw new Error("EPERM"); } };
    expect(protectSecretFile("f", 0o600, throwing)).toBe("not-enforced");
  });

  it("reports not-enforced when the verification read itself throws", () => {
    const blind: ProtectOps = { ...posixOps(() => 0o600), readMode: () => { throw new Error("gone"); } };
    expect(protectSecretFile("f", 0o600, blind)).toBe("not-enforced");
  });

  it("uses the ACL path when the mode bits are meaningless, and reports its result", () => {
    expect(protectSecretFile("f", 0o600, windowsOps(true))).toBe("windows-acl");
    expect(protectSecretFile("f", 0o600, windowsOps(false))).toBe("not-enforced");
  });

  it("never claims posix-mode on a host where mode bits do not apply", () => {
    // The Windows branch must not be able to report the POSIX verdict even when the
    // ACL call succeeded -- the two are different guarantees.
    expect(protectSecretFile("f", 0o600, windowsOps(true))).not.toBe("posix-mode");
  });
});

describe("B6-07: the mode the contract promises", () => {
  it("is delivered on POSIX, and reported as delivered", () => {
  const dir = join(process.cwd(), "results", "audit3-r2", "B6", "prot2");
  const file = join(dir, "providers.json");
  const out = writeTextAtomic(file, "{}", { mode: PROVIDERS_MODE });
  if (FILE_MODES_ENFORCED) {
    expect(out.protection).toBe("posix-mode");
    expect(statSync(file).mode & 0o777).toBe(PROVIDERS_MODE);
  } else {
    // The honest Windows answer: the file is written and correct, but the mode bits
    // are not enforced. The point of B6-07 is that this is now SAYABLE.
    expect(["windows-acl", "not-enforced"]).toContain(out.protection);
  }
  expect(readFileSync(file, "utf8")).toBe("{}");
  });

  it("the ProvidersStore records the same verdict after a save", () => {
  const dir = join(process.cwd(), "results", "audit3-r2", "B6", "prot3");
  const file = join(dir, "providers.json");
  const store = new ProvidersStore(file);
  const res = store.upsert({
    id: "p",
    base_url: "https://api.example.com",
    request_format: "chat_completions",
    api_key: "MnA3bC7dE9fG1hI2jK4lM6nO8pQ0rS4tU6vW8xY0zA2bC4dE",
    models: [],
  });
  expect(res.ok).toBe(true);
  expect(["posix-mode", "windows-acl", "not-enforced"]).toContain(store.lastProtection);
  // The save still wrote the file, and the key is on disk in cleartext (by design).
  expect(readFileSync(file, "utf8")).toContain("MnA3bC7dE9fG1hI2jK4lM6nO8pQ0rS4tU6vW8xY0zA2bC4dE");
  // ...and the public view still cannot leak it.
  expect(Object.keys(store.list()[0] ?? {})).not.toContain("api_key");
  });

  it("a write with no mode requested reports the neutral verdict, not a false guarantee", () => {
  const dir = join(process.cwd(), "results", "audit3-r2", "B6", "prot4");
  const file = join(dir, "workspaces.json");
  const out = writeTextAtomic(file, "{}", {});
  expect(out.protection).toBe("posix-mode"); // no restriction was requested or needed
  });
});
