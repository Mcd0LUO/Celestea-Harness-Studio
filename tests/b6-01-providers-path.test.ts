import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRedactor } from "@celestea/core";
import {
  ENV_ALLOW_NO_SECRETS,
  ENV_PROVIDERS_FILE,
  assertSecretsRegistered,
  loadSecrets,
  providersPathCandidates,
  resolveProvidersFile,
  type LoadedSecrets,
} from "../scripts/golden/redact.js";

/**
 * A credential with NO recognizable shape -- the case that made B6-01 a P0.
 *
 * Every rule in core DEFAULT_RULES matches a vendor PREFIX (sk-, npm_, ghp_,
 * AKIA). A real deployment stores whatever its provider issued, so a key like this
 * is a normal thing for providers.json to hold, and it is invisible to every
 * pattern rule. Only the REGISTERED-secret pass can catch it, which is exactly
 * the pass that the wrong providers path emptied.
 */
const SHAPELESS_KEY = "MnA3bC7dE9fG1hI2jK4lM6nO8pQ0rS4tU6vW8xY0zA2bC4dE";

/** A repo-root stand-in: the marker is what makes a directory a workspace root. */
function makeWorkspace(): string {
  const r = mkdtempSync(join(tmpdir(), "b6-providers-"));
  writeFileSync(join(r, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
  mkdirSync(join(r, "scripts", "golden"), { recursive: true });
  return r;
}

/** Write a providers.json holding one shapeless key. */
function plantProviders(dir: string, key: string = SHAPELESS_KEY): string {
  const file = join(dir, "providers.json");
  writeFileSync(
    file,
    JSON.stringify({
      providers: [
        {
          id: "vendor",
          name: "Vendor",
          note: "",
          base_url: "https://api.vendor.example",
          request_format: "chat_completions",
          api_key: key,
          models: [],
        },
      ],
      default_model: null,
    }),
    "utf8",
  );
  return file;
}

/** The realistic sink: an upstream 401 echoing the key back, in a session log. */
function sessionLogLine(key: string): string {
  return JSON.stringify({ kind: "error", message: "401 invalid api key: " + key });
}

let root = "";
const studioRepoArg = "/srv/celestea/studio";
const moduleDir = (): string => join(root, "scripts", "golden");
/**
 * A hermetic loadSecrets: the temp workspace is the root, and npmrcPath points
 * at a file that cannot exist so the machine real ~/.npmrc (which holds a live
 * registry token) never leaks into the suite and make it machine-dependent.
 */
const NO_NPMRC = join(root, "no-such-npmrc");
const load = (env: NodeJS.ProcessEnv = {}): LoadedSecrets =>
  loadSecrets(studioRepoArg, env, { moduleDir: moduleDir(), cwd: root, npmrcPath: NO_NPMRC });

beforeEach(() => {
  root = makeWorkspace();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("B6-01: the providers path is derived, not a bare join(studioRepo, ...)", () => {
  it("finds the repo-root providers.json even when --studio-repo points elsewhere", () => {
    const planted = plantProviders(root);
    const found = resolveProvidersFile({ studioRepo: studioRepoArg, env: {}, moduleDir: moduleDir(), cwd: root });
    expect(found).toBe(planted);
  });

  it("registers a shapeless key from the repo-root file (the P0 itself)", () => {
    plantProviders(root);
    const loaded = load();
    expect(loaded.providersFile).toBe(join(root, "providers.json"));
    expect(loaded.secrets).toContain(SHAPELESS_KEY);
  });

  it("redacts the key out of a session-log line that echoes it", () => {
    plantProviders(root);
    const { secrets } = load();
    const out = createRedactor(secrets).redact(sessionLogLine(SHAPELESS_KEY));
    expect(out).not.toContain(SHAPELESS_KEY);
    expect(out).toContain("<REDACTED>");
  });

  it("lets CELESTEA_PROVIDERS_FILE win over the repo-root copy (operator override)", () => {
    plantProviders(root);
    const moved = join(root, "data", "providers.json");
    mkdirSync(dirname(moved), { recursive: true });
    const other = "QqWwEeRrTtYyUuIiOoPpAaSsDdFfGgHhJjKkLl";
    writeFileSync(moved, JSON.stringify({ providers: [{ id: "v", api_key: other }] }), "utf8");
    const env: NodeJS.ProcessEnv = { [ENV_PROVIDERS_FILE]: moved };
    const loaded = load(env);
    expect(loaded.providersFile).toBe(moved);
    expect(loaded.secrets).toContain(other);
    expect(loaded.secrets).not.toContain(SHAPELESS_KEY);
  });

  it("reports null rather than a bogus path when no providers file exists", () => {
    const found = resolveProvidersFile({ studioRepo: studioRepoArg, env: {}, moduleDir: moduleDir(), cwd: root });
    expect(found).toBeNull();
  });

  it("lists the operator override first among the candidates", () => {
    const explicit = join(root, "only-here.json");
    const candidates = providersPathCandidates({
      studioRepo: studioRepoArg,
      env: { [ENV_PROVIDERS_FILE]: explicit },
      moduleDir: moduleDir(),
      cwd: root,
    });
    expect(candidates[0]).toBe(explicit);
  });

  it("ignores a blank override instead of resolving an empty path", () => {
    plantProviders(root);
    const loaded = load({ [ENV_PROVIDERS_FILE]: "   " });
    expect(loaded.providersFile).toBe(join(root, "providers.json"));
  });
});

describe("B6-01: fail-closed when the registry is empty", () => {
  const empty = (): LoadedSecrets => ({ secrets: [], sources: [], providersFile: null });

  it("refuses when 0 secrets were registered (this is the silent-leak case)", () => {
    expect(() => assertSecretsRegistered(empty(), ["/nope/providers.json"], {})).toThrow(/0 known secret\(s\) registered/);
  });

  it("names every path it searched, so the refusal is diagnosable from the message", () => {
    let message = "";
    try {
      assertSecretsRegistered(empty(), ["/a/providers.json", "/b/providers.json"], {});
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("/a/providers.json");
    expect(message).toContain("/b/providers.json");
  });

  it("passes once at least one secret is registered", () => {
    const loaded: LoadedSecrets = { secrets: [SHAPELESS_KEY], sources: ["x"], providersFile: "y" };
    expect(() => assertSecretsRegistered(loaded, [], {})).not.toThrow();
  });

  it("honours the explicit opt-out for a credential-free export", () => {
    expect(() => assertSecretsRegistered(empty(), [], { [ENV_ALLOW_NO_SECRETS]: "1" })).not.toThrow();
  });

  it("still refuses the opt-out value 0 (only the exact string 1 is consent)", () => {
    expect(() => assertSecretsRegistered(empty(), [], { [ENV_ALLOW_NO_SECRETS]: "0" })).toThrow();
  });

  it("end to end: a repo with no providers file refuses instead of exporting", () => {
    const loaded = load();
    expect(loaded.secrets).toEqual([]);
    const candidates = providersPathCandidates({ studioRepo: studioRepoArg, env: {}, moduleDir: moduleDir(), cwd: root });
    expect(() => assertSecretsRegistered(loaded, candidates, {})).toThrow(/refusing to export/);
  });

  it("control: an empty registry cannot redact a shapeless key, and no rule notices", () => {
    // The historical behaviour kept as an explicit control. If a future change
    // made the SHAPE rules catch this, this test is the one to revisit.
    const withRegistry = createRedactor([SHAPELESS_KEY]).redact(sessionLogLine(SHAPELESS_KEY));
    const withoutRegistry = createRedactor([]).redact(sessionLogLine(SHAPELESS_KEY));
    expect(withRegistry).not.toContain(SHAPELESS_KEY);
    expect(withoutRegistry).toContain(SHAPELESS_KEY);
  });
});
