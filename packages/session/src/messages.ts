/**
 * The two projections of the session log.
 *
 * 1. Studio projection (GET /api/sessions/{id}/messages) — src/api.rs:94-135.
 *    Per-event, independent, NO pairing/dropping; thinking rows are included;
 *    orphan tool_result rows are emitted; tool rows carry tool_parent_id.
 * 2. Engine `derive_messages` — the model-visible history (see ./log/derive.ts):
 *    turn markers and thinking are skipped, run_code sub-call rows
 *    (parent_id present) are skipped, consecutive tool calls merge into ONE
 *    assistant message, and unanswered calls are balanced with a synthetic
 *    cancelled result.
 *
 * Keeping both explicit is the whole point: they differ, and the difference is
 * contract.
 */

import { deriveMessagesFrom, toolSurfaceValue } from "@celestea/core";
import type { Message, SessionEvent, SessionEventOrigin, StudioMessage } from "@celestea/core";

/** W888: the human-readable label each non-user origin shows in the block. */
const ORIGIN_LABEL: Record<Exclude<SessionEventOrigin, "user">, string> = {
  skill: "技能目录",
  memory: "记忆 · 每轮注入",
  receipt: "回执",
  steering: "插话",
  compact: "压缩摘要",
  // W9346: the persistent goal's resident line / change notice. The label
  // matches the shipped i18n key the frontend already renders for `goal`
  // (apps/web/src/i18n/locales/*/chat.ts `chat.inbox.goal`).
  goal: "目标",
};

/** The label of a non-user origin ('user' never reaches here). */
export function originLabel(origin: SessionEventOrigin): string {
  return origin === "user" ? "用户" : ORIGIN_LABEL[origin];
}

/**
 * computer-use M2-B2b: the block label for a desktop confirmation audit row.
 *
 * A CONSTANT, for the same reason the confirmation card's own strings are: the
 * words must come from the code, never from the object being confirmed.
 * Nothing model-controlled is concatenated into it.
 */
const DESKTOP_CONFIRM_AUDIT_LABEL = "桌面确认";

/**
 * computer-use M2-B2b: the audit facts of one `desktop_confirm` row, as one
 * line of `key=value` pairs.
 *
 * key=value (not prose) on purpose: a projection that assembled a sentence out
 * of `app` would let a crafted window title choose where the sentence breaks.
 * The values are data; the shape around them is not.
 */
function desktopConfirmFacts(ev: Extract<SessionEvent, { type: "desktop_confirm" }>): string {
  const parts = [`method=${ev.method}`, `app=${ev.app}`];
  if (ev.title !== undefined) parts.push(`title=${ev.title}`);
  parts.push(`reason=${ev.reason}`);
  if (ev.timeout_ms !== undefined) parts.push(`budget_ms=${ev.timeout_ms}`);
  return parts.join(" ");
}

/** computer-use M2-B2b: the verdict line, paired with its asked row by `id`. */
function desktopConfirmVerdict(ev: Extract<SessionEvent, { type: "desktop_confirm_answer" }>): string {
  const parts = [`outcome=${ev.outcome}`];
  if (ev.elapsed_ms !== undefined) parts.push(`elapsed_ms=${ev.elapsed_ms}`);
  return parts.join(" ");
}

/** Studio projection of a single event; null for structural markers. */
export function sessionEventToMessage(ev: SessionEvent): StudioMessage | null {
  switch (ev.type) {
    case "turn_start":
    case "turn_end":
      return null;
    case "user_message": {
      // W888: a non-user ORIGIN projects to an inbox row (the UI's existing
      // renderInboxMessage branch). Absent/'user' keeps the exact pre-W888 bytes.
      const origin = ev.origin;
      if (origin !== undefined && origin !== "user") {
        const inbox: StudioMessage = { role: "inbox", kind: origin, content: ev.text, source: originLabel(origin) };
        if (ev.attachments !== undefined && ev.attachments.length > 0) inbox.attachments = ev.attachments;
        return inbox;
      }
      // W804 §4.2D: the Studio projection carries the attachment references (the
      // bytes stay on disk); no attachments => the pre-W804 object byte for byte.
      const out: StudioMessage = { role: "user", content: ev.text };
      if (ev.attachments !== undefined && ev.attachments.length > 0) out.attachments = ev.attachments;
      return out;
    }
    case "assistant_message":
      return { role: "assistant", content: ev.text };
    case "thinking_delta":
      return { role: "thinking", content: ev.text };
    case "tool_call": {
      const out: StudioMessage = {
        role: "tool",
        kind: "call",
        tool_call_id: ev.id,
        tool_name: ev.name,
        tool_args: ev.args,
      };
      if (ev.parent_id !== undefined) out.tool_parent_id = ev.parent_id;
      return out;
    }
    case "tool_result": {
      // W855 (B6): the log stores the ORIGINAL value; the transcript shows the
      // bounded/annotated FACE (the original can be arbitrarily large) plus the
      // descriptor so a card can badge "N bytes omitted -> locator".
      const out: StudioMessage = {
        role: "tool",
        kind: "result",
        tool_call_id: ev.id,
        tool_value: toolSurfaceValue(ev.value, ev.surface),
        tool_error: ev.error,
      };
      if (ev.parent_id !== undefined) out.tool_parent_id = ev.parent_id;
      if (ev.surface !== undefined) out.tool_surface = ev.surface;
      return out;
    }
    // W2018 (B1): the compaction markers are structural, like turn_start /
    // turn_end — they must NOT become transcript rows (a marker is not something
    // the user or the model said). Null keeps projectMessages byte-identical.
    case "compaction_start":
    case "compaction_end":
      return null;
    // W783 §7: the two host-side question rows. The Studio projection is the
    // per-event transcript surface the UI replays, so a parked question and its
    // answer stay visible there (an unanswered row is how a restart looks).
    case "user_question": {
      const out: StudioMessage = {
        role: "question",
        kind: "question",
        question_id: ev.id,
        content: ev.questions,
      };
      if (ev.expires_at !== undefined) out.question_expires_at = ev.expires_at;
      return out;
    }
    case "user_answer": {
      const out: StudioMessage = {
        role: "question",
        kind: "answer",
        question_id: ev.id,
        content: ev.answers,
      };
      if (ev.timed_out !== undefined) out.question_timed_out = ev.timed_out;
      return out;
    }
    // computer-use M2-B2b: the desktop gate's audit pair lands on the INBOX
    // channel, not the question one — and that choice is the semantics. The
    // question channel means "the MODEL asked the human something"; these rows
    // mean "the HOST stopped the model and asked on its own authority". Rendering
    // them as question cards would show the user's own gate as a model request,
    // which is the exact misreading the dedicated log tag exists to prevent.
    // `receipt` is the existing non-user origin whose UI block means "the system
    // recorded this"; the desktop confirmation IS such a record.
    case "desktop_confirm":
      return { role: "inbox", kind: "receipt", content: desktopConfirmFacts(ev), source: DESKTOP_CONFIRM_AUDIT_LABEL };
    case "desktop_confirm_answer":
      return { role: "inbox", kind: "receipt", content: desktopConfirmVerdict(ev), source: DESKTOP_CONFIRM_AUDIT_LABEL };
  }
}

/** The Studio message list for a whole log (golden-compared against HTTP). */
export function projectMessages(events: readonly SessionEvent[]): StudioMessage[] {
  const out: StudioMessage[] = [];
  for (const ev of events) {
    const m = sessionEventToMessage(ev);
    if (m !== null) out.push(m);
  }
  return out;
}

/**
 * Engine model-visible projection (`derive_messages`). Returns the engine's
 * `Message` shape (`role` / `content[]` / `tool_call_id`), not the Studio shape.
 */
export function deriveMessages(events: readonly SessionEvent[]): Message[] {
  return deriveMessagesFrom(events);
}
