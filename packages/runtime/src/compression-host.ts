/**
 * W1900 (Phase 2) — the COMPRESSION HOST: the one place a session's
 * compression state, the statusline's water level and the model-facing tools
 * are joined into a single late-bound surface.
 *
 * Three consumers need the same two facts, and none of them may compute them:
 *
 *   1. the `compress` / `decompress` / `context_status` tools (@celestea/tools,
 *      which may only import core) — they need the RAW event stream, the turn
 *      in flight, the block list and a way to persist a new one;
 *   2. the ephemeral nudge in the loop (@celestea/agent-loop, core only again)
 *      — it needs the water level and nothing else;
 *   3. `GET /api/status` — it needs the block count and ranges for the
 *      observability block.
 *
 * So this module builds all three from ONE port and ONE water-level reader, and
 * the answer can never disagree between them. The layering is what forces that:
 `status.ts` is the only place a water level is computed,
 `MemoryCompressionStore` is the only place a block list lives,
 * and a second arithmetic in either consumer would be a prompt that lies.
 *
 * The water level deliberately comes from the SAME `contextUsage` call the
 * statusline makes, mapped field-for-field onto core's `ContextUsageFacts`
 * (which is that payload's projection minus the three discriminators:
 * `method`/`projected`/`window_source` become the facts themselves). Nothing
 * here re-estimates, re-reads the log or recomputes a ratio — see
 `statusUsageFactsOf` for the mapping and its refusal to.
 */
import {
  contextRatioFacts,
  maxTurnNumber,
  type CompressionBlock,
  type CompressionHost,
  type CompressionPort,
  type ContextUsageFacts,
} from "@celestea/core";
import type { SessionLog, Statusline } from "@celestea/core";
import { compressionStoreOf, type CompressionStore } from "@celestea/session";
import { compressionEnabled } from "./compression-switch.js";

/**
 * Core's `ContextUsageFacts` projected from the statusline's `context_usage`.
 *
 * The ONLY mapping between the two shapes, and it is a field copy on purpose:
 * `contextUsage()` has already applied the real-prompt-first precedence and the
 * pressure projection, and re-deriving any of that here would be the second
 * arithmetic this whole design forbids. `window_source` is the one value that
 * has no counterpart in the facts, so it is DROPPED rather than invented — a
 * consumer that needs to know whether the denominator is real can read it off
 * the statusline.
 *
 * `null` when the statusline has no context_usage at all (a detached or
 * still-cold generation): `undefined` is not `0`, because a tool that stores
 * `context_ratio: 0` on a block is claiming the context was empty, and
 * `shouldNudge` on a `0` would be a different statement than on a `null`.
 */
export function statusUsageFactsOf(usage: Statusline["context_usage"] | undefined | null): ContextUsageFacts | null {
  if (usage === undefined || usage === null) return null;
  return {
    used: usage.used,
    window: usage.window,
    ratio: usage.ratio,
    estimated: usage.estimated,
    method: usage.method === "session_event_chars" ? "none" : usage.method,
    projected: usage.projected,
  };
}

/**
 * Core's `contextRatioFacts` fed from the statusline's three inputs.
 *
 * The seam for a host that has no `context_usage` payload but DOES have the
 * pieces (`Runtime.assembledContext()` + the profile window). Prefer
 * [statusUsageFactsOf] when a statusline exists: this path exists so a unit test
 * or a tool-only host can reach the same vocabulary without composing one.
 */
export function contextFactsOf(input: {
  promptTokens: number;
  assembledTokens: number | null;
  window: number;
}): ContextUsageFacts {
  return contextRatioFacts(input);
}

/** The water-level reader shape every consumer is handed. */
export type CompressionUsageReader = () => ContextUsageFacts | null;

export interface CompressionHostInput {
  /** The live session log — the overlay's consumer and the port's event source. */
  log: () => SessionLog | null;
  /** The statusline's own `context_usage` (the single water-level data plane). */
  usage: CompressionUsageReader;
}

/**
 * The block list of a log, or `[]` when the log carries no overlay (a
 * detached in-memory session, a kill-switched process, or a log that was
 * opened before the sidecar existed). Never throws: compression is a
 * degradation, not a failure mode.
 */
export function blocksOf(log: SessionLog | null | undefined): CompressionBlock[] {
  return compressionStoreOf(log)?.blocks() ?? [];
}

/**
 * Build the `CompressionHost` for one session generation.
 *
 * Two independent reasons to return `null` rather than a half-wired host:
 *
 *   - the kill-switch (`CELESTEA_MEMORY_COMPRESSION=off`) — the whole
 *     compression surface, tools included, disappears together, because a
 *     model offered `compress` in one process and not in the next is a
 *     prompt that changes under it;
 *   - a log with no compression store — there is nothing to compress AND
 *     nowhere to persist a block, so a port that silently dropped writes would
 *     report success for a compression that did not happen. A model must never
 *     be told a summary is in place when it is not.
 *
 * The `log` and `usage` are READ LAZILY (both are callbacks) because the log
 * is swapped by `rebind()` and the water level moves every turn: a host built
 * from a snapshot would compress against a session that no longer exists.
 */
export function compressionHostOf(input: CompressionHostInput): CompressionHost | null {
  if (!compressionEnabled()) return null;
  return {
    port: () => portOf(input.log(), input.usage),
    usage: () => input.usage(),
  };
}

/**
 * The port of one log, or `null` when it carries no compression store.
 *
 * `save` re-reads the store on every call rather than capturing a block array:
 * the tools drop a superseded block by handing `save` a whole new list, and a
 * captured list would be a stale base the second `compress` in the same turn
 * overwrites. `currentTurn()` is the NEWEST turn id, and the range validator
 * refuses anything that reaches it, so a `compress` call can never cover the
 * turn the model is answering in.
 *
 * `usage` is the host's OWN water-level reader, not a local `null`: the
 * block a `compress` call writes records the ratio at compression time
 * (`CompressionBlock.context_ratio`), and a port that answered `null` here
 * would stamp every block with `0` — a reading that claims the context was
 * empty exactly when the model decided it was full.
 */
function portOf(log: SessionLog | null, usage: CompressionUsageReader): CompressionPort | null {
  const store: CompressionStore | null = compressionStoreOf(log);
  if (log === null || store === null) return null;
  const port: CompressionPort = {
    events: () => log.events(),
    currentTurn: () => newestTurnOf(log),
    blocks: () => store.blocks(),
    save: (next) => {
      store.save(next);
    },
    usage,
  };
  return port;
}

/**
 * The newest turn number in the log, or **-1 when the log has no turn at all**.
 *
 * This is the log's own number (`turn-0` is the first turn — turn-id.ts), with
 * no offset: `validateRange` refuses `to_turn >= currentTurn`, so the turn in
 * flight is protected by comparing like with like.
 *
 * W1900 shipped `n > 0 ? n : 1` here, i.e. it skipped `turn-0` and then
 * FABRICATED a 1 for a log whose only turn is the first one. Those two floors
 * described a 1-based numbering that no other reader of this feature used
 * (`turnNumbersOf` and the block schema are 0-based), which is how the first
 * turn of every session became uncompressed-and-uncompressible. -1 says "no
 * turn yet" honestly: every range is then refused by the `current_turn` arm,
 * which is exactly true for an empty log.
 */
export function newestTurnOf(log: SessionLog): number {
  return maxTurnNumber(log.events());
}

/**
 * The observability block of a session's compression state.
 *
 * Reported by `GET /api/status` next to `recovery` and `cost`, because both of
 * those answer the same operator question — "what has this engine done to my
 * session behind the scenes?" — and a compression that is invisible in the
 * status surface is a feature nobody can debug after it misbehaves. The shape
 * is deliberately FLAT (no nesting, no optional fields): a status poll runs on
 * every SSE tick, so this has to be cheap, and an always-present block means a
 * client never has to distinguish "compression is off" from "the server is
 * old".
 */
export interface CompressionView {
  /** True when this process is allowed to compress at all (kill-switch read). */
  enabled: boolean;
  /** How many blocks are compressing the view right now (0 = no compression). */
  blocks: number;
  /**
   * The compressed ranges as `[from_turn, to_turn]` pairs, in the order they
   * sit in the log. Empty when nothing is compressed. The turn numbers are
   * enough to identify a block because ranges never overlap after
   * `normalizeBlocks`, so the list is unambiguous without ids.
   */
  ranges: [number, number][];
  /**
   * The water level at which the LAST block was written, or `null` when nothing
   * has been compressed. Kept as a historical reading (not a live one) so a
   * client can see whether the model's own trigger matched the operator's
   * expectation; the LIVE level is `context_usage.ratio` beside it.
   */
  last_ratio: number | null;
}

/**
 * The `CompressionView` of a session (an always-present, never-throwing block).
 *
 * `enabled:false` is the honest answer for a session with no sidecar: the
 * process may be compressing, but THIS session is not, because a detached or
 * kill-switched log has no store to read or write. An operator reading a status
 * poll then sees why `blocks` is 0 without having to know the layering.
 */
export function compressionViewOf(log: SessionLog | null | undefined): CompressionView {
  if (!compressionEnabled()) return { enabled: false, blocks: 0, ranges: [], last_ratio: null };
  const store = compressionStoreOf(log ?? null);
  if (log === null || log === undefined || store === null) {
    return { enabled: false, blocks: 0, ranges: [], last_ratio: null };
  }
  const blocks = store.blocks();
  // The block written LAST, not the one that STARTS latest. `blocks()` hands back
  // NORMALIZED (sorted by `from_turn`) blocks, so "the last element" is the range
  // with the largest start — a different block the moment the model compresses a
  // range BELOW one it already compressed. `created_turn` is what the write
  // recorded, so it is the honest key; equal turns (two blocks in one turn) keep
  // the later entry in store order.
  const last = blocks.reduce<CompressionBlock | null>(
    (best, block) => (best === null || block.created_turn >= best.created_turn ? block : best),
    null,
  );
  return {
    enabled: true,
    blocks: blocks.length,
    ranges: blocks.map((b) => [b.from_turn, b.to_turn] as [number, number]),
    last_ratio: last === null ? null : last.context_ratio,
  };
}