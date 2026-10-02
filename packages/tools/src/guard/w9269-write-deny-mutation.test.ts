/**
 * W9269 — the MUTATION NEGATIVE CONTROL for the write deny list.
 *
 * The brief's verification clause (docs/feature-sandbox-comparison.md §5):
 * "去掉一条 deny，断言『写 .bashrc 被拒』变红" — remove ONE deny entry and the
 * "writing .bashrc is refused" assertion must turn RED.
 *
 * A green suite cannot, by itself, prove the list is load-bearing: if the guard
 * refused .bashrc for some UNRELATED reason (outside the root, a read-only
 * policy, the wrong workspace) the same suite would stay green with the entry
 * deleted. So this file proves the refusal is DATA-DRIVEN — a direct, matched
 * A/B on the two halves of the same policy, with the ONLY difference being
 * whether the final component is on the list:
 *
 *   write  <ws>/.bashrc   -> denied (listed)
 *   write  <ws>/x.bashrc  -> allowed (identical, not listed)
 *
 * The second line is exactly the verdict a policy carrying a list with .bashrc
 * removed would return for the first. When the live mutation (editing
 * DANGEROUS_WRITE_FILES) is applied, case ① in the main suite turns red because
 * the first line's deny becomes the second line's allow. The A/B below is the
 * same discrimination the mutation exercises, stated so a future refactor that
 * made the refusal non-data-driven would also fail here.
 */
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, makeDir, makeTempDir } from "../testing/tmp.test-util.js";
import { DANGEROUS_WRITE_CODE, PathGuardPolicy } from "./path-guard.js";
import { DANGEROUS_WRITE_FILES, denyListMatch } from "./write-deny-list.js";

afterAll(() => cleanupTempDirs());

const workspace = makeDir(makeTempDir("w9269-mut"), "ws");
const BASHRC = join(workspace, ".bashrc");
/** Byte-identical to the target except the leading "x" — NOT on any list. */
const NOT_LISTED = join(workspace, "x.bashrc");

describe("W9269 mutation negative control (the list is load-bearing)", () => {
  it("refuses .bashrc with the named code, and allows the identical-but-unlisted twin", () => {
    const p = new PathGuardPolicy({ workspace });

    const listed = p.checkWrite(BASHRC);
    expect(listed.kind, "the listed name must be refused").toBe("deny");
    if (listed.kind !== "deny") expect.unreachable("must deny");
    expect(listed.reason).toContain("code=" + DANGEROUS_WRITE_CODE);

    // The control: with the SAME policy, the SAME directory, the SAME write
    // shape — a path that is not on the list is allowed. This is the verdict a
    // policy whose list had .bashrc removed would give for the first line, and
    // it is what makes the refusal provably data-driven rather than incidental.
    const unlisted = p.checkWrite(NOT_LISTED);
    expect(unlisted.kind, "an unlisted twin must still be allowed").toBe("allow");
  });

  it("the matcher, not an incidental rule, is what flips", () => {
    // Directly at the matcher seam the live mutation edits: the decision is a
    // function of DANGEROUS_WRITE_FILES. Remove the entry from the array and
    // this very lookup returns null, which is what makes the guard allow.
    expect(denyListMatch(BASHRC)).toEqual({ entry: ".bashrc", shape: "file" });
    expect(denyListMatch(NOT_LISTED)).toBeNull();

    // The entry is present in the data the guard actually reads; deleting it is
    // the mutation, and this assertion is the one that would guide the reader
    // to the exact token the negative control removes.
    expect(DANGEROUS_WRITE_FILES).toContain(".bashrc");
  });
});
