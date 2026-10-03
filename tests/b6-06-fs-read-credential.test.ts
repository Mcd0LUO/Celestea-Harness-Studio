/**
 * B6-06 — `GET /api/fs/read` returned any absolute path verbatim, which made it a
 * plaintext bypass around `GET /api/providers`, whose public view has no
 * `api_key` field at all. providers.json is the one file the data-file contract
 * marks `"secret": true`, and its path is not a secret.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getJson, makeHarness, type StudioHarness } from "../apps/studio/src/harness.test-util.js";
import { CREDENTIAL_FILE_ERROR, isCredentialFile } from "../apps/studio/src/handlers/fs-read.js";

function read(h: StudioHarness, query: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return getJson(h.app, `/api/fs/read?${query}`);
}

describe("B6-06: /api/fs/read refuses a credential file", () => {
  it("refuses the providers file the host is actually configured to use", async () => {
    const h = makeHarness();
    const providersFile = join(h.root, "providers.json");
    const res = await read(h, `path=${encodeURIComponent(providersFile)}`);
    expect(res.status).toBe(400);
    expect(res.body["code"]).toBe("credential_file");
    expect(res.body["error"]).toBe(CREDENTIAL_FILE_ERROR);
    // The key must not appear anywhere in the response body.
    expect(JSON.stringify(res.body)).not.toContain("api_key");
  });

  it("refuses the auth secret file too", async () => {
    const h = makeHarness();
    const res = await read(h, `path=${encodeURIComponent(join(h.root, "studio-auth.secret"))}`);
    expect(res.status).toBe(400);
    expect(res.body["code"]).toBe("credential_file");
  });

  it("refuses a providers.json at ANY path, not just the configured one", async () => {
    const h = makeHarness();
    const other = join(h.root, "nested", "deeper", "providers.json");
    const res = await read(h, `path=${encodeURIComponent(other)}`);
    expect(res.body["code"]).toBe("credential_file");
  });

  it("still serves an ordinary file (the endpoint is not simply disabled)", async () => {
    const h = makeHarness();
    const file = join(h.root, "note.txt");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, "alpha\nbeta\n", "utf8");
    const res = await read(h, `path=${encodeURIComponent(file)}`);
    expect(res.status).toBe(200);
    expect(res.body["kind"]).toBe("text");
    expect(res.body["text"]).toBe("alpha\nbeta\n");
  });

  it("still serves a file whose name merely CONTAINS providers.json", async () => {
    const h = makeHarness();
    const { writeFileSync } = await import("node:fs");
    const file = join(h.root, "my-providers.json.bak");
    writeFileSync(file, "backed up", "utf8");
    const res = await read(h, `path=${encodeURIComponent(file)}`);
    expect(res.status).toBe(200);
    expect(res.body["text"]).toBe("backed up");
  });

  it("isCredentialFile matches by resolved path, so a different spelling still hits", () => {
  const files = {
    providersFile: join("/data", "sub", "..", "providers.json"),
    authSecretFile: join("/data", "studio-auth.secret"),
  };
  expect(isCredentialFile(join("/data", "providers.json"), files)).toBe(true);
  expect(isCredentialFile(join("/data", "sub", "..", "providers.json"), files)).toBe(true);
  expect(isCredentialFile(join("/data", "PROVIDERS.JSON"), files)).toBe(true);
  expect(isCredentialFile(join("/data", "other.json"), files)).toBe(false);
  });
});
