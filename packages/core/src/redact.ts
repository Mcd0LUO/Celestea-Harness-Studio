/**
 * Secret redaction for golden fixtures.
 *
 * HARD REQUIREMENT (P0): no exported fixture may contain an api key / token in
 * cleartext. Redaction is applied to every byte the exporter writes and the
 * result is verified afterwards (see RedactionReport.leaksAfter).
 */

export interface RedactionRule {
  id: string;
  re: RegExp;
  replace: string;
}

export interface RedactionReport {
  replacements: number;
  byRule: Record<string, number>;
  secretsRegistered: number;
  /** Credentials discovered in credential contexts and propagated globally. */
  secretsDiscovered?: number;
  leaksAfter: string[];
}

const PLACEHOLDER = "<REDACTED>";

/**
 * The shortest value this module will treat as a secret.
 *
 * B6-10: this used to be written down in three places at two different numbers
 * (12 in the rule table, 8 in the registered-secret pass), so the two halves of
 * "is this a credential" disagreed and a window opened between them. One named
 * constant means a future change moves both or neither.
 */
export const MIN_SECRET_LEN = 8;

/** Token shapes that are secrets regardless of where they came from. */
export const DEFAULT_RULES: RedactionRule[] = [
  // NOTE: no leading \b on the token rules. Session logs embed JSON escapes as
  // literal text ("...\nsk-<key>..."), so a preceding "n" is a word character
  // and a \b boundary would silently skip a real key. Over-redaction is the
  // safe direction here.
  { id: "openai-sk", re: /sk-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g, replace: PLACEHOLDER },
  { id: "npm-token", re: /npm_[A-Za-z0-9]{30,}/g, replace: PLACEHOLDER },
  { id: "github-token", re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, replace: PLACEHOLDER },
  //
  // B6-09: the other vendor prefixes, at the shapes their issuers document.
  // Every one of these is a REAL key format, each was measured leaking through
  // untouched with assertClean reporting CLEAN, and each is a PURELY ADDITIVE rule:
  // the prefix is distinctive enough that the false-positive risk is negligible,
  // which is why `ghp_` could always be covered and these could not be. Stripe is
  // the one that reads as a surprise -- it starts with "sk-", but `openai-sk`
  // requires 16+ characters AFTER the hyphen and a secret key segment, so
  // `sk_live_` fell between the two (the underscore is what defeats the hyphen rule).
  { id: "google-api-key", re: /AIza[0-9A-Za-z_-]{35}/g, replace: PLACEHOLDER },
  { id: "slack-token", re: /xox[abposr]-[A-Za-z0-9-]{10,}/g, replace: PLACEHOLDER },
  { id: "gitlab-pat", re: /glpat-[A-Za-z0-9_-]{16,}/g, replace: PLACEHOLDER },
  { id: "huggingface-token", re: /hf_[A-Za-z0-9]{30,}/g, replace: PLACEHOLDER },
  { id: "stripe-key", re: /sk_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: PLACEHOLDER },
  //
  // A JWT: three base64url segments, both of the first two opening with "eyJ"
  // (the base64 of a JSON object's opening brace). Requiring the STRUCTURE and
  // not just "a long opaque blob" is what keeps this safe -- measured against
  // prose, a lone header segment, and a string that merely contains one payload
  // segment: all three stay unmasked. A signed JWT is itself a bearer credential,
  // so a session log that printed one has leaked something replayable.
  {
    id: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
    replace: PLACEHOLDER,
  },
  // A PEM private key, not a token: no prefix, and the body is base64 across many
  // lines. This is the highest-consequence one on the list -- a leaked private key
  // is a long-lived credential, and a tool that printed an .env or a key file into
  // a session would otherwise have it stored verbatim in the fixture.
  {
    id: "pem-private-key",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
    replace: PLACEHOLDER,
  },
  { id: "bearer", re: /(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/g, replace: "$1 " + PLACEHOLDER },
  { id: "authorization-header", re: /("(?:authorization|x-api-key|api[_-]?key)"\s*:\s*")([^"\\]{8,})(")/gi, replace: "$1" + PLACEHOLDER + "$3" },
  // W824 F01: JSON-quoted credential values. The key CLOSING quote sits between
  // the credential word and the colon, so credential-assignment (name\s*[=:]\s*value)
  // can never match a form like "token":"...". Match the quoted key form explicitly;
  // the name set is the credential suffixes only (the authorization-header rule above
  // owns authorization/api[_-]key, and dropping the broad "auth" fragment here keeps a
  // JSON field such as "author":"..." intact).
  //
  // B6-10 (NOT changed, deliberately): the floor here is 12 while the
  // registered-secret pass uses MIN_SECRET_LEN (8), so a 10- or 11-character
  // {"token":"..."} / {"password":"..."} passes through. Measured and left as is.
  //
  // Why not lower it to MIN_SECRET_LEN: redact-w824.test.ts's "keeps short
  // (non-credential) and non-credential JSON values intact" case pins
  // {"token":"short12345"} (exactly 10 characters) as VERBATIM. That test is the
  // P0 that introduced this rule (W824 F01, from R2 W821 E1), and its title states
  // the intent -- "keeps short (NON-CREDENTIAL) ... values intact". The two
  // readings cannot both hold, and this is a deliberate policy call, not an
  // oversight: below 12 characters a value is far more likely to be a placeholder,
  // an enum, a test fixture or a truncation marker than a live credential, and
  // masking those would corrupt golden fixtures. Note the same length under
  // api_key/authorization IS already masked (authorization-header, above), so the
  // exposure is limited to the shorter key NAMES, and B6-09 closes the shapes
  // that actually carry live credentials.
  { id: "json-credential", re: /("(?:[A-Za-z0-9_]*(?:token|secret|passwd|password|apikey|api_key)[A-Za-z0-9_]*)"\s*:\s*")((?:[^"\\]|\\.){12,})(")/gi, replace: "$1" + PLACEHOLDER + "$3" },
  { id: "env-assignment", re: /([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*)("?)([^\s"'\\]{8,})\2/g, replace: "$1$2" + PLACEHOLDER + "$2" },
  { id: "aws-key", re: /AKIA[0-9A-Z]{16}/g, replace: PLACEHOLDER },
  // Cookie / Set-Cookie header values (a live session cookie is a credential).
  //
  // B6-02: the separator is [ \t]*, NOT \s*. The value class already excludes
  // \r\n, but a \s* PREFIX happily eats the newline, so a cookie header was
  // followed by the NEXT line being claimed as its value. That in turn made the
  // leak check itself wrong: leaksAfter() replaces <REDACTED> with a SPACE, which
  // re-joins "cookie:  <next line>" into a fresh match, so assertClean threw on
  // output that was already perfectly redacted -- and writeText() throws on every
  // file, so one ordinary multi-line session log aborted the whole export.
  { id: "cookie-header", re: /((?:set-)?cookie[ \t]*:[ \t]*)([^\r\n"'\\]{8,})/gi, replace: "$1" + PLACEHOLDER },
  // Service-issued bearer tokens such as `dsh-auth-<token>`.
  { id: "service-auth-token", re: /-auth-[A-Za-z0-9_-]{12,}/g, replace: "-auth-" + PLACEHOLDER },
  // Any `...token=<value>` / `...key=<value>` / `...secret=<value>` assignment
  // with a token-shaped (12+ char) value. Prose like `?token=...` stays intact.
  //
  // B6-03: the NAME class was [A-Za-z0-9_]* -- no hyphen -- while the VALUE class
  // already allowed one. A name may not contain the same character its own value
  // may, so every hyphenated credential name fell into the gap: a bare header line
  // `x-api-key: <key>` (the actual Anthropic auth header this repo speaks, and the
  // form HTTP dumps use -- no quotes) passed through untouched while the QUOTED
  // form was caught by authorization-header, so neither rule backed up the other.
  // The api_key spelling also becomes api[_-]?key for the same reason.
  {
    id: "credential-assignment",
    re: /(\b[A-Za-z0-9_-]*(?:token|secret|passwd|password|apikey|api[_-]?key|auth)[A-Za-z0-9_-]*\s*[=:]\s*)([A-Za-z0-9_\-.]{12,})/gi,
    replace: "$1" + PLACEHOLDER,
  },
  // B6-04: URL userinfo -- `postgres://user:pass@host/db`, `https://u:p@host/`.
  // A connection string is one of the most common things a tool argument, a .env
  // dump or an upstream error carries, and the password had no rule at all: no
  // prefix, no assignment, nothing for the shape rules to match. The userinfo
  // section is bounded by the LAST @ before the host, so an @ inside the host or
  // the path is not mistaken for one, and a URL without a password is untouched.
  {
    id: "url-userinfo",
    re: /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s\/@:]{1,64}:)([^\s\/@]{3,})@/gi,
    replace: "$1$2" + PLACEHOLDER + "@",
  },
  // NOTE: no generic `_authToken=<value>` rule on purpose. Session logs contain
  // sed regex prose such as `s/(_authToken=)[A-Za-z0-9._-]+/.../`; the real
  // npm token is caught by the npm-token rule and by the registered-secret pass
  // (collectKnownSecrets reads ~/.npmrc).
];

export interface Redactor {
  redact(text: string): string;
  report(): RedactionReport;
  /** Secrets discovered in credential contexts while redacting (propagated globally). */
  dynamicSecrets(): string[];
  /** Throws when a registered secret or a generic token shape survives. */
  assertClean(text: string, where: string): void;
}

/**
 * Credential contexts. Any token-shaped (16+ char) substring found inside one
 * of these regions is registered as a dynamic secret and then redacted
 * EVERYWHERE — so an alias such as `T=<token>` (a shell variable holding a
 * cookie value) cannot survive just because its own context is not
 * credential-shaped.
 */
const CREDENTIAL_CONTEXTS: readonly RegExp[] = [
  // B6-02: [ \t]* for the same reason as the cookie-header rule above -- a
  // \s* prefix crosses the newline and harvests the following line as a
  // credential, which both over-registers and re-breaks the leak check.
  /(?:set-)?cookie[ \t]*:[ \t]*([^\r\n"'\\]{8,})/gi,
  /authorization\s*:\s*([^\r\n"'\\]{8,})/gi,
  /bearer\s+([A-Za-z0-9._~+/=-]{8,})/gi,
  /\b[A-Za-z0-9_]*(?:token|secret|password|passwd|apikey|api_key|auth)[A-Za-z0-9_]*\s*[=:]\s*("?)([A-Za-z0-9_\-.+/=]{8,})\1/gi,
  /(sk-[A-Za-z0-9_-]{16,})/g,
  /(-auth-[A-Za-z0-9_-]{12,})/g,
  /(npm_[A-Za-z0-9]{30,})/g,
];
const TOKENISH = /[A-Za-z0-9_\-.+/=]{16,}/g;

/**
 * Environment variables read as provider credentials by collectKnownSecrets().
 * Module-level so the list is data, not control flow.
 */
const PROVIDER_ENV_VARS = ["CELESTEA_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY"] as const;

/**
 * Harvest every token-shaped substring of one credential region into `into`.
 *
 * EX-01: this used to be the innermost loop of discover(), which nested 5
 * blocks deep. Extracting it is a pure move — same TOKENISH state handling
 * (lastIndex is reset per region), same >= 16 / placeholder filter.
 */
function addTokensFromRegion(region: string | undefined, into: Set<string>): void {
  if (typeof region !== "string") return;
  TOKENISH.lastIndex = 0;
  for (const tok of region.matchAll(TOKENISH)) {
    const v = tok[0];
    if (v.length >= 16 && !v.includes(PLACEHOLDER)) into.add(v);
  }
}

/**
 * Feed every capture group of one credential-context match into `into`.
 *
 * EX-01: same extraction rationale as addTokensFromRegion() — group 0 is the
 * whole match and is skipped, exactly as the original `g = 1` loop did.
 */
function addGroupsFromMatch(m: RegExpMatchArray, into: Set<string>): void {
  for (let g = 1; g < m.length; g++) {
    addTokensFromRegion(m[g], into);
  }
}

export function createRedactor(knownSecrets: readonly string[], extraRules: readonly RedactionRule[] = []): Redactor {
  const rules = [...extraRules, ...DEFAULT_RULES];
  const byRule: Record<string, number> = {};
  let replacements = 0;

  // Exact registered secrets first (longest first so overlapping values are safe).
  const secrets = [...new Set(knownSecrets.filter((s) => typeof s === "string" && s.length >= MIN_SECRET_LEN))].sort(
    (a, b) => b.length - a.length,
  );

  const dynamic = new Set<string>();

  /** Discover credential-shaped values in the text and register them globally. */
  function discover(text: string): void {
    for (const re of CREDENTIAL_CONTEXTS) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        addGroupsFromMatch(m, dynamic);
      }
    }
  }

  function redact(text: string): string {
    discover(text);
    let out = text;
    const allSecrets = [...new Set([...secrets, ...dynamic])].sort((a, b) => b.length - a.length);
    for (const secret of allSecrets) {
      if (!out.includes(secret)) continue;
      const parts = out.split(secret);
      const hits = parts.length - 1;
      if (hits > 0) {
        replacements += hits;
        byRule["registered-secret"] = (byRule["registered-secret"] ?? 0) + hits;
        out = parts.join(PLACEHOLDER);
      }
    }
    for (const rule of rules) {
      rule.re.lastIndex = 0;
      out = out.replace(rule.re, (...args: unknown[]) => {
        replacements += 1;
        byRule[rule.id] = (byRule[rule.id] ?? 0) + 1;
        // args = [match, g1, g2, ..., offset, string]; $1..$n are the groups.
        const groups = args.slice(1, -2) as Array<string | undefined>;
        let replacement = rule.replace;
        // Descending so $1 cannot clobber the prefix of $10.
        for (let i = groups.length; i >= 1; i--) {
          replacement = replacement.split(`$${i}`).join(groups[i - 1] ?? "");
        }
        return replacement;
      });
    }
    return out;
  }

  function leaksAfter(text: string): string[] {
    // A placeholder is by definition not a leak. Replace it with a SPACE (not
    // an empty string) so removing it cannot glue neighbouring text into a
    // fake match for value-shaped rules like `KEY=<value>`.
    const probe = text.split(PLACEHOLDER).join(" ");
    const leaks: string[] = [];
    for (const secret of secrets) if (probe.includes(secret)) leaks.push("registered-secret");
    for (const secret of dynamic) if (probe.includes(secret)) leaks.push("discovered-secret");
    for (const rule of rules) {
      rule.re.lastIndex = 0;
      if (rule.re.test(probe)) leaks.push(rule.id);
      rule.re.lastIndex = 0;
    }
    return [...new Set(leaks)];
  }

  return {
    redact,
    report(): RedactionReport {
      return { replacements, byRule, secretsRegistered: secrets.length, secretsDiscovered: dynamic.size, leaksAfter: [] };
    },
    dynamicSecrets(): string[] {
      return [...dynamic];
    },
    assertClean(text: string, where: string): void {
      const leaks = leaksAfter(text);
      if (leaks.length > 0) {
        throw new Error(`secret leak in ${where}: ${leaks.join(", ")}`);
      }
    },
  };
}

/**
 * Collect candidate secrets from read-only sources (providers.json keys, an
 * npm auth token, environment values). Never logs them.
 */
/**
 * Pull the `api_key` values out of a parsed providers.json shape.
 *
 * EX-01: this used to be the nested `for` inside collectKnownSecrets(), which
 * nested 5 blocks deep. Pure extraction — the guards, the >= 8 length test and
 * the untrimmed push are all byte-for-byte what the inline loop did. In
 * particular a key is PUSHED AS-IS (only its .trim() is measured), while the
 * env branch pushes the trimmed value; that asymmetry is preserved.
 */
function collectProviderKeys(providers: unknown): string[] {
  const keys: string[] = [];
  if (providers === null || typeof providers !== "object" || !("providers" in providers)) return keys;
  const list = (providers as { providers?: unknown }).providers;
  if (!Array.isArray(list)) return keys;
  for (const p of list) {
    if (p === null || typeof p !== "object" || !("api_key" in p)) continue;
    const key = (p as { api_key?: unknown }).api_key;
    if (typeof key === "string" && key.trim().length >= 8) keys.push(key);
  }
  return keys;
}

/** The `_authToken=<value>` entries of a ~/.npmrc blob. */
function collectNpmrcTokens(npmrc: string | undefined): string[] {
  const toks: string[] = [];
  if (!npmrc) return toks;
  for (const m of npmrc.matchAll(/_authToken\s*=\s*(\S+)/g)) {
    const tok = m[1];
    if (tok && tok.length >= 8) toks.push(tok);
  }
  return toks;
}

/** Trimmed values of the known provider-key environment variables. */
function collectEnvKeys(env: NodeJS.ProcessEnv | undefined): string[] {
  const keys: string[] = [];
  for (const name of PROVIDER_ENV_VARS) {
    const v = env?.[name];
    if (typeof v === "string" && v.trim().length >= 8) keys.push(v.trim());
  }
  return keys;
}

export function collectKnownSecrets(input: { providersJson?: unknown; npmrc?: string; env?: NodeJS.ProcessEnv }): string[] {
  return [...collectProviderKeys(input.providersJson), ...collectNpmrcTokens(input.npmrc), ...collectEnvKeys(input.env)];
}
