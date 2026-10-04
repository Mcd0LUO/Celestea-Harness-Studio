/**
 * `--self-test`: prove a built desktop app actually works, from the app itself.
 *
 * Why this exists. The interesting failures of a `deno desktop` build are not
 * compile errors — they are packaging errors: the frontend was not staged, the
 * contracts did not travel with the bundle, the extracted resource root is not
 * where the code looks, the server bound but the API 500s. None of those are
 * visible from the host, and by the time a user sees them the app is already in
 * their hands.
 *
 * So the compiled binary takes `--self-test`, boots the real server on the real
 * (auto-allocated) port, and exercises it over HTTP: health, the SPA document,
 * a real hashed asset, and the staged resources on disk. It prints one JSON line
 * and exits non-zero on failure, which makes it a usable release gate:
 *
 *   ./CelesteaStudio --self-test
 */

import { join } from "node:path";
import type { Logger } from "./log.ts";
import type { AppPaths } from "./paths.ts";
import type { StudioServerHandle } from "./studio-api.ts";

export interface SelfTestCheck {
  name: string;
  ok: boolean;
  detail: string;
  /**
   * Whether a failure here fails the whole report. Two checks only mean
   * something inside a compiled binary (the window/tray API and the baked
   * version) — under `deno run` they are reported and not enforced, which is what
   * lets the same `--self-test` gate be used in a source checkout and in a
   * packaged artifact.
   */
  required: boolean;
}

export interface SelfTestReport {
  ok: boolean;
  version: string | null;
  url: string;
  endpointCount: number;
  checks: SelfTestCheck[];
}

export interface SelfTestInput {
  /** Loopback base URL including the trailing slash. */
  url: string;
  handle: StudioServerHandle;
  paths: AppPaths;
  version: string | null;
  /** Result of the boot-time contract gate (already run before the server). */
  contractsVerified: boolean;
  /** The effective release URL (env override or staged), or null when none is set. */
  updateBaseUrl: string | null;
  /** Base64 Ed25519 key when signed manifests are required. */
  updatePublicKey: string;
  log: Logger;
}

function exists(path: string): boolean {
  try {
    return Deno.statSync(path).isFile || Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

/** The first `/assets/...` URL referenced by the SPA document (null if none). */
export function firstAssetHref(html: string): string | null {
  const match = /(?:src|href)="(\/assets\/[^"]+)"/.exec(html);
  return match?.[1] ?? null;
}

export async function runSelfTest(input: SelfTestInput): Promise<SelfTestReport> {
  const { log } = input;
  const base = input.url.endsWith("/") ? input.url : `${input.url}/`;
  const checks: SelfTestCheck[] = [];
  const inDesktop = typeof Deno.BrowserWindow === "function";
  const record = (name: string, ok: boolean, detail: string, required = true): void => {
    checks.push({ name, ok, detail, required });
    log.info(`${ok ? "PASS" : "FAIL"}${required ? "" : " (informational)"} ${name}: ${detail}`);
  };

  record("resources/contracts", exists(join(input.paths.contracts, "endpoints.json")), input.paths.contracts);
  record("resources/frontend", exists(join(input.paths.webdist, "index.html")), input.paths.webdist);
  record("resources/tray-icon", exists(input.paths.trayIcon), input.paths.trayIcon);
  record("contracts-gate", input.contractsVerified, "verifyContractsAtStartup() completed");
  record(
    "endpoint-table",
    input.handle.endpointCount > 0,
    `${input.handle.endpointCount} contract endpoints registered`,
  );

  try {
    const response = await fetch(`${base}api/health`, { signal: AbortSignal.timeout(10_000) });
    const body = (await response.json()) as Record<string, unknown>;
    record("http/api-health", response.ok, `HTTP ${response.status} ${JSON.stringify(body).slice(0, 160)}`);
  } catch (error) {
    record("http/api-health", false, error instanceof Error ? error.message : String(error));
  }

  let html = "";
  try {
    const response = await fetch(base, { signal: AbortSignal.timeout(10_000) });
    html = await response.text();
    record(
      "http/spa-document",
      response.ok && html.includes("<div id="),
      `HTTP ${response.status}, ${html.length} bytes, content-type=${response.headers.get("content-type") ?? "?"}`,
    );
  } catch (error) {
    record("http/spa-document", false, error instanceof Error ? error.message : String(error));
  }

  const href = firstAssetHref(html);
  if (href === null) {
    record("http/static-asset", false, "the served document references no /assets/ URL");
  } else {
    try {
      const response = await fetch(`${base}${href.replace(/^\//, "")}`, { signal: AbortSignal.timeout(10_000) });
      record("http/static-asset", response.ok, `${href} -> HTTP ${response.status}`);
    } catch (error) {
      record("http/static-asset", false, `${href}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  record(
    "desktop-runtime",
    inDesktop,
    inDesktop ? "BrowserWindow/Tray available" : "plain deno run (no window/tray)",
    inDesktop,
  );
  record(
    "version",
    input.version !== null,
    input.version === null ? "no version baked in (auto-update will be a no-op)" : `v${input.version}`,
    inDesktop,
  );
  // REPORTED, NOT ENFORCED. "No release URL" is a legitimate configuration — a
  // self-hosted build, a dev build, a first release before any host exists — and
  // the app is fully functional without updates. Failing the self-test for it
  // would make the gate unusable exactly where it is most useful (a build that
  // must prove it runs), so it is loud but informational.
  record(
    "update-source",
    input.updateBaseUrl !== null,
    input.updateBaseUrl === null
      ? "NOT configured: auto-update is disabled (set CELESTEA_DESKTOP_UPDATE_URL, desktop-settings.json, or rebuild with --update-url)"
      : `${input.updateBaseUrl}${input.updatePublicKey === "" ? " (unsigned manifests)" : " (signed manifests required)"}`,
    false,
  );

  return {
    ok: checks.filter((check) => check.required).every((check) => check.ok),
    version: input.version,
    url: base,
    endpointCount: input.handle.endpointCount,
    checks,
  };
}
