#!/usr/bin/env node
/**
 * `latest.json` — the manifest the auto-updater reads — plus file hashing.
 *
 * Shape (from the Deno desktop auto-update docs):
 *
 *   { "version": "2.8.2",
 *     "patches": { "2.8.1": { "name": "patch-2.8.1-to-2.8.2.bin", "sha256": "…" } } }
 *
 * One manifest per `os-arch` directory: a bsdiff patch is a diff of the RUNTIME
 * LIBRARY, so a Linux patch cannot apply to a macOS or ARM64 library. The runtime
 * checks `updates/<os>-<arch>/latest.json` because the app appends that slug to
 * the configured base URL (see desktop/src/paths.ts `updateUrlFor`).
 *
 * Merging matters: each release adds one `from-version -> to-version` patch, and
 * users may be several versions behind, so the manifest ACCUMULATES entries
 * instead of being overwritten.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Read an existing manifest, or null when there is none / it is unreadable. */
export function readManifest(dir) {
  const file = join(dir, "latest.json");
  if (!existsSync(file)) return null;
  try {
    const doc = JSON.parse(readFileSync(file, "utf8"));
    return typeof doc === "object" && doc !== null ? doc : null;
  } catch {
    return null;
  }
}

/**
 * Write/merge `<dir>/latest.json`.
 *
 * `addPatch` records one new `from -> version` entry. `version` always becomes the
 * manifest's version (the newest release wins), and older patch entries are kept
 * so a user two versions behind still has a path forward.
 */
export function writeManifest(dir, { version, baseUrl = null, addPatch = null }) {
  mkdirSync(dir, { recursive: true });
  const existing = readManifest(dir) ?? { version, patches: {} };
  const patches = { ...(existing.patches ?? {}) };
  if (addPatch !== null) patches[addPatch.fromVersion] = { name: addPatch.name, sha256: addPatch.sha256 };
  const manifest = { version, patches };
  if (baseUrl !== null) manifest.baseUrl = baseUrl;
  writeFileSync(join(dir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** `<sha256>  <relative path>` lines, the usual `sha256sum -c` format. */
export function writeChecksums(file, entries) {
  const lines = entries.map((entry) => `${sha256File(entry.path)}  ${entry.rel}`).join("\n");
  writeFileSync(file, `${lines}\n`);
  return lines;
}

/** Human-readable size for build logs. */
export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

