/**
 * EX-03 —— §4 会话显式的工具面探测（原 verify-contracts.ts 里的 probeToolFaces）。
 *
 * 纯搬家：判定分支、降级文案一字未改。
 *
 * W9265 补充一处**有意的**改动：execution 面的期望条数与折出名单改为从真源
 * `EXECUTION_TOOL_NAMES` 派生（原先是写死的 10 与 6 个名字的数组字面量）。
 * 这不是顺手加功能，是把「会静默过期」的字面量换成派生值——见下方注释。
 */
import { EXECUTION_TOOL_NAMES } from "@celestea/tools";
import { probe } from "../lib/http.js";
import { degraded, fail, pass } from "./checks.js";
import { STUDIO, TIMEOUT } from "./runtime.js";

/**
 * Section 4 -- session-explicit tool faces (W803 probe follow-up).
 *
 * A bare GET /api/tools answers for the FOCUSED/active session, whose mode can
 * drift (an execution session folds the face down to the keep list), while
 * contracts/tools.json is the full registry. So name the session explicitly, one
 * probe per face:
 *   - mode=standard  -> MUST equal the full registry exactly (every name);
 *   - mode=execution -> MUST be the documented fold: exactly the keep list, a
 *     subset of the registry, folding out every tool outside EXECUTION_TOOL_NAMES:
 *     the four SDK bridge tools + ask_user_question + (W804) read_image (W884
 *     keeps load_skill; F4 keeps browser_open/browser_act).
 *     (contracts/endpoints.json#get_tools, W791 P1; W804 added read_image).
 *
 * W9265: the two counts this file used to PIN in prose (a literal 10, and a
 * "the full registry (16)" note) are both derived from their source of truth
 * instead — the expected size now reads EXECUTION_FACE_SIZE (the keep list), and
 * the standard face already counted what it actually saw. Same discipline
 * tests/contracts.test.ts:544 enforces for the get_tools contract note, and for
 * the same reason: a number written in prose goes stale silently, and correcting
 * the note then turns the gate red instead of green.
 */
export async function probeToolFaces(
  sessions: Array<{ id: string; mode?: string }>,
  contractNames: string[],
): Promise<void> {
  const standardSession = sessions.find((s) => s.mode === "standard");
  const executionSession = sessions.find((s) => s.mode === "execution");
  const contractSet = new Set(contractNames);
  // W9265: the execution face IS EXECUTION_TOOL_NAMES — the very list the engine
  // folds by (packages/tools/src/exposure.ts#executionExposure). Deriving the
  // expected size from it means adding a keep-list entry moves the expectation
  // with it; the old hardcoded 10 would have silently rotted into a false FAIL.
  // W804: read_image is mounted (the session has an attachment store) but is NOT
  // in EXECUTION_TOOL_NAMES, so execution mode folds it out too — which is why
  // it shows up on the FOLDED side, not in the keep list.
  const EXECUTION_FACE_SIZE = EXECUTION_TOOL_NAMES.length;
  const EXPECTED_FOLDED = contractNames.filter((n) => !EXECUTION_TOOL_NAMES.includes(n)).sort();

  async function toolNamesFor(sessionId: string): Promise<{ names: string[]; status: number }> {
    const res = await probe(STUDIO, "/api/tools?session=" + encodeURIComponent(sessionId), { timeoutMs: TIMEOUT });
    const names = (((res.json as { tools?: Array<{ name: string }> }).tools) ?? []).map((t) => t.name).sort();
    return { names, status: res.status };
  }
  function sameNames(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((n, i) => n === b[i]);
  }
  const STANDARD_LABEL = "GET /api/tools?session=...(standard)";
  const EXECUTION_LABEL = "GET /api/tools?session=...(execution)";

  if (standardSession !== undefined) {
    const r = await toolNamesFor(standardSession.id);
    if (sameNames(r.names, contractNames)) {
      pass(STANDARD_LABEL, "tool-set", "session=" + standardSession.id + " (mode=standard); " + r.names.length + " names match contracts/tools.json exactly (full registry)", r.status);
    } else {
      fail(STANDARD_LABEL, "tool-set", "session=" + standardSession.id + " (mode=standard); live=[" + r.names.join(",") + "] contract=[" + contractNames.join(",") + "]", r.status);
    }
  } else {
    // No standard session: the primary equality assertion cannot run. Degrade
    // EXPLICITLY and recordably -- assert the weaker contract-superset-live
    // invariant, mark the check degraded (never a silent pass) and exit 2. A
    // live name outside the contract is still a hard fail.
    const fallback = sessions.find((s) => s.mode !== "execution");
    if (fallback === undefined) {
      degraded(STANDARD_LABEL, "tool-set", "DEGRADED: /api/sessions lists " + sessions.length + " session(s), none with mode=standard; the full-registry equality could not be asserted at all");
    } else {
      const r = await toolNamesFor(fallback.id);
      const outside = r.names.filter((n) => !contractSet.has(n));
      if (outside.length === 0) {
        degraded(STANDARD_LABEL, "tool-set", "DEGRADED: no mode=standard session in /api/sessions (" + sessions.length + " listed); asserted the weaker invariant contract superset-of live (" + r.names.length + " live <= " + contractNames.length + " contract) via session=" + fallback.id + " mode=" + (fallback.mode ?? "unknown") + "; activate a standard session to restore exact-equality", r.status);
      } else {
        fail(STANDARD_LABEL, "tool-set", "no mode=standard session AND live reports name(s) outside the contract: [" + outside.join(",") + "]", r.status);
      }
    }
  }

  if (executionSession !== undefined) {
    const r = await toolNamesFor(executionSession.id);
    const outside = r.names.filter((n) => !contractSet.has(n));
    const folded = contractNames.filter((n) => !r.names.includes(n));
    const problems: string[] = [];
    if (r.names.length !== EXECUTION_FACE_SIZE) problems.push("expected exactly " + EXECUTION_FACE_SIZE + " names, got " + r.names.length);
    if (outside.length > 0) problems.push("name(s) outside the contract: [" + outside.join(",") + "]");
    if (!sameNames(folded, EXPECTED_FOLDED)) problems.push("folded-out=[" + folded.join(",") + "] expected=[" + EXPECTED_FOLDED.join(",") + "]");
    const base = "session=" + executionSession.id + " (mode=execution); live=[" + r.names.join(",") + "] folded-out=[" + folded.join(",") + "]";
    if (problems.length === 0) {
      pass(EXECUTION_LABEL, "tool-set", base + "; exactly " + EXECUTION_FACE_SIZE + " kept: the full registry folded out the four SDK bridge tools + ask_user_question + read_image (load_skill and the F4 browser tools stay: not in SDK_TOOLS)", r.status);
    } else {
      fail(EXECUTION_LABEL, "tool-set", base + "; " + problems.join("; "), r.status);
    }
  } else {
    degraded(EXECUTION_LABEL, "tool-set", "DEGRADED: no mode=execution session in /api/sessions (" + sessions.length + " listed); the folded face could not be probed. The bare GET /api/tools answer follows the active session's mode, which is why this probe is session-explicit");
  }
}
