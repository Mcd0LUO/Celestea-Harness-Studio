/**
 * T1b (M1④): a tool result that carries image references must reach the model
 * as ImageContent blocks ON THE SAME tool message.
 *
 * WHY THIS FILE EXISTS. The projection the computer-use screenshots depend on is
 * NOT in this package. The chain is:
 *
 *   1. a tool returns a `value` whose `attachments` is a top-level ImageRef array
 *      (browser: packages/tools/src/browser/session.ts, spread into the
 *      result 的截图分支);
 *   2. THE LOOP writes that `value` into the `tool_result` log row
 *      (packages/agent-loop/src/loop.ts) — this package's only link;
 *   3. core projects the row: `deriveMessagesFrom` → `toolResultOf`
 *      (packages/core/src/projection.ts 的 toolResultOf) reads
 *      `attachmentRefsOfValue(value)` (packages/core/src/message.ts) and
 *      builds `toolResultWithImages` (packages/core/src/message.ts);
 *   4. the loop puts the projection in front of the model
 *      (loop.ts, `buildRequest` → `seams.session.deriveMessages()`).
 *
 * The assertion here is deliberately an END-TO-END CONSEQUENCE check over that
 * whole chain, not a mechanism check on step 3: step 3 is core's, and re-typing
 * core's internals here would pin an implementation this package does not own.
 * Steps 2 and 4 are this package's and are therefore what a regression here
 * would break.
 *
 * STEP 3 IS REAL, NOT MOCKED: [ProjectingSessionLog] delegates to core's exported
 * `deriveMessagesFrom`. The mock rule ("never mock the object under test") is why
 * the default `FakeSessionLog` — whose `deriveMessages()` returns a PRE-BAKED
 * array (fakes.test-util.ts) and is therefore `[]` for this scenario —
 * is not used for the projection. `pinned to the real projector` below proves it.
 */

import { describe, expect, it } from "vitest";
import {
  assistantText,
  deriveMessagesFrom,
  isImageContent,
  isTextContent,
  type ImageRef,
  type Message,
  type StreamEvent,
  type ToolInput,
  type ToolOutput,
} from "@celestea/core";
import { FakeSessionLog, FakeToolRegistry, ScriptedLlm, harness, toolCallMessage } from "./fakes.test-util.js";

/** `StreamEvent::Done(message)`. */
function done(message: Message): StreamEvent {
  return { kind: "done", message };
}

/** What the attachment store hands back for a screenshot (browser session.ts). */
const SHOT: ImageRef = {
  attachment_id: "b".repeat(64),
  media_type: "image/png",
  width: 1280,
  height: 800,
  name: "browser-1700000000000.png",
};

/**
 * The value `BrowserSessionManager.capture()` really produces
 * (packages/tools/src/browser/session.ts). The screenshot descriptor and
 * the reference array are TOP-LEVEL siblings, not nested: `capture()` spreads
 * the `screenshot()` result (`...shot`, line 411) straight into the
 * BrowserResult. This shape is the contract the projection is pinned against;
 * if the browser side ever nests them, THIS is the fixture that goes red.
 */
function browserValue(): Record<string, unknown> {
  return {
    ok: true,
    url: "https://example.test/",
    title: "Example",
    snapshot: { text: "heading\n", refs: [], truncated: false, total_nodes: 1, included_nodes: 1 },
    screenshot: {
      attachment_id: SHOT.attachment_id,
      media_type: SHOT.media_type,
      width: SHOT.width,
      height: SHOT.height,
      bytes: 4096,
    },
    attachments: [SHOT],
    isolation: { provider: "chrome", net_isolated: true },
    notes: ["address space exempted"],
  };
}

/** A log whose projection is core's REAL deriveMessagesFrom, never a canned array. */
class ProjectingSessionLog extends FakeSessionLog {
  override deriveMessages(): Message[] {
    return deriveMessagesFrom(this.events());
  }
}

/** A registry that answers every call with one canned value. */
class ValueRegistry extends FakeToolRegistry {
  constructor(private readonly value: unknown) {
    super();
  }

  override async dispatch(input: ToolInput): Promise<ToolOutput> {
    this.order.push(input.call_id);
    return { call_id: input.call_id, value: this.value, render: null, error: null, decision: { kind: "allow" } };
  }
}

/**
 * Drive one tool-call step with `value`, then a plain answer. Returns the
 * messages of the SECOND model request — the first request is built before the
 * tool ever ran, so it cannot contain the result.
 */
async function secondRequestMessages(value: unknown): Promise<Message[]> {
  const llm = new ScriptedLlm([[done(toolCallMessage(["c1"]))], [done(assistantText("done"))]]);
  const h = harness({ llm, session: new ProjectingSessionLog(), registry: new ValueRegistry(value) });
  const outcome = await h.run();
  expect(outcome).toBe("completed");
  expect(llm.requests.length).toBe(2);
  return llm.requests[1]?.messages ?? [];
}

/** The single tool message of a request, or a thrown error (never a silent undefined). */
function toolMessageOf(messages: readonly Message[]): Message {
  const tool = messages.find((message) => message.role === "tool");
  if (tool === undefined) throw new Error("no tool message in the request");
  return tool;
}

/** The image blocks of a message, in order. */
function imagesOf(message: Message): ImageRef[] {
  return message.content.filter(isImageContent).map((block) => block.content);
}

/** The first text block of a message, or a thrown error. */
function textOf(message: Message): string {
  const block = message.content.find(isTextContent);
  if (block === undefined) throw new Error("no text block in the message");
  return block.content;
}

describe("tool result image projection (T1b / M1④)", () => {
  it("delivers the screenshot reference as an image block on the tool message", async () => {
    const tool = toolMessageOf(await secondRequestMessages(browserValue()));

    // text FIRST, image AFTER — message.ts ordering (section 3.5).
    expect(tool.content.map((block) => block.type)).toEqual(["text", "image"]);
    expect(imagesOf(tool)).toEqual([SHOT]);
    expect(tool.tool_call_id).toBe("c1");
  });

  it("keeps the value's JSON text, so the metadata is still model-visible", async () => {
    const tool = toolMessageOf(await secondRequestMessages(browserValue()));
    const text = textOf(tool);

    expect(text).toContain("example.test");
    expect(text).toContain(SHOT.attachment_id);
    expect(text).toContain(String(SHOT.width));
  });

  it("reads attachments at the TOP level, not nested under the result", async () => {
    // The browser spreads `...shot` into the result (session.ts); this pins
    // that the projection and the producer agree on the nesting depth.
    const nested = {
      ok: true,
      snapshot: { text: "heading\n", refs: [] },
      result: { attachments: [SHOT] },
    };

    const tool = toolMessageOf(await secondRequestMessages(nested));

    expect(imagesOf(tool)).toEqual([]);
  });

  it("projects no image block when the value carries no attachments", async () => {
    const tool = toolMessageOf(await secondRequestMessages({ ok: true, snapshot: { text: "heading\n", refs: [] } }));

    expect(tool.content.map((block) => block.type)).toEqual(["text"]);
  });

  it("drops a malformed reference instead of smuggling it into the prompt", async () => {
    // attachment_id is not 64-hex here: isImageRef (message.ts) rejects it.
    const bad = { attachment_id: "nope", media_type: "image/png", width: 1, height: 1 };
    const tool = toolMessageOf(await secondRequestMessages({ ...browserValue(), attachments: [bad] }));

    expect(tool.content.map((block) => block.type)).toEqual(["text"]);
  });

  it("is pinned to the real projector: the default fake would project nothing", async () => {
    // Guards the mock rule from the other side. FakeSessionLog.deriveMessages()
    // returns a PRE-BAKED array (fakes.test-util.ts) and is therefore []
    // for this scenario — so a swap back to it would silently blank every image
    // block above. This asserts the real projector is the thing producing them.
    const llm = new ScriptedLlm([[done(toolCallMessage(["c1"]))], [done(assistantText("done"))]]);
    const h = harness({ llm, session: new FakeSessionLog(), registry: new ValueRegistry(browserValue()) });

    await h.run();

    // The row IS in the log (the loop wrote it) ...
    expect(h.session.events().some((event) => event.type === "tool_result")).toBe(true);
    // ... but the pre-baked fake projects no messages at all, where the real
    // projector above produced the image block. Hence the real one is required.
    const fake = new FakeSessionLog();
    fake.append({ type: "tool_result", id: "c1", value: browserValue(), error: null });
    expect(fake.deriveMessages()).toEqual([]);
    // isImageContent guards a CONTENT block, not a Message: unwrap one level.
    const blocks = deriveMessagesFrom(fake.events()).flatMap((message) => message.content);
    expect(blocks.filter(isImageContent)).toHaveLength(1);
  });
});
