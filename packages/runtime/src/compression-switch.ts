/**
 * The model-driven compression feature switch.
 *
 * `CELESTEA_MEMORY_COMPRESSION=off` (or 0/false/no) turns the whole face off:
 * no philosophy paragraph in the system prompt, no nudge, no preflight gate
 * and none of the three tools mounted. Sessions that already carry a
 * `compression.json` keep the file, but nothing reads it, so a kill switch is
 * reversible — turn it back on and the blocks are in the view again.
 *
 * The switch lives in the runtime, not in core, because it answers "may this
 * PROCESS be a compressing one?" and every layer that has to honour the answer
 * — the config projection, the log assembly, the tool mount — already depends
 * on the runtime. Same shape and the same falsey spellings as
 * `memoryExtractionEnabled` in ./memory-extraction.ts, so one operator learns
 * one rule.
 */

/** Env switch: `CELESTEA_MEMORY_COMPRESSION=off` disables model-driven compression. */
export const ENV_MEMORY_COMPRESSION = "CELESTEA_MEMORY_COMPRESSION";

/** Default ON; `off` (and the usual falsey spellings) turns compression off. */
export function compressionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[ENV_MEMORY_COMPRESSION] ?? "").trim().toLowerCase();
  return !["off", "0", "false", "no"].includes(raw);
}
