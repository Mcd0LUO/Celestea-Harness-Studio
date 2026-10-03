#!/usr/bin/env node
/**
 * Build the Celestea Studio desktop app for one platform or all of them, and lay
 * the result out for a single upload.
 *
 * OUTPUT LAYOUT (the point of this script):
 *
 *   release/<os-arch>/
 *     CelesteaStudio.AppImage | CelesteaStudio.deb | …   the distributables
 *     CelesteaStudio-<ver>-<os-arch>.zip                 (macOS .app / portable dir)
 *     latest.json                                        the update manifest for THIS platform
 *     patch-<from>-to-<to>.bin                           added by make-release.mjs
 *   release/SHA256SUMS.txt                               `sha256sum -c` format
 *   release/index.json                                   machine-readable index of the above
 *   release/README.md                                    what to upload where
 *
 * Intermediates stay out of the way in `desktop/dist/<os-arch>/<format>/` — the
 * unpacked app directory there is what a future patch is diffed against, so it
 * must survive the build.
 *
 * WHY PER-PLATFORM DIRECTORIES: a bsdiff patch is a diff of the runtime library,
 * so it is per OS *and* per architecture. The app appends `<os-arch>` to the
 * configured base URL (`desktop/src/paths.ts`), which makes the release tree the
 * update tree — one directory per platform, uploaded as-is.
 *
 * USAGE
 *   node desktop/scripts/build.mjs                       host platform, default formats
 *   node desktop/scripts/build.mjs --all-targets          all five targets
 *   node desktop/scripts/build.mjs --target linux-arm64 --formats AppImage
 *   node desktop/scripts/build.mjs --update-url https://host/celestea-studio
 *   node desktop/scripts/build.mjs --skip-repo-build      reuse the workspace dists
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bundleServer } from "./bundle-server.mjs";
import { installUnsignedMacosTools, writeAppIcns } from "./macos-unsigned-tools.mjs";
import { humanSize, readManifest, sha256File, writeChecksums, writeManifest } from "./manifest.mjs";
import { DESKTOP_DIR, DIST_DIR, REPO_ROOT } from "./paths.mjs";
import { ARCHIVE_FORMATS, DEFAULT_FORMATS, FORMATS, allTargets, resolveTarget } from "./platforms.mjs";
import { desktopVersion, pathBytes, stageResources, syncVersion } from "./stage.mjs";

const RELEASE_DIR = join(REPO_ROOT, "release");
/** The target icon files, per platform (see the comment at the use site). */
const ICON_FOR = { windows: "icons/icon.ico", linux: "icons/icon-512.png" };

function usage() {
  console.log(`Build the Celestea Studio desktop app into release/<os-arch>/.

Flags:
  --target <name>        ${allTargets().join(" | ")} | linux | macos | windows | <triple>   (repeatable)
  --all-targets          every supported target
  --format/--formats <l> comma list, e.g. "AppImage,deb" | "app,zip" | "msi,zip"
                         available: ${Object.entries(FORMATS).map(([p, f]) => `${p}: ${Object.keys(f).join("/")}`).join("  ")} (+ zip/tar.gz)
  --update-url <url>     base URL of the release host; baked into the binary and
                         used by the updater as <url>/<os-arch>
  --out <dir>            release root (default: <repo>/release)
  --backend <webview|cef>
  --compress [xz|zstd]   self-extracting compressed bundle
  --deno-flag <flag>     extra flag for "deno desktop" (repeatable)
  --skip-repo-build      do not run "pnpm run build"
  --skip-icons           do not generate missing icons
  --skip-stage           do not restage app resources
  --no-release           build into dist/ only (no release/ tree, no manifests)
  --continue-on-error    keep building other platforms after one fails (a
                         multi-platform release should not be all-or-nothing)
  --index-only           do not build: re-hash whatever <out>/<os-arch>/ already
                         holds and rewrite SHA256SUMS.txt / index.json / README.md
                         (used by the CI job that merges per-platform runners)
  --macos-unsigned       also build macOS .app on a non-macOS host, using Node
                         stand-ins for "iconutil" and "codesign". The result is
                         UNSIGNED: macOS refuses it until the user clears the
                         quarantine flag once (xattr -dr com.apple.quarantine).
                         Without this flag, macOS is skipped on such hosts.
  --quiet, --help

Environment:
  CELESTEA_DESKTOP_VERSION   override the version baked into the binary
  DENO                       deno binary to use (default: deno on PATH)`);
}

function parseArgs(argv) {
  const options = {
    targets: [],
    formats: null,
    updateUrl: null,
    out: RELEASE_DIR,
    backend: null,
    compress: null,
    denoFlags: [],
    repoBuild: true,
    icons: true,
    stage: true,
    release: true,
    quiet: false,
    continueOnError: false,
    indexOnly: false,
    macosUnsigned: false,
    help: false,
  };
  const value = (i, flag) => {
    const next = argv[i];
    if (next === undefined) throw new Error(`${flag} needs a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target") options.targets.push(value(++i, arg));
    else if (arg === "--all-targets") {
      options.targets.push(...allTargets());
      options.bulk = true;
    }
    else if (arg === "--format" || arg === "--formats") options.formats = value(++i, arg).split(",").map((f) => f.trim()).filter((f) => f !== "");
    else if (arg === "--update-url") options.updateUrl = value(++i, arg);
    else if (arg === "--out") options.out = value(++i, arg);
    else if (arg === "--backend") options.backend = value(++i, arg);
    else if (arg === "--compress") options.compress = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : "xz";
    else if (arg.startsWith("--compress=")) options.compress = arg.slice("--compress=".length);
    else if (arg === "--deno-flag") options.denoFlags.push(value(++i, arg));
    else if (arg === "--skip-repo-build") options.repoBuild = false;
    else if (arg === "--skip-icons") options.icons = false;
    else if (arg === "--skip-stage") options.stage = false;
    else if (arg === "--no-release") options.release = false;
    else if (arg === "--index-only") options.indexOnly = true;
    else if (arg === "--macos-unsigned") options.macosUnsigned = true;
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--continue-on-error") options.continueOnError = true;
    else if (arg === "--explicit") options.explicit = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown flag: ${arg} (try --help)`);
  }
  return options;
}

function run(command, args, { cwd = DESKTOP_DIR, quiet = false, env = process.env } = {}) {
  execFileSync(command, args, { cwd, stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit", env });
}

/**
 * Bake `--update-url` into deno.json (where `deno desktop` reads it from).
 *
 * Written SURGICALLY for the same reason `syncVersion` is: a structured rewrite
 * reformats the whole file. If the value already exists it is replaced in place;
 * otherwise a one-line `"release"` block is inserted after `"backend"`. Only if
 * neither shape is found does it fall back to re-serializing — with a warning, so
 * a human knows why their formatting moved.
 */
export function setUpdateUrl(url) {
  const file = join(DESKTOP_DIR, "deno.json");
  const base = url.replace(/\/+$/, "");
  const raw = readFileSync(file, "utf8");
  const withValue = raw.replace(/("baseUrl"\s*:\s*)"[^"]*"/, `$1"${base}"`);
  if (withValue !== raw) {
    writeFileSync(file, withValue);
    return base;
  }
  const inserted = raw.replace(
    /^([ \t]*)"backend"\s*:\s*"[^"]*",?\s*$/m,
    (line) => `${line.replace(/,\s*$/, "")},\n    "release": { "baseUrl": "${base}" }`,
  );
  if (inserted !== raw) {
    writeFileSync(file, inserted);
    return base;
  }
  const doc = JSON.parse(raw);
  doc.desktop = doc.desktop ?? {};
  doc.desktop.release = { ...(doc.desktop.release ?? {}), baseUrl: base };
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  console.error("[desktop] warning: deno.json has no \"backend\" line to insert next to; the file was re-serialized");
  return base;
}

/** `zip`/`tar.gz` wrap the directory a platform's `dir`/`app` format produced. */
function isArchive(format) {
  return format in ARCHIVE_FORMATS;
}

function hasCommand(command) {
  const path = process.env.PATH ?? "";
  for (const dir of path.split(process.platform === "win32" ? ";" : ":")) {
    if (dir === "") continue;
    for (const suffix of process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""]) {
      try {
        if (statSync(join(dir, `${command}${suffix}`)).isFile) return true;
      } catch {
        // keep looking
      }
    }
  }
  return false;
}

/**
 * A tar that can WRITE a zip (`-a` picks the format from the extension).
 *
 * On Windows this is `%SystemRoot%\System32\tar.exe` (bsdtar), and it is named by
 * absolute path on purpose: the CI job runs with `shell: bash`, so PATH starts with
 * Git for Windows' `usr/bin` — whose `tar` is GNU tar. GNU tar both refuses a
 * Windows path with a drive letter ("tar: Cannot connect to D: resolve failed",
 * reading `D:\…` as a remote host) and cannot write a zip. This was the second
 * failure of desktop-release.yml's Windows job, after the relative-output one.
 */
function zipCapableTar() {
  if (process.platform !== "win32") return "tar";
  const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  const exe = join(root, "System32", "tar.exe");
  return existsSync(exe) ? exe : "tar";
}

function archive(archiveFormat, sourceParent, innerName, outFile) {
  // The archiver runs with cwd = sourceParent (the payload has to be named relative
  // to it), and it gets the OUTPUT named relative to that same cwd too. Two
  // failures taught this, both from real CI runs of desktop-release.yml:
  //
  //   1. `--out release` was passed through unchanged, so `zip`/`tar` looked for
  //      `release/macos-arm64/…` INSIDE sourceParent:
  //        zip error: Could not create output file (release/macos-arm64/…zip)
  //        tar: release\windows-x64\…zip: Cannot open: No such file or directory
  //      — the Linux job never hit it: its formats are deb/AppImage, so no archiver
  //      runs at all, and local runs passed an absolute `--out` (the default).
  //   2. Making it absolute is not enough on Windows: tar read the drive letter as
  //      a remote host — "tar: Cannot connect to D: resolve failed".
  //
  // Relative-to-cwd is the form both `zip` and every `tar` accept on every OS.
  const target = resolve(outFile);
  mkdirSync(dirname(target), { recursive: true });
  const rel = relative(sourceParent, target);
  const out = rel === "" ? target : rel;
  if (archiveFormat === "zip") {
    if (hasCommand("zip")) {
      // -y keeps symlinks as symlinks; the executable bit inside a macOS .app
      // survives, which a zip written without it would lose.
      run("zip", ["-r", "-y", "-q", out, innerName], { cwd: sourceParent });
      return;
    }
    // Windows runners have no `zip` on PATH, but they do ship bsdtar in
    // System32, which writes a real zip when the extension says so (`-a`).
    run(zipCapableTar(), ["-a", "-c", "-f", out, innerName], { cwd: sourceParent });
    return;
  }
  run("tar", ["-czf", out, innerName], { cwd: sourceParent });
}

/** Recursive copy that keeps the executable bits (a macOS .app is a tree). */
function copyTree(from, to) {
  if (!statSync(from).isDirectory()) {
    // The destination's PARENT is what needs creating here; making `to` itself a
    // directory first is how the first version turned every copied file into
    // "EISDIR: illegal operation on a directory".
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    return;
  }
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    copyTree(join(from, entry.name), join(to, entry.name));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return 0;
  }
  const say = (line) => {
    if (!options.quiet) console.log(`[desktop] ${line}`);
  };

  const version = desktopVersion();
  if (options.indexOnly) {
    const written = writeReleaseIndex(options.out, version);
    say(`index rebuilt for ${written.platforms} platform(s), ${written.files} file(s)`);
    return 0;
  }
  const synced = syncVersion(version);
  if (synced.changed) say(`deno.json version ${synced.previous} -> ${synced.version}`);
  let baseUrl = readManifest(join(RELEASE_DIR, "linux-x64"))?.baseUrl ?? null;
  if (options.updateUrl !== null) {
    baseUrl = setUpdateUrl(options.updateUrl);
    say(`update URL baked in: ${baseUrl} (the app polls ${baseUrl}/<os-arch>/latest.json)`);
  }

  if (options.icons && !existsSync(join(DESKTOP_DIR, "icons", "icon-512.png"))) {
    say("generating icons");
    run("python3", [join(DESKTOP_DIR, "scripts", "gen-icons.py")], { quiet: options.quiet });
  }
  // `desktop.app.icons.macos` must be a STRING (the official config schema says so;
  // the prose docs also show an array, but the schema is what editors validate and
  // the runtime accepts), so the app icon is one `.icns` packed from the committed
  // PNGs. It is regenerated here whenever a PNG is newer, and committed so a bare
  // `deno desktop src/main.ts` still finds its icon.
  const iconsDir = join(DESKTOP_DIR, "icons");
  const icnsFile = join(iconsDir, "app.icns");
  const newestPng = readdirSync(iconsDir)
    .filter((name) => /^icon-\d+\.png$/.test(name))
    .map((name) => join(iconsDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  const stale = !existsSync(icnsFile) || (newestPng !== undefined && statSync(newestPng).mtimeMs > statSync(icnsFile).mtimeMs);
  if (stale && existsSync(join(iconsDir, "icon-512.png"))) {
    const packed = writeAppIcns(iconsDir, icnsFile);
    say(`icons/app.icns regenerated: ${packed.reps} representations, ${humanSize(packed.bytes)}`);
  }
  if (options.repoBuild) {
    say("building the workspace (pnpm run build)");
    try {
      run("pnpm", ["run", "build"], { cwd: REPO_ROOT, quiet: options.quiet });
    } catch (error) {
      throw new Error(
        "the workspace build failed (\"pnpm run build\").\n" +
          "  Most common causes, in the order they actually happen here:\n" +
          "   1. a package that imports a workspace package it does not declare, e.g.\n" +
          "      \"cannot find module '@celestea/x'\" -> add \"@celestea/x\": \"workspace:*\" to its\n" +
          "      package.json, then run \"pnpm install --no-frozen-lockfile\" (the lockfile has to\n" +
          "      be regenerated; pnpm-workspace.yaml sets frozenLockfile: true, so a plain\n" +
          "      \"pnpm install\" refuses with ERR_PNPM_OUTDATED_LOCKFILE).\n" +
          "   2. a genuinely broken source file (the failing package and file are printed above).\n" +
          "   3. a stale/absent node_modules: run \"pnpm install\".\n" +
          "  If the dist artifacts are ALREADY current (e.g. you just built them), you can skip the\n" +
          "  workspace build with --skip-repo-build — but that reuses whatever is on disk.\n" +
          `  original error: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`,
      );
    }
  } else {
    say("skipping the workspace build (--skip-repo-build)");
  }
  say("bundling the studio server (esbuild)");
  const bundle = await bundleServer({ quiet: options.quiet });
  say(`server bundle: ${humanSize(bundle.bytes)}`);
  if (options.stage) {
    const staged = stageResources({ version, quiet: options.quiet });
    say(`resources staged: ${humanSize(staged.bytes)}`);
  }

  const requested = options.targets.length > 0 ? options.targets : ["host"];
  const targets = requested.map(resolveTarget);
  const index = { generatedAt: new Date().toISOString(), version, baseUrl, platforms: {} };
  const checksumEntries = [];
  // Platforms this host cannot produce, recorded in index.json rather than left
  // as a silent hole in "all targets".
  const notBuilt = {};

  const failures = [];
  for (const target of targets) {
   try {
    // A macOS .app needs codesign(1) (Deno: "codesigning requires a macOS build
    // host"). `--all-targets` on Linux therefore SKIPS macOS with a loud note —
    // the alternative, "all platforms" that quietly omits one, is the kind of
    // claim this project does not make.
    const crossMacos = target.platform === "macos" && process.platform !== "darwin";
    let shimDir = null;
    if (crossMacos && !options.macosUnsigned) {
      const why = "requires a macOS build host (ad-hoc code signing uses codesign(1)); pass --macos-unsigned to get an UNSIGNED bundle";
      if (options.bulk && !options.explicit) {
        notBuilt[target.slug] = why;
        console.error(`[desktop] SKIP ${target.slug}: ${why} — or build it on macOS / via .github/workflows/desktop-release.yml`);
        continue;
      }
      throw new Error(`the macOS .app bundle needs codesign(1) on ${process.platform}.\n  ${why}`);
    }
    if (crossMacos) {
      // Node stand-ins for iconutil + codesign; see macos-unsigned-tools.mjs for
      // why both are required and what "unsigned" costs the user.
      shimDir = installUnsignedMacosTools(join(DIST_DIR, ".macos-unsigned-tools"));
      say(`${target.slug}: building UNSIGNED on ${process.platform} (iconutil/codesign stand-ins in ${relative(REPO_ROOT, shimDir)})`);
    }
    const formats = options.formats ?? DEFAULT_FORMATS[target.platform];
    // Directory-producing formats first: the archives wrap their output.
    const ordered = [...formats].sort((a, b) => Number(isArchive(a)) - Number(isArchive(b)));
    const releaseDir = join(options.out, target.slug);
    mkdirSync(releaseDir, { recursive: true });
    const files = [];

    const dirFormat = ordered.find((f) => f === "app" || FORMATS[target.platform][f]?.kind === "dir");
    const dirSpec = dirFormat === undefined ? null : FORMATS[target.platform][dirFormat];

    for (const format of ordered) {
      const spec = FORMATS[target.platform][format];
      if (spec === undefined) {
        if (!isArchive(format)) {
          throw new Error(`format "${format}" is not available on ${target.platform} (have: ${Object.keys(FORMATS[target.platform]).join(", ")} + ${Object.keys(ARCHIVE_FORMATS).join(", ")})`);
        }
        if (dirFormat === undefined || dirSpec === null) {
          throw new Error(`format "${format}" needs a directory format to archive (add "dir" or "app" to --formats)`);
        }
        const sourceParent = join(DIST_DIR, target.slug, dirFormat);
        if (!existsSync(join(sourceParent, dirSpec.name))) {
          throw new Error(`nothing to archive at ${join(sourceParent, dirSpec.name)} — build the "${dirFormat}" format first`);
        }
        const outFile = join(releaseDir, `CelesteaStudio-${version}-${target.slug}${ARCHIVE_FORMATS[format]}`);
        say(`packaging ${target.slug} ${format}`);
        archive(format, sourceParent, dirSpec.name, outFile);
        files.push({ name: outFile.split("/").pop(), path: outFile, kind: "archive" });
        continue;
      }

      // macOS on a non-macOS host is decided BEFORE this loop (see `crossMacos`):
      // either it was skipped with a reason, or the iconutil/codesign stand-ins are
      // already on PATH. Nothing to check here.
      const out = join(DIST_DIR, target.slug, format, spec.denoOut ?? spec.name);
      mkdirSync(dirname(out), { recursive: true });
      const args = ["desktop", "-A", "--config", "deno.json", "--include", "app"];
      if (!target.host) args.push("--target", target.triple);
      if (options.backend !== null) args.push("--backend", options.backend);
      if (options.compress !== null) args.push(`--compress=${options.compress}`);
      // Pass the TARGET platform's icon: a cross build otherwise hands the host's
      // icon to the packager, which skips it (measured: "not .ico, skipping").
      const icon = ICON_FOR[target.platform];
      if (icon !== undefined) args.push("--icon", icon);
      for (const flag of options.denoFlags) args.push(...flag.split(/\s+/).filter((part) => part !== ""));
      args.push("-o", out, "src/main.ts");
      say(`packaging ${target.slug} ${format} (${target.triple})`);
      run(process.env.DENO ?? "deno", args, {
        quiet: options.quiet,
        env: shimDir === null ? process.env : { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ""}` },
      });
      // `deno desktop` appends `.app` to whatever it is given on macOS, so the
      // produced path may or may not carry the suffix. Normalize to the ARTIFACT
      // name (`spec.name`, e.g. "Celestea Studio.app") — that is what the copy
      // step, the zip wrapper and index.json all refer to. Renaming to the `-o`
      // argument instead is how the first version of this lost the `.app`
      // extension and produced a bundle macOS would not recognize.
      const finalPath = join(dirname(out), spec.name);
      const produced = existsSync(out) ? out : existsSync(`${out}.app`) ? `${out}.app` : out;
      if (produced !== finalPath) {
        rmSync(finalPath, { recursive: true, force: true });
        renameSync(produced, finalPath);
      }

      if (options.release && spec.distribute !== false) {
        const released = join(releaseDir, spec.name);
        // Decide by what is actually on disk: a macOS `.app` is a directory even
        // though it is the "installer", and copyFileSync on it is an EISDIR.
        if (statSync(finalPath).isDirectory()) {
          rmSync(released, { recursive: true, force: true });
          copyTree(finalPath, released);
        } else {
          copyFileSync(finalPath, released);
        }
        files.push({ name: spec.name, path: released, kind: spec.kind });
      }
    }

    if (options.release) {
      // A first release for a platform has no patches — there is no previous
      // version to diff against. make-release.mjs adds the entry that lets users
      // on an older version move forward.
      const existing = readManifest(releaseDir);
      if (existing === null) {
        writeManifest(releaseDir, { version, baseUrl });
        say(`${target.slug}: wrote latest.json (version ${version}, no patches yet — see make-release.mjs)`);
      } else {
        say(`${target.slug}: keeping the existing latest.json (version ${existing.version}, ${Object.keys(existing.patches ?? {}).length} patches)`);
      }
    }

    index.platforms[target.slug] = {
      triple: target.triple,
      version,
      updateUrl: baseUrl === null ? null : `${baseUrl}/${target.slug}`,
      files: files.map((file) => ({
        name: file.name,
        kind: file.kind,
        bytes: pathBytes(file.path),
        sha256: digestOf(file.path),
      })),
      manifest: existsSync(join(releaseDir, "latest.json")) ? "latest.json" : null,
      ...(shimDir === null ? {} : { unsigned: true }),
    };
    for (const file of files) {
      // Directories cannot be hashed; their archive carries the hash instead.
      if (digestOf(file.path) !== null) checksumEntries.push({ path: file.path, rel: `${target.slug}/${file.name}` });
      say(`${target.slug}: ${file.name} (${humanSize(pathBytes(file.path))})`);
    }
   } catch (error) {
     const reason = error instanceof Error ? error.message : String(error);
     // Do not leave an empty <os-arch>/ behind claiming to be a platform.
     const dir = join(options.out, target.slug);
     if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
     failures.push({ slug: target.slug, reason });
     index.platforms[target.slug] = { triple: target.triple, version, files: [], error: reason };
     if (!options.continueOnError) throw new Error(`${target.slug}: ${reason}`);
     console.error(`[desktop] ${target.slug} FAILED: ${reason.split("\n")[0]} (continuing)`);
   }
  }

  if (options.release) {
    mkdirSync(options.out, { recursive: true });
    if (checksumEntries.length > 0) {
      writeChecksums(join(options.out, "SHA256SUMS.txt"), checksumEntries);
      say(`checksums: ${relative(REPO_ROOT, join(options.out, "SHA256SUMS.txt"))} (${checksumEntries.length} files)`);
    }
    for (const [slug, why] of Object.entries(notBuilt)) say(`${slug}: NOT BUILT — ${why}`);
    for (const [slug, info] of Object.entries(index.platforms)) {
      if (info.unsigned === true) {
        console.error(
          `[desktop] ${slug}: the .app is UNSIGNED (built on ${process.platform}). On the user's Mac:\n` +
            `  xattr -dr com.apple.quarantine "Celestea Studio.app"   # or right-click -> Open, once`,
        );
      }
    }
    if (Object.keys(notBuilt).length > 0) index.notBuilt = notBuilt;
    writeFileSync(join(options.out, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
    writeFileSync(join(options.out, "README.md"), releaseReadme(index));
    say(`index: ${relative(REPO_ROOT, join(options.out, "index.json"))}`);
    say(`release root: ${options.out} — upload it as-is; each <os-arch>/ directory is one update source`);
  }
  if (failures.length > 0) {
    console.error(`[desktop] ${failures.length} platform(s) failed: ${failures.map((f) => f.slug).join(", ")}`);
    return 1;
  }
  return 0;
}

/**
 * (Re)write `SHA256SUMS.txt`, `index.json` and `README.md` from whatever
 * `<out>/<os-arch>/` directories exist. Shared by a normal build and by
 * `--index-only`, which is what the CI merge job runs after collecting the
 * per-platform artifacts.
 */
function writeReleaseIndex(outDir, version) {
  const platforms = {};
  const checksumEntries = [];
  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^(linux|macos|windows)-(x64|arm64)$/.test(entry.name)) continue;
    const dir = join(outDir, entry.name);
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((child) => child.isFile() && child.name !== "latest.json")
      .map((child) => join(dir, child.name))
      .sort();
    const manifest = readManifest(dir);
    if (files.length === 0 && manifest === null) continue;
    platforms[entry.name] = {
      version: manifest?.version ?? version,
      updateUrl: manifest?.baseUrl === undefined || manifest.baseUrl === null ? null : `${manifest.baseUrl}/${entry.name}`,
      patches: Object.keys(manifest?.patches ?? {}),
      files: files.map((file) => ({ name: file.split("/").pop(), bytes: pathBytes(file), sha256: sha256File(file) })),
      manifest: manifest === null ? null : "latest.json",
    };
    for (const file of files) checksumEntries.push({ path: file, rel: `${entry.name}/${file.split("/").pop()}` });
  }
  mkdirSync(outDir, { recursive: true });
  if (checksumEntries.length > 0) writeChecksums(join(outDir, "SHA256SUMS.txt"), checksumEntries);
  const index = { generatedAt: new Date().toISOString(), version, platforms };
  writeFileSync(join(outDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  writeFileSync(join(outDir, "README.md"), releaseReadme(index));
  return { platforms: Object.keys(platforms).length, files: checksumEntries.length };
}

/**
 * sha256 of a file, or null for a directory.
 *
 * A macOS `.app` is a directory artifact: it has no single hash. Its
 * distributable form is the zip next to it, which IS hashed — so the bundle
 * still ends up covered by `SHA256SUMS.txt` (via the archive), and nothing tries
 * to `read(2)` a directory (`EISDIR: illegal operation on a directory, read`).
 */
function digestOf(path) {
  return statSync(path).isDirectory() ? null : sha256File(path);
}

function releaseReadme(index) {
  const rows = Object.entries(index.platforms)
    .map(([slug, info]) => {
      const files = info.files.map((f) => `\`${f.name}\``).join(", ") || "—";
      return `| \`${slug}\` | ${files} | ${info.updateUrl ?? "_not configured_"} |`;
    })
    .join("\n");
  return `# Celestea Studio ${index.version} — release artifacts

Generated by \`node desktop/scripts/build.mjs\`. Upload this whole directory: the
layout **is** the update layout.

| Platform | Distributables | Update source (the app polls \`<url>/latest.json\`) |
|---|---|---|
${rows}

## Not built here

${index.notBuilt === undefined || Object.keys(index.notBuilt).length === 0 ? "_Every supported platform was built._" : Object.entries(index.notBuilt).map(([slug, why]) => `- \`${slug}\`: ${why}`).join("\n")}

## What each file is

- **\`<os-arch>/latest.json\`** — the update manifest: the newest version plus one
  \`bsdiff\` patch per previous version the app can come from.
- **\`<os-arch>/patch-*.bin\`** — a binary diff of the *runtime library*. It is per
  platform **and** per architecture: there is no single cross-platform patch, which
  is exactly why the updater appends \`<os-arch>\` to the base URL.
- **\`SHA256SUMS.txt\`** — verify with \`sha256sum -c SHA256SUMS.txt\`.
- **\`index.json\`** — the same facts, machine-readable (sizes, hashes, update URLs).

## Shipping the next version

\`\`\`bash
# 1) build every platform (writes release/<os-arch>/)
CELESTEA_DESKTOP_VERSION=2.8.2 node desktop/scripts/build.mjs --all-targets --skip-repo-build

# 2) per platform, diff the OLD runtime library against the NEW one, then verify it
node desktop/scripts/make-release.mjs \\
  --from <old-release-dir>/linux-x64/CelesteaStudio \\
  --to   desktop/dist/linux-x64/AppImage/CelesteaStudio \\
  --version 2.8.2 --from-version 2.8.1
node desktop/scripts/verify-patch.mjs --old <old>/CelesteaStudio.so \\
  --patch release/linux-x64/patch-2.8.1-to-2.8.2.bin \\
  --expect desktop/dist/linux-x64/AppImage/CelesteaStudio/CelesteaStudio.so

# 3) upload release/ (or only the changed <os-arch>/ directories)
\`\`\`

Keep each release's unpacked app directory (\`desktop/dist/<os-arch>/<format>/<AppName>/\`):
that is what the next patch is diffed against.
`;
}

// Guarded: importing this module (tests, other scripts) must not start a build.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`[desktop] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
