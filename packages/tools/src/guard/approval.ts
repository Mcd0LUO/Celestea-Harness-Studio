/**
 * W-C1b · the MCP APPROVAL guard (docs/feature/mcp-client.md §7.1, decision D6).
 *
 * ## Why a guard and not a permission service
 *
 * `ToolRegistryImpl.runGuards` already `await`s every `guard.check(input)`
 * (`registry.ts`), so "wait for a human, then decide" is a NORMAL guard — the
 * registry's four-stage pipeline, its first-non-Allow short circuit and its
 * `ToolOutput.decision` field stay byte-for-byte what they were. The other half
 * of the design reuses the answerer channel that already exists and is already
 * per session generation: `UserQuestionService.ask()` parks a promise,
 * `POST /api/questions/{id}/answer` wakes it, the wait has a ceiling, and a
 * timeout returns an EMPTY answer set instead of deciding for anyone. That is
 * exactly an approval's shape, so P0 adds no endpoint, no SSE event and no
 * second permission surface.
 *
 * ## The fail-closed exits are ONE decision kind
 *
 * `ask` is a TERMINAL failure in this registry (`dispatch` turns a non-allow
 * decision into `ask: <reason>` and never calls the tool), so "undecided" is
 * expressible and never means "allowed":
 *   - no answerer mounted (`questions: null`),
 *   - the channel refused to ask (`NO_PROVIDER` / `DELEGATED_CALLER` /
 *     `CALLER_NOT_LIVE` / `ASK_ABORTED`),
 *   - nobody answered, or the wait expired (`answers: []`).
 *
 * A14's timeout case therefore reads differently from a human pressing deny: a
 * timed-out approval is `ask: … timed out; the call was NOT executed`
 * (UNDECIDED) while deny is `denied: …` (DECIDED). Collapsing the two would
 * tell the model a decision was reached that nobody reached.
 *
 * ## ORDER IS SEMANTICS (the mutation control for this file)
 *
 * Guards run in REGISTRATION order and the first non-Allow short-circuits
 * (`registry.ts`: "guards run in the given order"). This guard is therefore
 * mounted AFTER `PathGuard`: deterministic path arbitration should refuse a
 * call BEFORE a human is asked to spend attention on it. The reverse order
 * produces the worst possible UX — "waited 30 s, clicked allow, then PathGuard
 * refused" — and spends a question on a call that was never going to run.
 * `approval.test.ts` pins that order against a real `assembleTools` chain and
 * carries a mutation control that swaps the two mounts.
 *
 * ## Scope: MCP NAMES ONLY
 *
 * Any other tool is `allow`ed without touching the channel. A guard that can
 * only ever allow is chain noise, and approval is a per-MCP-config decision
 * (`mcp.json`'s `approval`, §4.1) — gating a BUILT-IN tool is
 * `toolDeny` / the permission baseline, already on this chain.
 */

import type { AskUserQuestionItem, AskUserQuestionOutcome, ToolDecision, ToolGuard, ToolInput, UserQuestionService } from "@celestea/core";
import { askTimeoutMs } from "@celestea/core";

import { GUARD_ERROR_PREFIX, contractError } from "../errors.js";

const ALLOW: ToolDecision = { kind: "allow" };

/**
 * The model-visible namespace reserved for the MCP client
 * (`docs/feature/mcp-client.md` §5.1). Declared HERE rather than imported from
 * `@celestea/mcp` because an L1 -> L1 import is forbidden
 * (ARCHITECTURE.md §1.4). `tests/mcp-approval-guard.test.ts` pins the two
 * literals together so the two packages cannot drift.
 */
export const MCP_TOOL_PREFIX = "mcp__";

/** The two verdicts `mcp.json` can declare (`approval`, §4.1). */
export type McpApprovalPolicy = "ask" | "never";

/** One model-visible tool's approval declaration. */
export interface McpApprovalRule {
  readonly approval: McpApprovalPolicy;
  /** MCP provenance for the approval card; absent = name-only identification. */
  readonly server?: string;
  readonly tool?: string;
}

/** Stable option labels — P0 reuses the generic question card (§8). */
export const APPROVAL_LABEL_DENY = "deny";
export const APPROVAL_LABEL_ALLOW_ONCE = "allow once";
export const APPROVAL_LABEL_ALWAYS = "allow for this session";

/** Stable reason codes carried inside the `toolguard:` envelope. */
export const APPROVAL_DENIED_CODE = "mcp_approval_denied";
export const APPROVAL_UNDECIDED_CODE = "mcp_approval_undecided";

/** The channel's answer, or the reason it refused to produce one. */
type Answered = { readonly kind: "answered"; readonly outcome: AskUserQuestionOutcome } | { readonly kind: "refused"; readonly reason: string };

export interface ApprovalGuardOptions {
  /**
   * The answerer channel, by CONSTRUCTION (the tools package never sees a
   * `Context`). `null` = this assembly has no human answerer at all — the
   * fail-closed case, not a degraded one.
   */
  readonly questions: UserQuestionService | null;
  /** Per model-visible tool name. A name ABSENT here defaults to `ask`. */
  readonly rules: ReadonlyMap<string, McpApprovalRule>;
  /** Maximum wait for the human (clamped by core's `askTimeoutMs`). */
  readonly timeoutMs?: number;
}

export class McpApprovalGuard implements ToolGuard {
  private readonly questions: UserQuestionService | null;
  private readonly rules: ReadonlyMap<string, McpApprovalRule>;
  private readonly timeoutMs: number | undefined;
  /**
   * Names the human allowed FOR THIS SESSION. One guard instance lives exactly
   * as long as one composed generation (§6.1 / D7), so this set IS the session —
   * and it is deliberately NOT persisted: a re-assembled generation asks again.
   */
  private readonly allowedForSession = new Set<string>();

  constructor(options: ApprovalGuardOptions) {
    this.questions = options.questions;
    this.rules = options.rules;
    this.timeoutMs = options.timeoutMs;
  }

  async check(input: ToolInput): Promise<ToolDecision> {
    if (!input.name.startsWith(MCP_TOOL_PREFIX)) return ALLOW;
    if (this.allowedForSession.has(input.name)) return ALLOW;
    const rule = this.rules.get(input.name);
    // `never` is the EXPLICIT unattended exit (§4.1): configuration is trust.
    // An unknown mcp__ name is not covered by that sentence, so it stays `ask`.
    if (rule?.approval === "never") return ALLOW;
    if (this.questions === null) return undecided(`no answerer is mounted, so '${input.name}' cannot be approved`);
    return this.verdictOf(input.name, await this.ask(input, rule));
  }

  /** One question through the EXISTING channel; a refusal is fail-closed. */
  private async ask(input: ToolInput, rule: McpApprovalRule | undefined): Promise<Answered> {
    const channel = this.questions;
    if (channel === null) return { kind: "refused", reason: "no answerer is mounted" };
    try {
      return { kind: "answered", outcome: await channel.ask({
        questions: [approvalQuestion(input.name, rule)],
        timeoutMs: askTimeoutMs(this.timeoutMs),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }) };
    } catch (error) {
      // DELEGATED_CALLER / CALLER_NOT_LIVE / NO_PROVIDER / ASK_ABORTED all land
      // here and all mean the same thing: nobody decided. The taxonomy is read
      // for the REASON TEXT only — the decision never branches on it (§6.3's
      // "never route on wording" applied to our own code as well).
      return { kind: "refused", reason: channelReason(error) };
    }
  }

  /** The answer -> decision mapping, in one place (A14 vs A15 must not blur). */
  private verdictOf(name: string, answered: Answered): ToolDecision {
    if (answered.kind === "refused") return undecided(`'${name}' was never put to a human: ${answered.reason}`);
    const selected = answered.outcome.answers.flatMap((answer) => answer.selected);
    if (selected.length === 0) return undecided(`'${name}' timed out with no answer; the call was NOT executed and nobody decided`);
    if (selected.includes(APPROVAL_LABEL_DENY)) {
      return { kind: "deny", reason: contractError(GUARD_ERROR_PREFIX, APPROVAL_DENIED_CODE, `'${name}' was denied by the approver`) };
    }
    if (selected.includes(APPROVAL_LABEL_ALWAYS)) this.allowedForSession.add(name);
    return ALLOW;
  }
}

/** The approval card: `deny` is listed FIRST — it is the safe default read. */
function approvalQuestion(name: string, rule: McpApprovalRule | undefined): AskUserQuestionItem {
  const server = rule?.server ?? "unknown server";
  const tool = rule?.tool ?? name;
  return {
    id: "mcp-approval",
    header: `mcp:${server}`,
    question: `Run the MCP tool '${tool}' on server '${server}'?`,
    detail: `The model asked to run '${name}'. Deny / allow once / allow for the rest of this session.`,
    options: [
      { label: APPROVAL_LABEL_DENY, description: "refuse this call" },
      { label: APPROVAL_LABEL_ALLOW_ONCE, description: "run this call and nothing else" },
      { label: APPROVAL_LABEL_ALWAYS, description: "run every call of this tool for the rest of this session" },
    ],
  };
}

/** Undecided = the terminal `ask` decision; the tool never runs. */
function undecided(message: string): ToolDecision {
  return { kind: "ask", reason: contractError(GUARD_ERROR_PREFIX, APPROVAL_UNDECIDED_CODE, message) };
}

/** The channel's own code, for the REASON text only (never a branch). */
function channelReason(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : error instanceof Error ? error.message : String(error);
}
