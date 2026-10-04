/**
 * W9331 — the degenerate-repetition guard as an ENGINE PLUGIN, ported from
 * upstream `dsh-guard-repeat-output` **2.1.6** (MIT, zero dependencies,
 * published 2026-10-04; <https://www.npmjs.com/package/dsh-guard-repeat-output>).
 *
 * ## Why this file exists at all
 *
 * Before W9331 the repetition guard was not a plugin: it was a set of optional
 * `AgentLoopBindings` (`repetition`, `repetitionRetries`, `repetitionDiagnostics`,
 * `sanitizeGarbage`) that a host had to know about and wire by hand. That is the
 * opposite of the rule the rest of the composition follows, and it has a concrete
 * cost: **a host that did not wire it got no protection at all**, silently. The
 * upstream incident that motivates the 2.1.6 fix is exactly that failure — 144
 * collapses passed through unchallenged because the guard was not reliably
 * present.
 *
 * So the guard is now mounted the way every other engine capability is mounted:
 * `compose()` mounts it, `pluginNamesOf` names it, and the hot-swap catalog can
 * switch it OFF. It is **default ON** (`ENGINE_POLICY` has no `defaultEnabled:
 * false` for it) because it is a protection, and it is still switchable because a
 * host that measures a false positive must be able to turn it off without a
 * rebuild.
 *
 * ## What the plugin actually does
 *
 * It resolves the guard's settings from the thresholds it is given and provides
 * them as a service, so the composition root and the loop read ONE resolved
 * answer. It deliberately does NOT construct the loop: the loop is the host's
 * (`ComposeConfig.loopFactory`), and a plugin that `new`ed a loop would be a
 * second driver — exactly the hazard `plugin-hotswap.ts` documents about captured
 * service references.
 *
 * The three layers, in the order they act on a delta:
 *
 *   1. `strip`   — remove blacklisted code points before forwarding (exact, safe)
 *   2. detect    — statistical repetition over a bounded window (the 2.1.6 fix)
 *   3. recover   — discard-and-retry, then truncate at the onset
 *
 * Layers 1-3 live in `@celestea/agent-loop` (`repetition-sanitize.ts`,
 * `repetition.ts`, `repetition-cut.ts`); this file owns only the *wiring* and the
 * switch. That split is deliberate — the judgement is pure and testable without
 * a Context, and the composition is testable without a stream.
 */

import { definePlugin, mountPlugins, type Context, type Plugin, type ServiceToken } from "@celestea/core";
import {
  DEFAULT_GARBAGE_THRESHOLDS,
  DEEPSEEK_REPETITION_THRESHOLDS,
  type GarbageThresholds,
  type RepetitionThresholds,
} from "@celestea/agent-loop";

/** Mount name of the repetition guard (matches `ENGINE_REPEAT_GUARD_PLUGIN`). */
export const REPEAT_GUARD_PLUGIN_NAME = "celestea.runtime.repeat-guard";

/** `CELESTEA_REPEAT_GUARD=off` (or `0`/`false`/`no`) disables the mount. */
export const REPEAT_GUARD_ENV = "CELESTEA_REPEAT_GUARD";

/** The service the plugin provides: the resolved guard settings for this generation. */
export interface RepeatGuardSettings {
  /** The repetition thresholds (already resolved, never partially filled). */
  repetition: RepetitionThresholds;
  /** Density thresholds that turn dense garbage into a collapse verdict. */
  garbage: GarbageThresholds;
  /** How many collapsed attempts may be discarded and re-issued per step. */
  retries: number;
  /** Whether blacklisted code points are stripped from every delta. */
  sanitize: boolean;
}

/**
 * The shipped settings. The retry budget of 2 and every threshold are upstream
 * W9323: upstream npm tarball ref (not a repo file) — cannot rot with a local edit.
 * 2.1.6's values, not locally invented ones (`index.js:147-230`).
 */
export const REPEAT_GUARD_DEFAULTS: RepeatGuardSettings = {
  repetition: DEEPSEEK_REPETITION_THRESHOLDS,
  garbage: DEFAULT_GARBAGE_THRESHOLDS,
  retries: 2,
  sanitize: true,
};

/** `off` / `0` / `false` / `no` (case-insensitive) mean "do not mount". */
export function repeatGuardDisabled(env: NodeJS.ProcessEnv): boolean {
  const raw = (env[REPEAT_GUARD_ENV] ?? "").trim().toLowerCase();
  return raw === "off" || raw === "0" || raw === "false" || raw === "no";
}

/** What a caller may override; every absent field keeps the shipped default. */
export type RepeatGuardOptions = Partial<RepeatGuardSettings>;

/**
 * Resolve the settings, merging a partial override onto the defaults.
 *
 * Pure, and **fail-safe on a hostile override**: a threshold that is not a
 * positive number falls back to the default rather than disabling the guard. A
 * `lowInfoDupShare: 0` would convict every window, and a `windowChars: 0` would
 * judge nothing — both are "protection disabled" wearing the costume of a
 * configuration, so neither is allowed through.
 */
export function repeatGuardSettingsOf(options: RepeatGuardOptions = {}): RepeatGuardSettings {
  return {
    repetition: saneThresholds(options.repetition ?? DEEPSEEK_REPETITION_THRESHOLDS),
    garbage: saneGarbage(options.garbage ?? DEFAULT_GARBAGE_THRESHOLDS),
    retries: Number.isInteger(options.retries) && (options.retries ?? -1) >= 0 ? (options.retries as number) : REPEAT_GUARD_DEFAULTS.retries,
    sanitize: options.sanitize !== false,
  };
}

/** Positive-number fallback, per field; the shape is never partially trusted. */
function saneThresholds(input: RepetitionThresholds): RepetitionThresholds {
  const base = DEEPSEEK_REPETITION_THRESHOLDS;
  const ratio = (value: number, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  return {
    windowChars: Math.floor(ratio(input.windowChars, base.windowChars)),
    minWindowChars: Math.floor(ratio(input.minWindowChars, base.minWindowChars)),
    minSegments: Math.floor(ratio(input.minSegments, base.minSegments)),
    phraseRun: Math.floor(ratio(input.phraseRun, base.phraseRun)),
    phraseTopCount: Math.floor(ratio(input.phraseTopCount, base.phraseTopCount)),
    // A ratio lives in (0, 1]; 0 would convict every window and >1 would never
    // convict, so both are rejected rather than clamped.
    lowInfoDupShare: ratio(input.lowInfoDupShare, base.lowInfoDupShare) > 1 ? base.lowInfoDupShare : ratio(input.lowInfoDupShare, base.lowInfoDupShare),
    maxUniqueGramRatio: ratio(input.maxUniqueGramRatio, base.maxUniqueGramRatio) > 1 ? base.maxUniqueGramRatio : ratio(input.maxUniqueGramRatio, base.maxUniqueGramRatio),
    gramK: Math.floor(ratio(input.gramK, base.gramK)),
    evalEveryChars: Math.floor(ratio(input.evalEveryChars, base.evalEveryChars)),
    onsetGapSegments: Math.floor(ratio(input.onsetGapSegments, base.onsetGapSegments)),
    // 0 IS meaningful here (it disables holdback), so the rule is "a
    // non-negative integer", not "positive".
    holdbackChars: Number.isInteger(input.holdbackChars) && input.holdbackChars >= 0 ? input.holdbackChars : base.holdbackChars,
  };
}

function saneGarbage(input: GarbageThresholds): GarbageThresholds {
  const base = DEFAULT_GARBAGE_THRESHOLDS;
  return {
    maxRun: Number.isInteger(input.maxRun) && input.maxRun > 0 ? input.maxRun : base.maxRun,
    maxRatio: typeof input.maxRatio === "number" && Number.isFinite(input.maxRatio) && input.maxRatio > 0 && input.maxRatio <= 1 ? input.maxRatio : base.maxRatio,
  };
}

/**
 * Mount the guard over one generation. Returns `null` when it is switched off —
 * in that case NO service is provided and nothing is mounted, which is what makes
 * "off" observable rather than merely quiet (the same contract
 * `mountWatchdog` follows).
 */
export function mountRepeatGuard(
  ctx: Context,
  options: RepeatGuardOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): RepeatGuardSettings | null {
  if (repeatGuardDisabled(env)) return null;
  const settings = repeatGuardSettingsOf(options);
  mountPlugins(ctx, [repeatGuardPlugin(settings)]);
  return settings;
}

/**
 * The plugin itself. Split out so a test can mount it without touching the
 * environment, and so the settings are constructed in exactly one place.
 *
 * It provides the settings under a module-local token. A later `provide` of the
 * same token wins, so a host can substitute a stricter or looser configuration
 * by mounting its own plugin over this one.
 */
export function repeatGuardPlugin(settings: RepeatGuardSettings = REPEAT_GUARD_DEFAULTS, name = REPEAT_GUARD_PLUGIN_NAME): Plugin {
  return definePlugin(name, (ctx) => {
    ctx.provide(REPEAT_GUARD_SERVICE, settings);
  });
}

/**
 * The service token. Declared here (not in core) for the same reason the swarm
 * roster token lives in its own package: a token belongs to the module that
 * PROVIDES the service, and core only holds seam-level tokens.
 */
export const REPEAT_GUARD_SERVICE: ServiceToken<RepeatGuardSettings> = Symbol.for(
  "celestea.runtime.repeat-guard",
) as ServiceToken<RepeatGuardSettings>;

/**
 * Read the settings back out of a Context, or `null` when the guard was not
 * mounted (switched off, or a host that composed without it).
 *
 * The distinction matters: a caller that cannot find the settings must not
 * substitute the defaults, because that would re-enable a guard the operator
 * deliberately turned off.
 */
export function repeatGuardOf(ctx: Context): RepeatGuardSettings | null {
  return ctx.get<RepeatGuardSettings>(REPEAT_GUARD_SERVICE) ?? null;
}
