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

/** The line break the philosophy is assembled with, named so the join reads. */
const PHILOSOPHY_LINE_BREAK = String.fromCharCode(10);

/**
 * Append the philosophy to a system prompt, keeping the profile text first
 * and separated by a blank line.
 *
 * Appended, never substituted: the profile prompt is the operator identity
 * and a user override is their call, so the philosophy rides along with
 * whatever they wrote rather than replacing it. Idempotent, because a second
 * call on an already-merged prompt would double the text and break the cache key.
 */
export function withCompressionPhilosophy(systemPrompt: string): string {
  if (systemPrompt.includes(COMPRESSION_PHILOSOPHY)) return systemPrompt;
  return systemPrompt.trimEnd() + String.fromCharCode(10, 10) + COMPRESSION_PHILOSOPHY;
}
