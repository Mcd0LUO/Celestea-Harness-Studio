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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectKnownSecrets, type Redactor } from "@celestea/core";
import { writtenFiles } from "./write.js";

/**
 * B6-01 (P0): where the exporter must look for the providers file.
 *
 * WHY THIS EXISTS. loadSecrets() used to build the path as
 * join(studioRepo, "providers.json"), with studioRepo defaulting to the
 * hardcoded /srv/celestea/studio. That is NOT where Studio reads its
 * providers: apps/studio/src/config.ts resolves
 * CELESTEA_PROVIDERS_FILE ?? resolve(cwd, "providers.json"). The two were
 * separate literals with nothing tying them together, so on every checkout
 * where the hardcoded path does not exist the secret registry came back EMPTY
 * and stayed empty, silently.
 *
 * An empty registry is not a weaker redaction, it is a DISABLED one: the rule
 * table in core only matches recognizable SHAPES (sk-/npm_/ghp_/AKIA/...), so a
 * vendor key with no distinctive prefix rode out of BOTH gates untouched -- the
 * redacted session log was byte-identical to the original, assertClean
 * reported CLEAN, and the independent pattern audit found nothing. The export
 * then wrote verdict "clean" over a file containing a live credential, in the
 * exact fixture tree its own header forbids committing.
 *
 * So resolution is now DERIVED, and the exporter and the server cannot drift:
 * the operator override first (the server honours exactly this name), then
 * every candidate under the repo root, then a refusal when none exists.
 */

/** The env var Studio reads for its providers file (see config.ts). */
export const ENV_PROVIDERS_FILE = "CELESTEA_PROVIDERS_FILE";

/** The workspace marker that identifies this repository root. */
const REPO_MARKER = "pnpm-workspace.yaml";

/** The only plaintext-key data file (contracts/data-files/index.json). */
const PROVIDERS_FILE = "providers.json";

/** Path inputs are injectable so a unit test never depends on the real cwd. */
export interface ProvidersPathInput {
  /** The --studio-repo argument. */
  studioRepo: string;
  env: NodeJS.ProcessEnv;
  /** Directory this module lives in; the repo root is derived by walking up. */
  moduleDir?: string;
  cwd?: string;
}

/** The checkout root: nearest ancestor holding pnpm-workspace.yaml, else null. */
function workspaceMarkerRoot(starts: readonly string[]): string | null {
  for (const start of starts) {
    for (let dir = start; ; ) {
      if (existsSync(join(dir, REPO_MARKER))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/**
 * Every place the providers file may legitimately live, in precedence order.
 * The first entry is the operator's own override, and it must win: a
 * deployment that moves the data dir cannot have its keys re-registered
 * from a stale copy sitting next to the source tree.
 */
export function providersPathCandidates(input: ProvidersPathInput): string[] {
  const override = input.env[ENV_PROVIDERS_FILE];
  const explicit = override !== undefined && override.trim() !== "" ? [override.trim()] : [];
  const moduleDir = input.moduleDir ?? dirname(fileURLToPath(import.meta.url));
  const cwd = input.cwd ?? process.cwd();
  const root = workspaceMarkerRoot([moduleDir, cwd]);
  const derived = root === null ? [] : [join(root, PROVIDERS_FILE), join(input.studioRepo, PROVIDERS_FILE)];
  return [...new Set([...explicit, ...derived])];
}

/** The one providers file this export must read, or null when none exists. */
export function resolveProvidersFile(input: ProvidersPathInput): string | null {
  return providersPathCandidates(input).find((p) => existsSync(p)) ?? null;
}

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
  /**
   * B6-01: the providers file that was actually read, or null when none was
   * found. Recorded so the caller can refuse an export that registered
   * nothing from it (fail-closed) instead of silently degrading.
   */
  providersFile: string | null;
}

/**
 * Collect every known secret from the READ-ONLY sources, and report which
 * providers file (if any) contributed them.
 *
 * B6-01: the providers path is DERIVED, never a bare join(studioRepo, ...).
 * The previous form silently produced an empty registry whenever the
 * hardcoded /srv/celestea/studio default did not exist, which turned
 * "redaction" into "copy verbatim" for any key without a recognizable shape.
 */
export function loadSecrets(
  studioRepo: string,
  env: NodeJS.ProcessEnv = process.env,
  paths: { moduleDir?: string; cwd?: string; npmrcPath?: string } = {},
): LoadedSecrets {
  const sources: string[] = [];
  let providersJson: unknown = undefined;
  const providersPath = resolveProvidersFile({ studioRepo, env, ...paths });
  if (providersPath !== null) {
    try {
      providersJson = JSON.parse(readFileSync(providersPath, "utf8")) as unknown;
      sources.push(`${providersPath} (read-only)`);
    } catch {
      /* a malformed providers.json must never break the export */
    }
  }
  let npmrc: string | undefined;
  // Injectable so a test never reads the real ~/.npmrc (which holds a live
  // registry token and would make the suite machine-dependent).
  const npmrcPath = paths.npmrcPath ?? join(homedir(), ".npmrc");
  if (existsSync(npmrcPath)) {
    npmrc = readFileSync(npmrcPath, "utf8");
    sources.push(`${npmrcPath} (_authToken)`);
  }
  const secrets = collectKnownSecrets({ providersJson, npmrc, env });
  if (env["CELESTEA_API_KEY"]) sources.push("env CELESTEA_API_KEY");
  return { secrets, sources, providersFile: providersPath };
}

/**
 * B6-01: the explicit opt-out for an export that genuinely has no credentials.
 */
export const ENV_ALLOW_NO_SECRETS = "CELESTEA_EXPORT_ALLOW_NO_SECRETS";

/**
 * B6-01: refuse an export whose secret registry is empty.
 *
 * Why fail-closed. An empty registry is indistinguishable, downstream, from
 * a successful redaction: the pattern rules still fire on sk-/npm_/AKIA
 * shapes, the gates still pass, and the manifest still says "clean". The only
 * thing that separates "nothing needed redacting" from "we never found the
 * keys" is this count -- so the count is what has to be checked.
 *
 * The refusal names every path that was searched, so a false alarm is
 * diagnosable from the message alone instead of by re-deriving the path chain.
 *
 * The opt-out is explicit and auditable: an operator exporting a synthetic
 * fixture set with no real providers sets CELESTEA_EXPORT_ALLOW_NO_SECRETS=1
 * instead of getting a silent pass by accident.
 *
 * @param loaded what loadSecrets() returned.
 * @param providersCandidates the paths that were searched (for the message).
 * @param env the environment (injectable for the test).
 * @throws when no secret was registered and the opt-out is not set.
 */
export function assertSecretsRegistered(
  loaded: LoadedSecrets,
  providersCandidates: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (loaded.secrets.length > 0) return;
  if (env[ENV_ALLOW_NO_SECRETS] === "1") return;
  const seen = loaded.sources.length === 0 ? "no source at all" : loaded.sources.join(", ");
  const msg = [
    "refusing to export: 0 known secret(s) registered, so redaction cannot be trusted.",
    "A key with no recognizable shape would reach the fixture verbatim while both",
    "gates report clean (B6-01).",
    " looked for: " + (providersCandidates.join(", ") || "(no candidate)"),
    " found: " + seen,
    " Set " + ENV_ALLOW_NO_SECRETS + "=1 only if this export really has no credentials.",
  ].join("\n");
  throw new Error(msg);
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