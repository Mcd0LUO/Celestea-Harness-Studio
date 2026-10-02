/**
 * Fixture collection for the golden exporter (EX-02 split, part 2/4).
 *
 * READ-ONLY: session logs are read straight from disk, snapshots are GET-only,
 * the SSE transcript is a passive connect. Nothing here POSTs a turn.
 *
 * Pure move: the five numbered steps that used to sit inline in main().
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RedactionReport, Redactor } from "@celestea/core";
import { analyzeReplay, deriveMessages, deriveSseTranscript, parseSessionJsonl, type ReplayStats } from "@celestea/session";
import { parseRegistryTsv, REGISTRY_TSV_PATH, summarize } from "@celestea/workers";
import { probe } from "../lib/http.js";
import { SNAPSHOT_ENDPOINTS, type SnapshotKey, type Snapshots, type SseCapture } from "./probe.js";
import { sha256, slugify, writeJson, writeText, writtenFiles, type FileRecord } from "./write.js";

/** Roles the export must cover; a missing one aborts the run (golden coverage gate). */
const REQUIRED_ROLES = ["dangling-tool-call", "run_code-parent-id", "normal-multi-turn"] as const;

/** Session-log role labels derived from replay stats. */
function classify(stats: ReplayStats, outcomes: Record<string, number>): string[] {
  const roles: string[] = ["session-log"];
  if (stats.danglingToolCalls.length > 0) roles.push("dangling-tool-call");
  if (stats.subCalls > 0) roles.push("run_code-parent-id");
  if (stats.tornTail !== null) roles.push("torn-tail");
  if (stats.turnStarts >= 2 && stats.danglingTurns === 0 && stats.danglingToolCalls.length === 0) roles.push("normal-multi-turn");
  for (const o of ["cancelled", "error", "step_limit", "interrupted"]) {
    if ((outcomes[o] ?? 0) > 0) roles.push(`${o}-outcome`);
  }
  return roles;
}

export interface SessionFixtureMeta {
  id: string;
  workspace: string;
  sessionDir: string;
  slug: string;
  roles: string[];
  source: { logPath: string; sizeBytes: number; sha256: string; mtime: string; stable: boolean };
  stats: Omit<ReplayStats, "turnIds"> & { turnIds: { ids: string[]; nonMonotonic: number; duplicates: string[]; malformed: string[] } };
  expectedMessages: number;
  derivedMessages: number;
  sseFrames: number;
  files: Record<string, FileRecord>;
}

interface SessionRow {
  id: string;
  workspace: string;
  kind?: string;
}

/** Snapshot bodies reduced to what the fixture loop needs (no extra HTTP calls). */
export function collectSessionRows(
  sessionsJson: unknown,
  workspacesJson: unknown,
): { sessionList: SessionRow[]; pathByName: Map<string, string> } {
  const sessionList = (sessionsJson as { sessions: SessionRow[] }).sessions;
  const workspaceList = (workspacesJson as { workspaces: Array<{ name: string; path: string }> }).workspaces;
  return {
    sessionList,
    pathByName: new Map(workspaceList.map((w) => [w.name, w.path])),
  };
}

/** One session fixture written to disk, or `null` when the session is skipped. */
async function exportOneSession(
  redactor: Redactor,
  studio: string,
  row: SessionRow,
  pathByName: Map<string, string>,
  maxDerivedSseEvents: number,
): Promise<SessionFixtureMeta | null> {
  const slash = row.id.indexOf("/");
  if (slash <= 0) return null;
  const ws = row.id.slice(0, slash);
  const dir = row.id.slice(slash + 1);
  const wsPath = pathByName.get(ws);
  if (wsPath === undefined) {
    console.warn(`[export-golden] skip ${row.id}: workspace '${ws}' not in registry`);
    return null;
  }
  const logPath = join(wsPath, dir, "cli-main.jsonl");
  if (!existsSync(logPath)) return null;

  const rawA = readFileSync(logPath);
  const parsed = parseSessionJsonl(rawA.toString("utf8"));
  const stats = analyzeReplay(parsed);
  const rawB = readFileSync(logPath);
  const stable = rawA.equals(rawB);
  const slug = slugify(dir);
  const roles = classify(stats, stats.outcomes);

  const messagesRes = await probe(studio, `/api/sessions/${encodeURIComponent(row.id)}/messages`);
  if (messagesRes.status !== 200) {
    console.warn(`[export-golden] skip ${row.id}: messages status ${messagesRes.status}`);
    return null;
  }
  const liveMessages = messagesRes.json as { session: string; messages: unknown[] };

  const base = `sessions/${slug}`;
  const files: Record<string, FileRecord> = {};
  files["cli-main.jsonl"] = writeText(redactor, `${base}/cli-main.jsonl`, rawA.toString("utf8"));
  files["messages-expected.json"] = writeJson(redactor, `${base}/messages-expected.json`, {
    source: { endpoint: `GET /api/sessions/${row.id}/messages`, session: row.id, fetchedFrom: studio },
    messages: liveMessages.messages,
  });
  files["derive-messages-expected.json"] = writeJson(redactor, `${base}/derive-messages-expected.json`, {
    note: "DERIVED by the TS reference implementation (engine derive_messages has no HTTP surface; P1 validates it against the engine unit tests)",
    messages: deriveMessages(parsed.events),
  });
  const derivedFrames = deriveSseTranscript(parsed.events);
  if (parsed.events.length <= maxDerivedSseEvents) {
    files["sse-transcript-derived.jsonl"] = writeText(
      redactor,
      `${base}/sse-transcript-derived.jsonl`,
      derivedFrames.map((f) => JSON.stringify(f)).join("\n") + "\n",
    );
  }
  const meta: SessionFixtureMeta = {
    id: row.id,
    workspace: ws,
    sessionDir: dir,
    slug,
    roles,
    source: {
      logPath,
      sizeBytes: rawA.byteLength,
      sha256: sha256(rawA),
      mtime: statSync(logPath).mtime.toISOString(),
      stable,
    },
    stats: {
      ...stats,
      turnIds: {
        ids: stats.turnIds.ids,
        nonMonotonic: stats.turnIds.nonMonotonic.length,
        duplicates: stats.turnIds.duplicates,
        malformed: stats.turnIds.malformed,
      },
    },
    expectedMessages: liveMessages.messages.length,
    derivedMessages: deriveMessages(parsed.events).length,
    sseFrames: derivedFrames.length,
    files,
  };
  files["meta.json"] = writeJson(redactor, `${base}/meta.json`, meta);
  console.log(`[export-golden] ${row.id}: ${stats.parsedEvents} events, roles=[${roles.join(", ")}]`);
  return meta;
}

/** Export every non-worker session and enforce the golden role coverage gate. */
export async function exportSessions(
  redactor: Redactor,
  studio: string,
  sessionList: SessionRow[],
  pathByName: Map<string, string>,
  maxDerivedSseEvents: number,
): Promise<SessionFixtureMeta[]> {
  const metas: SessionFixtureMeta[] = [];
  for (const row of sessionList) {
    if (row.kind === "worker") continue;
    const meta = await exportOneSession(redactor, studio, row, pathByName, maxDerivedSseEvents);
    if (meta !== null) metas.push(meta);
  }
  assertRoleCoverage(metas);
  return metas;
}

/** Golden coverage gate: every required role must be present or the export aborts. */
export function assertRoleCoverage(metas: SessionFixtureMeta[]): Set<string> {
  const rolesSeen = new Set(metas.flatMap((m) => m.roles));
  for (const required of REQUIRED_ROLES) {
    if (!rolesSeen.has(required)) {
      throw new Error(`golden coverage gap: no session fixture with role '${required}' (found: ${[...rolesSeen].join(", ")})`);
    }
  }
  return rolesSeen;
}
/** Snapshot key -> fixture path for the `live/*.json` verbatim bodies. */
const LIVE_FILES: ReadonlyArray<[SnapshotKey, string]> = [
  ["health", "live/health.json"],
  ["status", "live/status.json"],
  ["tools", "live/tools.json"],
  ["config", "live/config.json"],
  ["sessions", "live/sessions.json"],
  ["workspaces", "live/workspaces.json"],
  ["providers", "live/providers.json"],
  ["prompts", "live/prompts.json"],
  ["workers", "live/worker-status.json"],
  ["fsBrowse", "live/fs-browse.json"],
];

/** Write `live/*.json`: the verbatim status/body of every read-only endpoint. */
export function writeLiveSnapshots(redactor: Redactor, studio: string, snapshots: Snapshots): Record<string, FileRecord> {
  const liveFiles: Record<string, FileRecord> = {};
  for (const [key, relPath] of LIVE_FILES) {
    const res = snapshots[key];
    liveFiles[relPath] = writeJson(redactor, relPath, {
      endpoint: `GET ${studio}${SNAPSHOT_ENDPOINTS[key]}`,
      status: res.status,
      body: res.json,
    });
  }
  return liveFiles;
}

/** Write `sse/*`: the passive live capture plus its metadata. */
export function writeSseCapture(redactor: Redactor, studio: string, windowMs: number, sseCapture: SseCapture): Record<string, FileRecord> {
  const sseFiles: Record<string, FileRecord> = {};
  sseFiles["raw.txt"] = writeText(redactor, "sse/live-capture.raw.txt", sseCapture.raw);
  sseFiles["meta.json"] = writeJson(redactor, "sse/live-capture.json", {
    source: { endpoint: `GET ${studio}/api/events`, mode: "read-only passive connect" },
    windowMs,
    headers: sseCapture.headers,
    framesObserved: sseCapture.frames,
    keepalives: sseCapture.keepalives,
    note:
      sseCapture.frames === 0
        ? "No turn was running and P0 forbids POST /api/turn (it appends to the production cli-main.jsonl). The event NAMES are frozen in contracts/sse-events.json from the retired backend source; per-session transcripts are derived from the session log (fixtures/sessions/*/sse-transcript-derived.jsonl)."
        : "Captured live SSE frames while a turn was running.",
  });
  return sseFiles;
}

/** Write `workers/*`: the raw registry.tsv and its parsed/summarized form. */
export function writeRegistry(redactor: Redactor): Record<string, FileRecord> {
  const registryFiles: Record<string, FileRecord> = {};
  if (!existsSync(REGISTRY_TSV_PATH)) {
    console.warn(`[export-golden] ${REGISTRY_TSV_PATH} not found; skipping worker registry fixture`);
    return registryFiles;
  }
  const raw = readFileSync(REGISTRY_TSV_PATH, "utf8");
  const parsedRegistry = parseRegistryTsv(raw);
  registryFiles["registry.tsv"] = writeText(redactor, "workers/registry.tsv", raw);
  registryFiles["registry-parsed.json"] = writeJson(redactor, "workers/registry-parsed.json", {
    source: REGISTRY_TSV_PATH,
    lines: parsedRegistry.lines,
    entries: parsedRegistry.entries,
    skipped: parsedRegistry.skipped,
    summary: summarize(parsedRegistry.entries),
  });
  console.log(`[export-golden] registry.tsv: ${parsedRegistry.entries.length} rows, ${parsedRegistry.skipped.length} skipped`);
  return registryFiles;
}

/** Write the contract-checked public views: providers (api_key-free) + workspaces. */
export function writePublicViews(redactor: Redactor, studio: string, studioRepo: string, snapshots: Snapshots): Record<string, FileRecord> {
  const viewFiles: Record<string, FileRecord> = {};
  const providers = snapshots.providers;
  if (providers.text.includes('"api_key"')) {
    throw new Error("refusing to export: /api/providers response contains the string \"api_key\"");
  }
  viewFiles["providers/public-view.json"] = writeJson(redactor, "providers/public-view.json", {
    source: { endpoint: `GET ${studio}/api/providers`, note: "api_key is ABSENT from public_view (contract)" },
    body: providers.json,
  });
  viewFiles["workspaces/registry-view.json"] = writeJson(redactor, "workspaces/registry-view.json", {
    source: { endpoint: `GET ${studio}/api/workspaces` },
    body: snapshots.workspaces.json,
  });
  const wsFile = join(studioRepo, "workspaces.json");
  if (existsSync(wsFile)) {
    viewFiles["workspaces/workspaces-file.json"] = writeJson(redactor, "workspaces/workspaces-file.json", {
      source: { path: wsFile, note: "raw data file (read-only); no secrets by schema" },
      body: JSON.parse(readFileSync(wsFile, "utf8")) as unknown,
    });
  }
  return viewFiles;
}
/** The `index.json` manifest: what was exported, from where, and with what redaction. */
export function buildManifest(opts: {
  studio: string;
  studioRepo: string;
  sources: string[];
  report: RedactionReport;
  metas: SessionFixtureMeta[];
  sseCapture: SseCapture;
  registryFiles: Record<string, FileRecord>;
  outDir: string;
  writtenCount: number;
}): Record<string, unknown> {
  const { studio, studioRepo, sources, report, metas, sseCapture, registryFiles, outDir, writtenCount } = opts;
  return {
    generatedAt: new Date().toISOString(),
    studio,
    studioRepo,
    mode: "read-only (GET + passive SSE + direct file reads)",
    redaction: {
      secretsRegistered: report.secretsRegistered,
      secretsDiscovered: report.secretsDiscovered ?? 0,
      sources,
      replacements: report.replacements,
      byRule: report.byRule,
      policy: "registered provider keys + generic token shapes (sk-*, npm_*, ghp_*, Bearer, Authorization/api_key JSON values, *_API_KEY=..., AKIA*); every written file is re-scanned and the export aborts on a leak",
    },
    sessions: metas.map((m) => ({
      id: m.id,
      slug: m.slug,
      roles: m.roles,
      events: m.stats.parsedEvents,
      turns: m.stats.turnStarts,
      danglingToolCalls: m.stats.danglingToolCalls.length,
      subCalls: m.stats.subCalls,
      expectedMessages: m.expectedMessages,
      sseFrames: m.sseFrames,
    })),
    counts: {
      sessions: metas.length,
      sseLiveFrames: sseCapture.frames,
      registryRows: registryFiles["registry.tsv"] === undefined ? 0 : (JSON.parse(readFileSync(join(outDir, "workers/registry-parsed.json"), "utf8")) as { entries: unknown[] }).entries.length,
      files: writtenCount,
    },
    files: writtenFiles().map((w) => ({ path: w.path, bytes: w.bytes, sha256: w.sha256 })),
  };
}