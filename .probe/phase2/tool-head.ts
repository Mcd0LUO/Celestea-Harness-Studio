/**
 * W1900 (Phase 2) - `compress` / `decompress` / `context_status`.
 *
 * These are the only three tools in the package that act on the session
 * ITSELF rather than on a file, a process or a URL, which is why they are
 * written against a port instead of a store. `@celestea/tools` is a tier-1
 * package and may only depend on `core` (see .dependency-cruiser.cjs), so
 * the host closes over whatever late-bound log and status surface it has and
 * hands it over as [CompressionPort]. Every range decision below is made
 * against RAW events - the compressed view is exactly what a range is
 * checked before it disappears, so validating against it would be circular.
 *
 * The three refusals that matter are all decided by the ENGINE, never by
 * the prompt: a range the log never had, a range that is not turn-aligned
 * and a range reaching the turn in flight. A prompt-only rule is a rule the
 * model can forget at exactly the moment it would have mattered.
 *
 * Nothing here writes to the log, so compression leaves the append-only
 * history and Phase 1's extraction (which reads `log.events()`) untouched.
 */

import {
  contextRatioFacts,
  mergedBlockCount,
  normalizeBlocks,
  turnNumbersOf,
  validateRange,
  type CompressionBlock,
  type CompressionPort,
  type CompressionRejection,
  type ContextUsageFacts,
  type TurnRange,
} from "@celestea/core";
import type { Tool, ToolSpec } from "@celestea/core";

import { descParam } from "../desc.js";
import { contractFailure } from "../errors.js";
import { fnTool } from "../fn-tool.js";

/** Stable prefix of every structured `compress` / `decompress` error. */
export const COMPRESSION_ERROR_PREFIX = "compress";
