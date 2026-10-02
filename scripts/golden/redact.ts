/**
 * Redaction & leak verification for the golden exporter (EX-02 split, part 3/4).
 *
 * Two independent gates live here:
 *   1. a scan of every written file against the redactor's own registered +
 *      dynamically discovered secrets (`assertClean`), and
 *   2. a pattern audit that does not trust the redactor at all (SUSPICIOUS).
 *
 * Pure move: the rule table that used to be a local inside main() is hoisted to
 * module level verbatim (ARCHITECTURE.md §4.2 paradigm 2: data-table extraction).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { collectKnownSecrets, type Redactor } from "@celestea/core";
import { writtenFiles } from "./write.js";

/** Independent, pattern-based audit shapes (does not rely on the redactor itself). */
const SUSPICIOUS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "sk-token", re: /sk-[A-Za-z0-9_-]{12,}/ },
  { id: "npm-token", re: /npm_[A-Za-z0-9]{20,}/ },
  { id: "github-token", re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/ },
  { id: "auth-token", re: /_authToken\s*=\s*[A-Za-z0-9_-]{16,}/ },
  { id: "bearer-token", re: /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/ },
  { id: "aws-key", re: /AKIA[0-9A-Z]{16}/ },
  { id: "cookie-value", re: /(?:set-)?cookie\s*:\s*(?!<REDACTED>)[^\r\n"'\\]{8,}/i },
  { id: "token-assignment", re: /\b[A-Za-z0-9_]*token\s*[=:]\s*[A-Za-z0-9_\-.]{12,}/i },
  { id: "service-auth-token", re: /-auth-[A-Za-z0-9_-]{12,}/ },
];

export interface LoadedSecrets {
  secrets: string[];
  sources: string[];
}

export function loadSecrets(studioRepo: string): LoadedSecrets {
  const sources: string[] = [];
  let providersJson: unknown = undefined;
  const providersPath = join(studioRepo, "providers.json");
  if (existsSync(providersPath)) {
    try {
      providersJson = JSON.parse(readFileSync(providersPath, "utf8")) as unknown;
      sources.push(`${providersPath} (read-only)`);
    } catch {
      /* a malformed providers.json must never break the export */
    }
  }
  let npmrc: string | undefined;
  const npmrcPath = join(homedir(), ".npmrc");
  if (existsSync(npmrcPath)) {
    npmrc = readFileSync(npmrcPath, "utf8");
    sources.push(`${npmrcPath} (_authToken)`);
  }
  const secrets = collectKnownSecrets({ providersJson, npmrc, env: process.env });
  if (process.env["CELESTEA_API_KEY"]) sources.push("env CELESTEA_API_KEY");
  return { secrets, sources };
}

/** Final independent scan of every file on disk (redactor + dynamically discovered secrets). */
export function assertNoLeaks(redactor: Redactor, outDir: string): void {
  const leaks: string[] = [];
  const discovered = redactor.dynamicSecrets();
  for (const w of writtenFiles()) {
    const text = readFileSync(join(outDir, w.path), "utf8");
    try {
      redactor.assertClean(text, w.path);
    } catch (e) {
      leaks.push(`${w.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const secret of discovered) {
      if (text.includes(secret)) leaks.push(`${w.path}: discovered credential survives`);
    }
  }
  if (leaks.length > 0) throw new Error(`SECRET LEAK:\n${leaks.join("\n")}`);
}

export interface AuditFinding {
  file: string;
  pattern: string;
}

/** Pattern audit over every written file; throws when anything matches. */
export function assertPatternClean(outDir: string): AuditFinding[] {
  const audit: AuditFinding[] = [];
  for (const w of writtenFiles()) {
    const text = readFileSync(join(outDir, w.path), "utf8").split("<REDACTED>").join(" ");
    for (const pat of SUSPICIOUS) if (pat.re.test(text)) audit.push({ file: w.path, pattern: pat.id });
  }
  if (audit.length > 0) {
    throw new Error(`SECRET AUDIT FAILED:\n${audit.map((a) => `  ${a.file}: ${a.pattern}`).join("\n")}`);
  }
  return audit;
}

/** The id list recorded in redaction-audit.json (stable order = SUSPICIOUS order). */
export function suspiciousPatternIds(): string[] {
  return SUSPICIOUS.map((p) => p.id);
}