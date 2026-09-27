/**
 * A1 (W746) — the seam vocabulary is core's, and it stays core's.
 *
 * These are not behaviour tests (the provider's behaviour is tested against the
 * mock upstream elsewhere); they are the A1 invariants that must not rot:
 *
 *   1. the re-exported VALUES are the same objects core exports, so
 *      `instanceof LlmError` agrees across packages (the whole point of A1);
 *   2. the provider's `StreamEvent` differs from core's in exactly TWO members
 *      (`failed.kindOf`, and `done.truncated` added by W2017), asserted at the
 *      type level — if core's union gains or loses a variant, the difference
 *      must still be those two members, and the `done` widening must still be
 *      exactly the optional literal `true`;
 *   3. the request draft accepts a fully-filled core `ModelRequest`.
 */

import { describe, expect, it } from "vitest";

import {
  LlmError as CoreLlmError,
  LlmRegistry as CoreLlmRegistry,
  ROLES as CORE_ROLES,
  assistantText as coreAssistantText,
  messageToolCalls as coreMessageToolCalls,
  usageIsEmpty as coreUsageIsEmpty,
  userMessage as coreUserMessage,
  zeroUsage as coreZeroUsage,
  type LlmError as CoreLlmErrorType,
  type LlmRegistry as CoreLlmRegistryType,
  type ModelRequest,
  type StreamEvent as CoreStreamEvent,
  type Usage,
} from "@celestea/core";
import {
  LlmError,
  LlmRegistry,
  ROLES,
  assistantText,
  messageToolCalls,
  parseUsage,
  statusError,
  usageIsEmpty,
  userMessage,
  zeroUsage,
  type ModelRequestDraft,
  type StreamEvent,
} from "@celestea/llm";

/** Type-level equality (the standard invariant trick). */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

/** The provider's union is core's union with exactly two widened members. */
const DELTA_IS_THE_FAILED_AND_DONE_MEMBERS: Assert<
  Equal<
    Exclude<StreamEvent, { kind: "failed" } | { kind: "done" }>,
    Exclude<CoreStreamEvent, { kind: "failed" } | { kind: "done" }>
  >
> = true;

/**
 * W2017: the `done` widening is EXACTLY `truncated?: true` — the literal, not
 * `boolean`. `boolean` would make `truncated: false` a legal event, i.e. a new
 * key on every ordinary turn; this assertion is what keeps "absent means not
 * truncated" a fact rather than a convention.
 */
type ProviderDone = Extract<StreamEvent, { kind: "done" }>;
// Optional AND literal-true: indexing the field yields `true | undefined`
// (present but never required), and Required<> pins the payload to `true`.
const DONE_WIDENING_IS_TRUNCATED_TRUE: Assert<Equal<ProviderDone["truncated"], true | undefined>> = true;
const DONE_TRUNCATED_IS_NOT_BOOLEAN: Assert<Equal<Required<ProviderDone>["truncated"], true>> = true;

/** ...and it adds NOTHING else: same keys minus `truncated`, same message type. */
const DONE_ADDS_ONLY_TRUNCATED: Assert<Equal<keyof ProviderDone, "kind" | "message" | "truncated">> = true;
const DONE_MESSAGE_IS_CORES: Assert<
  Equal<ProviderDone["message"], Extract<CoreStreamEvent, { kind: "done" }>["message"]>
> = true;

/** A fully-filled core request is a legal provider request (no adapter needed). */
const ENGINE_REQUEST_IS_A_DRAFT: Assert<Equal<ModelRequest extends ModelRequestDraft ? true : false, true>> = true;

describe("A1 · @celestea/llm re-exports core's seam instead of redeclaring it", () => {
  it("re-exports the same class object, so instanceof agrees across packages", () => {
    expect(LlmError).toBe(CoreLlmError);
    // Built here, recognised there — and the other way round.
    const mine: CoreLlmErrorType = statusError(500, "Internal Server Error", "boom");
    expect(mine).toBeInstanceOf(CoreLlmError);
    expect(mine).toBeInstanceOf(LlmError);
    const theirs = new CoreLlmError("from core");
    expect(theirs).toBeInstanceOf(LlmError);
  });

  it("re-exports the same message/usage helpers (identity, not a copy)", () => {
    expect(ROLES).toBe(CORE_ROLES);
    expect(userMessage).toBe(coreUserMessage);
    expect(assistantText).toBe(coreAssistantText);
    expect(messageToolCalls).toBe(coreMessageToolCalls);
    expect(zeroUsage).toBe(coreZeroUsage);
    expect(usageIsEmpty).toBe(coreUsageIsEmpty);
    expect(userMessage("hi")).toEqual(coreUserMessage("hi"));
  });

  it("re-exports core's LlmRegistry (one registry implementation, not two)", () => {
    // Identity, not "an instance of itself": `new LlmRegistry()` is trivially an
    // LlmRegistry, so the old `toBeInstanceOf` could never fail. The invariant is
    // that the re-exported VALUE is core's own class object.
    expect(LlmRegistry).toBe(CoreLlmRegistry);
    const asCore: CoreLlmRegistryType = new LlmRegistry();
    expect(asCore.list()).toEqual([]);
  });

  it("parses provider usage frames into core's Usage shape", () => {
    const usage: Usage | undefined = parseUsage({
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, prompt_cache_hit_tokens: 1 },
    });
    expect(usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
      cache_read: 1,
      reasoning_tokens: 0,
    });
  });

});

// The two guards are TYPE-LEVEL: `Assert<T extends true>` makes each
// declaration itself the assertion, so a mismatched union/request fails the
// build. Their old runtime companions — e.g.
// `expect(DELTA_IS_ONLY_THE_FAILED_MEMBER).toBe(true)` — were tautologies (the
// constant's type IS `true`) and have been removed. The `void` reads keep the
// declarations "used" (the root tsconfig does not enable noUnusedLocals).
void DELTA_IS_THE_FAILED_AND_DONE_MEMBERS;
void DONE_WIDENING_IS_TRUNCATED_TRUE;
void DONE_TRUNCATED_IS_NOT_BOOLEAN;
void DONE_ADDS_ONLY_TRUNCATED;
void DONE_MESSAGE_IS_CORES;
void ENGINE_REQUEST_IS_A_DRAFT;
