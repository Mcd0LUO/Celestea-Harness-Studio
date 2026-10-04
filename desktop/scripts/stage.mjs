#!/usr/bin/env node
/**
 * Stage everything the compiled app needs at runtime into `desktop/app/`.
 *
 * The layout is not cosmetic — three runtime resolvers find their files by
 * walking up from the module's own location, and they only agree if the server
 * bundle sits in a directory that also holds `contracts/`, `webdist/` and a
 * `package.json`:
 *
 *   packages/core/src/repo.ts        contracts/endpoints.json   (frozen contracts)
 *   apps/studio/src/deployment.ts    package.json -> webdist/   (frontend build)
 *   apps/studio/src/version.ts       package.json -> version    (health endpoint)
 *
 * So `app/` is the app's resource root, and `--include app` is what puts it in
 * the binary (see build.mjs). Everything here is a copy of something already
 * built — nothing is transformed, so a staged tree is always explainable as
 * "the artifact, plus the frozen contracts, plus the frontend build".
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR, DESKTOP_DIR, ICONS_DIR, REPO_ROOT, SERVER_BUNDLE } from "./paths.mjs";

/** Paths that must exist after staging, with the reason each is required. */
const REQUIRED_OUTPUT = [
  ["celestea-server.mjs", "the studio server bundle (scripts/bundle-server.mjs)"],
  ["package.json", "the resource-root marker three runtime resolvers walk up to"],
  ["webdist/index.html", "the built frontend (apps/web/dist)"],
  ["contracts/endpoints.json", "the frozen contracts (verifyContractsAtStartup reads them)"],
  ["icons/tray.png", "the tray icon"],
  ["release.json", "the release/update facts read by the shell at boot (scripts/stage.mjs)"],
];

/**
 * The compile-time update URL, read from `desktop/deno.json`. Null when the
 * project configures none (then updates are disabled unless the operator sets
 * CELESTEA_DESKTOP_UPDATE_URL).
 */
export function readReleaseBaseUrl() {
  const doc = JSON.parse(readFileSync(join(DESKTOP_DIR, "deno.json"), "utf8"));
  const raw = doc?.desktop?.release?.baseUrl;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

/** Read the version the shell and the updater must agree on. */
export function desktopVersion(env = process.env) {
  const override = (env.CELESTEA_DESKTOP_VERSION ?? "").trim();
  if (override !== "") return override;
  const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  if (typeof root.version !== "string" || root.version === "") {
    throw new Error("the root package.json has no version — the desktop build needs one");
  }
  return root.version;
}

/**
 * Keep `desktop/deno.json`'s version equal to the repository's.
 *
 * `deno.json` is the ONLY place `deno desktop` reads the app version from, and
 * that value is baked into the binary as `Deno.desktopVersion` — which the
 * auto-updater compares against the release manifest. A drift here would make
 * every client believe it is out of date forever, so the build repairs it (the
 * same thing `pnpm version:sync` does for the web package) instead of trusting a
 * human to remember.
 */
export function syncVersion(version, { write = true } = {}) {
  const file = join(DESKTOP_DIR, "deno.json");
  const raw = readFileSync(file, "utf8");
  const before = JSON.parse(raw).version;
  if (before === version) return { changed: false, version };
  if (!write) return { changed: true, version, previous: before };
  // SURGICAL: replace the value only. Re-serializing the whole document reflows
  // every hand-formatted line (the macOS icon array grows from one line per entry
  // to four), which is how a build script ends up "changing the file format" of a
  // config a human maintains.
  const updated = raw.replace(/^(\s*"version"\s*:\s*)"[^"]*"/m, `$1"${version}"`);
  if (updated === raw) throw new Error(`could not find the "version" field in ${file}`);
  writeFileSync(file, updated);
  return { changed: true, version, previous: before };
}

export function stageResources({ repoRoot = REPO_ROOT, appDir = APP_DIR, version = desktopVersion(), quiet = false } = {}) {
  const say = (line) => {
    if (!quiet) console.log(`[desktop] ${line}`);
  };
  if (!existsSync(join(repoRoot, "apps", "web", "dist", "index.html"))) {
    throw new Error("apps/web/dist is missing — build the frontend first: pnpm run build");
  }
  if (!existsSync(join(repoRoot, "contracts", "endpoints.json"))) {
    throw new Error("contracts/endpoints.json is missing — the frozen contracts are required at runtime");
  }
  if (!existsSync(join(ICONS_DIR, "tray.png"))) {
    throw new Error("desktop/icons/tray.png is missing — generate the icons first: python3 desktop/scripts/gen-icons.py");
  }

  // The bundle is produced before staging and the destination is wiped, so it is
  // held in memory across the wipe (1-2 MiB) rather than copied around on disk.
  const bundleBytes = existsSync(SERVER_BUNDLE) ? readFileSync(SERVER_BUNDLE) : null;
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });

  cpSync(join(repoRoot, "apps", "web", "dist"), join(appDir, "webdist"), { recursive: true });
  cpSync(join(repoRoot, "contracts"), join(appDir, "contracts"), { recursive: true });
  cpSync(ICONS_DIR, join(appDir, "icons"), { recursive: true });

  const publicKey = join(DESKTOP_DIR, "update-pubkey.txt");
  if (existsSync(publicKey)) {
    cpSync(publicKey, join(appDir, "update-pubkey.txt"));
    say("staged a release public key (signed manifests will be required)");
  }

  writeFileSync(
    join(appDir, "package.json"),
    `${JSON.stringify({ name: "celestea-studio-desktop", version, private: true }, null, 2)}\n`,
  );

  // `desktop.release.baseUrl` is baked into the binary by `deno desktop` and is
  // NOT readable from the running program (no API, no env var). The shell also
  // needs it, for the honest manual "check for updates" (which reads
  // latest.json itself instead of guessing from Deno.autoUpdate()'s silence), so
  // the SAME deno.json value is staged as a resource. One source, two readers.
  const releaseBaseUrl = readReleaseBaseUrl();
  writeFileSync(join(appDir, "release.json"), `${JSON.stringify({ version, baseUrl: releaseBaseUrl }, null, 2)}\n`);

  if (bundleBytes !== null) writeFileSync(join(appDir, "celestea-server.mjs"), bundleBytes);
  else say("note: the server bundle was not present before staging — run scripts/bundle-server.mjs");

  const missing = REQUIRED_OUTPUT.filter(([rel]) => !existsSync(join(appDir, rel)));
  if (missing.length > 0) {
    throw new Error(`staging left the app incomplete:\n${missing.map(([rel, why]) => `  - ${rel} (${why})`).join("\n")}`);
  }

  const size = pathBytes(appDir);
  say(`staged ${(size / 1024 / 1024).toFixed(2)} MiB into ${appDir}`);
  return { appDir, version, bytes: size };
}

/** Bytes of a file or of a directory tree (build log lines and artefact sizes). */
export function pathBytes(target) {
  const stats = statSync(target);
  if (!stats.isDirectory()) return stats.size;
  let total = 0;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    total += pathBytes(join(target, entry.name));
  }
  return total;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const sync = syncVersion(desktopVersion());
    if (sync.changed) console.log(`[desktop] deno.json version ${sync.previous} -> ${sync.version}`);
    stageResources();
  } catch (error) {
    console.error(`[desktop] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
