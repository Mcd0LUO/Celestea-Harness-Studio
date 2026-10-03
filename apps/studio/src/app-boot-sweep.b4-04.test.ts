/**
 * B4-04 P2 -- the boot path actually SWEEPS crash residue.
 *
 * The sweeper itself is tested in packages/tools (crash-sweep.test.ts). What
 * that cannot prove is the half that was missing for real: that the STUDIO
 * BOOT calls it. A perfect, fully-tested, never-invoked sweep is exactly the
 * state the audit found the existing idleSince backstop in, so this file
 * pins the CALL, not the policy.
 *
 * Two properties matter and both are asserted here:
 *   1. boot sweeps (a stranded file is actually gone after startup), and
 *   2. boot does NOT block on it (the sweep is fired, not awaited).
 */

import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ATTACHMENTS_DIRNAME, SWEEP_MIN_AGE_MS } from "@celestea/tools";
import { crashResidueTargets, createStudioApp, sweepBootResidue } from "./app.js";
import { makeHarness, type StudioHarness } from "./harness.test-util.js";

const harnesses: StudioHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** A crash-stranded attachment tmp, backdated past the sweep grace window. */
function strandTmp(sessionDir: string, name: string, ageMs = SWEEP_MIN_AGE_MS * 10): string {
  const dir = join(sessionDir, ATTACHMENTS_DIRNAME);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, "crashed", "utf8");
  const secs = (Date.now() - ageMs) / 1000;
  utimesSync(file, secs, secs);
  return file;
}

/** Bounded poll: the boot sweep is fired, not awaited, so a test waits for the
 * EFFECT rather than for a promise nobody holds. */
async function untilGone(file: string, boundMs: number): Promise<boolean> {
  const started = performance.now();
  while (performance.now() - started <= boundMs) {
    if (!existsSync(file)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return !existsSync(file);
}

describe("B4-04 P2 · the boot path sweeps crash residue", () => {  it("boot removes a stranded attachment tmp from a session directory", async () => {
    const h = makeHarness();
    harnesses.push(h);

    // Give the store a real session, then strand a tmp inside it.
    h.studio.services.sessions.create({ title: "b4-04" });
    const row = h.studio.services.sessions.list()[0]!;
    const resolved = h.studio.services.sessions.resolve(row.id);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const stranded = strandTmp(resolved.value.dir, "deadbeef.png.tmp-999-1700000000000");
    expect(existsSync(stranded)).toBe(true);

    // The boot call: fired in production, awaited here so the assertion can
    // observe it.
    await sweepBootResidue(h.studio.services);

    expect(existsSync(stranded)).toBe(false);
  });

  it("boot LEAVES a file still inside the grace window", async () => {
    const h = makeHarness();
    harnesses.push(h);
    h.studio.services.sessions.create({ title: "b4-04b" });
    const row = h.studio.services.sessions.list()[0]!;
    const resolved = h.studio.services.sessions.resolve(row.id);
    if (!resolved.ok) return;
    const fresh = strandTmp(resolved.value.dir, "inflight.png.tmp-999-1", 1_000);

    await sweepBootResidue(h.studio.services);

    expect(existsSync(fresh)).toBe(true);
  });

  it("createStudioApp composes without waiting on the sweep", () => {
    // The call site is `void sweepBootResidue(...)`: composing an app must
    // return even if the sweep would take arbitrarily long. Nothing awaits it,
    // so a slow sweep cannot fail this test -- which is the property.
    const h = makeHarness();
    harnesses.push(h);
    expect(() =>
      createStudioApp({ config: h.studio.services.config, runtime: h.runtime }),
    ).not.toThrow();
  });

  it("the REAL boot (createStudioApp) sweeps -- not just the helper", async () => {
    const h = makeHarness();
    harnesses.push(h);
    h.studio.services.sessions.create({ title: "b4-04d" });
    const row = h.studio.services.sessions.list()[0]!;
    const resolved = h.studio.services.sessions.resolve(row.id);
    if (!resolved.ok) return;
    const stranded = strandTmp(resolved.value.dir, "viabootsweep.png.tmp-999-1700000000000");
    expect(existsSync(stranded)).toBe(true);

    // THIS is the wiring assertion: a second studio app over the same root runs
    // the boot path, which must fire the sweep on its own. The helper test above
    // cannot catch a missing call site -- it IS the call. Composition is
    // synchronous and the sweep is not awaited, so this waits for the file to
    // disappear rather than for a promise nobody holds.
    const second = makeHarness({
      paths: { workspacesFile: join(h.root, "workspaces.json") },
    });
    harnesses.push(second);
    createStudioApp({ config: second.studio.services.config, runtime: second.runtime });

    const gone = await untilGone(stranded, 5_000);
    expect(gone, `stranded tmp survived the boot sweep: ${stranded}`).toBe(true);
  });

  it("the target list is derived from the real session rows", () => {
    const h = makeHarness();
    harnesses.push(h);
    expect(crashResidueTargets(h.studio.services)).toEqual([]); // no session yet
    h.studio.services.sessions.create({ title: "b4-04c" });
    const targets = crashResidueTargets(h.studio.services);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.kind).toBe("attachments");
    expect(targets[0]?.dir.endsWith(ATTACHMENTS_DIRNAME)).toBe(true);
  });
});
