#!/usr/bin/env node
/**
 * Repair an app that a broken update left unbootable.
 *
 * WHY THIS EXISTS — measured on Deno 2.9.7, and it contradicts the auto-update
 * docs ("This makes broken updates self-healing"). The launcher decides whether to
 * roll back from two files next to the runtime library:
 *
 *   <dylib>.backup + <dylib>.update-ok   -> "the update was confirmed"; keep it
 *   <dylib>.backup, no <dylib>.update-ok -> roll back, restore the backup
 *
 * but the confirmation sentinel is written by the launch that PERFORMS the swap,
 * before the new library has ever been loaded. Measured sequence (a deliberately
 * unloadable library, `e_phnum=0`, so it fails at dlopen):
 *
 *   launch 1  --check-updates   stage the patch                    .update=有
 *   launch 2  plain start       swap; still runs the OLD library   .so=坏 .backup=有 .update-ok=有 ← 哨兵在这里就被写了
 *   launch 3  plain start       load the broken library -> exit 1  (no rollback: .update-ok exists)
 *   launch 4  plain start       same failure                       (no rollback)
 *   launch 5  plain start       same failure                       (no rollback)
 *
 * So in this runtime version the rollback path never fires for the failure mode it
 * was written for, and the app stays unbootable until the backup is restored by
 * hand. This script is that restoration:
 *
 *   node desktop/scripts/repair-rollback.mjs --app "/path/to/CelesteaStudio.AppImage-or-app-dir"
 *
 * It refuses to guess: it lists the library files it finds and what it will do, and
 * leaves the broken library in place as `<dylib>.broken` so the failure can still be
 * inspected (and reported upstream).
 */

import { copyFileSync, existsSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/** Library base names by platform, so the script can run on any of them. */
const LIBRARY_SUFFIXES = [".so", ".dylib", ".dll"];

function usage() {
  console.log(`Restore a desktop app that a broken update left unbootable.

Usage:
  node desktop/scripts/repair-rollback.mjs --app <path> [--dry-run] [--keep-broken]

  --app <path>   the app directory (or any file inside it): on Linux the directory
                 containing the launcher and libdenort/«name».so, on macOS the
                 ".app" bundle, on Windows the folder with denort.dll.
  --dry-run      report what would be done, change nothing
  --keep-broken  do not keep the broken library as <dylib>.broken`);
}

function parseArgs(argv) {
  const options = { app: null, dryRun: false, keepBroken: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--app") options.app = argv[++i];
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--keep-broken") options.keepBroken = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  return options;
}

/** The directory that holds the runtime library, given any path inside the app. */
export function libraryDir(input) {
  let dir = resolve(input);
  if (existsSync(dir) && !statSync(dir).isDirectory()) dir = join(dir, "..");
  // macOS: dig into the bundle.
  for (const candidate of [dir, join(dir, "Contents", "MacOS"), join(dir, "Contents", "Resources"), join(dir, "Contents", "Frameworks")]) {
    if (!existsSync(candidate)) continue;
    const hit = readdirSync(candidate).find((name) => name.endsWith(".backup") || LIBRARY_SUFFIXES.some((s) => name.endsWith(s)));
    if (hit !== undefined) return candidate;
  }
  return dir;
}

/** Every `<lib>`/`<lib>.backup`/`<lib>.update`/`<lib>.update-ok` group in `dir`. */
export function findRollbackSets(dir) {
  const names = readdirSync(dir);
  const sets = [];
  for (const name of names) {
    if (!name.endsWith(".backup")) continue;
    const library = name.slice(0, -".backup".length);
    sets.push({
      library: join(dir, library),
      backup: join(dir, name),
      update: join(dir, `${library}.update`),
      sentinel: join(dir, `${library}.update-ok`),
      broken: join(dir, `${library}.broken`),
    });
  }
  return sets;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.app === null) {
    usage();
    return options.help ? 0 : 2;
  }
  const dir = libraryDir(options.app);
  const sets = findRollbackSets(dir);
  console.log(`[repair] app directory: ${dir}`);
  if (sets.length === 0) {
    console.log("[repair] no <library>.backup found — nothing to restore.");
    console.log("[repair] (if the app still will not start, the failure is not an interrupted update)");
    return 0;
  }
  for (const set of sets) {
    console.log(`[repair] library: ${basename(set.library)}`);
    console.log(`[repair]   backup  : ${existsSync(set.backup) ? "present" : "MISSING"}`);
    console.log(`[repair]   staged  : ${existsSync(set.update) ? "present (will be removed)" : "absent"}`);
    console.log(`[repair]   sentinel: ${existsSync(set.sentinel) ? "present (will be removed)" : "absent"}`);
    if (options.dryRun) continue;
    if (!existsSync(set.backup)) continue;
    // Keep the library that failed to load: it is the evidence, and overwriting it
    // would destroy the only copy of what the updater actually applied.
    if (existsSync(set.library) && !options.keepBroken && !existsSync(set.broken)) {
      renameSync(set.library, set.broken);
      console.log(`[repair]   kept the unloadable library as ${basename(set.broken)}`);
    }
    copyFileSync(set.backup, set.library);
    console.log(`[repair]   restored ${basename(set.library)} from the backup`);
    for (const stale of [set.update, set.sentinel, set.backup]) {
      if (existsSync(stale)) unlinkSync(stale);
    }
    console.log("[repair]   cleared the staged update, the sentinel and the backup");
  }
  if (options.dryRun) {
    console.log("[repair] --dry-run: nothing was changed");
    return 0;
  }
  console.log("[repair] done — start the app again; report the failure with the .broken file if it recurs");
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[repair] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
