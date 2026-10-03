import { describe, expect, it } from "vitest";

import { probeModels, type ProbeFetch, type ProbeOptions, type ProbeResponse } from "./provider-probe.js";

/**
 * B2-01 (P0) — the probe must never quote a credential back.
 *
 * The bug: both failure strings were `head(text, …)`, so an upstream that echoes
 * the `Authorization` header it received (many gateways quote the bad key back in
 * a 401/500) put the row's stored `api_key` verbatim into the `{ok:false,error}`
 * body that `/api/providers/test` and `/api/providers/{id}/models/fetch` return to
 * the browser — breaking the frozen `endpoints.json` convention
 * `"no response ever contains api_key"`.
 *
 * Two echo sites are covered (a non-2xx status, and a 2xx whose body is not JSON),
 * and two key SHAPES are covered, because they are defended by two different
 * mechanisms:
 *   - a recognisable `sk-…` / `Bearer …` token → caught by the shape rules;
 *   - an arbitrary vendor string → caught ONLY by the registered-secret pass,
 *     which is why the probe's own key is handed to the redactor explicitly.
 */
const SHAPED = "sk-live-DEADBEEF-0123456789";
const ARBITRARY = "9f8e7d6c5b4a3210zyxw";

function respond(status: number, body: string): ProbeResponse {
  return { status, text: () => Promise.resolve(body) };
}

function opts(fetchImpl: ProbeFetch, engineKey: string | null = null): ProbeOptions {
  return { engineBaseUrl: "http://127.0.0.1:1", engineKey, fetch: fetchImpl, timeoutMs: 1000 };
}

async function probe(key: string, status: number, body: string): Promise<string> {
  const out = await probeModels(
    { id: "p", base_url: "http://127.0.0.1:9", request_format: "chat_completions", api_key: key },
    opts(async () => respond(status, body)),
  );
  return out.error ?? "";
}

describe("B2-01: an upstream that echoes the key never reaches the caller", () => {
  it("redacts a shaped key out of a non-2xx body (the real 500 case)", async () => {
    const error = await probe(
      SHAPED,
      500,
      "upstream exploded; your key was: Bearer " + SHAPED,
    );
    expect(error).not.toContain(SHAPED);
    expect(error).toContain("<REDACTED>");
    // the surrounding, non-secret context is still useful for diagnosis
    expect(error).toContain("HTTP 500");
    expect(error).toContain("upstream exploded");
  });

  it("redacts an ARBITRARY vendor key — only the registered-secret pass can", async () => {
    const error = await probe(ARBITRARY, 401, '{"error":{"message":"invalid api key: ' + ARBITRARY + '"}}');
    expect(error).not.toContain(ARBITRARY);
    expect(error).toContain("<REDACTED>");
  });

  it("redacts a key the probe BORROWED from the engine, not just the row's own", async () => {
    // keyless row + same-origin engine key ⇒ the key under test is the engine's
    const out = await probeModels(
      { id: "p", base_url: "http://engine.invalid", request_format: "chat_completions", api_key: null },
      {
        engineBaseUrl: "http://engine.invalid",
        engineKey: ARBITRARY,
        timeoutMs: 1000,
        fetch: async (_url, init) => respond(500, "rejected: " + (init.headers["authorization"] ?? "")),
      },
    );
    expect(out.error ?? "").not.toContain(ARBITRARY);
    expect(out.error ?? "").toContain("<REDACTED>");
  });

  it("redacts on the 2xx-but-not-JSON path too (the second echo site)", async () => {
    const error = await probe(SHAPED, 200, "<html>oops, token " + SHAPED + "</html>");
    expect(error).not.toContain(SHAPED);
    expect(error).toContain("<REDACTED>");
  });

  it("redacts even when the secret straddles the truncation boundary", async () => {
    // The body head is 300 chars; pad so the key starts before the cut and would
    // be sliced in half if truncation ran BEFORE redaction.
    const padded = "x".repeat(290) + " " + SHAPED;
    const error = await probe(SHAPED, 500, padded);
    expect(error).not.toContain(SHAPED);
    // either fully redacted, or entirely cut away — never a half-secret
    expect(error).not.toContain(SHAPED.slice(0, 8));
  });

  it("leaves a body with no secret in it untouched", async () => {
    const error = await probe(SHAPED, 503, "service temporarily unavailable, try later");
    expect(error).toContain("service temporarily unavailable, try later");
  });
});
