/**
 * Native notifications (best effort) and the fatal-error dialog.
 *
 * A desktop shell may not scream: `Notification` only exists in a compiled
 * `deno desktop` binary, the OS may have denied permission, and on a bare Linux
 * box no notification service may be listening. Every function here therefore
 * reports success as a boolean and NEVER throws — the caller decides what the
 * fallback is (the tray menu label is the guaranteed one, see `tray.ts`).
 */

import type { Logger } from "./log.ts";

/** True when the runtime exposes the desktop Notification API. */
export function notificationsAvailable(): boolean {
  return typeof Notification !== "undefined";
}

/**
 * Show a notification. When the permission is still "default" the request is
 * made first and the notification shown only if the user grants it.
 */
export function notify(log: Logger, title: string, body: string): boolean {
  if (!notificationsAvailable()) {
    log.warn(`notification skipped (no desktop runtime): ${title} — ${body}`);
    return false;
  }
  try {
    if (Notification.permission === "denied") {
      log.warn(`notification denied by the OS: ${title} — ${body}`);
      return false;
    }
    if (Notification.permission === "granted") {
      new Notification(title, { body });
      return true;
    }
    void Notification.requestPermission()
      .then((permission) => {
        if (permission === "granted") new Notification(title, { body });
        else log.warn(`notification not granted (${permission}): ${title} — ${body}`);
      })
      .catch((error: unknown) => log.warn(`notification request failed: ${describe(error)}`));
    return true;
  } catch (error) {
    log.warn(`notification failed: ${describe(error)}`);
    return false;
  }
}

/**
 * A modal, blocking error dialog for a failure the user must see (a refused
 * boot). `alert()` is a native dialog inside `deno desktop` and a no-op-ish
 * global elsewhere, so it is only used when the desktop runtime is present —
 * otherwise the caller has already found the line on stdout.
 */
export function alertBlocking(log: Logger, title: string, body: string): void {
  log.error(`${title}: ${body}`);
  if (typeof alert !== "function" || typeof Deno.BrowserWindow !== "function") return;
  try {
    alert(`${title}\n\n${body}`);
  } catch (error) {
    log.warn(`alert() failed: ${describe(error)}`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
