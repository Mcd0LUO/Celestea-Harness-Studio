/**
 * Usage-ledger extraction rows (docs/feature-memory-extraction.md Phase 1).
 *
 * The assertions of the extraction kind: the row's own shape (price snapshot,
 * cost, entries, status), the honest-cost rule (extraction spend counts in the
 * session totals and cost block but NEVER in a turn_total row or a step
 * count), and the step-folded query view staying step-only.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { zeroUsage, type Llm, type LlmStream, type SessionLog, type StreamEvent, type Usage } from "@celestea/core";
import { createLedgerLlm } from "./ledger-llm.js";
import { ledgerCostBlock, queryLedger } from "./ledger-query.js";
import {
  USAGE_LEDGER_FILE,
  UsageLedgerFile,
  createUsageLedger,
  type UsageExtractionRecord,
  type UsageLedger,
} from "./ledger.js";
import { loadPricingFile } from "./pricing.js";
import { memoryLog } from "./fakes.test-util.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function tmpDir(): string {
  const root = mkdtempSync(join(tmpdir(), "ledger-extraction-"));
  roots.push(root);
  return root;
}

function usage(prompt: number, completion: number): Usage {
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    cache_read: 0,
    reasoning_tokens: 0,
  };
}

function writePricing(dir: string): void {
  writeFileSync(
    join(dir, "pricing.json"),
    JSON.stringify({
      version: "2026-09-11",
      currency: "CNY",
      unit: "per_mtok",
      models: { "deepseek-chat": { in: 1.0, out: 2.0, cache_read: 0.1 } },
    }),
  );
}

function streamOf(events: readonly StreamEvent[]): LlmStream {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<StreamEvent> => {
      let i = 0;
      return {
        next: async (): Promise<IteratorResult<StreamEvent>> =>
          i < events.length ? { done: false, value: events[i++] as StreamEvent } : { done: true, value: undefined },
      };
    },
  };
}

function okStep(prompt: number, completion: number): StreamEvent[] {
  return [
    { kind: "usage", usage: usage(prompt, completion) },
    { kind: "done", message: { role: "assistant", content: [{ type: "text", content: "ok" }], tool_call_id: null } },
  ];
}

interface Rig {
  file: UsageLedgerFile;
  ledger: UsageLedger;
  log: SessionLog;
  llm: Llm;
  extractionRows(): UsageExtractionRecord[];
}

/** One session with turn-0 open and three scripted steps (100/10, 200/20, 300/30). */
async function rig(dir: string): Promise<Rig> {
  const file = new UsageLedgerFile({
    path: join(dir, USAGE_LEDGER_FILE),
    pricing: loadPricingFile(join(dir, "pricing.json")),
    now: (): number => 1_760_000_000_000,
  });
  const ledger = createUsageLedger({ session: "ws/s1", file });
  const log = memoryLog();
  log.append({ type: "turn_start", id: log.nextTurnId() });
  log.append({ type: "user_message", text: "hello" });
  ledger.beginTurn(log);
  const answers = [okStep(100, 10), okStep(200, 20), okStep(300, 30)];
  let calls = 0;
  const llm = createLedgerLlm({
    inner: {
      generate(): Promise<LlmStream> {
        const answer = answers[Math.min(calls++, answers.length - 1)] ?? [];
        return Promise.resolve(streamOf(answer));
      },
    },
    sink: ledger,
    provider: "mock",
    model: "deepseek-chat",
    base_url_host: "api.deepseek.com",
  });
  for (let i = 0; i < 3; i++) {
    const stream = await llm.generate({ model: "deepseek-chat", system: "s", messages: [], tools: [], max_tokens: null, temperature: null });
    for await (const event of stream) void event;
  }
  log.append({ type: "turn_end", id: "turn-0", outcome: "completed" });
  ledger.endTurn("completed");
  return {
    file,
    ledger,
    log,
    llm,
    extractionRows: (): UsageExtractionRecord[] =>
      file.read().filter((r): r is UsageExtractionRecord => r.kind === "extraction"),
  };
}

function bookExtraction(r: Rig, over: Partial<Parameters<UsageLedger["bookExtraction"]>[0]> = {}): void {
  r.ledger.bookExtraction({
    turn_id: "turn-0",
    usage: usage(500, 50),
    entries: 2,
    status: "ok",
    provider: "mock",
    model: "deepseek-chat",
    base_url_host: "api.deepseek.com",
    ...over,
  });
}

describe("extraction rows", () => {
  it("books one extraction row with the frozen price snapshot and a computed cost", async () => {
    const dir = tmpDir();
    writePricing(dir);
    const r = await rig(dir);
    bookExtraction(r);

    const rows = r.extractionRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error("no extraction row");
    expect(row.session).toBe("ws/s1");
    expect(row.turn_id).toBe("turn-0");
    expect(row.entries).toBe(2);
    expect(row.status).toBe("ok");
    expect(row.usage.prompt_tokens).toBe(500);
    expect(row.price?.version).toBe("2026-09-11");
    expect(row.priced_by).toBe("table");
    // 500 in @ 1.0/M + 50 out @ 2.0/M = 0.0006 CNY.
    expect(row.cost?.total).toBeCloseTo(0.0006, 9);
    // The turn_total row of the same turn is untouched (steps only).
    const total = r.file.read().find((x) => x.kind === "turn_total");
    if (total?.kind !== "turn_total") throw new Error("no turn_total row");
    expect(total.usage.prompt_tokens).toBe(600);
  });

  it("counts extraction in total() but never in latest() or the step rows", async () => {
    const dir = tmpDir();
    writePricing(dir);
    const r = await rig(dir);
    bookExtraction(r);

    // Honest cost: 600 step tokens + 550 extraction tokens.
    expect(r.ledger.total().prompt_tokens).toBe(1100);
    expect(r.ledger.totals().tokens.completion_tokens).toBe(110);
    // latest() is a STEP view: the extraction row must not become "the latest step".
    expect(r.ledger.latest().prompt_tokens).toBe(300);
  });

  it("an unpriced extraction is UNKNOWN, never silently free", async () => {
    const dir = tmpDir(); // no pricing.json
    const r = await rig(dir);
    bookExtraction(r);

    const row = r.extractionRows()[0];
    if (row === undefined) throw new Error("no extraction row");
    expect(row.priced_by).toBe("unpriced");
    expect(row.cost).toBeNull();
    expect(r.ledger.totals().unpriced_models).toContain("deepseek-chat");
  });

  it("books error and no-op rows with their status and zero entries", async () => {
    const dir = tmpDir();
    writePricing(dir);
    const r = await rig(dir);
    bookExtraction(r, { usage: zeroUsage(), entries: 0, status: "error" });
    bookExtraction(r, { entries: 0, status: "no-op" });

    const rows = r.extractionRows();
    expect(rows.map((x) => x.status)).toEqual(["error", "no-op"]);
    expect(rows.every((x) => x.entries === 0)).toBe(true);
  });

  it("a FAILED extraction that measured nothing is UNKNOWN, not free (W9261)", async () => {
    // `extractSlice` books `zeroUsage()` when the call dies before any usage
    // frame. Booking that 0 as a fact would make a priced session report a
    // COMPLETE cost that silently omits every failed extraction — the same
    // "zero is not a measurement" rule the step rows already follow.
    const dir = tmpDir();
    writePricing(dir);
    const r = await rig(dir);
    bookExtraction(r, { usage: zeroUsage(), entries: 0, status: "error" });

    const totals = r.ledger.totals();
    expect(totals.billed_unknown_records).toBe(1);
    expect(totals.cost_complete).toBe(false);
  });

  it("an extraction error that DID observe usage stays priced (not flagged unknown)", async () => {
    const dir = tmpDir();
    writePricing(dir);
    const r = await rig(dir);
    bookExtraction(r, { usage: usage(50, 5), entries: 0, status: "error" });

    const totals = r.ledger.totals();
    expect(totals.billed_unknown_records).toBe(0);
  });

  it("queryLedger folds step rows only — extraction spend stays out of the view", async () => {
    const dir = tmpDir();
    writePricing(dir);
    const r = await rig(dir);
    bookExtraction(r);

    const result = queryLedger(r.file.readAll(), { group_by: "session" });
    expect(result.totals.tokens.prompt_tokens).toBe(600);
    expect(result.totals.records).toBe(3);
  });

  it("ledgerCostBlock counts extraction in session_total but not in attempts", async () => {
    const dir = tmpDir();
    writePricing(dir);
    const r = await rig(dir);
    bookExtraction(r);

    const block = ledgerCostBlock(r.file.readAll(), "ws/s1");
    // Steps: (100+200+300) @ 1.0/M in + (10+20+30) @ 2.0/M out = 0.00072;
    // extraction adds 0.0006.
    expect(block.session_total).toBeCloseTo(0.00132, 9);
    expect(block.attempts).toBe(3);
    expect(block.records).toBe(3);
    expect(block.cost_complete).toBe(true);
  });

  it("survives a restart: a reopened file still counts the extraction row", async () => {
    const dir = tmpDir();
    writePricing(dir);
    const r = await rig(dir);
    bookExtraction(r);

    const reopened = new UsageLedgerFile({
      path: join(dir, USAGE_LEDGER_FILE),
      pricing: loadPricingFile(join(dir, "pricing.json")),
    });
    const ledger2 = createUsageLedger({ session: "ws/s1", file: reopened });
    expect(ledger2.total().prompt_tokens).toBe(1100);
    expect(existsSync(join(dir, USAGE_LEDGER_FILE))).toBe(true);
    void readFileSync;
  });
});
