/**
 * B6-08 · the grants credential screen must know the keys Studio actually stores.
 *
 * `knownSecretsOf()` read ONLY the env, while `collectKnownSecrets` has always
 * accepted a `providersJson` argument. Since the main form a Studio API key takes
 * is a row in `providers.json`, the screen missed exactly the secrets that matter
 * here: a grant scope of `/data/<real api_key>` was ACCEPTED and PERSISTED into
 * `grants.json` (0600 and an audit surface all the same) — violating the
 * guarantee the file states about itself ("a roots/hosts/tools value that LOOKS
 * like a credential is rejected … never echoed back").
 *
 * Pinned here:
 *   1. a key stored in `providers.json` makes a scope containing it REFUSED;
 *   2. an env key still works (the old behaviour must not regress);
 *   3. an ordinary absolute path is still accepted — the screen is a screen, not a
 *      blanket refusal (B6-08 also measured the false-positive side);
 *   4. a missing / corrupt providers file never throws and never widens.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { knownSecretsOf, looksLikeCredential, validateScope } from "./store/grants.js";

/** A data dir with a providers.json holding one api_key. */
function withProviders(apiKey: string): { env: NodeJS.ProcessEnv; root: string } {
  const root = mkdtempSync(join(tmpdir(), "b5-b608-"));
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "providers.json"),
    JSON.stringify({ version: 1, providers: [{ id: "p1", label: "p1", base_url: "https://x", api_key: apiKey, default: true }] }),
  );
  // The grants env is pinned to a workspaces file in the SAME dir (config.ts
  // derives the data dir from it), which is how knownSecretsOf finds providers.
  return { env: { CELESTEA_WORKSPACES_FILE: join(root, "workspaces.json") }, root };
}

describe("B6-08 · the credential screen knows providers.json", () => {
  it("a key in providers.json makes a scope containing it REFUSED", () => {
    const key = "MnA3bC7dE9fG1hI2jK4lM6nO8pQ0rS4tU6vW8xY0zA2bC4dE";
    const { env } = withProviders(key);
    const known = knownSecretsOf(env);
    expect(known, "the providers key must reach the known set").toContain(key);
    expect(looksLikeCredential("/data/" + key, known)).toBe(true);
    const v = validateScope("read_roots", { roots: ["/data/" + key] }, known);
    expect(v.ok, "a scope carrying a real api_key must be refused").toBe(false);
  });

  it("an EXPLICIT CELESTEA_PROVIDERS_FILE wins over the data dir", () => {
    const key = "sk-EXPLICITprovidersfile0123456789abcd";
    const other = mkdtempSync(join(tmpdir(), "b5-b608b-"));
    writeFileSync(join(other, "providers.json"), JSON.stringify({ providers: [{ api_key: key }] }));
    const env = { CELESTEA_PROVIDERS_FILE: join(other, "providers.json") };
    expect(knownSecretsOf(env)).toContain(key);
  });

  it("an env key still works (the pre-existing behaviour)", () => {
    const env = { ANTHROPIC_API_KEY: "sk-envSECRET0123456789ab" } as NodeJS.ProcessEnv;
    expect(looksLikeCredential("/x/sk-envSECRET0123456789ab", knownSecretsOf(env))).toBe(true);
  });

  it("an ordinary absolute path is still ACCEPTED (no blanket refusal)", () => {
    const { env } = withProviders("MnA3bC7dE9fG1hI2jK4lM6nO8pQ0rS4tU6vW8xY0zA2bC4dE");
    const known = knownSecretsOf(env);
    for (const ok of ["C:\\Users\\dev\\project", "/home/dev/project", "backend"]) {
      expect(validateScope("read_roots", { roots: [ok] }, known).ok, ok).toBe(true);
    }
  });

  it("a missing or corrupt providers file never throws and never widens", () => {
    const missing = { CELESTEA_PROVIDERS_FILE: join(mkdtempSync(join(tmpdir(), "b5-b608c-")), "nope.json") };
    expect(() => knownSecretsOf(missing)).not.toThrow();
    expect(knownSecretsOf(missing)).toEqual([]);
    const bad = mkdtempSync(join(tmpdir(), "b5-b608d-"));
    writeFileSync(join(bad, "providers.json"), "{ not json");
    expect(() => knownSecretsOf({ CELESTEA_PROVIDERS_FILE: join(bad, "providers.json") })).not.toThrow();
  });
});
