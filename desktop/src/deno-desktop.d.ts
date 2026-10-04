/**
 * Ambient declarations for the `deno desktop` runtime surface this app uses.
 *
 * Why this file exists. On Deno 2.9.7 `deno types` prints no declarations for
 * the desktop API: `Deno.autoUpdate`, `Deno.Tray`, `Deno.BrowserWindow`,
 * `Deno.dock` and the web `Notification` class are all absent, so a plain
 * `deno check src/main.ts` rejects every call into them. The declarations below
 * are therefore hand-written, and deliberately NARROW: only the members this app
 * actually calls are declared, so no code here can claim a capability the runtime
 * does not have (and `deno check` stays meaningful).
 *
 * The reference for each shape is the Deno desktop documentation
 * (https://docs.deno.com/runtime/desktop/), cross-checked against the runtime
 * behaviour recorded in `desktop/README.md` § Verification.
 */

/** One clickable entry in a tray / application menu. */
interface DesktopMenuItemSpec {
  label: string;
  /** Returned in the `menuclick` event's `detail.id`. */
  id?: string;
  /** e.g. "CmdOrCtrl+Q". */
  accelerator?: string;
  enabled: boolean;
}

/** `MenuItem` is a tagged union: clickable, submenu, separator, or OS role. */
type DesktopMenuItem =
  | { item: DesktopMenuItemSpec }
  | { submenu: { label: string; items: DesktopMenuItem[] } }
  | "separator"
  | { role: { role: string } };

interface DesktopMenuClickEvent {
  detail: { id: string };
}

interface DesktopResizeEvent {
  detail: { width: number; height: number };
}

interface DesktopBrowserWindowOptions {
  title?: string;
  /** Logical pixels; the runtime defaults to 800x600. */
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  resizable?: boolean;
  alwaysOnTop?: boolean;
  frameless?: boolean;
  noActivate?: boolean;
}

interface DesktopAutoUpdateOptions {
  /** Defaults to `desktop.release.baseUrl` baked in at compile time. */
  url?: string;
  /** Poll interval in ms; omitted = a single check. */
  interval?: number;
  /** Base64 Ed25519 public key; when set the manifest must be signed. */
  publicKey?: string;
  onUpdateReady?: (version: string) => void;
  onRollback?: (reason: string) => void;
}

declare namespace Deno {
  /** The `version` field baked into the binary, or null outside `deno desktop`. */
  const desktopVersion: string | null;

  /**
   * Poll the release server, download and stage a binary-diff patch.
   * A no-op (with a one-time warning) when no version was baked in.
   */
  function autoUpdate(options?: DesktopAutoUpdateOptions | string): Promise<void> | void;

  /** Status-area icon (macOS menu bar / Windows tray / Linux AppIndicator). */
  class Tray {
    constructor();
    /** 0 when the backend could not create a status item; calls are then no-ops. */
    readonly trayId: number;
    /** PNG bytes, not a path. */
    setIcon(png: Uint8Array): void;
    setIconDark(png: Uint8Array | null): void;
    setTooltip(text: string | null): void;
    setMenu(items: DesktopMenuItem[] | null): void;
    getBounds(): { x: number; y: number; width: number; height: number } | null;
    destroy(): void;
    addEventListener(type: "click" | "dblclick", listener: () => void): void;
    addEventListener(type: "menuclick", listener: (event: DesktopMenuClickEvent) => void): void;
  }

  /** Native window. The first construction adopts the implicit startup window. */
  class BrowserWindow {
    constructor(options?: DesktopBrowserWindowOptions);
    /** Stable numeric id, unique per window in this process. */
    readonly windowId: number;
    navigate(url: string): void;
    reload(): void;
    show(): void;
    hide(): void;
    focus(): void;
    close(): void;
    isClosed(): boolean;
    isVisible(): boolean;
    setTitle(title: string): void;
    getSize(): [number, number];
    setSize(width: number, height: number): void;
    getPosition(): [number, number];
    setPosition(x: number, y: number): void;
    isResizable(): boolean;
    setResizable(resizable: boolean): void;
    executeJs(code: string): Promise<unknown>;
    /** Native application menu (macOS menu bar; a window menu on Windows/Linux). */
    setApplicationMenu(items: DesktopMenuItem[] | null): void;
    addEventListener(type: "close" | "focus" | "blur", listener: (event: Event) => void): void;
    addEventListener(type: "resize", listener: (event: DesktopResizeEvent) => void): void;
    addEventListener(type: "menuclick", listener: (event: DesktopMenuClickEvent) => void): void;
  }

  /** Dock / taskbar presence (macOS and Windows act; Linux degrades). */
  const dock: {
    setBadge(text: string | null): void;
  };
}

interface DesktopNotificationOptions {
  body?: string;
  icon?: string;
  tag?: string;
}

/** The standard web Notifications API, wired to the OS by `deno desktop`. */
declare class Notification {
  constructor(title: string, options?: DesktopNotificationOptions);
  static readonly permission: "default" | "denied" | "granted";
  static requestPermission(): Promise<"default" | "denied" | "granted">;
  readonly title: string;
  readonly body: string;
  close(): void;
  addEventListener(type: "click" | "close" | "show", listener: () => void): void;
}
