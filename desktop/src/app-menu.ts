/**
 * The application menu (macOS menu bar; on Windows/Linux the window menu).
 *
 * WHY macOS ONLY. On macOS an app without a menu bar is visibly not a native app:
 * there is no ⌘Q, no ⌘C, and the app name does not appear where every other app
 * puts it. On Windows and Linux the tray plus the window title carry the identity,
 * a menubar is not the expected shape for this kind of utility, and the same
 * `setApplicationMenu` call would instead add a menu strip to the window. So the
 * menu is installed where it is expected and skipped where it would be noise.
 *
 * WHAT IS IN IT. Only OS ROLES (`quit`, `copy`, `reload`, …) plus two custom entries
 * wired to the SAME handlers the tray menu calls, so every action exists once. Roles
 * are the runtime's own menu items — no label translation, no platform branching.
 *
 * NOT VERIFIED ON A REAL MAC from this checkout (the build host is Linux). Every call
 * is therefore defensive: if anything about the menu API differs on a given runtime,
 * a warning is logged and the app keeps working — the tray still carries every action.
 */

import type { Copy } from "./i18n.ts";
import type { Logger } from "./log.ts";

export interface ApplicationMenuHandlers {
  onCheckUpdates(): void;
  onOpenInBrowser(): void;
}

export interface ApplicationMenuOptions {
  copy: Copy;
  log: Logger;
  /** Shown as the first submenu's title (the app menu). */
  appName: string;
  handlers: ApplicationMenuHandlers;
}

export const ID = {
  checkUpdates: "app-menu-check-updates",
  openInBrowser: "app-menu-open-browser",
} as const;

/** The menu definition, exported so the shape is inspectable without a Mac. */
export function applicationMenu(options: ApplicationMenuOptions): DesktopMenuItem[] {
  return [
    {
      submenu: {
        label: options.appName,
        items: [
          { role: { role: "about" } },
          "separator",
          { item: { label: options.copy.checkUpdates, id: ID.checkUpdates, enabled: true } },
          { item: { label: options.copy.openInBrowser, id: ID.openInBrowser, enabled: true } },
          "separator",
          { role: { role: "hide" } },
          { role: { role: "hideOthers" } },
          { role: { role: "unhide" } },
          "separator",
          { role: { role: "quit" } },
        ],
      },
    },
    {
      submenu: {
        label: "Edit",
        items: [
          { role: { role: "undo" } },
          { role: { role: "redo" } },
          "separator",
          { role: { role: "cut" } },
          { role: { role: "copy" } },
          { role: { role: "paste" } },
          { role: { role: "selectAll" } },
        ],
      },
    },
    {
      submenu: {
        label: "View",
        items: [{ role: { role: "reload" } }, { role: { role: "togglefullscreen" } }],
      },
    },
  ];
}

/**
 * Install the menu on macOS; a no-op elsewhere. Returns whether it was installed.
 * Clicks on the two custom entries arrive as `menuclick` events on the window.
 */
export function installApplicationMenu(window: Deno.BrowserWindow, options: ApplicationMenuOptions): boolean {
  if (Deno.build.os !== "darwin") return false;
  try {
    window.setApplicationMenu(applicationMenu(options));
    window.addEventListener("menuclick", (event) => {
      if (event.detail.id === ID.checkUpdates) options.handlers.onCheckUpdates();
      else if (event.detail.id === ID.openInBrowser) options.handlers.onOpenInBrowser();
    });
    options.log.info("macOS application menu installed");
    return true;
  } catch (error) {
    options.log.warn(`the application menu could not be installed (${error instanceof Error ? error.message : String(error)}); the tray still carries every action`);
    return false;
  }
}
