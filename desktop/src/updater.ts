/**
 * Auto-update: the polling loop, the honest manual check, and the rollback story.
 *
 * What the runtime does and what this module does NOT redo. `Deno.autoUpdate()`
 * owns the whole patch pipeline: it fetches `<baseUrl>/latest.json`, compares
 * versions, downloads the bsdiff patch, verifies its declared SHA-256, applies it
 * to the runtime library, stages it for the next launch, and rolls back
 * automatically when a launched update fails to boot. This module is the USER
 * INTERFACE of that pipeline — status, notifications, logging — plus one thing
 * the runtime cannot do: answer "am I up to date?" honestly.
 *
 * Why the manual check is implemented by reading the manifest ourselves:
 * `Deno.autoUpdate()` reports only the positive outcome (`onUpdateReady`). A
 * one-shot manual check that silently calls it would have to claim success or
 * failure without evidence — exactly the kind of lying status line this project
 * forbids elsewhere. So `checkNow()` fetches `latest.json`, compares versions
 * itself, reports "up to date" only when the manifest really says so, and hands
 * off to the runtime only when there IS a newer version to apply.
 *
 * Platform honesty: on Windows the runtime downloads and stages patches but the
 * launcher cannot swap a loaded DLL, so updates never take effect. That is stated
 * in the notification body rather than quietly promised.
 */

import type { Copy } from "./i18n.ts";
import type { Logger } from "./log.ts";
import { notify } from "./notify.ts";

/** `latest.json`, as documented for `deno desktop` releases. */
export interface ReleaseManifest {
  version: string;
  patches?: Record<string, { name: string; sha256: string }>;
}

/** The optional Ed25519 envelope a signed manifest comes wrapped in. */
interface SignedEnvelope {
  signed: string;
  signature: string;
}

export type UpdateStatusKind =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "ready"
  | "failed"
  /** The previous launch failed and the launcher restored the old library. */
  | "rolled-back"
  | "unsupported";

export interface UpdateStatus {
  kind: UpdateStatusKind;
  /** Version the status is about (new version for available/ready). */
  version?: string;
  /** Human reason for `failed` / `unsupported`. */
  reason?: string;
}

export interface UpdaterOptions {
  copy: Copy;
  log: Logger;
  /** `Deno.desktopVersion`: null outside a compiled desktop build. */
  currentVersion: string | null;
  /** Release base URL: the env override, else the one baked at compile time. */
  baseUrl: string | null;
  /** Base64 Ed25519 public key; when set, the runtime verifies the signature. */
  publicKey?: string | undefined;
  /** Poll interval in ms; 0 = no background polling (manual checks only). */
  intervalMs: number;
  onStatus(status: UpdateStatus): void;
}

export interface Updater {
  /** Start polling. A no-op (with one clear log line) when it cannot work. */
  start(): void;
  /** Manual check: never throws, always ends in a final status. */
  checkNow(): Promise<UpdateStatus>;
}

/**
 * "fetch failed" alone is useless to an operator: Deno hangs the real reason
 * (certificate, DNS, refused connection) off `error.cause`. Walk a few levels so
 * the message names the cause.
 */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    if (current.message !== "") parts.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.length > 0 ? parts.join(" <- ") : String(error);
}

/** How long a manual check waits for the runtime to stage a patch. */
const STAGE_TIMEOUT_MS = 120_000;
/** Manifest fetch timeout. */
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Compare dotted versions numerically (prerelease suffixes compared as text).
 * Returns -1 / 0 / 1. Unknown shapes compare equal, which makes a manifest this
 * function cannot parse a no-op instead of an accidental "update available".
 */
export function compareVersions(a: string, b: string): number {
  const split = (value: string): { nums: number[]; pre: string } => {
    const [core = "", pre = ""] = value.trim().replace(/^v/, "").split("-", 2);
    const nums = core.split(".").map((part) => Number.parseInt(part, 10));
    return { nums: nums.some((n) => Number.isNaN(n)) ? [] : nums, pre };
  };
  const left = split(a);
  const right = split(b);
  if (left.nums.length === 0 || right.nums.length === 0) return 0;
  const len = Math.max(left.nums.length, right.nums.length);
  for (let i = 0; i < len; i++) {
    const l = left.nums[i] ?? 0;
    const r = right.nums[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === "") return 1;
  if (right.pre === "") return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** Unwrap a signed manifest envelope; an unsigned manifest passes through. */
export function readManifest(payload: unknown): ReleaseManifest {
  const doc = payload as Partial<SignedEnvelope> & Partial<ReleaseManifest>;
  const inner = typeof doc.signed === "string" ? (JSON.parse(doc.signed) as ReleaseManifest) : (payload as ReleaseManifest);
  if (typeof inner?.version !== "string" || inner.version.trim() === "") {
    throw new Error("manifest has no version");
  }
  return inner;
}

/** The status → tray menu line. Null means "show the plain 检查更新… row". */
export function updateLine(copy: Copy, status: UpdateStatus): string | null {
  switch (status.kind) {
    case "checking":
      return copy.checkingUpdates;
    case "up-to-date":
      return copy.upToDate(status.version ?? "?");
    case "available":
      return copy.downloading(status.version ?? "?");
    case "ready":
      return copy.updateReadyLine(status.version ?? "?");
    case "failed":
      return copy.updateFailedLine(status.reason ?? "");
    case "rolled-back":
      return copy.updateRolledBackLine;
    case "unsupported":
      return copy.updateNotConfiguredLine;
    default:
      return null;
  }
}

export function createUpdater(options: UpdaterOptions): Updater {
  const { copy, log } = options;
  const baseUrl = options.baseUrl === null ? null : options.baseUrl.replace(/\/+$/, "");
  /** Resolvers waiting for the runtime to stage a patch (manual check). */
  const waiters: ((version: string) => void)[] = [];
  let staged: string | null = null;

  const setStatus = (status: UpdateStatus): void => {
    if (status.kind !== "idle") options.onStatus(status);
  };

  const onUpdateReady = (version: string): void => {
    staged = version;
    log.info(`update ${version} staged; it applies on the next launch`);
    const hint = Deno.build.os === "windows" ? ` (${copy.updateUnsupported})` : "";
    notify(log, copy.updateReadyTitle, `${copy.updateReadyBody(version)}${hint}`);
    setStatus({ kind: "ready", version });
    for (const resolve of waiters.splice(0)) resolve(version);
  };

  const onRollback = (reason: string): void => {
    log.error(`previous launch failed; rolled back automatically: ${reason}`);
    notify(log, copy.rollbackTitle, copy.rollbackBody(reason));
    // A rollback is NOT a failed update check, and showing it as one (the first
    // version of this file did) leaves the user staring at "check failed" for a
    // condition the app already handled by itself.
    setStatus({ kind: "rolled-back", reason });
  };

  const canUpdate = (): string | null => {
    if (typeof Deno.autoUpdate !== "function") return "this runtime has no auto-update API";
    if (options.currentVersion === null) return "no version was baked in at compile time (deno.json is missing \"version\")";
    if (baseUrl === null) {
      return "no release URL configured (set CELESTEA_DESKTOP_UPDATE_URL, write updateBaseUrl into <data home>/desktop-settings.json, or rebuild with build.mjs --update-url)";
    }
    // The docs are explicit: "the update URL must be https:// — the runtime
    // refuses to poll a plaintext endpoint." Checking it here turns a silent
    // 120-second wait for a patch that can never arrive into an immediate,
    // accurate reason.
    if (!baseUrl.startsWith("https://")) {
      return `the release URL must be https:// (the runtime refuses plaintext endpoints): ${baseUrl}`;
    }
    return null;
  };

  const callAutoUpdate = (interval: number | undefined): void => {
    const settings: DesktopAutoUpdateOptions = { onUpdateReady, onRollback };
    if (baseUrl !== null) settings.url = baseUrl;
    if (interval !== undefined && interval > 0) settings.interval = interval;
    if (options.publicKey !== undefined && options.publicKey.trim() !== "") settings.publicKey = options.publicKey.trim();
    void Promise.resolve(Deno.autoUpdate(settings)).catch((error: unknown) => {
      log.warn(`auto-update call failed: ${describeError(error)}`);
    });
  };

  const fetchManifest = async (): Promise<ReleaseManifest> => {
    const response = await fetch(`${baseUrl}/latest.json`, {
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${baseUrl}/latest.json`);
    return readManifest(await response.json());
  };

  const waitForStage = async (): Promise<string | null> => {
    if (staged !== null) return staged;
    return await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), STAGE_TIMEOUT_MS);
      waiters.push((version) => {
        clearTimeout(timer);
        resolve(version);
      });
    });
  };

  return {
    start: () => {
      const blocked = canUpdate();
      if (blocked !== null) {
        log.warn(`auto-update disabled: ${blocked}`);
        setStatus({ kind: "unsupported", reason: blocked });
        return;
      }
      log.info(
        `auto-update: polling ${baseUrl}/latest.json every ${Math.round(options.intervalMs / 60_000)}min ` +
          `(current v${options.currentVersion}${options.publicKey === undefined ? "" : ", signed manifests required"})`,
      );
      callAutoUpdate(options.intervalMs);
    },

    checkNow: async () => {
      const blocked = canUpdate();
      if (blocked !== null) {
        log.warn(`update check skipped: ${blocked}`);
        const status: UpdateStatus = { kind: "unsupported", reason: blocked };
        setStatus(status);
        notify(log, copy.updateReadyTitle, copy.updateCheckFailed(blocked));
        return status;
      }
      setStatus({ kind: "checking" });
      let manifest: ReleaseManifest;
      try {
        manifest = await fetchManifest();
      } catch (error) {
        const reason = describeError(error);
        log.warn(`update check failed: ${reason}`);
        const status: UpdateStatus = { kind: "failed", reason };
        setStatus(status);
        notify(log, copy.updateReadyTitle, copy.updateCheckFailed(reason));
        return status;
      }
      const current = options.currentVersion ?? "0.0.0";
      if (compareVersions(manifest.version, current) <= 0) {
        log.info(`update check: ${manifest.version} is not newer than ${current}`);
        const status: UpdateStatus = { kind: "up-to-date", version: current };
        setStatus(status);
        notify(log, copy.updateReadyTitle, copy.upToDate(current));
        return status;
      }
      log.info(`update check: ${manifest.version} is available; asking the runtime to stage it`);
      setStatus({ kind: "available", version: manifest.version });
      notify(log, copy.updateReadyTitle, copy.downloading(manifest.version));
      callAutoUpdate(undefined);
      const ready = await waitForStage();
      if (ready !== null) return { kind: "ready", version: ready };
      const reason = `no patch was staged within ${Math.round(STAGE_TIMEOUT_MS / 1000)}s (no patch for v${current} in the manifest, or the download failed)`;
      log.warn(`update check: ${reason}`);
      const status: UpdateStatus = { kind: "failed", reason };
      setStatus(status);
      notify(log, copy.updateReadyTitle, copy.updateCheckFailed(reason));
      return status;
    },
  };
}
