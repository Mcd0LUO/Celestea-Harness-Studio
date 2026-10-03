#!/usr/bin/env tsx
/**
 * Golden fixture exporter (P0).
 *
 * READ-ONLY against the retired implementation:
 *   - session logs are read straight from disk (never written)
 *   - REST snapshots use GET only
 *   - the SSE transcript is a passive connect (no POST /api/turn, because that
 *     would append to a production cli-main.jsonl)
 *
 * Every byte written is passed through the redactor, and the export fails
 * loudly if any registered secret or generic token shape survives.
 *
 * !! NEVER COMMIT REAL-SESSION FIXTURES !!
 * The sessions this script reads are REAL user conversations (private dialogue,
 * tool output, internal hostnames). `fixtures/sessions/*` is gitignored except
 * for the synthetic `test-*` / `scratch-*` fixtures; a fresh export of real
 * sessions MUST NOT be added to git. See `.gitignore` and W881.
 *
 * EX-02 (ARCHITECTURE.md §5): the linear `main()` used to hold every step; it now
 * only orchestrates, and the steps live in `scripts/golden/`:
 *   - `probe.ts`  — the read-only endpoint snapshots + the passive SSE capture
 *   - `fetch.ts`  — session fixtures, SSE/registry/public views, `live/*`, the manifest
 *   - `redact.ts` — secret loading, leak scan, independent pattern audit
 *   - `write.ts`  — the single redacting writer + the write log
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRedactor } from "@celestea/core";
import { bool, num, parseArgs, str } from "./lib/args.js";
import { captureSse, takeSnapshots } from "./golden/probe.js";
import {
  buildManifest,
  collectSessionRows,
  exportSessions,
  writeLiveSnapshots,
  writePublicViews,
  writeRegistry,
  writeSseCapture,
} from "./golden/fetch.js";
import {
  assertNoLeaks,
  assertPatternClean,
  assertSecretsRegistered,
  loadSecrets,
  providersPathCandidates,
  suspiciousPatternIds,
} from "./golden/redact.js";
import { configureWriter, ensureDir, writeJson, writtenFiles } from "./golden/write.js";

const args = parseArgs(process.argv.slice(2));
const STUDIO = str(args, "studio", "http://127.0.0.1:3777");
const OUT = resolve(str(args, "out", "fixtures"));
const SSE_WINDOW_MS = num(args, "sse-window-ms", 6000);
/** Above this event count the derived per-session SSE transcript is omitted (it is regenerable from cli-main.jsonl). */
const MAX_DERIVED_SSE_EVENTS = num(args, "max-derived-sse-events", 200);
/**
 * The checkout root, derived from this file location by walking up to the
 * workspace marker (scripts/export-golden.ts sits under scripts/).
 *
 * B6-01: this REPLACED a hardcoded "/srv/celestea/studio", which existed on no
 * other checkout. Because the providers file was resolved relative to it, that
 * one wrong literal emptied the secret registry and turned redaction into a
 * verbatim copy. Deriving the root from the module location is stable under any
 * cwd and any rename of the checkout directory -- the same rule studio applies in
 * apps/studio/src/deployment.ts (studioRepoRoot).
 */
function scriptRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (; ; ) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

/**
 * B6-01: the checkout root, DERIVED from this file location instead of a
 * hardcoded /srv/celestea/studio. The literal was the P0: it did not exist on
 * any other checkout, and the providers file is looked up relative to it, so
 * the secret registry silently came back empty and every non-shape key was
 * exported verbatim. scripts/golden/redact.ts now walks up to the real
 * workspace marker and honours CELESTEA_PROVIDERS_FILE first.
 */
const STUDIO_REPO = str(args, "studio-repo", scriptRepoRoot());
const VERBOSE = bool(args, "verbose");

async function main(): Promise<void> {
  console.warn(
    "[export-golden] WARNING: real-session fixtures are PRIVATE and MUST NEVER be committed; only synthetic test-*/scratch-* fixtures may enter git.",
  );
  console.log(`[export-golden] studio=${STUDIO} out=${OUT}`);
  ensureDir(OUT);
  configureWriter({ outDir: OUT, verbose: VERBOSE });

  const loaded = loadSecrets(STUDIO_REPO);
  // B6-01: fail-closed. An empty registry is indistinguishable downstream from a
  // successful redaction -- the shape rules still fire, both gates still pass, and
  // the manifest still says "clean" -- so the count is checked BEFORE any byte is
  // written, not after.
  assertSecretsRegistered(loaded, providersPathCandidates({ studioRepo: STUDIO_REPO, env: process.env }));
  const { secrets, sources } = loaded;
  const redactor = createRedactor(secrets);
  console.log(`[export-golden] registered ${secrets.length} secret(s) from ${sources.length} source(s)`);

  // ---- 1. live read-only snapshots -----------------------------------------
  const snapshots = await takeSnapshots(STUDIO);

  // ---- 2. session fixtures -------------------------------------------------
  const { sessionList, pathByName } = collectSessionRows(snapshots.sessions.json, snapshots.workspaces.json);
  const metas = await exportSessions(redactor, STUDIO, sessionList, pathByName, MAX_DERIVED_SSE_EVENTS);
  const rolesSeen = new Set(metas.flatMap((m) => m.roles));

  // ---- 3. SSE live capture (passive) --------------------------------------
  const sseCapture = await captureSse(STUDIO, SSE_WINDOW_MS);
  writeSseCapture(redactor, STUDIO, SSE_WINDOW_MS, sseCapture);

  // ---- 4. registry.tsv ----------------------------------------------------
  const registryFiles = writeRegistry(redactor);

  // ---- 5. public views ----------------------------------------------------
  writePublicViews(redactor, STUDIO, STUDIO_REPO, snapshots);
  writeLiveSnapshots(redactor, STUDIO, snapshots);

  // ---- 6. manifest + leak verification ------------------------------------
  const report = redactor.report();
  const manifest = buildManifest({
    studio: STUDIO,
    studioRepo: STUDIO_REPO,
    sources,
    report,
    metas,
    sseCapture,
    registryFiles,
    outDir: OUT,
    writtenCount: writtenFiles().length,
  });
  writeJson(redactor, "index.json", manifest);

  // Final independent scan of every file on disk.
  assertNoLeaks(redactor, OUT);
  const audit = assertPatternClean(OUT);
  writeJson(redactor, "redaction-audit.json", {
    generatedAt: new Date().toISOString(),
    policy: "registered secrets + generic token shapes; every written file re-scanned",
    secretsRegistered: report.secretsRegistered,
    secretsDiscovered: report.secretsDiscovered ?? 0,
    replacements: report.replacements,
    byRule: report.byRule,
    suspiciousPatterns: suspiciousPatternIds(),
    findings: audit,
    verdict: audit.length === 0 ? "clean" : "LEAK",
  });

  console.log(
    `[export-golden] OK: ${metas.length} sessions, ${writtenFiles().length} files, ${report.replacements} redaction(s), 0 leaks`,
  );
  console.log(`[export-golden] roles covered: ${[...rolesSeen].sort().join(", ")}`);
}

main().catch((e: unknown) => {
  console.error(`[export-golden] FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});