/**
 * Phase 2 · model-driven context compression — the SCHEMA and OVERLAY half.
 *
 * Compression never rewrites the log. The log stays append-only and the
 * compressed turns keep every event they ever had; what changes is the view
 * [SessionLog.deriveMessages] hands to the model, which replaces a covered
 * turn range with ONE summary block message. This module is that change,
 * stated as a pure function of (events, blocks).
 *
 * The interval arithmetic a range is built from — validation against the log
 * and the current turn, the nested-merge flattening, where a turn sits in
 * the event stream — lives next door in ./compression-range.ts. The split is
 * by responsibility: this half decides what a block MEANS and how the model
 * SEES it, that half decides which ranges are legal and how they sort.
 *
 * The two invariants both halves exist to protect:
 *
 *   1. **The log is the truth.** `events()` is untouched by compression; the
 *      overlay is a pure function of (events, blocks). A corrupt sidecar, a
 *      missing sidecar or a decompression all degrade to "no blocks", never
 *      to a rewritten history.
 *   2. **A turn is the atom.** Ranges are turn-number intervals, so a range
 *      never splits a turn — and a turn boundary always carries a complete
 *      tool_call/tool_result group (a turn's calls are flushed before the
 *      next event). The overlay re-runs [balanceToolCalls] anyway, because a
 *      cut can still strand a call whose result fell into a later turn.
 *
 * Turn ids are the ONLY stable anchor a caller can hold: a [Message] has no
 * id, and a [SessionEvent] has no ordinal id either (see projection.ts — the
 * tool_call accumulator makes message<->event non-1:1). `turn-<n>` is
 * therefore both the reference scheme and the boundary rule.
 */

import { balanceToolCalls, deriveMessagesFrom } from "./projection.js";
import { normalizeBlocks, turnEndIndex, turnStartIndex } from "./compression-range.js";
import type { CompressionRejection } from "./compression-range.js";
import type { Message } from "./message.js";
import type { SessionEvent } from "./types.js";

/** The sidecar file that holds a session's compressed ranges, beside its log. */
export const COMPRESSION_FILE = "compression.json";

/** Sidecar schema version. A future shape change bumps it; an unknown version resets. */
export const COMPRESSION_SCHEMA_VERSION = 1;

/**
 * One compressed range: the model sees [summary] in place of turns
 * `from`..`to`, while the log keeps every event of those turns.
 */
export interface CompressionBlock {
  /** Closed turn interval this block replaces. */
  from_turn: number;
  /** Closed turn interval's last turn, inclusive. */
  to_turn: number;
  /** The model-facing replacement text, written for the model's own future self. */
  summary: string;
  /** The turn the block was created in (never inside the compressed range). */
  created_turn: number;
  /** Context occupancy ratio (0..1) observed when the block was written. */
  context_ratio: number;
}

/** The sidecar as it is written to disk. */
export interface CompressionState {
  version: number;
  blocks: CompressionBlock[];
}

export const EMPTY_COMPRESSION_STATE: CompressionState = { version: COMPRESSION_SCHEMA_VERSION, blocks: [] };

/** The outcome of a `compress` / `decompress` request. */
export type CompressionOutcome =
  | { ok: true; block: CompressionBlock; merged: number }
  | { ok: false; code: CompressionRejection; message: string };

export type { CompressionRejection, TurnRange } from "./compression-range.js";
export {
  isValidRange,
  mergedBlockCount,
  normalizeBlocks,
  turnEndIndex,
  turnNumbersOf,
  turnStartIndex,
  validateRange,
} from "./compression-range.js";

/**
 * The model-visible text of one block.
 *
 * The header is a STABLE MARKER, not decoration: a model reading a later turn
 * needs to be able to tell "this is a summary standing in for turns 3-9" from
 * "this is what was literally said". The turn numbers are the citation
 * handle — the model can name them back through `context_status`.
 */
export function blockText(block: CompressionBlock): string {
  return (
    `[compressed turns ${block.from_turn}-${block.to_turn}] ` +
    `Summary of ${block.to_turn - block.from_turn + 1} earlier turn(s), written at turn ${block.created_turn}:\n` +
    block.summary
  );
}

/**
 * Project the log's events with every compressed range replaced by its block.
 *
 * Events are walked once. A turn whose number falls inside a normalized block
 * contributes ONE [blockText] message instead of its own projection, and every
 * turn outside every block projects exactly as it would have without the
 * overlay. [balanceToolCalls] then runs over the RESULT so a call stranded by
 * a cut is answered rather than leaving the request protocol-invalid.
 *
 * Pure: the same (events, blocks) always produce the same view, and no event
 * is mutated or removed from the log. Hide-consumed is therefore free — the
 * source events are still in the stream, extraction still reads them, and
 * only the view skips them.
 */
export function overlayCompressions(
  events: readonly SessionEvent[],
  blocks: readonly CompressionBlock[],
): Message[] {
  const cover = normalizeBlocks(blocks);
  if (cover.length === 0) return deriveMessagesFrom(events);
  const messages: Message[] = [];
  let index = 0;
  for (const block of cover) {
    const start = turnStartIndex(events, block.from_turn, index);
    if (start < 0) continue; // the log has no such turn: keep projecting what it does have
    const end = turnEndIndex(events, block.to_turn, index);
    // A not-found `to_turn` means the block over-claims past the end of the
    // history (a sidecar replayed into a shorter session). Covering up to the
    // end of the log is the only reading that loses nothing.
    const stop = end < 0 ? events.length : end;
    if (start > index) messages.push(...deriveMessagesFrom(events.slice(index, start)));
    messages.push({ role: "user", content: [{ type: "text", content: blockText(block) }], tool_call_id: null });
    index = Math.max(start, stop);
  }
  messages.push(...deriveMessagesFrom(events.slice(index)));
  balanceToolCalls(messages);
  return messages;
}

/**
 * The water level at which a cold range becomes worth compressing.
 *
 * Half the window is where the arithmetic starts paying: a block that
 * replaces a range is a few dozen tokens, so the nudge has to fire well
 * before the window is a problem. A constant rather than a knob because
 * the philosophy paragraph in the system prompt quotes it, and a quoted
 * number a config could move is a prompt that can lie.
 */
export const COMPRESSION_NUDGE_RATIO = 0.5;

/**
 * The water level at which the engine stops suggesting and starts insisting.
 *
 * Past this ratio the nudge text changes tone, and a turn that has no
 * cold range left to compress is refused rather than sent to a provider
 * that will reject it. The two thresholds are deliberately different:
 * the first is advice, the second is a floor.
 */
export const COMPRESSION_PREFLIGHT_RATIO = 0.8;

/**
 * The context budget arithmetic, in ONE place.
 *
 * Precedence, verbatim from the statusline's `contextUsage`: a provider-
 * reported `prompt_tokens` is the truth; without one, the assembled
 * estimate of the request that would be sent NOW is the next best thing;
 * with neither, the context is simply empty. A second implementation of
 * this order elsewhere is how a nudge and a statusline end up
 * disagreeing about the same turn.
 */
export function contextRatioFacts(input: ContextUsageInput): ContextUsageFacts {
  const window = input.window > 0 ? input.window : 0;
  if (input.promptTokens > 0) {
    return ratioFacts(input.promptTokens, window, false, "usage_prompt_tokens", false);
  }
  if (input.assembledTokens !== null && input.assembledTokens > 0) {
    return ratioFacts(input.assembledTokens, window, true, "assembled_estimate", false);
  }
  return { used: 0, window, ratio: 0, estimated: true, method: "none", projected: false };
}

/** The three numbers the water level is decided from. */
export interface ContextUsageInput {
  /** `prompt_tokens` the provider reported last turn; 0 when it reported none. */
  promptTokens: number;
  /** Tokens the assembled request would cost, or null when nothing is assembled. */
  assembledTokens: number | null;
  /** The profile's context window; 0 when nothing declares one. */
  window: number;
}

/** One water-level reading, with the ratio clamped into 0..1. */
function ratioFacts(
  used: number,
  window: number,
  estimated: boolean,
  method: ContextUsageFacts["method"],
  projected: boolean,
): ContextUsageFacts {
  const ratio = window > 0 ? Math.min(1, Math.max(0, used / window)) : 0;
  return { used, window, ratio, estimated, method, projected };
}

/**
 * The compression philosophy, merged into the system prompt when the
 * AgentConfig is constructed.
 *
 * It lives in the PROMPT, not in a tool description and not in a
 * per-step assembly, for three reasons the design settled on:
 *   - the system prompt is one frozen string, so `config.system_prompt` is
 *     exactly what the loop, the dedup visibility simulation and the
 *     statusline all estimate against. A reminder appended per step would
 *     break the prefix cache AND make the dedup simulation disagree with
 *     the real trimming the loop performs, which is the one thing that
 *     simulation is built to be safe about;
 *   - it survives a user-supplied system prompt, because the merge happens
 *     after the profile text is resolved;
 *   - the model needs the philosophy in the steps where no tool is
 *     called, which is most of them.
 */
const PHILOSOPHY_LINE_BREAK = String.fromCharCode(10);

export const COMPRESSION_PHILOSOPHY = [
  "Context compression. You have three tools for it: context_status (read-only:",
  "how full the context is, the turn numbers, the blocks that are compressed), compress",
  "(replace a CLOSED RANGE of earlier turns with one summary block you write), and",
  "decompress (put the original turns of one block back into the view).",
  "",
  "The discipline, in the order it matters:",
  "1. Compression is a TOOL, not an obligation. Below roughly half the window, leave",
  "   the history alone: it is what makes you useful, and a summary always loses",
  "   something. Call context_status when you are unsure, not on every turn.",
  "2. Compress COLD ranges only. Never the turn you are answering in, never the",
  "   recent turns you are actively reasoning across. A range you still need",
  "   verbatim is a range you will pay for twice.",
  "3. Write the summary for your own future self: what was decided and why, what was",
  "   learned with its evidence (paths, ids, commands), what is still open. Not a",
  "   transcript, not a narration of what you are doing now. It is the only trace",
  "   of those turns you will have.",
  "4. Failing is not scary. Nothing is ever deleted: decompress with the same range",
  "   brings the original turns back, so a bad summary is a cheap mistake, not a",
  "   loss. Compress the coldest thing you can live without, keep going, and",
  "   re-read the original only if you genuinely miss a detail.",
].join(PHILOSOPHY_LINE_BREAK);

/**
 * Append the philosophy to a system prompt, keeping the profile text first
 * and separated by a blank line.
 *
 * Appended, never substituted: the profile prompt is the operator identity
 * and a user override is their call, so the philosophy rides along with
 * whatever they wrote rather than replacing it. Idempotent, because a second
 * call on an already-merged prompt would double the text and break the cache
 * key.
 */
export function withCompressionPhilosophy(systemPrompt: string): string {
  if (systemPrompt.includes(COMPRESSION_PHILOSOPHY)) return systemPrompt;
  return systemPrompt.trimEnd() + String.fromCharCode(10, 10) + COMPRESSION_PHILOSOPHY;
}

/**
 * The context budget facts, in the shape the statusline already froze.
 *
 * A compression tool must NOT invent a second water-level arithmetic: the
 * one place that decides how full the context is is `status.ts`'s
 * `contextUsage`, and this interface is how that single answer reaches a
 * tool without the tools package having to import the runtime. Same field
 * names, same `method` vocabulary, same "real prompt first, assembled
 * estimate second" precedence — a caller can hand these straight to a UI.
 */
export interface ContextUsageFacts {
  /** Prompt tokens as the provider reported them, or the assembly estimate. */
  used: number;
  /** The profile context window (0 when nothing declares one). */
  window: number;
  /** `used / window`, clamped to 0..1. */
  ratio: number;
  /** True when `used` is an estimate rather than a provider-reported number. */
  estimated: boolean;
  /**
   * Which number `used` is: the provider's real `prompt_tokens`, an estimate
   * of the request that would be sent now, or nothing at all yet.
   */
  method: "usage_prompt_tokens" | "assembled_estimate" | "none";
  /** True when `used` is a projection of the next request, not this one. */
  projected: boolean;
}

/**
 * The seam a host provides so the `compress` / `decompress` / `context_status`
 * tools can act on a session without importing the session or the runtime.
 *
 * Everything here is a CALLBACK rather than a handle to storage: the tool
 * package is a tier-1 package and may only depend on `core`, so the host
 * closes over whatever late-bound log and status surface it has. The port is
 * deliberately read-mostly — `events()` is the RAW event stream (compression
 * is a view, so the tools validate against what actually happened), and
 * `save` is the only way state changes.
 */
export interface CompressionPort {
  /** The session's raw events — never the compressed view. */
  events(): readonly SessionEvent[];
  /** The turn in flight; a range ending at or after it can never be compressed. */
  currentTurn(): number;
  /** The blocks currently compressing the view. */
  blocks(): readonly CompressionBlock[];
  /** Persist a new block set (the store normalizes and de-duplicates). */
  save(blocks: readonly CompressionBlock[]): void;
  /** The host's context budget facts, or null before any status surface exists. */
  usage(): ContextUsageFacts | null;
}

/**
 * The host-side bundle of a compression port plus its read-only water level.
 *
 * Turn entry needs the ratio on its own (the 0.8 preflight) without also
 * being able to compress anything, so the two are separate methods here
 * rather than one wide object handed to the turn runner.
 */
export interface CompressionHost {
  /**
   * The port the model-facing tools are built over, or `null` when this
   * generation has no log to compress: a log with no compression sidecar
   * (in-memory, or opened before the file existed) has nowhere to persist a
   * block, so a stub port would report success for a compression that never
   * happened. The tools answer `null` with a `no_session` failure instead.
   */
  port(): CompressionPort | null;
  /** The current water level, or null when no status surface is wired yet. */
  usage(): ContextUsageFacts | null;
}
