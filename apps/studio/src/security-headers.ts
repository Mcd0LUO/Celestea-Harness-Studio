/**
 * B7-4 (audit round 3) — the baseline HTTP security response headers.
 *
 * The defect: the host answered EVERY request with `content-type` and
 * `cache-control` and nothing else. `GET /login` (the one HTML surface) and
 * every static asset went out with no `X-Content-Type-Options`,
 * `X-Frame-Options`, `Referrer-Policy` and no `Content-Security-Policy`.
 *
 * Severity framing, honestly: on the DEFAULT deployment (loopback, no
 * reverse proxy) none of the three is exploitable — no third-party page can
 * frame `127.0.0.1:3778`, and there is no attacker-controlled content on the
 * host to inject. They become real on the deployment this repo explicitly
 * supports and documents: `--bind 0.0.0.0 --token …` (see
 * `InsecureBindError`, which walks the operator toward exactly that) and the
 * nginx-fronted public host (`DEFAULT_AUTH_HTPASSWD_FILE`,
 * handlers/auth.ts's `auth_request` gate). There, `/login` is a PUBLIC page
 * and none of these headers were set.
 *
 * Why each one, and why the value:
 *
 *  - `x-content-type-options: nosniff` — `static.ts` maps `.txt` to
 *    `text/plain` and the SPA fallback serves `index.html` for extension-less
 *    paths. Without nosniff a browser may MIME-sniff a response into
 *    something executable. One header, no downside, no compatibility risk.
 *
 *  - `x-frame-options: DENY` — the login form has no CSRF token, so framing it
 *    is a clickjacking primitive with a very low attacker cost. `DENY` rather
 *    than `SAMEORIGIN`: nothing in this app ever frames itself.
 *
 *  - `referrer-policy: no-referrer` — session ids appear in the URL
 *    (`/api/sessions/{id}/…`) and the UI is served from the same origin as the
 *    API, so a full referrer hands any outbound link the session id. This host
 *    never needs a referrer.
 *
 *  - `content-security-policy` — the real defence, and the reason the other
 *    three are only a floor. `default-src 'self'` with no `unsafe-eval` and no
 *    wildcards.
 *
 * ## Why the two allowances below are load-bearing, not slack
 *
 * Both were read out of the SHIPPED `apps/web/dist` (measured, not guessed):
 *
 *  - `'unsafe-inline'` in `script-src`: `dist/index.html` carries an inline
 *    `<script>window.__CELESTEA_BUILD__ = {…}</script>` build stamp. A strict
 *    `script-src 'self'` would refuse to execute it and the version badge would
 *    silently lose its data.
 *  - `img-src 'self' data:`: the favicon is a `data:image/svg+xml,…` URI, and
 *    the UI also renders inline user-supplied images (attachments).
 *
 * `'unsafe-inline'` is a real weakening, so it is scoped to `script-src` only
 * and is called out here: the alternative (hashing the build stamp, or moving
 * it to a JSON endpoint) is a frontend build change, and this batch is not
 * allowed to rebuild `apps/web`. The hash route is the correct follow-up and
 * is recorded as such rather than being silently skipped.
 *
 * No `frame-ancestors` / `upgrade-insecure-requests` / HSTS: `frame-ancestors`
 * would duplicate `X-Frame-Options` for modern browsers only, and the last two
 * are meaningless (and `upgrade-insecure-requests` actively harmful) on a host
 * that is frequently reached over plain HTTP on a LAN.
 */
import type { MiddlewareHandler } from "hono";

/**
 * The policy itself, exported so a test can assert against the exact string
 * rather than re-typing it (a copy in the test would drift silently).
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // The build stamp in dist/index.html is an inline <script>; see the header.
  "script-src 'self' 'unsafe-inline'",
  // KaTeX/MathML and the workbench terminal ship no remote assets, but they do
  // build styles at runtime, hence style-src 'unsafe-inline'.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // The UI talks to exactly two things: the API on this origin, and the
  // EventSource on this origin. `connect-src` therefore stays 'self' and no
  // provider endpoint is ever reachable from a page (the server does that
  // server-side, which is the point of the proxy design).
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

/** The always-on baseline. None of these can break a legitimate client. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": CONTENT_SECURITY_POLICY,
};

/**
 * Apply the baseline to every response.
 *
 * Mounted FIRST in `createStudioApp` so it also covers the responses that
 * never pass through a named handler — the static/SPA catch-all, the
 * `/api/*` 404, the login page and the SSE stream.
 *
 * Why setting them here is safe for every one of those: Hono MERGES the
 * headers prepared on the context into whatever Response a handler returns
 * (`new Headers(this.#res.headers)` in `Context#newResponse`), including a
 * pre-built one. That matters for `GET /api/events`, whose handler builds its
 * `Response` from a stream and then returns it — prepared headers still land
 * on it. The SSE contract is therefore untouched: the stream keeps its
 * `text/event-stream` content type, its `cache-control: no-cache` and its
 * chunked transfer, and the only additions are four inert headers.
 */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) c.header(key, value);
    await next();
  };
}
