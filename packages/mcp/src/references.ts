/**
 * Credential REFERENCES — the only way a secret reaches an MCP server
 * (docs/feature/mcp-client.md §7.2, decision D3).
 *
 * `env` / `headers` values may contain `$VAR` / `${VAR}` references that are
 * resolved from the PROCESS environment at load time. Two consequences this
 * module exists to guarantee:
 *
 *   1. **A missing reference fails LOUDLY.** The server is skipped and the issue
 *      says which NAME is missing — never "connect with an empty string", which
 *      would look like an auth failure three layers down.
 *   2. **Values are never echoed.** Errors and status lines carry variable NAMES
 *      only. The same rule is why this file can stay 0644 and why the
 *      "providers.json is the only secret-bearing data file" assertion holds.
 *
 * Scope note: P0 resolves environment references ONLY. The design also sketches a
 * key-file form; it is not implemented, and a value shaped like one (`$FILE:…`)
 * is reported as an unsupported reference rather than being silently treated as
 * text.
 */

/** `$$` escapes a literal dollar; `${NAME}` and `$NAME` are references. */
function referencePattern(): RegExp {
  return /\$(?:\$|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;
}

export type ReferenceResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly missing: readonly string[]; readonly invalid: boolean };

/** `true` when the value contains at least one `$…` reference. */
export function hasReference(value: string): boolean {
  return value.includes("$");
}

/**
 * Resolve every reference in one value.
 *
 * A bare `"$VAR"` yields the variable's value VERBATIM (no stringification of an
 * empty string, no trimming); an embedded reference is interpolated, which is what
 * makes `"Bearer $TOKEN"` work.
 */
export function resolveReferences(value: string, env: Readonly<Record<string, string | undefined>>): ReferenceResult {
  if (!value.includes("$")) return { ok: true, value };
  const missing = new Set<string>();
  let invalid = false;
  let lastIndex = 0;
  let out = "";
  const reference = referencePattern();
  for (let m = reference.exec(value); m !== null; m = reference.exec(value)) {
    // Anything between matches must not contain a bare '$': a lone '$' or '$1' is
    // a malformed reference, not a literal we may pass through to the server.
    const gap = value.slice(lastIndex, m.index);
    if (gap.includes("$")) invalid = true;
    out += gap;
    lastIndex = m.index + m[0].length;
    if (m[0] === "$$") {
      out += "$";
      continue;
    }
    const name = m[1] ?? m[2];
    if (name === undefined) {
      invalid = true;
      continue;
    }
    const found = env[name];
    if (found === undefined) missing.add(name);
    else out += found;
  }
  const tail = value.slice(lastIndex);
  if (tail.includes("$")) invalid = true;
  if (missing.size > 0) return { ok: false, missing: [...missing], invalid };
  if (invalid) return { ok: false, missing: [], invalid: true };
  return { ok: true, value: out + tail };
}

/** Resolve every entry of a string map; reports names only, never values. */
export function resolveReferenceMap(
  input: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string | undefined>>,
): { readonly ok: true; readonly value: Readonly<Record<string, string>> } | { readonly ok: false; readonly missing: readonly string[]; readonly invalid: boolean } {
  const missing = new Set<string>();
  let invalid = false;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(input)) {
    const result = resolveReferences(raw, env);
    if (result.ok) out[key] = result.value;
    else {
      invalid = invalid || result.invalid;
      for (const name of result.missing) missing.add(name);
    }
  }
  if (missing.size > 0) return { ok: false, missing: [...missing], invalid };
  if (invalid) return { ok: false, missing: [], invalid: true };
  return { ok: true, value: out };
}