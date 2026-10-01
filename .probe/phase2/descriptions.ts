export const COMPRESS_DESCRIPTION =
  "Replace a CLOSED RANGE of earlier turns with one summary block, so the same information costs far fewer context tokens." +
  "This is a tool, not an obligation: compress only when the context is genuinely getting full (context_status tells you), and only a COLD range - never the turn you are answering in." +
  "Send {from_turn, to_turn} as turn numbers (turn 1 is the first turn of this session; context_status lists them), never message numbers or indexes." +
  "The engine refuses a range that does not line up with turn boundaries, a turn that does not exist, or any range whose to_turn is the current turn or later." +
  "Write the summary for your own future self: what was decided, what was learned, what is still open, and where the evidence is (file paths, ids, commands) - not a transcript and not a narration of what you are doing now." +
  "The history is not deleted: the log keeps every original event, and if the summary turns out to be wrong or insufficient you can call decompress with the same range to get the original turns back." +
  "Re-compressing a range that already contains a block merges into it (your summary then replaces the old one, so carry its still-relevant content forward)." +
  "The result is {ok:true, block:{from_turn,to_turn,summary,created_turn,context_ratio}, merged:<how many earlier blocks were absorbed>}; a refused range returns a structured error naming the reason and changes nothing.";

export const DECOMPRESS_DESCRIPTION =
  "Undo a compress: the original turns of one block go back into the view, in full, exactly as they were (nothing was ever deleted from the log - compression only changed what the model sees)." +
  "Compression is meant to be reversible, so a summary that lost a detail you need is a normal situation and not a failure: call decompress with the block's own {from_turn,to_turn} and read the original turns again." +
  "Pass a range that matches NO current block and nothing changes." +
  "Note the cost: the restored turns take their tokens back, so decompress the smallest block that has what you are missing rather than everything, and re-compress it afterwards if you no longer need it." +
  "The result is {ok:true, from_turn, to_turn, restored_turns:<how many turns came back>}; a range with no block returns {ok:false, code:'no_such_block'} and changes nothing.";

export const CONTEXT_STATUS_DESCRIPTION =
  "Report how full this session's context is, and what is currently compressed." +
  "Read-only: it changes nothing." +
  "Use it when you are unsure whether to compress (that is the normal case - compression is a tool, not a routine) and before you pick a range." +
  "The result is {context:{used,window,ratio,method,estimated,projected}, turn:{current,turns}, blocks:[{from_turn,to_turn,created_turn,context_ratio,summary_chars}], current_turn}." +
  "method is 'usage_prompt_tokens' when the provider reported a real prompt size, 'assembled_estimate' when the figure is an estimate of the request that would be sent now, and 'none' before anything has been generated." +
  "ratio is used/window and is the number to weigh your decision against: 0.5 is the point where a cold range is worth compressing, 0.8 is where the engine starts insisting." +
  "The ranges in blocks are exactly the ranges decompress accepts.";

