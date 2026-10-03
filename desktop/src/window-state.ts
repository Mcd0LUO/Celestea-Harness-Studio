/**
 * Window geometry that survives a restart — the smallest thing that makes a
 * window feel like the user's own rather than a new one every launch.
 *
 * Deliberately dependency-free and forgiving: a corrupt, hand-edited or
 * foreign-version file must never block a launch, so every read path falls back
 * to `null` (use the defaults) and every write is best-effort. Values are
 * clamped to a sane range because a window restored off-screen (a monitor that
 * is gone) is worse than a window that opens centered.
 */

import { dirname } from "node:path";

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  /** True when the user had it maximized; the shell re-maximizes if it can. */
  maximized?: boolean;
}

export const DEFAULT_WINDOW: Required<Pick<WindowState, "width" | "height">> = { width: 1280, height: 840 };

const MIN_SIDE = 480;
const MAX_SIDE = 8192;
const MAX_COORD = 32_768;

function clampInt(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : undefined;
}

/** Normalize anything that parsed as JSON into a usable state, or null. */
export function normalizeWindowState(raw: unknown): WindowState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const doc = raw as Record<string, unknown>;
  const width = clampInt(doc["width"], MIN_SIDE, MAX_SIDE) ?? DEFAULT_WINDOW.width;
  const height = clampInt(doc["height"], MIN_SIDE, MAX_SIDE) ?? DEFAULT_WINDOW.height;
  const x = clampInt(doc["x"], -MAX_COORD, MAX_COORD);
  const y = clampInt(doc["y"], -MAX_COORD, MAX_COORD);
  const state: WindowState = { width, height };
  if (x !== undefined) state.x = x;
  if (y !== undefined) state.y = y;
  if (doc["maximized"] === true) state.maximized = true;
  return state;
}

/** Read the saved geometry; null when absent or unusable (never throws). */
export function loadWindowState(file: string): WindowState | null {
  try {
    return normalizeWindowState(JSON.parse(Deno.readTextFileSync(file)) as unknown);
  } catch {
    return null;
  }
}

/** Persist the geometry; returns false instead of throwing on a read-only home. */
export function saveWindowState(file: string, state: WindowState): boolean {
  try {
    Deno.mkdirSync(dirname(file), { recursive: true });
    Deno.writeTextFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}
