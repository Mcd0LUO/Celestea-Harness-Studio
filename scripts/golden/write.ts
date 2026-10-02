/**
 * Golden-fixture writer primitives (EX-02 split, part 4/4).
 *
 * Every byte this exporter writes goes through here so there is exactly one
 * place that (a) runs the redactor, (b) asserts the result is clean,
 * (c) records the sha256 that later feeds the manifest and the final leak scan.
 *
 * Pure move: the bodies are the ones that used to live in
 * `scripts/export-golden.ts`; only the surrounding module changed.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Redactor } from "@celestea/core";

export interface FileRecord {
  bytes: number;
  sha256: string;
}

/** Every file written by this run, in write order; the manifest and the audit both replay it. */
const written: Array<{ path: string; bytes: number; sha256: string }> = [];

/** Resolved by the entry module; the writer needs the same absolute root the caller used. */
let outDir = "";
let verbose = false;

/** Wire the writer to this run's output root / verbosity (called once by the entry module). */
export function configureWriter(opts: { outDir: string; verbose: boolean }): void {
  outDir = opts.outDir;
  verbose = opts.verbose;
}

/** The write log, in the exact order the files were produced. */
export function writtenFiles(): ReadonlyArray<{ path: string; bytes: number; sha256: string }> {
  return written;
}

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

export function slugify(s: string): string {
  // Keep unicode letters (session dirs are often CJK) but drop separators.
  return s.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "session";
}

export function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

export function writeText(redactor: Redactor, relPath: string, text: string): FileRecord {
  const redacted = redactor.redact(text);
  redactor.assertClean(redacted, relPath);
  const abs = join(outDir, relPath);
  ensureDir(dirname(abs));
  writeFileSync(abs, redacted, "utf8");
  const rec = { path: relPath, bytes: Buffer.byteLength(redacted), sha256: sha256(redacted) };
  written.push(rec);
  if (verbose) console.log(`  wrote ${relPath} (${rec.bytes} B)`);
  return { bytes: rec.bytes, sha256: rec.sha256 };
}

export function writeJson(redactor: Redactor, relPath: string, value: unknown): FileRecord {
  const text = JSON.stringify(value, null, 2) + "\n";
  const rec = writeText(redactor, relPath, text);
  // A redacted JSON file must still be valid JSON.
  JSON.parse(readFileSync(join(outDir, relPath), "utf8"));
  return rec;
}