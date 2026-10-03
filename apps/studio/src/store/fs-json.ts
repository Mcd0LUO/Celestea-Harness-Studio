/**
 * File-level helpers shared by the three data stores.
 *
 * Durability is part of the frozen contract (`contracts/data-files/index.json`
 * `durability` map): every registry file is written pretty-printed through
 * `<file>.tmp` + `rename`; `providers.json` additionally forces mode 0600 and
 * fsyncs. Reading never silently overwrites an unreadable file — the caller
 * decides whether a malformed file is fatal (workspaces/providers) or merely a
 * warning (prompts).
 */

import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { renameWithRetry } from "@celestea/core";

/** Windows ACL tool; absent on POSIX, and absent on a stripped Windows image. */
const ICACLS = "icacls";

/** Bound on the ACL call: a hung icacls must not hang a save. */
const WINDOWS_ACL_TIMEOUT_MS = 5_000;

import { errText } from "./result.js";

export interface ReadOutcome<T> {
  /** false = the file does not exist (ENOENT), which every store tolerates. */
  exists: boolean;
  value?: T;
  /** Set when the file exists but could not be read/parsed. */
  error?: string;
}

/** Read + parse JSON; a missing file is `{exists:false}`, a broken one an error. */
export function readJsonIfExists(path: string): ReadOutcome<unknown> {
  if (!existsSync(path)) return { exists: false };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { exists: true, error: errText(e) };
  }
  // W9230 (W9206-22): an EMPTY file is an ERROR, not an empty table.
  //
  // This used to return `{exists:true, value:undefined}`, which the two
  // REGISTRY stores (workspaces / providers) read as "no rows" and then wrote
  // back — so a truncated `workspaces.json` silently unregistered every
  // workspace and a truncated `providers.json` (0600, plaintext API keys)
  // silently deleted every key. Both modules already document "a malformed
  // file is a HARD error (the unreadable registry is never overwritten with an
  // empty one)"; an empty file is exactly that case and is now reported as one.
  //
  // The WARNING-style readers are unaffected in substance: prompts /
  // permissions / grants / session-tools / display-plugins / session-meta all
  // already branch on `error` and degrade to the same empty value they produced
  // before, now with an accurate reason instead of "is not an object".
  if (text.trim() === "") return { exists: true, error: "file is empty" };
  try {
    return { exists: true, value: JSON.parse(text) as unknown };
  } catch (e) {
    return { exists: true, error: errText(e) };
  }
}

/**
 * B6-07: what the filesystem can actually guarantee for a secret data file.
 *
 * The contract says `providers.json` is mode 0600. On POSIX that is enforced and
 * re-asserted on every save. On Windows it is NOT: `chmod` there only toggles a
 * read-only attribute, so the file keeps the inherited ACL and reports 0666 --
 * the mode bits in the contract are a claim the platform does not honour.
 *
 * `protectSecretFile()` therefore does two things, in this order:
 *   1. it makes the best effort the platform actually supports, and
 *   2. it REPORTS whether that effort worked, instead of assuming it did.
 *
 * The report matters more than the effort. The previous code called chmodSync
 * unconditionally and returned void, so on Windows the call was a silent no-op
 * and the only visible symptom was a stat that disagreed with the contract.
 *
 * What this deliberately does NOT do on Windows: `icacls /inheritance:r`. That
 * removes inheritance AND every inherited ACE, the owner included, so the file
 * becomes unreadable and unwritable (EPERM) -- it would break the very save it
 * was meant to protect. The variant used instead is non-destructive: keep the
 * inherited ACEs but drop the permissive built-in groups. When that is refused
 * (a locked-down token cannot resolve the account names), the file is left
 * exactly as it was and the caller is told the mode is not enforced.
 */
export type SecretFileProtection = "posix-mode" | "windows-acl" | "not-enforced";

/** True where POSIX permission bits mean what they say (i.e. not win32). */
export const FILE_MODES_ENFORCED: boolean = process.platform !== "win32";

/** The permissive built-in groups a secret file should not inherit. */
const PERMISSIVE_WIN_GROUPS = ["BUILTIN\\Users", "BUILTIN\\Authenticated Users"];

/**
 * The platform operations protectSecretFile needs, injected so both branches
 * are testable everywhere.
 *
 * B6-07: the POLICY (what counts as enforced, and what to do when the operation
 * fails) is the part worth testing. On a machine where only one branch is
 * reachable -- Windows never enters the POSIX branch -- the other branch would
 * otherwise ship untested, which is exactly how a "verified" chmod that silently
 * does nothing got in. Taking the operations as parameters lets one suite cover
 * both branches AND both refusal paths on every platform.
 */
export interface ProtectOps {
  /** True when POSIX mode bits are meaningful on this platform. */
  modesEnforced: boolean;
  /** Apply the mode; throws when the platform refuses. */
  chmod: (path: string, mode: number) => void;
  /** Read the mode back, so the result is VERIFIED rather than assumed. */
  readMode: (path: string) => number;
  /** Windows-only ACL restriction. False when the platform declined. */
  restrictAcl: (path: string) => boolean;
}

/** The real operations, for the running host. */
export function hostProtectOps(): ProtectOps {
  return {
    modesEnforced: FILE_MODES_ENFORCED,
    chmod: chmodSync,
    readMode: (path: string) => statSync(path).mode & 0o777,
    restrictAcl: tryRestrictWindowsAcl,
  };
}

/**
 * Restrict a just-written secret file to its owner, as far as the platform allows.
 *
 * Never throws and never leaves the file less accessible than it was: a refusal
 * is reported, not forced. Callers that must not lose data can ignore the return
 * value; callers that want to surface the truth (or a test) can read it.
 *
 * @param path the file to restrict (already written).
 * @param mode the POSIX mode the contract asks for.
 * @param ops the platform operations (defaults to this host's).
 */
export function protectSecretFile(
  path: string,
  mode: number = 0o600,
  ops: ProtectOps = hostProtectOps(),
): SecretFileProtection {
  if (ops.modesEnforced) {
    try {
      ops.chmod(path, mode);
    } catch {
      return "not-enforced";
    }
    // Re-read instead of assuming: a filesystem mounted with fixed permissions
    // (some container overlays) accepts chmod and ignores it.
    try {
      return ops.readMode(path) === mode ? "posix-mode" : "not-enforced";
    } catch {
      return "not-enforced";
    }
  }
  return ops.restrictAcl(path) ? "windows-acl" : "not-enforced";
}

/**
 * Windows: drop the permissive built-in groups WITHOUT touching inheritance.
 *
 * `icacls /inheritance:d` copies the inherited ACEs onto the file itself (so the
 * owner keeps access) and `/remove` then takes away the broad groups. Both flags
 * together are the safe pair. `/inheritance:r` is deliberately NOT used: measured
 * on Windows, it drops every inherited ACE including the owner's, after which
 * the file is unreadable and unwritable (EPERM) -- it would break the very save
 * it was meant to protect.
 *
 * A refusal (locked-down token, unknown group, a filesystem with no ACL support)
 * leaves the file exactly as it was and is reported, never escalated.
 */
function tryRestrictWindowsAcl(path: string): boolean {
  try {
    const run = spawnSync(ICACLS, [path, "/inheritance:d", "/remove", ...PERMISSIVE_WIN_GROUPS], {
      timeout: WINDOWS_ACL_TIMEOUT_MS,
      windowsHide: true,
    });
    return run.status === 0;
  } catch {
    return false;
  }
}

export interface WriteOptions {
  /** Force this mode on the temp file before the rename (0600 for secrets). */
  mode?: number;
  /** fsync the file before renaming (providers.json only). */
  fsync?: boolean;
  /** Trailing newline (`to_string_pretty` + file write has none). */
  newline?: boolean;
}

/** What a completed write actually achieved, for a caller that passed `mode`. */
export interface WriteResult {
  bytes: number;
  /**
   * B6-07: present only when `mode` was requested. "not-enforced" means the
   * file is written and correct, but the OS did not apply the requested
   * restriction -- the honest answer, and the one a caller must be able to see
   * instead of inferring a guarantee that does not hold.
   */
  protection: SecretFileProtection;
}

/** Atomic pretty-JSON write: `<path>.tmp` -> fsync? -> rename. */
export function writeJsonAtomic(path: string, value: unknown, opts: WriteOptions = {}): WriteResult {
  const body = `${JSON.stringify(value, null, 2)}${opts.newline === true ? "\n" : ""}`;
  return writeTextAtomic(path, body, opts);
}

export function writeTextAtomic(path: string, body: string, opts: WriteOptions = {}): WriteResult {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body, opts.mode === undefined ? {} : { mode: opts.mode });
  // B6-07: the chmod is kept (it is what enforces 0600 on POSIX and is a harmless
  // no-op on Windows) and the RESULT is captured instead of discarded, so the
  // caller can tell "restricted" from "written but not restricted".
  const protection: SecretFileProtection =
    opts.mode === undefined ? "posix-mode" : protectSecretFile(tmp, opts.mode);
  if (opts.fsync === true) {
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  renameWithRetry(tmp, path);
  return { bytes: Buffer.byteLength(body), protection };
}

/** Plain (non-atomic) write, matching `session.json` semantics. */
export function writeTextPlain(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

export function writeFileRaw(path: string, body: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export interface FileStat {
  size: number;
  /** Seconds since the epoch (contract `modified`). */
  modified: number;
}

export function statOf(path: string): FileStat | null {
  try {
    const st = statSync(path);
    return { size: st.size, modified: Math.floor(st.mtimeMs / 1000) };
  } catch {
    return null;
  }
}

/** Direct sub-directory names, dot-dirs skipped, sorted (fs browse semantics). */
export function listDirNames(path: string, limit: number): string[] {
  const entries = readdirSync(path, { withFileTypes: true });
  const dirs: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".")) continue;
    dirs.push(e.name);
  }
  dirs.sort();
  return dirs.slice(0, limit);
}

/** Direct child names including dot-dirs and files (session scanning). */
export function listEntries(path: string): Array<{ name: string; isDir: boolean }> {
  try {
    return readdirSync(path, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return [];
  }
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** Best-effort recursive delete: used by every create/move rollback path. */
export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
