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
