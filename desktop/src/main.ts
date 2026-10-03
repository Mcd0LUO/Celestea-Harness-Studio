/**
 * Celestea Studio — the desktop entry point (`deno desktop src/main.ts`).
 *
 * There is exactly ONE entry point for three ways to run the studio, because a
 * second one would drift:
 *
 *   deno desktop src/main.ts   compiled app: window + tray + auto-update
 *   deno run -A src/main.ts    headless: the same server, no window (dev/CI)
 *   --self-test                boot, exercise the packaged app over HTTP, exit
 *
 * The desktop shell owns nothing of the product: sessions, workspaces, tools,
 * permissions and the HTTP API all come from `@celestea/studio` (bundled into
 * `app/celestea-server.mjs`). What the shell owns is the part a server does not
 * have — a window pointed at the loopback port the desktop runtime allocated, a
 * tray that keeps the app alive after the window is closed, and the update
 * status a long-running app must be able to show.
 */

import { join } from "node:path";
import { DICTS, resolveLang, type Copy } from "./i18n.ts";
import { createLogger, type Logger } from "./log.ts";
import { alertBlocking, notify } from "./notify.ts";
import {
  desktopLogFile,
  desktopSettingsFile,
  resolveUpdateBaseUrl,
  updateUrlFor,
  desktopRuntimeAvailable,
  desktopServePort,
  loopbackUrl,
  resolveAppPaths,
  type AppPaths,
} from "./paths.ts";
import { runSelfTest } from "./self-test.ts";
import { acquireInstanceLock, type InstanceCommand, type InstanceLock } from "./single-instance.ts";
import { loadStudioModule, type StudioModule, type StudioServerHandle } from "./studio-api.ts";
import { installApplicationMenu } from "./app-menu.ts";
import { openTarget } from "./open-target.ts";
import { createTray, type TrayHandle } from "./tray.ts";
import { createUpdater, updateLine } from "./updater.ts";
import { DEFAULT_WINDOW, loadWindowState, saveWindowState } from "./window-state.ts";

const APP_TITLE = "Celestea Studio";
/** Kept free of the production 3777, the same split `apps/studio/src/main.ts` makes. */
const DEFAULT_PORT = 3778;
/** Hourly: the documented sane interval — frequent enough, not wasteful. */
const UPDATE_INTERVAL_MS = 60 * 60 * 1000;
/** How long a bind is allowed to take before the shell calls it a failure. */
const LISTEN_TIMEOUT_MS = 20_000;
const WINDOW_STATE_FILE = "desktop-window.json";

export interface CliOptions {
  port: number | null;
  selfTest: boolean;
  /** Quit from inside the app after N ms — a deterministic smoke-test aid. */
  exitAfterMs: number | null;
  /** Run one update check, print the result, exit (ops + CI diagnostics). */
  checkUpdates: boolean;
  help: boolean;
}

/** Parse the flags the shell understands; unknown flags are ignored on purpose. */
export function parseCli(args: readonly string[]): CliOptions {
  let port: number | null = null;
  let selfTest = false;
  let exitAfterMs: number | null = null;
  let checkUpdates = false;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--self-test") selfTest = true;
    else if (arg === "--check-updates") checkUpdates = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--port") port = validPort(args[++i]) ?? port;
    else if (arg.startsWith("--port=")) port = validPort(arg.slice("--port=".length)) ?? port;
    else if (arg === "--exit-after-ms") exitAfterMs = validMs(args[++i]) ?? exitAfterMs;
    else if (arg.startsWith("--exit-after-ms=")) exitAfterMs = validMs(arg.slice("--exit-after-ms=".length)) ?? exitAfterMs;
  }
  return { port, selfTest, exitAfterMs, checkUpdates, help };
}

function validPort(raw: string | undefined): number | null {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isSafeInteger(value) && value >= 0 && value < 65_536 ? value : null;
}

/** Milliseconds for `--exit-after-ms` (any sane duration, not a port number). */
function validMs(raw: string | undefined): number | null {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isSafeInteger(value) && value >= 0 && value <= 86_400_000 ? value : null;
}

function exists(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

export interface ReleaseInfo {
  version: string | null;
  /** The URL baked into the binary at compile time, or null. */
  baseUrl: string | null;
}

/**
 * Read the staged release facts. `desktop.release.baseUrl` lives in deno.json,
 * is baked into the binary by `deno desktop`, and is NOT readable from the running
 * program — so `scripts/stage.mjs` writes the same value next to the bundle. A
 * missing or unreadable file is not fatal (updates just stay disabled unless the
 * operator sets CELESTEA_DESKTOP_UPDATE_URL); a malformed one is reported.
 */
export function readReleaseInfo(path: string, log: Logger): ReleaseInfo {
  try {
    const doc = JSON.parse(Deno.readTextFileSync(path)) as { version?: unknown; baseUrl?: unknown };
    return {
      version: typeof doc.version === "string" ? doc.version : null,
      baseUrl: typeof doc.baseUrl === "string" && doc.baseUrl.trim() !== "" ? doc.baseUrl.trim() : null,
    };
  } catch (error) {
    log.warn(`release.json could not be read (${error instanceof Error ? error.message : String(error)}); the update URL comes from the environment only`);
    return { version: null, baseUrl: null };
  }
}

/** The shell's runtime settings (`<data home>/desktop-settings.json`), or {}. */
export function readDesktopSettings(path: string, log: Logger): Record<string, unknown> {
  try {
    const doc = JSON.parse(Deno.readTextFileSync(path)) as unknown;
    return typeof doc === "object" && doc !== null ? (doc as Record<string, unknown>) : {};
  } catch (error) {
    // Absent is the normal case (nothing to configure); unreadable is worth a line.
    if (!(error instanceof Deno.errors.NotFound)) {
      log.warn(`desktop-settings.json could not be read (${error instanceof Error ? error.message : String(error)})`);
    }
    return {};
  }
}

/** The single line a human or a CI job needs when the shell cannot start. */
function failure(log: Logger, copy: Copy, detail: string): never {
  alertBlocking(log, copy.bootFailedTitle, detail);
  Deno.exit(1);
}

async function main(): Promise<void> {
  const cli = parseCli(Deno.args);
  // The instance socket lives from before the window exists until the process
  // exits, so requests from a second launch are QUEUED until runDesktop installs
  // a handler — a request that arrives in between must not be lost.
  const pendingCommands: InstanceCommand[] = [];
  let commandHandler: ((command: InstanceCommand) => void) | null = null;
  const onInstanceCommand = (command: InstanceCommand): void => {
    if (commandHandler !== null) commandHandler(command);
    else pendingCommands.push(command);
  };
  const env = Deno.env.toObject();
  const copy = DICTS[resolveLang(env)];
  if (cli.help) {
    printUsage();
    return;
  }

  // Before the paths resolve there is nowhere to put a log file, so a failure
  // here is stdout-only — and the message carries the fix.
  const bootstrap = createLogger();
  let paths: AppPaths;
  try {
    paths = resolveAppPaths(env);
  } catch (error) {
    bootstrap.error(error instanceof Error ? error.message : String(error));
    Deno.exit(2);
  }

  const studio: StudioModule = await loadStudioModule(paths.serverBundle);
  const home = (env["CELESTEA_HOME"] ?? "").trim() || studio.celesteaHome({ env });
  const log = createLogger({ file: desktopLogFile(home) });
  const version = Deno.desktopVersion ?? null;
  log.info(`${APP_TITLE} desktop ${version === null ? "(no baked version)" : `v${version}`} — ${Deno.build.os}/${Deno.build.arch}`);
  log.info(`resources: ${paths.appRoot}`);
  log.info(`data home: ${home}`);

  if (!exists(join(paths.webdist, "index.html"))) {
    log.warn(`no frontend build staged at ${paths.webdist}; the server will serve its build hint page`);
  }
  if (!exists(join(paths.contracts, "endpoints.json"))) {
    log.warn(`no frozen contracts staged at ${paths.contracts}; the boot contract gate will refuse to start`);
  }

  // The packaged frontend is this app's own UI. An operator who already set
  // STUDIO_STATIC_ROOT (a dev build, a custom theme) keeps their choice.
  if ((env["STUDIO_STATIC_ROOT"] ?? "").trim() === "") {
    Deno.env.set("STUDIO_STATIC_ROOT", paths.webdist);
  }

  // Inside a desktop build the webview is already pointed at the port the
  // runtime allocated, so that port is not negotiable (see paths.ts).
  const chosen = desktopServePort(env, cli.port ?? DEFAULT_PORT);
  // `--self-test` must not collide with an instance the user already runs — the
  // default 3778 is exactly the port a source checkout serves on. Unless the
  // desktop runtime chose the port or the caller asked for one, bind an ephemeral
  // port and let the OS pick a free one.
  const ephemeral = cli.selfTest && chosen.source === "fallback" && cli.port === null;
  const port = ephemeral ? 0 : chosen.port;
  log.info(
    ephemeral
      ? "port 0 (ephemeral, --self-test)"
      : `port ${port} (${chosen.source === "desktop-runtime" ? "allocated by the desktop runtime" : "explicit"})`,
  );

  let contractsVerified = false;
  try {
    studio.verifyContractsAtStartup();
    contractsVerified = true;
  } catch (error) {
    failure(log, copy, `frozen contracts: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Data files are rooted at the data home, NEVER at the process cwd: a desktop
  // app launched from a menu has a cwd the user never chose.
  const config = studio.loadStudioConfig({
    env,
    paths: {
      workspacesFile: join(home, "workspaces.json"),
      providersFile: join(home, "providers.json"),
      promptsFile: join(home, "prompts.json"),
      staticRoot: paths.webdist,
    },
  });

  // ONE INSTANCE, ONE TRAY ICON. A second launch would otherwise start a second
  // server and register a tray item at the same D-Bus path as the first, which is
  // what makes tray clicks land on the wrong process and look "dead" (see
  // single-instance.ts). Diagnostics bypass it: they never create a window/tray.
  let instance: InstanceLock | null = null;
  if (desktopRuntimeAvailable() && !cli.selfTest && !cli.checkUpdates) {
    instance = await acquireInstanceLock({
      home,
      log,
      onCommand: onInstanceCommand,
    });
    if (!instance.primary) {
      log.info("exiting: another instance owns this data directory");
      Deno.exit(0);
    }
  }

  let handle: StudioServerHandle;
  try {
    handle = studio.startStudioServer({ port, hostname: "127.0.0.1", config, env, log: !cli.selfTest });
  } catch (error) {
    failure(log, copy, `the studio server refused to start on 127.0.0.1:${port}: ${error instanceof Error ? error.message : String(error)}`);
  }
  // A port someone else already holds never settles this promise: the underlying
  // node:http server reports EADDRINUSE on an 'error' event that the studio's
  // bootstrap does not surface through the handle. Waiting forever would look like
  // a frozen app, so the wait is bounded and the message names the likely cause.
  try {
    await withTimeout(handle.listening, LISTEN_TIMEOUT_MS, () =>
      `the studio server did not start listening on 127.0.0.1:${port} within ${LISTEN_TIMEOUT_MS / 1000}s — ` +
      "is another Celestea instance already using that port? (pass --port 0 to pick a free one)",
    );
  } catch (error) {
    failure(log, copy, error instanceof Error ? error.message : String(error));
  }
  const url = loopbackUrl(handle.port);
  log.info(`serving ${url} (${handle.endpointCount} contract endpoints)`);

  // Update facts, resolved once for every mode. Precedence: environment, then the
  // settings file (so a self-hosted install needs no rebuild), then the value
  // baked in at build time with `--update-url`. The result is the PER-PLATFORM
  // URL, because a bsdiff patch is of the runtime library — see paths.ts.
  const release = readReleaseInfo(paths.releaseInfo, log);
  const settings = readDesktopSettings(desktopSettingsFile(home), log);
  const resolvedUpdate = resolveUpdateBaseUrl({ env, settings, baked: release.baseUrl });
  const updateBaseUrl = resolvedUpdate.baseUrl === null ? null : updateUrlFor(resolvedUpdate.baseUrl);
  const updatePublicKey =
    (env["CELESTEA_DESKTOP_UPDATE_PUBKEY"] ?? "").trim() ||
    (exists(paths.updatePubKeyFile) ? Deno.readTextFileSync(paths.updatePubKeyFile).trim() : "");
  log.info(
    updateBaseUrl === null
      ? "update source: none configured (auto-update disabled; set CELESTEA_DESKTOP_UPDATE_URL or " +
        desktopSettingsFile(home) + ', or rebuild with --update-url)'
      : `update source: ${updateBaseUrl} [${resolvedUpdate.source}]`,
  );

  // Two versions exist after an update, and they can disagree for exactly one
  // launch: `Deno.desktopVersion` is read from the library the launcher loaded,
  // while `release.json` travels with the payload — on the launch that swaps a
  // staged update in, the payload is already new while the runtime still reports
  // the old number (measured: see desktop/README.md § automatic updates). The
  // payload is what the user is actually running, so it is what gets shown and
  // what the updater compares against.
  const payloadVersion = release.version ?? version;
  if (release.version !== null && version !== null && release.version !== version) {
    log.warn(
      `the loaded runtime reports v${version} but the payload is v${release.version}: ` +
        "a staged update was swapped in during this launch and is live from the next start",
    );
  }

  if (cli.selfTest) {
    const report = await runSelfTest({ url, handle, paths, version: payloadVersion, contractsVerified, updateBaseUrl, updatePublicKey, log });
    console.log(JSON.stringify({ selfTest: report.ok ? "ok" : "failed", ...report }, null, 2));
    await stopQuietly(handle, log, "self-test");
    Deno.exit(report.ok ? 0 : 1);
  }

  if (!desktopRuntimeAvailable()) {
    log.info(copy.headlessHint);
    log.info(copy.serverReady(url));
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      try {
        Deno.addSignalListener(signal, () => void quitHeadless(handle, log, signal));
      } catch {
        // Windows has no SIGTERM; the listener set that exists is enough.
      }
    }
    if (cli.exitAfterMs !== null) {
      setTimeout(() => void quitHeadless(handle, log, `exit-after-ms=${cli.exitAfterMs}`), cli.exitAfterMs);
    }
    return;
  }

  await runDesktop({
    copy,
    log,
    studio,
    handle,
    url,
    home,
    paths,
    version: payloadVersion,
    updateBaseUrl,
    updatePublicKey,
    exitAfterMs: cli.exitAfterMs,
    checkUpdates: cli.checkUpdates,
    instance,
    setCommandHandler: (handler) => {
      commandHandler = handler;
      for (const command of pendingCommands.splice(0)) handler(command);
    },
  });
}

async function stopQuietly(handle: StudioServerHandle, log: Logger, reason: string): Promise<void> {
  try {
    await handle.stop(reason);
  } catch (error) {
    log.warn(`teardown reported: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Resolve `promise`, or reject with `describe()` after `ms`. Used for the one
 * wait that can hang forever (a bind that never completes) so a stuck port is a
 * readable error instead of a window that never loads.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, describe: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(describe())), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function quitHeadless(handle: StudioServerHandle, log: Logger, signal: string): Promise<void> {
  log.info(`${signal} received — draining`);
  await stopQuietly(handle, log, signal);
  Deno.exit(0);
}

export interface DesktopContext {
  copy: Copy;
  log: Logger;
  studio: StudioModule;
  handle: StudioServerHandle;
  url: string;
  home: string;
  paths: AppPaths;
  version: string | null;
  /** Effective release URL (env override or the baked/staged one). */
  updateBaseUrl: string | null;
  updatePublicKey: string;
  /** Quit from inside the app after N ms (smoke tests); null in normal runs. */
  exitAfterMs: number | null;
  /** One-shot update check mode (--check-updates). */
  checkUpdates: boolean;
  /** The held instance lock (null in diagnostics / headless runs). */
  instance: InstanceLock | null;
  /**
   * Install the handler for commands from a second launch. Anything queued before
   * this call is delivered immediately, in order.
   */
  setCommandHandler(handler: (command: InstanceCommand) => void): void;
}

/** Window + tray + updater: everything that only exists in a compiled build. */
async function runDesktop(context: DesktopContext): Promise<void> {
  const { copy, log, studio, handle, url, home, paths } = context;

  // `--check-updates` is a DIAGNOSTIC: it must not add a second window/tray on a
  // running desktop, and it must not need the instance lock. So it runs here,
  // before anything is created, and exits with the outcome.
  if (context.checkUpdates) {
    const updater = createUpdater({
      copy,
      log,
      currentVersion: context.version,
      baseUrl: context.updateBaseUrl,
      publicKey: context.updatePublicKey === "" ? undefined : context.updatePublicKey,
      intervalMs: 0,
      onStatus: () => {},
    });
    const status = await updater.checkNow();
    console.log(JSON.stringify({ updateCheck: status }, null, 2));
    await stopQuietly(handle, log, "check-updates");
    Deno.exit(status.kind === "failed" || status.kind === "unsupported" ? 1 : 0);
  }
  const stateFile = join(home, WINDOW_STATE_FILE);
  const saved = loadWindowState(stateFile);
  const geometry = saved ?? { ...DEFAULT_WINDOW };

  const window = new Deno.BrowserWindow({
    title: `${APP_TITLE}${context.version === null ? "" : ` v${context.version}`}`,
    width: geometry.width,
    height: geometry.height,
    ...(geometry.x === undefined ? {} : { x: geometry.x }),
    ...(geometry.y === undefined ? {} : { y: geometry.y }),
  });
  // The runtime navigated the startup window before our listener existed; the
  // explicit navigate is what makes the page load deterministic (it also
  // recovers from an "address not yet listening" first paint).
  window.navigate(url);
  log.info(`window opened at ${url}`);

  let quitting = false;
  let tray: TrayHandle | null = null;

  const persistGeometry = (): void => {
    try {
      const [width, height] = window.getSize();
      const [x, y] = window.getPosition();
      saveWindowState(stateFile, { width, height, x, y });
    } catch (error) {
      log.warn(`window geometry could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const quit = async (code: number, reason: string): Promise<void> => {
    if (quitting) return;
    quitting = true;
    persistGeometry();
    // Free the instance slot BEFORE the server drains: a user who quits then
    // immediately relaunches must not be told "already running".
    context.instance?.release();
    log.info(`quitting (${reason}) — draining the studio server`);
    try {
      tray?.destroy();
    } catch {
      // A tray that was never created (or already gone) must not block the exit.
    }
    await stopQuietly(handle, log, "desktop-quit");
    log.info("studio server drained");
    Deno.exit(code);
  };

  /**
   * Hand `target` to the OS and report the TRUTH about it.
   *
   * `studio.openBrowser()` (the CLI's helper, reused here at first) only proves
   * that an opener binary exists on PATH, and the app then logs "opened" — which
   * is how a click that opened nothing still looked successful in the log. The
   * verified opener in `open-target.ts` waits for the real outcome, and when no
   * opener worked the user gets a native, copyable dialog instead of silence.
   */
  const openWithOs = async (target: string, what: string): Promise<void> => {
    const result = await openTarget(target, { log });
    if (result.ok) {
      const openerNote = /still running/.test(result.detail) ? "" : ` (opener stderr: ${result.detail})`;
      log.info(`opened ${what}: ${target} [${result.method}]${result.detail === "" ? "" : openerNote}`);
      return;
    }
    log.error(`could not open ${what}: ${result.detail}`);
    notify(log, copy.openFailedTitle, `${what}: ${result.detail.slice(0, 200)}`);
    // The last resort is not another opener: it is showing the string where the
    // user can select it. `prompt` is a native dialog inside a desktop build and
    // its default value is editable, so the URL/path can be copied out by hand.
    try {
      if (typeof prompt === "function" && desktopRuntimeAvailable()) prompt(copy.openManually(what), target);
    } catch (error) {
      log.warn(`the fallback dialog could not be shown: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const showWindow = (): void => {
    window.show();
    window.focus();
    tray?.setWindowVisible(true);
  };
  const hideWindow = (): void => {
    window.hide();
    tray?.setWindowVisible(false);
  };
  const isVisible = (): boolean => {
    try {
      return window.isVisible();
    } catch {
      return true;
    }
  };
  const toggleWindow = (): void => {
    if (isVisible()) {
      hideWindow();
      log.info("window hidden from the tray (the app keeps running)");
    } else {
      showWindow();
      log.info("window shown from the tray");
    }
  };

  const updater = createUpdater({
    copy,
    log,
    currentVersion: context.version,
    baseUrl: context.updateBaseUrl,
    publicKey: context.updatePublicKey === "" ? undefined : context.updatePublicKey,
    intervalMs: UPDATE_INTERVAL_MS,
    onStatus: (status) => {
      tray?.setUpdateLine(updateLine(copy, status));
      try {
        Deno.dock.setBadge(status.kind === "ready" ? "↑" : null);
      } catch {
        // Dock badges are macOS/Windows-only; Linux degrades silently by design.
      }
    },
  });

  tray = createTray({
    copy,
    log,
    version: context.version ?? copy.versionUnknown,
    iconPath: paths.trayIcon,
    handlers: {
      onToggleWindow: toggleWindow,
      onOpenInBrowser: () => void openWithOs(url, "the browser"),
      onCheckUpdates: () => void updater.checkNow(),
      onOpenDataFolder: () => void openWithOs(home, copy.dataFolderTitle),
      onQuit: () => void quit(0, "tray"),
    },
  });

  log.info(
    tray.available
      ? "tray icon created"
      : "no system tray on this desktop; closing the window quits the app",
  );
  // macOS only: see app-menu.ts for why this is not installed everywhere.
  installApplicationMenu(window, {
    copy,
    log,
    appName: APP_TITLE,
    handlers: {
      onCheckUpdates: () => void updater.checkNow(),
      onOpenInBrowser: () => void openWithOs(url, "the browser"),
    },
  });

  // Closing the window hides it — the sessions, workers and in-flight turns must
  // survive the click. Without a tray that would strand the user, so then (and
  // only then) closing really quits.
  window.addEventListener("close", (event) => {
    if (tray === null || !tray.available) {
      log.info("window closed; this platform has no tray, so the app exits");
      void quit(0, "window-close");
      return;
    }
    event.preventDefault();
    hideWindow();
    log.info("window hidden; the app keeps running in the tray");
  });
  window.addEventListener("resize", debounce(persistGeometry, 500));

  updater.start();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(signal, () => void quit(0, signal));
    } catch {
      // Windows has no SIGTERM; the listener set that exists is enough.
    }
  }
  // From here on, a second launch raises this window (or quits the app). Anything
  // that arrived while the window was being created is delivered by this call.
  context.setCommandHandler((command) => {
    log.info(`another launch asked the app to ${command}`);
    if (command === "show") {
      showWindow();
      log.info("window raised because another launch asked for it");
    } else {
      void quit(0, "another-launch");
    }
  });

  // Deterministic exit for smoke tests. Note that a SIGTERM to the LAUNCHER may
  // take the process down before this runtime sees it (the launcher is its own
  // process), so a test that needs the real teardown path uses this instead.
  if (context.exitAfterMs !== null) {
    setTimeout(() => void quit(0, `exit-after-ms=${context.exitAfterMs}`), context.exitAfterMs);
  }

  // From here the window, the tray and the signal listeners are what keep the
  // process (and therefore the event loop) alive; runDesktop returns and the
  // runtime keeps serving.
}

/** Trailing-edge debounce, for geometry writes during a drag-resize. */
export function debounce(run: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      run();
    }, ms);
  };
}

function printUsage(): void {
  console.log(`${APP_TITLE} desktop

Usage:
  CelesteaStudio [--port N] [--self-test] [--help]

Flags:
  --port N      Bind this port when NOT launched by the desktop runtime.
                Inside a desktop build the runtime allocates the port (the
                webview is pointed at it) and this flag is ignored.
  --self-test   Boot the packaged app, exercise it over HTTP, print a JSON
                report and exit non-zero on failure (a release gate).
  --exit-after-ms N
                Quit through the normal quit path after N ms. For smoke tests:
                the desktop launcher owns the process, so an external SIGTERM
                may not reach this runtime.
  --check-updates
                Run one update check now, print the outcome as JSON and exit
                non-zero when the check failed or updates are unconfigured.
  --help        This text.

Environment:
  CELESTEA_HOME                data directory (default: platform app data)
  CELESTEA_DESKTOP_LANG        zh | en (default: the process locale)
  CELESTEA_DESKTOP_UPDATE_URL  override the baked release base URL
  CELESTEA_DESKTOP_UPDATE_PUBKEY  base64 Ed25519 release public key
  CELESTEA_DESKTOP_APP         override the resource root (build artifacts)
  STUDIO_STATIC_ROOT           override the served frontend build`);
}

if (import.meta.main) {
  await main();
}
