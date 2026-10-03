#!/usr/bin/env node
/**
 * Produce the release artifacts the built-in auto-updater consumes:
 * one bsdiff patch per (from-version -> to-version) plus `latest.json`.
 *
 * What the runtime expects (https://docs.deno.com/runtime/desktop/auto_update/):
 *
 *   GET <baseUrl>/latest.json     -> { version, patches: { "<from>": { name, sha256 } } }
 *   GET <baseUrl>/<name>          -> the bsdiff patch, SHA-256 checked before use
 *
 * The patch is a `bsdiff` of the app's RUNTIME LIBRARY between two releases (not
 * of the whole app): on Linux that is the `libdenort.so` sitting next to the
 * launcher, on macOS the framework dylib, on Windows `denort.dll`. `qbsdiff`
 * reads classic bsdiff 4.x output, so the stock `bsdiff` CLI is enough to make
 * one.
 *
 *   # small, shippable patches (needs the bsdiff CLI)
 *   bsdiff old-dylib new-dylib patch-1.4.0-to-1.5.0.bin
 *
 *   node desktop/scripts/make-release.mjs \
 *     --from  dist/linux-v1 --to dist/linux-v2 --version 2.8.2 --out release/linux-x64
 *
 * When no `bsdiff` binary is available, `--full` writes a VALID bsdiff whose
 * "extra" stream carries the whole new library. That patch applies exactly like a
 * real one (so the update flow can be tested end to end) but it is as large as
 * the library, which is why the script only does it when asked, and says so.
 *
 *   node desktop/scripts/make-release.mjs --from … --to … --version 2.8.2 --full
 *
 * Signing (defense in depth against a compromised release host):
 *
 *   node desktop/scripts/gen-update-key.mjs                     # once, offline
 *   node desktop/scripts/make-release.mjs … --sign-key private.pem
 *
 * A signed manifest is an envelope: { signed: "<manifest json>", signature: "<b64>" }.
 * The app then calls Deno.autoUpdate({ publicKey }) with the matching base64 raw
 * public key.
 */

import { execFileSync } from "node:child_process";
import { createPrivateKey, sign as signDetached } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { readManifest, sha256File, writeManifest } from "./manifest.mjs";
import { REPO_ROOT } from "./paths.mjs";
import { allTargets, platformSlug } from "./platforms.mjs";

/** Default release root — the same tree build.mjs fills (one upload directory). */
const RELEASE_DIR = join(REPO_ROOT, "release");

/** The `os-arch` slug a path belongs to, or null (paths carry it, e.g. dist/linux-x64/…). */
export function slugFromPath(path) {
  const match = /(?:^|[\\/])((?:linux|macos|windows)-(?:x64|arm64))(?:[\\/]|$)/.exec(path);
  return match === null ? null : match[1];
}

/** Candidate runtime-library names, per platform (checked in this order). */
const LIBRARY_NAMES = ["libdenort.so", "denort.dll", "libdenort.dylib", "denort"];
/** Nothing smaller than this can be the runtime library. */
const MIN_LIBRARY_BYTES = 8 * 1024 * 1024;

function usage() {
  console.log(`Build a release manifest + bsdiff patch for the desktop auto-updater.

Usage:
  node desktop/scripts/make-release.mjs --from <appdir> --to <appdir> --version <new>
                                       [--out <dir>] [--from-version <old>]
                                       [--base-url <url>] [--full] [--sign-key <pem>]
                                       [--name <file>] [--dry-run]

  --from / --to      built app directories (or .app bundles) of the two releases
  --version          the NEW version (must match Deno.desktopVersion of <to>)
  --from-version     the version the patch applies FROM (default: read from <from>
                     if possible, otherwise required)
  --out              output directory (default: release/<os-arch>, i.e. the upload tree)
  --platform         os-arch slug (linux-x64 | linux-arm64 | macos-x64 | macos-arm64 | windows-x64);
                     inferred from the --to path when it contains one
  --name             patch file name (default: patch-<from>-to-<to>.bin)
  --base-url         printed in the summary; also written to manifest.baseUrl
  --full             write a full-content bsdiff (no bsdiff CLI needed)
  --sign-key         Ed25519 private key PEM; wraps the manifest in a signed envelope
  --dry-run          report what would be produced, write nothing`);
}

function parseArgs(argv) {
  const options = { out: null, name: null, baseUrl: null, full: false, signKey: null, dryRun: false, platform: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--from") options.from = value();
    else if (arg === "--to") options.to = value();
    else if (arg === "--version") options.toVersion = value();
    else if (arg === "--from-version") options.fromVersion = value();
    else if (arg === "--out") options.out = value();
    else if (arg === "--platform") options.platform = value();
    else if (arg === "--name") options.name = value();
    else if (arg === "--base-url") options.baseUrl = value();
    else if (arg === "--sign-key") options.signKey = value();
    else if (arg === "--full") options.full = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown flag: ${arg} (try --help)`);
  }
  return options;
}

/** Every file under `dir` (cheap; app directories are small on the file side). */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * Find the runtime library inside a built app. The updater patches exactly this
 * file, so a wrong pick produces a patch that "applies" and yields a broken app —
 * hence the explicit name list, then a size floor, then a hard failure.
 */
export function findRuntimeLibrary(appDir) {
  const root = statSync(appDir).isDirectory() ? appDir : join(appDir, "..");
  const files = walk(root);
  for (const name of LIBRARY_NAMES) {
    const hit = files.find((file) => basename(file) === name);
    if (hit !== undefined) return hit;
  }
  const big = files.filter((file) => statSync(file).size >= MIN_LIBRARY_BYTES);
  const so = big.filter((file) => /\.(so|dylib|dll)$/.test(file));
  if (so.length === 1) return so[0];
  throw new Error(
    `could not identify the runtime library in ${appDir} (looked for ${LIBRARY_NAMES.join(", ")}).\n` +
      `  candidates >= ${MIN_LIBRARY_BYTES / 1024 / 1024} MiB: ${big.map((f) => basename(f)).join(", ") || "none"}`,
  );
}

/** bsdiff's sign-magnitude `off_t` encoding (7 magnitude bytes + a sign bit). */
function offTout(value) {
  const buffer = Buffer.alloc(8);
  let magnitude = BigInt(value < 0 ? -value : value);
  for (let i = 0; i < 8; i++) {
    buffer[i] = Number(magnitude & 0xffn);
    magnitude >>= 8n;
  }
  if (value < 0) buffer[7] |= 0x80;
  return buffer;
}

/** bzip2 a buffer through the system tool (Node has no bzip2 encoder). */
function bzip2(buffer) {
  try {
    return execFileSync("bzip2", ["-c", "-9"], { input: buffer, maxBuffer: 1 << 30 });
  } catch (error) {
    throw new Error(`bzip2 failed (${error instanceof Error ? error.message : String(error)}) — bsdiff streams are bzip2-compressed`);
  }
}

/**
 * Write a VALID bsdiff patch whose whole content travels in the "extra" stream.
 *
 * bsdiff's format is compressed control/diff/extra sections; a control triple of
 * (add=0, copy=<newSize>, seek=0) means "copy the entire new file out of extra",
 * which any bsdiff reader — qbsdiff included — reconstructs exactly. The result
 * is correct and large; it exists so the update pipeline can be exercised without
 * a bsdiff toolchain, and is never the recommended artifact.
 */
export function writeFullPatch(newFile, outFile) {
  const newBytes = readFileSync(newFile);
  const control = Buffer.concat([offTout(0), offTout(newBytes.length), offTout(0)]);
  const controlBz = bzip2(control);
  const diffBz = bzip2(Buffer.alloc(0));
  const extraBz = bzip2(newBytes);
  const header = Buffer.concat([Buffer.from("BSDIFF40", "ascii"), offTout(controlBz.length), offTout(diffBz.length), offTout(newBytes.length)]);
  writeFileSync(outFile, Buffer.concat([header, controlBz, diffBz, extraBz]));
  return { bytes: statSync(outFile).size, mode: "full" };
}

/** Real bsdiff, when the CLI exists. */
export function writeBsdiffPatch(oldFile, newFile, outFile) {
  const binary = process.env.BSDIFF ?? "bsdiff";
  execFileSync(binary, [oldFile, newFile, outFile], { stdio: "pipe" });
  return { bytes: statSync(outFile).size, mode: "bsdiff" };
}

/** Wrap a manifest in the signed envelope the runtime verifies. */
export function signManifest(manifest, privateKeyPem) {
  const json = JSON.stringify(manifest);
  const key = createPrivateKey(privateKeyPem);
  const signature = signDetached(null, Buffer.from(json, "utf8"), key);
  return { signed: json, signature: signature.toString("base64") };
}

export function makeRelease(options) {
  if (!options.from || !options.to || !options.toVersion) {
    throw new Error("--from, --to and --version are required (try --help)");
  }
  const fromDir = resolve(options.from);
  const toDir = resolve(options.to);
  for (const dir of [fromDir, toDir]) {
    if (!existsSync(dir)) throw new Error(`no such app directory: ${dir}`);
  }
  const fromVersion = options.fromVersion ?? readAppVersion(fromDir);
  if (fromVersion === undefined) {
    throw new Error("could not read the old version from the app directory — pass --from-version");
  }
  if (fromVersion === options.toVersion) throw new Error(`--from-version and --version are both ${fromVersion}`);

  const oldLib = findRuntimeLibrary(fromDir);
  const newLib = findRuntimeLibrary(toDir);
  const name = options.name ?? `patch-${fromVersion}-to-${options.toVersion}.bin`;
  const slug = options.platform ?? slugFromPath(toDir) ?? slugFromPath(fromDir);
  if (slug === null && options.out === null) {
    throw new Error(
      `cannot tell which platform this patch is for (no ${allTargets().join("/")} component in --to).\n` +
        "  Pass --platform <os-arch> or --out <release/<os-arch>>.",
    );
  }
  const outDir = resolve(options.out ?? join(RELEASE_DIR, slug));
  const patchPath = join(outDir, name);

  const manifestPreview = {
    version: options.toVersion,
    patches: { [fromVersion]: { name, sha256: "<computed after the patch is written>" } },
  };
  if (options.dryRun) {
    return { dryRun: true, oldLib, newLib, patchPath, manifest: manifestPreview, fromVersion, slug };
  }

  mkdirSync(outDir, { recursive: true });
  let patch;
  if (options.full) {
    patch = writeFullPatch(newLib, patchPath);
  } else {
    try {
      patch = writeBsdiffPatch(oldLib, newLib, patchPath);
    } catch (error) {
      throw new Error(
        `the bsdiff CLI failed or is missing (${error instanceof Error ? error.message.split("\n")[0] : String(error)}).\n` +
          "  Install bsdiff (Debian: apt install bsdiff; macOS: brew install bsdiff), or re-run with --full\n" +
          "  to write a valid but library-sized patch for testing.",
      );
    }
  }
  // The manifest ACCUMULATES: one entry per previous version, so a user one or
  // three releases behind still has a patch. An existing latest.json (written by
  // build.mjs for this platform) is merged, not replaced.
  const digest = sha256File(patchPath);
  const merged = writeManifest(outDir, {
    version: options.toVersion,
    baseUrl: options.baseUrl ?? readManifest(outDir)?.baseUrl ?? null,
    addPatch: { fromVersion, name, sha256: digest },
  });
  const manifestPath = join(outDir, "latest.json");
  let signed = false;
  if (options.signKey !== null) {
    const envelope = signManifest(merged, readFileSync(options.signKey, "utf8"));
    writeFileSync(manifestPath, `${JSON.stringify(envelope, null, 2)}\n`);
    signed = true;
  }

  return {
    fromVersion,
    toVersion: options.toVersion,
    slug: slug ?? "<unknown>",
    oldLib,
    newLib,
    patchPath,
    patchBytes: patch.bytes,
    mode: patch.mode,
    manifestPath,
    signed,
    manifest: merged,
  };
}

/**
 * Best-effort read of the version baked into an app: the launcher unpacked or the
 * staged `package.json` next to the runtime library. Missing is not fatal — the
 * caller can pass `--from-version`.
 */
function readAppVersion(appDir) {
  const candidates = [];
  try {
    candidates.push(...walk(appDir).filter((file) => basename(file) === "package.json"));
  } catch {
    return undefined;
  }
  for (const file of candidates) {
    try {
      const doc = JSON.parse(readFileSync(file, "utf8"));
      if (typeof doc.version === "string" && doc.version !== "") return doc.version;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      usage();
      process.exit(0);
    }
    const result = makeRelease(options);
    if (result.dryRun) {
      console.log(`[release] would patch ${result.fromVersion} -> ${result.manifest.version}`);
      console.log(`[release]   old library: ${result.oldLib}`);
      console.log(`[release]   new library: ${result.newLib}`);
      console.log(`[release]   patch:       ${result.patchPath}`);
    } else {
      console.log(
        `[release] ${result.mode === "full" ? "FULL-CONTENT" : "bsdiff"} patch ` +
          `${result.fromVersion} -> ${result.toVersion}: ${result.patchPath} (${(result.patchBytes / 1024 / 1024).toFixed(2)} MiB)`,
      );
      console.log(`[release] manifest: ${result.manifestPath}${result.signed ? " (signed envelope)" : ""}`);
      console.log(`[release] platform directory: ${result.slug} — upload it; the app polls <baseUrl>/${result.slug}/latest.json`);
      if (result.mode === "full") {
        console.log(`[release] NOTE: a full-content patch; install bsdiff and re-run without --full for a small one.`);
      }
    }
  } catch (error) {
    console.error(`[release] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
