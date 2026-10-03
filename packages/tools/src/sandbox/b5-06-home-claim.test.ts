/**
 * B5-06 · the `config.ts` header must not promise more than the code delivers.
 *
 * The old header read "deliberately never `HOME`: `~/.ssh`, `~/.aws`, `~/.gnupg`
 * must not ride along". The first half was TRUE; the second was FALSE, and it was
 * the false half that mattered — a reader who trusts it concludes the credential
 * directories are protected on the userspace path, and they are not.
 *
 * Measured on this host (Windows, gitbash): `HOME` is genuinely absent from
 * BOTH allowlists and from what `sanitizedEnv` hands the child, yet
 * `$HOME` still prints `/c/Users/lenovo` inside it (the shell synthesises it), and
 * `ls -d ~` resolves to the real home regardless. So the lever for credential
 * directories is the SANDBOX PROVIDER (bwrap masks), never this list.
 *
 * These assertions pin the two things a future edit could quietly break:
 *   1. the behavioural truth (`HOME` really is not passed) — so the comment that
 *      now claims it stays honest if the code is ever changed;
 *   2. the header does not re-acquire the FALSE claim it was corrected for.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ENV_ALLOWLIST, ENV_ALLOWLIST_WIN32, sanitizedEnv, buildSandboxConfig } from "./config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const header = readFileSync(join(HERE, "config.ts"), "utf8").slice(0, 4000);

describe("B5-06 · the HOME claim, both halves", () => {
  it("HOME really is NOT in either allowlist (the TRUE half, still true)", () => {
    expect(ENV_ALLOWLIST).not.toContain("HOME");
    expect(ENV_ALLOWLIST_WIN32).not.toContain("HOME");
  });

  it("sanitizedEnv really does not hand HOME to the child (measured, not assumed)", () => {
    // The exact env a host would receive, for BOTH platforms. This is the
    // behavioural fact the corrected comment rests on; if a future edit adds
    // HOME to the allowlist, this goes red BEFORE the comment starts lying again.
    for (const platform of ["linux", "win32"]) {
      const out = sanitizedEnv(buildSandboxConfig({ platform }), {
        HOME: "/root",
        PATH: "p",
        USERPROFILE: "C:\\Users\\x",
      } as NodeJS.ProcessEnv, platform);
      expect(Object.keys(out), platform).not.toContain("HOME");
    }
  });

  it("the header never ASSERTS credential-directory protection — only refutes it", () => {
    /**
     * A STRUCTURAL check, deliberately not a literal one.
     *
     * This case has failed twice, each time for an instructive reason, and both
     * failures are recorded below because they are the actual design constraints:
     *
     *   1. The first version banned the phrase "must not ride along". It went RED
     *      on an ALREADY-CORRECT header, because the header quoted the sentence
     *      it was correcting. A literal ban cannot tell asserting from refuting.
     *   2. The second version looked for the credential-directory literals
     *      (`~/.ssh` etc.) and required a refutation marker on the same line. It
     *      went GREEN-but-VACUOUS: after the quotes were paraphrased, ZERO lines
     *      matched the pattern, so the loop asserted nothing and two mutants
     *      survived. A filter that matches nothing is worse than no filter.
     *
     * So the check is on the CLAIM, wherever it is phrased: this file may talk
     * about credential directories ONLY inside a block that also carries the
     * refutation, and the refutation must be present at all. That survives both
     * paraphrasing of the quote and its re-introduction.
     */
    const body = header;

    // (a) The refutation must exist. Without it there is nothing to qualify.
    expect(body, "the refutation prose must be present").toMatch(/FALSE as/);
    expect(body).toMatch(/no mount boundary/i);
    expect(body).toMatch(/synthesise|synthesizes/);

    // (b) A claim is a sentence that says credential directories are kept out /
    //     protected / excluded — in ANY wording. Each occurrence must sit in a
    //     paragraph that also carries the refutation marker.
    const CLAIM = /(credential director|~\/\.ssh|~\/\.aws|~\/\.gnupg|\.ssh|\.gnupg)/i;
    const REFUTES = /FALSE|out of scope|not the allowlist|no mount boundary|B5-06|did not|never a confidentiality boundary/i;
    const paragraphs = body.split(/\n\s*\*\s*\n/); // split on blank comment lines
    for (const para of paragraphs) {
      if (!CLAIM.test(para)) continue;
      expect(REFUTES.test(para), `an unqualified claim survived:\n${para}`).toBe(true);
    }

    // (c) Sanity: the paragraphs really do contain the subject, so (b) is not
    //     vacuous again — this is the guard the second version was missing.
    expect(CLAIM.test(body), "the header must still discuss the subject").toBe(true);
  });
});
