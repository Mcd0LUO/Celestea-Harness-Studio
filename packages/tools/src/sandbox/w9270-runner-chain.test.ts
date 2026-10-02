/**
 * W9270 — the runner chain is DATA, and a new runner is added as data.
 *
 * The defect this file exists for: `selectSandboxDetailed` used to be one
 * expression — `probe.bwrapUsable && probe.bwrapPath !== null ? bwrap : userspace`
 * — so a macOS Seatbelt or a Windows ACL runner could only be added by editing
 * that branch. These cases pin the replacement mechanically:
 *
 *   A. a FAKE runner is selected on a host where the probe rejects bwrap, with
 *      the walk itself untouched (the branch is gone; the chain is the input);
 *   B. the order is a property of the data, not of code;
 *   C. every passed-over rung is TRAILED with the host evidence for it;
 *   D. an exhausted chain refuses (fail-closed) instead of running unguarded;
 *   E. a rung's own `fail` refusal is what the policy raises — including the
 *      EXACT, pre-recorded payload the old two-way branch produced.
 */

import { describe, expect, it } from "vitest";
import { isSandboxError, SandboxError, type Sandbox } from "@celestea/core";

import { buildSandboxConfig } from "./config.js";
import { USERSPACE_SANDBOX_META } from "@celestea/core";
import {
  ENV_SANDBOX_FALLBACK,
  selectSandboxDetailed,
  type SandboxRunnerCandidate,
  type RunnerHost,
} from "./provider.js";
import { type HostProbe } from "./probe.js";

const WORK = "/srv/celestea/studio";

function config() {
  return buildSandboxConfig({ workdir: WORK, root: WORK, timeoutMs: 5_000, maxTimeoutMs: 10_000 });
}

/** A host whose smoke measured every promise (the shape `probeHost()` returns). */
function probeWith(overrides: Partial<HostProbe> = {}): HostProbe {
  return {
    platform: "linux",
    bwrapPath: "/usr/bin/bwrap",
    bwrapVersion: "bubblewrap 0.11.1\n",
    bwrapUsable: true,
    bwrapRejectReason: null,
    prlimitPath: "/usr/bin/prlimit",
    shellUlimitWorks: true,
    uidThreads: 347,
    namespaceEvidence: ["mnt", "pid", "net", "ipc", "uts", "user", "cgroup"],
    readonlyRootObserved: true,
    tmpPrivateObserved: true,
    ...overrides,
  };
}

/** The host where NO built-in rung works — what a new runner exists for. */
const NO_BWRAP = probeWith({ bwrapUsable: false, bwrapRejectReason: "injected: no bwrap" });

/** A sandbox that records nothing and runs nothing (a chain-selection probe). */
function fakeSandbox(label: string): Sandbox {
  return {
    config: config(),
    run: () => {
      throw new Error(`${label} must not run in a selection test`);
    },
    spawn: () => {
      throw new Error(`${label} must not spawn in a selection test`);
    },
  };
}

/**
 * A stand-in for `windows-acl`: the ONLY thing it contributes is this object.
 * Nothing in `provider.ts` is edited, imported or configured to make it work.
 */
function fakeRunner(name: string, usable: boolean, reason: string, platform: NodeJS.Platform = "win32"): SandboxRunnerCandidate {
  return {
    name,
    usable: (host: RunnerHost) => usable && host.probe.platform === platform,
    unusableReason: () => reason,
    select: (host: RunnerHost) => ({
      sandbox: fakeSandbox(name),
      provider: name,
      degraded: false,
      reason: null,
      mode: host.mode,
      degradedByGrant: false,
      enforcement: "full",
      promiseGaps: [],
      skippedRunners: host.skipped,
    }),
  };
}

describe("W9270 A — a new runner is added as DATA, not as a branch", () => {
  it("selects an injected runner without the walk knowing its name", () => {
    // The host: win32, and the probe already rejected bwrap. On the OLD code
    // there was no expression that returns "windows-acl" here.
    const probe = probeWith({ platform: "win32", bwrapUsable: false, bwrapRejectReason: "not Linux" });
    const selection = selectSandboxDetailed({
      env: {},
      config: config(),
      probe,
      runners: [fakeRunner("windows-acl", true, "acl runner not built")],
    });
    expect(selection.provider).toBe("windows-acl");
    expect(selection.degraded).toBe(false);
    expect(selection.enforcement).toBe("full");
    // ...and the chain still tells the truth about what it walked past.
    expect(selection.skippedRunners).toEqual([{ name: "bwrap", reason: "not Linux" }]);
  });

  it("keeps a working bwrap ahead of the injected runner (order is the data's)", () => {
    const selection = selectSandboxDetailed({
      env: {},
      config: config(),
      probe: probeWith(),
      runners: [fakeRunner("windows-acl", true, "unreachable")],
    });
    expect(selection.provider).toBe("bwrap");
    expect(selection.skippedRunners).toEqual([]);
  });

  it("re-orders by data too: the SAME candidate can outrank bwrap via `chain`", () => {
    const selection = selectSandboxDetailed({
      env: {},
      config: config(),
      probe: probeWith(),
      chain: [fakeRunner("seatbelt", true, "unreachable", "linux"), USERSPACE_ONLY],
    });
    expect(selection.provider).toBe("seatbelt");
    expect(selection.skippedRunners).toEqual([]);
  });
});

describe("W9270 B — the walk is order-driven and records every skip", () => {
  it("trails each rejected rung with the evidence that rejected it", () => {
    const selection = selectSandboxDetailed({
      env: {},
      config: config(),
      probe: NO_BWRAP,
      runners: [
        fakeRunner("landlock", false, "landlock: kernel 6.4 ABI missing"),
        fakeRunner("seatbelt", false, "seatbelt: sandbox-exec not found"),
      ],
    });
    expect(selection.provider).toBe("userspace");
    expect(selection.skippedRunners).toEqual([
      { name: "bwrap", reason: "injected: no bwrap" },
      { name: "landlock", reason: "landlock: kernel 6.4 ABI missing" },
      { name: "seatbelt", reason: "seatbelt: sandbox-exec not found" },
    ]);
  });

  it("stops at the first usable rung — later candidates are never consulted", () => {
    const consulted: string[] = [];
    const spy = (name: string): SandboxRunnerCandidate => ({
      name,
      usable: () => {
        consulted.push(name);
        return false;
      },
      unusableReason: () => `${name} unusable`,
      select: () => {
        throw new Error("unreachable");
      },
    });
    selectSandboxDetailed({ env: {}, config: config(), probe: probeWith(), runners: [spy("a"), spy("b")] });
    // bwrap won outright, so not one rung behind it was even asked.
    expect(consulted).toEqual([]);
  });
});

describe("W9270 C — a chain that runs out refuses (never runs unguarded)", () => {
  it("throws the fail-closed refusal naming every rejected rung", () => {
    try {
      selectSandboxDetailed({
        env: {},
        config: config(),
        probe: NO_BWRAP,
        chain: [fakeRunner("landlock", false, "kernel 6.4 ABI missing")],
      });
      expect.unreachable("an exhausted chain must refuse, not fall through");
    } catch (error) {
      expect(isSandboxError(error)).toBe(true);
      expect((error as { kind: string }).kind).toBe("config");
      expect(String((error as Error).message)).toContain("sandbox_unavailable");
      expect(String((error as Error).message)).toContain("landlock: kernel 6.4 ABI missing");
    }
  });

  it("refuses an empty chain rather than handing back the host's own argv", () => {
    expect(() => selectSandboxDetailed({ env: {}, config: config(), probe: probeWith(), chain: [] })).toThrowError(
      /sandbox_unavailable/,
    );
  });
});

/**
 * E. The pre-existing fail-closed policy must survive the data-driven rewrite
 * `field for field`. The expected values below were recorded by RUNNING the
 * pre-change `selectSandboxDetailed` (see the W9270 report), not retyped from
 * the source — if the walk ever reorders the payload, this is what catches it.
 */
describe("W9270 D — the fail policy refuses with the UNCHANGED payload", () => {
  it("mode=fail with no usable runner raises the same SandboxError as before", () => {
    let caught: unknown;
    try {
      selectSandboxDetailed({
        env: { [ENV_SANDBOX_FALLBACK]: "fail" },
        config: config(),
        probe: probeWith({ bwrapUsable: false, bwrapRejectReason: "injected: no bwrap" }),
      });
    } catch (error) {
      caught = error;
    }
    expect(isSandboxError(caught)).toBe(true);
    const error = caught as { name: string; kind: string; message: string; detail: Record<string, unknown> };
    expect(error.name).toBe("SandboxError");
    expect(error.kind).toBe("config");
    expect(error.message).toBe(
      'run_shell-sandbox: code=config msg="sandbox_unavailable: injected: no bwrap and CELESTEA_SANDBOX_FALLBACK=fail refuses to degrade to the userspace sandbox"',
    );
    expect(error.detail).toEqual({ provider: "bwrap", reason: "injected: no bwrap", mode: "fail" });
  });

  it("the `unsandboxed` grant is still the one way through it", () => {
    const selection = selectSandboxDetailed({
      env: { [ENV_SANDBOX_FALLBACK]: "fail" },
      config: config(),
      probe: probeWith({ bwrapUsable: false, bwrapRejectReason: "injected: no bwrap" }),
      grants: { unsandboxed: true },
    });
    expect(selection.provider).toBe("userspace");
    expect(selection.degradedByGrant).toBe(true);
    expect(selection.reason).toBe("injected: no bwrap — degraded by the 'unsandboxed' session grant");
  });

  it("raises the refusal the rung itself returned, before building anything", () => {
    const refusal = new SandboxError("config", "sandbox_unavailable: windows-acl needs a real ACL sandbox", {
      provider: "windows-acl",
    });
    const rungs: string[] = [];
    const chain: SandboxRunnerCandidate[] = [
      {
        name: "windows-acl",
        usable: (host) => {
          rungs.push("windows-acl:usable");
          return true;
        },
        unusableReason: () => "windows-acl reports partial enforcement on this host",
        select: () => {
          rungs.push("windows-acl:select");
          return {
            sandbox: fakeSandbox("windows-acl"),
            provider: "windows-acl",
            degraded: true,
            reason: "windows-acl reports partial enforcement on this host",
            mode: "userspace",
            degradedByGrant: false,
            enforcement: "partial",
            promiseGaps: ["no_os_isolation"],
            skippedRunners: [],
          };
        },
        // The refusal depends on the RESOLVED policy the walk hands it, not on
        // a hardcoded branch somewhere in the traversal.
        refuse: (host) => (host.mode === "fail" ? refusal : null),
      },
    ];
    // `select` is never reached: the rung refused, and the walk contributes
    // only the throw of the refusal the rung authored.
    expect(() =>
      selectSandboxDetailed({ env: { [ENV_SANDBOX_FALLBACK]: "fail" }, config: config(), probe: probeWith(), chain }),
    ).toThrowError(refusal);
    expect(rungs).toEqual(["windows-acl:usable"]);
  });

  it("accepts the landing when the rung refuse() returns null (the bwrap shape)", () => {
    const rungs: string[] = [];
    const chain: SandboxRunnerCandidate[] = [
      {
        name: "policy-acceptor",
        usable: () => {
          rungs.push("usable");
          return true;
        },
        unusableReason: () => "unusable",
        select: (host) => {
          rungs.push("select");
          return {
            sandbox: fakeSandbox("policy-acceptor"),
            provider: "policy-acceptor",
            degraded: false,
            reason: null,
            mode: host.mode,
            degradedByGrant: false,
            enforcement: "full",
            promiseGaps: [],
            skippedRunners: [],
          };
        },
        // No fabricated check in the walk: under `fail` a rung whose refuse()
        // yields null IS built.
        refuse: (): null => null,
      },
    ];
    const selection = selectSandboxDetailed({
      env: { [ENV_SANDBOX_FALLBACK]: "fail" },
      config: config(),
      probe: probeWith(),
      chain,
    });
    expect(selection.provider).toBe("policy-acceptor");
    expect(rungs).toEqual(["usable", "select"]);
  });
});

describe("W9270 E — the degraded rung still reports the honest posture", () => {
  it("the terminal rung stays partial with the coarse no_os_isolation token", () => {
    const selection = selectSandboxDetailed({ env: {}, config: config(), probe: NO_BWRAP });
    expect(selection.provider).toBe("userspace");
    expect(selection.degraded).toBe(true);
    expect(selection.reason).toBe("injected: no bwrap");
    expect(selection.enforcement).toBe(USERSPACE_SANDBOX_META.enforcement);
    expect(selection.promiseGaps).toEqual(USERSPACE_SANDBOX_META.promise_gaps);
  });
});

/** The userspace rung, reduced to what a chain test needs. */
const USERSPACE_ONLY: SandboxRunnerCandidate = {
  name: "userspace",
  usable: () => true,
  unusableReason: () => "userspace is always usable",
  select: (host) => ({
    sandbox: fakeSandbox("userspace"),
    provider: "userspace",
    degraded: true,
    reason: host.skipped[0]?.reason ?? "no OS-isolation runner in the chain was usable on this host",
    mode: host.mode,
    degradedByGrant: false,
    enforcement: "partial",
    promiseGaps: ["no_os_isolation"],
    skippedRunners: host.skipped,
  }),
};
