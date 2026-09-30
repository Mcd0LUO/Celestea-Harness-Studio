/**
 * W2066 — the wire-protocol seam. What these pin, and why each one matters:
 *
 *   1. An UNREGISTERED protocol is refused by name, before any socket. The
 *      pre-W2066 build stored, displayed and ignored request_format, so a row
 *      declaring `anthropic_messages` was spoken to as OpenAI's dialect — the
 *      silent wrong-wire failure this whole change exists to remove.
 *   2. Refusal is not retryable: a format no adapter serves will not start
 *      serving itself, so the fallback chain must not burn attempts on it.
 *   3. The registry is last-wins with a disposer, like every other registry
 *      here — a plugin must be able to withdraw its adapter without a restart.
 *   4. A registration is a FORMAT, not a switch: two adapters for the same
 *      format means the second replaces the first, and the refusal text lists
 *      only what this build can actually speak.
 */

import { describe, expect, it } from "vitest";

import {
  AdapterRegistry,
  CHAT_COMPLETIONS_FORMAT,
  noAdapterAdvice,
  NO_ADAPTER,
  unknownRouteDescription,
  type RouteAdapter,
} from "./adapter.js";
import { chatCompletionsAdapter, createLiveLlm, defaultAdapterRegistry, requestFormatOf } from "./factory.js";
import { LlmError } from "./errors.js";
import type { ResolvedClientConfig } from "./profile.js";

const CONFIG: ResolvedClientConfig = {
  baseUrl: "http://gw.test/v1",
  apiKey: "k",
  model: "m1",
  reasoningEffort: null,
  maxOutputTokens: null,
  connectTimeoutMs: 0,
  responseTimeoutMs: 0,
  streamIdleTimeoutMs: 0,
};

/** A stand-in adapter: records that it was asked, serves no protocol. */
function stub(name: string, requestFormat: string): RouteAdapter & { built: number } {
  const adapter = {
    name,
    requestFormat,
    built: 0,
    createClient: () => {
      adapter.built += 1;
      return chatCompletionsAdapter.createClient(CONFIG);
    },
  };
  return adapter;
}

describe("requestFormatOf", () => {
  it("absent/blank means the documented default, never a guess at 'unknown'", () => {
    expect(requestFormatOf(null)).toBe(CHAT_COMPLETIONS_FORMAT);
    expect(requestFormatOf({})).toBe(CHAT_COMPLETIONS_FORMAT);
    expect(requestFormatOf({ request_format: "  " })).toBe(CHAT_COMPLETIONS_FORMAT);
  });

  it("passes a declared protocol through verbatim (free string, never folded)", () => {
    expect(requestFormatOf({ request_format: "anthropic_messages" })).toBe("anthropic_messages");
  });
});

describe("AdapterRegistry", () => {
  it("refuses an unregistered protocol by name, and is not retryable", () => {
    const registry = new AdapterRegistry();
    expect(() => registry.resolve("anthropic_messages", "providers.json row 'minimax'")).toThrow(LlmError);
    try {
      registry.resolve("anthropic_messages", "row 'minimax'");
      expect.unreachable("must refuse");
    } catch (err) {
      const e = err as LlmError;
      expect(e.retryable).toBe(false);
      // The message must name the FORMAT and the thing that declared it: those
      // are the two facts an operator can act on.
      expect(e.message).toContain("anthropic_messages");
      expect(e.message).toContain("row 'minimax'");
    }
  });

  it("NO_ADAPTER is the stable machine code callers branch on", () => {
    // The code is a constant, not a substring: nothing may parse the message.
    expect(NO_ADAPTER).toBe("NO_ADAPTER");
    expect(typeof chatCompletionsAdapter.requestFormat).toBe("string");
  });

  it("registers, resolves, and a disposer withdraws only its own entry", () => {
    const registry = new AdapterRegistry();
    const release = registry.register(chatCompletionsAdapter);
    expect(registry.formats()).toEqual([CHAT_COMPLETIONS_FORMAT]);
    expect(registry.resolve(CHAT_COMPLETIONS_FORMAT, "row").name).toBe(chatCompletionsAdapter.name);
    release();
    expect(registry.formats()).toEqual([]);
    expect(() => registry.resolve(CHAT_COMPLETIONS_FORMAT, "row")).toThrow(LlmError);
  });

  it("last-wins per format, and a SUPERSEDED disposer cannot withdraw the winner", () => {
    const registry = new AdapterRegistry();
    const releaseFirst = registry.register(stub("first", CHAT_COMPLETIONS_FORMAT));
    registry.register(stub("second", CHAT_COMPLETIONS_FORMAT));
    expect(registry.resolve(CHAT_COMPLETIONS_FORMAT, "row").name).toBe("second");
    // first's route was taken over by second; withdrawing first must be a no-op,
    // or a plugin disposing its old adapter would silently break the live one.
    releaseFirst();
    expect(registry.resolve(CHAT_COMPLETIONS_FORMAT, "row").name).toBe("second");
  });

  it("describe() answers through the adapter, and the empty default claims nothing", () => {
    const registry = new AdapterRegistry();
    registry.register(chatCompletionsAdapter);
    expect(registry.describe(CHAT_COMPLETIONS_FORMAT, CONFIG, "row")).toEqual({
      requestFormat: CHAT_COMPLETIONS_FORMAT,
      reasoningEfforts: [],
      contextWindow: null,
      acceptsImages: true,
    });
    const bare = stub("bare", "some-protocol");
    expect(bare.describe).toBeUndefined();
    registry.register(bare);
    expect(registry.describe("some-protocol", CONFIG, "row")).toEqual(
      unknownRouteDescription("some-protocol"),
    );
  });
});

describe("createLiveLlm routes through the registry", () => {
  it("the built-in registry serves chat_completions with the unchanged client", () => {
    const client = createLiveLlm({ model: "m1", base_url: "http://gw.test/v1" }, { API_KEY: "k" }, defaultAdapterRegistry());
    expect(client.endpoint()).toBe("http://gw.test/v1/chat/completions");
  });

  it("a row's undeclared-but-unserved protocol is REFUSED, not spoken as OpenAI", () => {
    // The regression line: before W2066 this call succeeded and posted an
    // anthropic-shaped conversation to whatever base_url the row carried.
    expect(() =>
      createLiveLlm(
        { model: "claude-x", base_url: "https://api.anthropic.com/v1", request_format: "anthropic_messages" },
        { ANTHROPIC_API_KEY: "k" },
        defaultAdapterRegistry(),
      ),
    ).toThrow(/anthropic_messages/);
  });
});

describe("noAdapterAdvice", () => {
  it("phrases the refusal as the repair, and says nothing is sent", () => {
    const text = noAdapterAdvice("anthropic_messages", "minimax", [CHAT_COMPLETIONS_FORMAT]);
    expect(text).toContain("minimax");
    expect(text).toContain("anthropic_messages");
    expect(text).toContain("chat_completions");
    expect(text).toContain("Nothing is sent");
  });
});
