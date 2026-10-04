#!/usr/bin/env node
/**
 * Platform / format tables shared by the desktop build and release scripts.
 *
 * The `os-arch` slug defined here (`linux-x64`, `macos-arm64`, `windows-x64`, …)
 * is load-bearing, not cosmetic: it is (a) the name of each directory under
 * `release/`, (b) the subdirectory the app appends to the update base URL, and
 * (c) what `latest.json` describes. `desktop/src/paths.ts` implements the same
 * three-line mapping for the running app — keep them in step.
 */

/** `--target` shorthands, and the triples `deno desktop` accepts. */
export const TRIPLES = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "macos-x64": "x86_64-apple-darwin",
  "macos-arm64": "aarch64-apple-darwin",
  "windows-x64": "x86_64-pc-windows-msvc",
};

/**
 * Per-platform output names, and which of them are installers vs. portable
 * bundles. The extension is what selects the format inside `deno desktop`.
 */
export const FORMATS = {
  linux: {
    AppImage: { name: "CelesteaStudio.AppImage", kind: "installer", portable: true },
    deb: { name: "CelesteaStudio.deb", kind: "installer", portable: true },
    rpm: { name: "CelesteaStudio.rpm", kind: "installer", portable: true },
    dir: { name: "CelesteaStudio", kind: "dir", portable: true },
  },
  macos: {
    // `denoOut` is what goes to `-o`: `deno desktop` appends `.app` itself, so
    // passing "Celestea Studio.app" yields "Celestea Studio.app.app" (measured)
    // and an ugly CFBundleName. The build script normalizes the result either way.
    // `distribute: false` — the .app is what the zip wraps and what a future
    // patch is diffed against, but a directory is not something a user can
    // download: release/ carries the zip.
    app: { name: "Celestea Studio.app", kind: "installer", portable: true, denoOut: "Celestea Studio", distribute: false },
    dmg: { name: "Celestea Studio.dmg", kind: "installer", portable: true },
    dir: { name: "CelesteaStudio", kind: "dir", portable: true },
  },
  windows: {
    msi: { name: "CelesteaStudio.msi", kind: "installer", portable: true },
    // `distribute: false` = built (it is what the zip wraps, and what a future
    // patch is diffed against) but not copied into release/.
    dir: { name: "CelesteaStudio", kind: "dir", portable: true, distribute: false },
  },
};

/** `zip` / `tar.gz` wrap whatever `dir` produced (macOS .app, Windows portable). */
export const ARCHIVE_FORMATS = { zip: ".zip", "tar.gz": ".tar.gz" };

/** What a plain `--target <platform>` builds when no `--formats` is given. */
export const DEFAULT_FORMATS = {
  // Linux: the portable single file everyone can run, plus the Debian package.
  linux: ["AppImage", "deb"],
  // macOS: the .app plus a zip that preserves the executable bit (a .dmg needs
  // hdiutil, i.e. a macOS host — see the distribution docs).
  macos: ["app", "zip"],
  // Windows: the installer, plus a portable zip for locked-down machines. `dir`
  // is the zip's source and the patch baseline, so it is always built.
  windows: ["msi", "dir", "zip"],
};

/** The `os-arch` slug for a release directory / update URL. */
export function platformSlug(platform, arch) {
  const osLabel = platform === "darwin" || platform === "macos" ? "macos" : platform === "win32" ? "windows" : platform;
  const archLabel = arch === "x86_64" || arch === "x64" ? "x64" : arch === "aarch64" || arch === "arm64" ? "arm64" : arch;
  return `${osLabel}-${archLabel}`;
}

export function hostPlatform() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

export function hostArch() {
  return process.arch === "arm64" ? "arm64" : "x64";
}

/**
 * Resolve a `--target` value into `{platform, arch, slug, triple}`.
 * Accepts a shorthand (`linux`), a slug (`linux-arm64`), or a full triple.
 */
export function resolveTarget(requested) {
  if (requested === "host") {
    const platform = hostPlatform();
    const arch = hostArch();
    return { platform, arch, slug: platformSlug(platform, arch), triple: TRIPLES[`${platform}-${arch}`], host: true };
  }
  if (requested in TRIPLES) {
    const [platform, arch] = requested.split("-");
    return { platform, arch, slug: requested, triple: TRIPLES[requested], host: requested === platformSlug(hostPlatform(), hostArch()) };
  }
  if (requested in { linux: 1, macos: 1, windows: 1 }) {
    const arch = hostArch();
    const slug = platformSlug(requested, arch);
    return { platform: requested, arch, slug, triple: TRIPLES[slug], host: slug === platformSlug(hostPlatform(), hostArch()) };
  }
  const platform = requested.includes("darwin") ? "macos" : requested.includes("windows") ? "windows" : requested.startsWith("linux") ? "linux" : null;
  if (platform === null) throw new Error(`unsupported target: ${requested}`);
  const arch = requested.includes("aarch64") || requested.includes("arm64") ? "arm64" : "x64";
  return { platform, arch, slug: platformSlug(platform, arch), triple: requested, host: platformSlug(platform, arch) === platformSlug(hostPlatform(), hostArch()) };
}

/** Every supported target, as slugs. */
export function allTargets() {
  return Object.keys(TRIPLES);
}
