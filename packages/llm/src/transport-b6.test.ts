/**
 * B6-05 — the llm transport carried its own one-regex redactor while core owned the
 * real rule table, so the transport missed every shape it had not been written for
 * and drifted behind the rules it duplicated.
 */
import { describe, expect, it } from "vitest";
import { redact } from "./transport.js";

describe("B6-05: transport.redact inherits core's rule table", () => {
  it("redacts a Set-Cookie value (no rule in the old local regex)", () => {
    // BEFORE: out: "Set-Cookie: sid=abcdefghij1234567890"  (verbatim)
    const out = redact("Set-Cookie: sid=abcdefghij1234567890");
    expect(out).not.toContain("abcdefghij1234567890");
    expect(out).toContain("<redacted>");
  });

  it("redacts a connection-string password (B6-04's url-userinfo rule)", () => {
    // BEFORE: out: "invalid base_url: postgres://u:p4ssw0rdSECRET@host/db"  (verbatim)
    const out = redact("invalid base_url: postgres://u:p4ssw0rdSECRET@host/db");
    expect(out).not.toContain("p4ssw0rdSECRET");
    expect(out).toContain("<redacted>");
  });

  it("redacts a bare x-api-key header echo (B6-03's hyphenated names)", () => {
    const out = redact("x-api-key: sk-ant-api03-AAAABBBBCCCCDDDDEEEE");
    expect(out).not.toContain("AAAABBBBCCCCDDDDEEEE");
    expect(out).toContain("<redacted>");
  });

  it("keeps the transport placeholder casing the fixtures pin", () => {
    // core emits <REDACTED>; this module has always emitted <redacted>.
    const out = redact("Set-Cookie: sid=abcdefghij1234567890");
    expect(out).toContain("<redacted>");
    expect(out).not.toContain("<REDACTED>");
  });

  it("still redacts the shapes transport-w824 pins (8-char Bearer, sk-)", () => {
    // The local shape rule is LAYERED under core, not replaced: core's bearer
    // rule needs 16+ characters, this one needs 8, and the suite below pins the
    // 12-character case. Deleting it would regress transport-w824.test.ts.
    expect(redact("Invalid Authorization: Bearer abcdef123456")).not.toContain("abcdef123456");
    expect(redact("Invalid Authorization:BEARER abcdef123456")).not.toContain("abcdef123456");
    expect(redact("bad key sk-abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
  });

  it("still replaces a registered key literally, and leaves it alone when unregistered", () => {
    const key = "9f8e7d6c5b4a3210";
    expect(redact("invalid api key: " + key, [key])).not.toContain(key);
    // An arbitrary provider key with no shape stays visible when NOT registered --
    // the exact behaviour transport-w824.test.ts's "redacts the client's own key
    // by literal replacement (N2 fallback)" case pins.
    expect(redact("invalid api key: " + key)).toContain(key);
  });

  it("leaves ordinary upstream prose alone", () => {
    const text = "upstream said 429 too many requests";
    expect(redact(text)).toBe(text);
  });
});
