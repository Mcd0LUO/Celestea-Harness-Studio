#!/usr/bin/env node
/**
 * Bundle the studio server into `desktop/app/celestea-server.mjs`.
 *
 * Why a bundle at all. `deno desktop` embeds the entry module's whole module
 * graph, and this repository is a pnpm monorepo: pointing Deno at the sources
 * makes it walk the workspace and embed `node_modules/` too (measured: the same
 * hello-world went from ~78 MB to ~326 MB). A single file that imports nothing
 * but `node:` builtins keeps the desktop binary at the size of the Deno runtime
 * plus the frontend, and removes the monorepo from the packaging problem.
 *
 * Two deliberate choices in here:
 *
 *   1. `tsconfigRaw: {}` disables TypeScript `paths`. Without it esbuild honours
 *      the root tsconfig and resolves every `@celestea/*` to a `.ts` SOURCE,
 *      which then fails on the sources' NodeNext `./x.js` imports. The compiled
 *      `dist/` output is what ships, so it is what gets bundled.
 *   2. workspace packages are resolved by the plugin below, straight to
 *      `packages/<name>/dist/index.js`, instead of through pnpm's `node_modules`
 *      symlinks. That is not paranoia: `@celestea/runtime` imports
 *      `@celestea/swarm` at runtime while `packages/runtime/package.json` does
 *      not declare it, so a plain Node/Deno import of the built runtime fails
 *      with "Cannot find package '@celestea/swarm'". Resolving workspace packages
 *      by path makes the desktop bundle immune to link state and undeclared
 *      intra-workspace edges.
 *
 * The esbuild CLI is not used because plugin resolution needs the JS API. The API
 * is imported by ABSOLUTE PATH on purpose: `desktop/` is not a pnpm workspace
 * package, so `import "esbuild"` cannot resolve from here (esbuild is a
 * devDependency of `apps/web`, which is where it is looked up).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { APP_DIR, REPO_ROOT, SERVER_BUNDLE, SERVER_ENTRY } from "./paths.mjs";

/** Compiled artifacts the bundle entry needs; a missing one means "build first". */
const REQUIRED_INPUTS = ["apps/studio/dist/server.js", "apps/studio/dist/config.js", "apps/cli/src/open-browser.ts"];

/** Every workspace package that must have a built `dist/index.js`. */
export function workspacePackages(repoRoot = REPO_ROOT) {
  const root = join(repoRoot, "packages");
  if (!existsSync(root)) return [];
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(root, entry.name, "package.json");
    if (!existsSync(manifest)) continue;
    const doc = JSON.parse(readFileSync(manifest, "utf8"));
    if (typeof doc.name === "string") found.push({ name: doc.name, dir: join(root, entry.name) });
  }
  return found;
}

export function missingInputs(repoRoot = REPO_ROOT) {
  const missing = REQUIRED_INPUTS.filter((rel) => !existsSync(join(repoRoot, rel)));
  for (const pkg of workspacePackages(repoRoot)) {
    if (!existsSync(join(pkg.dir, "dist", "index.js"))) missing.push(`packages/${pkg.name.replace("@celestea/", "")}/dist/index.js`);
  }
  return missing;
}

/** Locate esbuild's JS API (a devDependency of apps/web, not of the root). */
function findEsbuildApi(repoRoot) {
  const roots = [repoRoot, join(repoRoot, "apps", "web"), join(repoRoot, "apps", "studio")];
  for (const root of roots) {
    const api = join(root, "node_modules", "esbuild", "lib", "main.js");
    if (existsSync(api)) return api;
  }
  throw new Error("esbuild was not found in node_modules — run pnpm install (it is a devDependency of apps/web)");
}

/** Resolve `@celestea/*` to the built workspace artifact, by path. */
function workspacePlugin(repoRoot, log) {
  const byName = new Map(workspacePackages(repoRoot).map((pkg) => [pkg.name, pkg.dir]));
  return {
    name: "celestea-workspace",
    setup(build) {
      build.onResolve({ filter: /^@celestea\// }, (args) => {
        const dir = byName.get(args.path);
        if (dir === undefined) return null; // not a workspace package: normal resolution
        const entry = join(dir, "dist", "index.js");
        if (!existsSync(entry)) {
          return { errors: [{ text: `${args.path} has no built dist/index.js at ${entry} — run pnpm run build` }] };
        }
        log?.(`${args.path} -> ${entry}`);
        return { path: entry };
      });
    },
  };
}

export async function bundleServer({ repoRoot = REPO_ROOT, quiet = false, verbose = false } = {}) {
  const missing = missingInputs(repoRoot);
  if (missing.length > 0) {
    throw new Error(
      `the studio is not built yet (missing: ${missing.join(", ")}).\n` +
        "  build it with: pnpm run build    (or: node desktop/scripts/build.mjs)",
    );
  }
  const api = await import(pathToFileURL(findEsbuildApi(repoRoot)).href);
  mkdirSync(APP_DIR, { recursive: true });

  const result = await api.build({
    entryPoints: [SERVER_ENTRY],
    outfile: SERVER_BUNDLE,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2023",
    // See the header: never let tsconfig `paths` pull TypeScript sources in.
    tsconfigRaw: {},
    // `apps/studio/dist/version.js` dynamically imports the checkout-only version
    // toolchain. Bundled, its `import.meta.url` becomes the app bundle's, its
    // `git describe` runs in a directory that is not a checkout, and the reported
    // version degrades to "dev". Kept external it resolves to the real toolchain
    // during a source run (so `deno run` reports the git version) and fails
    // cleanly inside the packaged app — where `ownPackageVersion()` then reads
    // `app/package.json`, which is exactly the version the updater compares.
    external: ["../../../scripts/version.mjs"],
    mainFields: ["module", "main"],
    conditions: ["node"],
    logLevel: quiet ? "silent" : "warning",
    metafile: true,
    plugins: [workspacePlugin(repoRoot, verbose ? (line) => console.log(`[desktop] ${line}`) : undefined)],
    banner: {
      js: [
        "// Celestea Studio desktop — bundled studio server.",
        "// Generated by desktop/scripts/bundle-server.mjs; do not edit.",
        "// Imports nothing but node: builtins, so `deno desktop` embeds one file.",
      ].join("\n"),
    },
  });
  if (result.errors.length > 0) {
    throw new Error(result.errors.map((error) => error.text).join("\n"));
  }
  return { bundle: SERVER_BUNDLE, bytes: statSync(SERVER_BUNDLE).size, metafile: result.metafile };
}

// Guarded so the module can be IMPORTED (build.mjs does) without running the CLI
// path: `process.argv[1]` is undefined when the module is not the entry point.
const isEntryPoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  try {
    const result = await bundleServer({ verbose: process.argv.includes("--verbose") });
    console.log(`[desktop] bundled ${(result.bytes / 1024 / 1024).toFixed(2)} MiB -> ${result.bundle}`);
  } catch (error) {
    console.error(`[desktop] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
