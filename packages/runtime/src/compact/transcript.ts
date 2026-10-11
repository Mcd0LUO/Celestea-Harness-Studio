/**
 * Summary-input rendering + the compaction prompt
 * (port of `celestea_studio/src/compact.rs:34-54,180-262`; W2011/B5).
 *
 * The transcript handed to the summarising model is a flat, human-readable
 * rendering of the event stream (turn headings + per-role lines), clipped twice:
 * per event (so one huge tool result cannot eat the budget) and as a whole,
 * keeping the TAIL (recent history matters more than the opening pleasantries).
 *
 * All clipping is CHARACTER-wise, never byte-wise: a CJK transcript would
 * otherwise be cut mid-code-point and the summary request would be invalid UTF-8.
 */

import { serdeJsonString, type ImageRef, type SessionEvent } from "@celestea/core";

/** Per-event clip inside the transcript (tool results / texts). */
export const TRANSCRIPT_EVENT_MAX_CHARS = 4_000;
/** Whole-transcript clip (~60k chars) before it is sent to the model. */
export const SUMMARY_INPUT_MAX_CHARS = 60_000;
/** How much summary text is kept in the synthetic head turn. */
export const SUMMARY_KEEP_MAX_CHARS = 20_000;
/** `max_tokens` of the summarising request. */
export const SUMMARY_MAX_TOKENS = 4_096;
/** Whole-request timeout of the summarising call. */
export const SUMMARY_TIMEOUT_MS = 90_000;

/**
 * The structured summary prompt.
 *
 * W2011 (B5): the section list is a MINIMUM ("至少"), not "必须且只需四个小节",
 * and section 5 is "what is still UNVERIFIED / unknown". The retrospective
 * (`docs/failure-modes.md` §1.5, "叙事会漂，diff 不会") names exactly
 * this failure mode: a claim that a step was done, repeated onward without ever
 * being checked. A summary is a retelling of a retelling, so it must be allowed
 * to say "this was never verified" instead of restating it as a fact. Kimi Code
 * does the same in its own compaction instruction (the "still unverified"
 * section and the drift-avoidance rules around it).
 *
 * ★ Section 5 is placed FIRST among the sections, not last, and that is load
 * bearing: [clip] keeps the HEAD of a string, and `plan.ts` runs the summary
 * through `clip(summary, SUMMARY_KEEP_MAX_CHARS)`. A trailing section is
 * therefore the first thing a long summary loses — the section this whole change
 * exists for would be the one that disappears.
 */
export const COMPACT_SYSTEM_PROMPT =
  "你是上下文压缩器。把用户提供的会话记录压缩成一份中文结构化摘要，" +
  "至少包含以下五个小节（保留小节标题；顺序不限，但每节都必须出现）：\n" +
  "1) 仍未验证 / 未知：哪些结论只是「声称完成」而从未被验证（没跑过测试、没看 diff、没复现过），" +
  "哪些问题仍然没有答案。**凡早先某步声称做完但从未验证的，必须明说它是未验证，不得写成事实。**\n" +
  "2) 正在进行的任务：当前目标、所处阶段、尚未完成的部分。\n" +
  "3) 已做的决策：已经确定的技术/方案选择及其理由，包括被否决的方案。\n" +
  "4) 关键事实与文件改动：涉及的文件路径、函数/接口名、配置项、数据结论、报错信息等可复用的硬事实。\n" +
  "5) 待办：接下来要做的事，按优先级排列。\n" +
  "要求：忠于原始记录，不得编造；保留路径、标识符、数字、命令原样；压缩冗余寒暄与重复内容；直接输出摘要正文，不要任何前言、结语或解释。";

/** Character-wise clip with a truncation marker (`clip`). */
export function clip(s: string, max: number): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  return `${chars.slice(0, max).join("")}…（截断）`;
}

/** Keep the TAIL of a text, with a leading marker when it was cut (`clip_tail`). */
export function clipTail(s: string, max: number): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  return `（更早内容已截断，仅保留最近 ${max} 字符）\n${chars.slice(chars.length - max).join("")}`;
}

/** One event's transcript line (`render_transcript`'s match arms). */
export function transcriptLine(ev: SessionEvent): string {
  const quarter = TRANSCRIPT_EVENT_MAX_CHARS / 4;
  switch (ev.type) {
    case "turn_start":
      return `\n--- 轮次 ${ev.id} ---\n`;
    case "turn_end":
      return "";
    case "user_message":
      // W804: attachments enter the summary as placeholders, NEVER as bytes.
      return `【用户】${clip(ev.text, TRANSCRIPT_EVENT_MAX_CHARS)}${attachmentNote(ev.attachments)}\n`;
    case "assistant_message":
      return `【助手】${clip(ev.text, TRANSCRIPT_EVENT_MAX_CHARS)}\n`;
    case "thinking_delta":
      return `【思考】${clip(ev.text, quarter)}\n`;
    case "tool_call":
      return `【工具调用】${ev.name}(${clip(serdeJsonString(ev.args ?? null), quarter)})\n`;
    case "tool_result":
      return ev.error === null
        ? `【工具结果】${clip(serdeJsonString(ev.value ?? null), quarter)}\n`
        : `【工具结果】错误：${clip(ev.error, quarter)}\n`;
    // W783: a question and its answer are host-side audit rows about a PAUSED
    // turn. The transcript already carries what the model saw — the ordinary
    // `tool_result` of `ask_user_question` — so projecting them too would
    // summarise the same decision twice.
    case "user_question":
    case "user_answer":
      return "";
    // computer-use M2-B2b: the desktop gate's audit rows. Same rule as the
    // question rows — the transcript already carries the gated tool call and its
    // verdict, so a summary line here would describe the same decision twice.
    // Returning "" (not a note) keeps the summary prompt byte-identical to a log
    // that never had a confirmation in it.
    case "desktop_confirm":
    case "desktop_confirm_answer":
      return "";
    // W2018 (B1): markers are not transcript content. Returning "" (not a note)
    // keeps the summary prompt for a given log byte-identical whether or not an
    // earlier interrupted compaction left a marker behind.
    case "compaction_start":
    case "compaction_end":
      return "";
  }
}


/** W804: a byte-free placeholder for each attachment (summary input only). */
export function attachmentNote(refs: readonly ImageRef[] | undefined): string {
  if (refs === undefined || refs.length === 0) return "";
  return refs.map((ref) => `【图：${ref.media_type} ${ref.width}x${ref.height}】`).join("");
}
/** The whole summary input: every event line, then one tail clip. */
export function renderTranscript(events: readonly SessionEvent[], max = SUMMARY_INPUT_MAX_CHARS): string {
  let out = "";
  for (const ev of events) out += transcriptLine(ev);
  return clipTail(out, max);
}
