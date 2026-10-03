/**
 * Single instance: one app, one tray icon, one server.
 *
 * WHY THIS IS NOT OPTIONAL for an installed desktop app. Measured on Linux with
 * two copies of the .deb launcher running (see desktop/README.md §7.1):
 *
 *   - each process starts its own HTTP server on its own port (two data dirs'
 *     worth of state, two session engines);
 *   - each registers a tray icon at the SAME D-Bus object path
 *     (`/org/ayatana/NotificationItem/laufey_tray_1` — the library numbers items
 *     per process, so instance 2 collides with instance 1);
 *   - the desktop panel resolves a click through the path it cached, so clicks
 *     then land on the WRONG instance (or on one that already exited) and the
 *     tray looks "completely dead" even though the menu renders.
 *
 * So the fix for the tray symptom is the same as the fix for duplicate launches:
 * refuse to be the second instance, and let the first one show its window.
 *
 * HOW. A lock file plus a Unix socket, both under the data home:
 *
 *   <home>/desktop-instance.json   { pid, startedAt, socket, version }
 *   <home>/desktop-instance.sock   the primary instance listens here
 *
 * A second launch connects and sends `show`, then exits — so re-clicking the
 * launcher behaves like every other desktop app (it raises the existing window)
 * instead of silently starting a second agent on the same data. A launch that
 * finds a lock whose process is gone takes over: a crash must never make the app
 * permanently "already running".
 *
 * Escape hatch: `CELESTEA_DESKTOP_ALLOW_MULTI=1` bypasses the guard. The project
 * deliberately supports running a throwaway instance next to a production one
 * (`STUDIO_TS_PORT`), and `--self-test` must never be blocked by a running app —
 * both use this switch.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "./log.ts";

/** Commands a secondary launch can send to the primary instance. */
export type InstanceCommand = "show" | "quit";

export interface InstanceLockOptions {
  /** Data home (`CELESTEA_HOME` / platform default). */
  home: string;
  log: Logger;
  /** Called in the PRIMARY when a second launch asks for something. */
  onCommand?: (command: InstanceCommand) => void;
  /** Injected for tests: paths and the listen/connect implementations. */
  lockFile?: string;
  socketPath?: string;
}

export interface InstanceLock {
  /** False when another live instance owns the app (the caller must exit). */
  readonly primary: boolean;
  /** How the primary was notified, when this launch is a secondary one. */
  readonly notified: InstanceCommand | null;
  /** Release the socket/lock file (primary only; safe to call twice). */
  release(): void;
}

interface LockDoc {
  pid: number;
  startedAt: string;
  socket: string | null;
  version: string | null;
}

/** A short, stable, filesystem-safe tag for a data home (stale-socket fallback). */
export function homeTag(home: string): string {
  return createHash("sha256").update(home).digest("hex").slice(0, 12);
}

/**
 * Is `pid` alive? Signal 0 asks the kernel without delivering anything.
 *
 * POSIX only in practice: Deno's `kill` has no signal 0 on Windows, so there the
 * answer is "unknown, assume we need the socket" — connecting is the real test
 * anyway, and the caller treats an unreachable socket as "take over".
 */
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    Deno.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else; anything else
    // (ESRCH / unsupported) means "not our problem".
    return error instanceof Deno.errors.PermissionDenied;
  }
}

function readLock(file: string): LockDoc | null {
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as Partial<LockDoc>;
    if (typeof doc.pid !== "number") return null;
    return {
      pid: doc.pid,
      startedAt: typeof doc.startedAt === "string" ? doc.startedAt : "",
      socket: typeof doc.socket === "string" ? doc.socket : null,
      version: typeof doc.version === "string" ? doc.version : null,
    };
  } catch {
    return null;
  }
}

/** Send one command to the primary instance. Returns true when it was accepted. */
export async function notifyPrimary(socketPath: string, command: InstanceCommand): Promise<boolean> {
  try {
    const connection = await Deno.connect({ transport: "unix", path: socketPath });
    try {
      await connection.write(new TextEncoder().encode(`${command}\n`));
      // The primary answers with "ok" once it has acted; waiting for it keeps the
      // secondary's exit deterministic (it does not race the primary's window).
      const buffer = new Uint8Array(16);
      await connection.read(buffer);
    } finally {
      try {
        connection.close();
      } catch {
        // Already closed by the peer.
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Take the instance lock, or hand off to the running instance.
 *
 * Returns `{primary: true}` when this process owns the app and should continue
 * booting; `{primary: false}` after a successful hand-off (the caller exits).
 */
export async function acquireInstanceLock(options: InstanceLockOptions): Promise<InstanceLock> {
  const { log, home } = options;
  const lockFile = options.lockFile ?? join(home, "desktop-instance.json");
  let socketPath = options.socketPath ?? join(home, "desktop-instance.sock");

  if ((Deno.env.get("CELESTEA_DESKTOP_ALLOW_MULTI") ?? "").trim() === "1") {
    log.info("single-instance guard disabled by CELESTEA_DESKTOP_ALLOW_MULTI=1");
    return { primary: true, notified: null, release: () => {} };
  }

  const existing = readLock(lockFile);
  if (existing !== null) {
    const alive = processAlive(existing.pid);
    if (alive) {
      const target = existing.socket ?? socketPath;
      if (target !== null && (await notifyPrimary(target, "show"))) {
        log.info(`another instance is already running (pid ${existing.pid}); asked it to show its window`);
        return { primary: false, notified: "show", release: () => {} };
      }
      // Alive but unreachable. It may be starting up — or it may be HUNG, which is
      // not hypothetical: two instances sharing a data directory were measured
      // deadlocking after "studio server drained" (desktop/README.md §5.7), leaving
      // exactly this state (lock held, socket silent, tray icon still on the panel).
      // Refusing forever would strand the user, so the refusal is explicit and
      // escapable:
      const forced = (Deno.env.get("CELESTEA_DESKTOP_FORCE") ?? "").trim() === "1";
      if (!forced) {
        log.error(
          `another instance is running (pid ${existing.pid}) but does not answer on ${target}.\n` +
            `  It is most likely hung. End it with:  kill ${existing.pid}   (or kill -9 ${existing.pid} if that does nothing)\n` +
            "  To start anyway, knowing that two instances would share this data directory: CELESTEA_DESKTOP_FORCE=1",
        );
        return { primary: false, notified: null, release: () => {} };
      }
      log.warn(
        `CELESTEA_DESKTOP_FORCE=1: taking over from unresponsive pid ${existing.pid} — ` +
          "two instances may write to this data directory; kill the old process as soon as possible",
      );
      rmSync(lockFile, { force: true });
      rmSync(target, { force: true });
    }
    log.info(`clearing a stale instance lock (pid ${existing.pid} is gone)`);
    rmSync(lockFile, { force: true });
    if (existing.socket !== null) rmSync(existing.socket, { force: true });
  }

  mkdirSync(home, { recursive: true });

  // A unix socket path is limited to ~104 bytes on Linux/macOS. The data home is
  // normally short (~/.celestea), but a custom CELESTEA_HOME can be deep, so a
  // failure to listen falls back to the OS temp dir with a hash of the home.
  let listener: Deno.Listener | null = null;
  const candidates = [socketPath, join(tmpdir(), `celestea-desktop-${homeTag(home)}.sock`)];
  for (const candidate of candidates) {
    try {
      // A leftover socket file from a crashed run would block listen().
      if (existsSync(candidate)) rmSync(candidate, { force: true });
      listener = Deno.listen({ transport: "unix", path: candidate });
      socketPath = candidate;
      break;
    } catch (error) {
      log.warn(`could not listen on ${candidate} (${error instanceof Error ? error.message : String(error)}); trying the next path`);
    }
  }
  if (listener === null) {
    // No socket: still hold the lock, so a second launch is refused (it just
    // cannot ask the primary to raise its window). Windows without unix sockets
    // lands here.
    log.warn("no IPC socket available; a second launch will be refused instead of raising this window");
  }

  const doc: LockDoc = {
    pid: Deno.pid,
    startedAt: new Date().toISOString(),
    socket: listener === null ? null : socketPath,
    version: Deno.desktopVersion ?? null,
  };
  writeFileSync(lockFile, `${JSON.stringify(doc, null, 2)}\n`);
  log.info(`instance lock taken (pid ${Deno.pid}${listener === null ? "" : `, socket ${socketPath}`})`);

  if (listener !== null) {
    const encoder = new TextEncoder();
    void (async () => {
      for await (const connection of listener!) {
        try {
          const buffer = new Uint8Array(64);
          const read = await connection.read(buffer);
          const command = new TextDecoder().decode(buffer.subarray(0, read ?? 0)).trim();
          if (command === "show" || command === "quit") {
            options.onCommand?.(command);
            await connection.write(encoder.encode("ok\n"));
          }
        } catch (error) {
          log.warn(`instance IPC connection failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          try {
            connection.close();
          } catch {
            // Peer already gone.
          }
        }
      }
    })();
  }

  let released = false;
  return {
    primary: true,
    notified: null,
    release: () => {
      if (released) return;
      released = true;
      try {
        listener?.close();
      } catch {
        // Already closed.
      }
      rmSync(lockFile, { force: true });
      rmSync(socketPath, { force: true });
    },
  };
}
