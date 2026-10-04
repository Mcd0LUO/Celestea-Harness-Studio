/**
 * The system tray: a status-area icon with the shell's whole control surface.
 *
 * Why the tray is not optional here. The studio is a long-running agent host: a
 * user closes the window to get it out of the way but expects the sessions,
 * workers and in-flight turns to keep going. So the window's `close` event is
 * intercepted (see `main.ts`) and the app keeps living in the tray — which means
 * the tray has to carry every action the window does not: show it again, open the
 * very same UI in the user's own browser, check for updates, open the data folder,
 * and quit for real.
 *
 * The icon and the menu are the two things a tray backend can refuse
 * independently, so both failures are reported and degraded rather than assumed:
 * `trayId === 0` means the OS has no status area (some minimal Linux setups), and
 * a missing PNG means the icon cannot be drawn — in both cases the app still
 * runs, and `available` tells the caller not to promise tray behaviour.
 */

import type { Copy } from "./i18n.ts";
import type { Logger } from "./log.ts";

export interface TrayHandlers {
  /** Primary click (or the menu item) toggles window visibility. */
  onToggleWindow(): void;
  onOpenInBrowser(): void;
  onCheckUpdates(): void;
  onOpenDataFolder(): void;
  onQuit(): void;
}

export interface TrayOptions {
  copy: Copy;
  log: Logger;
  /** Shown as a disabled row, so the user always knows which build they run. */
  version: string;
  /** Tray PNG; read as bytes (the API takes bytes, not a path). */
  iconPath: string;
  handlers: TrayHandlers;
}

export interface TrayHandle {
  /** False when the OS offered no status area — callers must not rely on the tray. */
  readonly available: boolean;
  setWindowVisible(visible: boolean): void;
  /** e.g. "更新 v2.9.0 已就绪"; null restores the plain "检查更新…" row. */
  setUpdateLine(line: string | null): void;
  destroy(): void;
}

const ID = {
  toggle: "toggle-window",
  browser: "open-browser",
  updates: "check-updates",
  data: "open-data",
  quit: "quit",
  version: "version",
} as const;

export function createTray(options: TrayOptions): TrayHandle {
  const { copy, log, handlers } = options;

  // `CELESTEA_DESKTOP_NO_TRAY=1` runs without a status-area icon. Useful on
  // desktops with no status area, for a user who does not want one, and for
  // verifying the single-instance logic without adding icons to a live panel.
  if ((Deno.env.get("CELESTEA_DESKTOP_NO_TRAY") ?? "").trim() === "1") {
    log.info("tray disabled by CELESTEA_DESKTOP_NO_TRAY=1 (closing the window quits)");
    return {
      available: false,
      setWindowVisible: () => {},
      setUpdateLine: () => {},
      destroy: () => {},
    };
  }
  let windowVisible = true;
  let updateLine: string | null = null;

  const tray = new Deno.Tray();
  const available = tray.trayId !== 0;
  if (!available) {
    log.warn("the OS offered no status area for the tray icon; the window and menus still work");
  }

  const readIfPresent = (path: string): Uint8Array | null => {
    try {
      return Deno.readFileSync(path);
    } catch {
      return null;
    }
  };
  // `setIcon` is the base icon and `setIconDark` the dark-mode variant. Windows
  // ignores the latter and always draws the base one on the taskbar, which is
  // dark by default — so there the dark-background glyph IS the base icon.
  const darkVariantPath = options.iconPath.replace(/tray(\.[a-z]+)$/i, "tray-dark$1");
  const useDarkAsBase = Deno.build.os === "windows" && darkVariantPath !== options.iconPath;
  const base = readIfPresent(useDarkAsBase ? darkVariantPath : options.iconPath);
  if (base === null) {
    log.warn(`tray icon could not be read at ${options.iconPath}; the tray keeps its menu but shows no icon`);
  } else {
    tray.setIcon(base);
  }
  const dark = darkVariantPath === options.iconPath ? null : readIfPresent(darkVariantPath);
  if (dark !== null) tray.setIconDark(dark);
  tray.setTooltip(`${copy.trayTooltip} ${options.version}`);

  /** The single source of the menu; every state change re-renders from here. */
  const menu = (): DesktopMenuItem[] => [
    { item: { label: windowVisible ? copy.hideWindow : copy.showWindow, id: ID.toggle, enabled: true } },
    { item: { label: copy.openInBrowser, id: ID.browser, enabled: true } },
    "separator",
    { item: { label: updateLine ?? copy.checkUpdates, id: ID.updates, enabled: true } },
    { item: { label: copy.openDataFolder, id: ID.data, enabled: true } },
    { item: { label: `${copy.version} ${options.version}`, id: ID.version, enabled: false } },
    "separator",
    { item: { label: copy.quit, id: ID.quit, accelerator: "CmdOrCtrl+Q", enabled: true } },
  ];

  const render = (): void => {
    if (available) tray.setMenu(menu());
  };

  tray.addEventListener("click", handlers.onToggleWindow);
  tray.addEventListener("dblclick", handlers.onToggleWindow);
  tray.addEventListener("menuclick", (event) => {
    switch (event.detail.id) {
      case ID.toggle:
        handlers.onToggleWindow();
        break;
      case ID.browser:
        handlers.onOpenInBrowser();
        break;
      case ID.updates:
        handlers.onCheckUpdates();
        break;
      case ID.data:
        handlers.onOpenDataFolder();
        break;
      case ID.quit:
        handlers.onQuit();
        break;
      default:
        log.warn(`unhandled tray menu id: ${event.detail.id}`);
    }
  });

  render();

  return {
    available,
    setWindowVisible: (visible: boolean) => {
      if (visible === windowVisible) return;
      windowVisible = visible;
      render();
    },
    setUpdateLine: (line: string | null) => {
      updateLine = line;
      render();
    },
    destroy: () => tray.destroy(),
  };
}
