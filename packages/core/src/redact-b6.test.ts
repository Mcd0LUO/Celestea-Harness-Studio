/**
 * B6-02 / B6-03 / B6-04 — rule-table gaps found in the round-3 cross audit (B6).
 *
 * Each case below reproduces a defect that was measured BEFORE the fix, with
 * the exact observed output recorded in the comment beside it. None of these
 * failed loudly: B6-02 made the leak check throw on correctly-redacted text, and
 * B6-03/B6-04 let credentials through while every gate still reported CLEAN.
 */
import { describe, expect, it } from "vitest";
import { createRedactor } from "@celestea/core";

/** Redact then run the leak gate; returns both outcomes. */
function run(input: string): { out: string; gate: "clean" | string } {
  const r = createRedactor([]);
  const out = r.redact(input);
  try {
    r.assertClean(out, "probe");
    return { out, gate: "clean" };
  } catch (e) {
    return { out, gate: e instanceof Error ? e.message : String(e) };
  }
}

describe("B6-02: the cookie separator must not cross a newline", () => {
  it("a cookie header followed by ordinary prose passes the gate", () => {
    // BEFORE: gate: THROW secret leak in ...: cookie-header
    const { out, gate } = run("Cookie: AAAAAAAAAAAAAAAAAAAAAA\nnext line of prose here");
    expect(out).toBe("Cookie: <REDACTED>\nnext line of prose here");
    expect(gate).toBe("clean");
  });

  it("a cookie value never swallows the next line (cookie-header)", () => {
    const cases: Array<[string, string]> = [
      ["Cookie: abcdefghij12345678\nT=AAAAAAAAAAAAAAAAAAAA", "Cookie: <REDACTED>\nT=AAAAAAAAAAAAAAAAAAAA"],
      ["Set-Cookie: sessionvalue123456\napi_key=abcdefghijklmno", "Set-Cookie: <REDACTED>\napi_key=<REDACTED>"],
      ["cookie: abcdefghij12345678\n# another comment line with text", "cookie: <REDACTED>\n# another comment line with text"],
    ];
    for (const [input, expected] of cases) {
      const { out, gate } = run(input);
      expect(out, input).toBe(expected);
      expect(gate, input).toBe("clean");
    }
  });

  it("still redacts a real cookie value on its own line", () => {
    const { out, gate } = run("Cookie: AAAAAAAAAAAAAAAAAAAAAA");
    expect(out).toBe("Cookie: <REDACTED>");
    expect(gate).toBe("clean");
  });

  it("still redacts a cookie value that follows spaces or a tab", () => {
    expect(run("Cookie:    AAAAAAAAAAAAAAAAAAAAAA").out).toBe("Cookie:    <REDACTED>");
    expect(run("Cookie:\tAAAAAAAAAAAAAAAAAAAAAA").out).toBe("Cookie:\t<REDACTED>");
  });

  it("the CREDENTIAL_CONTEXTS pass does not harvest the next line either", () => {
    // The discovery pass feeds assertClean via dynamicSecrets(); a \s* prefix
    // here would register the following line as a credential and redact it.
    const r = createRedactor([]);
    r.redact("Cookie: AAAAAAAAAAAAAAAAAAAAAA\nnext line of prose here");
    expect(r.dynamicSecrets()).toEqual(["AAAAAAAAAAAAAAAAAAAAAA"]);
  });
});

describe("B6-03: a credential name may contain the hyphen its value may", () => {
  it("redacts a bare x-api-key header line (the Anthropic auth header)", () => {
    // BEFORE: out: "x-api-key: abcdefghijklmnop123456"  gate: CLEAN  (silent leak)
    const { out, gate } = run("x-api-key: abcdefghijklmnop123456");
    expect(out).toBe("x-api-key: <REDACTED>");
    expect(gate).toBe("clean");
  });

  it("redacts every hyphenated spelling of the credential names", () => {
    const names = ["x-api-key", "api-key", "x-auth-token", "auth-token", "x-token", "x-secret", "x-password"];
    for (const name of names) {
      const { out } = run(name + ": abcdefghijklmnop1234567890");
      expect(out, name).toBe(name + ": <REDACTED>");
    }
  });

  it("still redacts the underscore and bare spellings (no regression)", () => {
    expect(run("api_key: abcdefghijklmnop1234567890").out).toBe("api_key: <REDACTED>");
    expect(run("api_key=abcdefghijklmnop1234567890").out).toBe("api_key=<REDACTED>");
  });

  it("the hyphen does not turn ordinary hyphenated words into credentials", () => {
    // Measured BEFORE the fix and unchanged AFTER it: the over-redaction of a
    // name that merely ENDS in a credential word with a token-shaped value is
    // pre-existing (the name class already allowed the bare word), not something
    // the hyphen introduced. Kept as a standing characterization so a future
    // change cannot quietly widen it -- the module header calls over-redaction
    // "the safe direction".
    expect(run("tokenizer: nltk-tokenizer-v2").out).toBe("tokenizer: <REDACTED>");
    // ...while a name that does NOT contain a credential word, or a value that is
    // not token-shaped, is genuinely untouched.
    const keep = ["author: some human wrote this", "secretary: meeting notes", "tokenizer: short"];
    for (const text of keep) expect(run(text).out, text).toBe(text);
  });

  it("a short value is still left alone (the 12-char floor is unchanged)", () => {
    expect(run("x-api-key: short12345").out).toBe("x-api-key: short12345");
  });
});

describe("B6-04: URL userinfo is a credential", () => {
  it("redacts the password in a connection string", () => {
    // BEFORE: out: "postgres://user:sup3rs3cr3tP4ssw0rd@db.internal:5432/app"  gate: CLEAN
    const { out, gate } = run("postgres://user:sup3rs3cr3tP4ssw0rd@db.internal:5432/app");
    expect(out).toBe("postgres://user:<REDACTED>@db.internal:5432/app");
    expect(gate).toBe("clean");
  });

  it("redacts across schemes and inside a JSON field", () => {
    expect(run("https://admin:s3cr3tPassw0rdXYZ@internal.host/api").out).toBe("https://admin:<REDACTED>@internal.host/api");
    expect(run("mongodb://svc:r00tP4sswordHere@10.0.0.5:27017/db").out).toBe("mongodb://svc:<REDACTED>@10.0.0.5:27017/db");
    expect(run('{"dsn":"postgres://u:p4ssw0rdSECRET@host/db"}').out).toBe('{"dsn":"postgres://u:<REDACTED>@host/db"}');
  });

  it("keeps the username and the host, so the fixture still reads as a URL", () => {
    const out = run("postgres://user:sup3rs3cr3tP4ssw0rd@db.internal:5432/app").out;
    expect(out).toContain("postgres://user:");
    expect(out).toContain("@db.internal:5432/app");
  });

  it("leaves a URL with no password completely untouched", () => {
    const keep = [
      "https://example.com/path?q=1",
      "https://example.com/a@b/c",
      "http://127.0.0.1:3001/v1",
      "[docs](https://example.com/a(b))",
    ];
    for (const text of keep) expect(run(text).out, text).toBe(text);
  });

  it("does not mistake an email address or a git ssh remote for userinfo", () => {
    const keep = ["contact: admin@example.com", "git@github.com:owner/repo.git", "user@host"];
    for (const text of keep) expect(run(text).out, text).toBe(text);
  });

  it("a very short password is not a credential (3-char floor)", () => {
    expect(run("postgres://u:ab@host/db").out).toBe("postgres://u:ab@host/db");
  });
});

describe("B6-02/03/04: the three fixes do not disturb what was already correct", () => {
  it("keeps the Set-Cookie alias discovery pinned by redact.test.ts", () => {
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

  it("keeps short non-credential JSON values intact (W824 F01 guard)", () => {
    const r = createRedactor([]);
    expect(r.redact('{"token":"short12345"}')).toBe('{"token":"short12345"}');
    expect(r.redact('{"message":"hello world","count":12}')).toBe('{"message":"hello world","count":12}');
  });

  it("keeps the Authorization/api_key JSON header output pinned by redact.test.ts", () => {
    const r = createRedactor([]);
    expect(r.redact('{"Authorization":"Bearer abcdefghijklmnop","api_key":"sk-1234567890abcdefgh"}')).toBe(
      '{"Authorization":"<REDACTED>","api_key":"<REDACTED>"}',
    );
  });

  it("a registered secret is still replaced wherever it appears", () => {
    const secret = "MnA3bC7dE9fG1hI2jK4lM6nO8pQ0rS4tU6vW8xY0zA2bC4dE";
    const r = createRedactor([secret]);
    const out = r.redact('{"kind":"error","message":"401 invalid api key: '+ secret + '"}');
    expect(out).not.toContain(secret);
  });
});
