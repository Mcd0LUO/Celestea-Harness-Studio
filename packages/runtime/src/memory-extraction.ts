/**
 * Phase 1 — background memory extraction (docs/feature-memory-extraction.md §4).
 *
 * After each turn ends, this scheduler re-reads the turn's events, runs ONE
 * structured-output LLM call (no tools, cheapest reasoning tier, capped output),
 * and applies the returned memory ops through an injected write callback. It is
 * deliberately best-effort: every failure is a stderr line and a cursor that
 * stays put (the next turn retries), never a thrown error into the turn path.
 *
 * Design decisions, and why:
 *
 *   - **Runtime hosts the scheduler; the host injects everything.**
 *     Runtime cannot import @celestea/tools (dependency direction), so the
 *     write callback, the manifest provider, and cursor persistence are all
 *     injected deps — the studio host wires them against the real memory store.
 *
 *   - **The cursor is {turn_id, event_count}, stored outside the log.**
 *     Session events carry no global sequence number, and compaction RENUMBERS
 *     turn ids, so a stored cursor can dangle. Validation: if the stored
 *     turn_id is not found at-or-before event_count, the cursor resets to the
 *     log start and re-scans (§5's mandated tolerance). Re-extraction is safe:
 *     the store dedups identical text (memoryTextHash NOOP) and the prompt's
 *     manifest pushes the model to update rather than duplicate.
 *
 *   - **Two skip gates, both advancing the cursor (ZCode parity):**
 *       1. the slice contains a direct remember/forget tool call — the model
 *          already wrote memory deliberately, extraction would double-write;
 *       2. the slice carries no real user prose (injected rows with an origin
 *          of skill/memory/receipt/steering/compact do not count) — nothing
 *          worth extracting happens in a turn the user barely spoke in.
 *     Skipped turns still advance the cursor: their content is never
 *     interesting later, and NOT advancing would re-scan them forever.
 *
 *   - **Unparseable output is a no-op, not an error.** The extraction call is
 *     cheap and best-effort; treating junk as "nothing to save" (and advancing)
 *     avoids a retry storm that re-pays the transcript every turn. A genuine
 *     transport/timeout failure does NOT advance — the slice is retried with
 *     the next turn's events appended.
 *
 *   - **Cost accounting is honest but separate.** Every completed extraction
 *     call books a ledger row with kind "extraction" (never a step row, never
 *     folded into turn_total); aggregate totals include it so the statusline
 *     reflects real spend.
 */

import {
  messageText,
  userMessage,
  zeroUsage,
  type Llm,
  type SessionEvent,
  type SessionLog,
  type Usage,
} from "@celestea/core";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** One memory operation the extraction pass decided on. */
export type ExtractionOp =
  | { readonly op: "add"; readonly text: string; readonly tags: readonly string[] }
  | { readonly op: "update"; readonly id: string; readonly text: string; readonly tags: readonly string[] }
  | { readonly op: "forget"; readonly id: string };

/** The outcome of applying one op through the host's write callback. */
export interface ExtractionWriteResult {
  readonly applied: boolean;
  /** Why an op was refused (unknown id, oversize text, …); diagnostics only. */
  readonly reason?: string;
}

/** The extraction cursor: how far into the log extraction has processed. */
export interface ExtractionCursor {
  /** The last fully processed turn id ("turn-N"); "" = nothing processed. */
  readonly turn_id: string;
  /** events()[0..event_count) are processed; extraction resumes there. */
  readonly event_count: number;
}

/** Host-persisted cursor storage (studio: a sidecar file in the session dir). */
export interface ExtractionCursorStore {
  load(): ExtractionCursor | null;
  save(cursor: ExtractionCursor): void;
}

/** Narrow ledger seam: what this module books per completed extraction call. */
export interface ExtractionLedgerInput {
  readonly turn_id: string | null;
  readonly usage: Usage;
  /** Ops actually applied by the write callback. */
  readonly entries: number;
  readonly status: "ok" | "no-op" | "error";
}

export interface MemoryExtractionDeps {
  /** Extraction-tuned client (host pins the cheapest reasoning tier + output cap). */
  readonly llm: Llm;
  /** Model id for the request (the wire falls back to the client's own default). */
  readonly model: string;
  /**
   * Apply one op to the workspace memory store (host: store layer, not the
   * tool). `turnId` is the slice's last turn id, for the entry's `source`
   * provenance (null when the slice has no turn boundary — detached).
   */
  write(op: ExtractionOp, turnId: string | null): ExtractionWriteResult;
  /** Render the current memory entries as a compact manifest for the prompt. */
  manifest(): string;
  /** Per-call usage accounting; absent = no ledger row. */
  bookExtraction?(input: ExtractionLedgerInput): void;
  /** Cursor persistence; absent = in-memory only (survives the scheduler's lifetime). */
  readonly cursor?: ExtractionCursorStore;
  /** Hard cap on one entry's text, mirrored into the prompt (host: MEMORY_ENTRY_MAX_BYTES). */
  readonly entryMaxBytes: number;
  /** Head-truncation budget for the rendered transcript (default 24_000). */
  readonly maxTranscriptBytes?: number;
  /** Minimum user prose before a turn is extraction-eligible (default 3 words). */
  readonly minUserWords?: number;
  /** max_tokens on the extraction request (default 2048). */
  readonly maxOutputTokens?: number;
  stderr?(line: string): void;
}

export interface MemoryExtractionScheduler {
  /** Queue extraction for the latest log state; coalesces with in-flight work. */
  schedule(log: SessionLog): void;
  /** Await all queued + in-flight extraction (idle-TTL eviction / shutdown). */
  drain(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TRANSCRIPT_BYTES = 24_000;
const DEFAULT_MIN_USER_WORDS = 3;
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
/** Tool names that count as a deliberate direct memory write (skip gate 1). */
const DIRECT_WRITE_TOOLS: ReadonlySet<string> = new Set(["remember", "forget"]);
/** user_message origins that are NOT real user prose. */
const INJECTED_ORIGINS: ReadonlySet<string> = new Set(["skill", "memory", "receipt", "steering", "compact"]);

/** Env switch: `CELESTEA_MEMORY_EXTRACTION=off` (or 0/false/no) disables extraction. */
export const ENV_MEMORY_EXTRACTION = "CELESTEA_MEMORY_EXTRACTION";

/** Default ON; `off` (and the usual falsey spellings) turns extraction off. */
export function memoryExtractionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[ENV_MEMORY_EXTRACTION] ?? "").trim().toLowerCase();
  return !["off", "0", "false", "no"].includes(raw);
}

/** The extraction system prompt. Constant text → prefix-cache friendly. */
export function extractionSystemPrompt(entryMaxBytes: number): string {
  return [
    "You are the memory-extraction pass of a coding-agent harness. Read the",
    "conversation transcript and decide what deserves durable, cross-session",
    "memory. Output ONLY a JSON object — no prose, no markdown fences:",
    "",
    '{"ops":[{"op":"add","text":"...","tags":["..."]},',
    '{"op":"update","id":"m3","text":"...","tags":["..."]},',
    '{"op":"forget","id":"m5"}]}',
    "",
    "Memory types: user (role, goals, preferences, constraints), feedback",
    "(corrections AND quietly confirmed approaches — include the WHY), project",
    "(who/what/why/by-when; relative dates become absolute ISO dates), reference",
    "(pointers to external systems).",
    "",
    "NEVER save: anything derivable from the codebase or git history, fix",
    "recipes, AGENTS.md content, or ephemeral task state.",
    "",
    "Prefer update over duplicates: when an existing entry (manifest in the user",
    "message) covers the fact, update that id. Use forget for entries that are",
    "now wrong.",
    "",
    `Each entry text is at most ${entryMaxBytes} UTF-8 bytes — facts, not essays.`,
    'Nothing worth saving -> {"ops":[]}. JSON only.',
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** One turn's worth of extracted slice: the events plus the closing turn id. */
export interface ExtractionSlice {
  readonly turn_id: string;
  /** events().length index AFTER this slice (the new cursor event_count). */
  readonly event_count: number;
  readonly events: readonly SessionEvent[];
}

/**
 * Cut the unprocessed tail of the log into extraction slices, one per COMPLETE
 * turn. A trailing partial turn (no turn_end yet) is left for the next pass.
 * A stored cursor whose turn_id no longer exists in the processed prefix
 * (compaction renumbered the log) resets to the log start.
 */
export function sliceUnprocessedTurns(
  events: readonly SessionEvent[],
  cursor: ExtractionCursor,
): { readonly cursor: ExtractionCursor; readonly slices: readonly ExtractionSlice[] } {
  let base = cursor;
  if (base.event_count > events.length || base.event_count < 0) {
    base = { turn_id: "", event_count: 0 };
  } else if (base.turn_id !== "") {
    const prefix = events.slice(0, base.event_count);
    const found = prefix.some((e) => e.type === "turn_end" && e.id === base.turn_id);
    if (!found) base = { turn_id: "", event_count: 0 };
  }
  const slices: ExtractionSlice[] = [];
  let start = base.event_count;
  for (let i = start; i < events.length; i++) {
    const e = events[i];
    if (e !== undefined && e.type === "turn_end") {
      slices.push({ turn_id: e.id, event_count: i + 1, events: events.slice(start, i + 1) });
      start = i + 1;
    }
  }
  return { cursor: base, slices };
}

/** Skip gate 1: the model already wrote memory directly in this slice. */
export function containsDirectMemoryWrite(events: readonly SessionEvent[]): boolean {
  return events.some((e) => e.type === "tool_call" && DIRECT_WRITE_TOOLS.has(e.name));
}

/** Real user prose only: injected rows (origin != user) never count. */
export function userProseOf(events: readonly SessionEvent[]): string {
  return events
    .filter(
      (e): e is Extract<SessionEvent, { type: "user_message" }> =>
        e.type === "user_message" && (e.origin === undefined || e.origin === "user"),
    )
    .map((e) => e.text)
    .join("\n");
}

/**
 * Skip gate 2: enough user prose to make extraction worthwhile. Word-based like
 * ZCode's MINIMUM_USER_WORDS, with a CJK-aware fallback (whitespace splitting
 * sees "记住这个偏好" as one word; the character floor at ~3 chars/word catches it).
 */
export function hasEligibleUserProse(prose: string, minWords: number): boolean {
  const words = prose.split(/\s+/).filter(Boolean).length;
  if (words >= minWords) return true;
  return prose.replace(/\s/g, "").length >= minWords * 3;
}

/** Render a slice as a compact transcript for the extraction prompt. */
export function renderExtractionTranscript(events: readonly SessionEvent[], maxBytes: number): string {
  const lines: string[] = [];
  for (const e of events) {
    switch (e.type) {
      case "turn_start":
        lines.push(`--- ${e.id} begin ---`);
        break;
      case "turn_end":
        lines.push(`--- ${e.id} end ---`);
        break;
      case "user_message": {
        const origin = e.origin === undefined || e.origin === "user" ? "user" : `user/${e.origin}`;
        lines.push(`[${origin}] ${e.text}`);
        break;
      }
      case "assistant_message":
        lines.push(`[assistant] ${e.text}`);
        break;
      case "thinking_delta":
        break; // chain-of-thought never enters memory
      case "tool_call":
        lines.push(`[tool_call ${e.name}] ${preview(e.args)}`);
        break;
      case "tool_result":
        lines.push(`[tool_result] ${preview(e.error ?? e.value)}`);
        break;
      default:
        break;
    }
  }
  const full = lines.join("\n");
  if (byteLength(full) <= maxBytes) return full;
  // Keep the tail (recent context decides what is worth saving), mark the cut.
  const marker = "[transcript head truncated]\n";
  let tail = full;
  while (byteLength(marker + tail) > maxBytes && tail.length > 0) {
    tail = tail.slice(Math.ceil(tail.length / 2));
  }
  return marker + tail;
}

/** Parse the model's JSON output. Returns [] for "nothing" AND for junk. */
export function parseExtractionOps(text: string, entryMaxBytes: number): {
  readonly ops: readonly ExtractionOp[];
  readonly refused: number;
} {
  const json = extractJsonObject(text);
  if (json === null) return { ops: [], refused: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ops: [], refused: 0 };
  }
  if (typeof parsed !== "object" || parsed === null) return { ops: [], refused: 0 };
  const rawOps = (parsed as Record<string, unknown>)["ops"];
  if (!Array.isArray(rawOps)) return { ops: [], refused: 0 };
  const ops: ExtractionOp[] = [];
  let refused = 0;
  for (const raw of rawOps) {
    const op = normalizeOp(raw, entryMaxBytes);
    if (op === null) refused += 1;
    else ops.push(op);
  }
  return { ops, refused };
}

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

export function createMemoryExtractionScheduler(deps: MemoryExtractionDeps): MemoryExtractionScheduler {
  const stderr = deps.stderr ?? (() => undefined);
  const maxTranscriptBytes = deps.maxTranscriptBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES;
  const minUserWords = deps.minUserWords ?? DEFAULT_MIN_USER_WORDS;
  const maxOutputTokens = deps.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const system = extractionSystemPrompt(deps.entryMaxBytes);

  let memoryCursor: ExtractionCursor | null = null;
  let pendingLog: SessionLog | null = null;
  let running: Promise<void> | null = null;

  const loadCursor = (): ExtractionCursor => {
    if (memoryCursor !== null) return memoryCursor;
    try {
      memoryCursor = deps.cursor?.load() ?? { turn_id: "", event_count: 0 };
    } catch {
      memoryCursor = { turn_id: "", event_count: 0 };
    }
    return memoryCursor;
  };

  const saveCursor = (cursor: ExtractionCursor): void => {
    memoryCursor = cursor;
    try {
      deps.cursor?.save(cursor);
    } catch (error) {
      stderr(`memory-extraction: cursor save failed: ${String(error)}`);
    }
  };

  const extractSlice = async (slice: ExtractionSlice): Promise<void> => {
    const cursor: ExtractionCursor = { turn_id: slice.turn_id, event_count: slice.event_count };
    // Gate 1: a deliberate direct write makes extraction redundant this turn.
    if (containsDirectMemoryWrite(slice.events)) {
      saveCursor(cursor);
      return;
    }
    // Gate 2: too little real user prose to contain anything durable.
    if (!hasEligibleUserProse(userProseOf(slice.events), minUserWords)) {
      saveCursor(cursor);
      return;
    }
    const transcript = renderExtractionTranscript(slice.events, maxTranscriptBytes);
    const prompt = `Existing memory entries (id — text):\n${deps.manifest()}\n\nTranscript:\n${transcript}`;
    let text = "";
    let usage = zeroUsage();
    let failed: string | null = null;
    try {
      const stream = await deps.llm.generate({
        model: deps.model,
        system,
        messages: [userMessage(prompt)],
        tools: [],
        max_tokens: maxOutputTokens,
        temperature: null,
      });
      for await (const event of stream) {
        if (event.kind === "text") text += event.text;
        else if (event.kind === "usage") usage = event.usage;
        else if (event.kind === "failed") failed = event.message;
        else if (event.kind === "interrupted") failed = "interrupted";
        else if (event.kind === "done" && text === "") text = messageText(event.message) ?? "";
      }
    } catch (error) {
      failed = String(error);
    }
    if (failed !== null) {
      stderr(`memory-extraction: ${slice.turn_id} failed: ${failed}`);
      deps.bookExtraction?.({ turn_id: slice.turn_id, usage, entries: 0, status: "error" });
      return; // cursor NOT advanced — retried with the next turn's events
    }
    const { ops } = parseExtractionOps(text, deps.entryMaxBytes);
    let applied = 0;
    for (const op of ops) {
      try {
        const result = deps.write(op, slice.turn_id);
        if (result.applied) applied += 1;
        else stderr(`memory-extraction: op refused (${result.reason ?? "unknown"})`);
      } catch (error) {
        stderr(`memory-extraction: write failed: ${String(error)}`);
      }
    }
    deps.bookExtraction?.({
      turn_id: slice.turn_id,
      usage,
      entries: applied,
      status: applied > 0 ? "ok" : "no-op",
    });
    saveCursor(cursor);
  };

  const pump = async (): Promise<void> => {
    for (;;) {
      const log = pendingLog;
      pendingLog = null;
      if (log === null) return;
      let events: readonly SessionEvent[];
      try {
        events = log.events();
      } catch (error) {
        stderr(`memory-extraction: log read failed: ${String(error)}`);
        continue;
      }
      const { cursor, slices } = sliceUnprocessedTurns(events, loadCursor());
      if (cursor.event_count !== loadCursor().event_count) saveCursor(cursor);
      for (const slice of slices) await extractSlice(slice);
    }
  };

  return {
    schedule(log: SessionLog): void {
      pendingLog = log;
      if (running === null) {
        running = pump().finally(() => {
          running = null;
          // A schedule() that landed during the finally() re-arms the pump.
          if (pendingLog !== null) this.schedule(pendingLog);
        });
      }
    },
    async drain(): Promise<void> {
      // schedule() can only be called from the turn path; draining after the
      // last turn settles every queued pass.
      while (running !== null) await running;
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function preview(value: unknown): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Pull the first balanced {...} block out of the model's output. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function normalizeOp(raw: unknown, entryMaxBytes: number): ExtractionOp | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const tags = Array.isArray(o["tags"]) ? o["tags"].filter((t): t is string => typeof t === "string") : [];
  if (o["op"] === "add" && typeof o["text"] === "string" && o["text"].trim() !== "") {
    if (byteLength(o["text"]) > entryMaxBytes) return null; // refuse, never cut
    return { op: "add", text: o["text"], tags };
  }
  if (
    o["op"] === "update" &&
    typeof o["id"] === "string" &&
    typeof o["text"] === "string" &&
    o["text"].trim() !== ""
  ) {
    if (byteLength(o["text"]) > entryMaxBytes) return null;
    return { op: "update", id: o["id"], text: o["text"], tags };
  }
  if (o["op"] === "forget" && typeof o["id"] === "string") {
    return { op: "forget", id: o["id"] };
  }
  return null;
}
