/**
 * B6-09 — the rule table covered the OpenAI/npm/GitHub/AWS prefixes and nothing else,
 * so every other vendor a real deployment might configure leaked through untouched
 * while assertClean reported CLEAN.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, MIN_SECRET_LEN, createRedactor } from "./redact.js";

function redacted(input: string): boolean {
  return createRedactor([]).redact(input) !== input;
}

describe("B6-09: the vendor prefixes that had no rule", () => {
  it("redacts each documented key format", () => {
    const cases: Array<[string, string]> = [
      ["google api key", "AIza" + "A".repeat(35)],
      ["slack bot token", "xoxb-" + "1".repeat(12) + "-" + "A".repeat(24)],
      ["gitlab PAT", "glpat-" + "A".repeat(16)],
      ["huggingface token", "hf_" + "A".repeat(34)],
      ["stripe live key", "sk_" + "live_" + "A".repeat(24)],
      ["stripe test key", "sk_" + "test_" + "A".repeat(24)],
      ["jwt", ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "c2lnbmF0dXJlMTIz"].join(".")],
    ];
    for (const [name, value] of cases) {
      expect(redacted(value), name).toBe(true);
      expect(createRedactor([]).redact(value), name).not.toContain(value);
    }
  });

  it("redacts a multi-line PEM private key whole", () => {
    // The highest-consequence entry: a leaked private key is long-lived, and a tool
    // that printed a key file into a session would store it verbatim in a fixture.
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAx7Vn2K9LpQrStUvWxYz1234abcdEFGH5678",
      "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const out = createRedactor([]).redact(pem);
    expect(out).not.toContain("MIIEowIBAAKCAQEAx7Vn2K9LpQrStUvWxYz1234abcdEFGH5678");
    expect(out).toContain("<REDACTED>");
  });

  it("covers the other PEM flavours, not just RSA", () => {
    const pems = [
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----",
      "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIBBBBB\n-----END EC PRIVATE KEY-----",
      "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBg\n-----END PRIVATE KEY-----",
      "-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----",
    ];
    for (const pem of pems) expect(redacted(pem), pem.slice(0, 34)).toBe(true);
  });

  it("the new rules do not eat ordinary text", () => {
    // Each prefix here is a real prefix; the test is that the SHAPE around it still
    // has to match (length, segment count), so prose cannot trip a rule.
    const keep = [
      "a normal sentence with words and punctuation.",
      "the file is called hf_report.txt and has 3 sections",
      "we use xoxb as a shorthand in the docs",
      "AIza is a prefix used by google",
      "the sk_live variable is empty in CI",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "base64data.eyJzdWIiOiIxIn0.sig",
      "-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----",
    ];
    for (const text of keep) {
      expect(redacted(text), text).toBe(false);
    }
  });

  it("every new rule is registered under a stable id", () => {
    const ids = DEFAULT_RULES.map((r) => r.id);
    const added = ["google-api-key","slack-token","gitlab-pat","huggingface-token","stripe-key","jwt","pem-private-key"];
    for (const id of added) {
      expect(ids, id).toContain(id);
    }
  });

  it("still redacts the prefixes that already worked (no rule was displaced)", () => {
    const cases = [
      "sk-" + "a".repeat(30),
      "npm_" + "a".repeat(36),
      "ghp_" + "A".repeat(36),
      "AKIA" + "0".repeat(16),
    ];
    for (const value of cases) expect(redacted(value), value.slice(0, 12)).toBe(true);
  });
});

describe("B6-10 (not changed, documented): the json-credential floor", () => {
  it("stays at 12, and the divergence from MIN_SECRET_LEN is deliberate", () => {
    // Measured, then left alone: redact-w824.test.ts's "keeps short
    // (non-credential) and non-credential JSON values intact" case pins a
    // 10-character token value as verbatim. Below 12 a value is more likely a
    // placeholder or a fixture marker than a live credential, so the floor is a
    // policy choice, not an oversight. This test records the decision so a future
    // change cannot move it.
    const short = JSON.stringify({ token: "short12345" });
    const long = JSON.stringify({ token: "longenough12" });
    expect(createRedactor([]).redact(short)).toBe(short);
    expect(createRedactor([]).redact(long)).toContain("<REDACTED>");
  });

  it("MIN_SECRET_LEN is exported and is 8 (the registered-secret floor)", () => {
    expect(MIN_SECRET_LEN).toBe(8);
  });
});
