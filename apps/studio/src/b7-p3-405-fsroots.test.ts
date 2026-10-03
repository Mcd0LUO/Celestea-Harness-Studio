/**
 * B7-5 + B7-6 (audit round 3) — the two P3s, pinned so they cannot drift back.
 *
 * B7-5: a method mismatch on a KNOWN contract path must answer 405 with an
 * `Allow` header, because `contracts/endpoints.json` §errorCodes already says
 *   "405": "path exists but method mismatch (framework default)"
 * and the host never implemented it — `DELETE /api/health` and
 * `GET /api/does-not-exist` were byte-identical 404s.
 *
 * B7-6: `fsRoots()` on win32 used to START at the drive root, and
 * `handlers/fs.ts` opens the browser at `roots[0]` when the client sends no
 * `?path=` — which `apps/web/src/ui/fsbrowser.ts:257` does on every open
 * (`loadDirs('')`). So every Windows user's directory picker landed in
 * `Windows/`, `Program Files/`, `$Recycle.Bin/`. The USERPROFILE now comes
 * first (the same reason POSIX lists `/home` first); the drive root is kept as
 * the second shortcut and stays reachable from the breadcrumb root button.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createStudioApp } from "./app.js";
import { loadStudioConfig, fsRoots } from "./config.js";
import { createFakeRuntimeAdapter } from "./fake-runtime-adapter.js";
import { allowedMethodsFor } from "./api-not-found.js";
import { studioRoutes } from "./routes.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function app(): { fetch: (req: Request) => Response | Promise<Response> } {
  const root = mkdtempSync(join(tmpdir(), "b7p3-"));
  roots.push(root);
  const ws = join(root, "sample-ws");
  const sr = join(root, "dist");
  mkdirSync(ws, { recursive: true });
  mkdirSync(sr, { recursive: true });
  writeFileSync(join(sr, "index.html"), "<!doctype html><title>s</title>\n");
  writeFileSync(join(root, "workspaces.json"), JSON.stringify({ workspaces: [{ path: ws }], active_session: null }, null, 2));
  const config = loadStudioConfig({ cwd: root, env: {} as never, paths: { staticRoot: sr } });
  return createStudioApp({ config, env: {} as never, runtime: createFakeRuntimeAdapter({ profile: { model: "t" } }) }).app;
}

const call = async (a: { fetch(r: Request): Response | Promise<Response> }, method: string, path: string) => {
  const res = await a.fetch(
    new Request("http://l" + path, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" || method === "HEAD" || method === "DELETE" ? undefined : "{}",
    }),
  );
  return { status: res.status, allow: res.headers.get("allow"), body: await res.text() };
}

describe("B7-5 · method mismatch is 405 + Allow; an unknown path stays 404", () => {
  it("① a known contract path with a wrong method answers 405 (not 404)", async () => {
    const a = app();
    for (const [method, path] of [["DELETE", "/api/health"], ["PUT", "/api/health"], ["PATCH", "/api/config"], ["DELETE", "/api/sessions"]] as const) {
      const r = await call(a, method, path);
      expect(r.status, `${method} ${path}`).toBe(405);
    }
  });

  it("② the 405 carries an `Allow` header naming the methods that DO answer", async () => {
    const a = app();
    const health = await call(a, "DELETE", "/api/health");
    // GET plus HEAD: HTTP requires a GET resource to answer HEAD the same way.
    expect(health.allow).toBe("GET, HEAD");
    const config = await call(a, "PATCH", "/api/config");
    expect(config.allow).toBe("GET, HEAD, POST");
    const sessions = await call(a, "DELETE", "/api/sessions");
    expect(sessions.allow).toBe("GET, HEAD, POST");
  });

  it("②b a PATH-PARAMETER route with a wrong method also answers 405", async () => {
    // The regression this pins: the first matcher compared segment counts, so
    // every `/api/.../{id}/...` route kept answering 404 — 30 of 70 endpoints.
    const a = app();
    const messages = await call(a, "DELETE", "/api/sessions/ws%2Fs1/messages");
    expect(messages.status).toBe(405);
    expect(messages.allow).toBe("GET, HEAD");
    const del = await call(a, "PUT", "/api/providers/p1/delete");
    expect(del.status).toBe(405);
    expect(del.allow).toBe("POST");
    const input = await call(a, "PUT", "/api/terminal/t1/input");
    expect(input.status).toBe(405);
    expect(input.allow).toBe("POST");
  });

  it("③ a genuinely unknown path is STILL 404 with no Allow (the frozen rule)", async () => {
    const a = app();
    for (const path of ["/api/does-not-exist", "/api/nope", "/api/sessions/a/b/c"]) {
      const r = await call(a, "GET", path);
      expect(r.status, path).toBe(404);
      expect(r.allow, path).toBeNull();
    }
  });

  it("③b a path-parameter route with TRAILING JUNK stays 404, not 405 (B1-02)", async () => {
    // B7-5 made 405 mean "this url exists, wrong verb". The matcher that
    // implemented it aligned a `{param}` by SEARCHING for a position where the
    // trailing literals lined up, and returned on the first hit without checking
    // the url was fully consumed — so `/messages/extra` matched
    // `/api/sessions/{id}/messages` and answered 405 + `Allow: GET, HEAD`. That
    // is the exact confusion B7-5 exists to remove: a client would go looking
    // for a typo in its HTTP METHOD while the real problem is a typo in its PATH.
    const a = app();
    for (const [method, path] of [
      ["DELETE", "/api/sessions/ws%2Fs1/messages/extra"],
      ["DELETE", "/api/sessions/ws%2Fs1/messages/a/b"],
      ["DELETE", "/api/sessions/ws%2Fs1/permission/extra"],
      ["PUT", "/api/sessions/ws%2Fs1/permission/sub"],
      ["DELETE", "/api/terminal/t1/input/extra"],
    ] as const) {
      const r = await call(a, method, path);
      expect(r.status, `${method} ${path} must be 404 (unknown path)`).toBe(404);
      expect(r.allow, `${method} ${path} must carry no Allow`).toBeNull();
    }
  });

  it("③c the trailing-junk fix did not break the real matches (B1-02 negative control)", () => {
    // The same alignment arithmetic, both directions. A `{param}` still absorbs
    // the %2F-encoded session id, and a wildcard tail still absorbs the rest.
    const routes = studioRoutes();
    expect(allowedMethodsFor(routes, "/api/sessions/ws%2Fs1/messages")).toEqual(["GET", "HEAD"]);
    expect(allowedMethodsFor(routes, "/api/sessions/ws%2fs1/messages")).toEqual(["GET", "HEAD"]);
    expect(allowedMethodsFor(routes, "/api/sessions/a/b/c/d")).toBeNull();
    // An EMPTY parameter is still not a match (`/api/sessions//messages`).
    expect(allowedMethodsFor(routes, "/api/sessions//messages")).toBeNull();
  });

  it("④ 405 and 404 are now DISTINGUISHABLE — the whole point of the fix", async () => {
    const a = app();
    const wrongVerb = await call(a, "DELETE", "/api/health");
    const wrongPath = await call(a, "GET", "/api/does-not-exist");
    expect(wrongVerb.status).not.toBe(wrongPath.status);
    // The BODY shape is deliberately unchanged: `{"error": ...}` is one of the
    // two documented exceptions to the ok:false convention (common.ts:6-7), so
    // contracts/endpoints.json §conventions needs no edit and no client branch
    // that reads `error` breaks.
    expect(JSON.parse(wrongVerb.body)).toEqual(JSON.parse(wrongPath.body));
  });

  it("⑤ a correct method still works — the 405 arm must not swallow real routes", async () => {
    const a = app();
    expect((await call(a, "GET", "/api/health")).status).toBe(200);
    expect((await call(a, "POST", "/api/config")).status).toBe(200);
    expect((await call(a, "POST", "/api/exec")).status).toBe(422); // reaches its handler
    expect((await call(a, "HEAD", "/api/health")).status).toBe(200);
  });

  it("⑥ the Allow set is derived from the CONTRACT, and HEAD follows GET", () => {
    const routes = studioRoutes();
    expect(allowedMethodsFor(routes, "/api/health")).toEqual(["GET", "HEAD"]);
    expect(allowedMethodsFor(routes, "/api/config")).toEqual(["GET", "HEAD", "POST"]);
    // A path parameter is ONE contract segment that may arrive as SEVERAL url
    // segments: the contract says a session id is "<workspace>/<session>" with
    // the "/" %2F-encoded, so `ws%2Fs1` must still match `{id}`. Matching on
    // segment COUNT alone (the first draft) silently skipped all 30
    // path-parameter routes — they answered 404 with no Allow.
    expect(allowedMethodsFor(routes, "/api/sessions/ws%2Fs1/messages")).toEqual(["GET", "HEAD"]);
    expect(allowedMethodsFor(routes, "/api/permissions/presets/x")).toEqual(["DELETE", "PUT"]);
    expect(allowedMethodsFor(routes, "/api/terminal/t1/input")).toEqual(["POST"]);
    // ...and a path that is simply too long is still not a match.
    expect(allowedMethodsFor(routes, "/api/sessions/a/b/c/d")).toBeNull();
    expect(allowedMethodsFor(routes, "/api/nope")).toBeNull();
    // A lowercase %2f is the same encoding.
    expect(allowedMethodsFor(routes, "/api/sessions/ws%2fs1/messages")).toEqual(["GET", "HEAD"]);
  });
});

describe("B7-6 · fsRoots on win32 opens at the user profile, not the drive root", () => {
  it("① the USERPROFILE is first on win32 (this is the browse landing directory)", () => {
    const rootsOut = fsRoots("win32", { SystemDrive: "C:", USERPROFILE: "C:\\Users\\lenovo" } as never);
    expect(rootsOut[0]).toBe("C:\\Users\\lenovo");
    // The drive root is kept as a shortcut — just not as the landing spot.
    expect(rootsOut).toContain("C:\\");
  });

  it("② a blank or absent USERPROFILE falls back to the drive root (never an empty list)", () => {
    // An empty list would leave `roots[0]` undefined and break the fs default
    // path, so the fallback has to stay.
    expect(fsRoots("win32", {} as never)).toEqual(["C:\\"]);
    expect(fsRoots("win32", { SystemDrive: "D:", USERPROFILE: "   " } as never)).toEqual(["D:\\"]);
  });

  it("③ POSIX output is byte-identical to before (the W885 seam is untouched)", () => {
    expect(fsRoots("linux", {} as never)).toEqual(["/src", "/tmp", "/srv", "/home"]);
    // $home is first on POSIX for exactly the reason USERPROFILE is first now.
    expect(fsRoots("linux", {} as never)[0]).toBe("/src");
  });

  it("④ the win32 roots are absolute and carry no trailing separator on the profile", () => {
    const out = fsRoots("win32", { SystemDrive: "C:", USERPROFILE: "C:\\Users\\lenovo\\" } as never);
    expect(out[0]).toBe("C:\\Users\\lenovo");
    expect(out[0]?.endsWith("\\")).toBe(false);
  });
});
