/**
 * B7-4 (audit round 3) — the baseline HTTP security response headers.
 *
 * Two halves, and the second one matters more than the first:
 *
 *   ① the headers are actually sent, on EVERY surface (the audit measured
 *      `x-frame-options: null`, `content-security-policy: null`,
 *      `x-content-type-options: null`, `referrer-policy: null` on /login);
 *   ② nothing regressed. A security header that breaks the app is worse than
 *      no header, so the tests below pin that the CSP does not forbid anything
 *      the SHIPPED `apps/web/dist` actually does, and that the streaming SSE
 *      route keeps its content type, its `cache-control: no-cache` and its
 *      frame bytes. The SSE one is the subtle case: `GET /api/events` returns a
 *      PRE-BUILT Response built from a stream, which is exactly the shape a
 *      naive `new Response(body, {headers})` approach would silently miss.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeHarness, type StudioHarness } from "./harness.test-util.js";
import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from "./security-headers.js";

const harnesses: StudioHarness[] = [];
function harness(): StudioHarness {
  const h = makeHarness();
  harnesses.push(h);
  return h;
}
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** Every surface the audit listed, plus the ones a middleware could miss. */
const SURFACES: ReadonlyArray<readonly [string, string]> = [
  ["/login", "GET"],
  ["/auth/check", "GET"],
  ["/api/health", "GET"],
  ["/api/config", "GET"],
  ["/api/does-not-exist", "GET"],
  ["/assets/app.js", "GET"],
  ["/index.html", "GET"],
  ["/", "GET"],
  ["/some/spa/route", "GET"],
];

describe("B7-4 · baseline security headers on every surface", () => {
  it("① all four headers are present on every route (login, api, 404, static, SPA)", async () => {
    const h = harness();
    for (const [path, method] of SURFACES) {
      const res = await h.app.fetch(new Request("http://local" + path, { method }));
      for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
        expect(res.headers.get(key), `${method} ${path} is missing ${key}`).toBe(value);
      }
    }
  });

  it("② the CSP is a real policy, not a placeholder", () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    // The two directives that actually stop injection.
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("base-uri 'none'");
    // No wildcard anywhere, and no unsafe-eval (the bundles contain none).
    expect(CONTENT_SECURITY_POLICY).not.toContain("*");
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
    // connect-src must not open the provider endpoints to a page.
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/connect-src[^;]*\*/);
  });

  it("③ the CSP permits everything the SHIPPED apps/web/dist actually does", () => {
    // Measured against the real build, so a frontend change that needs a new
    // allowance fails HERE instead of silently blank-paging the operator.
    const dist = join(process.cwd(), "apps", "web", "dist");
    let html: string;
    try {
      html = readFileSync(join(dist, "index.html"), "utf8");
    } catch {
      // No build in this checkout: the allowance is documented in the module
      // header, so skip rather than fail on a machine that never built it.
      console.warn("[b7-04] apps/web/dist not present — CSP-vs-build assertions skipped");
      return;
    }
    // 1. the inline build stamp needs script-src 'unsafe-inline'
    const hasInlineScript = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html);
    if (hasInlineScript) {
      expect(CONTENT_SECURITY_POLICY).toMatch(/script-src[^;]*'unsafe-inline'/);
    }
    // 2. the data: favicon / inline images need img-src data:
    if (html.includes("data:image") || html.includes("data:")) {
      expect(CONTENT_SECURITY_POLICY).toMatch(/img-src[^;]*data:/);
    }
    // 3. nothing may be pulled from a remote origin
    const remote = [...html.matchAll(/(?:src|href)="(https?:\/\/[^\"]+)"/g)].map((m) => m[1] as string);
    expect(remote, "a remote origin would need a policy allowance").toEqual([]);
    // 4. the bundles must be free of dynamic code, or the policy would break them
    const assets = join(dist, "assets");
    for (const name of readdirSync(assets)) {
      if (!name.endsWith(".js")) continue;
      const code = readFileSync(join(assets, name), "utf8");
      expect(code, name + " uses eval").not.toMatch(/\beval\s*\(/);
      expect(code, name + " uses new Function").not.toMatch(/new Function\s*\(/);
    }
  });

  it("④ SSE keeps its streaming contract — content-type, cache-control and frame bytes", async () => {
    // The regression this guards: /api/events returns a PRE-BUILT Response, so a
    // header mechanism that only touched handler-returned JSON would not apply
    // here — and a security middleware that rewrote the response wholesale would
    // destroy the stream.
    const h = harness();
    const res = await h.app.fetch(new Request("http://local/api/events"));
    expect(res.status).toBe(200);
    // The streaming contract, byte for byte.
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    // And the security headers ride along on the same response.
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // The body still streams real frames (B7-2 keepalive is unaffected).
    const reader = (res.body as ReadableStream).getReader();
    const read = reader.read();
    h.studio.services.bus.emit("status", 1, { phase: "idle" }, "sample-ws/s1");
    const got = await Promise.race([
      read,
      new Promise<"TIMEOUT">((r) => setTimeout(() => r("TIMEOUT"), 2000)),
    ]);
    expect(got).not.toBe("TIMEOUT");
    const text = new TextDecoder().decode((got as { value: Uint8Array }).value);
    expect(text).toContain("event: status");
    await reader.cancel();
  });

  it("⑤ the headers do not disturb the error, auth or 404 bodies", async () => {
    const h = harness();
    // 404 keeps its frozen shape.
    const nf = await h.app.fetch(new Request("http://local/api/does-not-exist"));
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ error: "not found" });
    // 401 keeps the token gate's shape.
    const un = await h.app.fetch(new Request("http://local/auth/check"));
    expect(un.status).toBe(401);
    expect(await un.json()).toEqual({ ok: false, error: "unauthorized" });
    // The login page still answers HTML with no-store.
    const lp = await h.app.fetch(new Request("http://local/login"));
    expect(lp.status).toBe(200);
    expect(lp.headers.get("content-type")).toContain("text/html");
    expect(lp.headers.get("cache-control")).toBe("no-store");
  });
});
