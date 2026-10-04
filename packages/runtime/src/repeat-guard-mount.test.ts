/**
 * W9331 — the degenerate-repetition guard as a PLUGIN (upstream
 * `dsh-guard-repeat-output` 2.1.6, MIT).
 *
 * Three things are pinned here, and they are the three that make "the guard is
 * always mounted" a fact rather than a hope:
 *
 *   1. the DEFAULT is ON — a generation that says nothing about the guard gets one;
 *   2. the switch really switches: `CELESTEA_REPEAT_GUARD=off` and an explicit
 *      `false` at the compose face both leave NO service behind, which is what
 *      makes "off" observable instead of merely quiet (same contract the watchdog
 *      mount follows);
 *   3. a hostile override cannot disable the guard BY ACCIDENT — the thresholds are
 *      validated field by field, so `lowInfoDupShare: 0` (convict everything) or
 *      `windowChars: 0` (judge nothing) falls back to the shipped value instead of
 *      being taken literally.
 *
 * The detector's own judgement is pinned in `packages/agent-loop/src/repetition.test.ts`;
 * this file is about the WIRING.
 */

import { describe, expect, it } from "vitest";
import { Context } from "@celestea/core";
import { DEEPSEEK_REPETITION_THRESHOLDS, DEFAULT_GARBAGE_THRESHOLDS } from "@celestea/agent-loop";
import {
  REPEAT_GUARD_DEFAULTS,
  REPEAT_GUARD_ENV,
  REPEAT_GUARD_PLUGIN_NAME,
  REPEAT_GUARD_SERVICE,
  mountRepeatGuard,
  repeatGuardDisabled,
  repeatGuardOf,
  repeatGuardPlugin,
  repeatGuardSettingsOf,
} from "./repeat-guard-mount.js";

describe("W9331 repeat-guard mount · the switch", () => {
  it("mounts by DEFAULT and provides the resolved settings", () => {
    const ctx = Context.root();
    const settings = mountRepeatGuard(ctx, {}, {});
    expect(settings).not.toBeNull();
    expect(repeatGuardOf(ctx)).toEqual(settings);
    // The shipped values are upstream 2.1.6's, including the two that the
    // alignment changed (0.80 and 4096) — asserted here so a future edit to the
    // defaults cannot drift without this file noticing.
    expect(settings?.repetition.lowInfoDupShare).toBe(0.8);
    expect(settings?.repetition.holdbackChars).toBe(4096);
    expect(settings?.repetition).toEqual(DEEPSEEK_REPETITION_THRESHOLDS);
    expect(settings?.garbage).toEqual(DEFAULT_GARBAGE_THRESHOLDS);
    // The strip arm is the one layer whose action is unconditional-safe, so it is on.
    expect(settings?.sanitize).toBe(true);
    expect(settings?.retries).toBe(2);
  });

  it("does NOT mount when the environment says off — and leaves no service", () => {
    const ctx = Context.root();
    expect(mountRepeatGuard(ctx, {}, { [REPEAT_GUARD_ENV]: "off" })).toBeNull();
    // `null` from the reader is what tells a caller "the operator switched this
    // off", so a caller cannot mistake it for "not composed yet" and re-default it.
    expect(repeatGuardOf(ctx)).toBeNull();
    expect(ctx.get(REPEAT_GUARD_SERVICE)).toBeUndefined();
  });

  it("treats off / 0 / false / no (any case) as off, and anything else as on", () => {
    for (const raw of ["off", "OFF", "0", "false", "FALSE", "no", " no "]) {
      expect(repeatGuardDisabled({ [REPEAT_GUARD_ENV]: raw }), raw).toBe(true);
    }
    for (const raw of ["", "on", "1", "true", "yes", "maybe"]) {
      expect(repeatGuardDisabled({ [REPEAT_GUARD_ENV]: raw }), raw).toBe(false);
    }
  });

  it("mounting the plugin directly provides the SAME service token", () => {
    const ctx = Context.root();
    repeatGuardPlugin(REPEAT_GUARD_DEFAULTS).mount(ctx);
    expect(ctx.get(REPEAT_GUARD_SERVICE)).toBe(REPEAT_GUARD_DEFAULTS);
  });

  it("a later mount of the token wins, so a host can substitute its own settings", () => {
    const ctx = Context.root();
    mountRepeatGuard(ctx, {}, {});
    const stricter = { ...REPEAT_GUARD_DEFAULTS, retries: 0 };
    repeatGuardPlugin(stricter).mount(ctx);
    expect(repeatGuardOf(ctx)?.retries).toBe(0);
  });
});

describe("W9331 repeat-guard settings · a hostile override cannot disable it by accident", () => {
  it("keeps the shipped value for every field that is not a usable number", () => {
    const s = repeatGuardSettingsOf({
      repetition: {
        ...DEEPSEEK_REPETITION_THRESHOLDS,
        windowChars: 0,
        minWindowChars: -1,
        minSegments: Number.NaN,
        phraseRun: 0,
        phraseTopCount: 0,
        lowInfoDupShare: 0,
        maxUniqueGramRatio: 0,
        gramK: 0,
        evalEveryChars: 0,
        onsetGapSegments: -5,
      },
    });
    // Every one of those would have been "protection disabled" wearing the costume
    // of a configuration, so every one falls back.
    expect(s.repetition).toEqual(DEEPSEEK_REPETITION_THRESHOLDS);
  });

  it("rejects a ratio above 1 (which would mean 'never convict') instead of clamping it", () => {
    const s = repeatGuardSettingsOf({
      repetition: { ...DEEPSEEK_REPETITION_THRESHOLDS, lowInfoDupShare: 2, maxUniqueGramRatio: 9 },
    });
    expect(s.repetition.lowInfoDupShare).toBe(DEEPSEEK_REPETITION_THRESHOLDS.lowInfoDupShare);
    expect(s.repetition.maxUniqueGramRatio).toBe(DEEPSEEK_REPETITION_THRESHOLDS.maxUniqueGramRatio);
  });

  it("accepts `holdbackChars: 0`, because 0 is a MEANINGFUL value there", () => {
    // Unlike every other field, 0 here is documented as "no holdback" — so the
    // rule is "non-negative integer", not "positive number".
    const s = repeatGuardSettingsOf({ repetition: { ...DEEPSEEK_REPETITION_THRESHOLDS, holdbackChars: 0 } });
    expect(s.repetition.holdbackChars).toBe(0);
  });

  it("honours a legitimate override for every field it can", () => {
    const s = repeatGuardSettingsOf({
      repetition: { ...DEEPSEEK_REPETITION_THRESHOLDS, windowChars: 800, lowInfoDupShare: 0.9, holdbackChars: 128 },
      garbage: { maxRun: 8, maxRatio: 0.25 },
      retries: 5,
      sanitize: false,
    });
    expect(s.repetition.windowChars).toBe(800);
    expect(s.repetition.lowInfoDupShare).toBe(0.9);
    expect(s.repetition.holdbackChars).toBe(128);
    expect(s.garbage).toEqual({ maxRun: 8, maxRatio: 0.25 });
    expect(s.retries).toBe(5);
    expect(s.sanitize).toBe(false);
  });

  it("falls back for a garbage threshold that is not a usable number", () => {
    const s = repeatGuardSettingsOf({ garbage: { maxRun: 0, maxRatio: 0 } });
    expect(s.garbage).toEqual(DEFAULT_GARBAGE_THRESHOLDS);
  });

  it("falls back for a negative or non-integer retry budget", () => {
    expect(repeatGuardSettingsOf({ retries: -1 }).retries).toBe(REPEAT_GUARD_DEFAULTS.retries);
    expect(repeatGuardSettingsOf({ retries: 1.5 }).retries).toBe(REPEAT_GUARD_DEFAULTS.retries);
    // 0 IS valid: it means "truncate on the first conviction".
    expect(repeatGuardSettingsOf({ retries: 0 }).retries).toBe(0);
  });

  it("names itself with the catalog's name, so the inventory cannot drift", () => {
    const ctx = Context.root();
    const plugin = repeatGuardPlugin();
    plugin.mount(ctx);
    expect(plugin.name()).toBe(REPEAT_GUARD_PLUGIN_NAME);
    expect(REPEAT_GUARD_PLUGIN_NAME).toBe("celestea.runtime.repeat-guard");
  });
});
