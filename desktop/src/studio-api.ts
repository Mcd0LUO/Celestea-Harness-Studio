/**
 * The ONE seam between this shell and the studio.
 *
 * `app/celestea-server.mjs` is an esbuild bundle of the real `@celestea/studio`
 * server (see `scripts/bundle-server.mjs`). It is imported dynamically because
 * the bundle is a build artifact: a fresh checkout has no such file, and the
 * failure has to be a readable "build it first" message rather than a module
 * resolution stack trace. The interfaces below are hand-written for the same
 * reason the desktop API declarations are: the bundle ships no types, so the
 * contract is stated here once and CHECKED at load time
 * (`assertStudioModule`) — a bundle whose shape drifted fails loudly at boot
 * instead of midway through a user's session.
 */

import { pathToFileURL } from "node:url";

/** The pieces of `StudioConfig` this shell reads or overrides. */
export interface StudioConfig {
  bind: string;
  apiKeyEnv: string;
  authToken: string | null;
  paths: {
    workspacesFile: string;
    providersFile: string;
    promptsFile: string;
    staticRoot: string;
    authSecretFile: string;
    authHtpasswdFile: string;
  };
}

export interface StudioServerOptions {
  port: number;
  hostname: string;
  config?: StudioConfig;
  env?: Record<string, string | undefined>;
  /** Emit the studio's startup banner (default true). */
  log?: boolean;
  /** Install the server's last-resort uncaught-error net (default true). */
  crashNet?: boolean;
  onListening?: (info: { port: number; hostname: string; endpointCount: number }) => void;
}

export interface StudioServerHandle {
  readonly port: number;
  readonly hostname: string;
  readonly endpointCount: number;
  /** Resolves once the socket is bound and the REAL port is known. */
  readonly listening: Promise<{ port: number; hostname: string }>;
  /** The studio's W742 teardown: drain, flush grants audit, engine down. */
  stop(signal: string): Promise<void>;
}

export interface StudioPathOverrides {
  workspacesFile?: string;
  providersFile?: string;
  promptsFile?: string;
  staticRoot?: string;
}

export interface OpenBrowserResult {
  opened: boolean;
  reason?: string;
}

export interface StudioModule {
  verifyContractsAtStartup(): void;
  celesteaHome(input?: { env?: Record<string, string | undefined> }): string;
  loadStudioConfig(input?: { env?: Record<string, string | undefined>; paths?: StudioPathOverrides }): StudioConfig;
  startStudioServer(options: StudioServerOptions): StudioServerHandle;
  /**
   * The CLI's fire-and-forget opener, still exported by the bundle. The desktop
   * shell no longer calls it: it cannot tell whether a browser actually opened
   * (see `src/open-target.ts`), and a GUI app's only feedback is its own claim.
   * Kept in the contract because the bundle ships it and dropping it would make
   * older/newer bundles diverge for no gain.
   */
  openBrowser(url: string): OpenBrowserResult;
}

const REQUIRED: readonly (keyof StudioModule)[] = [
  "verifyContractsAtStartup",
  "celesteaHome",
  "loadStudioConfig",
  "startStudioServer",
  "openBrowser",
];

/** Fail early and by name when the bundle does not match this shell's contract. */
export function assertStudioModule(candidate: unknown): StudioModule {
  const missing = REQUIRED.filter((name) => typeof (candidate as Record<string, unknown> | null)?.[name] !== "function");
  if (missing.length > 0) {
    throw new Error(
      `the bundled studio server does not export ${missing.join(", ")} — ` +
        "the shell and the bundle are out of sync; rebuild with node desktop/scripts/bundle-server.mjs",
    );
  }
  return candidate as StudioModule;
}

/**
 * Import the bundle from an absolute path. `Deno.statSync` runs first so the
 * common "forgot to build" case produces our message, not Deno's.
 */
export async function loadStudioModule(bundlePath: string): Promise<StudioModule> {
  try {
    if (!Deno.statSync(bundlePath).isFile) throw new Error("not a file");
  } catch {
    throw new Error(`the studio server bundle is missing at ${bundlePath} — run: node desktop/scripts/build.mjs`);
  }
  // pathToFileURL, not string concatenation: the same code has to work on
  // Windows, where "C:\..." is not a valid import specifier.
  return assertStudioModule(await import(pathToFileURL(bundlePath).href));
}
