#!/usr/bin/env node
/**
 * build-webdist.mjs (H) — build the frontend, then stage it INSIDE @celestea/studio.
 *
 * Why: a globally installed `celestea` has no repo checkout, so
 * `<repo>/apps/web/dist` does not exist. The Vite build is copied to
 * `apps/studio/webdist`, which the shipped `defaultStaticRoot()` prefers.
 *
 * Why it BUILDS first (not just copies): an audit caught `webdist` shipping a
 * STALE frontend (build-meta sha one commit behind) while every gate was green —
 * `pnpm -r build` may run independent packages in parallel, so "web built, then
 * studio copied" was never guaranteed. Rebuilding here makes freshness a
 * property of the staging step itself, not of workspace ordering. Set
 * `CELESTEA_SKIP_WEB_BUILD=1` to stage an already-built dist (the
 * `release:check` gate still verifies freshness).
 *
 * ## Why `check:web` calls THIS (not `apps/web run build`) — 2026-10-04
 *
 * It used to call `apps/web run build`, which refreshes `apps/web/dist` but NOT the
 * staged `apps/studio/webdist` the app actually serves (`defaultStaticRoot()` prefers
 * it). So `pnpm check` was green while `npm start` served a frontend 13 commits behind
 * — the SAME failure this header already records from the earlier audit. Routing the
 * gate through here makes "gate green" imply "the served artifact is current", i.e. it
 * closes a false-green channel rather than adding a check.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(REPO_ROOT, "apps", "web", "dist");
const TARGET = join(REPO_ROOT, "apps", "studio", "webdist");

if (process.env["CELESTEA_SKIP_WEB_BUILD"] !== "1") {
  console.log("[build-webdist] building apps/web (freshness is the point of this step)");
  // shell on Windows only: pnpm is a .cmd shim there, and execFileSync does not
  // apply PATHEXT — spawning the bare name raises ENOENT. Same rule (and same
  // reason) as scripts/run-with-env.mjs.
  execFileSync("pnpm", ["--dir", "apps/web", "run", "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
} else {
  console.log("[build-webdist] CELESTEA_SKIP_WEB_BUILD=1 — staging the existing apps/web/dist");
}

if (!existsSync(join(SOURCE, "index.html")) || !existsSync(join(SOURCE, "build-meta.json"))) {
  console.error("[build-webdist] no built frontend at " + SOURCE + " (run apps/web build first)");
  process.exit(1);
}
rmSync(TARGET, { recursive: true, force: true });
cpSync(SOURCE, TARGET, { recursive: true });
console.log("[build-webdist] staged " + SOURCE + " -> " + TARGET);
