/** The `from_turn` argument, described the way the model needs it. */
function fromTurnArg(of: string): Record<string, unknown> {
  return {
    type: "integer",
    minimum: 1,
    description:
      `First turn of the range${of}, as a turn NUMBER (1 = the first turn of this session). Inclusive.`,
  };
}

/** The `to_turn` argument: compress forbids the turn in flight, decompress does not care. */
function toTurnArg(of: string, current: boolean): Record<string, unknown> {
  if (current) {
    return {
      type: "integer",
      minimum: 1,
      description:
        "Last turn of the range. Inclusive, and MUST be strictly less than the current turn - the turn in flight cannot be compressed. Use context_status to see the numbers.",
    };
  }
  return {
    type: "integer",
    minimum: 1,
    description: `Last turn of the range${of}. Inclusive.`,
  };
}

/** The frozen spec of `compress`. */
export function compressSpec(): ToolSpec {
  return {
    name: "compress",
    description: COMPRESS_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        from_turn: fromTurnArg(" to compress"),
        to_turn: toTurnArg(" to compress", true),
        summary: {
          type: "string",
          description:
            "The replacement text, written for your own future self: decisions made, facts learned with their evidence (paths, ids, commands), open questions, and anything you must not forget. It is the only trace of those turns you will have in the view, so do not write a narration or a transcript, and do not leave out the details you would otherwise have to re-derive.",
        },
        desc: descParam(),
      },
      required: ["from_turn", "to_turn", "summary"],
      additionalProperties: false,
    },
  };
}

/** The frozen spec of `decompress`. */
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
          description:
            "First turn of the block to restore - the from_turn of an existing compress call. Inclusive.",
        },
        to_turn: {
          type: "integer",
          minimum: 1,
          description:
            "Last turn of the block to restore - the to_turn of that same compress call. Inclusive.",
        },
        desc: descParam(),
      },
      required: ["from_turn", "to_turn"],
      additionalProperties: false,
    },
  };
}

/** The frozen spec of `context_status`. */
export function contextStatusSpec(): ToolSpec {
  return {
    name: "context_status",
    description: CONTEXT_STATUS_DESCRIPTION,
    parameters: {
      type: "object",
      properties: { desc: descParam() },
      required: [],
      additionalProperties: false,
    },
  };
}
