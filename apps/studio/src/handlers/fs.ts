/**
 * `GET /api/fs/browse` — `src/workspaces.rs:700-766` — iteration G's
 * `GET /api/fs/list` (the Win-style file manager's read-only listing) and its
 * follow-up `GET /api/fs/read` (the viewer; see `fs-read.ts`).
 *
 * `browse` lists DIRECTORY names only (the legacy shape). `list` lists
 * directories AND files as `{name,type,size,mtime}`, reusing the same
 * discipline: absolute path, dot-names hidden, symlinks never followed, sorted,
 * capped at `MAX_DIR_ENTRIES` (with an explicit `truncated` flag). `read`
 * applies that SAME discipline to one file (never follows a link, same trust
 * boundary) and shares the `read_file` tool's binary/pagination rules.
 *
 * Wire format is FROZEN by `docs/archive/decisions/iteration-g-workbench.md` §0.1:
 *   type: "dir" | "file"      (a symlink is reported as the link itself, i.e.
 *                              "file" when it is not a directory — never followed)
 *   mtime: ISO-8601 string    (null when `lstat` cannot read it)
 * `roots` and `truncated` are ADDITIVE fields on top of that frozen minimum.
 *
 * `roots` is a hardcoded informational constant — listing is NOT restricted to
 * it; the endpoints have no auth, which is why the default bind is loopback.
 *
 * W885 (W883 E3): "absolute" and "parent" are PLATFORM questions, not
 * `startsWith("/")` and `lastIndexOf("/")`. The path helpers take the platform
 * as an argument, so the win32 rules are unit-tested on Linux; the routes
 * themselves still run under the host's own platform.
 */

import { lstatSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { fsRoots, MAX_DIR_ENTRIES } from "../config.js";
import type { RouteTable } from "../routes.js";
import { isAbsolutePath, parentDir, rootOf } from "../store/session-id.js";
import { errText } from "../store/result.js";
import type { Deps } from "./common.js";
import { registerFsRead } from "./fs-read.js";

interface BrowseBody {
  path: string;
  parent: string | null;
  dirs: string[];
  roots: readonly string[];
  error?: string;
}

/** One entry of `GET /api/fs/list` (frozen shape, §0.1). */
export interface FsListEntry {
  name: string;
  /** `dir` for a directory; `file` for everything else (symlinks NOT followed). */
  type: "dir" | "file";
  /** Bytes for files / symlinks; `null` for directories. */
  size: number | null;
  /** ISO-8601 mtime from `lstat`; null when it could not be read. */
  mtime: string | null;
}

interface ListBody {
  path: string;
  parent: string | null;
  entries: FsListEntry[];
  roots: readonly string[];
  truncated: boolean;
  error?: string;
}

/** Absolute under `platform` (`C:\…`, `\\\\server\\share`, `/…`). */
export function isBrowsablePath(path: string, platform: string = process.platform): boolean {
  return isAbsolutePath(path, platform);
}

/**
 * The parent directory of `path`, never above the filesystem root: `C:\` is
 * its own parent on Windows, `/` on POSIX, `\\\\server\\share\\` on a UNC share.
 */
export function browseParent(path: string, platform: string = process.platform): string {
  const root = rootOf(path, platform);
  const trimmed = stripTrailingSeparators(path, platform);
  if (trimmed === "" || trimmed === root) return root === "" ? path : root;
  const parent = parentDir(trimmed, platform);
  return parent === "" ? root : parent;
}

/** `/a/b/` -> `/a/b`; a bare root keeps its separator (`C:\`, `/`). */
function stripTrailingSeparators(path: string, platform: string): string {
  if (path === rootOf(path, platform)) return path;
  let out = path;
  while (out.length > 1 && (out.endsWith("/") || out.endsWith("\\"))) out = out.slice(0, -1);
  return out;
}

function browseDirs(path: string): { dirs: string[] } | { error: string } {
  if (!isBrowsablePath(path)) return { error: "path '" + path + "' must be absolute" };
  const read = readDirectory(path);
  if ("error" in read) return read;
  const dirs: string[] = [];
  for (const entry of read.entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    dirs.push(entry.name);
  }
  dirs.sort();
  return { dirs: dirs.slice(0, MAX_DIR_ENTRIES) };
}

/** Read a directory, mapping the two expected failures onto the frozen texts. */
function readDirectory(path: string): { entries: Dirent[] } | { error: string } {
  try {
    return { entries: readdirSync(path, { withFileTypes: true }) };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { error: "path '" + path + "' is not an existing directory" };
    return { error: "cannot read '" + path + "': " + errText(e) };
  }
}

/**
 * The Win-style listing: directories first, then files, each by name; dot-names
 * hidden; a symlink is `file` (its own lstat, never the target).
 */
export function listDirectory(path: string): { entries: FsListEntry[]; truncated: boolean } | { error: string } {
  if (!isBrowsablePath(path)) return { error: "path '" + path + "' must be absolute" };
  const read = readDirectory(path);
  if ("error" in read) return read;
  // W9230 (W9206-39): ORDER FIRST, THEN TRUNCATE, THEN STAT.
  //
  // MAX_DIR_ENTRIES bounds the RESPONSE, not the WORK. The old order described
  // (i.e. lstat-ed) EVERY entry — including dot-names it was about to hide —
  // and only then sorted and sliced, so a 100k-entry directory cost 100k
  // synchronous stats on the main thread to return 200 rows. A dirent already
  // carries `isDirectory()` and the name, which is everything the ordering
  // needs, so the cap is applied before the first `lstatSync`.
  const visible = read.entries.filter((entry) => !entry.name.startsWith("."));
  visible.sort((a, b) => compareDirents(a, b));
  const truncated = visible.length > MAX_DIR_ENTRIES;
  const kept = visible.slice(0, MAX_DIR_ENTRIES);
  return { entries: kept.map((entry) => describeEntry(path, entry.name, entry)), truncated };
}

function describeEntry(dir: string, name: string, dirent: Dirent): FsListEntry {
  const type: FsListEntry["type"] = dirent.isDirectory() ? "dir" : "file";
  let size: number | null = null;
  let mtime: string | null = null;
  try {
    // lstat, not stat: a symlink is never followed to its target.
    const info = lstatSync(join(dir, name));
    size = info.isDirectory() ? null : info.size;
    mtime = new Date(info.mtimeMs).toISOString();
  } catch {
    // The entry vanished between readdir and lstat: keep it, with unknown stats.
  }
  return { name, type, size, mtime };
}

/**
 * W9230 (W9206-39): the ordering over RAW dirents, so the cap can be applied
 * before any `lstatSync`. The classification is the same one `describeEntry`
 * uses (`dirent.isDirectory()`, never a followed symlink), so the resulting
 * order is byte-identical to the previous sort over described entries.
 */
function compareDirents(a: Dirent, b: Dirent): number {
  const aDir = a.isDirectory() ? 0 : 1;
  const bDir = b.isDirectory() ? 0 : 1;
  if (aDir !== bDir) return aDir - bDir;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function registerFs(app: Hono, _deps: Deps, table: RouteTable): string[] {
  const browse = table.get("get_fs_browse");
  const list = table.get("get_fs_list");
  app.on(browse.method, browse.honoPath, (c) => {
    const asked = (c.req.query("path") ?? "").trim();
    const roots = fsRoots();
    // W885 follow-up: with no path the client gets the PLATFORM's root, not "/".
    const raw = asked === "" ? (roots[0] ?? "/") : asked;
    const out = browseDirs(raw);
    if ("error" in out) {
      const body: BrowseBody = { path: raw, parent: null, dirs: [], roots, error: out.error };
      return c.json(body, 400);
    }
    const body: BrowseBody = { path: raw, parent: browseParent(raw), dirs: out.dirs, roots };
    return c.json(body);
  });
  app.on(list.method, list.honoPath, (c) => {
    const asked = (c.req.query("path") ?? "").trim();
    const roots = fsRoots();
    const raw = asked === "" ? (roots[0] ?? "/") : asked;
    const out = listDirectory(raw);
    if ("error" in out) {
      const body: ListBody = { path: raw, parent: null, entries: [], roots, truncated: false, error: out.error };
      return c.json(body, 400);
    }
    const body: ListBody = { path: raw, parent: browseParent(raw), entries: out.entries, roots, truncated: out.truncated };
    return c.json(body);
  });
  return [browse.id, list.id, registerFsRead(app, _deps, table)];
}
