/**
 * Hand a URL or a path to the operating system — and REPORT WHAT ACTUALLY HAPPENED.
 *
 * Why this is not `openBrowser()` from the CLI (`apps/cli/src/open-browser.ts`).
 * That helper is fire-and-forget BY DESIGN: it checks that the opener binary
 * exists on PATH, spawns it detached, and reports `{opened: true}` — which is a
 * statement about the binary, not about the browser. For a CLI that prints "open
 * <url> instead" when the opener is missing, that is fine. For a desktop app it is
 * not: the user clicked a tray item and the only feedback the app can give is its
 * own claim. Measured failure that motivated this file: `xdg-open` started
 * Microsoft Edge, Edge died on a read-only profile in a sandboxed session, no
 * window ever appeared — and the CLI helper still returned `opened: true`.
 *
 * So this module:
 *   1. tries a LIST of openers (a desktop may be GNOME, KDE, or a minimal
 *      session; `xdg-open` is the portable one but not always the working one),
 *   2. WAITS for the child's exit status, with a grace period for openers that
 *      legitimately stay in the foreground,
 *   3. reports the real outcome — exit code and the first stderr line — so the
 *      caller can tell the user the truth and offer a fallback.
 *
 * What is verified and where (this checkout builds and runs on Linux/x86_64):
 *   - Linux: `xdg-open` end to end, including the failure path.
 *   - macOS / Windows: the openers below are the platform's documented ones
 *     (`open`, `cmd /c start`), but they are NOT verified on a real Mac or a real
 *     Windows session from here. The verified-outcome design means that if they
 *     behave differently, the app says so instead of pretending.
 */

import type { Logger } from "./log.ts";

export interface OpenTargetResult {
  ok: boolean;
  /** The opener that produced this result, or null when none could be tried. */
  method: string | null;
  /** Exit code of the opener, when it exited. */
  code: number | null;
  /** One line for humans: the reason on failure, or a short note on success. */
  detail: string;
}

export interface OpenTargetOptions {
  log: Logger;
  /** Injected for tests: the platform to act as. */
  platform?: string;
  env?: Record<string, string | undefined>;
  /** How long an opener may run before it counts as "launched and healthy". */
  graceMs?: number;
  /** Injected for tests: run one candidate and resolve its outcome. */
  run?: (command: string, args: string[]) => Promise<{ code: number | null; stderr: string }>;
}

/** A URL vs. a filesystem path: they need different openers on some desktops. */
export function isUrlLike(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
}

/**
 * Candidate openers, most portable first. Each entry is a command plus the fixed
 * arguments; the target is appended last.
 *
 * `$BROWSER` comes last and only for URLs: it is the user's declared preference,
 * but it is a shell fragment in general, so it is only used as a literal command
 * name here (a value with arguments or spaces is skipped — guessing at it is how
 * an opener ends up running something the user did not mean).
 */
export function openerCandidates(target: string, platform: string, env: Record<string, string | undefined>): { command: string; args: string[] }[] {
  if (platform === "darwin") return [{ command: "open", args: [target] }];
  if (platform === "win32") {
    return [
      { command: "cmd", args: ["/d", "/s", "/c", "start", "", target] },
      { command: "powershell", args: ["-NoProfile", "-Command", "Start-Process", `'${target}'`] },
    ];
  }
  const url = isUrlLike(target);
  const candidates = [
    { command: "xdg-open", args: [target] },
    // GNOME's own opener: works when xdg-open's mime lookup is broken.
    { command: "gio", args: ["open", target] },
    // KDE.
    { command: "kde-open5", args: [target] },
    { command: "kde-open", args: [target] },
  ];
  const browser = (env["BROWSER"] ?? "").trim();
  if (url && /^[\w./-]+$/.test(browser)) candidates.push({ command: browser, args: [target] });
  return candidates;
}

/** Is `command` runnable? A PATH lookup, with the platform's executable suffix. */
export function findExecutable(command: string, platform: string, env: Record<string, string | undefined>): string | null {
  if (command.includes("/") || command.includes("\\")) return command;
  const path = env["PATH"] ?? "";
  const separator = platform === "win32" ? ";" : ":";
  const suffixes = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const extensions = platform === "win32" ? (env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";") : [];
  for (const dir of path.split(separator)) {
    if (dir === "") continue;
    for (const suffix of [...extensions, ...suffixes]) {
      const candidate = `${dir}/${command}${suffix.toLowerCase()}`;
      try {
        if (Deno.statSync(candidate).isFile) return candidate;
      } catch {
        // keep looking
      }
      try {
        if (Deno.statSync(`${dir}/${command}${suffix}`).isFile) return `${dir}/${command}${suffix}`;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

/** Default runner: `Deno.Command` with a grace period, capturing stderr. */
async function runCommand(command: string, args: string[], graceMs: number): Promise<{ code: number | null; stderr: string }> {
  const child = new Deno.Command(command, { args, stdout: "null", stderr: "piped", stdin: "null" }).spawn();
  const stderr = new Response(child.stderr).text();
  const status = child.status;
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), graceMs));
  const raced = await Promise.race([status.then((s) => s.code), timeout]);
  if (raced === "timeout") {
    // Still running: an opener that keeps the foreground (a browser launched
    // without `&`) has not failed — it has not finished.
    return { code: 0, stderr: "still running (counted as launched)" };
  }
  return { code: raced, stderr: (await stderr).split("\n")[0] ?? "" };
}

/** One line for the log/notification: what was tried, and how it ended. */
export function describeOpenResult(result: OpenTargetResult): string {
  if (result.ok) return `opened with ${result.method ?? "?"}`;
  if (result.method === null) return `no opener available (${result.detail})`;
  return `${result.method} failed (${result.detail})`;
}

/**
 * Open `target` with the first opener that actually works. Never throws: every
 * failure comes back as `{ok: false}` with the reason, because the caller's job is
 * to tell the user (and offer a copyable fallback), not to crash.
 */
export async function openTarget(target: string, options: OpenTargetOptions): Promise<OpenTargetResult> {
  const platform = options.platform ?? Deno.build.os;
  const env = options.env ?? Deno.env.toObject();
  const graceMs = options.graceMs ?? 6000;
  const run = options.run ?? ((command: string, args: string[]) => runCommand(command, args, graceMs));
  const tried: string[] = [];

  for (const candidate of openerCandidates(target, platform, env)) {
    const binary = findExecutable(candidate.command, platform, env);
    if (binary === null) {
      tried.push(`${candidate.command}: not on PATH`);
      continue;
    }
    try {
      const outcome = await run(binary, candidate.args);
      if (outcome.code === 0) {
        return { ok: true, method: candidate.command, code: 0, detail: outcome.stderr.slice(0, 120) };
      }
      tried.push(`${candidate.command}: exit ${outcome.code}${outcome.stderr === "" ? "" : ` (${outcome.stderr.slice(0, 120)})`}`);
    } catch (error) {
      tried.push(`${candidate.command}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  options.log.warn(`could not open ${target}: ${tried.join("; ")}`);
  return {
    ok: false,
    method: null,
    code: null,
    detail: tried.length === 0 ? "no opener candidates for this platform" : tried.join("; "),
  };
}
