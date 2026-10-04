/**
 * Tray / notification copy (zh + en) — the desktop shell's own dictionary.
 *
 * The web UI already ships a 840+ key zh/en dictionary; the desktop shell is
 * outside that runtime, but it must not be English-only either. The language is
 * chosen once at boot from `CELESTEA_DESKTOP_LANG` (explicit) or the process
 * locale (`LC_ALL` / `LC_MESSAGES` / `LANG`), and every user-visible string the
 * shell prints or shows lives HERE so a translator has one file to edit.
 */

export type Lang = "zh" | "en";

export interface Copy {
  readonly trayTooltip: string;
  readonly showWindow: string;
  readonly hideWindow: string;
  readonly openInBrowser: string;
  readonly checkUpdates: string;
  readonly checkingUpdates: string;
  readonly upToDate: (version: string) => string;
  readonly updateAvailable: (version: string) => string;
  readonly downloading: (version: string) => string;
  readonly updateReadyTitle: string;
  readonly updateReadyBody: (version: string) => string;
  /** One-line form for the tray menu. */
  readonly updateReadyLine: (version: string) => string;
  readonly rollbackTitle: string;
  readonly rollbackBody: (reason: string) => string;
  readonly updateCheckFailed: (reason: string) => string;
  /** One-line form for the tray menu (the full sentence goes to a notification). */
  readonly updateFailedLine: (reason: string) => string;
  readonly updateUnsupported: string;
  readonly openDataFolder: string;
  readonly dataFolderTitle: string;
  readonly dataFolderBody: string;
  readonly bootFailedTitle: string;
  readonly quit: string;
  readonly version: string;
  readonly versionUnknown: string;
  readonly headlessHint: string;
  readonly serverReady: (url: string) => string;
  readonly openFailed: (reason: string) => string;
  readonly openFailedTitle: string;
  /** Shown as a copyable dialog when no opener worked. */
  readonly openManually: (what: string) => string;
  readonly updateRolledBackLine: string;
  readonly updateNotConfiguredLine: string;
}

const ZH: Copy = {
  trayTooltip: "Celestea Studio",
  showWindow: "显示窗口",
  hideWindow: "隐藏窗口",
  openInBrowser: "在浏览器中打开",
  checkUpdates: "检查更新…",
  checkingUpdates: "正在检查更新…",
  upToDate: (v) => `已是最新版本（v${v}）`,
  updateAvailable: (v) => `发现新版本 v${v}`,
  downloading: (v) => `正在下载 v${v}…`,
  updateReadyTitle: "更新已就绪",
  updateReadyBody: (v) => `v${v} 已下载并在重启时换入（换入那一次启动仍跑旧库，再启动一次即生效）。`,
  updateReadyLine: (v) => `更新已就绪：v${v}`,
  rollbackTitle: "已回滚到上一版本",
  rollbackBody: (reason) => `上次更新启动失败，已自动回滚：${reason}`,
  updateCheckFailed: (reason) => `检查更新失败：${reason}`,
  updateFailedLine: () => "检查更新失败",
  updateUnsupported: "Windows 上补丁只下载不生效（运行时限制）",
  openDataFolder: "打开数据目录",
  dataFolderTitle: "数据目录",
  dataFolderBody: "会话、工作区与提供商密钥都保存在这里，不会上传到任何云端。",
  bootFailedTitle: "启动失败",
  quit: "退出 Celestea Studio",
  version: "版本",
  versionUnknown: "未知",
  headlessHint: "没有桌面运行时（deno run），以无界面模式启动。",
  serverReady: (url) => `服务已就绪：${url}`,
  openFailed: (reason) => `无法打开：${reason}`,
  openFailedTitle: "打开失败",
  openManually: (what) => `无法用系统程序打开${what}，可以直接复制下面的地址：`,
  updateRolledBackLine: "已回滚到上一版本",
  updateNotConfiguredLine: "未配置更新源",
};

const EN: Copy = {
  trayTooltip: "Celestea Studio",
  showWindow: "Show Window",
  hideWindow: "Hide Window",
  openInBrowser: "Open in Browser",
  checkUpdates: "Check for Updates…",
  checkingUpdates: "Checking for updates…",
  upToDate: (v) => `Up to date (v${v})`,
  updateAvailable: (v) => `Update available: v${v}`,
  downloading: (v) => `Downloading v${v}…`,
  updateReadyTitle: "Update ready",
  updateReadyBody: (v) => `v${v} is downloaded and swapped in at startup (the swapping launch still runs the old library; the next one runs the new).`,
  updateReadyLine: (v) => `Update ready: v${v}`,
  rollbackTitle: "Rolled back",
  rollbackBody: (reason) => `The last update failed to start and was rolled back: ${reason}`,
  updateCheckFailed: (reason) => `Update check failed: ${reason}`,
  updateFailedLine: () => "Update check failed",
  updateUnsupported: "On Windows patches are downloaded but not applied (runtime limitation)",
  openDataFolder: "Open Data Folder",
  dataFolderTitle: "Data folder",
  dataFolderBody: "Sessions, workspaces and provider keys live here — nothing is uploaded to a cloud.",
  bootFailedTitle: "Startup failed",
  quit: "Quit Celestea Studio",
  version: "Version",
  versionUnknown: "unknown",
  headlessHint: "No desktop runtime (deno run): starting in headless mode.",
  serverReady: (url) => `Serving on ${url}`,
  openFailed: (reason) => `Could not open: ${reason}`,
  openFailedTitle: "Could not open",
  openManually: (what) => `Could not open ${what} with a system program. Copy the address below:`,
  updateRolledBackLine: "Rolled back to the previous version",
  updateNotConfiguredLine: "No update source configured",
};

export const DICTS: Record<Lang, Copy> = { zh: ZH, en: EN };

/**
 * Pick the shell language: explicit override first, then the POSIX locale.
 * Anything not recognisably Chinese falls back to English (the safer default
 * for a mixed-locale machine — an English string is readable to more users than
 * a wrong-language one).
 */
export function resolveLang(env: Record<string, string | undefined>): Lang {
  const explicit = (env["CELESTEA_DESKTOP_LANG"] ?? "").trim().toLowerCase();
  if (explicit.startsWith("zh")) return "zh";
  if (explicit === "en") return "en";
  const locale = env["LC_ALL"] ?? env["LC_MESSAGES"] ?? env["LANG"] ?? "";
  return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}
