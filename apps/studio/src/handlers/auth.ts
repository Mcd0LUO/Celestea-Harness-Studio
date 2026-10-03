/**
 * W767 — the three endpoints of Studio's OWN login-cookie gate.
 *
 *   GET  /login        the self-contained login page (always reachable)
 *   POST /auth/login   verify against Studio's password file, then Set-Cookie
 *   GET  /auth/check   200/401 for nginx `auth_request` (the actual gate)
 *
 * nginx asks `/auth/check` for every other path and rewrites a 401 into a
 * redirect to `/login`; these three are the only paths exempted there. The
 * backend therefore stays usable from localhost with no cookie (the engine's own
 * API is unchanged) while the public host is gated by the cookie.
 *
 * Hard rules kept here:
 *   - the password is verified through `htpasswd -vbi` (stdin, never argv);
 *   - a SUCCESSFUL login answers 200 with `Set-Cookie` AND the navigation in the
 *     same response (never a 302 — some mobile clients drop the cookie on a
 *     redirect);
 *   - the cookie value never reaches a log line, and a wrong password and an
 *     unknown user are indistinguishable (401 both ways).
 */

import type { Context, Hono } from "hono";
import type { RouteTable } from "../routes.js";
import { DEFAULT_JSON_BODY_BYTES, failJson, type Deps } from "./common.js";
import {
  AUTH_COOKIE,
  AUTH_MAX_FAILURES,
  AUTH_WINDOW_MS,
  authCookie,
  cookieValue,
  createFailureLimiter,
  isLoopbackBind,
  loadAuthSecret,
  loginPage,
  LOGIN_OK_PAGE,
  mintToken,
  verifyPassword,
  verifyToken,
  type FailureLimiter,
} from "../auth/index.js";

const HTML = "text/html; charset=utf-8";
const NO_STORE = "no-store";

/** The gate's own state: one limiter + one lazily-created secret per app. */
interface Gate {
  limiter: FailureLimiter;
  htpasswdFile: string;
  secret(): Buffer;
}

export function registerAuth(app: Hono, deps: Deps, table: RouteTable): string[] {
  const gate = createGate(deps);
  const page = table.get("get_login");
  const login = table.get("post_auth_login");
  const check = table.get("get_auth_check");

  app.on(page.method, page.honoPath, (c) => pageResponse(c, loginPage(), 200));

  app.on(check.method, check.honoPath, (c) => {
    const user = cookieUser(c, gate);
    return user === null
      ? jsonResponse(c, { ok: false, error: "unauthorized" }, 401)
      : jsonResponse(c, { ok: true, user }, 200);
  });

  app.on(login.method, login.honoPath, (c) => loginResponse(c, gate));
  return [page.id, login.id, check.id];
}

function createGate(deps: Deps): Gate {
  const limiter = createFailureLimiter({ now: Date.now, windowMs: AUTH_WINDOW_MS, maxFailures: AUTH_MAX_FAILURES });
  const htpasswdFile = deps.config.paths.authHtpasswdFile;
  let secret: Buffer | null = null;
  return {
    limiter,
    htpasswdFile,
    secret: (): Buffer => (secret ??= loadAuthSecret(deps.config.paths.authSecretFile)),
  };
}

/** The user of a valid cookie, or null (missing / tampered / expired / unknown). */
function cookieUser(c: Context, gate: Gate): string | null {
  const raw = cookieValue(c.req.header("cookie"), AUTH_COOKIE);
  if (raw === null) return null;
  const verdict = verifyToken(raw, gate.secret(), Math.floor(Date.now() / 1000));
  return verdict.ok ? verdict.user : null;
}

/** One failed attempt is counted against BOTH the username and the client IP. */
function attemptKeys(c: Context, user: string): string[] {
  return [`u:${user.toLowerCase()}`, `ip:${clientIp(c)}`];
}

async function loginResponse(c: Context, gate: Gate): Promise<Response> {
  const wantsJson = prefersJson(c);
  const creds = await credentialsOf(c);
  // B7-1: an over-length body is refused BEFORE any credential work, and it is
  // NOT counted as a failed attempt — a 64 MiB body is a malformed request, not
  // a guess, and charging it to the failure limiter would let one oversized
  // request lock a legitimate user out of their own login form.
  if (creds !== null && "oversize" in creds) {
    return denied(
      c,
      wantsJson,
      413,
      `request body is over the ${LOGIN_BODY_BYTES}-byte limit`,
      "请求体过大",
    );
  }
  if (creds === null) return denied(c, wantsJson, 401, "invalid username or password", "用户名或密码不正确");
  const keys = attemptKeys(c, creds.user);
  if (keys.some((key) => gate.limiter.blocked(key))) {
    return wantsJson
      ? failJson(c, 429, "too many failed login attempts", { retry_after: AUTH_WINDOW_MS / 1000 })
      : pageResponse(c, loginPage("尝试次数过多，请稍后再试"), 429);
  }
  const verdict = verifyPassword(gate.htpasswdFile, creds.user, creds.pass);
  if (verdict !== "ok") {
    for (const key of keys) gate.limiter.fail(key);
    if (verdict === "error") {
      warn(`password check failed to run (file=${gate.htpasswdFile}) — login denied`);
      return denied(c, wantsJson, 500, "credential store unavailable", "凭据校验服务不可用，请联系管理员");
    }
    return denied(c, wantsJson, 401, "invalid username or password", "用户名或密码不正确");
  }
  for (const key of keys) gate.limiter.clear(key);
  const token = mintToken(creds.user, gate.secret(), Math.floor(Date.now() / 1000));
  return wantsJson
    ? jsonResponse(c, { ok: true, user: creds.user }, 200, { "set-cookie": authCookie(token) })
    : pageResponse(c, LOGIN_OK_PAGE, 200, { "set-cookie": authCookie(token) });
}

function denied(c: Context, wantsJson: boolean, status: number, error: string, pageError: string): Response {
  return wantsJson ? failJson(c, status, error) : pageResponse(c, loginPage(pageError), status);
}

/**
 * B7-1 (audit round 3): the login body's ceiling.
 *
 * Why this route had none. W9230 added `DEFAULT_JSON_BODY_BYTES` to
 * `readJsonBody`, and its own module comment (handlers/common.ts:110-120)
 * names this route as one of the two it was written FOR — "an unauthenticated
 * `/auth/login` (not under the token gate) ... could be handed an arbitrarily
 * large body and OOM the process". But login never came through
 * `readJsonBody`: it has to accept a urlencoded FORM post as well as JSON, so
 * it read the body itself and the ceiling never reached it. Measured on a live
 * listener before the fix: a 64 MiB form body was buffered in full (heap +30.6
 * MiB, no 413) while the same bytes on `POST /api/config` were refused 413.
 *
 * 1 MiB is the same ceiling every other JSON route uses and is astronomically
 * above a username/password pair; a login that needs more than 1 MiB is not a
 * login. An unauthenticated, uncounted 64 MiB read is a free OOM for anyone who
 * can reach the port.
 */
const LOGIN_BODY_BYTES = DEFAULT_JSON_BODY_BYTES;

/**
 * Read the login body under a ceiling, or null when it is absent/oversize.
 *
 * Same two-half shape as `readJsonBody` (common.ts:142-155), for the same two
 * reasons: `content-length` is refused BEFORE a single byte is buffered (the
 * declared length is attacker-chosen but the refusal it triggers costs nothing),
 * and the bytes actually read are re-checked because a chunked request declares
 * no length at all. UTF-16 code units are a LOWER bound on the byte count, so
 * this errs in the safe direction.
 */
async function readLoginBody(
  c: Context,
  maxBytes = LOGIN_BODY_BYTES,
): Promise<{ ok: true; raw: string } | { ok: false; oversize: true } | { ok: false; oversize: false }> {
  const declared = Number.parseInt(c.req.header("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, oversize: true };
  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    return { ok: false, oversize: false };
  }
  if (raw.length > maxBytes) return { ok: false, oversize: true };
  return { ok: true, raw };
}

/** `{username, password}` out of a form post OR a JSON body; null when absent. */
async function credentialsOf(
  c: Context,
): Promise<{ user: string; pass: string } | { oversize: true } | null> {
  const read = await readLoginBody(c);
  if (!read.ok) return read.oversize ? { oversize: true } : null;
  const raw = read.raw;
  if (raw.trim() === "") return null;
  const type = (c.req.header("content-type") ?? "").toLowerCase();
  if (type.includes("json")) {
    try {
      return pickCredentials(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      return null;
    }
  }
  return pickCredentials(Object.fromEntries(new URLSearchParams(raw)));
}

function pickCredentials(body: Record<string, unknown>): { user: string; pass: string } | null {
  const user = body["username"];
  const pass = body["password"];
  if (typeof user !== "string" || typeof pass !== "string") return null;
  return user.trim() === "" || pass === "" ? null : { user: user.trim(), pass };
}

/** JSON clients (curl/API) get JSON; a browser form post gets a page back. */
function prefersJson(c: Context): boolean {
  const type = (c.req.header("content-type") ?? "").toLowerCase();
  const accept = (c.req.header("accept") ?? "").toLowerCase();
  return type.includes("json") || accept.includes("application/json");
}

/**
 * W9230 (W9206-09): the peer's real socket address, or null when the adapter
 * does not expose one (tests build a Request without a socket).
 *
 * `@hono/node-server` passes the raw `IncomingMessage` as `c.env.incoming`;
 * the socket's `remoteAddress` is the one value an HTTP client cannot choose.
 */
function peerAddress(c: Context): string | null {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string | null } } } | undefined)?.incoming;
  const address = incoming?.socket?.remoteAddress;
  return typeof address === "string" && address !== "" ? address : null;
}

/**
 * The client IP for the failure limiter.
 *
 * W9230 (W9206-09): `X-Real-IP` / `X-Forwarded-For` used to be trusted
 * UNCONDITIONALLY. Both are ordinary request headers, so an attacker could send
 * a fresh value per request and never fill the `ip:` bucket — the per-IP limit
 * was decorative — or, in the other direction, name a VICTIM's address to lock
 * that victim out. They are now honoured ONLY when the request actually arrived
 * from a loopback peer (the documented nginx front, which terminates the
 * connection on the same host). Any other peer is bucketed by its own socket
 * address, which it cannot forge.
 *
 * A peer that exposes no socket at all (an in-process test harness, a future
 * adapter) keeps the historical single `local` bucket: the limiter still works,
 * it is just shared, which is exactly the pre-W9206 behaviour.
 */
function clientIp(c: Context): string {
  const peer = peerAddress(c);
  if (peer === null) return "local";
  // W9230: reuse the ONE address test (auth/api-token.ts) rather than a second
  // prefix check — a socket address and a --bind value must agree on what
  // "loopback" means.
  if (!isLoopbackBind(peer)) return peer;
  const real = c.req.header("x-real-ip");
  if (real !== undefined && real.trim() !== "") return real.trim();
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded !== undefined) {
    const first = forwarded.split(",")[0]?.trim();
    if (first !== undefined && first !== "") return first;
  }
  return peer;
}

/**
 * B7-4: these two builders go through `c`, never `new Response(...)` directly.
 *
 * Hono merges the headers prepared on the Context into the response through
 * the `c.res =` setter, so a handler that RETURNS a bare `new Response()`
 * silently bypasses every middleware header. That is not theoretical: these
 * two functions are how `/login` and `/auth/check` answer, and with a raw
 * Response the B7-4 security headers never reached them — `x-frame-options`
 * and `x-content-type-options` came back null on the one public HTML surface
 * the audit flagged. The contract of this file (a 200 carries Set-Cookie AND
 * the navigation in the SAME response, never a 302) is unchanged; only the
 * construction path is.
 */
function pageResponse(c: Context, body: string, status: number, extra: Record<string, string> = {}): Response {
  for (const [key, value] of Object.entries({ "content-type": HTML, "cache-control": NO_STORE, ...extra })) {
    c.header(key, value);
  }
  return c.newResponse(body, status as never);
}

function jsonResponse(c: Context, body: unknown, status: number, extra: Record<string, string> = {}): Response {
  for (const [key, value] of Object.entries({
    "content-type": "application/json; charset=utf-8",
    "cache-control": NO_STORE,
    ...extra,
  })) {
    c.header(key, value);
  }
  return c.newResponse(JSON.stringify(body), status as never);
}

function warn(message: string): void {
  process.stderr.write(`studio auth: ${message}\n`);
}
