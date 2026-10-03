/**
 * W9 acceptance at the HTTP surface: the six permission endpoints.
 *
 * B5-01 (P0) adds the confirmation gate on PUT /api/sessions/{id}/permission.
 * The gate is the grants one-shot handshake (same GrantTokenStore, same HttpOnly
 * nonce cookie, same 60s TTL, same rate limiter, same audit channel), with the
 * TARGET PRESET bound into the token so a token minted for one preset cannot
 * install another.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getJson, jsonRequest, makeHarness, type StudioHarness } from "./harness.test-util.js";

const S1 = "sample-ws%2Fs1";
const harnesses: StudioHarness[] = [];

function open(env?: Record<string, string>): StudioHarness {
  const h = makeHarness({ session: { name: "s1", log: "" }, ...(env === undefined ? {} : { env }) });
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const preset = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  label: id,
  network: false,
  workspaceWritable: false,
  toolRootsWritable: false,
  writeRoots: [],
  unsandboxed: false,
  toolDeny: ["write_file"],
  ...over,
});

/** The exact binding the handler hashes (B5-01: the PRESET, not a free scope). */
const scopeHashOf = (target: string): string =>
  createHash("sha256").update(JSON.stringify({ cap: "permission", scope: { preset: target } })).digest("hex");

/**
 * Drive the browser half of the handshake: mint a one-shot token for one preset
 * and keep the HttpOnly nonce cookie a real browser would hold.
 */
async function confirmPermission(h: StudioHarness, target: string, id = S1): Promise<{ token: string; cookie: string }> {
  const res = await h.app.request(
    `/api/sessions/${id}/permission/confirm-token?preset=${target}&scope_hash=${scopeHashOf(target)}`,
    { headers: { "sec-fetch-site": "same-origin" } },
  );
  const body = JSON.parse(await res.text()) as { token?: string };
  const setCookie = res.headers.get("set-cookie");
  return { token: body.token ?? "", cookie: (setCookie ?? "").split(";")[0] ?? "" };
}

/** A PUT carrying a minted confirmation, exactly as the UI would send it. */
function confirmedPut(minted: { token: string; cookie: string }, body: unknown): RequestInit {
  return {
    method: "PUT",
    headers: { "content-type": "application/json", "x-celestea-grant-confirm": minted.token, cookie: minted.cookie },
    body: JSON.stringify(body),
  };
}

/**
 * The preset the sidecar on disk records, or `null` when none was written.
 *
 * B5-01: the GET endpoint answers the EFFECTIVE baseline, which falls back to
 * the deployment default when no sidecar exists — so a refused PUT must be
 * proved by the FILE, not by the GET (otherwise a harness that defaults to
 * full-access would make every assertion vacuous).
 */
function storedPreset(h: StudioHarness): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(h.workspace, "s1", "permission.json"), "utf8")) as { preset?: string };
    return typeof raw.preset === "string" ? raw.preset : null;
  } catch {
    return null;
  }
}

/** Every audit line written so far (the LOCAL channel is the authoritative one). */
function auditLines(h: StudioHarness): string[] {
  try {
    return readFileSync(join(h.root, "grants-audit.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "");
  } catch {
    return [];
  }
}

describe("W9 /api/permissions/presets", () => {
  it("lists the three built-ins and creates/updates/deletes a custom preset", async () => {
    const h = open();
    const first = await getJson(h.app, "/api/permissions/presets");
    expect(first.body["ok"]).toBe(true);
    expect((first.body["builtin"] as unknown[]).map((p) => (p as { id: string }).id)).toEqual(["read-only", "write-read", "full-access"]);
    expect(first.body["custom"]).toEqual([]);

    const created = await getJson(h.app, "/api/permissions/presets", jsonRequest("POST", { preset: preset("team-ro") }));
    expect(created.status).toBe(200);
    expect((created.body["preset"] as { id: string }).id).toBe("team-ro");

    const dup = await getJson(h.app, "/api/permissions/presets", jsonRequest("POST", { preset: preset("team-ro") }));
    expect(dup.status).toBe(409);

    const builtin = await getJson(h.app, "/api/permissions/presets", jsonRequest("POST", { preset: preset("read-only") }));
    expect(builtin.status).toBe(409);

    const updated = await getJson(h.app, "/api/permissions/presets/team-ro", jsonRequest("PUT", { preset: preset("team-ro", { workspaceWritable: true, toolDeny: [] }) }));
    expect(updated.status).toBe(200);
    expect((updated.body["preset"] as { workspaceWritable: boolean }).workspaceWritable).toBe(true);

    const del = await getJson(h.app, "/api/permissions/presets/team-ro", jsonRequest("DELETE"));
    expect(del.status).toBe(200);
    expect(del.body["deleted"]).toBe("team-ro");
    const after = await getJson(h.app, "/api/permissions/presets");
    expect(after.body["custom"]).toEqual([]);
  });
});

describe("W9 /api/sessions/{id}/permission", () => {
  it("defaults to full-access and reports the effective baseline", async () => {
    const h = open();
    const def = await getJson(h.app, `/api/sessions/${S1}/permission`);
    expect(def.status).toBe(200);
    expect(def.body["preset"]).toBe("full-access");
    expect((def.body["effective"] as { network: boolean }).network).toBe(true);

    const unknown = await getJson(h.app, `/api/sessions/${S1}/permission`, jsonRequest("PUT", { preset: "nope" }));
    expect(unknown.status).toBe(422);
  });

  it("persists a confirmed preset and reports the narrowed capabilities", async () => {
    const h = open();
    const minted = await confirmPermission(h, "read-only");
    const set = await getJson(h.app, `/api/sessions/${S1}/permission`, confirmedPut(minted, { preset: "read-only" }));
    expect(set.status).toBe(200);

    const ro = await getJson(h.app, `/api/sessions/${S1}/permission`);
    expect(ro.body["preset"]).toBe("read-only");
    const eff = ro.body["effective"] as { network: boolean; workspaceWritable: boolean; toolDeny: string[] };
    expect(eff.network).toBe(false);
    expect(eff.workspaceWritable).toBe(false);
    expect(eff.toolDeny).toContain("write_file");
  });
});

describe("B5-01 (P0) · a preset change needs a human confirmation", () => {
  it("refuses an unconfirmed PUT (the reported self-escalation)", async () => {
    const h = open({ CELESTEA_PERMISSION_DEFAULT: "read-only" });
    // Exactly the P0 repro: a bare JSON body, no credentials of any kind.
    const res = await getJson(h.app, `/api/sessions/${S1}/permission`, jsonRequest("PUT", { preset: "full-access" }));
    expect(res.status).toBe(403);
    expect(res.body["error"]).toBe("permission confirmation required");
    // AND the escalation did not land: still read-only.
    const after = await getJson(h.app, `/api/sessions/${S1}/permission`);
    expect(after.body["preset"]).toBe("read-only");
    expect((after.body["effective"] as { allPaths: boolean }).allPaths).toBe(false);
  });

  it("refuses a PUT that presents only a forged confirm HEADER (no nonce cookie)", async () => {
    const h = open();
    // W9206-03's lesson, one level up: the header alone is forgeable by
    // http_request, so the HttpOnly nonce is the part that actually binds.
    const res = await getJson(h.app, `/api/sessions/${S1}/permission`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-celestea-grant-confirm": "deadbeef".repeat(8), "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ preset: "full-access" }),
    });
    expect(res.status).toBe(403);
    expect(storedPreset(h)).toBeNull();
  });

  it("will not mint a token without same-origin evidence", async () => {
    const h = open();
    const res = await h.app.request(`/api/sessions/${S1}/permission/confirm-token?preset=full-access&scope_hash=${scopeHashOf("full-access")}`, {
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
    const body = JSON.parse(await res.text()) as { token?: string };
    expect(body.token).toBeUndefined();
  });

  it("binds the token to ONE preset: a read-only token cannot install full-access", async () => {
    const h = open();
    const mintedForReadOnly = await confirmPermission(h, "read-only");
    const res = await getJson(h.app, `/api/sessions/${S1}/permission`, confirmedPut(mintedForReadOnly, { preset: "full-access" }));
    expect(res.status).toBe(403);
    expect(storedPreset(h)).toBeNull();
  });

  it("burns the token: a replay of the same confirmation is refused", async () => {
    const h = open();
    const minted = await confirmPermission(h, "read-only");
    const first = await getJson(h.app, `/api/sessions/${S1}/permission`, confirmedPut(minted, { preset: "read-only" }));
    expect(first.status).toBe(200);
    const replay = await getJson(h.app, `/api/sessions/${S1}/permission`, confirmedPut(minted, { preset: "read-only" }));
    expect(replay.status).toBe(409);
    expect(replay.body["error"]).toBe("confirmation token already used");
  });

  it("leaves an audit trail for both the refusal and the success", async () => {
    const h = open();
    await getJson(h.app, `/api/sessions/${S1}/permission`, jsonRequest("PUT", { preset: "full-access" }));
    const minted = await confirmPermission(h, "read-only");
    await getJson(h.app, `/api/sessions/${S1}/permission`, confirmedPut(minted, { preset: "read-only" }));
    const events = auditLines(h).map((l) => JSON.parse(l) as { event: string; cap?: string; reason?: string; scope?: unknown });
    expect(events.some((e) => e.event === "deny" && e.cap === "permission")).toBe(true);
    expect(events.some((e) => e.event === "grant" && e.cap === "permission")).toBe(true);
  });

  it("fails closed on CELESTEA_PERMISSION_MAX: cannot escalate past the ceiling", async () => {
    const h = open({ CELESTEA_PERMISSION_MAX: "read-only" });
    // A fully CONFIRMED change is still refused when it widens past the ceiling.
    const minted = await confirmPermission(h, "full-access");
    const res = await getJson(h.app, `/api/sessions/${S1}/permission`, confirmedPut(minted, { preset: "full-access" }));
    expect(res.status).toBe(403);
    expect(String(res.body["error"])).toContain("exceeds the deployment ceiling");
    // Nothing was persisted, and the effective baseline is still clamped.
    expect(storedPreset(h)).toBeNull();
    const after = await getJson(h.app, `/api/sessions/${S1}/permission`);
    expect((after.body["effective"] as { allPaths: boolean }).allPaths).toBe(false);
  });

  it("still allows a NARROWING change under a read-only ceiling", async () => {
    const h = open({ CELESTEA_PERMISSION_MAX: "read-only" });
    const minted = await confirmPermission(h, "read-only");
    const res = await getJson(h.app, `/api/sessions/${S1}/permission`, confirmedPut(minted, { preset: "read-only" }));
    expect(res.status).toBe(200);
  });
});

describe("W9 preset writeRoots validation", () => {
  it("rejects a preset whose writeRoots are not a usable absolute directory", async () => {
    const h = open();
    const rel = await getJson(h.app, "/api/permissions/presets", jsonRequest("POST", { preset: preset("bad-one", { writeRoots: ["relative/x"] }) }));
    expect(rel.status).toBe(422);
    const root = await getJson(h.app, "/api/permissions/presets", jsonRequest("POST", { preset: preset("bad-two", { writeRoots: ["/"] }) }));
    expect(root.status).toBe(422);
  });
});
