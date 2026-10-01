/**
 * W1900 (Phase 2) — `compress` / `decompress` / `context_status`: the
 * model-facing face of context compression.
 *
 * Compression is a TOOL here, not an engine behaviour: the model decides when
 * the context is full, which COLD range to fold, and writes the summary that
 * replaces it. The engine only validates, persists, and projects. That split
 * is what keeps the two hard promises cheap:
 *
 *   - **The log is the truth.** Nothing here appends, edits or removes an
 *     event. `compress` writes a block into the sidecar; `decompress` takes
 *     it back out. The same range can be restored and folded again forever,
 *     and the original turns never stop existing under the overlay.
 *   - **A turn is the atom.** Both tools take a TURN RANGE, because the turn
 *     id is the only stable anchor that exists (a Message has no id and a
 *     SessionEvent has no ordinal id — see projection.ts), and because a turn
 *     boundary always carries a complete tool_call/tool_result group. So
 *     there is no safe-cut problem to solve and no per-message reference
 *     numbers to render.
 *
 * These are HOST tools, like `remember`/`forget`: the compression state
 * belongs to a live session log, so the caller injects a `CompressionHost`
 * port and an embedding with no session leaves them UNREGISTERED — the model
 * is then never told a tool exists that could only fail. @celestea/tools is a
 * tier-1 package and may only depend on core, which is exactly why the port
 * (`compression.ts` in core) is a set of callbacks over the late-bound log
 * and the status surface rather than a handle to storage.
 *
 * Rejection is structured, never a throw-with-a-stack: every refusal comes
 * back as `{ok:false, code, message}` naming which rule the range broke, so
 * a model that guesses a bad range learns WHY and can retry once instead of
 * abandoning compression entirely. A range that is refused changes nothing —
 * not the sidecar, not the view.
 */

import type { CompressionHost, CompressionPort, CompressionRejection, ContextUsageFacts, Tool, ToolSpec } from "@celestea/core";
import { COMPRESSION_NUDGE_RATIO, COMPRESSION_PREFLIGHT_RATIO, turnNumbersOf, validateRange } from "@celestea/core";

import { optionalIntArg } from "../args.js";
import { descParam } from "../desc.js";
import { contractFailure } from "../errors.js";

/** Stable prefix of every structured compression-tool error. */
export const COMPRESSION_ERROR_PREFIX = "compression";

/** The model-facing behaviour descriptions (mirrored by contracts/tools.json). */
export const COMPRESS_DESCRIPTION =
  "Replace a CLOSED RANGE of earlier turns with one summary block, so the same information costs far fewer context tokens. This is a tool, not an obligation: compress only when the context is genuinely getting full (context_status tells you), and only a COLD range - never the turn you are answering in. Send {from_turn, to_turn} as turn numbers (turn 1 is the first turn of this session; context_status lists them), never message numbers or indexes. The engine refuses a range that does not line up with turn boundaries, a turn that does not exist, or any range whose to_turn is the current turn or later. Write the summary for your own future self: what was decided, what was learned, what is still open, and where the evidence is (file paths, ids, commands) - not a transcript and not a narration of what you are doing now. The history is not deleted: the log keeps every original event, and if the summary turns out to be wrong or insufficient you can call decompress with the same range to get the original turns back. Re-compressing a range that already contains a block merges into it (your summary then replaces the old one, so carry its still-relevant content forward). The result is {ok:true, block:{from_turn,to_turn,summary,created_turn,context_ratio}, merged:<how many earlier blocks were absorbed>}; a refused range returns a structured error naming the reason and changes nothing.";
export const DECOMPRESS_DESCRIPTION =
  "Undo a compress: the original turns of one block go back into the view, in full, exactly as they were (nothing was ever deleted from the log - compression only changed what the model sees). Compression is meant to be reversible, so a summary that lost a detail you need is a normal situation and not a failure: call decompress with the block's own {from_turn,to_turn} and read the original turns again. Pass a range that matches NO current block and nothing changes. Note the cost: the restored turns take their tokens back, so decompress the smallest block that has what you are missing rather than everything, and re-compress it afterwards if you no longer need it. The result is {ok:true, from_turn, to_turn, restored_turns:<how many turns came back>}; a range with no block returns {ok:false, code:'no_such_block'} and changes nothing.";
export const CONTEXT_STATUS_DESCRIPTION =
  "Report how full this session's context is, and what is currently compressed. Read-only: it changes nothing. Use it when you are unsure whether to compress (that is the normal case - compression is a tool, not a routine) and before you pick a range. The result is {context:{used,window,ratio,method,estimated,projected}, turn:{current,turns}, blocks:[{from_turn,to_turn,created_turn,context_ratio,summary_chars}], current_turn}. method is 'usage_prompt_tokens' when the provider reported a real prompt size, 'assembled_estimate' when the figure is an estimate of the request that would be sent now, and 'none' before anything has been generated. ratio is used/window and is the number to weigh your decision against: 0.5 is the point where a cold range is worth compressing, 0.8 is where the engine starts insisting. The ranges in blocks are exactly the ranges decompress accepts.";

/** How a refused range is explained to the model, per rejection reason. */
const REJECTION_HINTS: Record<CompressionRejection, string> = {
  not_aligned: "the range does not line up with whole turns of this session",
  unknown_turn: "the log has no such turn yet - only turns that already happened can be compressed",
  current_turn: "the turn in flight cannot be compressed; to_turn must be strictly less than the current turn",
  inverted: "from_turn must be at least 1 and no greater than to_turn",
  empty: "the range covers no turn",
};

function portOf(host: CompressionHost): CompressionPort {
  const port = host.port();
  if (port === undefined || port === null) {
    throw contractFailure(COMPRESSION_ERROR_PREFIX, "no_session", "no live session log is bound to this generation");
  }
  return port;
}

/** The two turn numbers, validated as integers. */
function rangeOf(args: unknown): { from: number; to: number } {
  const from = optionalIntArg(args, "from_turn");
  const to = optionalIntArg(args, "to_turn");
  if (from === undefined) throw contractFailure(COMPRESSION_ERROR_PREFIX, "missing_arg", "from_turn is required and must be an integer turn number");
  if (to === undefined) throw contractFailure(COMPRESSION_ERROR_PREFIX, "missing_arg", "to_turn is required and must be an integer turn number");
  // Turn NUMBERS below 1 are not an argument-shape problem: they are a range
  // that breaks the engine's own rule, so they are left to `validateRange` and
  // come back as a structured `inverted` refusal like every other bad range.
  return { from, to };
}

function compress(host: CompressionHost, args: unknown): unknown {
  const port = portOf(host);
  const range = rangeOf(args);
  const summaryRaw = (args as Record<string, unknown>)["summary"];
  if (typeof summaryRaw !== "string" || summaryRaw.trim() === "") {
    throw contractFailure(COMPRESSION_ERROR_PREFIX, "empty_summary", "summary must be the replacement text; an empty summary would lose the turns it claims to replace");
  }
  const rejection = validateRange(port.events(), range, port.currentTurn());
  if (rejection !== null) {
    return { ok: false, code: rejection, message: REJECTION_HINTS[rejection] };
  }
  const usage = port.usage();
  const block = {
    from_turn: range.from,
    to_turn: range.to,
    summary: summaryRaw.trim(),
    created_turn: port.currentTurn(),
    context_ratio: usage === null ? 0 : usage.ratio,
  };
  // A range that COVERS an existing block replaces it: the new summary is a
  // summary of summaries, and counting what it absorbed is what the model
  // needs to know it did not just shadow a block.
  const superseded = port.blocks().filter((b) => range.from <= b.from_turn && range.to >= b.to_turn).length;
  port.save([...port.blocks().filter((b) => !(range.from <= b.from_turn && range.to >= b.to_turn)), block]);
  return { ok: true, block, merged: superseded };
}

function decompress(host: CompressionHost, args: unknown): unknown {
  const port = portOf(host);
  const range = rangeOf(args);
  const target = port.blocks().find((b) => b.from_turn === range.from && b.to_turn === range.to);
  if (target === undefined) {
    return { ok: false, code: "no_such_block", message: "no compressed block has exactly this range; call context_status to see the ranges decompress accepts" };
  }
  // Matched BY RANGE, never by reference: the store hands out fresh copies of
  // its blocks, so an identity filter would silently keep the block it meant to
  // drop and `decompress` would report success while changing nothing.
  port.save(port.blocks().filter((b) => b.from_turn !== target.from_turn || b.to_turn !== target.to_turn));
  return { ok: true, from_turn: target.from_turn, to_turn: target.to_turn, restored_turns: target.to_turn - target.from_turn + 1 };
}

function contextStatus(host: CompressionHost): unknown {
  const port = portOf(host);
  const usage = host.usage() ?? port.usage();
  const context = usage === null
    ? { used: 0, window: 0, ratio: 0, estimated: true, method: "none" as const, projected: false }
    : usage;
  return {
    context,
    turn: { current: port.currentTurn(), turns: turnNumbersOf(port.events()) },
    blocks: port.blocks().map((b) => ({
      from_turn: b.from_turn,
      to_turn: b.to_turn,
      created_turn: b.created_turn,
      context_ratio: b.context_ratio,
      summary_chars: b.summary.length,
    })),
    current_turn: port.currentTurn(),
  };
}

export function compressSpec(): ToolSpec {
  return {
    name: "compress",
    description: COMPRESS_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        from_turn: {
          type: "integer",
          minimum: 1,
          description: "First turn of the range to compress, as a turn NUMBER (1 = the first turn of this session). Inclusive.",
        },
        to_turn: {
          type: "integer",
          minimum: 1,
          description: "Last turn of the range to compress. Inclusive, and MUST be strictly less than the current turn - the turn in flight cannot be compressed. Use context_status to see the numbers.",
        },
        summary: {
          type: "string",
          description: "The replacement text, written for your own future self: decisions made, facts learned with their evidence (paths, ids, commands), open questions, and anything you must not forget. It is the only trace of those turns you will have in the view, so do not write a narration or a transcript, and do not leave out the details you would otherwise have to re-derive.",
        },
        desc: descParam(),
      },
      required: ["from_turn", "to_turn", "summary"],
      additionalProperties: false,
    },
  };
}

export function decompressSpec(): ToolSpec {
  return {
    name: "decompress",
    description: DECOMPRESS_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        from_turn: {
          type: "integer",
          minimum: 1,
          description: "First turn of the block to restore - the from_turn of an existing compress call. Inclusive.",
        },
        to_turn: {
          type: "integer",
          minimum: 1,
          description: "Last turn of the block to restore - the to_turn of that same compress call. Inclusive.",
        },
        desc: descParam(),
      },
      required: ["from_turn", "to_turn"],
      additionalProperties: false,
    },
  };
}

export function contextStatusSpec(): ToolSpec {
  return {
    name: "context_status",
    description: CONTEXT_STATUS_DESCRIPTION,
    parameters: {
      type: "object",
      properties: { desc: descParam() },
      additionalProperties: false,
    },
  };
}

function hostTool(spec: () => ToolSpec, run: (host: CompressionHost, args: unknown) => unknown, host: CompressionHost): Tool {
  const frozen = spec();
  return { spec: () => frozen, execute: async (args) => run(host, args) };
}

export function compressTool(host: CompressionHost): Tool {
  return hostTool(compressSpec, compress, host);
}

export function decompressTool(host: CompressionHost): Tool {
  return hostTool(decompressSpec, decompress, host);
}

export function contextStatusTool(host: CompressionHost): Tool {
  return hostTool(contextStatusSpec, () => contextStatus(host), host);
}

/** The three compression tools, in the contract's own order. */
export function compressionTools(host: CompressionHost): Tool[] {
  return [compressTool(host), decompressTool(host), contextStatusTool(host)];
}

/** The water levels the tool face and the prompt quote, re-exported for hosts. */
export { COMPRESSION_NUDGE_RATIO, COMPRESSION_PREFLIGHT_RATIO };
export type { ContextUsageFacts };
