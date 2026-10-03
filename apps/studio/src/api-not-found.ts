/**
 * B7-5 (audit round 3) — a method mismatch is 405, not 404.
 *
 * The defect: every unmatched request fell into one catch-all that answered
 * `404 {"error":"not found"}`. So `DELETE /api/health` (a contract endpoint,
 * wrong verb) and `GET /api/does-not-exist` (no such endpoint) were
 * byte-identical responses, and no `Allow` header was ever sent.
 *
 * That contradicts the frozen contract, which already declares the answer:
 * `contracts/endpoints.json` §errorCodes says
 *
 *     "404": "unknown workspace/session/provider/prompt"
 *     "405": "path exists but method mismatch (framework default)"
 *
 * so 405 is not this change inventing a behaviour — it is the contract
 * asserting one the host never implemented. The two cases are genuinely
 * different questions ("that URL does not exist" vs "that URL exists, use a
 * different verb") and collapsing them makes a typo'd verb indistinguishable
 * from a typo'd path, which is the case a client actually has to debug.
 *
 * ## Why the change is safe for the client
 *
 * `apps/web/src/api.ts` ALREADY treats the two as equivalent — it maps
 * `status === 404 || status === 405` to one 'endpoint not published' branch in
 * five places, because an older server without an endpoint answers 404. So no
 * frontend branch changes meaning; a client that only knew 404 keeps working
 * because it already handled both.
 *
 * ## The body
 *
 * It stays the handler's own frozen shape — `{"error": "not found"}` —
 * which is one of the two documented exceptions to the `{"ok":false,"error"}
 * convention (see handlers/common.ts:6-7). Only the STATUS and the new `Allow`
 * header change, so `contracts/endpoints.json` §conventions needs no edit: this
 * is the 404 body a path-mismatch answers with, which is what that clause
 * already describes. `ok:false` is deliberately NOT added — it would be a new
 * shape on a route whose body is frozen.
 */
import type { Context, MiddlewareHandler } from "hono";
import type { RegisteredRoute } from "./routes.js";

/** The frozen body for a path that does not answer (common.ts:6-7). */
function notFoundBody(c: Context): Response {
  return c.json({ error: "not found" }, 404);
}

function methodNotAllowed(c: Context, allow: string): Response {
  const res = c.json({ error: "not found" }, 405);
  res.headers.set("allow", allow);
  return res;
}

/**
 * `path` -> the methods that answer it.
 *
 * Keyed by the CONTRACT path (`/api/sessions/{id}/messages`), never the Hono
 * spelling, so the lookup below compares like with like. `HEAD` is included
 * for every `GET`: HTTP requires a `HEAD`-capable resource to answer `HEAD`
 * the same way it answers `GET`, and the static handler already does.
 */
function allowedByPath(routes: readonly RegisteredRoute[]): Map<string, Set<string>> {
  const table = new Map<string, Set<string>>();
  for (const route of routes) {
    const set = table.get(route.contractPath) ?? new Set<string>();
    set.add(route.method);
    if (route.method === "GET") set.add("HEAD");
    table.set(route.contractPath, set);
  }
  return table;
}

/**
 * The methods a request's PATH targets, or null when it targets none.
 *
 * ## The `%2F` problem, and why the naive matcher is wrong
 *
 * A session id is `<workspace>/<session>` and the contract says the `/` "MUST
 * be %2F encoded" (contracts/endpoints.json §conventions.sessionId), so
 * `GET /api/sessions/ws%2Fs1/messages` is FOUR contract segments
 * (`api, sessions, {id}, messages`) but only THREE URL segments, because
 * `URL.pathname` keeps `%2F` as three literal characters. A segment-COUNT
 * match therefore returns null for EVERY one of the 30 path-parameter
 * routes — measured: `DELETE /api/sessions/ws%2Fs1/messages` answered 404
 * with no `Allow` while `DELETE /api/health` answered 405. The fix must
 * account for the encoded separator.
 *
 * So a `{param}` is matched against the REST of the URL from its position:
 * it absorbs `%2F` and consumes the remaining segments until the next
 * literal segment of the contract path matches. That is what makes
 * `api, sessions, {id}, messages` match `api, sessions, ws%2Fs1, messages`
 * and, at the same time, keeps a real mismatch (`/api/sessions/a/b/c/d`)
 * from matching.
 */
/**
 * A CONTRACT path parameter. The contract spells it `{id}` (and `{*rest}`);
 * `toHonoPath` rewrites those to `:id`/`*` for the router, so the table built
 * from `contractPath` carries the BRACE form.
 */
function isParam(part: string): boolean {
  return part.startsWith("{") && part.endsWith("}");
}

function matchSegments(parts: string[], segments: string[]): boolean {
  let i = 0;
  for (let p = 0; p < parts.length; p += 1) {
    const part = parts[p] as string;
    if (isParam(part)) {
      // A parameter is ONE contract segment that may arrive as SEVERAL url
      // segments (`ws%2Fs1` is one `{id}` but splits into `ws` + `s1`), and it
      // may not contain a bare `/` beyond that.
      //
      // B1-02 (audit round 4): the alignment is NOT a search. Everything after
      // the parameter is LITERAL, so its tail is pinned to the end of the url
      // by arithmetic alone — `take + rest.length` must equal `segments.length`,
      // which leaves exactly ONE candidate. The old code looped over every
      // position and `return true`d on the first alignment whose LITERALS lined
      // up, without ever checking the url was fully consumed — so
      // `/api/sessions/a/messages/extra` matched `/api/sessions/{id}/messages`
      // (the trailing `extra` was never looked at) and answered 405 + `Allow`
      // instead of 404: the one case the whole B7-5 fix exists to make
      // distinguishable — a typo'd PATH — kept masquerading as a typo'd VERB.
      const rest = parts.slice(p + 1);
      const take = segments.length - rest.length;
      // `take > i`: a parameter must swallow at least one segment, so an empty
      // one (`/api/sessions//messages`) stays a non-match exactly as before.
      if (take <= i) return false;
      return rest.every((r, k) => r === segments[take + k]);
    }
    if (segments[i] !== part) return false;
    i += 1;
  }
  return i === segments.length;
}

/** The request's url segments (`%2F` is a SEPARATOR, per the encoding rule). */
function requestSegments(pathname: string): string[] {
  return pathname
    .split("/")
    .flatMap((part) => part.split(/%2f|%5c/i))
    .filter((s) => s !== "");
}

/** The contract path a request targets, or null when it targets none. */
function matchContractPath(pathname: string, table: Map<string, Set<string>>): Set<string> | null {
  const segments = requestSegments(pathname);
  for (const [contractPath, methods] of table) {
    const parts = contractPath.split("/").filter((s) => s !== "");
    if (matchSegments(parts, segments)) return methods;
  }
  return null;
}

/**
 * The `/api/*` terminal handler: 405 on a method mismatch, 404 otherwise.
 *
 * Mounted in place of the single `app.all("/api/*", ...)` catch-all, so the
 * frozen rule that an unknown API path must never fall through to the SPA is
 * kept exactly as it was — this still answers every unmatched `/api/*` request
 * and still returns JSON.
 */
export function apiNotFound(routes: readonly RegisteredRoute[]): MiddlewareHandler {
  const table = allowedByPath(routes);
  return async (c) => {
    const methods = matchContractPath(new URL(c.req.url).pathname, table);
    if (methods !== null) {
      const method = c.req.method.toUpperCase();
      if (!methods.has(method)) {
        return methodNotAllowed(c, [...methods].sort().join(", "));
      }
    }
    return notFoundBody(c);
  };
}

/** Exported for the test: the `Allow` set the contract declares for a path. */
export function allowedMethodsFor(routes: readonly RegisteredRoute[], pathname: string): string[] | null {
  const methods = matchContractPath(pathname, allowedByPath(routes));
  return methods === null ? null : [...methods].sort();
}
