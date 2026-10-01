/**
 * Phase 2 · the compression SIDECAR — `<session-dir>/compression.json`.
 *
 * Same posture as `checkpoint.json`: a sidecar beside the append-only log,
 * written atomically (tmp + rename), and NEVER an exception. A missing file,
 * unparseable JSON, a foreign version or a half-shaped block all degrade to
 * "this session has nothing compressed" — the log is the truth, so a lost
 * sidecar costs the model its summaries for a while and costs the audit
 * nothing at all.
 *
 * The store owns the BLOCK LIST, not the view: `packages/core`'s overlay
 * projects (events, blocks), and this sidecar is the only place a block list
 * outlives the process. Compression is a view decision, so the sidecar is
 * rebuildable from the log at any time by a human reading it.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMPRESSION_FILE,
  COMPRESSION_SCHEMA_VERSION,
  normalizeBlocks,
  type CompressionBlock,
  type CompressionState,
} from "@celestea/core";
import { renameWithRetry } from "@celestea/core";

/** The sidecar path of a session directory. */
export function compressionPathFor(dir: string): string {
  return join(dir, COMPRESSION_FILE);
}

/** Read side of the compression state (what the overlay and tools consume). */
export interface CompressionStoreView {
  /** The blocks in effect, normalized (sorted, non-overlapping, merged). */
  blocks(): CompressionBlock[];
  /**
   * A monotone counter that changes on EVERY mutation. It is the one term of
   * the runtime's memoized context assembly that a pure view change cannot
   * express: compressing a range does not append an event, so the log's
   * `(count, last event)` key is unchanged while the model-visible request is
   * not.
   */
  version(): number;
}

export interface CompressionStore extends CompressionStoreView {
  /** Replace the whole block list (the tools validate ranges before calling). */
  save(blocks: readonly CompressionBlock[]): void;
}

export interface CompressionStoreOptions {
  /** Called once when a write is refused, so a host can surface degradation. */
  warn?: (message: string) => void;
}

/**
 * Load a block list, or `[]` for anything unreadable.
 *
 * The per-field shape check is what makes a foreign file a reset rather than a
 * crash: a `compression.json` from a newer schema, or a file where someone
 * hand-edited `to_turn` into a string, must not reach the overlay as a block.
 */
export function readCompressionState(path: string): CompressionBlock[] {
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return [];
  }
  if (raw === null || typeof raw !== "object") return [];
  const state = raw as Partial<CompressionState>;
  if (state.version !== COMPRESSION_SCHEMA_VERSION || !Array.isArray(state.blocks)) return [];
  const blocks: CompressionBlock[] = [];
  for (const entry of state.blocks) {
    const block = parseBlock(entry);
    if (block !== null) blocks.push(block);
  }
  return normalizeBlocks(blocks);
}

/** One block, or null when a field is missing or of the wrong type. */
function parseBlock(entry: unknown): CompressionBlock | null {
  if (entry === null || typeof entry !== "object") return null;
  const o = entry as Record<string, unknown>;
  if (typeof o["from_turn"] !== "number" || !Number.isSafeInteger(o["from_turn"])) return null;
  if (typeof o["to_turn"] !== "number" || !Number.isSafeInteger(o["to_turn"])) return null;
  if (typeof o["summary"] !== "string" || o["summary"].trim() === "") return null;
  if (typeof o["created_turn"] !== "number" || !Number.isSafeInteger(o["created_turn"])) return null;
  if (typeof o["context_ratio"] !== "number" || !Number.isFinite(o["context_ratio"])) return null;
  return {
    from_turn: o["from_turn"],
    to_turn: o["to_turn"],
    summary: o["summary"],
    created_turn: o["created_turn"],
    context_ratio: o["context_ratio"],
  };
}

/** The on-disk file-backed store for one session directory. */
export class FileCompressionStore implements CompressionStore {
  private readonly path: string;
  private current: CompressionBlock[];
  private counter = 0;
  private readonly warn: ((message: string) => void) | undefined;

  constructor(dir: string, options: CompressionStoreOptions = {}) {
    this.path = compressionPathFor(dir);
    this.current = readCompressionState(this.path);
    this.warn = options.warn;
  }

  blocks(): CompressionBlock[] {
    return this.current.map((block) => ({ ...block }));
  }

  version(): number {
    return this.counter;
  }

  /**
   * Write the block list. A failed write is REPORTED, never thrown: a turn must
   * not die because a sidecar could not be written, and the in-memory list is
   * still what this process's overlay will use (the next boot just loses it).
   */
  save(blocks: readonly CompressionBlock[]): void {
    const next = normalizeBlocks(blocks);
    this.current = next;
    this.counter += 1;
    const state: CompressionState = { version: COMPRESSION_SCHEMA_VERSION, blocks: next };
    try {
      const tmp = `${this.path}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameWithRetry(tmp, this.path);
    } catch (e) {
      this.warn?.(`compression sidecar write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** An in-memory store (tests / a detached session with no directory). */
export class MemoryCompressionStore implements CompressionStore {
  private current: CompressionBlock[];
  private counter = 0;

  constructor(blocks: readonly CompressionBlock[] = []) {
    this.current = normalizeBlocks(blocks);
  }

  blocks(): CompressionBlock[] {
    return this.current.map((block) => ({ ...block }));
  }

  version(): number {
    return this.counter;
  }

  save(blocks: readonly CompressionBlock[]): void {
    this.current = normalizeBlocks(blocks);
    this.counter += 1;
  }
}
