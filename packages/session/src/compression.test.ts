/**
 * W1900 (Phase 2) — the compression sidecar and the log decorator.
 *
 * Two contracts are load-bearing here, so they are asserted directly:
 *
 *   1. **The log is the truth.** `compressedLog` is a transparent Proxy: the
 *      only member whose behaviour changes is `deriveMessages()`. `events()`
 *      still returns every row, which is what keeps Phase 1 extraction (which
 *      reads the raw stream) and replay untouched.
 *   2. **Corruption degrades, it never crashes.** A missing, unparseable,
 *      foreign-version or hand-mangled `compression.json` all read back as
 *      "nothing compressed", and an unwritable one warns instead of throwing,
 *      because a turn must not die over a sidecar.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySessionLog, PersistentSessionLog } from "@celestea/session";
import { COMPRESSION_FILE, COMPRESSION_SCHEMA_VERSION } from "@celestea/core";
import type { Message, SessionEvent } from "@celestea/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  compressionPathFor,
  compressionStoreOf,
  compressionVersionOf,
  compressedLog,
  FileCompressionStore,
  MemoryCompressionStore,
  readCompressionState,
} from "./index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "compression-"));
  dirs.push(dir);
  return dir;
}

function block(from: number, to: number, summary = "S") {
  return { from_turn: from, to_turn: to, summary, created_turn: to + 1, context_ratio: 0.6 };
}

/** Append one turn: start, a question, an answer, end. */
function appendTurn(log: { append(e: SessionEvent): void }, n: number, text: string): void {
  log.append({ type: "turn_start", id: `turn-${n}` });
  log.append({ type: "user_message", text: `q${n} ${text}` });
  log.append({ type: "assistant_message", text: `a${n} ${text}` });
  log.append({ type: "turn_end", id: `turn-${n}`, outcome: "completed" });
}

function fill(log: { append(e: SessionEvent): void }, count: number, body = "hello"): void {
  for (let n = 1; n <= count; n += 1) appendTurn(log, n, body);
}

/** The block text carries a header line, so summaries are matched as substrings. */
function carries(messages: readonly Message[], needle: string): boolean {
  return texts(messages).some((t) => t.includes(needle));
}

function texts(messages: readonly Message[]): string[] {
  const out: string[] = [];
  for (const message of messages) {
    let text = "";
    for (const part of message.content) if (part.type === "text") text += part.content;
    out.push(text);
  }
  return out;
}

describe("W1900 · the sidecar round-trips (data-file contract)", () => {
  it("writes the versioned state beside the log and reads it back", () => {
    const dir = tmpDir();
    const store = new FileCompressionStore(dir);
    store.save([block(1, 3), block(5, 7, "second")]);

    const path = compressionPathFor(dir);
    expect(path).toBe(join(dir, COMPRESSION_FILE));
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { version: number; blocks: unknown[] };
    expect(onDisk.version).toBe(COMPRESSION_SCHEMA_VERSION);
    expect(onDisk.blocks).toHaveLength(2);

    // A fresh store in the same directory sees them: the state outlives the process.
    expect(new FileCompressionStore(dir).blocks().map((b) => [b.from_turn, b.to_turn])).toEqual([[1, 3], [5, 7]]);
  });

  it("hands out COPIES, so a caller cannot mutate the live list", () => {
    const store = new MemoryCompressionStore([block(1, 2)]);
    const first = store.blocks();
    first[0]!.summary = "tampered";
    expect(store.blocks()[0]?.summary).toBe("S");
  });

  it("bumps its version on every mutation (the overlay changes with no event)", () => {
    const store = new MemoryCompressionStore();
    const before = store.version();
    store.save([block(1, 1)]);
    store.save([block(1, 1)]);
    expect(store.version()).toBe(before + 2);
  });

  it("sorts and normalizes what it is given, so an unordered save is still sane", () => {
    const store = new MemoryCompressionStore();
    store.save([block(7, 8), block(1, 2)]);
    expect(store.blocks().map((b) => [b.from_turn, b.to_turn])).toEqual([[1, 2], [7, 8]]);
  });
});

describe("W1900 · a corrupt sidecar resets instead of crashing", () => {
  it("reads a missing file as nothing compressed", () => {
    expect(readCompressionState(join(tmpDir(), "absent.json"))).toEqual([]);
  });

  it("reads unparseable JSON as nothing compressed", () => {
    const dir = tmpDir();
    const path = compressionPathFor(dir);
    writeFileSync(path, "{ this is not json");
    expect(readCompressionState(path)).toEqual([]);
    expect(new FileCompressionStore(dir).blocks()).toEqual([]);
  });

  it("reads a FOREIGN schema version as nothing compressed", () => {
    const dir = tmpDir();
    const path = compressionPathFor(dir);
    writeFileSync(path, JSON.stringify({ version: 99, blocks: [block(1, 2)] }));
    expect(readCompressionState(path)).toEqual([]);
  });

  it("drops a block whose field is the wrong type, keeping its healthy siblings", () => {
    const dir = tmpDir();
    const path = compressionPathFor(dir);
    writeFileSync(
      path,
      JSON.stringify({
        version: COMPRESSION_SCHEMA_VERSION,
        blocks: [block(1, 2), { ...block(3, 4), to_turn: "four" }, { ...block(5, 6), summary: "   " }],
      }),
    );
    expect(readCompressionState(path).map((b) => [b.from_turn, b.to_turn])).toEqual([[1, 2]]);
  });

  it("refuses a top-level value that is not an object at all", () => {
    const dir = tmpDir();
    const path = compressionPathFor(dir);
    writeFileSync(path, JSON.stringify([block(1, 2)]));
    expect(readCompressionState(path)).toEqual([]);
  });
});

describe("W1900 · an unwritable sidecar degrades, it never throws", () => {
  it("warns instead of failing, and keeps the in-memory list usable", () => {
    const dir = tmpDir();
    const warnings: string[] = [];
    const store = new FileCompressionStore(dir, { warn: (m) => warnings.push(m) });
    // Make the sidecar's own path un-writable by parking a DIRECTORY there.
    mkdirSync(compressionPathFor(dir), { recursive: true });

    store.save([block(1, 2)]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("compression sidecar write failed");
    // The turn still sees its summary for as long as the process lives.
    expect(store.blocks().map((b) => [b.from_turn, b.to_turn])).toEqual([[1, 2]]);
  });
});

describe("W1900 · compressedLog: only deriveMessages changes", () => {
  it("overlays the view while events() stays complete", () => {
    const log = InMemorySessionLog.create();
    fill(log, 5, "cold");
    const eventsBefore = log.events();
    const store = new MemoryCompressionStore([block(2, 4, "turns 2-4 in one line")]);
    const compressed = compressedLog(log, store);

    const view = compressed.deriveMessages();
    expect(carries(view, "turns 2-4 in one line")).toBe(true);
    expect(view.some((m) => texts([m]).some((t) => t.startsWith("q2 cold")))).toBe(false);
    expect(carries(view, "q1 cold")).toBe(true);
    expect(carries(view, "q5 cold")).toBe(true);
    // The log is untouched: extraction, replay and the audit still read it all.
    expect(compressed.events()).toEqual(eventsBefore);
    expect(compressed.events()).toHaveLength(20);
  });

  it("reads the store on every projection, so a save is visible immediately", () => {
    const log = InMemorySessionLog.create();
    fill(log, 4);
    const store = new MemoryCompressionStore();
    const compressed = compressedLog(log, store);
    const before = texts(compressed.deriveMessages());

    store.save([block(1, 2, "folded")]);

    expect(texts(compressed.deriveMessages())).not.toEqual(before);
    expect(carries(compressed.deriveMessages(), "folded")).toBe(true);
  });

  it("drops the blocks on clear(), because the turns they stand for are gone", () => {
    const log = InMemorySessionLog.create();
    fill(log, 3);
    const store = new MemoryCompressionStore([block(1, 2)]);
    const compressed = compressedLog(log, store);

    compressed.clear();

    expect(compressed.events()).toEqual([]);
    expect(store.blocks()).toEqual([]);
    // A summary of turns that no longer exist must not linger in the view.
    expect(compressed.deriveMessages()).toEqual([]);
  });

  it("keeps every other member transparent (nextTurnId, append, events)", () => {
    const log = InMemorySessionLog.create();
    const store = new MemoryCompressionStore();
    const compressed = compressedLog(log, store);

    expect(compressed.nextTurnId()).toBe("turn-0");
    fill(compressed, 1, "x");
    expect(compressed.events()).toHaveLength(4);
  });

  it("reports no store for a plain log (an embedding that never mounted Phase 2)", () => {
    expect(compressionStoreOf(InMemorySessionLog.create())).toBeNull();
    expect(compressionStoreOf(null)).toBeNull();
    expect(compressionStoreOf(undefined)).toBeNull();
    expect(compressionVersionOf(InMemorySessionLog.create())).toBe(0);
  });

  it("exposes its store and a live version counter through the symbol key", () => {
    const log = InMemorySessionLog.create();
    const store = new MemoryCompressionStore();
    const compressed = compressedLog(log, store);

    expect(compressionStoreOf(compressed)).toBe(store);
    expect(compressionVersionOf(compressed)).toBe(0);
    store.save([block(1, 1)]);
    expect(compressionVersionOf(compressed)).toBe(1);
  });
});

describe("W1900 · the decorator stacks on top of a persistent log", () => {
  it("replays from disk and overlays the persisted blocks in one seam", () => {
    const dir = tmpDir();
    const first = PersistentSessionLog.open(dir, "cli");
    fill(first, 6, "history");
    const eventsBefore = first.events();

    new FileCompressionStore(dir).save([block(2, 4, "old work")]);
    const reopened = compressedLog(
      PersistentSessionLog.open(dir, "cli"),
      new FileCompressionStore(dir),
    );

    const view = reopened.deriveMessages();
    expect(carries(view, "old work")).toBe(true);
    expect(texts(view).some((t) => t.startsWith("q3 history"))).toBe(false);
    expect(reopened.events()).toEqual(eventsBefore);
  });
});
