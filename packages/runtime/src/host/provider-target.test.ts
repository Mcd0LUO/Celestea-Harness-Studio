/**
 * Startup context-window resolution — the fourth answer of the host's
 * provider-target seam (model / base_url / key / window).
 *
 * Precedence: env `CELESTEA_CONTEXT_WINDOW` > the owning model's declared
 * `context_window` > the profile's own fallback value. Rationale: a wrong-LOW
 * window only trims early (observable, safe); a wrong-HIGH one silently
 * overruns the real window mid-turn — so an undeclared model must never
 * inherit more than the conservative fallback.
 *
 * Exercised through `applyProviderTarget` (the composition the engine actually
 * runs at startup); `resolveContextWindow` covers the edge cases directly.
 */

import { describe, expect, it } from "vitest";
import {
  applyProviderTarget,
  resolveContextWindow,
  resolveProviderTarget,
  type ProviderLookup,
  type ProviderRef,
} from "./provider-target.js";

interface TestProfile {
  model: string;
  base_url: string;
  api_key_env: string;
  context_window: number;
}

const FALLBACK = 131_072;

function row(over: Partial<ProviderRef> = {}): ProviderRef {
  return {
    id: "gw",
    base_url: "http://gw.test/v1",
    request_format: "chat_completions",
    api_key: null,
    models: [{ id: "m1", context_window: 1_048_576 }],
    ...over,
  };
}

function lookup(rows: readonly ProviderRef[], defaultModel: string | null): ProviderLookup {
  return { rows: () => rows, defaultModel: () => defaultModel };
}

function baseProfile(over: Partial<TestProfile> = {}): TestProfile {
  return {
    model: "unknown",
    base_url: "http://profile.test/v1",
    api_key_env: "CELESTEA_API_KEY",
    context_window: FALLBACK,
    ...over,
  };
}

/** The engine's real startup composition: resolve, then apply. */
function startup(rows: readonly ProviderRef[], env: NodeJS.ProcessEnv, base = baseProfile()) {
  const look = lookup(rows, "m1");
  return applyProviderTarget(base, resolveProviderTarget(look, env, base), look, env);
}

describe("startup context window", () => {
  it("applies the owning model's declared context_window when the env does not override", () => {
    const { profile } = startup([row()], {});
    expect(profile.context_window).toBe(1_048_576);
  });

  it("lets a valid CELESTEA_CONTEXT_WINDOW win over the model's declared window", () => {
    const { profile } = startup([row()], { CELESTEA_CONTEXT_WINDOW: "200000" });
    expect(profile.context_window).toBe(200_000);
  });

  it("keeps the profile fallback when the model declares no window", () => {
    const { profile } = startup([row({ models: [{ id: "m1" }] })], {});
    expect(profile.context_window).toBe(FALLBACK);
  });

  it("keeps the profile fallback when no provider lists the model", () => {
    const look = lookup([], null);
    const base = baseProfile({ model: "self" });
    const { profile } = applyProviderTarget(base, resolveProviderTarget(look, {}, base), look, {});
    expect(profile.context_window).toBe(FALLBACK);
  });

  it("rejects a non-positive declared window (never widens on bad metadata)", () => {
    const { profile } = startup([row({ models: [{ id: "m1", context_window: 0 }] })], {});
    expect(profile.context_window).toBe(FALLBACK);
  });
});

describe("resolveContextWindow edges", () => {
  it("no owner at all keeps the base window", () => {
    expect(resolveContextWindow(null, "m1", {}, FALLBACK)).toBe(FALLBACK);
  });

  it("a blank env override does not count as configured", () => {
    expect(resolveContextWindow(row(), "m1", { CELESTEA_CONTEXT_WINDOW: "  " }, FALLBACK)).toBe(1_048_576);
  });

  it("an unparseable env override falls back without consulting metadata", () => {
    expect(resolveContextWindow(row(), "m1", { CELESTEA_CONTEXT_WINDOW: "huge" }, FALLBACK)).toBe(FALLBACK);
  });

  it("a fractional declaration is truncated, not rounded", () => {
    const owner = row({ models: [{ id: "m1", context_window: 131_072.9 }] });
    expect(resolveContextWindow(owner, "m1", {}, FALLBACK)).toBe(131_072);
  });
});
