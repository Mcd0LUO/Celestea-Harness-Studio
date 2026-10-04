/**
 * B3 / W815-13 (= W819-6): the provider probe must go through the deployment's
 * SSRF target policy instead of calling the host fetch directly.
 *
 * Source: \`/srv/ops/runtime/worker-exec/results/W828-R3修复计划-C-studio-web-tests-security.md\`
 * §B3 — "验收探针：设 CELESTEA_HTTP_DENY=127.0.0.0/8，POST /api/providers/test
 * 指向 http://127.0.0.1/… → 期望 ok:false 且 fetch recorder 未被调用；指向允许
 * 地址 → 正常。走真实 handler。"
 *
 * Two layers, both on the REAL call path:
 *   1. \`POST /api/providers/test\` through the real Hono app (\`app.request\`)
 *      against a REAL loopback HTTP server: the server itself is the fetch
 *      recorder, so "not called" is a fact about the network, not a stub.
 *   2. \`probeModels\` with the production policy type + an injected recorder,
 *      for the fast, network-free regression.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HttpTargetPolicy, type HostResolver } from "@celestea/tools";
import { getJson, jsonRequest, makeHarness, type StudioHarness } from "./harness.test-util.js";
import {
  NO_API_KEY,
  UNSUPPORTED_FORMAT,
  probeModels,
  type ProbeFetch,
  type ProbeResponse,
} from "./store/provider-probe.js";
import type { RequestFormat } from "./store/providers.js";

const harnesses: StudioHarness[] = [];
const servers: Server[] = [];
const ENV_KEYS = ["CELESTEA_HTTP_ALLOW", "CELESTEA_HTTP_DENY"] as const;
let savedEnv: Record<string, string | undefined> = {};

afterEach(async () => {
  for (const h of harnesses.splice(0)) h.cleanup();
  for (const s of servers.splice(0)) await close(s);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  savedEnv = {};
});

function stashEnv(): void {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** A real model-list endpoint; every hit is recorded. */
async function modelServer(): Promise<{ port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "m-1" }, { id: "m-2" }] }));
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  return { port, hits };
}

const respond = (status: number, body: string): ProbeResponse => ({ status, text: () => Promise.resolve(body) });

describe("B3/W815-13: probe honours CELESTEA_HTTP_DENY through the real handler", () => {
  it("refuses a denied target before any socket, then serves an allowed one", async () => {
    stashEnv();
    const { port, hits } = await modelServer();
    const h = makeHarness();
    harnesses.push(h);
    const target = "http://127.0.0.1:" + port + "/v1";
    const body = jsonRequest("POST", { base_url: target, request_format: "chat_completions", api_key: "k" });

    // Denied: the policy names loopback. The probe must come back ok:false and the
    // REAL server must have seen zero requests.
    process.env["CELESTEA_HTTP_DENY"] = "127.0.0.0/8";
    delete process.env["CELESTEA_HTTP_ALLOW"];
    const denied = await getJson(h.app, "/api/providers/test", body);
    expect(denied.status).toBe(200);
    expect(denied.body["ok"]).toBe(false);
    expect(typeof denied.body["error"]).toBe("string");
    // The denial must not echo the internal address back to the caller.
    expect(String(denied.body["error"])).not.toContain("127.0.0.1");
    expect(hits).toEqual([]);

    // Allowed: the SAME target with the deny removed is reached exactly once.
    delete process.env["CELESTEA_HTTP_DENY"];
    process.env["CELESTEA_HTTP_ALLOW"] = "127.0.0.0/8";
    const ok = await getJson(h.app, "/api/providers/test", body);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, model_count: 2 });
    expect(hits).toEqual(["/v1/models"]);
  });
});

describe("B3/W815-13: probeModels policy seam (recorder is the injected fetch)", () => {
  const opts = { engineBaseUrl: "http://engine.test/v1", engineKey: null as string | null };

  function recorder(): { fetch: ProbeFetch; called: () => number } {
    let n = 0;
    return {
      fetch: () => {
        n += 1;
        return Promise.resolve(respond(200, JSON.stringify({ data: [{ id: "m-1" }] })));
      },
      called: () => n,
    };
  }

  const resolver: HostResolver = async (host) => (host === "blocked.test" ? ["10.1.2.3"] : ["127.0.0.1"]);

  it("returns ok:false and never calls fetch when the resolved address is denied", async () => {
    const rec = recorder();
    const policy = HttpTargetPolicy.parse(undefined, "10.0.0.0/8", { resolver });
    const out = await probeModels(
      { id: "a", base_url: "http://blocked.test/v1", request_format: "chat_completions", api_key: "k" },
      { ...opts, fetch: rec.fetch, policy },
    );
    expect(out.ok).toBe(false);
    expect(String(out.error)).not.toContain("10.1.2.3");
    expect(rec.called()).toBe(0);
  });

  it("still probes when the resolved address passes the policy", async () => {
    const rec = recorder();
    const policy = HttpTargetPolicy.parse("127.0.0.0/8", undefined, { resolver });
    const out = await probeModels(
      { id: "a", base_url: "http://allowed.test/v1", request_format: "chat_completions", api_key: "k" },
      { ...opts, fetch: rec.fetch, policy },
    );
    expect(out).toEqual({ ok: true, models: [{ id: "m-1" }] });
    expect(rec.called()).toBe(1);
  });
});

/**
 * W9271: the probe must ask the host the way the row DECLARES it, and must keep
 * refusing a protocol it has no implementation for.
 *
 * Everything here is network-free (an injected recorder) and asserts the THING that
 * actually went on the wire - the URL and the auth headers - because the old bug was
 * invisible in the outcome: every format answered with a clean 200 refusal.
 */
describe("W9271: probe speaks each declared request_format, and fails closed on the rest", () => {
  const opts = { engineBaseUrl: "http://engine.test/v1", engineKey: null as string | null };

  /** Records the exact request; answers like a real OpenAI-shaped model list. */
  function wire(): {
    fetch: ProbeFetch;
    calls: Array<{ url: string; method: string; headers: Record<string, string> }>;
  } {
    const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    return {
      calls,
      fetch: (url, init) => {
        calls.push({ url, method: init.method, headers: { ...init.headers } });
        return Promise.resolve(respond(200, JSON.stringify({ data: [{ id: "m-1" }] })));
      },
    };
  }

  // `blocked.test` resolves into the denied range; everything else to loopback.
  const resolver: HostResolver = async (host) => (host === "blocked.test" ? ["10.1.2.3"] : ["127.0.0.1"]);
  const allowAll = HttpTargetPolicy.parse("0.0.0.0/0", undefined, { resolver });

  /** Probe one format and hand back BOTH the outcome and what went on the wire. */
  const probe = async (format: string) => {
    const w = wire();
    const out = await probeModels(
      { id: "a", base_url: "http://allowed.test/v1/", request_format: format as RequestFormat, api_key: "secret-key" },
      { ...opts, fetch: w.fetch, policy: allowAll },
    );
    return { out, calls: w.calls };
  };

  it("chat_completions: GET <base>/models with Authorization: Bearer (unchanged)", async () => {
    const { out, calls } = await probe("chat_completions");
    expect(out).toEqual({ ok: true, models: [{ id: "m-1" }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://allowed.test/v1/models");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer secret-key");
  });

  it("responses: the same OpenAI-compatible GET + Bearer, not a refusal", async () => {
    const { out, calls } = await probe("responses");
    expect(out).toEqual({ ok: true, models: [{ id: "m-1" }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://allowed.test/v1/models");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer secret-key");
  });

  it("anthropic_messages: the SAME Bearer header the engine's transport sends (mirror, not guess)", async () => {
    const { out, calls } = await probe("anthropic_messages");
    expect(out).toEqual({ ok: true, models: [{ id: "m-1" }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://allowed.test/v1/models");
    expect(calls[0]?.method).toBe("GET");
    // MIRROR, not a guess: `requestHeaders` in packages/llm/src/transport.ts
    // sends Bearer for EVERY protocol, anthropic_messages included, so a probe
    // sending x-api-key here would call a row the engine cannot use healthy -
    // a lie in the direction that ships a broken config. The adapter's missing
    // protocol-native auth is registered as P19 (docs/pitfalls.md); fix it
    // THERE, and this assertion moves with it.
    expect(calls[0]?.headers["authorization"]).toBe("Bearer secret-key");
    expect(calls[0]?.headers["x-api-key"]).toBeUndefined();
  });

  it("refuses an UNKNOWN format by name and issues ZERO upstream requests", async () => {
    const { out, calls } = await probe("grpc_talks");
    expect(out.ok).toBe(false);
    // Structured, and it NAMES the format - never a guessed dialect on the wire.
    expect(out.error).toContain(UNSUPPORTED_FORMAT);
    expect(out.error).toContain("grpc_talks");
    expect(calls).toEqual([]);
  });

  it("a keyless NON-same-origin row still issues zero requests on any format", async () => {
    const w = wire();
    const out = await probeModels(
      { id: "a", base_url: "http://elsewhere.test/v1", request_format: "anthropic_messages", api_key: null },
      { ...opts, fetch: w.fetch, policy: allowAll },
    );
    expect(out).toEqual({ ok: false, error: NO_API_KEY });
    expect(w.calls).toEqual([]);
  });

  it("a DENIED target is refused before the anthropic headers are ever built", async () => {
    const w = wire();
    const out = await probeModels(
      { id: "a", base_url: "http://blocked.test/v1", request_format: "anthropic_messages", api_key: "secret-key" },
      { ...opts, fetch: w.fetch, policy: HttpTargetPolicy.parse(undefined, "10.0.0.0/8", { resolver }) },
    );
    expect(out.ok).toBe(false);
    expect(String(out.error)).not.toContain("10.1.2.3");
    expect(w.calls).toEqual([]);
  });
});
