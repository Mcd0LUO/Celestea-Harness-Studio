/**
 * Provider policy — **which** sandbox a deployment gets, decided out loud.
 *
 * W9270 — the choice is a **CANDIDATE CHAIN walked by capability**, not a
 * two-way branch. It used to be one expression:
 *
 *     probe.bwrapUsable && probe.bwrapPath !== null ? selectBwrap(...) : (userspace)
 *
 * which meant a macOS Seatbelt or a Windows ACL runner could only be added by
 * EDITING that expression — a branch, not data. The chain makes it the other way
 * round: `[bwrap, …injected, userspace]`, each rung carrying its own functional
 * probe and its own `select`, and the walk knowing nothing about any particular
 * provider. Adding `windows-acl` is appending one candidate object; this file
 * does not change. (`provider.test.ts` asserts that mechanically: a fake runner
 * is selected with the walk untouched.)
 *
 * Two rules keep the chain honest, and both are enforced by the walk, not by
 * convention:
 *
 * 1. **A skipped rung records WHY.** `skippedRunners` carries the host evidence
 *    for every candidate the walk passed over, so a degradation is still visible
 *    (the W268 lesson) no matter how long the chain grows.
 * 2. **`fail` stays fail-closed at EVERY rung.** Each candidate declares the
 *    refusal the policy raises when it lands there (`refuse`); the walk consults
 *    it before building anything. bwrap declines to refuse (it is what `fail`
 *    wants — its PARTIAL boundary is refused inside its own `select`, W1483), the
 *    terminal userspace rung refuses with the same `SandboxError("config", …)` and
 *    the same `sandbox_unavailable:` vocabulary it always used, and the
 *    `unsandboxed` session grant remains the ONE documented way through it.
 *
 * The fallback policy is unchanged: `CELESTEA_SANDBOX_FALLBACK=userspace`
 * (default) degrades, `=fail` refuses to run at all. An unrecognized value is an
 * error, not a silent return to the default (a typo must not decide the security
 * posture). The chosen provider always travels in `SandboxSelection`
 * (`degraded`/`reason`/`enforcement` are available for startup logs).
 *
 * Same env vocabulary as the engine contract (`contracts/tools.json`):
 * `CELESTEA_SANDBOX_NET=1`, `CELESTEA_SANDBOX_SHARE_TMP=1`,
 * `CELESTEA_SANDBOX_SECCOMP=1`, plus `CELESTEA_SANDBOX_MASK=<abs dirs>`.
 */

import { isAbsolute } from "node:path";

import type { Sandbox, SandboxConfig, SandboxEnforcement, SandboxPromiseGap } from "@celestea/core";
import { SandboxError } from "@celestea/core";

import { BWRAP_PROVIDER, DEFAULT_BWRAP_OPTIONS, type BwrapOptions } from "./bwrap-argv.js";
import { bwrapEnforcement } from "./enforcement.js";
import { BwrapSandbox } from "./bwrap.js";
import { sandboxConfigFromEnv } from "./config.js";
import { envFlag, envString } from "../env.js";
import { limitsFromEnv, rlimitsEnabled } from "./limits.js";
import { probeHost, type HostProbe } from "./probe.js";
import { UserspaceSandbox } from "./userspace.js";

/** Env var: `userspace` (default, degrade) | `fail` (refuse). */
export const ENV_SANDBOX_FALLBACK = "CELESTEA_SANDBOX_FALLBACK";
/** Env var: `1` keeps the host network namespace (contract knob). */
export const ENV_SANDBOX_NET = "CELESTEA_SANDBOX_NET";
/** Env var: `1` binds the host `/tmp` instead of a private tmpfs (contract knob). */
export const ENV_SANDBOX_SHARE_TMP = "CELESTEA_SANDBOX_SHARE_TMP";
/** Env var: `1` installs the TS cBPF whitelist (contract knob). */
export const ENV_SANDBOX_SECCOMP = "CELESTEA_SANDBOX_SECCOMP";
/** Env var: comma-separated absolute host dirs masked with an empty tmpfs. */
export const ENV_SANDBOX_MASK = "CELESTEA_SANDBOX_MASK";

/** Provider id of the terminal rung (reported as `SandboxMeta.provider`). */
const USERSPACE_PROVIDER = "userspace";

/** Reason used when the chain reached the terminal rung with nothing skipped. */
const NO_RUNNER_REASON = "no OS-isolation runner in the chain was usable on this host";

export type SandboxFallbackMode = "userspace" | "fail";

/**
 * Session-grant view of the sandbox provider (W516). Structural: the tools
 * package never imports the host's grants module.
 */
export interface SandboxGrantView {
  /** `network`: keep the host network namespace even without the env knob. */
  network?: boolean;
  /** `unsandboxed`: accept the userspace provider although the mode is `fail`. */
  unsandboxed?: boolean;
  /** W9: the permission baseline's write capability (false = read-only). */
  workspaceWritable?: boolean;
  /** W9: extra absolute write roots to bind rw in the sandbox. */
  writeRoots?: readonly string[];
}

/**
 * One rung the walk passed over, with the host evidence that passed it over.
 * The trail is what keeps a long chain auditable: the W268 failure was a
 * degradation nobody could see, and a chain without a trail would be the same
 * bug with more rungs.
 */
export interface SkippedRunner {
  /** The candidate's provider id (what it WOULD have reported). */
  readonly name: string;
  /** Why this host could not run it (probe evidence, never prose from nowhere). */
  readonly reason: string;
}

/**
 * Everything a candidate may look at: the host facts, the resolved policy, and
 * how far the walk got. Passed as ONE object so a new candidate never has to
 * learn the traversal's internals — the seam is the data, not the call shape.
 */
export interface RunnerHost {
  /** The host self-check (injectable; tests never touch the real machine). */
  readonly probe: HostProbe;
  readonly env: NodeJS.ProcessEnv;
  /** `CELESTEA_SANDBOX_FALLBACK`, already validated. */
  readonly mode: SandboxFallbackMode;
  readonly grants: SandboxGrantView;
  readonly config: SandboxConfig;
  /** Rungs already rejected, in chain order (empty at the first one). */
  readonly skipped: readonly SkippedRunner[];
}

/**
 * One rung of the chain — the unit a new runner is added as (W9270).
 *
 * A candidate is DATA plus three small functions; the walk in
 * [walkRunnerChain] knows no provider name, so appending a rung cannot break
 * the traversal and cannot change what the existing rungs do.
 */
export interface SandboxRunnerCandidate {
  /** Provider id reported when this rung is the one selected. */
  readonly name: string;
  /**
   * The FUNCTIONAL PROBE: can THIS host actually run it? Evidence, not
   * assumption — a binary that exists but cannot confine is unusable.
   */
  usable(host: RunnerHost): boolean;
  /** Why not. Recorded in the trail so a degradation is never silent. */
  unusableReason(host: RunnerHost): string;
  /**
   * Build the selection. A provider MAY raise its own fail-closed refusal here
   * (bwrap does, for a PARTIAL boundary under `fail` — W1483).
   */
  select(host: RunnerHost): SandboxSelection;
  /**
   * The `CELESTEA_SANDBOX_FALLBACK=fail` refusal for landing on THIS rung, or
   * `null` when the policy accepts the landing. Omitted / `null` = a rung that
   * delivers what `fail` asked for (bwrap's own partial gate lives in `select`).
   */
  refuse?(host: RunnerHost): SandboxError | null;
}

export interface SelectOptions {
  env?: NodeJS.ProcessEnv;
  config?: SandboxConfig;
  /** Inject a probe (tests); default: the memoized host probe. */
  probe?: HostProbe;
  /** Per-session grants (W516): widen only — see [bwrapOptionsFromEnv]. */
  grants?: SandboxGrantView;
  /**
   * W9270: candidate data to add to the chain — placed AFTER the built-in
   * OS-isolated rungs and BEFORE the terminal userspace fallback, so an
   * injected runner beats the degraded path and never beats a working bwrap.
   * Adding a runner is appending one object here; this file does not change.
   */
  runners?: readonly SandboxRunnerCandidate[];
  /**
   * W9270: replace the chain wholesale (walk mechanics — e.g. reaching the
   * exhaustion refusal, or exercising a rung the product never chains).
   * Wins over `runners` when both are given. Mirrors DSH's
   * `SandboxInternals.chain`.
   */
  chain?: readonly SandboxRunnerCandidate[];
}

export interface SandboxSelection {
  sandbox: Sandbox;
  /** Provider that will actually execute commands. */
  provider: string;
  /** true when bwrap was unavailable and the userspace path was chosen. */
  degraded: boolean;
  /** Why bwrap was rejected (for the startup log); null when not degraded. */
  reason: string | null;
  mode: SandboxFallbackMode;
  /**
   * true when the userspace provider was chosen *because* the `unsandboxed`
   * session grant overrode `CELESTEA_SANDBOX_FALLBACK=fail`. The host must
   * record a `degraded_by_grant` audit line when it sees this (`§4.4`).
   */
  degradedByGrant: boolean;
  /**
   * W1483: the selected provider's own completeness verdict (`full`/`partial`).
   * Read it from here for startup logs / health instead of re-deriving it from
   * the provider's booleans.
   */
  enforcement: SandboxEnforcement;
  /** W1483: what the selected provider could not deliver (`partial` only). */
  promiseGaps: readonly SandboxPromiseGap[];
  /**
   * W9270: the chain trail — every rung passed over before the selected one,
   * with the host evidence for each. Empty when the first rung won. This is
   * the honest replacement for "bwrap was unusable": on a five-rung chain the
   * answer names all four rejections, not just the one a branch remembered.
   */
  skippedRunners: readonly SkippedRunner[];
}

/** The selected sandbox, ready to inject (`builtinTools`, plugin service). */
export function selectSandbox(options: SelectOptions = {}): Sandbox {
  return selectSandboxDetailed(options).sandbox;
}

/**
 * Selection plus the honest story of how it was made: resolve the policy, then
 * WALK the chain. No provider branch lives here — the only provider names in
 * this file are the candidate data declared at the bottom.
 */
export function selectSandboxDetailed(options: SelectOptions = {}): SandboxSelection {
  const env = options.env ?? process.env;
  const mode = fallbackMode(env);
  const grants = options.grants ?? {};
  const probe = options.probe ?? probeHost({ env });
  const config = options.config ?? sandboxConfigFromEnv(env);
  return walkRunnerChain(chainFor(options), { probe, env, mode, grants, config, skipped: [] });
}

/**
 * The chain this deployment walks: built-in OS-isolated rungs, the caller's
 * added candidates, then the terminal fallback.
 */
function chainFor(options: SelectOptions): readonly SandboxRunnerCandidate[] {
  if (options.chain !== undefined) return options.chain;
  return [BWRAP_CANDIDATE, ...(options.runners ?? []), USERSPACE_CANDIDATE];
}

/**
 * The traversal — the same three steps for every provider, by construction.
 *
 * 1. ask the rung whether this host can run it (functional probe);
 * 2. if not, record `{ name, reason }` and go on to the next;
 * 3. if yes, let the rung's own `fail`-policy refusal speak, then build.
 *
 * Step 2 is the ONLY branch, and it is about the chain, never about a provider.
 * A chain that runs out (only reachable through an injected `chain`) refuses
 * rather than returning the host's own argv unguarded.
 */
function walkRunnerChain(chain: readonly SandboxRunnerCandidate[], base: RunnerHost): SandboxSelection {
  const skipped: SkippedRunner[] = [];
  for (const candidate of chain) {
    const host: RunnerHost = { ...base, skipped };
    if (!candidate.usable(host)) {
      skipped.push({ name: candidate.name, reason: candidate.unusableReason(host) });
      continue;
    }
    const refusal = candidate.refuse?.(host) ?? null;
    if (refusal !== null) throw refusal;
    return { ...candidate.select(host), skippedRunners: [...skipped] };
  }
  throw new SandboxError(
    "config",
    `sandbox_unavailable: no runner in the chain is usable on this host (${skipped.map((rung) => `${rung.name}: ${rung.reason}`).join("; ") || "empty chain"})`,
    { skipped: [...skipped], mode: base.mode },
  );
}

/**
 * Rung 0 — bwrap, gated by the host probe (W274 §8.2: usable only after the
 * real mount sequence ran and `/dev/zero` read back inside the namespace).
 *
 * `refuse` is deliberately absent: bwrap is what `fail` WANTS, so landing here
 * is never a refusal. Its PARTIAL boundary is refused by [selectBwrap] itself,
 * which is the W1483 absolute-promise gate and must not become a chain concern.
 */
const BWRAP_CANDIDATE: SandboxRunnerCandidate = {
  name: BWRAP_PROVIDER,
  usable: (host) => host.probe.bwrapUsable && host.probe.bwrapPath !== null,
  unusableReason: (host) => host.probe.bwrapRejectReason ?? "bwrap reported unusable by the host probe",
  select: selectBwrap,
};

/**
 * The terminal rung — the explicit, VISIBLE degradation (or its grant override).
 * It is always usable: a chain MUST have a last rung, and the policy decides
 * whether landing on it is acceptable ([refuseUserspace]).
 */
const USERSPACE_CANDIDATE: SandboxRunnerCandidate = {
  name: USERSPACE_PROVIDER,
  usable: () => true,
  unusableReason: () => NO_RUNNER_REASON,
  select: selectUserspace,
  refuse: refuseUserspace,
};

/**
 * §4.3.5: `unsandboxed` is the ONE grant that accepts the userspace provider
 * under `fail` — the policy would refuse, and the user explicitly asked for
 * this session to run anyway.
 *
 * The refusal names the FIRST rung the walk could not use, because that is the
 * provider the deployment asked for and the host did not deliver (with the
 * built-in chain: bwrap, hence the unchanged `provider: "bwrap"` payload).
 */
function refuseUserspace(host: RunnerHost): SandboxError | null {
  if (host.mode !== "fail" || host.grants.unsandboxed === true) return null;
  const rejected = host.skipped[0];
  const reason = rejected?.reason ?? NO_RUNNER_REASON;
  return new SandboxError(
    "config",
    `sandbox_unavailable: ${reason} and ${ENV_SANDBOX_FALLBACK}=fail refuses to degrade to the userspace sandbox`,
    { provider: rejected?.name ?? USERSPACE_PROVIDER, reason, mode: host.mode },
  );
}

/**
 * W1483: the bwrap rung's build, including the absolute-promise gate.
 *
 * The provider declares what it can actually deliver on THIS host, and the
 * EXISTING `fail` policy refuses a partial boundary instead of silently shipping
 * one. The declaration is the provider's, never ours.
 */
function selectBwrap(host: RunnerHost): SandboxSelection {
  const { env, mode, grants, probe, config } = host;
  const run = bwrapOptionsFromEnv(env, grants);
  const declared = bwrapEnforcement(run, probe);
  const gaps = declared.promise_gaps ?? [];
  if (declared.enforcement === "partial" && mode === "fail" && grants.unsandboxed !== true) {
    const missing = gaps.join(", ") || "unspecified";
    throw new SandboxError(
      "config",
      "sandbox_unavailable: the bwrap provider reports partial enforcement (missing: " +
        `${missing}) and ${ENV_SANDBOX_FALLBACK}=fail requires every promised effect; ` +
        `fix the host or set ${ENV_SANDBOX_FALLBACK}=userspace to accept the degraded boundary explicitly`,
      { provider: BWRAP_PROVIDER, enforcement: declared.enforcement, promise_gaps: [...gaps], mode },
    );
  }
  const sandbox = new BwrapSandbox(config, {
    probe,
    env,
    // W1465: RLIMIT_NPROC counts the whole real UID host-wide, so a cap derived
    // once here is a time bomb — the UID's thread count grows and the frozen
    // value eventually makes bwrap fail to create its namespace at all
    // (EAGAIN, "Resource temporarily unavailable"). Re-derive per call.
    refreshNprocPerCall: true,
    limits: limitsFromEnv(env, probe.uidThreads),
    // W516 §4.3.5: `unsandboxed` is IGNORED when bwrap works — isolation is
    // already in effect and grants only ever add an escape when a policy
    // refuses, never "less isolation than the host already provides".
    run,
    rlimits: rlimitsEnabled(env),
  });
  return {
    sandbox,
    provider: BWRAP_PROVIDER,
    degraded: false,
    reason: null,
    mode,
    degradedByGrant: false,
    enforcement: declared.enforcement,
    promiseGaps: [...gaps],
    skippedRunners: host.skipped,
  };
}

/** The terminal rung's build — degradation reason = the first rejected rung. */
function selectUserspace(host: RunnerHost): SandboxSelection {
  const { env, mode, probe, config, grants, skipped } = host;
  // With the built-in chain there is always one rejected rung (bwrap); a caller
  // that chains userspace first gets the neutral reason instead of a borrowed one.
  const reason = skipped[0]?.reason ?? NO_RUNNER_REASON;
  // Landing here under `fail` is only reachable through the grant — otherwise
  // [refuseUserspace] already threw — so this conjunction is the same verdict.
  const degradedByGrant = mode === "fail" && grants.unsandboxed === true;
  const sandbox = new UserspaceSandbox(config, {
    probe,
    env,
    refreshNprocPerCall: true,
    limits: limitsFromEnv(env, probe.uidThreads),
    rlimits: rlimitsEnabled(env),
  });
  const declared = sandbox.enforcement();
  return {
    sandbox,
    provider: USERSPACE_PROVIDER,
    degraded: true,
    reason: degradedByGrant ? `${reason} — degraded by the 'unsandboxed' session grant` : reason,
    mode,
    degradedByGrant,
    enforcement: declared.enforcement,
    promiseGaps: declared.promise_gaps ?? [],
    skippedRunners: skipped,
  };
}

/** Fallback policy; an unknown value is rejected (fail-closed, see module docs). */
export function fallbackMode(env: NodeJS.ProcessEnv = process.env): SandboxFallbackMode {
  const raw = envString(env, ENV_SANDBOX_FALLBACK)?.toLowerCase();
  if (raw === undefined || raw === "userspace") return "userspace";
  if (raw === "fail") return "fail";
  throw new SandboxError("config", `invalid ${ENV_SANDBOX_FALLBACK}='${raw}' (expected 'userspace' or 'fail')`, {
    value: raw,
  });
}

/**
 * bwrap knobs from the contract env vocabulary. W516: a session's `network`
 * grant ORs into `shareNet` (and touches nothing else — `shareTmp`, `seccomp`,
 * `maskDirs` and the rlimits stay exactly as the operator set them, §5.6).
 */
export function bwrapOptionsFromEnv(env: NodeJS.ProcessEnv = process.env, grants: SandboxGrantView = {}): BwrapOptions {
  return {
    shareNet: envFlag(env[ENV_SANDBOX_NET], DEFAULT_BWRAP_OPTIONS.shareNet) || grants.network === true,
    shareTmp: envFlag(env[ENV_SANDBOX_SHARE_TMP], DEFAULT_BWRAP_OPTIONS.shareTmp),
    seccomp: envFlag(env[ENV_SANDBOX_SECCOMP], DEFAULT_BWRAP_OPTIONS.seccomp),
    maskDirs: parseMaskDirs(envString(env, ENV_SANDBOX_MASK)),
    workspaceWritable: grants.workspaceWritable !== false,
    writeRoots: [...(grants.writeRoots ?? [])],
  };
}

function parseMaskDirs(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const dirs = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  for (const dir of dirs) {
    if (!isAbsolute(dir) || dir === "/") {
      throw new SandboxError("config", `invalid ${ENV_SANDBOX_MASK} entry '${dir}' (absolute, non-root paths only)`);
    }
  }
  return dirs;
}
