/**
 * `<session-dir>/session.json` — the optional Studio session metadata
 * (`contracts/data-files/session.schema.json`).
 *
 * The engine NEVER reads this file; only `POST /api/sessions` writes it (and
 * only when `title` and/or `model` and/or `prompt` and/or `mode` is non-empty),
 * `rename`/`branch` re-write it (see W779 below), and `activate`/`compact` honor
 * its `model` override. Missing or corrupt files are tolerated (`None`), never
 * repaired.
 *
 * W779 T2: `title` joins them — the ORIGINAL, un-sanitized session title (CJK,
 * spaces and all), so the GUI can show `我的 会话` instead of the directory name
 * `我的_会话-1700000000.0`. `POST /api/sessions` always has a title, so every
 * session created from now on carries one; the field is optional on read, and a
 * session without it falls back to the de-suffixed directory name.
 *
 * W729 (P0): `mode` joins `model`/`prompt` as a creation-time session property.
 * K8: the default mode is *not* written — the KEY never appears for a session
 * that did not ask for one. W779 T2 adds `title`, so the file itself now always
 * exists; K8's guarantee is per-key (no `mode` key), not per-file.
 *
 * W2065: `base_url` joins `model` as the endpoint that model was resolved
 * against. It is written ONLY together with `model` (by
 * `PUT /api/sessions/{id}/model`) and is honoured by
 * `runtime/session-compose.ts profileFor`. Both keys are cleared together when
 * the override is cleared.
 */

import { parseMode, type SessionMode } from "./mode.js";
import { isHttpUrl } from "./validate.js";
import { readJsonIfExists, writeTextAtomic } from "./fs-json.js";

export const SESSION_META = "session.json";

export interface SessionMeta {
  /**
   * W779 T2: the display name, verbatim as the user typed it. Absent = the
   * caller falls back to the directory name without its creation suffix.
   */
  title?: string;
  model?: string;
  /**
   * W2065: the endpoint the `model` override was resolved against. Written by
   * `PUT /api/sessions/{id}/model` together with `model` (never on its own), so
   * the two can never drift: before this key a session could hold provider B's
   * model while inheriting provider A's base_url, and every request went to the
   * wrong host. ABSENT = 「follow the global default」, exactly like `model`.
   */
  base_url?: string;
  prompt?: string;
  /** Declared session mode; ABSENT = `standard` and no key on disk (K8). */
  mode?: SessionMode;
}

/**
 * Read the metadata; a corrupt file behaves exactly like a missing one, and a
 * `mode` that is not a declared literal is dropped (never repaired on disk).
 */
export function readSessionMeta(dir: string): SessionMeta | null {
  const out = readJsonIfExists(`${dir}/${SESSION_META}`);
  if (!out.exists || out.error !== undefined) return null;
  if (typeof out.value !== "object" || out.value === null || Array.isArray(out.value)) return null;
  const rec = out.value as Record<string, unknown>;
  const meta: SessionMeta = {};
  if (typeof rec["title"] === "string") meta.title = rec["title"];
  if (typeof rec["model"] === "string") meta.model = rec["model"];
  // W2065: a non-http(s) value is DROPPED (tolerated, never repaired on disk) —
  // this string becomes a request target, and a hand-edited session.json must not
  // be able to inject another URL scheme into the engine profile.
  if (typeof rec["base_url"] === "string" && isHttpUrl(rec["base_url"])) meta.base_url = rec["base_url"];
  if (typeof rec["prompt"] === "string") meta.prompt = rec["prompt"];
  const mode = parseMode(rec["mode"]);
  if (mode !== null) meta.mode = mode;
  return meta;
}

/** Any of `title`/`model`/`base_url`/`prompt`/`mode` non-empty -> write; all empty -> no file. */
export function writeSessionMeta(dir: string, meta: SessionMeta): void {
  const title = meta.title ?? "";
  const model = meta.model ?? "";
  const baseUrl = meta.base_url ?? "";
  const prompt = meta.prompt ?? "";
  const mode: string = meta.mode ?? "";
  if (title === "" && model === "" && baseUrl === "" && prompt === "" && mode === "") return;
  const body: Record<string, string> = {};
  if (title !== "") body["title"] = title;
  if (model !== "") body["model"] = model;
  // W2065: K8 per key — absent means 「follow the global default」, so a session
  // that never pinned an endpoint carries no `base_url` line at all.
  if (baseUrl !== "") body["base_url"] = baseUrl;
  if (prompt !== "") body["prompt"] = prompt;
  if (mode !== "") body["mode"] = mode;
  // W9230 (W9206-23): ATOMIC. This used to be a bare `writeFileSync`, and this
  // file is rewritten by rename / branch / compact / mode-switch / model-pin and
  // session creation — so a crash or a kill mid-write truncated it, and
  // `readSessionMeta` (which treats a broken file as a missing one) then
  // silently dropped the session's title, model, prompt binding and mode. The
  // write is not on a hot path, so the tmp+rename cost is worth the guarantee;
  // mode 0644 matches the contract's declared mode for this file.
  writeTextAtomic(`${dir}/${SESSION_META}`, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o644 });
}
