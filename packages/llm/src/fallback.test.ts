/**
 * Iteration E §4.4 acceptance: D2 / D3 / D4 / D7 / D9 (+ `Retry-After`, §4.5 R4-4).
 *
 * Everything runs against the package's own mock upstream (`127.0.0.1`, dummy
 * key): no network, no credential, no production host is touched.
 *
 * D1 lives in `errors.test.ts` (P0); D5's SSE/statusline half and D6's ledger
 * half need the runtime host/runtime and live in
 * `apps/studio/src/runtime/fallback-host.test.ts` and
 * `apps/studio/src/runtime/fallback-ledger.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { OpenAiCompatClient } from "./client.js";
import { LlmError } from "./errors.js";
import { assistantText, collectStream, userMessage, type Llm, type LlmStream, type StreamEvent, type Usage } from "./seam.js";
import {
  createFallbackLlm,
  DEFAULT_FALLBACK_POLICY,
  FallbackState,
  type FallbackAttemptInfo,
  type LlmTarget,
} from "./fallback.js";
import { fallbackEnabled, loadFallbackConfig, targetAvailability } from "./fallback-config.js";
import {
  fastStreamFrames,
  sseFrame,
  startMockUpstream,
  type MockUpstream,
  type UpstreamBehaviour,
} from "./mock-upstream.test-util.js";

/** The two targets every HTTP-backed case uses (chains of clients, own ports). */
interface Pair {
  primary: MockUpstream;
  backup: MockUpstream;
  targets: LlmTarget[];
  clientFor: (t: LlmTarget) => OpenAiCompatClient;
  close(): Promise<void>;
}

async function pairOf(
  first: { behaviour: UpstreamBehaviour; status?: number; headers?: Record<string, string> },
  second: { behaviour: UpstreamBehaviour } = { behaviour: "frames" },
): Promise<Pair> {
  const primary = await startMockUpstream(first.behaviour, {
    ...(first.status === undefined ? {} : { status: first.status }),
    ...(first.headers === undefined ? {} : { headers: first.headers }),
    body: "upstream said no",
  });
  const backup = await startMockUpstream(second.behaviour, {
    frames: fastStreamFrames(["Hel", "lo"]),
    end: true,
  });
  const targets: LlmTarget[] = [
    { name: "primary", provider: "mock-a", model: "model-a", baseUrl: primary.baseUrl, apiKeyEnv: "MOCK_A_KEY" },
    { name: "backup", provider: "mock-b", model: "model-b", baseUrl: backup.baseUrl, apiKeyEnv: "MOCK_B_KEY" },
  ];
  return {
    primary,
    backup,
    targets,
    clientFor: (t) =>
      new OpenAiCompatClient({
        baseUrl: t.baseUrl ?? "",
        apiKey: "test-key",
        model: t.model,
        connectTimeoutMs: 1000,
        responseTimeoutMs: 1000,
        streamIdleTimeoutMs: 1000,
      }),
    close: async () => {
      await primary.close();
      await backup.close();
    },
  };
}

const REQ = { messages: [userMessage("hi")] };

/**
 * W2039: the guard for a stage whose FIRING is not what the case tests.
 *
 * A guard in the same magnitude as scheduler jitter turns a case into a
 * load-dependent coin flip. This file already had that lesson once (the
 * stream-idle guard, W887e, quoted in [timeout.test.ts]'s "a healthy fast stream
 * is not killed" case); W2039 is the response-header guard hitting the same wall:
 *
 *   the response-header case passed `responseTimeoutMs: 60` to a `clientFor`
 *   serving BOTH targets. The silent primary MUST trip its 60ms guard - that is
 *   the tested behaviour - but the healthy backup then armed its OWN 60ms guard
 *   around connect + request write + server scheduling. Measured under 24 pinned
 *   spinners (load ~43 on 28 cores) the backup's own guard expired before its
 *   (already arrived) response was read, and because `attemptLoop` rethrows the
 *   LAST attempt's error, that backup error escaped `generate()` instead of the
 *   expected hand-over. Forced proof: stalling the event loop 120ms right after
 *   the backup request was flushed reproduces it with the BACKUP's port in the
 *   message (the port is the evidence - the primary's port never appears).
 *
 * The fix is NOT "a bigger 60ms": every guard that the case actually TESTS keeps
 * its exact value, and only the incidental guard - the one that must simply not
 * fire - is decoupled from the jitter magnitude. Two orders of magnitude is the
 * same margin `timeout.test.ts` uses for the healthy stream.
 */
const DECOUPLED_GUARD_MS = 5_000;

/** D2: a retryable status hands the call to the next target, visibly. */
describe("D2 — 503 on target #1, healthy target #2", () => {
  it("produces `done`, calls each target once and reports reason http_503", async () => {
    const p = await pairOf({ behaviour: "http-error", status: 503 });
    const attempts: FallbackAttemptInfo[] = [];
    const steps: Array<{ attempt: number; kind: string; status: number | null }> = [];
    const llm = createFallbackLlm({
      targets: p.targets,
      clientFor: p.clientFor,
      onAttempt: (info) => attempts.push(info),
      steps: {
        beginStep: (info) => ({
          record: () => {},
          close: (outcome) =>
            steps.push({ attempt: info.attempt, kind: outcome.kind, status: outcome.http_status ?? null }),
        }),
      },
    });

    const events = await collectStream(await llm.generate(REQ));
    const text = events.filter((e) => e.kind === "text").map((e) => (e as { text: string }).text);

    expect(events.at(-1)?.kind).toBe("done");
    expect(text.join("")).toBe("Hello");
    expect([p.primary.requests.length, p.backup.requests.length]).toEqual([1, 1]);
    expect(attempts).toHaveLength(1);
    // The hook fires for the SWITCH (primary -> backup), not for the failure.
    expect(attempts[0]).toMatchObject({ attempt: 1, target: "backup", from: "primary", reason: "http_503", httpStatus: 503 });
    expect(steps).toEqual([
      { attempt: 0, kind: "error", status: 503 },
      { attempt: 1, kind: "ok", status: null },
    ]);
    expect(llm.effective()).toEqual({ name: "backup", model: "model-b" });
    expect(llm.chain()).toEqual(["primary", "backup"]);
    await p.close();
  });
});

/** D3: a configuration/credential status is terminal — one attempt, no hand-over. */
describe("D3 — 401 / 403 / 400 try exactly one target", () => {
  for (const status of [401, 403, 400]) {
    it(`stops after the first attempt on ${status}`, async () => {
      const p = await pairOf({ behaviour: "http-error", status });
      const attempts: FallbackAttemptInfo[] = [];
      const llm = createFallbackLlm({ targets: p.targets, clientFor: p.clientFor, onAttempt: (i) => attempts.push(i) });

      await expect(collectStream(await llm.generate(REQ))).rejects.toBeInstanceOf(LlmError);
      expect(p.primary.requests.length).toBe(1);
      expect(p.backup.requests.length).toBe(0);
      // A non-retryable status never switches, so no hand-over is announced.
      expect(attempts).toEqual([]);
      await p.close();
    });
  }
});

/** D4: output already reached the consumer — never redone (§4.5 R4-2). */
describe("D4 — three text frames, then a torn stream", () => {
  it("does not call target #2 and ends as a stream failure", async () => {
    // Three deltas and NO `[DONE]`: the stream ends torn (no terminal frame).
    const torn = ["a", "b", "c"].map((piece) => sseFrame({ choices: [{ index: 0, delta: { content: piece } }] }));
    const primary = await startMockUpstream("frames", { frames: torn, end: true });
    const backup = await startMockUpstream("frames", { frames: fastStreamFrames(["X"]), end: true });
    const targets: LlmTarget[] = [
      { name: "primary", provider: "mock-a", model: "model-a", baseUrl: primary.baseUrl },
      { name: "backup", provider: "mock-b", model: "model-b", baseUrl: backup.baseUrl },
    ];
    const attempts: FallbackAttemptInfo[] = [];
    const llm = createFallbackLlm({
      targets,
      // W2039 (preventive, same class as the response-header case below): this
      // case asserts the PRODUCED LOCK - a torn stream must end as
      // `interrupted`, never as a hand-over. Its idle guard must therefore not
      // fire at all, yet 60ms also covered the wait for the first body chunk, so
      // a >60ms scheduling gap turned the expected `interrupted` into `failed`
      // (proved live: injecting a 120ms inter-chunk gap flips the terminal).
      // Not observed failing under load - hardened because it is the identical
      // anti-pattern. The idle guard itself is covered by timeout.test.ts §2.
      clientFor: (t) =>
        new OpenAiCompatClient({ baseUrl: t.baseUrl ?? "", apiKey: "k", model: t.model, streamIdleTimeoutMs: DECOUPLED_GUARD_MS }),
      onAttempt: (i) => attempts.push(i),
    });

    const events = await collectStream(await llm.generate(REQ));
    const texts = events.filter((e) => e.kind === "text").map((e) => (e as { text: string }).text);

    expect(texts.join("")).toBe("abc");
    // Torn stream = the terminal is `interrupted` (the client's own verdict for
    // a response that ends without `[DONE]`); what matters is that it is NOT a
    // hand-over: nothing is redone once text has been produced.
    expect(events.at(-1)?.kind).toBe("interrupted");
    expect(events.some((e) => e.kind === "done")).toBe(false);
    expect(backup.requests.length).toBe(0);
    // produced > 0 = terminal: nothing is announced, because nothing switches.
    expect(attempts).toEqual([]);
    await primary.close();
    await backup.close();
  });
});

/** D7: three consecutive failures bench a target for `cooldownMs` (fake clock). */
describe("D7 — target-level cooldown", () => {
  it("prefers target #2 inside the cooldown window and restores target #1 after it", async () => {
    const p = await pairOf({ behaviour: "http-error", status: 503 });
    let now = 1_000_000;
    const state = new FallbackState();
    const llm = createFallbackLlm({
      targets: p.targets,
      clientFor: p.clientFor,
      state,
      now: () => now,
      policy: { failureThreshold: 3, cooldownMs: 60_000 },
    });

    for (let i = 0; i < 3; i++) await collectStream(await llm.generate(REQ));
    expect(state.isCooling("primary", now)).toBe(true);
    expect(llm.chain()).toEqual(["backup", "primary"]);

    now += 60_000;
    expect(state.isCooling("primary", now)).toBe(false);
    expect(llm.chain()).toEqual(["primary", "backup"]);
    await p.close();
  });
});

/** `Retry-After` is honoured up to `cooldownMs`, and ignored beyond it (§4.5 R4-4). */
describe("Retry-After (429)", () => {
  it("waits the header's delay when it fits inside cooldownMs", async () => {
    const p = await pairOf({ behaviour: "http-error", status: 429, headers: { "retry-after": "2" } });
    const waits: number[] = [];
    const llm = createFallbackLlm({
      targets: p.targets,
      clientFor: p.clientFor,
      sleep: async (ms) => void waits.push(ms),
    });

    expect((await collectStream(await llm.generate(REQ))).at(-1)?.kind).toBe("done");
    expect(waits).toEqual([2000]);
    expect(p.backup.requests.length).toBe(1);
    await p.close();
  });

  it("moves on without waiting when the delay exceeds cooldownMs", async () => {
    const p = await pairOf({ behaviour: "http-error", status: 429, headers: { "retry-after": "600" } });
    const waits: number[] = [];
    const llm = createFallbackLlm({
      targets: p.targets,
      clientFor: p.clientFor,
      sleep: async (ms) => void waits.push(ms),
      policy: { cooldownMs: 60_000 },
    });

    expect((await collectStream(await llm.generate(REQ))).at(-1)?.kind).toBe("done");
    expect(waits).toEqual([]);
    await p.close();
  });
});

/** A response-header timeout is a hand-over with its own reason. */
describe("timeout trigger (§4.2.2)", () => {
  it("hands over after a response-header timeout, with reason timeout_response", async () => {
    const primary = await startMockUpstream("silent");
    const backup = await startMockUpstream("frames", { frames: fastStreamFrames(["ok"]), end: true });
    const attempts: FallbackAttemptInfo[] = [];
    const llm = createFallbackLlm({
      targets: [
        { name: "primary", provider: "a", model: "m-a", baseUrl: primary.baseUrl },
        { name: "backup", provider: "b", model: "m-b", baseUrl: backup.baseUrl },
      ],
      clientFor: (t) =>
        new OpenAiCompatClient({
          baseUrl: t.baseUrl ?? "",
          apiKey: "k",
          model: t.model,
          // W2039: 60ms is the TESTED behaviour and stays on the silent primary,
          // whose guard MUST trip. The backup is the healthy target the case
          // hands over TO; racing it against the same 60ms only measures
          // scheduler jitter (see DECOUPLED_GUARD_MS).
          responseTimeoutMs: t.name === "primary" ? 60 : DECOUPLED_GUARD_MS,
        }),
      onAttempt: (i) => attempts.push(i),
    });

    expect((await collectStream(await llm.generate(REQ))).at(-1)?.kind).toBe("done");
    expect(attempts.map((a) => [a.from, a.target, a.reason])).toEqual([["primary", "backup", "timeout_response"]]);
    expect(backup.requests.length).toBe(1);
    await primary.close();
    await backup.close();
  });
});

/** D9: the switch is OFF by default, and "off" means "nothing is loaded". */
describe("D9 — the switch defaults to off", () => {
  it("is disabled unless CELESTEA_LLM_FALLBACK is on/1/true/yes", () => {
    expect(fallbackEnabled({})).toBe(false);
    expect(fallbackEnabled({ CELESTEA_LLM_FALLBACK: "off" })).toBe(false);
    expect(fallbackEnabled({ CELESTEA_LLM_FALLBACK: "maybe" })).toBe(false);
    expect(fallbackEnabled({ CELESTEA_LLM_FALLBACK: "on" })).toBe(true);
    // A configured chain is NOT loaded while the switch is off (no side effects).
    expect(loadFallbackConfig({ env: { CELESTEA_LLM_FALLBACKS: '{"targets":[{"name":"a","model":"m"}]}' } })).toBeNull();
  });

  it("reports a target whose credential env is unset instead of dropping it (U7)", () => {
    const config = loadFallbackConfig({
      env: {
        CELESTEA_LLM_FALLBACK: "on",
        CELESTEA_LLM_FALLBACKS: '{"targets":[{"name":"a","model":"m-a"},{"name":"b","model":"m-b","apiKeyEnv":"MISSING_KEY"}]}',
      },
    });
    expect(config?.targets).toHaveLength(2);
    const availability = targetAvailability(config?.targets ?? [], {});
    expect(availability).toEqual([
      { name: "a", model: "m-a", available: true, missingEnv: null },
      { name: "b", model: "m-b", available: false, missingEnv: "MISSING_KEY" },
    ]);
  });

  it("keeps the documented defaults byte-for-byte (§4.2.1)", () => {
    expect(DEFAULT_FALLBACK_POLICY).toEqual({
      maxAttempts: 2,
      cooldownMs: 60_000,
      failureThreshold: 3,
      notRetryableStatuses: [400, 401, 403, 404, 422],
      retryableStatuses: [408, 425, 429, 500, 502, 503, 504],
      respectRetryAfter: true,
    });
  });
});

/** A one-off stream helper used by the "no target" assertion below. */
function scripted(events: StreamEvent[]): { generate: () => Promise<AsyncIterable<StreamEvent>> } {
  return {
    generate: async () => ({
      async *[Symbol.asyncIterator]() {
        for (const e of events) yield e;
      },
    }),
  };
}

describe("chain exhaustion", () => {
  /**
   * B2-03: exhaustion is a TERMINAL EVENT, not a throw.
   *
   * It used to `throw lastError` out of the async generator, which bypassed the
   * stream-event contract (no terminal frame, no usage frame) and dropped the
   * `httpStatus` / `retryable` the decorators had already computed.
   */
  it("ends with a failed terminal event carrying the last error's classification", async () => {
    const failing = new LlmError("stream request failed: 503", "generate", { httpStatus: 503, retryable: true });
    const llm = createFallbackLlm({
      targets: [
        { name: "a", provider: "a", model: "m-a" },
        { name: "b", provider: "b", model: "m-b" },
      ],
      clientFor: () => ({
        generate: () => Promise.reject(failing),
      }),
    });
    const events = await collectStream(await llm.generate(REQ));
    const last = events[events.length - 1];
    // A pre-stream failure is "generate", NOT "stream" (B2-02 and B2-03 together).
    expect(last).toEqual({ kind: "failed", kindOf: "generate", message: "stream request failed: 503" });
  });

  it("does not reject generate() when the chain is exhausted", async () => {
    const failing = new LlmError("stream request failed: 503", "generate", { httpStatus: 503, retryable: true });
    const llm = createFallbackLlm({
      targets: [{ name: "a", provider: "a", model: "m-a" }],
      clientFor: () => ({ generate: () => Promise.reject(failing) }),
    });
    await expect(collectStream(await llm.generate(REQ))).resolves.toBeDefined();
  });

  it("keeps a genuinely mid-stream failure as kindOf stream", async () => {
    // The mirror image: an LlmError that IS a stream failure must not be
    // laundered into "generate" by the exhaustion path.
    const tearing = new LlmError("sse decode error: upstream hung up", "stream", { retryable: true });
    const llm = createFallbackLlm({
      targets: [
        { name: "a", provider: "a", model: "m-a" },
        { name: "b", provider: "b", model: "m-b" },
      ],
      clientFor: () => ({
        generate: async () => ({
          async *[Symbol.asyncIterator]() {
            throw tearing;
          },
        }),
      }),
    });
    const events = await collectStream(await llm.generate(REQ));
    const last = events[events.length - 1];
    expect(last).toEqual({ kind: "failed", kindOf: "stream", message: "sse decode error: upstream hung up" });
  });

  it("requires at least one target", () => {
    expect(() => createFallbackLlm({ targets: [], clientFor: () => scripted([]) })).toThrow(/at least one target/);
  });
});

// W835 (R3 batch C / W811 P1-2): the last target must not sleep Retry-After.
// Source: W826-R3修复计划 §批次 C P1-2 probe (真实 fallback 入口 + sleep spy).
describe("W835 P1-2 — no Retry-After sleep once the chain is exhausted", () => {
  // B2-03: the shape of the terminal changed (a `failed` event, not a throw); the
  // property this case guards — NO sleep once nothing is left to try — is unchanged.
  it("does not sleep and reports a terminal failure for a single failed target", async () => {
    const only = await startMockUpstream("http-error", {
      status: 429,
      headers: { "retry-after": "2" },
      body: "slow down",
    });
    const waits: number[] = [];
    const llm = createFallbackLlm({
      targets: [{ name: "only", provider: "p", model: "m", baseUrl: only.baseUrl }],
      clientFor: (t) =>
        new OpenAiCompatClient({
          baseUrl: t.baseUrl ?? "",
          apiKey: "k",
          model: t.model,
          connectTimeoutMs: 1000,
          responseTimeoutMs: 1000,
        }),
      sleep: async (ms) => void waits.push(ms),
    });

    const events = await collectStream(await llm.generate(REQ));
    expect(events[events.length - 1]).toMatchObject({ kind: "failed" });
    expect(waits).toEqual([]);
    await only.close();
  });
});

// W835 (R3 batch C / W811 P1-3): abandoning the consumer must still close the
// step. Source: W826-R3修复计划 §批次 C P1-3 probe (真实 fallback + step sink).
describe("W835 P1-3 — abandoning a step still closes it with its usage", () => {
  it("records the usage then closes the step as ok when the consumer breaks", async () => {
    const usage: Usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, cache_read: 0, reasoning_tokens: 0 };
    const recorded: Usage[] = [];
    const closed: string[] = [];
    const inner: Llm = {
      generate: async (): Promise<LlmStream> => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
          yield { kind: "usage", usage };
          yield { kind: "done", message: assistantText("never read") };
        },
      }),
    };
    const llm = createFallbackLlm({
      targets: [{ name: "only", provider: "p", model: "m" }],
      clientFor: () => inner,
      steps: {
        beginStep: () => ({
          record: (u) => recorded.push(u),
          close: (outcome) => closed.push(outcome.kind),
        }),
      },
    });

    for await (const event of await llm.generate(REQ)) {
      if (event.kind === "usage") break;
    }

    expect(recorded).toEqual([usage]);
    expect(closed).toEqual(["ok"]);
  });
});
