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

import { resolve } from "node:path";
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
import { assertNoLeaks, assertPatternClean, loadSecrets, suspiciousPatternIds } from "./golden/redact.js";
import { configureWriter, ensureDir, writeJson, writtenFiles } from "./golden/write.js";

const args = parseArgs(process.argv.slice(2));
const STUDIO = str(args, "studio", "http://127.0.0.1:3777");
const OUT = resolve(str(args, "out", "fixtures"));
const SSE_WINDOW_MS = num(args, "sse-window-ms", 6000);
/** Above this event count the derived per-session SSE transcript is omitted (it is regenerable from cli-main.jsonl). */
const MAX_DERIVED_SSE_EVENTS = num(args, "max-derived-sse-events", 200);
const STUDIO_REPO = str(args, "studio-repo", "/srv/celestea/studio");
const VERBOSE = bool(args, "verbose");

async function main(): Promise<void> {
  console.warn(
    "[export-golden] WARNING: real-session fixtures are PRIVATE and MUST NEVER be committed; only synthetic test-*/scratch-* fixtures may enter git.",
  );
  console.log(`[export-golden] studio=${STUDIO} out=${OUT}`);
  ensureDir(OUT);
  configureWriter({ outDir: OUT, verbose: VERBOSE });

  const { secrets, sources } = loadSecrets(STUDIO_REPO);
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