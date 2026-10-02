/**
 * Behavior-equivalence golden for redact.ts (EX-01 refactor: extract helpers,
 * drop max-depth to <= 4).
 *
 * Every expected value below was captured by RUNNING the PRE-refactor code
 * (a console.log probe on the original discover()/collectKnownSecrets()).
 * They are byte-exact outputs of the original implementation, so if the
 * refactor changed any output text, replacement count, byRule tally,
 * discovered-secret set, or collected-secret list, these will go red.
 */
import { describe, expect, it } from "vitest";
import { collectKnownSecrets, createRedactor } from "./redact.js";

describe("redact: same input -> same output (pre/post EX-01 refactor)", () => {
  it("registered secret + token shapes: output and report identical", () => {
    const g = "sk-abcdefghijklmnopqrstuvwxyz012345";
    const r = createRedactor([g]);
    const input = `key=${g} bearer=Bearer ${g} npm=npm_${"a".repeat(36)}`;
    expect(r.redact(input)).toBe("key=<REDACTED> bearer=Bearer <REDACTED> npm=<REDACTED>");
    expect(r.report()).toEqual({
      replacements: 3,
      byRule: { "registered-secret": 3 },
      secretsRegistered: 1,
      secretsDiscovered: 2,
      leaksAfter: [],
    });
  });

  it("JSON authorization/api_key header values: output and report identical", () => {
    const r = createRedactor([]);
    const out = r.redact('{"Authorization":"Bearer abcdefghijklmnop","api_key":"sk-1234567890abcdefgh"}');
    expect(out).toBe('{"Authorization":"<REDACTED>","api_key":"<REDACTED>"}');
    expect(r.report()).toEqual({
      replacements: 4,
      byRule: { "registered-secret": 2, "authorization-header": 2 },
      secretsRegistered: 0,
      secretsDiscovered: 2,
      leaksAfter: [],
    });
  });

  it("credential-context discovery (Set-Cookie -> alias T=...): identical", () => {
    const r = createRedactor([]);
    const out = r.redact("Set-Cookie: session=abcdefghijklmnopqr; T=abcdefghijklmnopqr");
    expect(out).toBe("Set-Cookie: <REDACTED>");
    expect(r.dynamicSecrets()).toEqual(["session=abcdefghijklmnopqr", "T=abcdefghijklmnopqr"]);
    expect(r.report()).toEqual({
      replacements: 3,
      byRule: { "registered-secret": 2, "cookie-header": 1 },
      secretsRegistered: 0,
      secretsDiscovered: 2,
      leaksAfter: [],
    });
  });

  it("aws-key rule: two AKIA keys both redacted, tally identical", () => {
    const r = createRedactor([]);
    expect(r.redact("AKIA0123456789ABCDEF and AKIA9876543210FEDCBA")).toBe("<REDACTED> and <REDACTED>");
    expect(r.report()).toEqual({
      replacements: 2,
      byRule: { "aws-key": 2 },
      secretsRegistered: 0,
      secretsDiscovered: 0,
      leaksAfter: [],
    });
  });

  it("collectKnownSecrets: order + trimming identical (providers, npmrc, env)", () => {
    const found = collectKnownSecrets({
      providersJson: { providers: [{ api_key: "sk-providerkey0123456789" }, { api_key: "" }, { name: "x" }] },
      npmrc: "_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789",
      env: { CELESTEA_API_KEY: "sk-fromenv0123456789abcdef", OPENAI_API_KEY: "  sk-openai-pad-0123456789  ", SHORT: "abc" },
    });
    // providers keep the raw value; env values are trimmed; empty/short/missing skipped.
    expect(found).toEqual([
      "sk-providerkey0123456789",
      "npm_abcdefghijklmnopqrstuvwxyz0123456789",
      "sk-fromenv0123456789abcdef",
      "sk-openai-pad-0123456789",
    ]);
  });

  it("collectKnownSecrets: non-array providers / empty npmrc / undefined env -> []", () => {
    expect(collectKnownSecrets({ providersJson: { providers: "notarray" }, npmrc: "", env: undefined })).toEqual([]);
    expect(collectKnownSecrets({})).toEqual([]);
  });
});