/**
 * Phase 1 — the host-injected write callback of background memory extraction:
 * op -> append-only log mapping, text-hash dedup, id validation, provenance,
 * and the manifest the extraction prompt reads back.
 *
 * Uses the in-memory [MemoryStoreIo] seam (same as the B2 write-side tests).
 */
import { describe, expect, it } from "vitest";
import { applyMemoryExtractionOp, memoryManifest } from "./extraction.js";
import { foldMemoryLog, parseMemoryLog, serializeMemoryLine } from "./log.js";
import { memoryStoreOf, readMemoryState, type MemoryStoreIo } from "./store.js";

const WS = "C:\ws";
const HOME = { env: { CELESTEA_HOME: "/home" } };

/** An in-memory io seam: a Map of path -> text, append concatenates. */
function fakeIo(): MemoryStoreIo & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readText: (f) => files.get(f) ?? null,
    ensureDir: () => undefined,
    append: (f, t) => void files.set(f, (files.get(f) ?? "") + t),
    write: (f, t) => void files.set(f, t),
  };
}

function storeOf(io: MemoryStoreIo) {
  return memoryStoreOf(WS, HOME, io);
}

const SRC = { session: "s1", turn: "turn-3" };

describe("Phase 1 · applyMemoryExtractionOp", () => {
  it("add appends an entry with the next id, tags and provenance", () => {
    const io = fakeIo();
    const out = applyMemoryExtractionOp(storeOf(io), { op: "add", text: "user prefers dark mode", tags: ["ui"] }, SRC);
    expect(out).toEqual({ applied: true });
    const state = readMemoryState(storeOf(io));
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({ id: "m1", text: "user prefers dark mode", tags: ["ui"], source: SRC });
  });

  it("add dedups on the text hash (a re-scanned slice re-proposing the same fact)", () => {
    const io = fakeIo();
    const store = storeOf(io);
    expect(applyMemoryExtractionOp(store, { op: "add", text: "same fact", tags: [] }, SRC).applied).toBe(true);
    const dup = applyMemoryExtractionOp(store, { op: "add", text: "same fact", tags: [] }, SRC);
    expect(dup).toEqual({ applied: false, reason: "duplicate-text" });
    expect(readMemoryState(store).entries).toHaveLength(1);
  });

  it("add refuses oversize text, never truncates", () => {
    const io = fakeIo();
    const out = applyMemoryExtractionOp(storeOf(io), { op: "add", text: "x".repeat(3000), tags: [] }, SRC);
    expect(out).toEqual({ applied: false, reason: "entry-too-large" });
    expect(readMemoryState(storeOf(io)).entries).toHaveLength(0);
  });

  it("update appends a NEW id superseding the old, with provenance", () => {
    const io = fakeIo();
    const store = storeOf(io);
    applyMemoryExtractionOp(store, { op: "add", text: "runs on port 3777", tags: [] }, SRC);
    const out = applyMemoryExtractionOp(store, { op: "update", id: "m1", text: "runs on port 4444", tags: ["ops"] }, SRC);
    expect(out).toEqual({ applied: true });
    const state = readMemoryState(store);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({ id: "m2", text: "runs on port 4444", supersedes: "m1", source: SRC });
    expect(state.tombstoned.has("m1")).toBe(true);
  });

  it("update refuses an id that is not active", () => {
    const io = fakeIo();
    const out = applyMemoryExtractionOp(storeOf(io), { op: "update", id: "m9", text: "nope", tags: [] }, SRC);
    expect(out).toEqual({ applied: false, reason: "unknown-id" });
  });

  it("forget appends a tombstone; a second forget of the same id is refused", () => {
    const io = fakeIo();
    const store = storeOf(io);
    applyMemoryExtractionOp(store, { op: "add", text: "temp fact", tags: [] }, SRC);
    expect(applyMemoryExtractionOp(store, { op: "forget", id: "m1" }, SRC)).toEqual({ applied: true });
    expect(readMemoryState(store).entries).toHaveLength(0);
    expect(applyMemoryExtractionOp(store, { op: "forget", id: "m1" }, SRC)).toEqual({ applied: false, reason: "unknown-id" });
  });

  it("writes without provenance when the slice has no turn id", () => {
    const io = fakeIo();
    expect(applyMemoryExtractionOp(storeOf(io), { op: "add", text: "detached fact", tags: [] }, null).applied).toBe(true);
    expect(readMemoryState(storeOf(io)).entries[0]?.source).toBeUndefined();
  });

  it("a pre-existing id layout keeps ids monotonic (next id from ALL lines, incl. tombstoned)", () => {
    const io = fakeIo();
    const store = storeOf(io);
    applyMemoryExtractionOp(store, { op: "add", text: "fact one", tags: [] }, SRC);
    applyMemoryExtractionOp(store, { op: "forget", id: "m1" }, SRC);
    applyMemoryExtractionOp(store, { op: "add", text: "fact two", tags: [] }, SRC);
    expect(readMemoryState(store).entries[0]?.id).toBe("m2");
  });
});

describe("Phase 1 · memoryManifest", () => {
  it("renders one compact line per active entry with id and tags", () => {
    const io = fakeIo();
    const store = storeOf(io);
    applyMemoryExtractionOp(store, { op: "add", text: "user is 张三", tags: ["profile", "lang"] }, SRC);
    applyMemoryExtractionOp(store, { op: "add", text: "deploys\non Fridays", tags: [] }, SRC);
    const manifest = memoryManifest(store);
    expect(manifest).toContain("- m1 [profile, lang] user is 张三");
    expect(manifest).toContain("- m2 deploys on Fridays"); // whitespace flattened
    expect(manifest).not.toContain("forget");
  });

  it("omits tombstoned entries", () => {
    const io = fakeIo();
    const store = storeOf(io);
    applyMemoryExtractionOp(store, { op: "add", text: "gone soon", tags: [] }, SRC);
    applyMemoryExtractionOp(store, { op: "forget", id: "m1" }, SRC);
    expect(memoryManifest(store)).toBe("");
  });

  it("respects the byte budget with a truncation marker", () => {
    const io = fakeIo();
    const store = storeOf(io);
    for (let i = 0; i < 30; i += 1) {
      applyMemoryExtractionOp(store, { op: "add", text: `fact number ${i} with some padding text`, tags: [] }, SRC);
    }
    const manifest = memoryManifest(store, 200);
    expect(Buffer.byteLength(manifest, "utf8")).toBeLessThanOrEqual(220); // budget + marker slack
    // W1900: the marker COUNTS what it hid. A model that cannot see how much of
    // the manifest it is missing cannot tell "not remembered" from "not shown".
    const shown = manifest.split("\n").filter((line) => line.startsWith("- m")).length;
    const counted = /\((\d+) more entries not shown\)/.exec(manifest);
    expect(counted).not.toBeNull();
    expect(Number(counted?.[1])).toBe(30 - shown);
  });
});

describe("Phase 1 · op shape parity with the serialized log", () => {
  it("an extraction-written entry round-trips through serialize/parse with source intact", () => {
    const io = fakeIo();
    const store = storeOf(io);
    applyMemoryExtractionOp(store, { op: "add", text: "round trip", tags: ["t"] }, SRC);
    const raw = io.files.get([...io.files.keys()].find((k) => k.endsWith("entries.jsonl")) ?? "") ?? "";
    const lines = parseMemoryLog(raw);
    const folded = foldMemoryLog(lines);
    expect(folded.entries[0]).toMatchObject({ id: "m1", source: SRC });
    expect(serializeMemoryLine(folded.entries[0]!)).toContain('"source"');
  });
});
