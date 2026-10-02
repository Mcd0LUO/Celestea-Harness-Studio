/**
 * Read-only snapshot probes for the golden exporter (EX-02 split, part 1/4).
 *
 * Every call in here is a GET (or a passive SSE connect); nothing writes to the
 * live backend, so the exporter stays READ-ONLY by construction.
 *
 * Pure move: the ten snapshot calls, the reachability guard and the SSE capture
 * are the ones that used to sit inline in main().
 */

import { probe, type ProbeResult } from "../lib/http.js";

/** The fixed set of read-only endpoints snapshotted into `live/*.json`. */
export const SNAPSHOT_ENDPOINTS = {
  health: "/api/health",
  status: "/api/status",
  tools: "/api/tools",
  config: "/api/config",
  sessions: "/api/sessions",
  workspaces: "/api/workspaces",
  providers: "/api/providers",
  prompts: "/api/prompts",
  workers: "/api/worker/status",
  fsBrowse: "/api/fs/browse",
} as const;

export type SnapshotKey = keyof typeof SNAPSHOT_ENDPOINTS;

export type Snapshots = Record<SnapshotKey, ProbeResult>;

/** Sequential on purpose: the original issued them in this order, one await at a time. */
async function probeAll(studio: string): Promise<Snapshots> {
  const snapshots = {} as Snapshots;
  for (const [key, path] of Object.entries(SNAPSHOT_ENDPOINTS) as Array<[SnapshotKey, string]>) {
    snapshots[key] = await probe(studio, path);
  }
  return snapshots;
}

/** Snapshot every read-only endpoint and fail loudly when the studio is not reachable. */
export async function takeSnapshots(studio: string): Promise<Snapshots> {
  const snapshots = await probeAll(studio);
  const { health, sessions, workspaces } = snapshots;
  if (!health.ok || !sessions.ok || !workspaces.ok) {
    throw new Error(`studio not reachable at ${studio} (health=${health.status} sessions=${sessions.status} workspaces=${workspaces.status})`);
  }
  return snapshots;
}

export interface SseCapture {
  raw: string;
  headers: Record<string, string>;
  frames: number;
  keepalives: number;
}

/** Count one SSE text block as either a keepalive or a real frame (empty blocks are padding). */
function countBlock(block: string, counters: { frames: number; keepalives: number }): void {
  if (block.trim() === "") return;
  if (block.includes("event: keepalive") || block.trim() === "data:") counters.keepalives += 1;
  else counters.frames += 1;
}

/** Passive connect to /api/events for `windowMs`; never POSTs a turn. */
export async function captureSse(base: string, windowMs: number): Promise<SseCapture> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), windowMs);
  const chunks: string[] = [];
  const counters = { frames: 0, keepalives: 0 };
  let headers: Record<string, string> = {};
  try {
    const res = await fetch(base.replace(/\/$/, "") + "/api/events", { headers: { accept: "text/event-stream" }, signal: ac.signal });
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const reader = res.body?.getReader();
    if (reader) {
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = dec.decode(value, { stream: true });
        chunks.push(text);
        for (const block of text.split("\n\n")) countBlock(block, counters);
      }
    }
  } catch {
    /* abort = window elapsed, expected */
  } finally {
    clearTimeout(timer);
  }
  return { raw: chunks.join(""), headers, frames: counters.frames, keepalives: counters.keepalives };
}