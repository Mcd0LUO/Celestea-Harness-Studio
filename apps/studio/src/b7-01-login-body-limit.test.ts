/**
 * B7-1 (audit round 3) — `POST /auth/login` has the request-body ceiling that
 * W9230 already gave every other POST.
 *
 * The defect: the `DEFAULT_JSON_BODY_BYTES` note in `handlers/common.ts`
 * (W9230's own comment) names this route as one of the two the ceiling was
 * written FOR — "an unauthenticated
 * `/auth/login` (not under the token gate) ... could be handed an arbitrarily
 * large body and OOM the process" — but login never routes through
 * `readJsonBody` (it also has to accept a urlencoded FORM post), so it read
 * the body itself and the ceiling never reached it. Measured on a live
 * listener before the fix: a 64 MiB form body was buffered in full
 * (heap +30.6 MiB, no 413) while the same bytes on `POST /api/config` were
 * refused 413.
 *
 * What is pinned here (each case is a distinct way the ceiling must hold):
 *   ① a DECLARED over-length body is refused 413 before it is buffered;
 *   ② an UNDECLARED (chunked) over-length body is still caught after the read;
 *   ③ a forged short `content-length` does not buy a bypass (the post-read
 *      re-check is the half that catches it);
 *   ④ a LEGITIMATE body is untouched — no regression in the happy path;
 *   ⑤ an over-length body is NOT charged to the failure limiter, so one
 *      oversized request cannot lock a real user out of the login form.
 *
 * None of these need `htpasswd`: the ceiling is reached BEFORE the password
 * check runs, which is exactly the property being pinned.
 */

import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type StudioHarness } from "./harness.test-util.js";

const harnesses: StudioHarness[] = [];

function harness(): StudioHarness {
  const h = makeHarness({ paths: { authHtpasswdFile: "/nonexistent/htpasswd-studio" } });
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const MB = 1024 * 1024;
const FORM = "application/x-www-form-urlencoded";
const JSON_CT = { "content-type": "application/json", accept: "application/json" };

/** A urlencoded login body whose password alone is `size` bytes. */
function formBody(size: number): string {
  return "username=someone&password=" + "a".repeat(size);
}

describe("B7-1 · /auth/login refuses an over-length body with 413", () => {
  it("① a declared over-length body is refused 413 (form post)", async () => {
    const res = await harness().app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": FORM, accept: "application/json" },
      body: formBody(MB + 4096),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("1048576-byte limit");
  });

  it("① the same holds for a JSON login body", async () => {
    const res = await harness().app.request("/auth/login", {
      method: "POST",
      headers: JSON_CT,
      body: JSON.stringify({ username: "someone", password: "a".repeat(MB + 4096) }),
    });
    expect(res.status).toBe(413);
  });

  it("② an UNDECLARED over-length body (no content-length) is still caught after the read", async () => {
    // A Request always derives a content-length from its body, so the declared
    // header is explicitly suppressed here to exercise the post-read half.
    const oversized = formBody(MB + 4096);
    const h = harness();
    const headers = new Headers({ "content-type": FORM, accept: "application/json" });
    headers.delete("content-length");
    const r = await h.app.fetch(
      new Request("http://local/auth/login", { method: "POST", headers, body: oversized }),
    );
    expect(r.status).toBe(413);
  });

  it("③ a forged short content-length does not buy a bypass", async () => {
    const h = harness();
    // Declared 10 bytes, actually >1 MiB: only the post-read re-check can see it.
    const r = await h.app.fetch(
      new Request("http://local/auth/login", {
        method: "POST",
        headers: { "content-type": FORM, accept: "application/json", "content-length": "10" },
        body: formBody(MB + 4096),
      }),
    );
    expect(r.status).toBe(413);
  });

  it("④ a legitimate small body is NOT refused (no happy-path regression)", async () => {
    const h = harness();
    const r = await h.app.fetch(
      new Request("http://local/auth/login", {
        method: "POST",
        headers: { "content-type": FORM, accept: "application/json" },
        body: "username=someone&password=correct%20horse",
      }),
    );
    // The password file is deliberately absent, so a well-formed body passes the
    // CEILING and fails the CREDENTIAL check instead (500, never 413).
    expect(r.status).not.toBe(413);
    expect(r.status).toBe(500);
  });

  it("⑤ an over-length body is not charged to the failure limiter", async () => {
    const h = harness();
    const post = (body: string) =>
      h.app.fetch(
        new Request("http://local/auth/login", {
          method: "POST",
          headers: { "content-type": FORM, accept: "application/json" },
          body,
        }),
      );
    // Hammer the ceiling far more than AUTH_MAX_FAILURES times...
    for (let i = 0; i < 12; i += 1) expect((await post(formBody(MB + 4096))).status).toBe(413);
    // ...then a real credential attempt must NOT be answered 429 (the limiter
    // stayed clean). The password file is absent on purpose, so the credential
    // check itself errors 500 — what matters here is that it is REACHED.
    const r = await post("username=someone&password=wrong");
    expect(r.status).not.toBe(429);
    expect(r.status).toBe(500);
  });
});
