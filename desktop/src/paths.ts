/**
 * Where the desktop shell's own files live, and which port it must serve on.
 *
 * Two facts drive this module:
 *
 * 1. `deno desktop` does not run from the project directory. The compiled
 *    binary extracts its embedded virtual filesystem to a temporary root and
 *    rewrites module URLs into it, so `Deno.cwd()` (the user's shell) and
 *    `Deno.execPath()` (the launcher) are both the WRONG base for finding
 *    assets. `import.meta.dirname` is the one stable anchor, and the relative
 *    layout around it is preserved by the bundler — this module resolves the
 *    resource root from there and validates the result instead of assuming it.
 *
 * 2. Inside a desktop build the runtime picks a free loopback port BEFORE the
 *    program runs and publishes it as `DENO_SERVE_ADDRESS`; the webview
 *    navigates to that exact port. The studio server therefore has to bind to
 *    it (see `desktopServePort`). Outside a desktop build the same entry point
 *    is a normal headless server, so an explicit port is used instead.
 */

import { dirname, join, resolve } from "node:path";

/** Thrown when the staged resources are missing — the message says what to run. */
export class DesktopResourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopResourceError";
  }
}

export interface AppPaths {
  /** The desktop project root (the directory holding `deno.json`). */
  root: string;
  /** The staged resource directory: server bundle + webdist + contracts + icons. */
  appRoot: string;
  /** The esbuild bundle of `@celestea/studio` (`scripts/bundle-server.mjs`). */
  serverBundle: string;
  /** The built Vite frontend, served by the studio server. */
  webdist: string;
  /** The frozen contracts, read at boot by `verifyContractsAtStartup()`. */
  contracts: string;
  /** Tray icon (PNG bytes are read at runtime; it is not a path for the OS). */
  trayIcon: string;
  /** Optional Ed25519 release public key (base64), staged from the repo. */
  updatePubKeyFile: string;
  /** Staged release facts `{ version, baseUrl }` — the shell's copy of what
   * `deno desktop` baked in (see scripts/stage.mjs for why both exist). */
  releaseInfo: string;
}

/** Candidate resource roots, most specific first. Pure so the order is testable. */
export function appRootCandidates(moduleDir: string, execPath: string, env: Record<string, string | undefined>): string[] {
  const candidates: string[] = [];
  const override = (env["CELESTEA_DESKTOP_APP"] ?? "").trim();
  if (override !== "") candidates.push(resolve(override));
  candidates.push(resolve(moduleDir, ".."));
  candidates.push(resolve(moduleDir, "..", ".."));
  candidates.push(dirname(resolve(execPath)));
  return [...new Set(candidates)];
}

function hasBundle(dir: string): boolean {
  try {
    return Deno.statSync(join(dir, "app", "celestea-server.mjs")).isFile;
  } catch {
    return false;
  }
}

/**
 * Resolve the desktop project root. Throws a `DesktopResourceError` naming every
 * candidate it tried — a missing build is by far the most common failure here and
 * the fix is one command, so the error carries it.
 */
export function resolveAppPaths(env: Record<string, string | undefined> = Deno.env.toObject()): AppPaths {
  const moduleDir = import.meta.dirname ?? dirname(new URL(import.meta.url).pathname);
  const candidates = appRootCandidates(moduleDir, Deno.execPath(), env);
  const root = candidates.find(hasBundle);
  if (root === undefined) {
    throw new DesktopResourceError(
      "desktop resources are not built yet (no app/celestea-server.mjs).\n" +
        `  looked in: ${candidates.join(", ")}\n` +
        "  build them with: node desktop/scripts/build.mjs --skip-deno-build",
    );
  }
  const appRoot = join(root, "app");
  return {
    root,
    appRoot,
    serverBundle: join(appRoot, "celestea-server.mjs"),
    webdist: join(appRoot, "webdist"),
    contracts: join(appRoot, "contracts"),
    trayIcon: join(appRoot, "icons", "tray.png"),
    updatePubKeyFile: join(appRoot, "update-pubkey.txt"),
    releaseInfo: join(appRoot, "release.json"),
  };
}

/**
 * The port the studio server MUST bind to.
 *
 * Desktop build: the runtime's pre-allocated loopback port from
 * `DENO_SERVE_ADDRESS` (`tcp:127.0.0.1:<port>`) — the webview navigates there, so
 * any other port yields a blank window. Headless run: `--port` / the env
 * override / the historical 3778 (which keeps 3777 free for a production
 * instance, the same split `apps/studio/src/main.ts` uses).
 */
export function desktopServePort(
  env: Record<string, string | undefined>,
  fallback: number,
): { port: number; source: "desktop-runtime" | "fallback" } {
  const addr = (env["DENO_SERVE_ADDRESS"] ?? "").trim();
  if (addr !== "") {
    const port = Number.parseInt(addr.slice(addr.lastIndexOf(":") + 1), 10);
    if (Number.isSafeInteger(port) && port > 0 && port < 65_536) return { port, source: "desktop-runtime" };
  }
  const configured = Number.parseInt(env["CELESTEA_DESKTOP_PORT"] ?? "", 10);
  if (Number.isSafeInteger(configured) && configured >= 0 && configured < 65_536) return { port: configured, source: "fallback" };
  return { port: fallback, source: "fallback" };
}

/** True inside a compiled `deno desktop` binary; false under plain `deno run`. */
export function desktopRuntimeAvailable(): boolean {
  return typeof Deno.BrowserWindow === "function";
}

/** The loopback URL the webview (and the browser hand-off) uses. */
export function loopbackUrl(port: number, path = "/"): string {
  return `http://127.0.0.1:${port}${path}`;
}

/** The `os-arch` label used for release/update directories, e.g. `linux-x64`. */
export function platformSlug(os: string = Deno.build.os, arch: string = Deno.build.arch): string {
  const osLabel = os === "darwin" ? "macos" : os;
  const archLabel = arch === "x86_64" ? "x64" : arch === "aarch64" ? "arm64" : arch;
  return `${osLabel}-${archLabel}`;
}

/**
 * The update URL this build polls: `<baseUrl>/<os-arch>`.
 *
 * A patch is a bsdiff of the RUNTIME LIBRARY, so it is per OS and per
 * architecture — one shared patch across platforms cannot exist (the docs:
 * "generate patches per-architecture … serve the right manifest based on
 * user-agent, or include all patches under architecture-specific keys"). The
 * documented pattern is the per-architecture directory used here, which also
 * means one upload directory per platform under `release/`.
 *
 * Idempotent: a base URL that already ends in the platform slug is left alone, so
 * pointing CELESTEA_DESKTOP_UPDATE_URL straight at a platform directory works too.
 */
export function updateUrlFor(baseUrl: string, os: string = Deno.build.os, arch: string = Deno.build.arch): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const slug = platformSlug(os, arch);
  return base.endsWith(`/${slug}`) ? base : `${base}/${slug}`;
}

/**
 * Resolve the effective release base URL. The operator's environment wins, then
 * the settings file (so a self-hosted install needs no rebuild), then the value
 * baked at compile time — which is null unless the builder passed `--update-url`.
 */
export function resolveUpdateBaseUrl(input: {
  env: Record<string, string | undefined>;
  settings?: { updateBaseUrl?: unknown };
  baked: string | null;
}): { baseUrl: string | null; source: "env" | "settings" | "baked" | "none" } {
  const fromEnv = (input.env["CELESTEA_DESKTOP_UPDATE_URL"] ?? "").trim();
  if (fromEnv !== "") return { baseUrl: fromEnv, source: "env" };
  const fromSettings = typeof input.settings?.updateBaseUrl === "string" ? input.settings.updateBaseUrl.trim() : "";
  if (fromSettings !== "") return { baseUrl: fromSettings, source: "settings" };
  if (input.baked !== null && input.baked.trim() !== "") return { baseUrl: input.baked.trim(), source: "baked" };
  return { baseUrl: null, source: "none" };
}

/** Absolute path of the shell's runtime settings file (update source, etc.). */
export function desktopSettingsFile(home: string): string {
  return join(home, "desktop-settings.json");
}

/** Absolute path of the desktop shell's own log file inside the data directory. */
export function desktopLogFile(home: string): string {
  return join(home, "desktop.log");
}
