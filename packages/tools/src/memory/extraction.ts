/**
 * Phase 1 — the WRITE callback of background memory extraction
 * (docs/feature-memory-extraction.md §4). The scheduler lives in
 * @celestea/runtime; runtime may not import this package, so this module is the
 * host-injected half: it maps one extraction op onto the append-only entries
 * log ([appendMemoryLine]) and renders the manifest the extraction prompt reads.
 *
 * The op shape is DECLARED HERE structurally (runtime's own `ExtractionOp` is
 * structurally identical, so the host can pass it straight through) — importing
 * the runtime type would reverse the dependency direction.
 *
 * Every refusal is a result, never a throw: the scheduler treats
 * `{ applied: false }` as a diagnostics line and moves on.
 */

import { findEntryByText, MEMORY_ENTRY_MAX_BYTES, nextMemoryId } from "./log.js";
import { appendMemoryLine, readMemoryState, type MemoryStore } from "./store.js";

/** One memory op, as the extraction pass returns it (structural mirror). */
export type MemoryExtractionOp =
  | { readonly op: "add"; readonly text: string; readonly tags: readonly string[] }
  | { readonly op: "update"; readonly id: string; readonly text: string; readonly tags: readonly string[] }
  | { readonly op: "forget"; readonly id: string };

/** The outcome of applying one op (structural mirror of the runtime's). */
export interface MemoryExtractionResult {
  readonly applied: boolean;
  /** Why an op was refused (duplicate-text, unknown-id, entry-too-large). */
  readonly reason?: string;
}

/** Where an extraction-written entry came from; null on a detached turn id. */
export interface MemoryExtractionSource {
  readonly session: string;
  readonly turn: string;
}

/**
 * Apply one extraction op to the store's GLOBAL layer. `add` and `update`
 * dedup on the text hash (a re-scanned cursor slice can re-propose the same
 * fact); `update` and `forget` refuse ids that are not currently active
 * (the model only knows the manifest, which lists active ids).
 */
export function applyMemoryExtractionOp(
  store: MemoryStore,
  op: MemoryExtractionOp,
  source: MemoryExtractionSource | null,
): MemoryExtractionResult {
  const state = readMemoryState(store);
  const at = new Date().toISOString();
  const provenance = source === null ? {} : { source };
  if (op.op === "add" || op.op === "update") {
    if (Buffer.byteLength(op.text, "utf8") > MEMORY_ENTRY_MAX_BYTES) return { applied: false, reason: "entry-too-large" };
    if (findEntryByText(state, op.text) !== undefined) return { applied: false, reason: "duplicate-text" };
  }
  if (op.op === "add") {
    appendMemoryLine(store, { kind: "entry", id: nextMemoryId(state.lines), text: op.text, tags: op.tags, at, ...provenance });
    return { applied: true };
  }
  if (op.op === "update") {
    if (!state.entries.some((e) => e.id === op.id)) return { applied: false, reason: "unknown-id" };
    appendMemoryLine(store, {
      kind: "entry",
      id: nextMemoryId(state.lines),
      text: op.text,
      tags: op.tags,
      at,
      supersedes: op.id,
      ...provenance,
    });
    return { applied: true };
  }
  if (!state.entries.some((e) => e.id === op.id)) return { applied: false, reason: "unknown-id" };
  appendMemoryLine(store, { kind: "forget", id: op.id, at });
  return { applied: true };
}

/** Byte budget for the manifest the extraction prompt embeds. */
export const MEMORY_MANIFEST_MAX_BYTES = 8_192;

/**
 * Render the store's active entries as a compact manifest (one line per entry:
 * `- m7 [tag1, tag2] text`). This is what the extraction prompt shows the
 * model, so it can `update`/`forget` by id instead of duplicating facts.
 * Overlong manifests are tail-truncated (oldest entries kept — recency at the
 * cut is not worth dropping the ids the model would reference).
 */
export function memoryManifest(store: MemoryStore, maxBytes: number = MEMORY_MANIFEST_MAX_BYTES): string {
  const lines = readMemoryState(store).entries.map(
    (e) => `- ${e.id}${e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : ""} ${e.text.replace(/\s+/g, " ")}`,
  );
  const total = lines.length;
  let out = lines.join("\n");
  while (Buffer.byteLength(out, "utf8") > maxBytes && lines.length > 1) {
    lines.pop();
    // The COUNT, not a bare "(truncated)": a model that cannot see how much of
    // the manifest it is missing cannot judge whether "no such entry" means "not
    // remembered" or "not shown". The policy stays "oldest kept" (see above) —
    // this only makes the cut legible.
    out = lines.join("\n") + `\n- … (${total - lines.length} more entries not shown)`;
  }
  return out;
}
