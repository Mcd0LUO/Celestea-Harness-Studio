#!/usr/bin/env node
/**
 * Shared paths for the desktop build scripts.
 *
 * Every path is derived from this file's own location, never from the process
 * cwd: `pnpm run desktop:build` runs from the repo root, a CI job may run from
 * anywhere, and `deno desktop` is invoked with an explicit cwd (see build.mjs).
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `<repo>/desktop` */
export const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The repository root. */
export const REPO_ROOT = resolve(DESKTOP_DIR, "..");
/** Staged resources + the server bundle (gitignored, produced by the build). */
export const APP_DIR = join(DESKTOP_DIR, "app");
/** The esbuild output the shell imports at runtime. */
export const SERVER_BUNDLE = join(APP_DIR, "celestea-server.mjs");
/** The bundle's source (this is the shell's whole contract with the studio). */
export const SERVER_ENTRY = join(DESKTOP_DIR, "scripts", "server-entry.mjs");
/** Committed source icons; the builder uses these, staging copies them into app/. */
export const ICONS_DIR = join(DESKTOP_DIR, "icons");
/**
 * Intermediate build output (the unpacked app directories the packagers and the
 * patch baselines come from). Overridable so a second version can be built
 * WITHOUT clobbering the current one's baseline:
 *
 *   CELESTEA_DESKTOP_DIST=tmp/dist-2.8.2 node desktop/scripts/build.mjs --no-release
 */
export const DIST_DIR = (process.env.CELESTEA_DESKTOP_DIST ?? "").trim() !== ""
  ? (process.env.CELESTEA_DESKTOP_DIST ?? "").trim()
  : join(DESKTOP_DIR, "dist");
