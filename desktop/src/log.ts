/**
 * The desktop shell's stdout logger.
 *
 * The studio server logs its own lines with a `[celestea-studio-ts]` prefix; the
 * shell's lines are prefixed `[celestea-desktop]` so a user pasting a terminal
 * session into an issue makes the two sources distinguishable. A launched
 * desktop app has no terminal on macOS/Windows unless started from one, so the
 * logger ALSO keeps the last lines in memory and mirrors them to a file under the
 * data directory — that file is what "something went wrong at startup" support
 * actually needs.
 */

const PREFIX = "[celestea-desktop]";
/** How many lines stay readable through `tailLines()` (diagnostics, self-test). */
const KEEP = 200;

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Recent lines, oldest first (never throws). */
  tailLines(): string[];
  /** Mirror path, or null when file logging is off/unavailable. */
  readonly file: string | null;
}

export interface LoggerOptions {
  /** Append the same lines here; null disables file logging. */
  file?: string | null;
  /** Also write to stdout (false in tests / self-test summaries). */
  toStdout?: boolean;
}

/**
 * Create a logger. File writing is best-effort: a read-only data directory must
 * never take the app down, so a failed append degrades to stdout only.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const file = options.file ?? null;
  const toStdout = options.toStdout ?? true;
  const kept: string[] = [];
  let fileBroken = false;

  const emit = (level: "info" | "warn" | "error", message: string): void => {
    const line = `${PREFIX} ${level === "info" ? "" : level + ": "}${message}`;
    kept.push(line);
    if (kept.length > KEEP) kept.shift();
    if (toStdout) {
      if (level === "error") console.error(line);
      else console.log(line);
    }
    if (file !== null && !fileBroken) {
      try {
        Deno.writeTextFileSync(file, `${new Date().toISOString()} ${line}\n`, { append: true, create: true });
      } catch {
        fileBroken = true;
      }
    }
  };

  return {
    info: (m) => emit("info", m),
    warn: (m) => emit("warn", m),
    error: (m) => emit("error", m),
    tailLines: () => [...kept],
    get file() {
      return fileBroken || file === null ? null : file;
    },
  };
}
