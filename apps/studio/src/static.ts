/**
 * Static file serving + SPA fallback (`src/main.rs:735-847`).
 *
 * The Vite build under `STUDIO_STATIC_ROOT` is served READ-ONLY and hardened
 * twice: `sanitizeRel` refuses `..`, absolute and prefix components on the
 * request path, and the resolved path is then re-checked to sit inside the
 * root (so a symlink cannot escape either). Unknown `/api/*` paths never reach
 * this handler — they are 404 JSON, which is why the API 404 is registered
 * before the fallback. A missing build serves the "build the frontend first"
 * hint page instead.
 */

import { readFileSync, statSync, realpathSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { Context, type Hono } from "hono";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const HINT_PAGE = `<!doctype html><meta charset="utf-8"><title>celestea-studio</title>
<body style="font-family:system-ui;padding:2rem">
<h1>celestea-studio TS</h1>
<p>frontend/dist is missing — build the frontend first (<code>pnpm build</code> in frontend/).</p>
<p>The HTTP API is available at <code>/api/*</code>.</p>
</body>`;

export function contentTypeFor(rel: string): string {
  return MIME[extname(rel).toLowerCase()] ?? "application/octet-stream";
}

/** Allow normal components only: reject `..`, absolute and prefix components. */
export function sanitizeRel(rel: string): string | null {
  const parts: string[] = [];
  for (const raw of rel.split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === ".." || raw.includes("\\") || raw.includes("\0")) return null;
    parts.push(raw);
  }
  if (parts.length === 0) return null;
  return parts.join("/");
}

/** Resolve inside the root or refuse (catches symlink escapes too). */
export function resolveWithinRoot(root: string, rel: string): string | null {
  const target = resolve(root, rel);
  const realRoot = (() => {
    try {
      return realpathSync(root);
    } catch {
      return resolve(root);
    }
  })();
  const real = (() => {
    try {
      return realpathSync(target);
    } catch {
      return target;
    }
  })();
  if (real !== realRoot && !real.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`)) return null;
  return target;
}

interface StaticFile {
  body: Uint8Array;
  contentType: string;
}

function readIfFile(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    return path;
  } catch {
    return null;
  }
}

function readStatic(root: string, rel: string): StaticFile | null {
  const file = readIfFile(resolveWithinRoot(root, rel) ?? "");
  if (file === null) return null;
  return { body: readFileSync(file), contentType: contentTypeFor(rel) };
}

function bytesResponse(c: Context, body: Uint8Array, contentType: string, status = 200): Response {
  c.header("content-type", contentType);
  c.header("cache-control", "no-cache");
  // `Uint8Array<ArrayBufferLike>` (what readFileSync hands back) is not assignable
  // to the DOM `Data` type; the copy into a plain ArrayBuffer is what makes the
  // body type-safe and costs one allocation per served file.
  return c.newResponse(new Uint8Array(body), status as never);
}

function htmlResponse(c: Context, body: string, status = 200): Response {
  c.header("content-type", "text/html; charset=utf-8");
  c.header("cache-control", "no-cache");
  return c.newResponse(body, status as never);
}

/**
 * The static/SPA handler; `/api/*` is answered by the caller's 404 route.
 *
 * The Context is an OPTIONAL first argument so the exported helper keeps its
 * original `(root, rawPath)` shape for direct callers (`static.test.ts` and any
 * future probe). Without one we fall back to a standalone Context: that loses
 * the middleware-prepared headers, which is precisely why `registerStatic`
 * always passes the real one.
 */
export function serveStaticPath(root: string, rawPath: string): Response;
export function serveStaticPath(c: Context, root: string, rawPath: string): Response;
export function serveStaticPath(a: string | Context, b: string, rawPath?: string): Response {
  // A throwaway Context for the context-free form: it can build the response,
  // it just carries no middleware-prepared headers.
  const c = typeof a === "string" ? new Context(new Request("http://local")) : a;
  const root = typeof a === "string" ? a : b;
  const path = rawPath ?? b;
  const notFound = (): Response => c.json({ error: "not found" }, 404);
  if (path.startsWith("/api/")) return notFound();
  const rel = sanitizeRel(path.replace(/^\/+/, "") === "" ? "index.html" : path.replace(/^\/+/, ""));
  if (rel === null) return notFound();
  const file = readStatic(root, rel);
  if (file !== null) return bytesResponse(c, file.body, file.contentType);
  if (rel === "index.html" || !rel.includes(".")) {
    const index = readStatic(root, "index.html");
    return index === null ? htmlResponse(c, HINT_PAGE) : bytesResponse(c, index.body, "text/html; charset=utf-8");
  }
  return notFound();
}

export function registerStatic(app: Hono, root: string): void {
  // B7-4: the Context is threaded in (it always was available) so these
  // responses are built through `c.newResponse` rather than a bare
  // `new Response(...)`. Hono merges middleware-prepared headers into the
  // response only via the `c.res =` setter, so a raw Response returned by a
  // handler silently DROPS every security header — which is exactly what
  // happened to the static tree and the login page before this change. Every
  // byte-level behaviour below (MIME table, traversal refusal, SPA fallback,
  // the 404 shape) is unchanged.
  app.get("*", (c) => serveStaticPath(c, root, new URL(c.req.url).pathname));
}
